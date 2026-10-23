import { useEffect, useState } from 'react';
import { SshConnectionEditor } from './SshConnections';
import type { SshConnection, RemoteAction, RemoteConfig, RemoteInfo, RemoteTransfer } from '../shared/protocol';
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

export function McpSettings({ disabled, onError }: { disabled: boolean; onError: (error: string) => void }) {
  const [copied,setCopied] = useState(false);
  return <section className="settings-card"><h2>Agent 远程终端 · MCP</h2><p>先在 SSH 连接中保存别名和登录信息，再复制 MCP 配置加入 Agent。Agent 可按别名管理会话、上传和下载文件，远端终端与传输进度实时可见；你可随时接管。</p><p className="form-hint">配置包含本机程序路径，不含 SSH 密钥。AgentBerth 需保持后台运行；MCP 断开不关闭 SSH。主窗口关闭继续运行；托盘退出关闭 SSH。SSH 链路断开后，原进程不可保证恢复或停止。</p><div className="mcp-actions"><button className="subtle" disabled={disabled} onClick={() => void window.berth.mcpConfig().then(value => window.berth.copyText(value)).then(() => setCopied(true)).catch(reason => onError(String(reason)))}>{copied ? 'MCP 配置已复制' : '复制 MCP 配置'}</button><button className="subtle" onClick={() => void window.berth.copyText('请使用 AgentBerth MCP 操作我指定的远程终端。先 terminal_list 查看已保存连接，用 terminal_open({alias:"用户指定的别名"}) 打开；后续工具可直接传 alias，无需用户填写 UUID。terminal_create 创建命名会话，terminal_update/close/delete/reconnect 管理生命周期；用户只需填写服务器信息。terminal_upload/download/transfer 通过已有 SSH 的 SFTP 传输，传 requestId 并用 terminal_transfer_status 等待；目标为完整路径，默认不覆盖，明确 resume 才续传。terminal_execute 同时返回状态、退出码、info 和 output；已知 info.phase=idle 直接执行，completed 且 output.hasMore=false 无需额外读屏或等待。已有会话被人工接管时停止输入，不能重新调用 open 抢回控制。POSIX Shell 命令使用 terminal_execute；phase=unknown 时先读屏确认空闲提示符，再传 atPrompt=true；其他 Shell 使用读屏和按键。普通命令只需 alias 和 command，可省略 requestId；工具会生成并返回 id。需要显式去重时传 UUID，同一请求重试复用 ID；长任务用 terminal_read_output，传 actionId=返回的 id、cursor=output.nextCursor；有输出或完成即返回，按 hasMore 分页。只等最终完成可用 terminal_wait。不要 sleep 或频繁读屏轮询。truncated/available=false 表示输出丢失，不可为找回日志重放。需更新后台至 API 29 并重连 MCP。命令支持多行脚本和 Tab；输出只包含本轮命令，不受终端高度或清屏影响，不用 clear 取回日志。TUI 用 terminal_screen 和 terminal_keys；text 默认附带 Enter，只有显式 enter:false 才不提交，命名 key 只发送一次。结果 unknown 时先检查，不能重放。SSH 断线不会恢复原进程，用户重新连接会新建 Shell。不要同时用 ssh-skill 或直接 SSH 绕过共享终端；用户接管后停止输入。').catch(reason => onError(String(reason)))}>复制给 Agent 的说明</button></div></section>;
}
