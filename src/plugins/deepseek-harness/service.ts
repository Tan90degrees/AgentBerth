import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {z} from 'zod';
import {acpCommand} from '../../daemon/acp-transport';
import {terminalEnvironment} from '../../daemon/paths';
import {terminateTree} from '../../daemon/processes';
import {localPluginUrl,type PluginWebState} from '../../shared/extensions';

const stripAnsi=(text:string)=>text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
const argumentsSchema=z.array(z.string().max(4096).refine(s=>!s.includes('\0'))).max(64);
export const defaultHarnessArgs=['--yes','@deepseek-ai/dsh','web','--no-open','--host','127.0.0.1','--port','0'];

/** Own only the child we launch. Harness owns its server, UI and configuration. */
export class HarnessService {
  private child:ChildProcessWithoutNullStreams|null=null;
  private closed=false;
  private operation:Promise<unknown>|null=null;
  private value:PluginWebState={state:'stopped',url:null,projectId:null,pid:null,exitCode:null,error:null,log:''};
  private lines=new Map<string,string>();
  private exited:Promise<void>=Promise.resolve();
  constructor(private executable:string,private args:string[],private onPidChange:(pid:number|null)=>void=()=>{}){argumentsSchema.parse(args);}
  static fromConfig(config:Record<string,unknown>,onPidChange:(pid:number|null)=>void=()=>{}){
    const executable=typeof config.executable==='string'?config.executable.trim():'npx';
    if(!executable||executable.length>4096||/[\r\n\0]/.test(executable))throw new Error('请填写有效的启动程序');
    let args:unknown;try{args=config.args===undefined?defaultHarnessArgs:JSON.parse(String(config.args));}catch{throw new Error('启动参数须为 JSON 字符串数组');}
    return new HarnessService(executable,argumentsSchema.parse(args),onPidChange);
  }
  snapshot():PluginWebState{return {...this.value};}
  private capture(chunk:string,stream:string){
    const pending=(this.lines.get(stream)??'')+stripAnsi(chunk),lines=pending.split(/[\r\n]/);
    this.lines.set(stream,(lines.pop()??'').slice(-24000));
    for(const line of lines){
      // Redact only complete lines, so a URL split across stdout chunks cannot
      // leak a token through the second chunk. stderr has its own line buffer.
      const redacted=line.replace(/https?:\/\/[^\s]+/g,url=>{try{const u=new URL(url);if(u.search)u.search='?redacted';return u.toString();}catch{return '[URL]';}});
      this.value.log=(this.value.log+redacted+'\n').slice(-20000);
      const match=/^\s*dsh web:\s*(https?:\/\/\S+)\s*$/.exec(line);if(!match||!['starting','running'].includes(this.value.state))continue;
      try{const url=localPluginUrl(match[1]);if(url.toString().length>8192)continue;this.value.url=url.toString();this.value.state='running';}catch{/* Refuse remote endpoints and unrelated log URLs. */}
    }
  }
  async control(action:'start'|'stop'|'restart',project?:{id:string|null;path:string}){
    if(this.closed)throw new Error('插件已停用');
    if(this.operation)throw new Error('服务操作正在进行，请稍后重试');
    const pending=(async()=>{
      if(action!=='start')await this.stop();
      if(action!=='stop'){
        if(!project)throw new Error('请选择本机项目');
        if(this.child){if(project.id!==this.value.projectId)throw new Error('更换项目之前请停止服务');return this.snapshot();}
        await this.start(project);
      }
      return this.snapshot();
    })();
    this.operation=pending;try{return await pending;}finally{this.operation=null;}
  }
  private async start(project:{id:string|null;path:string}){
    this.value={state:'starting',url:null,projectId:project.id,pid:null,exitCode:null,error:null,log:''};this.lines.clear();
    try{
      const command=await acpCommand(this.executable,this.args);if(this.closed)throw new Error('插件已停用');
      const child=spawn(command.file,command.args,{cwd:project.path,env:terminalEnvironment(command.file),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
      this.child=child;this.value.pid=child.pid??null;this.onPidChange(this.value.pid);
      this.exited=new Promise(resolve=>child.once('close',(code)=>{
        for(const stream of this.lines.keys())this.capture('\n',stream);
        if(this.child===child){this.child=null;this.value.pid=null;this.onPidChange(null);this.value.url=null;this.value.exitCode=code;
          if(this.value.state==='stopping')this.value.state='stopped';
          else {this.value.state='failed';this.value.error??=`Harness 服务已退出${code===null?'':'（'+code+'）'}，请检查启动日志`;}}
        resolve();
      }));
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',(text:string)=>this.capture(text,'stdout'));child.stderr.on('data',(text:string)=>this.capture(text,'stderr'));child.stdin.on('error',()=>{});
      child.once('error',error=>{this.value.error=error.message;this.value.state='failed';});
      await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    }catch(error){this.value.state='failed';this.value.error=String(error);throw error;}
  }
  private async stop(){
    const child=this.child;if(!child){this.value.state='stopped';this.value.url=null;return;}
    this.value.state='stopping';this.value.url=null;
    try{
      if(child.pid)await terminateTree({pid:child.pid,kill:(signal?:string)=>child.kill(signal as NodeJS.Signals)},()=>this.child===child);
      let timer:NodeJS.Timeout|undefined;
      try{await Promise.race([this.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Harness 服务尚未退出，请重试停止')),5000);})]);}finally{clearTimeout(timer);}
    }catch(error){this.value.state='failed';this.value.error=String(error);throw error;}
  }
  async dispose(){this.closed=true;await this.operation?.catch(()=>{});await this.stop();}
}
