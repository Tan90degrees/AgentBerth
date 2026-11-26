import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { z } from 'zod';
import { PROTOCOL_VERSION, type ServerEvent } from '../shared/protocol';
import { serverTokenPattern, type WorkspaceProvisionProgress, type WorkspaceSshEndpoint, type WorkspaceSshProbe } from '../shared/workspace-server';
import { DaemonConnection } from './connection';

export type VerifyWorkspaceHost = (endpoint:WorkspaceSshEndpoint,fingerprint:string,interactive:boolean)=>Promise<boolean>;
type Architecture=WorkspaceSshProbe['arch'];
type Inspection={arch:Architecture;home:string;hostname:string;installed:boolean;live:boolean;runtime?:{token:string;port:number}};
const runtimeSchema=z.object({version:z.literal(PROTOCOL_VERSION),pid:z.number().int().min(2),port:z.number().int().min(1).max(65535),token:z.string().regex(serverTokenPattern)});
const prefix='AgentBerth:';

const inspectScript=String.raw`
set -eu
case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) arch=x64 ;;
  Linux:aarch64|Linux:arm64) arch=arm64 ;;
  *) exit 20 ;;
esac
case "$HOME" in /*) ;; *) exit 21 ;; esac
data="$HOME/.local/share/agentberth-server"
entry="$HOME/.local/opt/agentberth-server/bin/agentberth-server"
printf 'AgentBerth:arch=%s\nAgentBerth:home=%s\nAgentBerth:hostname=%s\n' "$arch" "$HOME" "$(uname -n)"
if test -x "$entry"; then printf 'AgentBerth:installed=yes\n'; fi
if test -f "$data/daemon.lock"; then
  pid=$(cat "$data/daemon.lock")
  case "$pid" in ''|*[!0-9]*) exit 22 ;; esac
  if test "$pid" -gt 1 && test -d "/proc/$pid"; then
    printf 'AgentBerth:live=%s\n' "$pid"
    if test -f "$data/runtime.json"; then
      printf 'AgentBerth:runtime='
      head -c 4096 "$data/runtime.json"
      printf '\n'
    fi
  fi
fi
`;

const startupScript=String.raw`
set -eu
umask 077
data="$HOME/.local/share/agentberth-server"
entry="$HOME/.local/opt/agentberth-server/bin/agentberth-server"
test -x "$entry" || exit 23
mkdir -p "$data"
if test -f "$data/daemon.lock"; then
  pid=$(cat "$data/daemon.lock")
  case "$pid" in ''|*[!0-9]*) exit 22 ;; esac
  if test "$pid" -gt 1 && test -d "/proc/$pid"; then exit 0; fi
fi
mode=
if "$entry" --help | grep -q -- --ssh-only; then mode=--ssh-only; fi
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  if systemctl --user start agentberth-server.service >/dev/null 2>&1; then exit 0; fi
  if test "$mode" = --ssh-only; then
    units="$HOME/.config/systemd/user"
    mkdir -p "$units"
    if test ! -e "$units/agentberth-workspace.service"; then
      cat > "$units/agentberth-workspace.service" <<'UNIT'
[Unit]
Description=AgentBerth SSH workspace

[Service]
ExecStart=%h/.local/opt/agentberth-server/bin/agentberth-server --data-dir %h/.local/share/agentberth-server --ssh-only
Restart=on-failure
TimeoutStopSec=90

[Install]
WantedBy=default.target
UNIT
    fi
    if systemctl --user daemon-reload && systemctl --user enable --now agentberth-workspace.service; then exit 0; fi
  fi
fi
nohup "$entry" --data-dir "$data" $mode </dev/null >>"$data/service.log" 2>&1 &
`;

class SshExecutionError extends Error {
  constructor(readonly exitCode:number|undefined){super('服务器命令失败（'+String(exitCode??'无退出码')+'）');}
}
async function readKey(file:string){
  const handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK);
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>128*1024)throw new Error('请选择有效的 SSH 私钥文件');
    return await handle.readFile();
  }finally{await handle.close();}
}

async function openSsh(endpoint:WorkspaceSshEndpoint,verify:VerifyWorkspaceHost,interactive:boolean){
  const {ssh,password,passphrase}=endpoint;
  const privateKey=ssh.authentication==='key'?await readKey(ssh.keyPath!):undefined;
  const client=new Client();
  return new Promise<Client>((resolve,reject)=>{
    let settled=false;
    let verificationError:unknown;
    const fail=(error:unknown)=>{
      if(settled)return;
      settled=true;client.destroy();reject(error);
    };
    client.on('error',error=>{
      const detail=(error as Error&{level?:string;code?:string});
      fail(verificationError??new Error(detail.level==='client-authentication'?'SSH 登录失败，请核对账号、密码或密钥':
        detail.code==='ECONNREFUSED'?'服务器拒绝 SSH 连接，请检查端口':detail.message));
    });
    client.on('close',()=>fail(verificationError??new Error('SSH 连接已断开')));
    client.once('ready',()=>{if(!settled){settled=true;resolve(client);}});
    client.on('keyboard-interactive',(_name,_instructions,_language,prompts,finish)=>{
      finish(password&&prompts.length===1&&!prompts[0].echo&&/password|密码/i.test(prompts[0].prompt)?[password]:[]);
    });
    const hostVerifier:ConnectConfig['hostVerifier']=(key:Buffer,answer:(accepted:boolean)=>void)=>{
      const fingerprint='SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');
      void verify(endpoint,fingerprint,interactive).then(accepted=>{
        if(!accepted)verificationError=new Error('SSH 主机指纹未通过确认');
        answer(!settled&&accepted);
      },error=>{verificationError=error;answer(false);});
    };
    try{client.connect({host:ssh.host,port:ssh.port,username:ssh.username,password,privateKey,passphrase,
      readyTimeout:90_000,keepaliveInterval:10_000,keepaliveCountMax:3,tryKeyboard:ssh.authentication==='password',hostVerifier});}
    catch(error){fail(error);}
  });
}

function run(client:Client,script:string,timeout=10_000):Promise<string>{
  return new Promise((resolve,reject)=>{
    let channel:ClientChannel|undefined;
    let complete=false,output='';
    const finish=(error?:Error)=>{
      if(complete)return;
      complete=true;clearTimeout(timer);
      if(error){channel?.destroy();reject(error);}else resolve(output);
    };
    const timer=setTimeout(()=>finish(new Error('等待服务器响应超时')),timeout);
    client.exec('sh -s',(error,stream)=>{
      if(complete){stream?.destroy();return;}
      if(error){finish(new Error('无法运行服务器部署命令，请检查 SSH Shell 权限'));return;}
      channel=stream;
      stream.on('data',(chunk:Buffer)=>{
        output+=chunk.toString();
        if(output.length>16*1024)finish(new Error('服务器返回了过长的探测结果'));
      });
      stream.stderr.resume();
      stream.on('error',()=>finish(new Error('服务器命令通道已断开')));
      stream.on('close',(code?:number)=>finish(code===0?undefined:new SshExecutionError(code)));
      stream.end(script+'\n');
    });
  });
}

export async function inspectWorkspace(client:Client):Promise<Inspection>{
  let output:string;
  try{output=await run(client,inspectScript);}
  catch(error){
    if(error instanceof SshExecutionError&&error.exitCode===20)throw new Error('服务器需要 Linux x64 或 ARM64');
    if(error instanceof SshExecutionError&&error.exitCode===22)throw new Error('服务器后台正在启动或锁文件异常，请稍后探测');
    throw error;
  }
  const fields=new Map(output.split('\n').filter(line=>line.startsWith(prefix)).map(line=>{
    const field=line.slice(prefix.length),equals=field.indexOf('=');
    return [field.slice(0,equals),field.slice(equals+1)];
  }));
  const home=fields.get('home'),arch=fields.get('arch'),hostname=fields.get('hostname')??'Linux';
  if(!home?.startsWith('/')||/[\x00-\x1f\x7f]/.test(home)||home.length>4096||(arch!=='x64'&&arch!=='arm64'))
    throw new Error('服务器返回的用户目录或架构无效');
  const raw=fields.get('runtime');
  const pid=fields.get('live');
  let runtime:Inspection['runtime'];
  if(raw){
    try{
      const descriptor=runtimeSchema.parse(JSON.parse(raw));
      if(String(descriptor.pid)===pid)runtime=descriptor;
    }catch{throw new Error('服务器后台配置不兼容，请检查当前服务版本');}
  }
  return {arch,home,hostname:hostname.slice(0,253),installed:fields.get('installed')==='yes',live:!!pid,runtime};
}

function forward(client:Client,port:number):Promise<ClientChannel>{
  return new Promise((resolve,reject)=>{
    let expired=false;
    const timer=setTimeout(()=>{expired=true;reject(new Error('SSH 隧道连接超时'));},8000);
    client.forwardOut('127.0.0.1',0,'127.0.0.1',port,(error,channel)=>{
      clearTimeout(timer);
      if(expired){channel?.destroy();return;}
      if(error)reject(new Error('无法建立 SSH 隧道，请检查服务器的 TCP 转发权限'));
      else resolve(channel);
    });
  });
}
async function connectRuntime(client:Client,inspection:Inspection,emit:(event:ServerEvent)=>void){
  if(!inspection.runtime)throw new Error('服务器后台尚未就绪');
  const {port,token}=inspection.runtime,channel=await forward(client,port);
  channel.on('error',()=>{channel.destroy();});
  try{return await DaemonConnection.openWorkspace({address:'ws://127.0.0.1:'+port,token},emit,channel);}
  catch(error){channel.destroy();throw error;}
}
function sftp(client:Client):Promise<SFTPWrapper>{
  return new Promise((resolve,reject)=>{
    let expired=false;
    const timeout=setTimeout(()=>{expired=true;reject(new Error('建立 SFTP 上传通道超时'));},12_000);
    client.sftp((error,handle)=>{
      clearTimeout(timeout);
      if(expired){handle?.end();return;}
      if(error)reject(new Error('服务器未开放 SFTP 上传'));
      else resolve(handle);
    });
  });
}
async function getPayload(directory:string,version:string,arch:Architecture){
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('当前桌面版本没有匹配的部署包');
  const name='AgentBerth-Server-'+version+'-linux-'+arch+'.tar.gz',file=path.join(directory,name);
  let contents:string;
  try{
    const info=await stat(file);
    if(!info.isFile()||info.size<1||info.size>256*1024*1024)throw new Error();
    const checksum=await stat(file+'.sha256');
    if(!checksum.isFile()||checksum.size>1024)throw new Error();
    contents=await readFile(file+'.sha256','utf8');
  }catch{throw new Error('此桌面包缺少 Linux '+arch+' 部署文件，请安装完整测试包');}
  const hash=contents.trim().split(/\s+/);
  const digest=createHash('sha256');
  for await(const chunk of createReadStream(file))digest.update(chunk);
  if(hash.length!==2||hash[1]!==name||hash[0]!==digest.digest('hex'))throw new Error('桌面内置服务器包校验失败');
  return {file,hash:hash[0]};
}

async function deploy(client:Client,inspection:Inspection,id:string,storage:string,version:string,progress:(value:WorkspaceProvisionProgress)=>void){
  const {file,hash}=await getPayload(storage,version,inspection.arch);
  const name='.agentberth-stage-'+id,pathOnServer=inspection.home+'/.local/opt/'+name+'/bundle.tar.gz';
  const stage='stage="$HOME/.local/opt/'+name+'"\n';
  await run(client,'set -eu\numask 077\n'+stage+'mkdir -p "$HOME/.local/opt"\nmkdir "$stage"');
  try{
    progress('upload');
    const channel=await sftp(client);
    try{
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('上传服务器包超时，请检查 SSH 网络后重试')),240_000);
        channel.fastPut(file,pathOnServer,{concurrency:32,mode:0o600},error=>{
          clearTimeout(timer);
          if(error)reject(new Error('上传服务器包失败，请检查 SFTP 权限和服务器磁盘空间',{cause:error}));
          else resolve();
        });
      });
    }finally{channel.end();}
    progress('install');
    await run(client,'set -eu\numask 077\n'+stage+
      'cd "$stage"\nprintf "%s  %s\\n" '+hash+' bundle.tar.gz | sha256sum -c -\n'+
      'tar -xzf bundle.tar.gz\ntest -x agentberth-server/bin/agentberth-server\n'+
      'mv -T -n -- agentberth-server "$HOME/.local/opt/agentberth-server"\n'+
      'test -x "$HOME/.local/opt/agentberth-server/bin/agentberth-server"',60_000);
  }finally{await run(client,stage+'rm -rf -- "$stage"').catch(()=>{});}
}

export class WorkspaceProvision {
  private probe?:{id:string;client:Client;inspection:Inspection;endpoint:WorkspaceSshEndpoint;timer:NodeJS.Timeout};
  private busy=false;
  constructor(private verify:VerifyWorkspaceHost,private assets:string,private version:string){}

  async inspect(endpoint:WorkspaceSshEndpoint):Promise<WorkspaceSshProbe>{
    if(this.busy)throw new Error('正在探测或部署服务器');
    this.discard();
    this.busy=true;
    let client:Client|undefined;
    try{
      client=await openSsh(endpoint,this.verify,true);
      const inspection=await this.readStartup(client);
      if(inspection.live){
        const check=await connectRuntime(client,inspection,()=>{});
        check.close(true);
      }
      const id=randomUUID(),timer=setTimeout(()=>this.discard(id),5*60_000);
      timer.unref();
      this.probe={id,client,inspection,endpoint,timer};
      client=undefined;
      return {id,arch:inspection.arch,hostname:inspection.hostname,status:inspection.live?'running':inspection.installed?'installed':'missing'};
    }finally{client?.end();this.busy=false;}
  }
  discard(id?:string){
    const probe=this.probe;
    if(!probe||(id&&id!==probe.id))return;
    this.probe=undefined;clearTimeout(probe.timer);probe.client.end();
  }

  async activate(id:string,emit:(event:ServerEvent)=>void,progress:(value:WorkspaceProvisionProgress)=>void){
    const probe=this.probe;
    if(this.busy||!probe||probe.id!==id)throw new Error('请重新探测服务器');
    this.busy=true;this.probe=undefined;clearTimeout(probe.timer);
    const {client,endpoint}=probe;
    try{
      let inspection=await this.readStartup(client);
      if(!inspection.live){
        if(!inspection.installed)await deploy(client,inspection,id,this.assets,this.version,progress);
        progress('start');
        await run(client,startupScript,40000);
        const deadline=Date.now()+25000;
        do{
          inspection=await inspectWorkspace(client);
          if(inspection.runtime)break;
          await new Promise(resolve=>setTimeout(resolve,250));
        }while(Date.now()<deadline);
        if(!inspection.runtime)throw new Error('服务器启动未完成，请查看 ~/.local/share/agentberth-server/service.log 后重试');
      }
      progress('connect');
      const connection=await connectRuntime(client,inspection,emit);
      connection.onClose(()=>client.end());
      return {endpoint,connection};
    }catch(error){client.end();throw error;}
    finally{this.busy=false;}
  }

  async reconnect(endpoint:WorkspaceSshEndpoint,emit:(event:ServerEvent)=>void){
    const client=await openSsh(endpoint,this.verify,false);
    try{
      const inspection=await this.readStartup(client);
      if(!inspection.live)throw new Error('服务器服务已停止，请重新探测并启动');
      const connection=await connectRuntime(client,inspection,emit);
      connection.onClose(()=>client.end());
      return connection;
    }catch(error){client.end();throw error;}
  }
  private async readStartup(client:Client){
    let inspection=await inspectWorkspace(client);
    for(let attempt=0;inspection.live&&!inspection.runtime&&attempt<10;attempt++){
      await new Promise(resolve=>setTimeout(resolve,250));
      inspection=await inspectWorkspace(client);
    }
    return inspection;
  }
}
