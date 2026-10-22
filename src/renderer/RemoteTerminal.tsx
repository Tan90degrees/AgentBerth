import { useEffect, useState } from 'react';
import type { RemoteAction, RemoteConfig, RemoteInfo } from '../shared/protocol';
import './remote.css';

export function RemoteFields({ value, onChange, disabled, onError }: { value: RemoteConfig | null; onChange: (value: RemoteConfig | null) => void; disabled: boolean; onError: (error: string) => void }) {
  const [hosts,setHosts] = useState<string[]>([]);
  useEffect(() => { void window.berth.rpc<string[]>('sshHosts').then(setHosts).catch(reason => onError(String(reason))); }, []);
  return <div className="remote-fields"><label>运行位置<select aria-label="运行位置" disabled={disabled} value={value ? 'ssh' : 'local'} onChange={event => onChange(event.target.value === 'ssh' ? { host: hosts[0] ?? '', directory: '' } : null)}><option value="local">本机</option><option value="ssh">远程 SSH · 实时终端</option></select></label>{value && <>
    <label>SSH 主机别名<input aria-label="SSH 主机别名" disabled={disabled} required list="ssh-host-aliases" maxLength={254} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" value={value.host} onChange={event => onChange({ ...value, host: event.target.value })} placeholder="例如 ascend-dev" /><datalist id="ssh-host-aliases">{hosts.map(host => <option key={host} value={host} />)}</datalist></label>
    <label>远端工作目录（可选）<input aria-label="远端工作目录" disabled={disabled} maxLength={4096} value={value.directory} pattern="(/.*)?" onChange={event => onChange({ ...value, directory: event.target.value })} placeholder="留空使用 SSH 登录目录" /></label>
    <p className="form-hint">沿用 ~/.ssh/config 中的密钥、端口和跳板机。请先在系统终端成功登录并确认主机密钥；此处不弹出密码输入。远端无需额外安装；普通 SSH 登录 Shell 即可。项目分组、文件树与 Git 仍指向本机目录。</p>
  </>}</div>;
}

export function RemoteBar({ sessionId, runId, onControl, onError }: { sessionId: string; runId: string; onControl: (info: RemoteInfo | null) => void; onError: (error: string) => void }) {
  const [info,setInfo] = useState<RemoteInfo|null>(null);
  const [actions,setActions] = useState<RemoteAction[]>([]);
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false), [more,setMore] = useState(true);
  useEffect(() => {
    let disposed = false;
    const apply = (value: RemoteInfo | null) => { if (!disposed) { setInfo(value); onControl(value); } };
    const off = window.berth.onEvent(event => {
      if (event.event === 'remote' && event.data.sessionId === sessionId && event.data.runId === runId) apply(event.data);
      if (event.event === 'remoteAction' && event.data.sessionId === sessionId) setActions(previous => [event.data,...previous.filter(action => action.id !== event.data.id)].sort((a,b) => b.sequence-a.sequence).slice(0,1000));
    });
    void window.berth.rpc<RemoteInfo|null>('remoteInfo',{sessionId}).then(value => { if (value?.runId === runId) apply(value); }).catch(reason => { if (!disposed) onError(String(reason)); });
    void window.berth.rpc<RemoteAction[]>('remoteActions',{sessionId}).then(value => { if (!disposed) { setActions(previous => [...new Map([...value,...previous].map(action => [action.id,action])).values()].sort((a,b) => b.sequence-a.sequence)); setMore(value.length === 50); } }).catch(reason => { if (!disposed) onError(String(reason)); });
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
  return <div className="remote-session"><div className="remote-toolbar" role="group" aria-label="远程终端控制"><span className={`dot ${info?.connection === 'connected' ? 'live' : ''}`} /><span className="remote-location" title={info?.cwd ?? ''}>SSH · {info?.host ?? '连接中'}{info?.cwd ? ` · ${info.cwd}` : ''}</span><span>{info?.connection === 'connected' ? info.owner === 'agent' ? 'Agent 操作中' : '人工控制' : info?.connection === 'disconnected' ? 'SSH 已断开' : '正在连接'}</span><button className="subtle" disabled={busy || info?.connection !== 'connected'} onClick={() => void control()}>{info?.owner === 'agent' ? '接管' : '交给 Agent'}</button>{info?.connection === 'disconnected' && <button className="text-button" disabled={busy} onClick={() => void reconnect()}>重新连接（新 Shell）</button>}<button className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>操作步骤 {open ? '▴' : '▾'}</button></div>
    {info?.error && <p className="remote-error" role="status">{info.error}</p>}
    {open && <div className="remote-steps" aria-label="远程操作步骤">{!actions.length && <p>尚无操作。设置中复制 MCP 配置，连接 Agent 后点击“交给 Agent”。</p>}{actions.map(action => <div className="remote-step" key={action.id}><time>{new Date(action.startedAt).toLocaleTimeString()}</time><code title={action.label}>{action.label}</code><span className={action.status === 'unknown' ? 'remote-unknown' : ''}>{action.status === 'running' ? '运行中' : action.status === 'unknown' ? '结果未知' : action.exitCode !== null ? `退出 ${action.exitCode}` : '完成'}</span></div>)}{more && <button className="text-button" disabled={busy} onClick={() => void older()}>更早的步骤</button>}</div>}
  </div>;
}

export function McpSettings({ disabled, onError }: { disabled: boolean; onError: (error: string) => void }) {
  const [copied,setCopied] = useState(false);
  return <section className="settings-card"><h2>Agent 远程终端 · MCP</h2><p>在项目中新建“远程 SSH”会话。将配置加入你的 Agent MCP 设置，启动会话后点击“交给 Agent”，即可实时观看并随时接管。</p><p className="form-hint">配置包含本机程序路径，不含 SSH 密钥。AgentBerth 需保持后台运行；MCP 断开不关闭 SSH。主窗口关闭继续运行；托盘退出关闭 SSH。SSH 链路断开后，原进程不可保证恢复或停止。</p><button className="subtle" disabled={disabled} onClick={() => void window.berth.mcpConfig().then(value => window.berth.copyText(value)).then(() => setCopied(true)).catch(reason => onError(String(reason)))}>{copied ? 'MCP 配置已复制' : '复制 MCP 配置'}</button><button className="text-button" onClick={() => void window.berth.copyText('请使用 AgentBerth MCP 操作我指定的远程终端。先 terminal_list 选择会话，terminal_screen 查看状态；仅在用户交给 Agent 后输入。POSIX Shell 命令使用 terminal_execute；phase=unknown 时先读屏确认空闲提示符，再传 atPrompt=true；其他 Shell 使用读屏和按键。新命令生成 UUID requestId，同一请求重试复用 ID；长任务用 terminal_wait 等待同一 actionId，不重复执行。TUI 用 terminal_screen 和 terminal_keys。结果 unknown 时先检查，不能重放。SSH 断线不会恢复原进程，用户重新连接会新建 Shell。不要同时用 ssh-skill 或直接 SSH 绕过共享终端；用户接管后停止输入。').catch(reason => onError(String(reason)))}>复制给 Agent 的说明</button></section>;
}
