import {memo,useEffect,useMemo,useState} from 'react';
import type {AcpEvent,AcpTerminal} from '../shared/acp';
import {fileChange,toolState} from '../shared/acp-presentation';
import {ConversationMarkdown,ConversationMessage} from './ConversationMessage';
import {AsyncButton} from './AsyncButton';

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
function FileChange({value,onOpenFile}:{value:any;onOpenFile?:OpenFile}){
  const change=useMemo(()=>fileChange(value.oldText,String(value.newText??'')),[value.oldText,value.newText]);
  return <section className="acp-file-change"><header><strong>{value.oldText===null?'新建文件':'文件改动'}</strong>{onOpenFile&&typeof value.path==='string'?<button className="conversation-action" onClick={()=>onOpenFile(value.path)}>{value.path}</button>:<code>{value.path}</code>}</header><pre>{change.lines.map((line,index)=><span className={line.kind} key={index}><b aria-hidden="true">{line.kind==='add'?'+':line.kind==='remove'?'-':' '}</b>{line.text||' '}<br/></span>)}</pre>{change.truncated&&<small>改动较长，仅显示前 400 行；打开文件可查看完整内容。</small>}</section>;
}
function Tool({events,sessionId,onOpenFile}:{events:AcpEvent[];sessionId:string;onOpenFile?:OpenFile}){
  const data=useMemo(()=>toolState(events),[events]),[expanded,setExpanded]=useState(false),status=String(data.status??'pending'),content=Array.isArray(data.content)?data.content.filter((item:any)=>item&&typeof item==='object'):[];
  return <details className="acp-tool-card" data-tool-id={data.toolCallId} data-status={status} open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary><span className={'acp-tool-dot '+status} aria-hidden="true"/><span className="acp-tool-label">{kinds[String(data.kind)]??'工具'}</span><strong>{String(data.title??events[0].text??'工具调用')}</strong><span className={'acp-tool-status '+status}>{statuses[status]??status}</span></summary>
    {expanded&&<div className="acp-tool-body">{Array.isArray(data.locations)&&data.locations.length>0&&<div className="acp-tool-locations">{data.locations.filter((location:any)=>location&&typeof location.path==='string').map((location:any,index:number)=><button key={index} disabled={!onOpenFile} onClick={()=>onOpenFile?.(String(location.path),location.line)}>{String(location.path)}{location.line?':'+location.line:''}</button>)}</div>}
      {data.rawInput!==undefined&&<details className="acp-tool-input" open><summary>输入参数</summary><pre>{json(data.rawInput)}</pre></details>}
      {content.map((item:any,index:number)=>item.type==='diff'?<FileChange key={index} value={item} onOpenFile={onOpenFile}/>:item.type==='terminal'?<TerminalOutput key={index} sessionId={sessionId} terminalId={String(item.terminalId)}/>:item.type==='content'?<Content key={index} content={item.content} onOpenFile={onOpenFile}/>:<Content key={index} content={item} onOpenFile={onOpenFile}/>)}
      {data.rawOutput!==undefined&&<details className="acp-tool-result" open={!content.length}><summary>返回结果</summary><pre>{json(data.rawOutput)}</pre></details>}
      {data.omitted&&<p>此工具事件超过历史记录限制，详细内容未保存。</p>}
      {!content.length&&data.rawOutput===undefined&&<p className="acp-quiet">{status==='in_progress'?'正在等待工具结果…':'Agent 未提供额外输出'}</p>}
      <details className="acp-raw-event"><summary>协议详情</summary><pre>{JSON.stringify(data,null,2)}</pre></details>
    </div>}
  </details>;
}
export const AcpEventView=memo(function AcpEventView({events,streaming,sessionId,label,onError,onOpenFile}:{events:AcpEvent[];streaming:boolean;sessionId:string;label:string;onError:(value:string)=>void;onOpenFile?:OpenFile}){
  const first=events[0],text=events.map(event=>event.text).join('');
  if(first.kind==='thought')return <details className="acp-thinking"><summary><span aria-hidden="true">✧</span> 思考过程</summary><ConversationMarkdown text={text} streaming={streaming}/></details>;
  if(first.kind==='tool')return <Tool events={events} sessionId={sessionId} onOpenFile={onOpenFile}/>;
  if(first.kind==='terminal')return <details className="acp-tool-card"><summary>终端运行记录</summary><pre>{String(first.data?.output??'')}</pre>{!!first.data?.truncated&&<small>显示保留的末尾输出</small>}</details>;
  if(first.kind==='plan'){
    const entries=Array.isArray(events.at(-1)?.data?.entries)?(events.at(-1)!.data!.entries as any[]).filter(entry=>entry&&typeof entry.content==='string'):[],done=entries.filter(entry=>entry.status==='completed').length;
    return <details className="acp-plan" open={done<entries.length}><summary><strong>执行计划</strong><span>{done} / {entries.length}</span></summary><ol>{entries.map((entry,index)=><li key={index} data-status={entry.status}><span aria-hidden="true">{entry.status==='completed'?'✓':entry.status==='in_progress'?'◉':'○'}</span><span>{entry.content}</span><small>{entry.status==='completed'?'已完成':entry.status==='in_progress'?'进行中':'待处理'}</small></li>)}</ol></details>;
  }
  if(first.kind==='permission')return <details className="acp-permission-record"><summary>授权请求 · {text}</summary><p>授权通过下方操作卡片处理。已处理的选择记录保留在对话中。</p>{!!first.data?.toolCall&&<pre>{JSON.stringify(first.data.toolCall,null,2)}</pre>}</details>;
  if(first.kind==='notice'||first.kind==='turn')return <div className="acp-turn-divider"><span>{first.kind==='turn'?'✓ ':''}{text}</span></div>;
  return <ConversationMessage role={first.kind==='user'?'user':first.kind==='error'?'error':'assistant'} text={first.data?.content?'':text} label={label} timestamp={first.createdAt} streaming={streaming} onError={onError}>{!!first.data?.content&&<Content content={first.data.content} onOpenFile={onOpenFile}/>}</ConversationMessage>;
});
