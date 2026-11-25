import { useEffect, useState } from 'react';
import type { AgentDefinition } from '../shared/protocol';
import { acpMcpServersSchema, type AcpMcpServer } from '../shared/acp-workbench';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';

export function AcpMcpConfig({agent,onClose,opener}:{agent:AgentDefinition;onClose:()=>void;opener:HTMLElement|null}){
  const [value,setValue]=useState('[]'),[initial,setInitial]=useState<string>(),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  useEffect(()=>{
    let alive=true;
    void window.berth.rpc<AcpMcpServer[]>('acpMcpConfig',{agentId:agent.id}).then(servers=>{
      if(!alive)return;
      const json=JSON.stringify(servers,null,2);setValue(json);setInitial(json);
    }).catch(error=>{if(alive)setError(String(error));});
    return ()=>{alive=false;};
  },[agent.id]);
  return <Dialog title={agent.name+' · MCP'} onClose={onClose} returnFocus={opener} error={error} busy={saving} dirty={initial!==undefined&&value!==initial}>
    <label>转发给普通 ACP 对话的服务<textarea aria-label="MCP 服务 JSON" rows={10} spellCheck={false} disabled={initial===undefined||saving} value={value} onChange={event=>setValue(event.target.value)}/></label>
    <div className="acp-registry-actions">{(['stdio','http','sse'] as const).map(type=><button key={type} type="button" disabled={initial===undefined||saving} onClick={()=>{
      try{
        const list=acpMcpServersSchema.parse(JSON.parse(value)),name='server-'+(list.length+1);
        const server=type==='stdio'?{name,type,command:'',args:[],env:[]}:{name,type,url:'https://',headers:[]};
        setValue(JSON.stringify([...list,server],null,2));setError('');
      }catch(error){setError(String(error));}
    }}>添加 {type}</button>)}</div>
    <footer><button className="subtle" disabled={saving} onClick={onClose}>取消</button><AsyncButton className="primary" disabled={initial===undefined||value===initial} onError={setError} onAction={async()=>{
      const servers=acpMcpServersSchema.parse(JSON.parse(value));
      if(!window.confirm('保存后，此 Agent 的普通对话会收到这些服务配置，stdio 服务可能启动本机程序。确定保存？'))return 'cancelled';
      setSaving(true);try{await window.berth.rpc('acpMcpConfig',{agentId:agent.id,servers});onClose();}finally{setSaving(false);}
    }}>保存</AsyncButton></footer>
  </Dialog>;
}
