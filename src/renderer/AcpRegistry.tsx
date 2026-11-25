import { useEffect, useState } from 'react';
import type { AcpConfig } from '../shared/acp';
import type { AgentDefinition } from '../shared/protocol';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';

type Detected={name:string;executable:string;args:string[]};
type Entry={id:string;name:string;version:string;description:string;config?:AcpConfig;binary?:boolean};
export function AcpRegistry({agents,onClose,opener,onConfigure}:{agents:AgentDefinition[];onClose:()=>void;opener:HTMLElement|null;onConfigure:(name:string,config:AcpConfig)=>void}){
  const [source,setSource]=useState<'local'|'registry'>('local');
  const [local,setLocal]=useState<Detected[]>([]),[catalog,setCatalog]=useState<Entry[]|null>(null),[query,setQuery]=useState(''),[error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let current=true;
    setBusy(true);setError('');
    const request=source==='local'
      ? window.berth.rpc<Detected[]>('acpDiscover').then(result=>{if(current)setLocal(result);})
      : window.berth.rpc<Entry[]>('acpRegistry').then(result=>{if(current)setCatalog(result);});
    void request.catch(error=>{if(current)setError(String(error));}).finally(()=>{if(current)setBusy(false);});
    return ()=>{current=false;};
  },[source]);
  const matches=(name:string)=>name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const register=async(entry:Entry,previous?:AgentDefinition)=>{
    if(!entry.config&&!entry.binary)return;
    if(!window.confirm(`${previous?'更新':'安装'} ${entry.name} ${entry.version}？将下载并启动该 Agent。`))return 'cancelled';
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
    }finally{setBusy(false);}
  };
  return <Dialog title="添加 ACP Agent" onClose={onClose} returnFocus={opener} error={error} busy={busy}>
    <div className="acp-registry-actions">
      <button type="button" aria-pressed={source==='local'} disabled={busy} onClick={()=>setSource('local')}>本机已安装</button>
      <button type="button" aria-pressed={source==='registry'} disabled={busy} onClick={()=>setSource('registry')}>ACP Registry</button>
      <input aria-label="搜索 Agent" placeholder="搜索 Agent" value={query} onChange={event=>setQuery(event.target.value)}/>
    </div>
    {busy&&<p role="status">正在检查 Agent…</p>}
    {source==='local'?<>
      <ul className="acp-registry-list">{local.filter(item=>matches(item.name)).map(item=>{
        const existing=agents.find(agent=>agent.acp?.executable===item.executable&&JSON.stringify(agent.acp.args)===JSON.stringify(item.args));
        return <li key={item.executable}><header><strong>{item.name}</strong><button disabled={!!existing||busy} onClick={()=>onConfigure(item.name,{executable:item.executable,args:item.args,env:{}})}>{existing?'已接入':'配置并测试'}</button></header><small>{item.executable} {item.args.join(' ')}</small></li>;
      })}</ul>
      {!busy&&!local.length&&<p role="status">未找到已安装的 ACP 启动程序</p>}
    </>:<ul className="acp-registry-list">{catalog?.filter(item=>matches(item.name+' '+item.id)).map(item=>{
      const previous=agents.find(agent=>agent.acp?.registryId===item.id),current=previous?.acp?.registryVersion===item.version;
      return <li key={item.id}><header><strong>{item.name}</strong><span className="badge">{item.version}</span><AsyncButton disabled={current||!item.config&&!item.binary||busy} onError={setError} onAction={()=>register(item,previous)}>{current?'已安装':!item.config&&!item.binary?'手动接入':previous?'更新':'安装'}</AsyncButton></header>
        {item.description&&<p>{item.description}</p>}
        {!item.config&&!item.binary&&<small>此条目需自行安装启动程序</small>}
      </li>;
    })}</ul>}
    <footer><button className="subtle" disabled={busy} onClick={onClose}>关闭</button><button disabled={busy} onClick={()=>onConfigure('',{executable:'',args:[],env:{}})}>手动配置</button></footer>
  </Dialog>;
}
