import { memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AcpEvent, AcpSnapshot } from '../shared/acp';
import type { Session, Method } from '../shared/protocol';
import { AsyncButton } from './AsyncButton';

const phases={disconnected:'未连接',connecting:'正在连接',ready:'就绪',running:'正在执行',permission:'等待你的授权',error:'需要处理'};
const Message=memo(function Message({events,streaming}:{events:AcpEvent[];streaming:boolean}){
  const first=events[0],text=events.map(event=>event.text).join('');
  if(first.kind==='thought')return <details className="acp-thought"><summary>思考过程</summary><pre>{text}</pre></details>;
  if(first.kind==='tool'){
    const data=Object.assign({},...events.map(event=>event.data??{}));
    return <details className="acp-tool"><summary>{String(data.title??first.text)} <small>{String(data.status??'')}</small></summary><pre>{JSON.stringify(data,null,2)}</pre></details>;
  }
  if(first.kind==='plan')return <details className="acp-tool" open><summary>执行计划</summary><ul>{(events.at(-1)?.data?.entries as any[]??[]).map((entry,index)=><li key={index}>{entry.status==='completed'?'✓':'○'} {entry.content}</li>)}</ul></details>;
  if(first.kind==='permission')return null;
  if(first.kind==='notice'||first.kind==='turn')return <p className="acp-notice">{text}</p>;
  return <article className={'acp-message '+first.kind}><strong>{first.kind==='user'?'你':first.kind==='error'?'执行提示':'Agent'}</strong>{streaming?<div className="acp-stream">{text}</div>:<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown>}</article>;
});
export function AcpConversation({session,connected}:{session:Session;connected:boolean}){
  const [snapshot,setSnapshot]=useState<AcpSnapshot|null>(null),[text,setText]=useState(''),[error,setError]=useState(''),[pending,setPending]=useState(false),[hasOlder,setHasOlder]=useState(false);
  const scroll=useRef<HTMLDivElement>(null),bottom=useRef(true),openerGeneration=useRef(0),request=useRef<{id:string;text:string}|null>(null);
  useEffect(()=>{
    const generation=++openerGeneration.current;let initialized=false;const queued:any[]=[];
    const apply=(event:any)=>setSnapshot(previous=>{if(!previous)return previous;if(event.state)return {...previous,...event.state};if(event.event){if(previous.events.some(item=>item.id===event.event.id))return previous;return {...previous,events:[...previous.events,event.event].sort((a,b)=>a.sequence-b.sequence)};}return previous;});
    const off=window.berth.onEvent(event=>{if(event.event==='acp'&&event.data.sessionId===session.id){if(!initialized)queued.push(event.data);else apply(event.data);}});
    void window.berth.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id}).then(value=>{if(openerGeneration.current!==generation)return;setSnapshot(value);setHasOlder(value.hasMore);initialized=true;for(const event of queued)apply(event);}).catch(error=>{if(openerGeneration.current===generation)setError(String(error));});
    return()=>{openerGeneration.current++;off();};
  },[session.id,connected]);
  const groups=useMemo(()=>{
    const groups:AcpEvent[][]=[];
    for(const event of snapshot?.events??[]){const last=groups.at(-1),previous=last?.at(-1),same=previous&&previous.turnId===event.turnId&&previous.kind===event.kind;
      if(same&&['assistant','thought'].includes(event.kind)||same&&event.kind==='tool'&&previous?.data?.toolCallId===event.data?.toolCallId)last!.push(event);else groups.push([event]);}
    return groups;
  },[snapshot?.events]);
  useEffect(()=>{if(bottom.current)scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'instant'});},[snapshot?.events,snapshot?.permissions]);
  const call=async(method:Method,params:Record<string,unknown>={})=>{setError('');return window.berth.rpc(method,{sessionId:session.id,...params});};
  const sending=!!snapshot&&['running','permission'].includes(snapshot.phase);
  async function send(){
    if(!text.trim()||pending||sending||!connected||!snapshot)return;
    const content=text.trim(),submission=request.current?.text===content?request.current:{id:crypto.randomUUID(),text:content};request.current=submission;setPending(true);setError('');
    try{await call('acpSend',{requestId:submission.id,text:submission.text});setText(previous=>previous.trim()===submission.text?'':previous);request.current=null;bottom.current=true;}
    catch(error){setError(String(error));}finally{setPending(false);}
  }
  return <section className="acp-conversation" aria-label="ACP 对话">
    <header className="acp-toolbar"><span className="badge">ACP · {snapshot?phases[snapshot.phase]:'读取记录…'}</span>
      {snapshot?.nativeSessionId&&<small title={snapshot.nativeSessionId}>{snapshot.nativeSessionId.slice(0,16)}</small>}
      {snapshot?.modes&&<label>模式<select aria-label="ACP 会话模式" disabled={snapshot.phase!=='ready'} value={snapshot.modes.currentModeId} onChange={event=>void call('acpConfigure',{configId:'mode',value:event.target.value}).catch(error=>setError(String(error)))}>{snapshot.modes.availableModes.map(mode=><option key={mode.id} value={mode.id}>{mode.name}</option>)}</select></label>}
      {snapshot?.configOptions?.map(option=><label key={option.id}>{option.name}<select aria-label={'ACP '+option.name} disabled={snapshot.phase!=='ready'} value={option.currentValue??''} onChange={event=>void call('acpConfigure',{configId:option.id,value:event.target.value}).catch(error=>setError(String(error)))}>{option.options?.flatMap(item=>item.options??[{value:item.value??'',name:item.name??item.value??''}]).map(item=><option key={item.value} value={item.value}>{item.name}</option>)}</select></label>)}
    </header>
    <div className="acp-messages" ref={scroll} onScroll={()=>{const box=scroll.current!;bottom.current=box.scrollHeight-box.scrollTop-box.clientHeight<64;}}>
      {hasOlder&&<AsyncButton className="subtle" onError={setError} onAction={async()=>{const value=await window.berth.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id,before:snapshot?.events[0]?.sequence});setHasOlder(value.hasMore);bottom.current=false;setSnapshot(previous=>previous?{...previous,events:[...value.events,...previous.events].filter((event,index,all)=>all.findIndex(item=>item.id===event.id)===index)}:value);}}>加载更早的消息</AsyncButton>}
      {!groups.length&&<div className="acp-welcome"><h2>开始这段对话</h2><p>发送任务后，Agent 的回复、计划、工具调用和授权请求会显示在这里。</p></div>}
      {groups.map(events=><Message key={events[0].id} events={events} streaming={sending&&events[0].kind==='assistant'&&events[0].turnId===snapshot?.turnId}/>)}
    </div>
    {(error||snapshot?.error)&&<p role="alert" className="form-error">{error||snapshot?.error}</p>}
    {snapshot?.phase==='error'&&<AsyncButton className="subtle" onError={setError} onAction={async()=>{await call('stop');await call('start',{cols:100,rows:30,resume:true});}}>重新连接 Agent</AsyncButton>}
    {snapshot?.phase==='error'&&snapshot.authMethods?.map(method=><AsyncButton key={method.id} className="subtle" onError={setError} onAction={()=>call('acpAuthenticate',{methodId:method.id})}>{'登录：'+method.name}</AsyncButton>)}
    {snapshot?.permissions.map(permission=><section key={permission.id} className="acp-permission" role="group" aria-label="Agent 授权请求"><strong>{permission.title}</strong><div>{permission.options.map(option=><AsyncButton key={option.optionId} className={option.kind.startsWith('allow')?'primary':'subtle'} onError={setError} onAction={()=>call('acpPermission',{permissionId:permission.id,optionId:option.optionId})}>{option.name}</AsyncButton>)}<AsyncButton className="subtle" onError={setError} onAction={()=>call('acpPermission',{permissionId:permission.id,optionId:null})}>取消授权</AsyncButton></div></section>)}
    <form className="acp-composer" onSubmit={event=>{event.preventDefault();void send();}}><textarea aria-label="发送给 Agent 的消息" placeholder="描述任务…" value={text} maxLength={40000} disabled={!connected||!snapshot||pending} onChange={event=>{setText(event.target.value);if(request.current?.text!==event.target.value.trim())request.current=null;}} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/><footer><small>Enter 发送 · Shift+Enter 换行</small>{sending?<AsyncButton className="subtle" onError={setError} onAction={()=>call('acpCancel')}>停止任务</AsyncButton>:<button className="primary" disabled={!connected||!snapshot||!text.trim()||pending}>发送</button>}</footer></form>
  </section>;
}
