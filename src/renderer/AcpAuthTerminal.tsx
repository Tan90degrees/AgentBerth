import {useEffect,useRef} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {inputChunks} from '../shared/desktop';
import {useTerminalTheme} from './appearance';
import {AsyncButton} from './AsyncButton';

export function AcpAuthTerminal({sessionId,terminalId,onError}:{sessionId:string;terminalId:string;onError:(value:string)=>void}){
  const host=useRef<HTMLDivElement>(null),theme=useTerminalTheme(),palette=useRef(theme),term=useRef<Terminal|null>(null);
  palette.current=theme;
  useEffect(()=>{if(term.current)term.current.options.theme=theme;},[theme]);
  useEffect(()=>{
    const element=host.current!,terminal=new Terminal({theme:palette.current,scrollback:500,cursorBlink:true});
    const fit=new FitAddon();term.current=terminal;terminal.loadAddon(fit);terminal.open(element);
    const rpc=(action:string,extra:Record<string,unknown>={})=>window.berth.rpc('acpAuthTerminal',{sessionId,terminalId,action,...extra});
    let alive=true,sequence=-1;
    const buffer:{sequence:number;output:string}[]=[];
    const write=(item:{sequence:number;output:string})=>{if(item.sequence>sequence){terminal.write(item.output);sequence=item.sequence;}};
    const off=window.berth.onEvent(event=>{
      if(event.event!=='acp'||event.data.sessionId!==sessionId||event.data.authOutput?.terminalId!==terminalId)return;
      if(sequence<0)buffer.push(event.data.authOutput);
      else write(event.data.authOutput);
    });
    void rpc('read').then(value=>{if(alive){write(value as {sequence:number;output:string});for(const item of buffer)write(item);buffer.length=0;}})
      .catch(error=>{if(alive)onError(String(error));});
    let writes=Promise.resolve();
    const input=terminal.onData(text=>{
      writes=writes.then(async()=>{for(const part of inputChunks(text)){if(!alive)break;await rpc('write',{input:part});}})
        .catch(error=>{if(alive)onError(String(error));});
    });
    const size=terminal.onResize(({cols,rows})=>{void rpc('resize',{cols:Math.max(2,Math.min(500,cols)),rows:Math.max(2,Math.min(250,rows))}).catch(()=>{});});
    const resize=new ResizeObserver(()=>fit.fit());resize.observe(element);fit.fit();terminal.focus();
    return()=>{alive=false;off();resize.disconnect();input.dispose();size.dispose();term.current=null;terminal.dispose();};
  },[sessionId,terminalId,onError]);

  return <section className="acp-auth-terminal" aria-label="Agent 登录终端">
    <header><strong>Agent 登录终端</strong><AsyncButton className="subtle" onError={onError} onAction={()=>window.berth.rpc('acpAuthTerminal',{sessionId,terminalId,action:'cancel'})}>取消登录</AsyncButton></header>
    <div ref={host} className="acp-auth-viewport"/>
  </section>;
}
