import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { resolveExecutable } from './executables';
import { terminalEnvironment } from './paths';
import { terminateWindowsTree } from './processes';
import type { AcpConfig } from '../shared/acp';

/** Treat a path as one file, including spaces; never split it as a shell command. */
export function acpExecutable(value:string){
  const trimmed=value.trim();
  return trimmed.length>1&&((trimmed.startsWith('"')&&trimmed.endsWith('"'))||(trimmed.startsWith("'")&&trimmed.endsWith("'")))?trimmed.slice(1,-1):trimmed;
}

/** Resolve native executables and Windows batch/PowerShell scripts. */
export async function acpCommand(executable:string,arguments_:string[]){
    const name=acpExecutable(executable),options={allowBatch:true,allowPowerShell:true};
    let file:string;try{file=await resolveExecutable(name,options);}catch(error){
      if(process.platform!=='win32'||path.extname(name))throw error;
      let found:string|undefined;
      for(const extension of ['.cmd','.bat','.ps1']){try{found=await resolveExecutable(name+extension,options);break;}catch{/* Try installed script launchers without splitting the path. */}}
      if(!found)throw error;file=found;
    }
    let args=arguments_;
    if(process.platform==='win32'&&/\.ps1$/i.test(file)){
      // Run the script as a file with literal arguments, without building an
      // extra PowerShell expression around its bidirectional protocol.
      return {file:path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args]};
    }
    if(process.platform==='win32'&&/\.(?:cmd|bat)$/i.test(file)){
      const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
      const script=`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; & ${[file,...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
      file=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
    }
    return {file,args};
}

export class AcpRpcError extends Error {constructor(readonly code:number,message:string,readonly data?:unknown){super(message);}}
type Handler=(method:string,params:Record<string,any>)=>Promise<unknown>;
export class AcpTransport {
  private sequence=0;private buffer='';private closed=false;private ended=false;
  private stopping:Promise<void>|undefined;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer?:NodeJS.Timeout}>();
  private incoming=0;readonly child:ChildProcessWithoutNullStreams;readonly exited:Promise<void>;stderr='';
  static async open(config:AcpConfig,cwd:string,request:Handler,notify:(method:string,params:Record<string,any>)=>void,onExit:(error:Error)=>void){
    const {file,args}=await acpCommand(config.executable,config.args);
    const child=spawn(file,args,{cwd,env:{...terminalEnvironment(file),...config.env},shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    const transport=new AcpTransport(child,request,notify,onExit);
    try{await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}
    catch(error){throw new Error(`无法启动 ACP 程序“${config.executable}”：${String(error)}。请检查完整路径、脚本解释器和项目工作目录；启动参数须单独填写，不会按空格拆分程序路径。`,{cause:error});}return transport;
  }
  private constructor(child:ChildProcessWithoutNullStreams,private request:Handler,private notification:(method:string,params:Record<string,any>)=>void,private onExit:(error:Error)=>void){
    this.child=child;this.exited=new Promise(resolve=>child.once('close',()=>resolve()));
    child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
      try{this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>8*1024*1024)throw new Error('ACP 消息超过 8 MiB');let end:number;while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end).trim();this.buffer=this.buffer.slice(end+1);if(line)this.receive(JSON.parse(line));}}
      catch(error){this.fail(new Error('ACP 标准输出必须是逐行 JSON-RPC；日志请写入 stderr：'+String(error)));void this.stop();}
    });
    child.stderr.setEncoding('utf8');child.stderr.on('data',(chunk:string)=>{this.stderr=(this.stderr+chunk).slice(-16384);});child.stdin.on('error',()=>{});
    child.once('error',error=>this.fail(error));child.once('exit',(code,signal)=>this.fail(new Error(`ACP 进程已退出（${code??signal??'unknown'}）${this.stderr?'：'+this.stderr.slice(-1500):''}`)));
  }
  get pid(){return this.child.pid??null;}
  private send(message:unknown){if(this.closed||this.ended||!this.child.stdin.writable)throw new Error('ACP 连接已断开，未发送操作');const line=JSON.stringify(message);if(Buffer.byteLength(line)>8*1024*1024)throw new Error('ACP 请求过大');this.child.stdin.write(line+'\n');}
  notify(method:string,params:Record<string,unknown>){this.send({jsonrpc:'2.0',method,params});}
  call<T=any>(method:string,params:Record<string,unknown>,timeout=30000):Promise<T>{
    const id=String(++this.sequence);
    return new Promise((resolve,reject)=>{
      const entry:{resolve:(v:any)=>void;reject:(e:Error)=>void;timer?:NodeJS.Timeout}={resolve,reject};
      if(timeout)entry.timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`ACP ${method} 响应超时；执行结果未知，不会自动重放`));},timeout);
      this.pending.set(id,entry);try{this.send({jsonrpc:'2.0',id,method,params});}catch(error){this.pending.delete(id);clearTimeout(entry.timer);reject(error);}
    });
  }
  private receive(message:any){
    if(!message||message.jsonrpc!=='2.0'||typeof message!=='object')throw new Error('无效的 JSON-RPC 消息');
    if(typeof message.method==='string'){
      const params=message.params??{};if(!params||typeof params!=='object'||Array.isArray(params))throw new Error('ACP 参数须为对象');
      if(message.id===undefined){this.notification(message.method,params);return;}
      if(typeof message.id!=='string'&&typeof message.id!=='number')throw new Error('ACP 请求 ID 无效');
      if(this.incoming>=64){this.send({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'客户端请求过多'}});return;}
      this.incoming++;
      void Promise.resolve().then(()=>this.request(message.method,params)).then(result=>{if(!this.closed&&!this.ended)this.send({jsonrpc:'2.0',id:message.id,result:result??{}});},error=>{if(!this.closed&&!this.ended)this.send({jsonrpc:'2.0',id:message.id,error:{code:error instanceof AcpRpcError?error.code:-32603,message:String(error instanceof Error?error.message:error)}});}).catch(()=>{}).finally(()=>this.incoming--);return;
    }
    const item=this.pending.get(String(message.id));if(!item)return;this.pending.delete(String(message.id));clearTimeout(item.timer);
    if(message.error)item.reject(new AcpRpcError(Number(message.error.code),String(message.error.message??'ACP 请求失败'),message.error.data));else item.resolve(message.result);
  }
  private fail(error:Error){if(this.ended)return;this.ended=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();if(!this.closed)this.onExit(error);}
  async stop(){
    if(this.stopping)return this.stopping;
    this.closed=true;this.fail(new Error('ACP 连接已停止'));
    const stopping=(async()=>{
    try{if(this.pid&&this.child.exitCode===null&&this.child.signalCode===null){if(process.platform==='win32')await terminateWindowsTree(this.pid,()=>this.child.exitCode===null&&this.child.signalCode===null);else{try{process.kill(-this.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}}}
    finally{this.child.stdin.destroy();this.child.stdout.destroy();this.child.stderr.destroy();}
    let timer:NodeJS.Timeout|undefined;try{await Promise.race([this.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('ACP 进程尚未退出')),3000);})]);}finally{clearTimeout(timer);}
    })();this.stopping=stopping.catch(error=>{this.stopping=undefined;throw error;});return this.stopping;
  }
}
