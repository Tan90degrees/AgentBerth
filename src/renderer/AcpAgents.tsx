import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { AsyncButton } from './AsyncButton';
import type { AgentDefinition, State } from '../shared/protocol';

export function AcpAgents({onError}:{onError:(error:string)=>void}){
  const [agents,setAgents]=useState<AgentDefinition[]>([]),[editing,setEditing]=useState<AgentDefinition|null|undefined>();
  const [name,setName]=useState(''),[executable,setExecutable]=useState(''),[args,setArgs]=useState('[]'),[env,setEnv]=useState('{}'),[skills,setSkills]=useState(''),[error,setError]=useState(''),[probe,setProbe]=useState(''),[busy,setBusy]=useState(false);
  const opener=useRef<HTMLElement|null>(null),initial=useRef('');
  useEffect(()=>{let alive=true;const apply=(s:State)=>{if(alive)setAgents(s.agents?.filter(agent=>agent.acp&&!agent.sourceId?.startsWith('ext.'))??[]);};void window.berth.rpc<State>('state').then(apply).catch(error=>onError(String(error)));const off=window.berth.onEvent(event=>{if(event.event==='state')apply(event.data);});return()=>{alive=false;off();};},[]);
  const open=(value:AgentDefinition|null)=>{opener.current=document.activeElement as HTMLElement;setEditing(value);setName(value?.name??'');setExecutable(value?.acp?.executable??'');setArgs(JSON.stringify(value?.acp?.args??[]));setEnv(JSON.stringify(value?.acp?.env??{},null,2));setSkills(value?.skills?.project??'');setError('');setProbe('');initial.current=JSON.stringify([value?.name??'',value?.acp?.executable??'',JSON.stringify(value?.acp?.args??[]),JSON.stringify(value?.acp?.env??{},null,2),value?.skills?.project??'']);};
  const config=()=>({executable:executable.trim(),args:JSON.parse(args),env:JSON.parse(env)});
  return <section className="acp-agents" aria-label="ACP Agent 接入">
    <header><div><h2>ACP Agent</h2><p>使用已有 Agent 的 ACP 启动程序，以对话方式工作。会话仍在左侧项目中创建和管理。</p></div><button className="extension-button primary" onClick={()=>open(null)}>新增 ACP Agent</button></header>
    <ul className="extension-list">{agents.map(agent=><li key={agent.id}><header><div><strong>{agent.name}</strong><small>ACP · {agent.acp!.executable} {agent.acp!.args.join(' ')}</small></div><div className="extension-actions"><button className="extension-button subtle" onClick={()=>open(agent)}>编辑</button><AsyncButton className="extension-button danger" onError={onError} onAction={async()=>{if(!window.confirm(`移除 ACP 接入“${agent.name}”？使用此接入的会话需要先修改或删除。`))return 'cancelled';await window.berth.rpc('deleteAgent',{agentId:agent.id});}}>移除</AsyncButton></div></header></li>)}</ul>
    {editing!==undefined&&<Dialog title={editing?'编辑 ACP Agent':'新增 ACP Agent'} returnFocus={opener.current} onClose={()=>setEditing(undefined)} busy={busy} dirty={JSON.stringify([name,executable,args,env,skills])!==initial.current} error={error}>
      <form onSubmit={event=>{event.preventDefault();setBusy(true);setError('');void Promise.resolve().then(()=>window.berth.rpc(editing?'updateAgent':'createAgent',{...(editing?{agentId:editing.id}:{}),name:name.trim(),command:executable.trim(),acp:config(),sourceId:editing?.sourceId??'acp.'+crypto.randomUUID().replaceAll('-',''),resumeCommand:'',plugin:null,...(skills.trim()?{skills:{project:skills.trim()}}:{})})).then(()=>setEditing(undefined)).catch(error=>setError(String(error))).finally(()=>setBusy(false));}}>
        <label>Agent 名称<input aria-label="ACP Agent 名称" required value={name} maxLength={100} onChange={event=>setName(event.target.value)}/></label>
        <label>启动程序<input aria-label="ACP 启动程序" required value={executable} placeholder="opencode 或程序完整路径" onChange={event=>setExecutable(event.target.value)}/></label>
        <label>启动参数（JSON 数组）<input aria-label="ACP 启动参数" value={args} placeholder={'["acp"]'} onChange={event=>setArgs(event.target.value)}/></label>
        <p className="form-hint">OpenCode 示例：程序 opencode，参数 ["acp"]。Claude、Codex 等需使用各自的 ACP 适配器；普通 TUI 命令不能直接当作 ACP 服务。</p>
        <details><summary>高级配置</summary><label>环境变量（JSON 对象）<textarea aria-label="ACP 环境变量" value={env} onChange={event=>setEnv(event.target.value)}/></label><p className="form-hint">默认继承本机环境和 Agent 登录状态。显式填写的环境变量会保存在本机配置中。</p><label>项目 Skills 目录（可选）<input aria-label="ACP Skills 目录" value={skills} onChange={event=>setSkills(event.target.value)}/></label></details>
        <AsyncButton className="subtle" disabled={busy||!executable.trim()} onError={setError} onAction={async()=>{const result=await window.berth.rpc<any>('acpProbe',config());setProbe(JSON.stringify({agentInfo:result.agentInfo,capabilities:result.agentCapabilities,authMethods:result.authMethods},null,2));}}>测试连接</AsyncButton>
        {probe&&<pre className="acp-probe" role="status">{probe}</pre>}
        <footer><button type="button" data-dismiss="dialog" className="subtle">取消</button><button className="primary" disabled={busy}>保存 ACP 接入</button></footer>
      </form>
    </Dialog>}
  </section>;
}
