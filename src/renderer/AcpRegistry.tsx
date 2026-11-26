import { useEffect, useState } from 'react';
import type { AcpConfig } from '../shared/acp';
import type { AgentDefinition } from '../shared/protocol';
import { AcpEmpty, AcpIcon } from './AcpUi';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';

type Detected={name:string;executable:string;args:string[]};
type Entry={id:string;name:string;version:string;description:string;config?:AcpConfig;binary?:boolean};
export function AcpRegistry({agents,onClose,opener,onConfigure}:{agents:AgentDefinition[];onClose:()=>void;opener:HTMLElement|null;onConfigure:(name:string,config:AcpConfig)=>void}){
  const [source,setSource]=useState<'local'|'registry'>('local');
  const [local,setLocal]=useState<Detected[]|null>(null),[catalog,setCatalog]=useState<Entry[]|null>(null),[query,setQuery]=useState(''),[error,setError]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  const [confirmation,setConfirmation]=useState<{entry:Entry;previous?:AgentDefinition}|null>(null);
  useEffect(()=>{
    let current=true;setError('');
    if(source==='local'?local:catalog){setLoading(false);return;}
    setLoading(true);
    const request=source==='local'
      ? window.berth.rpc<Detected[]>('acpDiscover').then(result=>{if(current)setLocal(result);})
      : window.berth.rpc<Entry[]>('acpRegistry').then(result=>{if(current)setCatalog(result);});
    void request.catch(error=>{if(current)setError(String(error));}).finally(()=>{if(current)setLoading(false);});
    return ()=>{current=false;};
  },[source,retry]);
  const matches=(name:string)=>name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const register=async(entry:Entry,previous?:AgentDefinition)=>{
    if(!entry.config&&!entry.binary)return;
    setBusy(true);setError('');
    try{
      const recipe=await window.berth.rpc<AcpConfig>('acpRegistryPrepare',{registryId:entry.id,version:entry.version});
      const config={...recipe,...(previous?.acp?.mcpServers?{mcpServers:previous.acp.mcpServers}:{}),
        ...(previous?.acp?.startupTimeoutMs?{startupTimeoutMs:previous.acp.startupTimeoutMs}:{}),env:{...previous?.acp?.env,...recipe.env}};
      const result=await window.berth.rpc<{protocolVersion:number}>('acpProbe',config);
      if(result.protocolVersion!==1)throw new Error('该版本未协商 ACP v1');
      const sourceId=previous?.sourceId??'acp.registry.'+entry.id.slice(0,80);
      await window.berth.rpc(previous?'updateAgent':'createAgent',previous?
        {agentId:previous.id,name:previous.name,sourceId,acp:config,command:config.executable,resumeCommand:previous.resumeCommand??'',plugin:previous.plugin??null,...(previous.skills?{skills:previous.skills}:{})}
        :{name:entry.name,sourceId,acp:config,command:config.executable,resumeCommand:'',plugin:null});
      setConfirmation(null);
    }finally{setBusy(false);}
  };
  const localResults=local?.filter(item=>matches(item.name))??[];
  const registryResults=catalog?.filter(item=>matches(item.name+' '+item.id))??[];
  return <Dialog variant="acp-wide" title="添加 ACP Agent" onClose={onClose} returnFocus={opener} error={error} busy={busy}>
    <div className="acp-registry-toolbar">
      <div className="acp-review-tabs" role="group" aria-label="Agent 来源">
        <button type="button" aria-pressed={source==='local'} disabled={busy} onClick={()=>{setConfirmation(null);setSource('local');}}>本机已安装</button>
        <button type="button" aria-pressed={source==='registry'} disabled={busy} onClick={()=>{setConfirmation(null);setSource('registry');}}>ACP Registry</button>
      </div>
      <label className="acp-search-field"><AcpIcon name="search"/><input aria-label="搜索 Agent" placeholder="搜索 Agent" value={query} onChange={event=>setQuery(event.target.value)}/></label>
    </div>
    {confirmation&&<div className="acp-install-confirm" data-acp-motion>
      <div><strong>{confirmation.previous?'更新':'安装'} {confirmation.entry.name}</strong><small>确认后下载并启动 {confirmation.entry.version}</small></div>
      <button type="button" className="subtle" onClick={()=>setConfirmation(null)}>取消</button>
      <AsyncButton className="primary" onError={setError} onAction={()=>register(confirmation.entry,confirmation.previous)}>确认{confirmation.previous?'更新':'安装'}</AsyncButton>
    </div>}
    {loading?<AcpEmpty icon="folder" busy>{source==='local'?'正在扫描本机…':'正在读取 Registry…'}</AcpEmpty>:
      <div key={source} data-acp-motion>
        {source==='local'?<ul className="acp-registry-list">{localResults.map(item=>{
          const existing=agents.find(agent=>agent.acp?.executable===item.executable&&JSON.stringify(agent.acp.args)===JSON.stringify(item.args));
          return <li key={item.executable}><div className="acp-list-icon"><AcpIcon name="terminal"/></div><div className="acp-list-main"><strong>{item.name}</strong><small>{item.executable} {item.args.join(' ')}</small></div>
            {existing?<span className="badge">已接入</span>:<button type="button" className="subtle" onClick={()=>onConfigure(item.name,{executable:item.executable,args:item.args,env:{}})}>配置并测试</button>}
          </li>;
        })}</ul>:<ul className="acp-registry-list">{registryResults.map(item=>{
          const previous=agents.find(agent=>agent.acp?.registryId===item.id),current=previous?.acp?.registryVersion===item.version;
          return <li key={item.id}><div className="acp-list-icon"><AcpIcon name="chat"/></div><div className="acp-list-main"><strong>{item.name} <small>{item.version}</small></strong>{item.description&&<p>{item.description}</p>}</div>
            {current?<span className="badge">已安装</span>:item.config||item.binary?<button type="button" className="subtle" onClick={()=>setConfirmation({entry:item,previous})}>{previous?'更新':'安装'}</button>:
              <button type="button" className="subtle" onClick={()=>onConfigure(item.name,{executable:'',args:[],env:{}})}>手动接入</button>}
          </li>;
        })}</ul>}
        {error&&(source==='local'?!local:!catalog)&&<button type="button" className="subtle" onClick={()=>setRetry(value=>value+1)}>重试</button>}
        {!error&&!(source==='local'?localResults.length:registryResults.length)&&<AcpEmpty icon="search">{query.trim()?'没有匹配的 Agent':source==='local'?'未检测到已安装的 Agent':'暂无可用条目'}</AcpEmpty>}
      </div>}
    <footer><button type="button" className="subtle" disabled={busy} data-dismiss="dialog">关闭</button><button type="button" className="subtle" disabled={busy} onClick={()=>onConfigure('',{executable:'',args:[],env:{}})}>手动配置</button></footer>
  </Dialog>;
}
