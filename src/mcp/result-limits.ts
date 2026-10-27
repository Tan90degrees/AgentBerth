import { BoundedText } from '../shared/bounded-text';

// Same final-result cap and reduction steps as ssh-skill/result_protocol.py.
export const MAX_RESULT_BYTES=256*1024;
const steps=[[100,16*1024],[50,8*1024],[20,4*1024],[10,2*1024],[5,1024],[1,512]] as const;
// Account for JSON escapes just as ssh-skill's ensure_ascii=True encoder does.
const encode=(value:unknown)=>JSON.stringify(value??null).replace(/[^\x00-\x7f]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
const sample=<T>(values:T[],max:number):T[]=>values.length<=max?values:[...values.slice(0,Math.ceil(max/2)),...(Math.floor(max/2)?values.slice(-Math.floor(max/2)):[])];
function bound(value:unknown,items:number,bytes:number,path:string,changed:Set<string>):unknown {
  if(typeof value==='string'){
    const text=new BoundedText(bytes,4000,Math.floor(bytes/4));text.append(value);const preview=text.preview();if(preview.omitted)changed.add(path);return preview.text;
  }
  if(Array.isArray(value)){
    const kept=sample(value,items);if(kept.length<value.length)changed.add(path);return kept.map((entry,index)=>bound(entry,items,bytes,`${path}[${index}]`,changed));
  }
  if(value&&typeof value==='object'){
    const entries=Object.entries(value),kept=sample(entries,items);if(kept.length<entries.length)changed.add(path);
    return Object.fromEntries(kept.map(([key,entry])=>[key,bound(entry,items,bytes,`${path}.${key}`,changed)]));
  }
  return value;
}
export function boundedToolText(value:unknown):string {
  const original=encode(value),totalBytes=Buffer.byteLength(original);
  if(totalBytes<=MAX_RESULT_BYTES)return original;
  for(const [items,bytes] of steps){
    const changed=new Set<string>(),bounded=bound(value,items,bytes,'$',changed);
    const candidate:Record<string,any>=bounded&&!Array.isArray(bounded)&&typeof bounded==='object'?{...bounded}:{data:bounded};
    // Preserve command identity and status even if a large object is sampled.
    if(value&&!Array.isArray(value)&&typeof value==='object')for(const key of ['scope','fromCursor','id','sessionId','runId','status','exitCode'])if(key in value)candidate[key]=(value as Record<string,unknown>)[key];
    candidate.resultLimit={truncated:true,totalBytes,maxBytes:MAX_RESULT_BYTES,truncatedPaths:[...changed].slice(0,100)};
    if(candidate.scope==='command'){
      candidate.allOutputInThisResponse=false;
      if(candidate.output&&changed.has('$.output.text')){
        candidate.output={...candidate.output,omitted:true,truncated:true,returnedBytes:Buffer.byteLength(candidate.output.text??'')};
        // Keep running-command waits at their NEW-output cursor. Detailed recovery
        // is opt-in and starts at the original range, since nextCursor has advanced.
        if(candidate.status!=='running')candidate.continuation=null;
        if(['sessionId','runId','id'].every(key=>typeof candidate[key]==='string')&&Number.isSafeInteger(candidate.fromCursor))candidate.details={tool:'terminal_execute',arguments:{sessionId:candidate.sessionId,runId:candidate.runId,actionId:candidate.id,cursor:candidate.fromCursor,waitMs:0,mode:'page',maxChars:4096}};
        candidate.notice='JSON 结果超出总预算，已保留首尾并省略部分内容；不自动读取全部分页或重跑命令。运行中仍可用 continuation 等待新增输出；仅任务确需细节时才用 details 小范围读取。';
      }
    }
    const encoded=encode(candidate);if(Buffer.byteLength(encoded)<=MAX_RESULT_BYTES)return encoded;
  }
  return encode({resultLimit:{truncated:true,totalBytes,maxBytes:MAX_RESULT_BYTES,truncatedPaths:['$']},notice:'结果超出总预算，明细已省略；不要自动重跑操作。'});
}
