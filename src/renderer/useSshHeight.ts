import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { readStored, saveStored } from './storage';

export function clampSshHeight(value:number,available:number):number {
  return Math.round(Math.max(120,Math.min(value,Math.max(120,available-120))));
}
const initial=()=>{const value=Number(readStored('berth.sshHeight'));return Number.isFinite(value)&&value>=120?value:null;};

/** Update only the panel's CSS during a drag. Existing terminal resize scheduling
 * handles PTY fits; no viewport remount or application render per pointer event. */
export function useSshHeight() {
  const host=useRef<HTMLElement>(null),frame=useRef(0),drag=useRef<{id:number;y:number;height:number}|null>(null);
  const desired=useRef(initial()),preview=useRef(280);
  const [height,setHeight]=useState(280),[available,setAvailable]=useState(600);
  const space=()=>host.current?.closest('.workbench-split')?.clientHeight??window.innerHeight;
  const apply=(value:number)=>{preview.current=clampSshHeight(value,space());host.current?.style.setProperty('--ssh-height',`${preview.current}px`);};
  const commit=(value:number)=>{
    cancelAnimationFrame(frame.current);frame.current=0;apply(value);desired.current=preview.current;setHeight(preview.current);saveStored('berth.sshHeight',String(preview.current));
  };
  useEffect(()=>{
    const parent=host.current?.closest('.workbench-split');if(!parent)return;
    const update=()=>{const size=parent.clientHeight;if(!size)return;setAvailable(size);apply(desired.current??Math.max(280,Math.min(480,window.innerHeight*.42)));setHeight(preview.current);};
    const observer=new ResizeObserver(update);observer.observe(parent);update();
    return ()=>{observer.disconnect();cancelAnimationFrame(frame.current);document.body.classList.remove('terminal-height-resizing');};
  },[]);
  const finish=(event:PointerEvent)=>{if(drag.current?.id!==event.pointerId)return;drag.current=null;document.body.classList.remove('terminal-height-resizing');commit(preview.current);};
  return {host,height,available,
    reset:()=>{desired.current=null;saveStored('berth.sshHeight',null);apply(Math.max(280,Math.min(480,window.innerHeight*.42)));setHeight(preview.current);},
    adjust:(value:number)=>commit(value),
    onPointerDown:(event:PointerEvent<HTMLElement>)=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);preview.current=host.current!.getBoundingClientRect().height;drag.current={id:event.pointerId,y:event.clientY,height:preview.current};document.body.classList.add('terminal-height-resizing');},
    onPointerMove:(event:PointerEvent)=>{if(drag.current?.id!==event.pointerId)return;const value=drag.current.height+drag.current.y-event.clientY;preview.current=clampSshHeight(value,space());if(!frame.current)frame.current=requestAnimationFrame(()=>{apply(preview.current);frame.current=0;});},
    finish};
}
