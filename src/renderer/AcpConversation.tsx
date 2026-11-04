import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { acpOptionChoices, type AcpSnapshot } from '../shared/acp';
import type { Session, Method } from '../shared/protocol';
import { AsyncButton } from './AsyncButton';
import {AcpEventView as Message} from './AcpEventView';
import {captureHistoryAnchor,restoreHistoryAnchor} from './history-scroll';
import {conversationGroups} from '../shared/acp-presentation';

const phases={disconnected:'未连接',connecting:'正在连接',ready:'就绪',running:'正在执行',permission:'等待你的授权',error:'需要处理'};
const drafts=new Map<string,string>();
export function AcpConversation({session,connected,onOpenFile,task}:{session:Session;connected:boolean;task?:{title:string;label:string;onOpen:()=>void};onOpenFile?:(path:string,line?:number)=>void}){
  const [snapshot,setSnapshot]=useState<AcpSnapshot|null>(null),[text,setText]=useState(()=>drafts.get(session.id)??''),[error,setError]=useState(''),[pending,setPending]=useState(false),[hasOlder,setHasOlder]=useState(false),[following,setFollowing]=useState(true),[loadingOlder,setLoadingOlder]=useState(false);
  useEffect(()=>{if(text)drafts.set(session.id,text);else drafts.delete(session.id);if(drafts.size>100)drafts.delete(drafts.keys().next().value!);},[text,session.id]);
  const scroll=useRef<HTMLDivElement>(null),bottom=useRef(true),openerGeneration=useRef(0),request=useRef<{id:string;text:string}|null>(null),olderRequest=useRef<symbol|null>(null),prependAnchor=useRef<ReturnType<typeof captureHistoryAnchor>|null>(null),previousTop=useRef(0);
  useEffect(()=>{
    const generation=++openerGeneration.current;olderRequest.current=null;prependAnchor.current=null;setLoadingOlder(false);bottom.current=true;setFollowing(true);let initialized=false;const queued:any[]=[];
    const apply=(event:any)=>setSnapshot(previous=>{if(!previous)return previous;if(event.state)return {...previous,...event.state};if(event.event){if(previous.events.some(item=>item.id===event.event.id))return previous;return {...previous,events:[...previous.events,event.event].sort((a,b)=>a.sequence-b.sequence)};}return previous;});
    const off=window.berth.onEvent(event=>{if(event.event==='acp'&&event.data.sessionId===session.id){if(!initialized)queued.push(event.data);else apply(event.data);}});
    void window.berth.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id}).then(value=>{if(openerGeneration.current!==generation)return;setSnapshot(value);setHasOlder(value.hasMore);initialized=true;for(const event of queued)apply(event);}).catch(error=>{if(openerGeneration.current===generation)setError(String(error));});
    return()=>{openerGeneration.current++;off();};
  },[session.id,connected]);
  const groups=useMemo(()=>{const referenced=new Set((snapshot?.events??[]).flatMap(event=>Array.isArray(event.data?.content)?(event.data!.content as any[]).filter(item=>item?.type==='terminal').map(item=>item.terminalId):[]));return conversationGroups(snapshot?.events??[]).filter(events=>events[0].kind!=='terminal'||!referenced.has(events[0].data?.terminalId));},[snapshot?.events]);
  useEffect(()=>{if(bottom.current&&scroll.current){scroll.current.scrollTo({top:scroll.current.scrollHeight,behavior:'instant'});previousTop.current=scroll.current.scrollTop;}},[snapshot?.events,snapshot?.permissions]);
  useLayoutEffect(()=>{if(prependAnchor.current&&scroll.current){restoreHistoryAnchor(scroll.current,prependAnchor.current);previousTop.current=scroll.current.scrollTop;prependAnchor.current=null;olderRequest.current=null;setLoadingOlder(false);}},[snapshot?.events]);
  async function loadOlder(){
    const before=snapshot?.events[0]?.sequence,box=scroll.current;if(!hasOlder||olderRequest.current||!before||!box)return;
    const token=Symbol(),generation=openerGeneration.current;olderRequest.current=token;setLoadingOlder(true);
    try{const value=await window.berth.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id,before});if(openerGeneration.current!==generation||olderRequest.current!==token)return;prependAnchor.current=captureHistoryAnchor(box);bottom.current=false;setFollowing(false);setHasOlder(value.hasMore&&!!value.events.length&&value.events[0].sequence<before);setSnapshot(previous=>previous?{...previous,events:[...value.events,...previous.events].filter((event,index,all)=>all.findIndex(item=>item.id===event.id)===index)}:value);}
    catch(error){if(openerGeneration.current===generation)setError(String(error));}
    finally{if(olderRequest.current===token&&!prependAnchor.current){olderRequest.current=null;setLoadingOlder(false);}}
  }
  const call=async(method:Method,params:Record<string,unknown>={})=>{setError('');return window.berth.rpc(method,{sessionId:session.id,...params});};
  const sending=!!snapshot&&['running','permission'].includes(snapshot.phase);
  async function configure(configId:string,value:string){setPending(true);try{await call('acpConfigure',{configId,value});}catch(error){setError(String(error));}finally{setPending(false);}}
  async function send(){
    if(task){task.onOpen();return;}if(!text.trim()||!connected||!snapshot)return;
    if(pending||sending){setError('Agent 仍在执行，草稿已保留；请等待完成或先停止当前任务。');return;}
    const content=text.trim(),submission=request.current?.text===content?request.current:{id:crypto.randomUUID(),text:content};request.current=submission;setPending(true);setError('');
    try{await call('acpSend',{requestId:submission.id,text:submission.text});setText(previous=>previous.trim()===submission.text?'':previous);request.current=null;bottom.current=true;setFollowing(true);}
    catch(error){setError(String(error));}finally{setPending(false);}
  }
  return <section className="acp-conversation" aria-label="ACP 对话">
    <header className="acp-toolbar">{snapshot?.phase==='connecting'&&<AsyncButton className="subtle" onError={setError} onAction={()=>call('stop')}>取消连接</AsyncButton>}<span className="badge">ACP · {snapshot?phases[snapshot.phase]:'读取记录…'}</span>
      {snapshot?.nativeSessionId&&<small title={snapshot.nativeSessionId}>{snapshot.nativeSessionId.slice(0,16)}</small>}
      {snapshot?.modes&&!snapshot.configOptions?.some(option=>option.id==='mode'||option.category==='mode')&&<label>模式<select aria-label="ACP 会话模式" disabled={snapshot.phase!=='ready'||pending} value={snapshot.modes.currentModeId} onChange={event=>void configure('mode',event.target.value)}>{snapshot.modes.availableModes.map(mode=><option key={mode.id} value={mode.id}>{mode.name}</option>)}</select></label>}
      {snapshot?.configOptions?.map(option=>{const choices=acpOptionChoices(option);return <label key={option.id}>{option.name}<select aria-label={'ACP '+option.name} disabled={snapshot.phase!=='ready'||pending||!choices.length} value={option.currentValue??''} onChange={event=>void configure(option.id,event.target.value)}>{choices.length?choices.map(item=><option key={item.value} value={item.value}>{item.name}</option>):<option value={option.currentValue??''}>暂无可选项</option>}</select></label>;})}
    </header>
    <div className="acp-messages" ref={scroll} style={{overflowAnchor:'none'}} onWheel={event=>{if(event.deltaY<0&&(scroll.current?.scrollTop??0)<80)void loadOlder();}} onScroll={()=>{const box=scroll.current!,up=box.scrollTop<previousTop.current;previousTop.current=box.scrollTop;bottom.current=box.scrollHeight-box.scrollTop-box.clientHeight<64;setFollowing(bottom.current);if(up&&box.scrollTop<80)void loadOlder();}}>
      {!!snapshot?.events.length&&<p className="history-load-status" role="status">{loadingOlder?'正在加载更早消息…':hasOlder?'向上滚动查看更早消息':'已到对话开头'}</p>}
      {!groups.length&&<div className="acp-welcome"><h2>开始这段对话</h2><p>发送任务后，Agent 的回复、计划、工具调用和授权请求会显示在这里。</p></div>}
      {groups.map(events=><Message key={events[0].id} events={events} sessionId={session.id} label={String(snapshot?.agentInfo?.title??snapshot?.agentInfo?.name??'Agent')} onError={setError} onOpenFile={onOpenFile} streaming={sending&&events[0].kind==='assistant'&&events[0].turnId===snapshot?.turnId}/>)}
    </div>
    {!following&&<button className="acp-jump-latest" onClick={()=>{bottom.current=true;setFollowing(true);scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'smooth'});}}>↓ 回到最新</button>}
    {(error||snapshot?.error)&&<p role="alert" className="form-error">{error||snapshot?.error}</p>}
    {!task&&(snapshot?.phase==='error'||snapshot?.phase==='disconnected')&&<AsyncButton className="subtle" onError={setError} onAction={async()=>{await call('stop');await call('start',{cols:100,rows:30,resume:true});}}>{snapshot?.phase==='disconnected'?'连接 Agent':'重新连接 Agent'}</AsyncButton>}
    {snapshot?.phase==='error'&&snapshot.authMethods?.map(method=><AsyncButton key={method.id} className="subtle" onError={setError} onAction={()=>call('acpAuthenticate',{methodId:method.id})}>{'登录：'+method.name}</AsyncButton>)}
    {snapshot?.permissions.map(permission=><section key={permission.id} className="acp-permission" role="group" aria-label="Agent 授权请求"><strong>{permission.title}</strong><div>{permission.options.map(option=><AsyncButton key={option.optionId} className={option.kind.startsWith('allow')?'primary':'subtle'} onError={setError} onAction={()=>call('acpPermission',{permissionId:permission.id,optionId:option.optionId})}>{option.name}</AsyncButton>)}<AsyncButton className="subtle" onError={setError} onAction={()=>call('acpPermission',{permissionId:permission.id,optionId:null})}>取消授权</AsyncButton></div></section>)}
    {task?<section className="acp-task-route" aria-label="Superagent 任务操作"><div><strong>{task.title}</strong><span>{task.label} · 在任务页回答问题和提交指令，在此查看执行过程或处理授权。</span></div><button className="primary" onClick={task.onOpen}>返回任务并回答</button></section>:<form className="acp-composer" onSubmit={event=>{event.preventDefault();void send();}}>{text.startsWith('/')&&!text.includes(' ')&&!!snapshot?.availableCommands?.length&&<div className="acp-command-menu" aria-label="Agent 命令">{snapshot.availableCommands.filter(command=>('/'+command.name).startsWith(text)).slice(0,8).map(command=><button type="button" key={command.name} onClick={()=>setText('/'+command.name+' ')}><strong>/{command.name}</strong><span>{command.description}</span></button>)}</div>}<textarea aria-label="发送给 Agent 的消息" placeholder="描述任务…" value={text} maxLength={40000} disabled={!connected||!snapshot||pending} onChange={event=>{setText(event.target.value);if(request.current?.text!==event.target.value.trim())request.current=null;}} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/><footer><small>Enter 发送 · Shift+Enter 换行</small>{sending?<AsyncButton className="subtle" onError={setError} onAction={()=>call('acpCancel')}>停止任务</AsyncButton>:<button className="primary" disabled={!connected||!snapshot||!text.trim()||pending||snapshot?.phase==='connecting'||snapshot?.phase==='error'}>发送</button>}</footer></form>}
  </section>;
}
