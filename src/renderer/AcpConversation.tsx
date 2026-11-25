import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { acpOptionChoices, type AcpSnapshot } from '../shared/acp';
import type { Session, Method } from '../shared/protocol';
import { AsyncButton } from './AsyncButton';
import {AcpEventView as Message} from './AcpEventView';
import {captureHistoryAnchor,restoreHistoryAnchor} from './history-scroll';
import {AcpElicitationForm} from './AcpElicitation';
import {agentInputStyle} from '../shared/agent-input-style';
import { AcpComposer } from './AcpComposer';
import { AcpEmpty, AcpIcon } from './AcpUi';
import { AcpReview } from './AcpReview';
import {conversationGroups} from '../shared/acp-presentation';

const phases={disconnected:'未连接',connecting:'正在连接',ready:'就绪',running:'正在执行',permission:'等待你的授权',error:'需要处理'};
export function AcpConversation({session,connected,onOpenFile,task,enhanced=false,focusRequest,projectPath,onHistory}:{onHistory?:(opener:HTMLElement)=>void;session:Session;connected:boolean;enhanced?:boolean;projectPath?:string;focusRequest?:{id:string;nonce:number};task?:{title:string;label:string;onOpen:()=>void};onOpenFile?:(path:string,line?:number)=>void}){
  const [snapshot,setSnapshot]=useState<AcpSnapshot|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false),[hasOlder,setHasOlder]=useState(false),[following,setFollowing]=useState(true),[loadingOlder,setLoadingOlder]=useState(false),[initialLoading,setInitialLoading]=useState(true),[loadError,setLoadError]=useState(''),[retryNonce,setRetryNonce]=useState(0);
  const [review,setReview]=useState(false);
  const reviewOpener=useRef<HTMLElement|null>(null),interactions=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!focusRequest||!snapshot)return;
    interactions.current?.querySelector<HTMLElement>('[data-acp-request="'+CSS.escape(focusRequest.id)+'"]')?.focus();
  },[focusRequest?.nonce,snapshot?.permissions.length,snapshot?.elicitations?.length]);
  const scroll=useRef<HTMLDivElement>(null),bottom=useRef(true),openerGeneration=useRef(0),olderRequest=useRef<symbol|null>(null),prependAnchor=useRef<ReturnType<typeof captureHistoryAnchor>|null>(null),previousTop=useRef(0);
  useEffect(()=>{
    const generation=++openerGeneration.current;olderRequest.current=null;prependAnchor.current=null;setLoadingOlder(false);setInitialLoading(connected);setLoadError('');setError('');if(!snapshot||snapshot.sessionId!==session.id){setSnapshot(null);bottom.current=true;setFollowing(true);}if(!connected)return()=>{openerGeneration.current++;};let initialized=false;const queued:any[]=[];
    const apply=(event:any)=>setSnapshot(previous=>{if(!previous)return previous;if(event.state)return {...previous,...event.state};if(event.event){if(previous.events.some(item=>item.id===event.event.id))return previous;return {...previous,events:[...previous.events,event.event].sort((a,b)=>a.sequence-b.sequence)};}return previous;});
    const off=window.berth.onEvent(event=>{if(event.event==='acp'&&event.data.sessionId===session.id){if(!initialized)queued.push(event.data);else apply(event.data);}});
    void window.berth.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id}).then(value=>{if(openerGeneration.current!==generation)return;setSnapshot(previous=>previous?.sessionId===value.sessionId?{...value,events:[...new Map([...previous.events,...value.events].map(event=>[event.id,event])).values()].sort((a,b)=>a.sequence-b.sequence)}:value);setHasOlder(value.hasMore);setInitialLoading(false);initialized=true;for(const event of queued)apply(event);queued.length=0;}).catch(error=>{if(openerGeneration.current===generation){setLoadError(String(error));setInitialLoading(false);initialized=true;for(const event of queued)apply(event);queued.length=0;}});
    return()=>{openerGeneration.current++;off();};
  },[session.id,connected,retryNonce]);
  const groups=useMemo(()=>{const referenced=new Set((snapshot?.events??[]).flatMap(event=>Array.isArray(event.data?.content)?(event.data!.content as any[]).filter(item=>item?.type==='terminal').map(item=>item.terminalId):[]));return conversationGroups(snapshot?.events??[]).filter(events=>events[0].kind!=='terminal'||!referenced.has(events[0].data?.terminalId));},[snapshot?.events]);
  useEffect(()=>{if(bottom.current&&scroll.current){scroll.current.scrollTo({top:scroll.current.scrollHeight,behavior:'instant'});previousTop.current=scroll.current.scrollTop;}},[snapshot?.events,snapshot?.permissions,snapshot?.elicitations]);
  useEffect(()=>{
    const viewport=scroll.current;
    if(!viewport)return;
    const resize=new ResizeObserver(()=>{
      if(bottom.current&&!olderRequest.current){
        viewport.scrollTop=viewport.scrollHeight;
        previousTop.current=viewport.scrollTop;
      }
    });
    resize.observe(viewport);
    return ()=>resize.disconnect();
  },[]);
  useLayoutEffect(()=>{if(prependAnchor.current&&scroll.current){restoreHistoryAnchor(scroll.current,prependAnchor.current);previousTop.current=scroll.current.scrollTop;prependAnchor.current=null;olderRequest.current=null;setLoadingOlder(false);}},[snapshot?.events]);
  async function loadOlder(){
    const before=snapshot?.events[0]?.sequence,box=scroll.current;if(!connected||initialLoading||loadError||!hasOlder||olderRequest.current||!before||!box)return;
    const token=Symbol(),generation=openerGeneration.current;olderRequest.current=token;setLoadingOlder(true);
    try{const value=await window.berth.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id,before});if(openerGeneration.current!==generation||olderRequest.current!==token)return;prependAnchor.current=captureHistoryAnchor(box);bottom.current=false;setFollowing(false);setHasOlder(value.hasMore&&!!value.events.length&&value.events[0].sequence<before);setSnapshot(previous=>previous?{...previous,events:[...value.events,...previous.events].filter((event,index,all)=>all.findIndex(item=>item.id===event.id)===index)}:value);}
    catch(error){if(openerGeneration.current===generation)setError(String(error));}
    finally{if(olderRequest.current===token&&!prependAnchor.current){olderRequest.current=null;setLoadingOlder(false);}}
  }
  const ready=connected&&!initialLoading&&!loadError&&snapshot?.sessionId===session.id;
  const call=async(method:Method,params:Record<string,unknown>={})=>{if(!ready)throw new Error('请先连接后台并重新读取对话');setError('');return window.berth.rpc(method,{sessionId:session.id,...params});};
  const sending=!!snapshot&&['running','permission'].includes(snapshot.phase);
  async function configure(configId:string,value:string){setPending(true);try{await call('acpConfigure',{configId,value});}catch(error){setError(String(error));}finally{setPending(false);}}
  return <section className="acp-conversation" aria-label="ACP 对话" aria-busy={initialLoading}>
    <style>{agentInputStyle}</style>
    <header className="acp-toolbar">
      <div className="acp-toolbar-main">
        <div className="acp-identity">
          <span className="acp-agent-mark"><AcpIcon name="chat"/></span>
          <div>
            <strong title={String(snapshot?.agentInfo?.title??snapshot?.agentInfo?.name??'ACP 对话')}>{String(snapshot?.agentInfo?.title??snapshot?.agentInfo?.name??'ACP 对话')}</strong>
            <span className="acp-connection" data-phase={connected?snapshot?.phase??'connecting':'disconnected'} role="status">ACP · {!connected?'后台未连接':initialLoading?(snapshot?'正在同步…':'读取记录…'):loadError?'记录未同步':snapshot?(snapshot.elicitations?.length?'等待你的回答':phases[snapshot.phase]):'记录不可用'}</span>
          </div>
        </div>
        <div className="acp-toolbar-actions">
          {snapshot?.phase==='connecting'&&<AsyncButton className="subtle" disabled={!ready} onError={setError} onAction={()=>call('stop')}>取消连接</AsyncButton>}
          {enhanced&&!task&&<button type="button" className="subtle acp-icon-action" disabled={!ready} onClick={event=>{reviewOpener.current=event.currentTarget;setReview(true);}}><AcpIcon name="review"/>审阅改动</button>}
          {onHistory&&!task&&<button type="button" className="subtle acp-icon-action acp-square" aria-label="对话历史" title="对话历史" onClick={event=>onHistory(event.currentTarget)}><AcpIcon name="history"/></button>}
          {(snapshot?.nativeSessionId||snapshot?.usage)&&<details className="acp-conversation-details">
            <summary className="acp-icon-action acp-square" aria-label="会话详情" title="会话详情"><AcpIcon name="more"/></summary>
            <div className="acp-conversation-popover">
              {snapshot?.nativeSessionId&&<div><span>原生会话 ID</span><AsyncButton className="subtle acp-session-id" title={snapshot.nativeSessionId} aria-label="复制原生会话 ID" onError={setError} onAction={()=>window.berth.copyText(snapshot.nativeSessionId!)}>{snapshot.nativeSessionId}</AsyncButton></div>}
              {snapshot?.usage&&<div><span>上下文用量</span><meter min={0} max={snapshot.usage.size} value={Math.min(snapshot.usage.used,snapshot.usage.size)} aria-label="上下文用量"/><small>{snapshot.usage.used.toLocaleString()} / {snapshot.usage.size.toLocaleString()}{snapshot.usage.cost&&` · ${snapshot.usage.cost.amount} ${snapshot.usage.cost.currency}`}</small></div>}
            </div>
          </details>}
        </div>
      </div>
      {(snapshot?.modes||!!snapshot?.configOptions?.length)&&<div className="acp-toolbar-options" aria-label="会话模型与模式">
        {snapshot?.modes&&!snapshot.configOptions?.some(option=>option.id==='mode'||option.category==='mode')&&<label>模式<select aria-label="ACP 会话模式" disabled={!ready||snapshot.phase!=='ready'||pending} value={snapshot.modes.currentModeId} onChange={event=>void configure('mode',event.target.value)}>{snapshot.modes.availableModes.map(mode=><option key={mode.id} value={mode.id}>{mode.name}</option>)}</select></label>}
        {snapshot?.configOptions?.map(option=>{const choices=acpOptionChoices(option);return <label key={option.id}>{option.name}<select aria-label={'ACP '+option.name} disabled={!ready||snapshot.phase!=='ready'||pending||!choices.length} value={option.currentValue??''} onChange={event=>void configure(option.id,event.target.value)}>{choices.length?choices.map(item=><option key={item.value} value={item.value}>{item.name}</option>):<option value={option.currentValue??''}>暂无可选项</option>}</select></label>;})}
        {snapshot?.usage&&<small className="acp-usage-caption" title="上下文用量">{Math.round(snapshot.usage.used/snapshot.usage.size*100)}%</small>}
      </div>}
    </header>
    <div className="acp-thread">
    <div className="acp-messages" ref={scroll} style={{overflowAnchor:'none'}} onWheel={event=>{if(event.deltaY<0&&(scroll.current?.scrollTop??0)<80)void loadOlder();}} onScroll={()=>{const box=scroll.current!,up=box.scrollTop<previousTop.current;previousTop.current=box.scrollTop;bottom.current=box.scrollHeight-box.scrollTop-box.clientHeight<64;setFollowing(bottom.current);if(up&&box.scrollTop<80)void loadOlder();}}>
      {!!snapshot?.events.length&&<p className="history-load-status" role="status">{loadingOlder?'正在加载更早消息…':hasOlder?'向上滚动查看更早消息':'已到对话开头'}</p>}
      {!snapshot&&initialLoading&&<AcpEmpty icon="chat" busy>正在读取对话…</AcpEmpty>}
      {!snapshot&&!initialLoading&&<div className="acp-welcome"><h2>{connected?'暂时无法读取对话':'后台连接已断开'}</h2>{/* 尚未发送的草稿会保留。 */}</div>}
      {snapshot&&!groups.length&&<div className="acp-welcome acp-conversation-start" data-acp-motion><span className="acp-agent-mark"><AcpIcon name="chat"/></span><h2>{snapshot.phase==='ready'?'开始对话':snapshot.phase==='connecting'?'正在连接 Agent':'连接后开始对话'}</h2></div>}
      {groups.map(events=><Message key={events[0].id} events={events} sessionId={session.id} label={String(snapshot?.agentInfo?.title??snapshot?.agentInfo?.name??'Agent')} onError={setError} onOpenFile={onOpenFile} streaming={sending&&events[0].kind==='assistant'&&events[0].turnId===snapshot?.turnId}/>)}
    </div>
    {!following&&<button className="acp-jump-latest" onClick={()=>{bottom.current=true;setFollowing(true);scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}}>↓ 回到最新</button>}
    </div>
    {(!connected||loadError)&&<div className="acp-load-error" data-acp-motion role="alert"><span>{!connected?'后台连接已断开，已显示的对话和草稿会保留。':`读取对话失败：${loadError.replace(/^Error: /,'')}`}</span><AsyncButton className="subtle" disabled={initialLoading} onError={setLoadError} onAction={()=>connected?setRetryNonce(value=>value+1):window.berth.reconnect()}>{connected?'重新读取':'重新连接后台'}</AsyncButton></div>}
    {(error||snapshot?.error)&&<p role="alert" className="form-error">{error||snapshot?.error}</p>}
    {connected&&!loadError&&!task&&(snapshot?.phase==='error'||snapshot?.phase==='disconnected')&&<div className="acp-reconnect" data-acp-motion><AsyncButton className="subtle" disabled={!ready} onError={setError} onAction={async()=>{await call('stop');await call('start',{cols:100,rows:30,resume:true});}}>{snapshot?.phase==='disconnected'?'连接 Agent':'重新连接 Agent'}</AsyncButton>
    {snapshot?.phase==='error'&&snapshot.authMethods?.map(method=><AsyncButton key={method.id} className="subtle" disabled={!ready} onError={setError} onAction={()=>call('acpAuthenticate',{methodId:method.id})}>{'登录：'+method.name}</AsyncButton>)}</div>}
    <div ref={interactions} className="acp-interactions" hidden={!snapshot?.elicitations?.length&&!snapshot?.permissions.length}>
    {snapshot?.elicitations?.map(request=><div key={request.id} tabIndex={-1} data-acp-motion data-acp-request={request.id}><AcpElicitationForm request={request} sessionId={session.id} disabled={!ready} onError={setError}/></div>)}
    {snapshot?.permissions.map(permission=><section key={permission.id} tabIndex={-1} data-acp-motion data-acp-request={permission.id} className="acp-permission" role="alert" aria-label="Agent 授权请求"><strong>{permission.title}</strong>{permission.toolCall&&<PermissionDetails tool={permission.toolCall} />}<div>{permission.options.map(option=><AsyncButton key={option.optionId} className={option.kind==='allow_once'?'primary':'subtle'} disabled={!ready} onError={setError} onAction={()=>call('acpPermission',{permissionId:permission.id,optionId:option.optionId})}>{option.name}</AsyncButton>)}<AsyncButton className="subtle" disabled={!ready} onError={setError} onAction={()=>call('acpPermission',{permissionId:permission.id,optionId:null})}>取消授权</AsyncButton></div></section>)}
    </div>
    {task?<section className="acp-task-route" aria-label="Superagent 任务操作"><div><strong>{task.title}</strong><span>{task.label}</span></div><button className="primary" onClick={task.onOpen}>返回任务并回答</button></section>:<AcpComposer session={session} snapshot={snapshot} enhanced={enhanced} ready={ready} onError={setError} onSent={()=>{bottom.current=true;setFollowing(true);}} call={call}/>}
    {review&&<AcpReview session={session} workspacePath={session.worktreePath??projectPath} events={snapshot?.events??[]} onClose={()=>setReview(false)} onOpenFile={onOpenFile} returnFocus={reviewOpener.current}/>}
  </section>;
}
function PermissionDetails({tool}:{tool:Record<string,unknown>}){
  const input=tool.rawInput&&typeof tool.rawInput==='object'?tool.rawInput as Record<string,unknown>:{};
  const command=typeof input.command==='string'?input.command:Array.isArray(input.command)&&input.command.every(item=>typeof item==='string')?input.command.join(' '):undefined;
  const locations=Array.isArray(tool.locations)?tool.locations.flatMap(item=>typeof item?.path==='string'?[item.path]:[]):[];
  const paths=[...new Set([...locations,...['path','filePath','cwd','workdir'].flatMap(key=>typeof input[key]==='string'?[String(input[key])]:[])])].slice(0,12);
  if(!command&&!paths.length)return null;
  return <details className="acp-permission-detail" open><summary>操作详情</summary>{command&&<pre>{command.slice(0,4000)}</pre>}{paths.map(path=><code key={path}>{path}</code>)}</details>;
}
