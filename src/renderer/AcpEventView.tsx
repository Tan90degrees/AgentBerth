import {memo,useEffect,useMemo,useState} from 'react';
import type {AcpEvent,AcpTerminal} from '../shared/acp';
import {fileChange,toolState,toolCommand} from '../shared/acp-presentation';
import {ConversationMarkdown,ConversationMessage,CopyGlyph} from './ConversationMessage';
import {AsyncButton} from './AsyncButton';
import {useHighlightedCode} from './highlighting';

type OpenFile=(path:string,line?:number)=>void;
const json=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const statuses:Record<string,string>={pending:'待执行',in_progress:'执行中',completed:'已完成',failed:'失败'};
const kinds:Record<string,string>={read:'读取',edit:'修改',delete:'删除',move:'移动',search:'搜索',execute:'命令',fetch:'获取',think:'分析',switch_mode:'切换模式',other:'工具'};
function resourcePath(uri:string){try{const path=decodeURIComponent(new URL(uri).pathname);return /^\/[a-z]:\//i.test(path)?path.slice(1):path;}catch{return uri;}}
function TerminalOutput({sessionId,terminalId}:{sessionId:string;terminalId:string}){
  const [view,setView]=useState<AcpTerminal|null>(null),[error,setError]=useState('');
  useEffect(()=>{let alive=true,timer:ReturnType<typeof setTimeout>;const read=async()=>{try{const value=await window.berth.rpc<AcpTerminal>('acpTerminal',{sessionId,terminalId});if(!alive)return;setView(value);setError('');if(!value.released&&!value.exitStatus)timer=setTimeout(read,1000);}catch(error){if(alive)setError(String(error));}};void read();return()=>{alive=false;clearTimeout(timer);};},[sessionId,terminalId]);
  return <div className="acp-terminal-output"><div><strong>终端输出</strong>{view?.exitStatus&&<span>退出码 {view.exitStatus.exitCode??view.exitStatus.signal??'未知'}</span>}</div>{error?<p role="status">{error}</p>:<pre>{view?.output||'等待输出…'}</pre>}{view?.truncated&&<small>仅显示保留的末尾输出；显示窗口不会改变 Agent 获取的命令结果。</small>}</div>;
}
function Content({content,onOpenFile}:{content:any;onOpenFile?:OpenFile}){
  if(!content||typeof content!=='object')return null;
  if(content.type==='text')return <ConversationMarkdown text={String(content.text??'')}/>;
  if(content.type==='image'&&/^image\/(png|jpeg|webp|gif)$/i.test(content.mimeType??'')&&typeof content.data==='string'&&content.data.length<300000)return <img className="acp-content-image" src={'data:'+content.mimeType+';base64,'+content.data} alt="Agent 返回的图片"/>;
  if(content.type==='resource'&&typeof content.resource?.text==='string')return <div className="conversation-code"><div>{content.resource.uri??'资源内容'}</div><pre>{content.resource.text}</pre></div>;
  const uri=content.uri??content.resource?.uri;
  if(typeof uri==='string')return <div className="conversation-resource"><span>{content.name??content.title??'资源'} · {uri}</span>{/^https?:\/\//i.test(uri)?<AsyncButton className="conversation-action" onAction={()=>window.berth.openExternal(uri)}>打开链接</AsyncButton>:/^file:\/\//i.test(uri)&&onOpenFile?<button className="conversation-action" onClick={()=>onOpenFile(resourcePath(uri))}>打开文件</button>:null}</div>;
  return <p className="conversation-resource">{content.type==='image'?'图片超过当前记录大小限制':`内容类型：${String(content.type??'未知')}（当前无法预览）`}</p>;
}
function ToolGlyph({kind}:{kind:string}){
  const paths:Record<string,string>={execute:'m5 6 5 4-5 4m7 0h4',edit:'m4 13-1 4 4-1L17 6l-3-3-10 10m8-8 3 3',read:'M5 3h7l3 3v11H5V3m7 0v4h3M8 10h4m-4 3h4',search:'m13 13 4 4M14 9A5 5 0 1 1 4 9a5 5 0 0 1 10 0',other:'m7 4-4 6 4 6m6-12 4 6-4 6'};
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]??paths.other}/></svg>;
}
function ToolCode({text,title,language='plaintext',onError}:{text:string;title:string;language?:string;onError?:(value:string)=>void}){
  const html=useHighlightedCode(text,language,text.length<=64000);
  return <section className="acp-tool-code"><header><span>{title}</span><AsyncButton className="conversation-action" aria-label={'复制'+title} onError={onError} onAction={()=>window.berth.copyText(text)}><CopyGlyph/><span>复制</span></AsyncButton></header><pre>{html===null?<code>{text}</code>:<code className="hljs" dangerouslySetInnerHTML={{__html:html}}/>}</pre></section>;
}
function FileChange({value,onOpenFile,onError}:{value:any;onOpenFile?:OpenFile;onError?:(value:string)=>void}){
  const change=useMemo(()=>fileChange(value.oldText,String(value.newText??'')),[value.oldText,value.newText]);
  return <section className="acp-file-change"><header><ToolGlyph kind="edit"/><div className="acp-file-name"><strong>{value.oldText===null?'新建文件':'文件改动'}</strong>{onOpenFile&&typeof value.path==='string'?<button className="conversation-action" title={value.path} onClick={()=>onOpenFile(value.path)}>{value.path}</button>:<code>{value.path}</code>}</div><span className="acp-diff-stat" aria-label={'新增 '+change.added+' 行，删除 '+change.removed+' 行'}><b>+{change.added}</b><i>−{change.removed}</i></span><AsyncButton className="conversation-action" aria-label="复制修改后内容" onError={onError} onAction={()=>window.berth.copyText(String(value.newText??''))}><CopyGlyph/></AsyncButton></header><pre>{change.lines.map((line,index)=><span className={line.kind} key={index}><small aria-hidden="true">{line.oldLine??''}</small><small aria-hidden="true">{line.newLine??''}</small><b aria-hidden="true">{line.kind==='add'?'+':line.kind==='remove'?'−':' '}</b><code>{line.text||' '}</code></span>)}</pre>{change.truncated&&<small>改动较长，仅显示前 400 行；打开文件可查看完整内容。</small>}</section>;
}
function Tool({events,sessionId,onOpenFile,onError}:{events:AcpEvent[];sessionId:string;onOpenFile?:OpenFile;onError:(value:string)=>void}){
  const data=useMemo(()=>toolState(events),[events]),[expanded,setExpanded]=useState(false),status=String(data.status??'pending'),content=Array.isArray(data.content)?data.content.filter((item:any)=>item&&typeof item==='object'):[];
  const kind=String(data.kind??'other'),command=kind==='execute'?toolCommand(data.rawInput):null;
  return <details className={'acp-tool-card acp-tool-'+kind} data-tool-id={data.toolCallId} data-status={status} open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary><span className={'acp-tool-icon '+status}><ToolGlyph kind={kind}/></span><span className="acp-tool-label">{kinds[String(data.kind)]??'工具'}</span><strong>{String(data.title??events[0].text??'工具调用')}</strong><span className={'acp-tool-status '+status}>{statuses[status]??status}</span></summary>
    {expanded&&<div className="acp-tool-body">{Array.isArray(data.locations)&&data.locations.length>0&&<div className="acp-tool-locations">{data.locations.filter((location:any)=>location&&typeof location.path==='string').map((location:any,index:number)=><button key={index} disabled={!onOpenFile} onClick={()=>onOpenFile?.(String(location.path),location.line)}>{String(location.path)}{location.line?':'+location.line:''}</button>)}</div>}
      {data.rawInput!==undefined&&<details className="acp-tool-input" open><summary>输入参数</summary>{command?<ToolCode text={command} title="命令" language="bash" onError={onError}/>:<ToolCode text={json(data.rawInput)??''} title="参数" language={typeof data.rawInput==='string'?'plaintext':'json'} onError={onError}/>}</details>}
      {content.map((item:any,index:number)=>item.type==='diff'?<FileChange key={index} value={item} onOpenFile={onOpenFile} onError={onError}/>:item.type==='terminal'?<TerminalOutput key={index} sessionId={sessionId} terminalId={String(item.terminalId)}/>:item.type==='content'?<Content key={index} content={item.content} onOpenFile={onOpenFile}/>:<Content key={index} content={item} onOpenFile={onOpenFile}/>)}
      {data.rawOutput!==undefined&&<details className="acp-tool-result" open={!content.length}><summary>返回结果</summary><ToolCode text={json(data.rawOutput)??''} title="结果" language={typeof data.rawOutput==='string'?'plaintext':'json'} onError={onError}/></details>}
      {data.omitted&&<p>此工具事件超过历史记录限制，详细内容未保存。</p>}
      {!content.length&&data.rawOutput===undefined&&<p className="acp-quiet">{status==='in_progress'?'正在等待工具结果…':'Agent 未提供额外输出'}</p>}
      <details className="acp-raw-event"><summary>协议详情</summary><pre>{JSON.stringify(data,null,2)}</pre></details>
    </div>}
  </details>;
}
export const AcpEventView=memo(function AcpEventView({events,streaming,sessionId,label,onError,onOpenFile}:{events:AcpEvent[];streaming:boolean;sessionId:string;label:string;onError:(value:string)=>void;onOpenFile?:OpenFile}){
  const first=events[0],text=events.map(event=>event.text).join('');
  if(first.kind==='thought')return <details className="acp-thinking"><summary><span aria-hidden="true">✧</span> 思考过程</summary><ConversationMarkdown text={text} streaming={streaming}/></details>;
  if(first.kind==='tool')return <Tool events={events} sessionId={sessionId} onOpenFile={onOpenFile} onError={onError}/>;
  if(first.kind==='terminal')return <details className="acp-tool-card"><summary>终端运行记录</summary><pre>{String(first.data?.output??'')}</pre>{!!first.data?.truncated&&<small>显示保留的末尾输出</small>}</details>;
  if(first.kind==='plan'){
    const entries=Array.isArray(events.at(-1)?.data?.entries)?(events.at(-1)!.data!.entries as any[]).filter(entry=>entry&&typeof entry.content==='string'):[],done=entries.filter(entry=>entry.status==='completed').length;
    return <details className="acp-plan" open={done<entries.length}><summary><strong>执行计划</strong><span>{done} / {entries.length}</span></summary><ol>{entries.map((entry,index)=><li key={index} data-status={entry.status}><span aria-hidden="true">{entry.status==='completed'?'✓':entry.status==='in_progress'?'◉':'○'}</span><span>{entry.content}</span><small>{entry.status==='completed'?'已完成':entry.status==='in_progress'?'进行中':'待处理'}</small></li>)}</ol></details>;
  }
  if(first.kind==='permission')return <details className="acp-permission-record"><summary>授权请求 · {text}</summary><p>授权通过下方操作卡片处理。已处理的选择记录保留在对话中。</p>{!!first.data?.toolCall&&<pre>{JSON.stringify(first.data.toolCall,null,2)}</pre>}</details>;
  if(first.kind==='notice'||first.kind==='turn')return <div className="acp-turn-divider"><span>{first.kind==='turn'?'✓ ':''}{text}</span></div>;
  return <ConversationMessage role={first.kind==='user'?'user':first.kind==='error'?'error':'assistant'} text={first.data?.content?'':text} label={label} timestamp={first.createdAt} streaming={streaming} onError={onError}>{!!first.data?.content&&<Content content={first.data.content} onOpenFile={onOpenFile}/>}</ConversationMessage>;
});
