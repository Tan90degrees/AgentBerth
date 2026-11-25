import { useEffect, useRef, useState } from 'react';
import {ACP_STARTUP_TIMEOUT_MS,type AcpConfig} from '../shared/acp';
import {ACP_WORKBENCH_API_VERSION,acpCapability} from '../shared/acp-workbench';
import { AcpMcpConfig } from './AcpMcpConfig';
import { AcpRegistry } from './AcpRegistry';
import { Dialog } from './Dialog';
import { AsyncButton } from './AsyncButton';
import type { AgentDefinition, State } from '../shared/protocol';

export function AcpAgents({onError,apiVersion=0}:{apiVersion?:number;onError:(error:string)=>void}){
  const [agents,setAgents]=useState<AgentDefinition[]>([]),[editing,setEditing]=useState<AgentDefinition|null|undefined>();
  const [name,setName]=useState(''),[executable,setExecutable]=useState(''),[args,setArgs]=useState('[]'),[env,setEnv]=useState('{}'),[skills,setSkills]=useState(''),[error,setError]=useState(''),[probe,setProbe]=useState(''),[busy,setBusy]=useState(false),[reachable,setReachable]=useState<string|null>(null);
  const [catalog,setCatalog]=useState(false),[mcpAgent,setMcpAgent]=useState<AgentDefinition|null>(null);
  const [probeData,setProbeData]=useState<{agentInfo?:{name?:string;version?:string};agentCapabilities?:Record<string,unknown>;authMethods?:{name:string}[]}|null>(null);
  const [startupSeconds,setStartupSeconds]=useState(ACP_STARTUP_TIMEOUT_MS/1000);
  const opener=useRef<HTMLElement|null>(null),initial=useRef('');
  useEffect(()=>{let alive=true;const apply=(s:State)=>{if(alive)setAgents(s.agents?.filter(agent=>agent.acp)??[]);};void window.berth.rpc<State>('state').then(apply).catch(error=>onError(String(error)));const off=window.berth.onEvent(event=>{if(event.event==='state')apply(event.data);});return()=>{alive=false;off();};},[]);
  const open=(value:AgentDefinition|null)=>{opener.current=document.activeElement as HTMLElement;setEditing(value);setName(value?.name??'');setExecutable(value?.acp?.executable??'');setArgs(JSON.stringify(value?.acp?.args??[]));setEnv(JSON.stringify(value?.acp?.env??{},null,2));setSkills(value?.skills?.project??'');setStartupSeconds((value?.acp?.startupTimeoutMs??ACP_STARTUP_TIMEOUT_MS)/1000);setError('');setProbe('');setProbeData(null);initial.current=JSON.stringify([value?.name??'',value?.acp?.executable??'',JSON.stringify(value?.acp?.args??[]),JSON.stringify(value?.acp?.env??{},null,2),value?.skills?.project??'',(value?.acp?.startupTimeoutMs??ACP_STARTUP_TIMEOUT_MS)/1000]);};
  const enhanced=apiVersion>=ACP_WORKBENCH_API_VERSION;
  const config=()=>({executable:executable.trim(),args:JSON.parse(args),env:JSON.parse(env),startupTimeoutMs:startupSeconds*1000,
    ...(enhanced&&editing?.acp?.mcpServers?{mcpServers:editing.acp.mcpServers}:{}),
    ...(enhanced&&editing?.acp?.registryId?{registryId:editing.acp.registryId,registryVersion:editing.acp.registryVersion}:{})});
  return <section className="acp-agents" aria-label="ACP Agent 接入">
    <header><div><h2>ACP Agent</h2>{/* 使用已有 Agent 的 ACP 启动程序，以对话方式工作。会话仍在左侧项目中创建和管理。 */}</div><div className="extension-actions">{enhanced&&<button className="extension-button subtle" onClick={event=>{opener.current=event.currentTarget;setCatalog(true);}}>发现与安装</button>}<button className="extension-button primary" onClick={()=>open(null)}>新增 ACP Agent</button></div></header>
    <ul className="extension-list">{agents.map(agent=><li key={agent.id}><header><div><strong>{agent.name}</strong><small>ACP · {agent.acp!.executable} {agent.acp!.args.join(' ')}</small></div><div className="extension-actions">{enhanced&&<button className="extension-button subtle" onClick={event=>{opener.current=event.currentTarget;setMcpAgent(agent);}}>MCP</button>}{agent.sourceId?.startsWith('ext.') ? <AsyncButton className="extension-button subtle" onError={onError} onAction={async()=>{setReachable(null);await window.berth.rpc('acpProbe',agent.acp!);setReachable(agent.id);}}>{reachable===agent.id?'连接成功':'测试连接'}</AsyncButton> : <><button className="extension-button subtle" onClick={()=>open(agent)}>编辑</button><AsyncButton className="extension-button danger" onError={onError} onAction={async()=>{if(!window.confirm(`移除 ACP 接入“${agent.name}”？使用此接入的会话需要先修改或删除。`))return 'cancelled';await window.berth.rpc('deleteAgent',{agentId:agent.id});}}>移除</AsyncButton></>}</div></header></li>)}</ul>
    {mcpAgent&&<AcpMcpConfig agent={mcpAgent} opener={opener.current} onClose={()=>setMcpAgent(null)}/>}
    {catalog&&<AcpRegistry agents={agents} opener={opener.current} onClose={()=>setCatalog(false)} onConfigure={(name,config:AcpConfig)=>{
      setCatalog(false);open(null);setName(name);setExecutable(config.executable);setArgs(JSON.stringify(config.args));setEnv(JSON.stringify(config.env,null,2));
    }}/>}
    {editing!==undefined&&<Dialog title={editing?'编辑 ACP Agent':'新增 ACP Agent'} returnFocus={opener.current} onClose={()=>setEditing(undefined)} busy={busy} dirty={JSON.stringify([name,executable,args,env,skills,startupSeconds])!==initial.current} error={error}>
      <form onSubmit={event=>{event.preventDefault();setBusy(true);setError('');void Promise.resolve().then(()=>window.berth.rpc(editing?'updateAgent':'createAgent',{...(editing?{agentId:editing.id}:{}),name:name.trim(),command:executable.trim(),acp:config(),sourceId:editing?.sourceId??'acp.'+crypto.randomUUID().replaceAll('-',''),resumeCommand:'',plugin:null,...(skills.trim()?{skills:{project:skills.trim()}}:{})})).then(()=>setEditing(undefined)).catch(error=>setError(String(error))).finally(()=>setBusy(false));}}>
        <label>Agent 名称<input aria-label="ACP Agent 名称" required value={name} maxLength={100} onChange={event=>setName(event.target.value)}/></label>
        <label>启动程序<div className="input-with-button"><input aria-label="ACP 启动程序" required value={executable} placeholder="opencode、脚本或程序完整路径" onChange={event=>setExecutable(event.target.value)}/><AsyncButton type="button" className="subtle" onError={setError} onAction={async()=>{const file=await window.berth.chooseExecutable('acp');if(file)setExecutable(file);else return 'cancelled';}}>选择文件</AsyncButton></div></label>
        <label>启动参数（JSON 数组）<input aria-label="ACP 启动参数" value={args} placeholder={'["acp"]'} onChange={event=>setArgs(event.target.value)}/></label>
        {/* OpenCode：程序 opencode，参数 ["acp"]。Claude、Codex 等需使用各自的 ACP 适配器；普通 TUI 命令不能直接当作 ACP 服务。 */}
        {/* Windows 可直接选择 .cmd、.bat 或 .ps1 脚本。含空格路径完整填写，不需要加引号。Python、JavaScript 等脚本请选择 python/node 解释器，把脚本完整路径作为参数数组的第一项。 */}
        <details><summary>高级配置</summary><label>启动等待时间（秒）<input aria-label="ACP 启动等待时间" type="number" min={5} max={600} step={1} required value={startupSeconds} onChange={event=>setStartupSeconds(Number(event.target.value))}/></label>{/* 包含首次下载和插件加载；等待期间可以停止连接。 */}<label>环境变量（JSON 对象）<textarea aria-label="ACP 环境变量" value={env} onChange={event=>setEnv(event.target.value)}/></label>{/* 默认继承本机环境和 Agent 登录状态。显式填写的环境变量会保存在本机配置中。 */}<label>项目 Skills 目录（可选）<input aria-label="ACP Skills 目录" value={skills} onChange={event=>setSkills(event.target.value)}/></label></details>
        <AsyncButton className="subtle" disabled={busy||!executable.trim()} onError={setError} onAction={async()=>{const result=await window.berth.rpc<any>('acpProbe',config());if(result.protocolVersion!==1)throw new Error('该程序未协商 ACP v1');setProbeData(result);setProbe(JSON.stringify({agentInfo:result.agentInfo,capabilities:result.agentCapabilities,authMethods:result.authMethods},null,2));}}>测试连接</AsyncButton>
              {probeData&&<div className="acp-capabilities" role="status"><strong>连接成功 · {probeData.agentInfo?.name??'ACP v1'} {probeData.agentInfo?.version}</strong>
        {(probeData.agentCapabilities?.loadSession===true||acpCapability(probeData.agentCapabilities,'sessionCapabilities','resume'))&&<span className="badge">续接</span>}
        {acpCapability(probeData.agentCapabilities,'sessionCapabilities','list')&&<span className="badge">原生历史</span>}
        {acpCapability(probeData.agentCapabilities,'promptCapabilities','image')&&<span className="badge">图片</span>}
        {!!probeData.authMethods?.length&&<span className="badge">登录方式：{probeData.authMethods.map(item=>item.name).join('、')}</span>}
      </div>}
      {probe&&<details><summary>协议详情</summary><pre className="acp-probe">{probe}</pre></details>}
        <footer><button type="button" data-dismiss="dialog" className="subtle">取消</button><button className="primary" disabled={busy}>保存 ACP 接入</button></footer>
      </form>
    </Dialog>}
  </section>;
}
