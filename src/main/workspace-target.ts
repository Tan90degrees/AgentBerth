import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { serverTokenPattern, workspaceServerAddress, type WorkspaceConnection, type WorkspaceEndpoint, type WorkspaceSshEndpoint, type WorkspaceSshSettings, type WorkspaceTarget } from '../shared/workspace-server';
import {sshWorkspaceAddress, sshWorkspaceEndpoint, sshWorkspaceSecrets, workspaceSshSettings} from './workspace-ssh-config';

interface Vault {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
type Saved = { address: string; active: boolean; ca?: string; secret?: string; ssh?:WorkspaceSshSettings };

export function workspaceKey(address?: string): string {
  return address ? createHash('sha256').update(address).digest('hex').slice(0, 32) : '';
}

export function workspaceCertificate(value?: string): string | undefined {
  if (!value) return;
  if (Buffer.byteLength(value)>64*1024) throw new Error('CA 证书文件过大');
  const certificates=value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)??[];
  if(!certificates.length||value.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,'').trim())
    throw new Error('请选择 PEM 格式的 CA 证书');
  for(const pem of certificates) new X509Certificate(pem);
  return certificates.join('\n');
}

export class WorkspaceTargets {
  private current?: WorkspaceConnection;
  private saved?: Saved;
  constructor(private file: string, private vault: Vault) {}

  load() {
    try {
      const value=JSON.parse(readFileSync(this.file,'utf8'));
      const ssh=value.ssh===undefined?undefined:workspaceSshSettings.parse(value.ssh);
      const address=ssh?sshWorkspaceAddress(ssh):workspaceServerAddress(value.address);
      const saved:Saved={address,active:value.active===true,ca:ssh?undefined:workspaceCertificate(value.ca),
        secret:typeof value.secret==='string'&&value.secret.length<=32768?value.secret:undefined,ssh};

      this.saved=saved;
      if(saved.active&&saved.secret)this.current=ssh?this.sshEndpoint(ssh):this.endpoint(address,undefined,undefined);
    } catch { this.current=undefined; }
  }

  get active() { return this.current; }

  state(): WorkspaceTarget {
    const direct=this.current&&'token' in this.current?this.current:undefined;
    const ssh=this.current&&'ssh' in this.current?this.current.ssh:this.saved?.ssh;
    return {address:this.current?.address,recentAddress:this.saved?.address,
      savedToken:!!this.saved?.secret&&!this.saved.ssh,hasCertificate:!!(direct?.ca??this.saved?.ca),ssh,savedSsh:!!this.saved?.ssh&&!!this.saved.secret};

  }

  endpoint(input:string,token?:string,certificate?:string): WorkspaceEndpoint {
    const address=workspaceServerAddress(input);
    const saved=this.saved?.address===address?this.saved:undefined;
    const active=this.current?.address===address&&'token' in this.current?this.current:undefined;
    let credential=token?.trim()||active?.token;
    if(!credential&&saved?.secret&&this.safe()){
      try { credential=this.vault.decryptString(Buffer.from(saved.secret,'base64')); }
      catch { throw new Error('无法读取已保存的令牌，请重新输入'); }
    }
    if(!credential||!serverTokenPattern.test(credential))throw new Error('请输入 64 位服务器令牌');
    const ca=certificate===undefined?(active?.ca??saved?.ca):workspaceCertificate(certificate);
    if(ca&&address.startsWith('ws:'))throw new Error('CA 证书用于 wss:// 连接');
    return {address,token:credential,ca};
  }

  sshEndpoint(settings:WorkspaceSshSettings,password?:string,passphrase?:string):WorkspaceSshEndpoint{
    const address=sshWorkspaceAddress(settings);
    const active=this.current?.address===address&&'ssh' in this.current?this.current:undefined;
    const saved=this.saved?.address===address&&this.saved.ssh?.authentication===settings.authentication&&this.saved.ssh?.keyPath===settings.keyPath?this.saved:undefined;
    const reuse=active?.ssh.authentication===settings.authentication&&active.ssh.keyPath===settings.keyPath?active:undefined;
    let secret:ReturnType<typeof sshWorkspaceSecrets.parse>={};
    if(saved?.secret&&this.safe()&&!password&&!passphrase){
      try{secret=sshWorkspaceSecrets.parse(JSON.parse(this.vault.decryptString(Buffer.from(saved.secret,'base64'))));}
      catch{throw new Error('无法读取已保存的 SSH 凭据，请重新输入');}
    }
    return sshWorkspaceEndpoint(settings,password||reuse?.password||secret.password,passphrase||reuse?.passphrase||secret.passphrase);
  }

  select(endpoint: WorkspaceConnection | undefined, remember = false, forget = false) {
    if(endpoint){
      this.checkRemember(remember);
      const value='ssh' in endpoint?JSON.stringify({password:endpoint.password,passphrase:endpoint.passphrase}):endpoint.token;
      const secret=remember?this.vault.encryptString(value).toString('base64'):undefined;
      this.save({address:endpoint.address,secret,active:remember,...('ssh' in endpoint?{ssh:endpoint.ssh}:{ca:endpoint.ca})});
    }else if(forget){
      rmSync(this.file,{force:true});
      this.saved=undefined;
    }else if(this.saved)this.save({...this.saved,active:false});
    this.current=endpoint;
  }

  checkRemember(remember:boolean){if(remember&&!this.safe())throw new Error('当前系统没有安全凭据存储，请取消记住凭据');}
  private safe(){return this.vault.isEncryptionAvailable()&&this.vault.getSelectedStorageBackend?.()!=='basic_text';}
  private save(value:Saved){
    const file=this.file+'.tmp';
    writeFileSync(file,JSON.stringify(value),{mode:0o600});
    renameSync(file,this.file);
    this.saved=value;
  }
}
