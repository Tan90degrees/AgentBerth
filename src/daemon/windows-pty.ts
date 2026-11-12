import type { TerminalProcess } from './remote';
import type { EventEmitter } from 'node:events';

// node-pty 1.1 exposes no public input-pipe error event. Keep its private
// ConPTY compatibility boundary here and recheck it when upgrading node-pty.
// https://github.com/microsoft/node-pty/issues/942
// https://github.com/microsoft/node-pty/issues/827
interface Conpty {
  _isReady?:boolean;
  _agent?: { inSocket: EventEmitter; outSocket: EventEmitter; resize(cols:number,rows:number):void; kill():void };
}
export function protectWindowsPty(pty:TerminalProcess, report:(error:unknown)=>void, platform:NodeJS.Platform=process.platform):boolean {
  if(platform!=='win32')return false;
  const agent=(pty as TerminalProcess & Conpty)._agent;
  if(!agent)return false; // SSH transports and injected test PTYs have no ConPTY.
  if(typeof agent.inSocket?.on!=='function'||typeof agent.outSocket?.on!=='function'||typeof agent.resize!=='function')throw new Error('Unsupported node-pty ConPTY internals');
  let ended=false,failed=false,inResize=false;
  const fail=(error:unknown)=>{if(ended||failed)return;failed=true;report(error);};
  // Keep listeners for late pipe errors after exit too. Removing them during
  // cleanup would turn a queued EAGAIN/EPIPE into another uncaught exception.
  agent.inSocket.on('error',fail);
  agent.outSocket.on('error',fail);
  pty.onExit(()=>{ended=true;});
  const resize=agent.resize;
  agent.resize=function(cols,rows){
    if(ended||failed)return;
    try {return resize.call(this,cols,rows);}
    catch(error){fail(error);if(inResize)throw error;}
  };
  const requestResize=pty.resize;
  pty.resize=function(cols,rows){
    if(ended||failed)throw new Error('终端通道已关闭，无法调整尺寸');
    inResize=true;try{return requestResize.call(this,cols,rows);}finally{inResize=false;}
  };
  const kill=pty.kill;
  pty.kill=function(signal){
    ended=true;
    // WindowsTerminal defers kill until first data too. A stopped/broken shell
    // may never send that data; release its ConPTY worker without that barrier.
    if((pty as TerminalProcess & Conpty)._isReady===false&&typeof agent.kill==='function')return agent.kill();
    return kill.call(this,signal);
  };
  return true;
}
