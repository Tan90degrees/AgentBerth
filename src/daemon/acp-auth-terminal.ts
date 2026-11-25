import type {IPty} from 'node-pty';
import {terminateTree} from './processes';

/** This PTY is intentionally separate from the recoverable session terminal. */
export class AcpAuthTerminal {
  private active=true;
  private stopping=false;
  private terminated?:Promise<void>;
  private output='';
  private sequence=0;

  constructor(private pty:IPty,readonly id:string,emit:(sequence:number,output:string)=>void,exited:(success:boolean,exitCode:number)=>void){
    pty.onData(output=>{
      this.output=(this.output+output).slice(-64*1024);
      emit(++this.sequence,output);
    });
    pty.onExit(({exitCode,signal})=>{
      this.active=false;
      this.output='';
      if(!this.stopping)exited(exitCode===0&&!signal,exitCode);
    });
  }

  read(){return {sequence:this.sequence,output:this.output};}
  write(text:string){if(this.active&&!this.stopping)this.pty.write(text);}
  resize(cols:number,rows:number){if(this.active&&!this.stopping)this.pty.resize(cols,rows);}
  stop():Promise<void>{
    if(!this.active)return Promise.resolve();
    this.stopping=true;
    return this.terminated??=terminateTree(this.pty,()=>this.active).then(()=>{
      this.active=false;this.output='';
      if(process.platform==='win32'){try{this.pty.kill();}catch{/* The exit callback may have closed ConPTY. */}}
    }).catch(error=>{this.terminated=undefined;throw error;});
  }
}

export function literalAuthProgram(file:string){
  const executable=file.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/,'')??'';
  return !/^(?:cmd|command|powershell|pwsh|wscript|cscript|sh|bash|dash|zsh|fish|ksh|csh|tcsh|env)$/.test(executable);
}

export function terminalAuthDescriptor(value:Record<string,unknown>){
  const args=value.args??[],env=value.env??{};
  if(!Array.isArray(args)||args.length>64||args.some(arg=>typeof arg!=='string'||arg.length>4096||/[\r\n\0]/.test(arg)))return;
  if(!env||typeof env!=='object'||Array.isArray(env))return;
  const entries=Object.entries(env);
  if(entries.length>20||entries.some(([key,value])=>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof value!=='string'||value.length>1000||/[\r\n\0]/.test(value)||
    /^(?:PATH|PATHEXT|HOME|USERPROFILE|SHELL|COMSPEC|SYSTEMROOT|WINDIR|ELECTRON_RUN_AS_NODE|NODE_|PYTHON|PERL|RUBY|GEM_|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|BASH_ENV|ENV$|ZDOTDIR|LD_|DYLD_|SSL_|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GIT_|.*PROXY$)/i.test(key)))return;
  return {args:args as string[],env:Object.fromEntries(entries) as Record<string,string>};
}
