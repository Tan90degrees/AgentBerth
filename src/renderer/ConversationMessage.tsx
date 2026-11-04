import {Children,isValidElement,memo,useDeferredValue,useMemo,type ReactNode} from 'react';
import Markdown,{type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {AsyncButton} from './AsyncButton';
import {useHighlightedCode} from './highlighting';

export function CopyGlyph(){return <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="6" y="6" width="11" height="11" rx="2"/><path d="M13 6V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>;}
const textOf=(value:ReactNode):string=>typeof value==='string'?value:Array.isArray(value)?value.map(textOf).join(''):isValidElement<{children?:ReactNode}>(value)?textOf(value.props.children):'';
function CodeBlock({children,streaming,onError}:{children?:ReactNode;streaming:boolean;onError?:(value:string)=>void}){
  const child=Children.toArray(children).find(isValidElement),props=isValidElement<{className?:string;children?:ReactNode}>(child)?child.props:{},text=textOf(props.children).replace(/\n$/,''),language=/language-([\w+#.-]+)/.exec(props.className??'')?.[1]??'plaintext';
  const html=useHighlightedCode(text,language,!streaming&&text.length<=64000);
  return <div className="conversation-code"><div><span>{language==='plaintext'?'代码':language}</span><AsyncButton className="conversation-action" aria-label="复制代码" title="复制代码" onError={onError} onAction={()=>window.berth.copyText(text)}><CopyGlyph/><span>复制代码</span></AsyncButton></div><pre>{html===null?<code className={props.className}>{text}</code>:<code className={'hljs '+(props.className??'')} dangerouslySetInnerHTML={{__html:html}}/>}</pre></div>;
}
export const ConversationMarkdown=memo(function ConversationMarkdown({text,streaming=false,onError}:{text:string;streaming?:boolean;onError?:(value:string)=>void}){
  const deferred=useDeferredValue(text);
  const components=useMemo<Components>(()=>({pre:({children})=><CodeBlock streaming={streaming} onError={onError}>{children}</CodeBlock>,a:({href,children})=>href&&/^https?:\/\//i.test(href)?<a href={href} onClick={event=>{event.preventDefault();void window.berth.openExternal(href).catch(error=>onError?.(String(error)));}}>{children}</a>:<span title={href}>{children}</span>,img:({alt})=><span className="conversation-resource">图片{alt?'：'+alt:''}（未自动加载远程资源）</span>}),[streaming,onError]);
  return <div className="conversation-markdown"><Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{streaming?deferred:text}</Markdown></div>;
});
export const ConversationMessage=memo(function ConversationMessage({role,text,label='Agent',timestamp,streaming=false,children,onError}:{role:'user'|'assistant'|'error';text:string;label?:string;timestamp?:string|null;streaming?:boolean;children?:ReactNode;onError?:(value:string)=>void}){
  const time=timestamp?new Date(timestamp).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
  return <article className={'conversation-message '+role} data-role={role} aria-label={role==='user'?'你发送的消息':role==='error'?'执行提示':label+' 的回复'}>
    <header><span className="conversation-avatar" aria-hidden="true">{role==='user'?'你':role==='error'?'!':'A'}</span><strong>{role==='user'?'你':role==='error'?'执行提示':label}</strong>{time&&<time dateTime={timestamp??undefined}>{time}</time>}{streaming&&<span className="conversation-writing" role="status">正在回复<span aria-hidden="true"> ···</span></span>}</header>
    <div className={'conversation-bubble'+(streaming?' acp-stream':'')}>{role==='user'?<div className="conversation-user-text">{text}</div>:<ConversationMarkdown text={text} streaming={streaming} onError={onError}/>}{children}</div>
    {text&&<footer><AsyncButton className="conversation-action" aria-label={role==='user'?'复制你的消息':'复制 Agent 回复'} title="复制消息" onError={onError} onAction={()=>window.berth.copyText(text)}><CopyGlyph/><span>复制</span></AsyncButton></footer>}
  </article>;
});
