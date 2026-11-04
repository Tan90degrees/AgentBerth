import {useEffect,useState} from 'react';
import {AsyncButton} from './AsyncButton';

export function SourceDevelopmentGuide(){
  const [guide,setGuide]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  useEffect(()=>{let alive=true;void window.berth.pluginDevelopmentPrompt(undefined,'superagent-source').then(value=>{if(alive)setGuide(value);}).catch(error=>{if(alive)setError(String(error));});return()=>{alive=false;};},[]);
  return <section aria-label="Superagent 信息源开发指南">
    <p className="form-hint">接入规范、示例与验收说明。</p>
    <textarea className="source-development-guide" aria-label="信息源开发指南内容" readOnly value={guide||'正在加载开发指南…'}/>
    {error&&<p role="alert" className="form-error">{error}</p>}
    {message&&<p role="status">{message}</p>}
    <footer><AsyncButton className="extension-button subtle" onError={setError} onAction={async()=>{const folder=await window.berth.exportPluginKit();if(!folder)return 'cancelled';setGuide(await window.berth.pluginDevelopmentPrompt(folder,'superagent-source'));setMessage('开发套件已导出：'+folder);}}>导出开发套件</AsyncButton><AsyncButton className="extension-button primary" disabled={!guide} onError={setError} onAction={()=>window.berth.copyText(guide)}>复制给 Agent</AsyncButton></footer>
  </section>;
}
