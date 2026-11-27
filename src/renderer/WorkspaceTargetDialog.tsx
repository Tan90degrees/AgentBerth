import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import type { WorkspaceProvisionProgress, WorkspaceSshProbe, WorkspaceSshSettings, WorkspaceTarget } from '../shared/workspace-server';

const progressLabels:Record<WorkspaceProvisionProgress,string> = {
  upload:'正在上传服务器包…', install:'正在校验并安装…', start:'正在启动服务…', connect:'正在连接工作区…',
};
const probeLabels = {
  running:{status:'已部署，服务运行中', action:'进入工作区'},
  installed:{status:'已安装，服务未运行', action:'启动并进入'},
  missing:{status:'未部署', action:'部署并进入'},
};
const formatError=(error:unknown)=>String(error).replace(/^Error invoking remote method '[^']+': Error: /,'');

export function WorkspaceTargetDialog({ current, onClose, opener }: {current?:string;onClose:()=>void;opener:HTMLElement|null}){
  const [profile,setProfile]=useState<WorkspaceTarget|null>(null);
  const [mode,setMode]=useState<'ssh'|'direct'>(current?.startsWith('wss:')||current?.startsWith('ws:')?'direct':'ssh');
  const [address,setAddress]=useState('');
  const [token,setToken]=useState('');
  const [ca,setCa]=useState<string>();
  const [remember,setRemember]=useState(false);
  const [ssh,setSsh]=useState<WorkspaceSshSettings>({host:'',port:22,username:'',authentication:'password'});
  const [port,setPort]=useState('22');
  const [password,setPassword]=useState('');
  const [passphrase,setPassphrase]=useState('');
  const [rememberSsh,setRememberSsh]=useState(false);
  const [probe,setProbe]=useState<WorkspaceSshProbe>();
  const probeId=useRef<string>(undefined);
  const addressInput=useRef<HTMLInputElement>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState('');
  useEffect(()=>{
    let active=true;
    void window.berth.workspaceTarget({action:'state'}).then(value=>{
      if(!active||!value||typeof value==='string')return;
      setProfile(value);
      const previous=value.address??value.recentAddress;
      if(previous&&!previous.startsWith('ssh:'))setAddress(previous);
      setRemember(value.savedToken);
      if(value.ssh){setSsh(value.ssh);setPort(String(value.ssh.port));}
      setRememberSsh(!!value.savedSsh);
    }).catch(error=>{if(active)setError(formatError(error));});
    const unsubscribe=window.berth.onWorkspaceProvision(phase=>setBusy(progressLabels[phase]));
    return()=>{
      active=false;unsubscribe();
      if(probeId.current)void window.berth.workspaceSsh({action:'discard',id:probeId.current}).catch(()=>{});
    };
  },[]);
  useEffect(()=>{if(profile)addressInput.current?.focus();},[profile,mode]);
  const discardProbe=()=>{
    if(probeId.current)void window.berth.workspaceSsh({action:'discard',id:probeId.current}).catch(()=>{});
    probeId.current=undefined;
    setProbe(undefined);setError('');
  };
  const updateSsh=(values:Partial<WorkspaceSshSettings>)=>{
    discardProbe();setSsh(previous=>({...previous,...values}));
  };
  const run=async(request:Parameters<typeof window.berth.workspaceTarget>[0])=>{
    setBusy('正在切换工作区…');setError('');
    try{await window.berth.workspaceTarget(request);if(request.action==='local'&&!current)onClose();}
    catch(error){setError(formatError(error));setBusy('');}
  };
  const runSsh=async()=>{
    setBusy(probe?'正在连接工作区…':'正在探测服务器…');setError('');
    if(probe){
      probeId.current=undefined;setProbe(undefined);
      try{await window.berth.workspaceSsh({action:'activate',id:probe.id,remember:rememberSsh});}
      catch(error){void window.berth.workspaceSsh({action:'discard',id:probe.id}).catch(()=>{});setError(formatError(error));setBusy('');}
      return;
    }
    try{
      const result=await window.berth.workspaceSsh({action:'probe',settings:{...ssh,port:Number(port)},
        ...(ssh.authentication==='password'?{password}:{passphrase})});
      if(result&&'status' in result){probeId.current=result.id;setProbe(result);}
    }catch(error){setError(formatError(error));}
    finally{setBusy('');}
  };
  const previous=profile?.ssh;
  const sameSsh=previous?.host===ssh.host.trim().toLowerCase().replace(/^\[([^\]]+)\]$/,'$1')&&previous.port===Number(port)&&previous.username===ssh.username.trim()&&
    previous.authentication===ssh.authentication&&previous.keyPath===ssh.keyPath;
  const savedSsh=profile?.savedSsh&&sameSsh;
  const savedToken=profile?.savedToken&&address===profile.recentAddress;
  const hasCertificate=ca===undefined?profile?.hasCertificate&&address===profile.recentAddress:!!ca;
  const sshValid=!!ssh.host.trim()&&!!ssh.username.trim()&&Number.isInteger(Number(port))&&Number(port)>=1&&Number(port)<=65535&&
    (ssh.authentication==='password'?!!password||savedSsh:!!ssh.keyPath);
  return <Dialog title="工作区连接" onClose={onClose} returnFocus={opener} busy={!!busy} error={error}>
    <div className="workspace-connection-modes" role="group" aria-label="连接方式">
      <button type="button" aria-pressed={mode==='ssh'} disabled={!!busy} onClick={()=>{discardProbe();setMode('ssh');}}>SSH</button>
      <button type="button" aria-pressed={mode==='direct'} disabled={!!busy} onClick={()=>{discardProbe();setMode('direct');}}>地址与令牌</button>
    </div>
    <form onSubmit={event=>{event.preventDefault();if(mode==='ssh')void runSsh();else void run({action:'connect',address,token,ca,remember});}}>
      {mode==='ssh'?<>
        <div className="workspace-ssh-address">
          <label>服务器 IP 或主机名<input ref={addressInput} autoFocus required value={ssh.host} disabled={!!busy||!profile} maxLength={253} placeholder="192.0.2.10" onChange={event=>updateSsh({host:event.target.value})}/></label>
          <label>SSH 端口<input type="number" required min={1} max={65535} value={port} disabled={!!busy} onChange={event=>{discardProbe();setPort(event.target.value);}}/></label>
        </div>
        <label>SSH 用户名<input required value={ssh.username} disabled={!!busy} maxLength={128} autoComplete="username" onChange={event=>updateSsh({username:event.target.value})}/></label>
        <label>身份验证<select value={ssh.authentication} disabled={!!busy} onChange={event=>{
          setPassword('');setPassphrase('');
          updateSsh({authentication:event.target.value==='key'?'key':'password',keyPath:undefined});
        }}><option value="password">密码</option><option value="key">SSH 私钥</option></select></label>
        {ssh.authentication==='password'?
          <label>SSH 密码<input type="password" required={!savedSsh} value={password} disabled={!!busy} maxLength={4096} autoComplete="current-password"
            placeholder={savedSsh?'使用已保存的密码':undefined} onChange={event=>{discardProbe();setPassword(event.target.value);}}/></label>:
          <>
            <div className="workspace-key-file">
              <label>本机私钥文件<input readOnly value={ssh.keyPath??''} disabled={!!busy}/></label>
              <button type="button" className="subtle" disabled={!!busy} onClick={async()=>{
                try{const file=await window.berth.chooseWorkspaceSshKey();if(file)updateSsh({keyPath:file});}catch(error){setError(formatError(error));}
              }}>选择私钥</button>
            </div>
            <label>私钥口令（可选）<input type="password" value={passphrase} disabled={!!busy} maxLength={4096} autoComplete="off" onChange={event=>{discardProbe();setPassphrase(event.target.value);}}/></label>
          </>}
        <label className="checkbox"><input type="checkbox" checked={rememberSsh} disabled={!!busy} onChange={event=>setRememberSsh(event.target.checked)}/>记住 SSH 登录并在下次打开时连接</label>
        {probe&&<output className="workspace-ssh-probe" aria-live="polite"><strong>{probeLabels[probe.status].status}</strong><span>{probe.hostname} · {probe.arch==='x64'?'Linux x64':'Linux ARM64'}</span></output>}
      </>:<>
        <label>服务器地址<input ref={addressInput} autoFocus type="text" required value={address} disabled={!!busy||!profile} maxLength={2048} placeholder="wss://server.example.com:7467" onChange={event=>{setAddress(event.target.value);setCa(undefined);}}/></label>
        <label>服务器令牌<input type="password" autoComplete="off" value={token} disabled={!!busy} maxLength={128} placeholder={savedToken?'使用已保存的令牌':undefined} onChange={event=>setToken(event.target.value)}/></label>
        <label className="checkbox"><input type="checkbox" checked={remember} disabled={!!busy} onChange={event=>setRemember(event.target.checked)}/>记住令牌并在下次打开时连接</label>
        <div className="workspace-certificate">
          <button type="button" className="subtle" disabled={!!busy||!profile} onClick={async()=>{
            try{const data=await window.berth.workspaceTarget({action:'certificate'});if(typeof data==='string')setCa(data);}catch(error){setError(formatError(error));}
          }}>{hasCertificate?'更换 CA 证书':'选择 CA 证书'}</button>
          {hasCertificate&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>setCa('')}>移除 CA 证书</button>}
        </div>
      </>}
      <footer className="workspace-target-actions">
        {current&&<button type="button" className="subtle" disabled={!!busy} onClick={()=>void run({action:'local'})}>返回本机</button>}
        {profile?.recentAddress&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>void run({action:'local',forget:true})}>清除服务器配置</button>}
        <button type="button" className="subtle" data-dismiss="dialog" disabled={!!busy}>取消</button>
        <button className="primary" disabled={!!busy||!profile||(mode==='ssh'?!sshValid:!address.trim())} aria-live="polite">
          {busy||(mode==='ssh'?(probe?probeLabels[probe.status].action:'探测服务器'):'连接服务器')}
        </button>
      </footer>
    </form>
  </Dialog>;
}
