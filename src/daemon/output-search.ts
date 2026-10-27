import { RemoteOperationError } from '../shared/remote-errors';
import { stripVTControlCharacters } from 'node:util';
import type { OutputSearch, OutputSearchResult, RemoteCommandOutput } from '../shared/protocol';

type Line={number:number;cursor:number;text:string;clipped?:boolean};
type Reader=(cursor:number,maxChars:number)=>RemoteCommandOutput;
const encodedBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value).replace(/[^\x00-\x7f]/g,'\\u0000'));
const clean=(text:string)=>(text.includes('\x1b')||text.includes('\x9b')?stripVTControlCharacters(text):text).replace(/\r?\n$/,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');

/** At most one cached line is materialized at a time; never split the entire log. */
function* lines(read:Reader,start:number,end:number):Generator<Line> {
  let cursor=start,lineCursor=start,number=1,pieces:string[]=[];
  while(cursor<end){
    const page=read(cursor,Math.min(65536,end-cursor));
    if(!page.available)throw new Error('搜索过程中输出缓存不可用');
    if(page.nextCursor<=cursor)throw new Error('搜索游标无效或拆分 Unicode 字符');
    let from=0,index:number;
    while((index=page.text.indexOf('\n',from))>=0){
      pieces.push(page.text.slice(from,index+1));yield {number:number++,cursor:lineCursor,text:clean(pieces.join(''))};pieces=[];from=index+1;lineCursor=cursor+from;
    }
    if(from<page.text.length)pieces.push(page.text.slice(from));
    cursor=page.nextCursor;
  }
  if(pieces.length)yield {number,cursor:lineCursor,text:clean(pieces.join(''))};
}

function snippet(text:string,index:number,queryLength:number,max=1024):string {
  if(text.length<=max)return text;
  let start=Math.max(0,index-Math.floor((max-queryLength)/2)),end=Math.min(text.length,start+max);
  if(/[\uDC00-\uDFFF]/.test(text[start]??''))start++;
  if(/[\uD800-\uDBFF]/.test(text[end-1]??''))end--;
  return (start?'…':'')+text.slice(start,end)+(end<text.length?'…':'');
}

export function searchOutput(read:Reader,end:number,cursor:number,options:OutputSearch):RemoteCommandOutput {
  const first=read(cursor,1),snapshotEnd=options.endCursor??end;
  if(snapshotEnd>end||snapshotEnd<cursor)throw new Error('搜索结束游标超出本轮命令范围');
  if(!first.available)return {...first,omitted:false};
  if(options.endCursor!==undefined&&first.truncated)throw new RemoteOperationError('CACHE_RANGE_LOST','搜索快照已被缓存淘汰，请从当前缓存重新查询；不能宣称旧范围完整');
  const start=Math.max(cursor,first.earliestCursor??cursor);
  // Escape all metacharacters: this is literal text search, never user regex/code.
  const pattern=new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),options.caseSensitive?'u':'iu');
  const hits:Line[]=[];let totalMatches=0;
  for(const line of lines(read,start,snapshotEnd)){
    const match=pattern.exec(line.text);if(!match)continue;
    if(totalMatches>=options.offset&&hits.length<options.limit)hits.push({...line,text:snippet(line.text,match.index,match[0].length),clipped:line.text.length>1024});
    totalMatches++;
  }
  const selected=new Map(hits.map(line=>[line.number,line]));
  const contexts=new Map<number,Line>();
  let hitIndex=0;
  if(hits.length&&options.contextLines)for(const line of lines(read,start,snapshotEnd)){
    while(hitIndex<hits.length&&line.number>hits[hitIndex].number+options.contextLines)hitIndex++;
    if(hitIndex===hits.length)break;
    if(!selected.has(line.number)&&Math.abs(hits[hitIndex].number-line.number)<=options.contextLines)contexts.set(line.number,{...line,text:snippet(line.text,0,0),clipped:line.text.length>1024});
  }
  const make=():OutputSearchResult=>{
    const all=[...selected.values(),...contexts.values()].sort((a,b)=>a.number-b.number),groups:OutputSearchResult['groups']=[];
    let previous=-2;
    for(const line of all){
      let group=groups.at(-1);if(!group||line.number!==previous+1){group={startLine:line.number,cursor:line.cursor,text:'',matchLines:[]};groups.push(group);}
      group.text+=(previous===line.number-1?'\n':'')+line.text;if(selected.has(line.number))group.matchLines.push(line.number);previous=line.number;
    }
    return {query:options.query,caseSensitive:options.caseSensitive,contextLines:options.contextLines,maxBytes:options.maxBytes,offset:options.offset,limit:options.limit,totalMatches,returnedMatches:selected.size,nextOffset:options.limit&&options.offset+selected.size<totalMatches?options.offset+selected.size:null,startCursor:start,endCursor:snapshotEnd,lineNumbering:'range',omitted:false,groups};
  };
  let search=make(),omitted=[...selected.values(),...contexts.values()].some(line=>line.clipped);
  // Matching lines take priority over context; pagination never skips removed hits.
  let bytes=encodedBytes(search);
  while(bytes>options.maxBytes&&contexts.size){
    const remove=Math.max(1,Math.ceil(contexts.size*(1-options.maxBytes/bytes)));
    for(const number of [...contexts.keys()].slice(-remove))contexts.delete(number);
    omitted=true;search=make();bytes=encodedBytes(search);
  }
  while(bytes>options.maxBytes&&selected.size>1){
    const remove=Math.min(selected.size-1,Math.max(1,Math.ceil(selected.size*(1-options.maxBytes/bytes))));
    for(const number of [...selected.keys()].slice(-remove))selected.delete(number);
    omitted=true;search=make();bytes=encodedBytes(search);
  }
  if(encodedBytes(search)>options.maxBytes&&selected.size){
    const [number,line]=[...selected][0],match=pattern.exec(line.text)!;selected.set(number,{...line,text:snippet(line.text,match.index,match[0].length,options.query.length+12)});omitted=true;search=make();
  }
  search.omitted=omitted||search.nextOffset!==null;
  return {text:'',nextCursor:snapshotEnd,earliestCursor:first.earliestCursor,available:true,hasMore:false,format:'terminal',mode:'summary',cacheLost:(first.earliestCursor??0)>0,truncated:(first.earliestCursor??0)>0||search.omitted,omitted:search.omitted,search};
}
