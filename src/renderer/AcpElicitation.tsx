import {useLayoutEffect,useRef} from 'react';
import {elicitationControls} from '../shared/elicitation-controls';
import type {AcpElicitation,ElicitationContent} from '../shared/acp-elicitation';
const drafts=new Map<string,ElicitationContent>();

export function AcpElicitationForm({request,sessionId,onError,disabled}:{request:AcpElicitation;sessionId:string;onError:(message:string)=>void;disabled:boolean}){
  const host=useRef<HTMLDivElement>(null),latest=useRef({onError,disabled});latest.current={onError,disabled};
  useLayoutEffect(()=>elicitationControls(host.current!,request,(action,content?:ElicitationContent)=>{
    if(latest.current.disabled)throw new Error('连接已中断，回答已保留；请重连后核对请求');
    return window.berth.rpc('acpElicitation',{sessionId,requestId:request.id,action,content});
  },message=>latest.current.onError(message),drafts),[sessionId,request.id]);
  return <div ref={host} className="acp-elicitation" aria-disabled={disabled}/>;
}
