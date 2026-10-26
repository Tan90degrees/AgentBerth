import { useEffect, useRef, useState } from 'react';
import type { RemoteInfo, State } from '../shared/protocol';
import type { TreeMenuTarget } from './ContextMenu';
import { RemoteBar } from './RemoteTerminal';
import { Dialog } from './Dialog';
import { SshConnections } from './SshConnections';
import { TerminalView } from './TerminalView';
import { OutputBadge } from './useTerminalActivity';
import { readStored, saveStored } from './storage';
import { useSshHeight } from './useSshHeight';
import { AsyncButton } from './AsyncButton';

/** One mounted remote viewport. Opening the dock never starts a new SSH session. */
export function SshDock({unread,state,visible,connected,sessionId,onSelect,onClose,onMenu,onError,connectionEpoch,hasLocal,detached=false,onWindow}: {
  unread: ReadonlySet<string>; state: State; visible: boolean; connected: boolean; sessionId: string; onSelect: (id:string)=>void; onClose:()=>void;
  onMenu:(target:TreeMenuTarget)=>void; onError:(error:string)=>void; connectionEpoch:number; hasLocal:boolean;
  detached?:boolean; onWindow:()=>Promise<unknown>;
}) {
  const resize=useSshHeight();
  const sessions=state.sessions.filter(session=>session.remote);
  const session=sessions.find(item=>item.id===sessionId);
  const [serversOpen,setServersOpen]=useState(false),[serverError,setServerError]=useState('');
  const serverOpener=useRef<HTMLButtonElement|null>(null);
  const [expanded,setExpanded]=useState(()=>readStored('berth.sshExpanded')==='true');
  const [info,setInfo]=useState<RemoteInfo|null>(null);
  const active=session?.latestRun?.status==='running';
  useEffect(()=>{setInfo(null);},[sessionId,session?.latestRun?.id]);
  const menu=(element:HTMLElement,x?:number,y?:number)=>{if(!session)return;const box=element.getBoundingClientRect();onMenu({kind:'session',id:session.id,opener:element,x:x??box.right,y:y??box.bottom});};
  return <section ref={resize.host} className={`ssh-dock${expanded?' expanded':''}${!hasLocal?' sole-terminal':''}`} hidden={!visible} aria-label="SSH 实时终端">
    {hasLocal&&<div className="ssh-height-resizer" role="separator" tabIndex={0} aria-label="调整终端高度" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={Math.max(120,resize.available-120)} aria-valuenow={resize.height}
      title="拖动调整终端高度，双击恢复默认；方向键微调"
      onDoubleClick={()=>{setExpanded(false);saveStored('berth.sshExpanded','false');resize.reset();}}
      onPointerDown={event=>{if(event.button!==0)return;setExpanded(false);saveStored('berth.sshExpanded','false');resize.onPointerDown(event);}}
      onPointerMove={resize.onPointerMove} onPointerUp={resize.finish} onPointerCancel={resize.finish} onLostPointerCapture={resize.finish}
      onKeyDown={event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();setExpanded(false);saveStored('berth.sshExpanded','false');resize.adjust(event.key==='Home'?120:event.key==='End'?resize.available-120:resize.height+(event.key==='ArrowUp'?1:-1)*(event.shiftKey?50:10));}} />}
    <header className="ssh-dock-header" data-session-id={session?.id} onContextMenu={event=>{event.preventDefault();menu(event.currentTarget,event.clientX,event.clientY);}}>
      <h2>{session?.title??'SSH 远端终端'}</h2>{sessions.some(value=>unread.has(value.id))&&<OutputBadge />}
      <select aria-label="SSH 终端" value={session?.id??''} disabled={!sessions.length} onChange={event=>onSelect(event.target.value)}>
        <option value="">选择 Agent 会话</option>
        {sessions.length>0&&<optgroup label="已有会话">{sessions.map(value=><option key={value.id} value={value.id}>{unread.has(value.id)?'[新输出] ':''}{value.title} · {value.remote?.host}{value.latestRun?.status==='running'?' · 运行中':''}</option>)}</optgroup>}
      </select>
      {session&&<button type="button" className="subtle" aria-label="SSH 会话操作" onClick={event=>menu(event.currentTarget)}>⋯</button>}
      <button ref={serverOpener} type="button" className="subtle" disabled={!connected||state.apiVersion<22} onClick={()=>{setServerError('');setServersOpen(true);}}>服务器</button>
      <AsyncButton className="subtle" onAction={onWindow} onError={onError} title={detached?'返回主窗口，SSH 连接继续运行':'在独立窗口显示，继续使用当前 SSH 会话'}>{detached?'放回主窗口':'在独立窗口打开'}</AsyncButton>
      {hasLocal&&<button type="button" className="icon-button" aria-label={expanded?'还原 SSH 面板':'放大 SSH 面板'} onClick={()=>setExpanded(previous=>{saveStored('berth.sshExpanded',String(!previous));return !previous;})}>{expanded?'↙':'↗'}</button>}
      {!detached&&<button type="button" className="icon-button" aria-label="收起 SSH 面板" title="只收起显示，连接继续运行" onClick={onClose}>×</button>}
    </header>
    {session&&active&&<RemoteBar key={`remote-status:${session.id}:${session.latestRun!.id}:${connectionEpoch}`} sessionId={session.id} runId={session.latestRun!.id} onControl={setInfo} onError={onError} transfersSupported={state.apiVersion>=25} />}
    {session&&active?<TerminalView key={`remote-terminal:${session.id}:${session.latestRun!.id}:${connectionEpoch}`} sessionId={session.id} remoteSession inputEnabled={info?.sessionId===session.id&&info.owner==='user'&&info.connection==='connected'} fontSize={state.settings.fontSize} autoFocus={false} onError={onError} />:<div className="ssh-dock-empty" role="status"><p>{session?.latestRun?.error??(session?session.latestRun?'SSH 会话已停止，Agent 可按需重新打开。':'会话已就绪，让 Agent 打开连接。':'先填写服务器信息，再让 Agent 通过 MCP 按别名打开或管理会话。')}</p><small>{detached?'远端输出会实时显示在这里。关闭此窗口会将面板放回主窗口，SSH 连接继续运行。':'本机 Agent 保持在上方；远端输出会实时显示在这里。收起面板不会断开 SSH。'}</small></div>}
    {serversOpen&&<Dialog title="SSH 服务器" error={serverError} returnFocus={serverOpener.current} onClose={()=>setServersOpen(false)}><SshConnections disabled={!connected} onError={setServerError} /></Dialog>}
  </section>;
}
