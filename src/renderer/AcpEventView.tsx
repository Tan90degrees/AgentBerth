import {memo,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {AcpEvent,AcpTerminal} from '../shared/acp';
import {acpCapabilityMarker,acpRecord,acpStreamBlocks} from '../shared/acp-stream';
import {fileChange,toolState,toolCommand} from '../shared/acp-presentation';
import {ConversationMarkdown,ConversationMessage,CopyGlyph} from './ConversationMessage';
import {AsyncButton} from './AsyncButton';
import {AcpMediaView} from './AcpMediaView';
import {useHighlightedCode} from './highlighting';

type OpenFile=(path:string,line?:number)=>void;
const json=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const statuses:Record<string,string>={pending:'待执行',in_progress:'执行中',completed:'已完成',failed:'失败',cancelled:'已取消'};
const kinds:Record<string,string>={read:'读取',edit:'修改',delete:'删除',move:'移动',search:'搜索',execute:'命令',fetch:'获取',think:'分析',switch_mode:'切换模式',other:'工具'};
function resourcePath(uri:string){try{const path=decodeURIComponent(new URL(uri).pathname);return /^\/[a-z]:\//i.test(path)?path.slice(1):path;}catch{return uri;}}
function TerminalOutput({sessionId,terminalId}:{sessionId:string;terminalId:string}){
  const [view,setView]=useState<AcpTerminal|null>(null),[error,setError]=useState('');
  const screen=useRef<HTMLPreElement>(null),following=useRef(true);
  useEffect(()=>{if(screen.current&&following.current)screen.current.scrollTop=screen.current.scrollHeight;},[view?.output]);
  useEffect(()=>{
    let alive=true,received=false;
    const apply=(value:AcpTerminal)=>{setView(value);setError('');};
    setView(null);setError('');
    const off=window.berth.onEvent(event=>{
      if(event.event==='acp'&&event.data.sessionId===sessionId&&event.data.terminal?.terminalId===terminalId){
        received=true;apply(event.data.terminal);
      }
    });
    void window.berth.rpc<AcpTerminal>('acpTerminal',{sessionId,terminalId}).then(value=>{
      if(alive&&!received)apply(value);
    }).catch(error=>{if(alive&&!received)setError(String(error));});
    return()=>{alive=false;off();};
  },[sessionId,terminalId]);
  return <div className="acp-terminal-output"><div><strong>终端输出</strong>{view?.exitStatus&&<span>退出码 {view.exitStatus.exitCode??view.exitStatus.signal??'未知'}</span>}</div>{error?<p role="status">{error}</p>:<pre ref={screen} onScroll={event=>{const box=event.currentTarget;following.current=box.scrollHeight-box.scrollTop-box.clientHeight<20;}}>{view?.output||'等待输出…'}</pre>}{view?.truncated&&<small>仅显示保留的末尾输出</small>}</div>;
}
function Content({content,onOpenFile,sessionId}:{content:any;sessionId:string;onOpenFile?:OpenFile}){
  if(!content||typeof content!=='object')return null;
  if(typeof content.mediaId==='string'&&typeof content.mimeType==='string')return <AcpMediaView key={content.mediaId} sessionId={sessionId} mediaId={content.mediaId} mimeType={content.mimeType} type={String(content.type)} uri={typeof content.uri==='string'?content.uri:undefined}/>;
  if(content.omitted)return <p className="conversation-resource">此附件无法预览 · {String(content.mimeType??content.type??'未知格式')}</p>;
  if(content.type==='text')return <ConversationMarkdown text={String(content.text??'')}/>;
  if(content.type==='image'&&/^image\/(png|jpeg|webp|gif)$/i.test(content.mimeType??'')&&typeof content.data==='string'&&content.data.length<300000)return <img className="acp-content-image" src={'data:'+content.mimeType+';base64,'+content.data} alt="Agent 返回的图片"/>;
  if(content.type==='audio'&&/^audio\/(?:wav|mpeg|ogg|mp4|webm|flac)$/i.test(content.mimeType??'')&&typeof content.data==='string')return <audio className="acp-content-audio" controls preload="metadata" src={'data:'+content.mimeType+';base64,'+content.data}/>;
  if(content.type==='resource'&&typeof content.resource?.text==='string')return <div className="conversation-code"><div>{content.resource.uri??'资源内容'}</div><pre>{content.resource.text}</pre></div>;
  const uri=content.uri??content.resource?.uri;
  if(typeof uri==='string')return <div className="conversation-resource"><span>{content.name??content.title??'资源'} · {uri}</span>{/^https?:\/\//i.test(uri)?<AsyncButton className="conversation-action" onAction={()=>window.berth.openExternal(uri)}>打开链接</AsyncButton>:/^file:\/\//i.test(uri)&&onOpenFile?<button className="conversation-action" onClick={()=>onOpenFile(resourcePath(uri))}>打开文件</button>:null}</div>;
  return <p className="conversation-resource">{content.type==='image'?'图片超过当前记录大小限制':`内容类型：${String(content.type??'未知')}（当前无法预览）`}</p>;
}
function ContentBlocks({blocks,onOpenFile,streaming,sessionId}:{blocks:unknown[];sessionId:string;onOpenFile?:OpenFile;streaming?:boolean}){
  const ordered:unknown[]=[];
  let text='';
  for(const block of blocks){
    if(acpRecord(block)&&block.type==='text'&&typeof block.text==='string'){text+=block.text;continue;}
    if(text){ordered.push({type:'text',text});text='';}
    if(block)ordered.push(block);
  }
  if(text)ordered.push({type:'text',text});
  return <>{ordered.map((block,index)=>acpRecord(block)&&block.type==='text'
    ?<ConversationMarkdown key={index} text={String(block.text??'')} streaming={streaming&&index===ordered.length-1}/>
    :<Content key={index} content={block} sessionId={sessionId} onOpenFile={onOpenFile}/>)}</>;
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
  return <section className="acp-file-change"><header><ToolGlyph kind="edit"/><div className="acp-file-name"><strong>{value.oldText===null?'新建文件':'文件改动'}</strong>{onOpenFile&&typeof value.path==='string'?<button className="conversation-action" title={value.path} onClick={()=>onOpenFile(value.path)}>{value.path}</button>:<code>{value.path}</code>}</div><span className="acp-diff-stat" aria-label={'新增 '+change.added+' 行，删除 '+change.removed+' 行'}><b>+{change.added}</b><i>−{change.removed}</i></span><AsyncButton className="conversation-action" aria-label="复制修改后内容" onError={onError} onAction={()=>window.berth.copyText(String(value.newText??''))}><CopyGlyph/></AsyncButton></header><pre>{change.lines.map((line,index)=><span className={line.kind} key={index}><small aria-hidden="true">{line.oldLine??''}</small><small aria-hidden="true">{line.newLine??''}</small><b aria-hidden="true">{line.kind==='add'?'+':line.kind==='remove'?'−':' '}</b><code>{line.text||' '}</code></span>)}</pre>{change.truncated&&<small>差异预览 · 前 400 行</small>}</section>;
}
function Tool({events,sessionId,onOpenFile,onError,nameFor}:{nameFor?:(id:unknown)=>string;events:AcpEvent[];sessionId:string;onOpenFile?:OpenFile;onError:(value:string)=>void}){
  const data=useMemo(()=>toolState(events),[events]),[expanded,setExpanded]=useState(false),status=String(data.status??'pending'),content=Array.isArray(data.content)?data.content.filter((item:any)=>item&&typeof item==='object'):[];
  const kind=String(data.kind??'other'),command=kind==='execute'?toolCommand(data.rawInput):null;
  return <details className={'acp-tool-card acp-tool-'+kind} data-tool-id={data.toolCallId} data-status={status} open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary><span className={'acp-tool-icon '+status}><ToolGlyph kind={kind}/></span><span className="acp-tool-label">{kinds[String(data.kind)]??'工具'}</span><strong>{String(data.title??events[0].text??'工具调用')}</strong><span className={'acp-tool-status '+status}>{statuses[status]??status}</span></summary>
    {expanded&&<div className="acp-tool-body">{Array.isArray(data.locations)&&data.locations.length>0&&<div className="acp-tool-locations">{data.locations.filter((location:any)=>location&&typeof location.path==='string').map((location:any,index:number)=><button key={index} disabled={!onOpenFile} onClick={()=>onOpenFile?.(String(location.path),location.line)}>{String(location.path)}{location.line?':'+location.line:''}</button>)}</div>}
      {data.rawInput!==undefined&&<details className="acp-tool-input" open><summary>输入参数</summary>{command?<ToolCode text={command} title="命令" language="bash" onError={onError}/>:<ToolCode text={json(data.rawInput)??''} title="参数" language={typeof data.rawInput==='string'?'plaintext':'json'} onError={onError}/>}</details>}
      {content.map((item:any,index:number)=>item.type==='diff'?<FileChange key={index} value={item} onOpenFile={onOpenFile} onError={onError}/>:item.type==='terminal'?<TerminalOutput key={index} sessionId={sessionId} terminalId={String(item.terminalId)}/>:item.type==='session'?<div className="acp-inline-child" key={index}><span aria-hidden="true">↳</span> {nameFor?.(item.sessionId)||String(item.sessionId??'子代理')}</div>:item.type==='content'?<Content key={index} content={item.content} sessionId={sessionId} onOpenFile={onOpenFile}/>:<Content key={index} content={item} sessionId={sessionId} onOpenFile={onOpenFile}/>)}
      {data.rawOutput!==undefined&&<details className="acp-tool-result" open={!content.length}><summary>返回结果</summary><ToolCode text={json(data.rawOutput)??''} title="结果" language={typeof data.rawOutput==='string'?'plaintext':'json'} onError={onError}/></details>}
      {data.omitted&&<p>此工具事件超过历史记录限制，详细内容未保存。</p>}
      {!content.length&&data.rawOutput===undefined&&<p className="acp-quiet">{status==='in_progress'?'正在等待工具结果…':'Agent 未提供额外输出'}</p>}
      <details className="acp-raw-event"><summary>协议详情</summary><pre>{JSON.stringify(data,null,2)}</pre></details>
    </div>}
  </details>;
}
interface EventProps {
  events:AcpEvent[];streaming:boolean;sessionId:string;label:string;onError:(value:string)=>void;onOpenFile?:OpenFile;
  nameFor?:(id:unknown)=>string;renderChild?:(id:string)=>ReactNode;cancelChild?:(id:string)=>Promise<unknown>;
}
export const AcpEventView=memo(function AcpEventView({events,streaming,sessionId,label,onError,onOpenFile,nameFor,renderChild,cancelChild}:EventProps){
  const first=events[0],last=events.at(-1)!,text=events.map(event=>event.text).join('');
  const rich=events.some(event=>event.data?.content);
  const blocks=rich?events.map(event=>event.data?.content??{type:'text',text:event.text}):[];
  if(first.kind==='thought')return <details className="acp-thinking"><summary><span aria-hidden="true">✧</span> 思考过程</summary>{rich?<ContentBlocks sessionId={sessionId} blocks={blocks} onOpenFile={onOpenFile}/>:<ConversationMarkdown text={text} streaming={streaming}/>}</details>;
  if(first.kind==='tool')return <Tool events={events} sessionId={sessionId} onOpenFile={onOpenFile} onError={onError} nameFor={nameFor}/>;
  if(first.kind==='terminal')return <details className="acp-tool-card"><summary>终端运行记录</summary><pre>{String(first.data?.output??'')}</pre>{!!first.data?.truncated&&<small>显示保留的末尾输出</small>}</details>;
  if(first.kind==='plan'){
    const data=last.data;
    if(data?.format==='markdown'){
      const markdown=events.filter(event=>event.data?.revision===data.revision).map(event=>event.text).join('');
      const file=typeof data.path==='string'?data.path:undefined;
      return <details className="acp-plan acp-stream-card"><summary><strong>执行计划</strong></summary><div className="acp-stream-body">{file&&onOpenFile&&<button className="subtle" onClick={()=>onOpenFile(file)}>打开计划文件</button>}<ConversationMarkdown text={markdown}/></div></details>;
    }
    const entries=Array.isArray(data?.entries)?data.entries.filter(entry=>entry&&typeof entry.content==='string'):[],done=entries.filter(entry=>entry.status==='completed').length;
    return <details className="acp-plan" open={done<entries.length}><summary><strong>执行计划</strong><span>{done} / {entries.length}</span></summary><ol>{entries.map((entry,index)=><li key={index} data-status={entry.status}><span aria-hidden="true">{entry.status==='completed'?'✓':entry.status==='in_progress'?'◉':'○'}</span><span>{entry.content}</span><small>{statuses[entry.status]??'待处理'}{entry.priority==='high'?' · 高优先级':''}</small></li>)}</ol></details>;
  }
  if(first.kind==='compaction'||first.kind==='session-message'){
    const compaction=first.kind==='compaction';
    const data=Object.assign({},...events.map(event=>event.data)) as Record<string,unknown>;
    const content=acpStreamBlocks(events,compaction?'summary':'blocks');
    const status=compaction?String(data.status??'in_progress'):'';
    const caption=compaction?statuses[status]??status:[nameFor?.(data.senderSessionId),nameFor?.(data.recipientSessionId)].filter(Boolean).join(' → ');
    return <details className="acp-stream-card" data-status={status}><summary><span className="acp-stream-glyph" aria-hidden="true">{compaction?'≡':'↔'}</span><strong>{compaction?'整理上下文':'协作消息'}</strong>{caption&&<small>{caption}</small>}</summary><div className="acp-stream-body">{typeof data.error==='string'&&<p role="status">{data.error}</p>}<ContentBlocks sessionId={sessionId} blocks={content} onOpenFile={onOpenFile} streaming={status==='in_progress'}/></div></details>;
  }
  if(first.kind==='subagent'){
    const data=Object.assign({},...events.map(event=>event.data)) as Record<string,unknown>;
    const id=String(data.subagentId??''),state=acpRecord(data.state)?data.state:undefined;
    const active=state?.state==='running';
    const usage=acpRecord(data.usage_update)?data.usage_update:undefined;
    const mode=acpRecord(data.current_mode_update)?data.current_mode_update.currentModeId:undefined;
    const info=acpRecord(data.session_info_update)?data.session_info_update:undefined;
    const config=acpRecord(data.config_option_update)&&Array.isArray(data.config_option_update.configOptions)?data.config_option_update.configOptions:[];
    const commands=acpRecord(data.available_commands_update)&&Array.isArray(data.available_commands_update.availableCommands)?data.available_commands_update.availableCommands:[];
    const cancel=active&&cancelChild&&acpRecord(data.capabilities)&&acpCapabilityMarker(data.capabilities.cancel);
    const outcome=typeof state?.stopReason==='string'?({end_turn:'已完成',cancelled:'已取消',error:'失败',refusal:'已拒绝',max_tokens:'达到输出上限',max_turn_requests:'达到请求上限'} as Record<string,string>)[state.stopReason]:undefined;
    return <details className="acp-stream-card acp-subagent-card" data-status={active?'in_progress':''}><summary><span className="acp-stream-glyph" aria-hidden="true">↳</span><strong>{nameFor?.(id)||'子代理'}</strong><small>{active?'执行中':outcome??(state?.state==='idle'?'空闲':'状态未报告')}</small></summary>
      <div className="acp-stream-body">{typeof data.description==='string'&&<p>{data.description}</p>}{(typeof mode==='string'||usage||info?.title||config.length>0||commands.length>0)&&<dl className="acp-child-info">
        {typeof info?.title==='string'&&<div><dt>会话标题</dt><dd>{info.title}</dd></div>}
        {typeof mode==='string'&&<div><dt>模式</dt><dd>{mode}</dd></div>}
        {typeof usage?.used==='number'&&typeof usage.size==='number'&&<div><dt>上下文用量</dt><dd>{usage.used.toLocaleString()} / {usage.size.toLocaleString()}</dd></div>}
        {config.filter(option=>option&&typeof option.name==='string'&&['string','boolean'].includes(typeof option.currentValue)).map((option,index)=><div key={index}><dt>{option.name}</dt><dd>{typeof option.currentValue==='boolean'?(option.currentValue?'开启':'关闭'):option.currentValue}</dd></div>)}
        {commands.length>0&&<div><dt>命令</dt><dd>{commands.filter(command=>typeof command?.name==='string').map(command=>'/'+command.name).join(' · ')}</dd></div>}
      </dl>}{cancel&&<AsyncButton className="subtle" onError={onError} onAction={()=>cancelChild(id)}>停止子代理</AsyncButton>}{renderChild?.(id)}</div>
    </details>;
  }
  if(first.kind==='permission')return <details className="acp-permission-record"><summary>授权请求 · {text}</summary>{!!first.data?.toolCall&&<pre>{JSON.stringify(first.data.toolCall,null,2)}</pre>}</details>;
  if(first.kind==='notice'||first.kind==='turn'||first.kind==='elicitation')return <div className="acp-turn-divider"><span>{first.kind==='turn'?'✓ ':first.kind==='elicitation'?'提问 · ':''}{text}</span></div>;
  return <ConversationMessage role={first.kind==='user'?'user':first.kind==='error'?'error':'assistant'} text={rich?'':text} label={label} timestamp={first.createdAt} streaming={streaming} onError={onError}>{rich&&<ContentBlocks sessionId={sessionId} blocks={blocks} onOpenFile={onOpenFile} streaming={streaming}/>}
    {Array.isArray(first.data?.attachments)&&<div className="acp-attachment-list">{first.data.attachments.map((item,index)=>
      item?.type==='file'&&typeof item.path==='string'&&onOpenFile?<button key={index} onClick={()=>onOpenFile(item.path)}>{item.path}</button>:<span className="badge" key={index}>{String(item?.name??item?.path??'附件')}</span>)}</div>}</ConversationMessage>;
});
