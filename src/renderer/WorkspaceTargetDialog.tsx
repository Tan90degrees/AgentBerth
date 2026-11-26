import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import type { WorkspaceTarget } from '../shared/workspace-server';

export function WorkspaceTargetDialog({ current, onClose, opener }: {current?:string;onClose:()=>void;opener:HTMLElement|null}){
  const [profile,setProfile]=useState<WorkspaceTarget|null>(null);
  const [address,setAddress]=useState(current??'');
  const [token,setToken]=useState('');
  const [ca,setCa]=useState<string>();
  const [remember,setRemember]=useState(false);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let active=true;
    void window.berth.workspaceTarget({action:'state'}).then(value=>{
      if(!active||!value||typeof value==='string')return;
      setProfile(value);setAddress(value.address??value.recentAddress??'');setRemember(value.savedToken);
    }).catch(error=>{if(active)setError(String(error));});
    return()=>{active=false;};
  },[]);
  const run=async(request:Parameters<typeof window.berth.workspaceTarget>[0])=>{
    setBusy(true);setError('');
    try{await window.berth.workspaceTarget(request);}
    catch(error){setError(String(error).replace(/^Error invoking remote method '[^']+': Error: /,''));setBusy(false);}
  };
  const savedToken=profile?.savedToken&&address===profile.recentAddress;
  const hasCertificate=ca===undefined?profile?.hasCertificate&&address===profile.recentAddress:!!ca;
  return <Dialog title="工作区连接" onClose={onClose} returnFocus={opener} busy={busy} error={error}>
    <form onSubmit={event=>{event.preventDefault();void run({action:'connect',address,token,ca,remember});}}>
      <label>服务器地址<input autoFocus type="text" required value={address} disabled={busy||!profile} maxLength={2048} placeholder="wss://server.example.com:7467" onChange={event=>{setAddress(event.target.value);setCa(undefined);}}/></label>
      <label>服务器令牌<input type="password" autoComplete="off" value={token} disabled={busy} maxLength={128} placeholder={savedToken?'使用已保存的令牌':undefined} onChange={event=>setToken(event.target.value)}/></label>
      <label className="checkbox"><input type="checkbox" checked={remember} disabled={busy} onChange={event=>setRemember(event.target.checked)}/>记住令牌并在下次打开时连接</label>
      <div className="workspace-certificate">
        <button type="button" className="subtle" disabled={busy||!profile} onClick={async()=>{
          try{const data=await window.berth.workspaceTarget({action:'certificate'});if(typeof data==='string')setCa(data);}catch(error){setError(String(error));}
        }}>{hasCertificate?'更换 CA 证书':'选择 CA 证书'}</button>
        {hasCertificate&&<button type="button" className="text-button" disabled={busy} onClick={()=>setCa('')}>移除 CA 证书</button>}
      </div>
      <footer className="workspace-target-actions">
        {current&&<button type="button" className="subtle" disabled={busy} onClick={()=>void run({action:'local'})}>返回本机</button>}
        {profile?.recentAddress&&<button type="button" className="text-button" disabled={busy} onClick={()=>void run({action:'local',forget:true})}>清除服务器配置</button>}
        <button type="button" className="subtle" data-dismiss="dialog" disabled={busy}>取消</button>
        <button className="primary" disabled={busy||!profile||!address.trim()}>{busy?'正在连接…':'连接服务器'}</button>
      </footer>
    </form>
  </Dialog>;
}
