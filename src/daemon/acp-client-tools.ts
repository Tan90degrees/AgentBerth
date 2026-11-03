import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { terminalEnvironment } from './paths';
import { acpCommand } from './acp-transport';
import { terminateWindowsTree } from './processes';
import type {AcpTerminal} from '../shared/acp';

interface TerminalTask {child:ChildProcessWithoutNullStreams;output:Buffer;limit:number;truncated:boolean;exit:{exitCode?:number;signal?:string}|null;done:Promise<{exitCode?:number;signal?:string}>}
export class AcpClientTools {
  private tasks=new Map<string,TerminalTask>();
  private rootReady:Promise<string>|undefined;
  constructor(private root:string,private released?:(view:AcpTerminal)=>void){}
  terminal(terminalId:string):AcpTerminal{
    const task=this.tasks.get(terminalId);if(!task)throw new Error('终端输出尚未保存或已过期');
    let start=Math.max(0,task.output.length-16384);while(start<task.output.length&&(task.output[start]&0xc0)===0x80)start++;
    return {terminalId,output:task.output.subarray(start).toString('utf8'),truncated:task.truncated||start>0,...(task.exit?{exitStatus:task.exit}:{})};
  }
  private inside(file:string,root:string){const relative=path.relative(root,file);return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
  async file(input:string,create=false):Promise<string>{
    if(!input||input.includes('\0'))throw new Error('文件路径无效');
    const root=await(this.rootReady??=realpath(this.root)),file=path.resolve(root,input);
    let ancestor=create?path.dirname(file):file;
    // Canonicalize the closest existing ancestor first. Windows temp paths can
    // use 8.3 aliases (RUNNER~1); comparing them lexically to realpath rejects
    // the same workspace. Symlink targets still have to remain inside root.
    while(true){
      try{const actual=await realpath(ancestor),resolved=path.resolve(actual,path.relative(ancestor,file));if(!this.inside(actual,root)||!this.inside(resolved,root))throw new Error('ACP 路径指向工作区之外');return resolved;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}
    }
  }
  async call(method:string,p:Record<string,any>){
    if(method==='fs/read_text_file'){
      const input=z.object({path:z.string().min(1),line:z.number().int().min(1).optional(),limit:z.number().int().min(1).max(100000).optional()}).parse(p),file=await this.file(input.path),info=await stat(file);
      if(!info.isFile()||info.size>1024*1024)throw new Error('ACP 文本文件须为不超过 1 MiB 的普通文件');
      const content=await readFile(file,'utf8');return {content:input.line||input.limit?content.split('\n').slice((input.line??1)-1,input.limit?((input.line??1)-1)+input.limit:undefined).join('\n'):content};
    }
    if(method==='fs/write_text_file'){
      const input=z.object({path:z.string().min(1),content:z.string().max(1024*1024)}).parse(p),file=await this.file(input.path,true);
      if(Buffer.byteLength(input.content)>1024*1024)throw new Error('ACP 文本文件不能超过 1 MiB');
      await mkdir(path.dirname(file),{recursive:true});await this.file(file);await writeFile(file,input.content,'utf8');return {};
    }
    if(method==='terminal/create'){
      if(this.tasks.size>=16)throw new Error('此 ACP 会话最多保留 16 个命令，请先释放已完成的终端');
      const input=z.object({command:z.string().min(1).max(4096),args:z.array(z.string().max(16000)).max(128).default([]),cwd:z.string().optional(),env:z.array(z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),value:z.string().max(16000)})).max(128).default([]),outputByteLimit:z.number().int().positive().optional()}).parse(p);
      const cwd=await realpath(await this.file(input.cwd??this.root)),resolved=await acpCommand(input.command,input.args),file=resolved.file,child=spawn(file,resolved.args,{cwd,env:{...terminalEnvironment(file),...Object.fromEntries(input.env.map(item=>[item.name,item.value]))},shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
      const task:TerminalTask={child,limit:Math.min(1024*1024,input.outputByteLimit??1024*1024),output:Buffer.alloc(0),truncated:false,exit:null,done:null!};
      task.done=new Promise(resolve=>{child.once('error',error=>{task.output=Buffer.from(String(error));task.exit={exitCode:1};resolve(task.exit);});child.once('close',(code,signal)=>{task.exit={...(code!==null?{exitCode:code}:{}),...(signal?{signal}:{})};resolve(task.exit);});});
      const capture=(data:Buffer)=>{const output=Buffer.concat([task.output,data]);if(output.length>task.limit){task.truncated=true;let start=output.length-task.limit;while(start<output.length&&(output[start]&0xc0)===0x80)start++;task.output=output.subarray(start);}else task.output=output;};
      child.stdout.on('data',capture);child.stderr.on('data',capture);child.stdin.on('error',()=>{});child.stdin.end();
      await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});const terminalId=randomUUID();this.tasks.set(terminalId,task);return {terminalId};
    }
    const task=this.tasks.get(String(p.terminalId));if(!task)throw new Error('ACP 终端不存在或已释放');
    if(method==='terminal/output')return {output:task.output.toString('utf8'),truncated:task.truncated,...(task.exit?{exitStatus:task.exit}:{})};
    if(method==='terminal/wait_for_exit')return task.done;
    if(method==='terminal/kill'||method==='terminal/release'){await this.kill(task);if(method==='terminal/release'){this.released?.({...this.terminal(p.terminalId),released:true});this.tasks.delete(p.terminalId);}return {};}
    throw new Error('不支持的 ACP 客户端方法');
  }
  private async kill(task:TerminalTask){if(task.exit||!task.child.pid)return;if(process.platform==='win32')await terminateWindowsTree(task.child.pid,()=>!task.exit);else try{process.kill(-task.child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}task.child.stdout.destroy();task.child.stderr.destroy();let timer:NodeJS.Timeout|undefined;try{await Promise.race([task.done,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('ACP 命令进程尚未退出，请重试断开')),3000);})]);}finally{clearTimeout(timer);}}
  async close(){await Promise.all([...this.tasks].map(async([id,task])=>{await this.kill(task);this.released?.({...this.terminal(id),released:true});}));this.tasks.clear();}
}
