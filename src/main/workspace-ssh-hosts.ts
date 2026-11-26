import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { WorkspaceSshEndpoint } from '../shared/workspace-server';

export class WorkspaceSshHosts {
  constructor(private file:string,private confirm:(target:WorkspaceSshEndpoint,fingerprint:string)=>Promise<boolean>){}

  async verify(target:WorkspaceSshEndpoint,fingerprint:string,interactive:boolean){
    const key=JSON.stringify([target.ssh.host,target.ssh.port]);
    const known=this.read();
    if(known[key]===fingerprint)return true;
    if(known[key])throw new Error('SSH 主机指纹已变化，请核对服务器与本机信任记录');
    if(!interactive||!await this.confirm(target,fingerprint))return false;
    const latest=this.read();
    if(latest[key]&&latest[key]!==fingerprint)throw new Error('SSH 主机信任记录已变化，请重试');
    latest[key]=fingerprint;
    const temporary=this.file+'.tmp';
    writeFileSync(temporary,JSON.stringify(latest),{mode:0o600});
    renameSync(temporary,this.file);
    return true;
  }

  private read():Record<string,string>{
    try{
      const data=JSON.parse(readFileSync(this.file,'utf8'));
      if(!data||typeof data!=='object'||Array.isArray(data)||Object.values(data).some(value=>typeof value!=='string'||!/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)))
        throw new Error('SSH 主机信任记录格式无效');
      return data;
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return {};
      throw error;
    }
  }
}
