import { useEffect, useState } from 'react';
import { AsyncButton } from './AsyncButton';
import { SshConnectionEditor } from './SshConnections';
import type { McpMetrics, SshConnection, RemoteAction, RemoteConfig, RemoteInfo, RemoteTransfer } from '../shared/protocol';
import './remote.css';

export function RemoteFields({ value, onChange, disabled, onError }: { value: RemoteConfig; onChange: (value: RemoteConfig) => void; disabled: boolean; onError: (error: string) => void }) {
  const [hosts,setHosts] = useState<string[]>([]), [connections,setConnections] = useState<SshConnection[]>([]), [creating,setCreating] = useState(false), [legacy,setLegacy] = useState(!!value?.host && !value?.connectionId);
  useEffect(() => { void Promise.all([window.berth.rpc<string[]>('sshHosts').then(setHosts), window.berth.rpc<SshConnection[]>('sshConnections').then(setConnections)]).catch(reason => onError(String(reason))); }, []);
  return <div className="remote-fields">
    <label>SSH 连接<select aria-label="SSH 连接" required disabled={disabled} value={value.connectionId ?? (creating ? 'new' : legacy ? 'legacy' : '')} onChange={event => {
      if (event.target.value === 'new') { setLegacy(false); setCreating(true); return; }
      setCreating(false);setLegacy(event.target.value === 'legacy');
      const profile=connections.find(item=>item.id===event.target.value);
      onChange({host:profile?.alias??'', connectionId:profile?.id, directory:value.directory});
    }}><option value="" disabled>选择已保存连接</option>{connections.map(profile=><option key={profile.id} value={profile.id}>{profile.alias}</option>)}<option value="new">＋ 新建 SSH 连接</option><option value="legacy">沿用系统 SSH 配置（密钥登录）</option></select></label>
    {creating && <SshConnectionEditor disabled={disabled} onError={onError} onCancel={()=>setCreating(false)} onSaved={profile=>{setConnections(previous=>[...previous,profile]);onChange({connectionId:profile.id,host:profile.alias,directory:value.directory});setCreating(false);}} />}
    {!value.connectionId && legacy && <details open><summary>系统 SSH 配置</summary><label>SSH 主机别名<input aria-label="SSH 主机别名" disabled={disabled} required list="ssh-host-aliases" maxLength={254} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" value={value.host} onChange={event => onChange({ ...value, host: event.target.value })} placeholder="例如 dev-server" /><datalist id="ssh-host-aliases">{hosts.map(host => <option key={host} value={host} />)}</datalist></label><p className="form-hint">高级：沿用 ~/.ssh/config 的密钥和跳板机，需先在系统终端登录并确认主机指纹。密码登录请选择新建 SSH 连接。</p></details>}
    <label>远端工作目录（可选）<input aria-label="远端工作目录" disabled={disabled} maxLength={4096} value={value.directory} pattern="(/.*)?" onChange={event => onChange({ ...value, directory: event.target.value })} placeholder="留空使用 SSH 登录目录" /></label>
    <p className="form-hint">远端仅需 SSH 服务及已有 Shell。SSH 会话独立管理，无需本机项目目录。</p>
  </div>;
}

export function RemoteBar({ sessionId, runId, onControl, onError, transfersSupported=false }: { sessionId: string; runId: string; onControl: (info: RemoteInfo | null) => void; onError: (error: string) => void;transfersSupported?:boolean }) {
  const [info,setInfo] = useState<RemoteInfo|null>(null);
  const [actions,setActions] = useState<RemoteAction[]>([]);
  const [transfers,setTransfers]=useState<RemoteTransfer[]>([]);
  const belongs=(value:RemoteTransfer)=>[value.spec.source,value.spec.destination].some(endpoint=>endpoint.kind==='remote'&&endpoint.sessionId===sessionId&&endpoint.runId===runId);
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false), [more,setMore] = useState(true);
  useEffect(() => {
    let disposed = false;
    const apply = (value: RemoteInfo | null) => { if (!disposed) { setInfo(value); onControl(value); } };
    const off = window.berth.onEvent(event => {
      if (event.event === 'remote' && event.data.sessionId === sessionId && event.data.runId === runId) apply(event.data);
      if (!disposed && event.event === 'remoteAction' && event.data.sessionId === sessionId) setActions(previous => [event.data,...previous.filter(action => action.id !== event.data.id)].sort((a,b) => b.sequence-a.sequence).slice(0,1000));
      if(!disposed&&event.event==='remoteTransfer'&&belongs(event.data))setTransfers(previous=>[event.data,...previous.filter(value=>value.id!==event.data.id)].slice(0,20));
    });
    void window.berth.rpc<RemoteInfo|null>('remoteInfo',{sessionId}).then(value => { if (value?.runId === runId) apply(value); }).catch(reason => { if (!disposed) onError(String(reason)); });
    void window.berth.rpc<RemoteAction[]>('remoteActions',{sessionId}).then(value => { if (!disposed) { setActions(previous => [...new Map([...value,...previous].map(action => [action.id,action])).values()].sort((a,b) => b.sequence-a.sequence)); setMore(value.length === 50); } }).catch(reason => { if (!disposed) onError(String(reason)); });
    if(transfersSupported)void window.berth.rpc<RemoteTransfer[]>('remoteTransfers',{sessionId}).then(values=>{if(!disposed)setTransfers(previous=>[...new Map([...values.filter(belongs),...previous].map(value=>[value.id,value])).values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)));}).catch(error=>{if(!disposed)onError(String(error));});
    return () => { disposed = true; off(); onControl(null); };
  }, [sessionId,runId]);
  const control = async () => {
    setBusy(true);
    try { const value = await window.berth.rpc<RemoteInfo>('remoteControl',{sessionId,runId,owner:info?.owner === 'agent' ? 'user' : 'agent'}); setInfo(value); onControl(value); }
    catch (reason) { onError(String(reason)); } finally { setBusy(false); }
  };
  const reconnect = async () => {
    setBusy(true);
    try { await window.berth.rpc('remoteReconnect',{sessionId,runId}); }
    catch(reason) {onError(String(reason));} finally {setBusy(false);}
  };
  const older = async () => {
    setBusy(true);try { const value = await window.berth.rpc<RemoteAction[]>('remoteActions',{sessionId,before:actions.at(-1)?.sequence}); setActions(previous => [...new Map([...previous,...value].map(action => [action.id,action])).values()].sort((a,b) => b.sequence-a.sequence)); setMore(value.length === 50); } catch(reason) {onError(String(reason));} finally {setBusy(false);}
  };
  const latestCommand=actions.find(action=>action.runId===runId&&action.kind==='command');
  const transfer=transfers.find(value=>value.status==='running')??transfers[0];
  const size=(bytes:number)=>bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:bytes>=1024?`${(bytes/1024).toFixed(1)} KB`:`${bytes} B`;
  return <div className="remote-session"><div className="remote-toolbar" role="group" aria-label="远程终端控制"><span className={`dot ${info?.connection === 'connected' ? 'live' : ''}`} /><span className="remote-location" title={info?.cwd ?? ''}>SSH · {info?.host ?? '连接中'}{info?.cwd ? ` · ${info.cwd}` : ''}</span><span>{info?.connection === 'connected' ? info.owner === 'agent' ? 'Agent 操作中' : '人工控制' : info?.connection === 'disconnected' ? 'SSH 已断开' : '正在连接'}</span><button className="subtle" disabled={busy || info?.connection !== 'connected'} onClick={() => void control()}>{info?.owner === 'agent' ? '接管' : '交给 Agent'}</button>{info?.connection === 'disconnected' && <button className="text-button" disabled={busy} onClick={() => void reconnect()}>重新连接（新 Shell）</button>}<button className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>操作步骤 {open ? '▴' : '▾'}</button></div>
    {latestCommand&&<div className="remote-current" aria-label="当前远端操作"><span>最近命令</span><code title={latestCommand.label}>{latestCommand.label}</code><span>{latestCommand.status==='running'?'执行中':latestCommand.status==='unknown'?'结果未知':`退出 ${latestCommand.exitCode}`}</span></div>}
    {transfer&&<div className="remote-current remote-transfer" aria-label="文件传输"><span>{({running:'传输中',completed:'传输完成',failed:'传输失败',cancelled:'已取消',unknown:'结果未知'})[transfer.status]}</span><code title={`${transfer.spec.source.path} → ${transfer.spec.destination.path}${transfer.error?' · '+transfer.error:''}`}>{transfer.spec.source.path.split(/[\\/]/).at(-1)} → {transfer.spec.destination.path.split(/[\\/]/).at(-1)}</code><span>{size(transfer.bytes)} / {size(transfer.totalBytes)} · {transfer.files}/{transfer.totalFiles}</span>{transfer.status==='running'&&<><progress aria-label="文件传输进度" max={Math.max(transfer.totalBytes,1)} value={transfer.totalBytes?transfer.bytes:undefined}/><button type="button" className="text-button" disabled={busy} onClick={()=>{setBusy(true);void window.berth.rpc('remoteTransferCancel',{requestId:transfer.id}).catch(error=>onError(String(error))).finally(()=>setBusy(false));}}>取消传输</button></>}</div>}
    {info?.error && <p className="remote-error" role="status">{info.error}</p>}
    {open && <div className="remote-steps" aria-label="远程操作步骤">{!actions.length && <p>尚无操作。设置中复制 MCP 配置，连接 Agent 后点击“交给 Agent”。</p>}{actions.map(action => <div className="remote-step" key={action.id}><time>{new Date(action.startedAt).toLocaleTimeString()}</time><code title={action.label}>{action.label}</code><span className={action.status === 'unknown' ? 'remote-unknown' : ''}>{action.status === 'running' ? '运行中' : action.status === 'unknown' ? '结果未知' : action.exitCode !== null ? `退出 ${action.exitCode}` : '完成'}</span></div>)}{more && <button className="text-button" disabled={busy} onClick={() => void older()}>更早的步骤</button>}</div>}
  </div>;
}

export function McpSettings({ disabled, onError,metricsSupported=false }: { disabled: boolean; onError: (error: string) => void;metricsSupported?:boolean }) {
  const [metrics,setMetrics]=useState<McpMetrics|null>(null);
  useEffect(()=>{
    if(!metricsSupported||disabled)return;
    let alive=true,changed=false;
    const off=window.berth.onEvent(event=>{if(event.event==='mcpMetrics'){changed=true;setMetrics(event.data);}});
    void window.berth.rpc<McpMetrics>('mcpMetrics').then(value=>{if(alive&&!changed)setMetrics(value);}).catch(error=>{if(alive)onError(String(error));});
    return ()=>{alive=false;off();};
  },[metricsSupported,disabled]);
  return <section className="settings-card">
    <h2>Agent 远程终端 · MCP</h2>
    <p>保存 SSH 连接后，将 MCP 配置添加到 Agent 即可。无需复制额外提示词：工具自带用法、执行状态与下一步引导，Agent 可按别名执行命令、管理会话和传输文件。</p>
    <p className="form-hint">你只需描述任务，例如“检查 dev-server 的磁盘空间”。执行过程在 SSH 终端中实时可见，你可随时接管。</p>
    {metricsSupported?<div className="mcp-metrics" aria-label="MCP 调用统计" title="本次后台收到的 MCP 工具调用结果；不含内部 RPC。成功指工具正常返回，命令退出码非零不计为工具调用失败。">
      <span>本次后台</span><span>调用 <strong aria-label="MCP 调用次数">{metrics?.total??0}</strong></span><span>成功率 <strong aria-label="MCP 调用成功率">{metrics?.successRate==null?'—':(metrics.successRate*100).toFixed(1)+'%'}</strong></span><span>失败 <strong aria-label="MCP 调用失败次数">{metrics?.failed??0}</strong></span>
    </div>:<p className="form-hint">更新后台后可查看 MCP 调用统计。</p>}
    {metrics&&metrics.tools.length>0&&<details className="mcp-metric-details"><summary>按工具查看</summary><table><thead><tr><th>工具</th><th>调用</th><th>成功</th><th>失败</th></tr></thead><tbody>{metrics.tools.map(row=><tr key={row.tool}><td>{row.tool}</td><td>{row.total}</td><td>{row.succeeded}</td><td>{row.failed}</td></tr>)}</tbody></table></details>}
    <div className="mcp-actions"><AsyncButton className="subtle" disabled={disabled} onError={onError} onAction={async()=>window.berth.copyText(await window.berth.mcpConfig())}>复制 MCP 配置</AsyncButton><AsyncButton className="subtle" disabled={disabled} onError={onError} onAction={async()=>window.berth.copyText(await window.berth.mcpConfig('opencode'))}>复制 OpenCode MCP 配置</AsyncButton></div>
    <p className="form-hint">配置不含 SSH 密钥。AgentBerth 需保持后台运行；主窗口关闭继续运行，托盘退出关闭 SSH。断线后重新连接会建立新的 Shell。</p>
  </section>;
}
