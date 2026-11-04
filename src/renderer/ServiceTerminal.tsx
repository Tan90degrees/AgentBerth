import {useState} from 'react';
import type {Session} from '../shared/protocol';
import type {WindowsPty} from '../shared/protocol';
import {TerminalView} from './TerminalView';

export function ServiceTerminal({session,connected,fontSize,windowsPty,onError}:{session:Session;connected:boolean;fontSize:number;windowsPty?:WindowsPty;onError:(message:string)=>void}){
  const [pending,setPending]=useState(false),run=session.latestRun;
  const running=run?.status==='running',stopping=run?.status==='stopping';
  async function control(action:'start'|'stop'|'restart'){
    if(pending)return;setPending(true);
    try{await window.berth.rpc('serviceAction',{sessionId:session.id,action,cols:100,rows:30});}
    catch(error){onError(String(error));}finally{setPending(false);}
  }
  return <section className="service-terminal" aria-label="服务终端">
    <header className="service-toolbar"><div><strong>{stopping?'正在停止':running?'运行中':run?.status==='failed'?'启动失败':'已停止'}</strong><code title={session.command}>{session.command}</code></div><span>
      <button className="subtle" disabled={!connected||pending||running||stopping} onClick={()=>void control('start')}>启动服务</button>
      <button className="subtle" disabled={!connected||pending||!running} onClick={()=>void control('stop')}>停止服务</button>
      <button className="subtle" disabled={!connected||pending||stopping} onClick={()=>void control('restart')}>重启服务</button>
    </span></header>
    {run?.error&&<p className="launch-error" role="alert">{run.error}</p>}
    {run&&connected?<TerminalView key={run.id} sessionId={session.id} inputEnabled={false} orderedResize binaryMouse fontSize={fontSize} windowsPty={windowsPty} autoFocus={false} onError={onError}/>:<div className="empty-page">{connected?'启动后在此查看服务输出':'后台连接已断开'}</div>}
    <footer className="terminal-footer"><span>只读输出 · 可选择和复制</span><span>{run?.pid&&running?'PID '+run.pid:run?.exitCode!==null&&run?.exitCode!==undefined?'退出码 '+run.exitCode:''}</span></footer>
  </section>;
}
