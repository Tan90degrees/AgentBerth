import { useEffect, useState } from 'react';
import { sshConnectionSchema, type SshConnection, type SshConnectionConfig } from '../shared/protocol';

const emptyConnection = (): SshConnectionConfig => ({alias:'',hostname:'',port:22,username:'',authentication:'password',privateKeyPath:'',allowAgent:true});
const authLabels = { password: '密码', key: '私钥文件', agent: '系统 SSH Agent' };

export function SshConnectionEditor({ value, disabled, onSaved, onCancel, onError }: { value?: SshConnection; disabled: boolean; onSaved: (value: SshConnection) => void; onCancel: () => void; onError: (error: string) => void }) {
  const [draft,setDraft] = useState<SshConnectionConfig>(value ? (({id: _id,...config}) => config)(value) : emptyConnection());
  const [error,setError] = useState('');
  const report = (message: string) => {setError(message);onError(message);};
  const [password,setPassword] = useState(''), [passphrase,setPassphrase] = useState(''), [remember,setRemember] = useState(false), [saving,setSaving] = useState(false);
  const change = (patch: Partial<SshConnectionConfig>) => setDraft(previous => ({...previous,...patch}));
  const save = async () => {
    const parsed = sshConnectionSchema.safeParse(draft);
    if (!parsed.success) { report(parsed.error.issues[0]?.message ?? '请填写连接别名、地址与用户名'); return; }
    if (!value && draft.authentication === 'password' && !password) { report('请输入登录密码'); return; }
    setError('');setSaving(true);
    try { const saved = await window.berth.saveSshConnection(parsed.data,value?.id,{password,passphrase},remember); setPassword(''); setPassphrase(''); onSaved(saved); }
    catch (error) { report(String(error)); }
    finally { setSaving(false); }
  };
  return <fieldset className="ssh-editor" disabled={disabled || saving}><legend>{value ? '编辑 SSH 连接' : '新建 SSH 连接'}</legend>
    {error && <div className="form-error" role="alert">{error.replace(/^Error: /,'')}</div>}
    <div className="ssh-grid"><label>连接别名<input aria-label="连接别名" value={draft.alias} maxLength={100} autoComplete="off" placeholder="例如 dev-server" onChange={e=>change({alias:e.target.value})} /></label>
    <label>主机名或 IP<input aria-label="SSH 地址" value={draft.hostname} maxLength={254} autoComplete="off" placeholder="服务器地址" onChange={e=>change({hostname:e.target.value})} /></label>
    <label>端口<input aria-label="SSH 端口" type="number" min={1} max={65535} value={draft.port} onChange={e=>change({port:Number(e.target.value)})} /></label>
    <label>用户名<input aria-label="SSH 用户名" value={draft.username} maxLength={256} autoComplete="off" placeholder="登录用户名" onChange={e=>change({username:e.target.value})} /></label></div>
    <label>登录方式<select aria-label="SSH 登录方式" value={draft.authentication} onChange={e=>{change({authentication:e.target.value as SshConnectionConfig['authentication']});setPassword('');setPassphrase('');}}>{Object.entries(authLabels).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>
    {draft.authentication === 'password' && <label>密码<input aria-label="SSH 密码" type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder={value?.authentication === 'password' ? '留空保留已保存的密码' : '输入登录密码'} /></label>}
    {draft.authentication === 'key' && <><label>私钥文件<div className="input-with-button"><input aria-label="SSH 私钥文件" value={draft.privateKeyPath} onChange={e=>change({privateKeyPath:e.target.value})} placeholder="选择本机私钥文件" /><button type="button" className="subtle" onClick={()=>void window.berth.chooseSshKey().then(file=>{if(file)change({privateKeyPath:file});}).catch(error=>onError(String(error)))}>选择文件</button></div></label><label>密钥口令（可选）<input aria-label="SSH 密钥口令" type="password" autoComplete="new-password" value={passphrase} onChange={e=>setPassphrase(e.target.value)} placeholder="私钥没有口令可留空；编辑时留空保留" /></label></>}
    {draft.authentication !== 'agent' && <label className="ssh-check"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} />记住密码或口令（系统加密存储）</label>}
    <label className="ssh-check"><input type="checkbox" checked={draft.allowAgent} onChange={e=>change({allowAgent:e.target.checked})} />允许 Agent 按此别名打开终端</label>
    <p className="form-hint">{draft.authentication === 'agent' ? '使用本机已运行的 SSH Agent 及其加载的密钥。Windows 使用 OpenSSH Authentication Agent。' : '未勾选记住时，密码和口令仅在本次应用运行期间可用。'}首次连接会显示服务器指纹供确认。远端无需安装额外程序。</p>
    <div className="mcp-actions"><button type="button" className="subtle" onClick={onCancel}>取消</button><button type="button" className="primary" onClick={()=>void save()}>{saving?'正在保存…':'保存连接'}</button></div>
  </fieldset>;
}

export function SshConnections({disabled,onError}: {disabled:boolean;onError:(error:string)=>void}) {
  const [connections,setConnections]=useState<SshConnection[]>([]), [editing,setEditing]=useState<SshConnection|null|undefined>(undefined);
  const load=()=>window.berth.rpc<SshConnection[]>('sshConnections').then(setConnections).catch(error=>onError(String(error)));
  useEffect(()=>{if(!disabled)void load();},[disabled]);
  return <section className="settings-card"><h2>SSH 连接</h2><p>保存一次登录信息，Agent 即可通过 MCP 的 terminal_open 按别名打开可见终端。</p>
    {connections.length === 0 && <p className="form-hint">尚未保存连接。地址、用户名和密码均由你填写。</p>}
    {connections.map(value=><div className="ssh-profile" key={value.id}><span><strong>{value.alias}</strong><small>{authLabels[value.authentication]} · {value.allowAgent?'允许 Agent 打开':'仅手动使用'}</small></span><button type="button" className="subtle" disabled={disabled} onClick={()=>setEditing(value)}>编辑</button><button type="button" className="subtle" disabled={disabled} onClick={()=>void window.berth.deleteSshConnection(value.id).then(load).catch(error=>onError(String(error)))}>删除</button></div>)}
    {editing === undefined ? <button type="button" className="subtle" disabled={disabled} onClick={()=>setEditing(null)}>新建 SSH 连接</button> : <SshConnectionEditor key={editing?.id??'new'} value={editing??undefined} disabled={disabled} onError={onError} onCancel={()=>setEditing(undefined)} onSaved={()=>{setEditing(undefined);void load();}} />}
  </section>;
}
