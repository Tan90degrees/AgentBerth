import { useEffect, useRef, useState } from 'react';
import type { RemoteInfo, Session, SshConnection, State } from '../shared/protocol';
import type { TreeMenuTarget } from './ContextMenu';
import { RemoteBar } from './RemoteTerminal';
import { TerminalView } from './TerminalView';
import { readStored, saveStored } from './storage';

/** One mounted remote viewport. Opening the dock never starts a new SSH session. */
export function SshDock({state,visible,connected,sessionId,onSelect,onClose,onSettings,onMenu,onError,connectionEpoch,hasLocal}: {
  state: State; visible: boolean; connected: boolean; sessionId: string; onSelect: (id:string)=>void; onClose:()=>void; onSettings:()=>void;
  onMenu:(target:TreeMenuTarget)=>void; onError:(error:string)=>void; connectionEpoch:number; hasLocal:boolean;
}) {
  const sessions=state.sessions.filter(session=>session.remote);
  const session=sessions.find(item=>item.id===sessionId);
  const [profiles,setProfiles]=useState<SshConnection[]>([]), [choice,setChoice]=useState(''), [busy,setBusy]=useState(false);
  const [expanded,setExpanded]=useState(()=>readStored('berth.sshExpanded')==='true');
  const [info,setInfo]=useState<RemoteInfo|null>(null);
  const opening=useRef(false);
  const active=session?.latestRun?.status==='running';
  useEffect(()=>{if(visible&&connected&&state.apiVersion>=22)void window.berth.rpc<SshConnection[]>('sshConnections').then(setProfiles).catch(error=>onError(String(error)));},[visible,connected,state.apiVersion]);
  useEffect(()=>{setInfo(null);},[sessionId,session?.latestRun?.id]);
  const connect=async()=>{
    if(opening.current)return;
    opening.current=true;setBusy(true);
    try {
      if(session) {
        if(!['running','stopping'].includes(session.latestRun?.status??''))await window.berth.rpc('start',{sessionId:session.id,cols:100,rows:30});
      } else if(choice.startsWith('profile:')) {
        const profile=profiles.find(item=>item.id===choice.slice(8));
        if(profile){const target=await window.berth.openSshConnection(profile.alias);onSelect(target.sessionId);setChoice('');}
      }
    } catch(error){onError(String(error));}
    finally{opening.current=false;setBusy(false);}
  };
  const menu=(element:HTMLElement,x?:number,y?:number)=>{if(!session)return;const box=element.getBoundingClientRect();onMenu({kind:'session',id:session.id,opener:element,x:x??box.right,y:y??box.bottom});};
  return <section className={`ssh-dock${expanded?' expanded':''}${!hasLocal?' sole-terminal':''}`} hidden={!visible} aria-label="SSH 实时终端">
    <header className="ssh-dock-header" data-session-id={session?.id} onContextMenu={event=>{event.preventDefault();menu(event.currentTarget,event.clientX,event.clientY);}}>
      <h2>{session?.title??'SSH 远端终端'}</h2>
      <select aria-label="SSH 终端" value={session?.id??choice} disabled={busy} onChange={event=>{const value=event.target.value;setChoice(value);onSelect(value.startsWith('profile:')?'':value);}}>
        <option value="">选择连接或会话</option>
        {sessions.length>0&&<optgroup label="已有会话">{sessions.map(value=><option key={value.id} value={value.id}>{value.title} · {value.remote?.host}{value.latestRun?.status==='running'?' · 运行中':''}</option>)}</optgroup>}
        <optgroup label="已保存连接">{profiles.filter(profile=>!sessions.some(value=>value.remote?.connectionId===profile.id)).map(profile=><option key={profile.id} value={'profile:'+profile.id}>{profile.alias}</option>)}</optgroup>
      </select>
      {session&&<button type="button" className="subtle" aria-label="SSH 会话操作" onClick={event=>menu(event.currentTarget)}>⋯</button>}
      {!active&&<button type="button" className="subtle" disabled={!connected||busy||state.apiVersion<23||(!session&&!choice)||session?.latestRun?.status==='stopping'} onClick={()=>void connect()}>{busy?'连接中…':session?.latestRun?.status==='stopping'?'正在停止':session?.latestRun?'重新启动':'连接'}</button>}
      <button type="button" className="text-button" onClick={onSettings}>管理连接</button>
      {hasLocal&&<button type="button" className="icon-button" aria-label={expanded?'还原 SSH 面板':'放大 SSH 面板'} onClick={()=>setExpanded(previous=>{saveStored('berth.sshExpanded',String(!previous));return !previous;})}>{expanded?'↙':'↗'}</button>}
      <button type="button" className="icon-button" aria-label="收起 SSH 面板" title="只收起显示，连接继续运行" onClick={onClose}>×</button>
    </header>
    {session&&active&&<RemoteBar key={`remote-status:${session.id}:${session.latestRun!.id}:${connectionEpoch}`} sessionId={session.id} runId={session.latestRun!.id} onControl={setInfo} onError={onError} />}
    {session&&active?<TerminalView key={`remote-terminal:${session.id}:${session.latestRun!.id}:${connectionEpoch}`} sessionId={session.id} remoteSession inputEnabled={info?.sessionId===session.id&&info.owner==='user'&&info.connection==='connected'} fontSize={state.settings.fontSize} autoFocus={false} onError={onError} />:<div className="ssh-dock-empty" role="status"><p>{session?.latestRun?.error??(session?session.latestRun?'SSH 会话已停止，可重新启动。':'会话已就绪，点击连接。':'选择已保存连接，或在设置中添加 SSH 连接。')}</p><small>本机 Agent 保持在上方；远端输出会实时显示在这里。收起面板不会断开 SSH。</small></div>}
  </section>;
}
