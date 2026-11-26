import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { serverTokenPattern, workspaceServerAddress, type WorkspaceEndpoint, type WorkspaceTarget } from '../shared/workspace-server';

interface Vault {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
type Saved = { address: string; active: boolean; ca?: string; secret?: string };

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
  private current?: WorkspaceEndpoint;
  private saved?: Saved;
  constructor(private file: string, private vault: Vault) {}

  load() {
    try {
      const value=JSON.parse(readFileSync(this.file,'utf8'));
      const address=workspaceServerAddress(value.address);
      const saved:Saved={address,active:value.active===true,ca:workspaceCertificate(value.ca),secret:typeof value.secret==='string'&&value.secret.length<=4096?value.secret:undefined};
      this.saved=saved;
      if(saved.active&&saved.secret)this.current=this.endpoint(address,undefined,undefined);
    } catch { this.current=undefined; }
  }

  get active() { return this.current; }

  state(): WorkspaceTarget {
    return {address:this.current?.address,recentAddress:this.saved?.address,savedToken:!!this.saved?.secret,hasCertificate:!!(this.current?.ca??this.saved?.ca)};
  }

  endpoint(input:string,token?:string,certificate?:string): WorkspaceEndpoint {
    const address=workspaceServerAddress(input);
    const saved=this.saved?.address===address?this.saved:undefined;
    const active=this.current?.address===address?this.current:undefined;
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

  select(endpoint: WorkspaceEndpoint | undefined, remember = false, forget = false) {
    if(endpoint){
      if(remember&&!this.safe())throw new Error('当前系统没有安全凭据存储，请取消记住令牌');
      const secret=remember?this.vault.encryptString(endpoint.token).toString('base64'):undefined;
      this.save({address:endpoint.address,ca:endpoint.ca,secret,active:remember});
    }else if(forget){
      rmSync(this.file,{force:true});
      this.saved=undefined;
    }else if(this.saved)this.save({...this.saved,active:false});
    this.current=endpoint;
  }

  private safe(){return this.vault.isEncryptionAvailable()&&this.vault.getSelectedStorageBackend?.()!=='basic_text';}
  private save(value:Saved){
    const file=this.file+'.tmp';
    writeFileSync(file,JSON.stringify(value),{mode:0o600});
    renameSync(file,this.file);
    this.saved=value;
  }
}
