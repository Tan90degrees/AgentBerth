import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';

/** Shared feedback; false is a handled failure, 'cancelled' is a neutral picker cancel. */
export function AsyncButton({onAction,onError,children,disabled,type='button',...props}:Omit<ButtonHTMLAttributes<HTMLButtonElement>,'onClick'|'onError'> & {onAction:()=>unknown|Promise<unknown>;onError?:(message:string)=>void}) {
  const [state,setState]=useState<'idle'|'pending'|'success'|'error'>('idle');
  const pending=useRef(false),alive=useRef(true),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;if(timer.current)clearTimeout(timer.current);};},[]);
  const run=async()=>{
    if(pending.current||disabled)return;
    pending.current=true;onError?.('');if(timer.current)clearTimeout(timer.current);setState('pending');
    let next:'idle'|'success'|'error'='success';
    try{const result=await onAction();if(result===false)next='error';else if(result==='cancelled')next='idle';}
    catch(error){next='error';onError?.(String(error));}
    finally{pending.current=false;if(alive.current){setState(next);timer.current=setTimeout(()=>{if(alive.current)setState('idle');},1800);}}
  };
  return <button {...props} aria-label={props['aria-label']??(typeof children==='string'?children:undefined)} type={type} disabled={disabled||state==='pending'} aria-busy={state==='pending'} data-feedback={state} onClick={()=>void run()}>{children}<span className="button-announcement" role="status">{state==='pending'?'正在处理':state==='success'?'操作完成':state==='error'?'操作失败，请查看错误信息':''}</span></button>;
}
