import {useLayoutEffect,useRef} from 'react';
import {AsyncButton} from './AsyncButton';
import {elicitationControls} from '../shared/elicitation-controls';
import type {AcpElicitation,ElicitationContent} from '../shared/acp-elicitation';
const drafts=new Map<string,ElicitationContent>();

export function AcpElicitationForm({request,sessionId,onError,disabled}:{request:AcpElicitation;sessionId:string;onError:(message:string)=>void;disabled:boolean}){
  const host=useRef<HTMLDivElement>(null),latest=useRef({onError,disabled});latest.current={onError,disabled};
  useLayoutEffect(()=>request.url?undefined:elicitationControls(host.current!,request,(action,content?:ElicitationContent)=>{
    if(latest.current.disabled)throw new Error('连接已中断，回答已保留；请重连后核对请求');
    return window.berth.rpc('acpElicitation',{sessionId,requestId:request.id,action,content});
  },message=>latest.current.onError(message),drafts),[sessionId,request.id]);
  if(request.url){
    const {href,hostname,suspicious}=request.url;
    const respond=(action:'accept'|'decline'|'cancel')=>window.berth.rpc('acpElicitation',{sessionId,requestId:request.id,action});
    return <section className="acp-permission acp-url-request" aria-label="Agent 网页请求">
      <strong>{request.message}</strong>
      <p><b>{hostname}</b>{suspicious&&<small> · 请核对域名与连接类型</small>}</p>
      <code>{href}</code>
      <div><AsyncButton className="primary" disabled={disabled} onError={onError} onAction={async()=>{await window.berth.openExternal(href);await respond('accept');}}>打开浏览器</AsyncButton>
      <AsyncButton className="subtle" disabled={disabled} onError={onError} onAction={()=>respond('decline')}>拒绝</AsyncButton>
      <AsyncButton className="subtle" disabled={disabled} onError={onError} onAction={()=>respond('cancel')}>取消</AsyncButton></div>
    </section>;
  }
  return <div ref={host} className="acp-elicitation" aria-disabled={disabled}/>;
}
