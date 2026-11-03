import {useEffect,useRef,useState} from 'react';
import {Dialog} from './Dialog';
import {AsyncButton} from './AsyncButton';

export function SourceDevelopmentGuide({onClose}:{onClose:()=>void}){
  const [guide,setGuide]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  const opener=useRef(document.activeElement as HTMLElement);
  useEffect(()=>{let alive=true;void window.berth.pluginDevelopmentPrompt(undefined,'superagent-source').then(value=>{if(alive)setGuide(value);}).catch(error=>{if(alive)setError(String(error));});return()=>{alive=false;};},[]);
  return <Dialog title="Superagent 信息源开发指南" error={error} onClose={onClose} returnFocus={opener.current}>
    <p className="form-hint">包含接入步骤、完整本地示例、事件与回传契约和验收清单。可复制给 Agent，或导出开发目录直接修改。</p>
    <textarea className="source-development-guide" aria-label="信息源开发指南内容" readOnly value={guide||'正在加载开发指南…'}/>
    {message&&<p role="status">{message}</p>}
    <footer><AsyncButton className="extension-button subtle" onError={setError} onAction={async()=>{const folder=await window.berth.exportPluginKit();if(!folder)return 'cancelled';setGuide(await window.berth.pluginDevelopmentPrompt(folder,'superagent-source'));setMessage('开发套件已导出：'+folder);}}>导出开发套件</AsyncButton><AsyncButton className="extension-button primary" disabled={!guide} onError={setError} onAction={()=>window.berth.copyText(guide)}>复制给 Agent</AsyncButton></footer>
  </Dialog>;
}
