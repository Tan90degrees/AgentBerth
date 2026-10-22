import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import * as pty from 'node-pty';
import { terminateTree } from './processes';
import type { RemoteConfig, RemoteInfo } from '../shared/protocol';

export type TerminalProcess = Pick<pty.IPty, 'pid' | 'write' | 'resize' | 'pause' | 'resume' | 'kill' | 'onData' | 'onExit'>;
export const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const executeFile = promisify(execFile);

export const sshArguments = (host: string, command?: string, tty = false) => [
  tty ? '-tt' : '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
  '--', host, ...(command === undefined ? [] : [command]),
];

/** Host patterns cannot be connection targets. Includes are read only, bounded and cycle-safe. */
export function sshHosts(root = path.join(homedir(), '.ssh', 'config')): string[] {
  const seen = new Set<string>(), hosts = new Set<string>();
  const read = (file: string, depth: number) => {
    if (depth > 8 || seen.size >= 64 || seen.has(file)) return;
    seen.add(file);
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { return; }
    if (text.length > 1024 * 1024) return;
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().replace(/\s+#.*$/, '').split(/\s+/);
      if (parts[0]?.toLowerCase() === 'host') for (const alias of parts.slice(1)) if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$/.test(alias)) hosts.add(alias);
      if (parts[0]?.toLowerCase() === 'include') for (const pattern of parts.slice(1)) {
        const expanded = pattern.replace(/^~(?=[/\\])/, homedir());
        try { for (const include of globSync(path.isAbsolute(expanded) ? expanded : path.resolve(homedir(), '.ssh', expanded)).slice(0,64)) read(include, depth + 1); } catch { /* An unsupported pattern can still be resolved by OpenSSH. */ }
      }
    }
  };
  read(root, 0); return [...hosts].sort();
}

/** POSIX shell builtins only. No Bash, multiplexers, scripts, files or remote runtime. */
export function shellBootstrap(sessionId: string, directory: string): string {
  return `${directory ? `cd ${shellQuote(directory)} || exit; ` : ''}printf '\\033]777;AgentBerth;${sessionId};ready;;0;%s\\007' "$PWD"; exec "${'${SHELL:-/bin/sh}'}" -i`;
}
export function managedCommand(sessionId: string, requestId: string, command: string): string {
  const prefix = `\\033]777;AgentBerth;${sessionId};`;
  const characters = Array.from(command), chunks: string[] = [];
  // SSH PTYs can have a 4 KiB canonical input limit. Shell continuations keep
  // physical input lines short while eval still receives one exact argument.
  for (let offset = 0; offset < characters.length; offset += 256) chunks.push(shellQuote(characters.slice(offset, offset + 256).join('')));
  return `printf '${prefix}start;${requestId}\\007'; eval ${chunks.join('\\\r')}; __ab_status=$?; printf '${prefix}ready;${requestId};%s;%s\\007' "$__ab_status" "$PWD"; (exit "$__ab_status")\r`;
}
export class ShellMarkers {
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  constructor(private sessionId: string, private onMarker: (kind: 'ready' | 'start', status: number, cwd: string | null, requestId: string) => void) {}
  feed(bytes: Buffer): void {
    this.buffer += this.decoder.write(bytes);
    const prefix = `\x1b]777;AgentBerth;${this.sessionId};`;
    for (;;) {
      const start = this.buffer.indexOf(prefix);
      if (start < 0) { this.buffer = this.buffer.slice(-prefix.length); return; }
      const end = this.buffer.indexOf('\x07', start);
      if (end < 0) { this.buffer = this.buffer.slice(start, start + 16384); return; }
      const body = this.buffer.slice(start + prefix.length, end);
      this.buffer = this.buffer.slice(end + 1);
      const match = /^(start|ready);([^;]*)(?:;(\d{1,3});([\s\S]*))?$/.exec(body);
      if (!match) continue;
      if (match[1] === 'start') this.onMarker('start',0,null,match[2]);
      else if (match[3] !== undefined) this.onMarker('ready',Number(match[3]),match[4],match[2]);
    }
  }
}

/** One native SSH PTY, owned locally. A real transport loss never masquerades as
 * process/session recovery: reconnect is explicit and starts a new login Shell. */
export class RemoteTerminal implements TerminalProcess {
  private events = new EventEmitter();
  private viewer: pty.IPty | null = null;
  private closed = false;
  private reconnecting = false;
  private generation = 0;
  private cols: number;
  private rows: number;
  constructor(readonly config: RemoteConfig, readonly sessionId: string, cols: number, rows: number,
    private notify: (change: Partial<RemoteInfo>) => void,
    private marker: (kind: 'ready' | 'start', status: number, cwd: string | null, requestId: string) => void,
    private executable = 'ssh') { this.cols = cols; this.rows = rows; }
  get pid(): number { return this.viewer?.pid ?? 0; }
  onData(listener: (text: string) => void) { this.events.on('data',listener); return {dispose:()=>{this.events.off('data',listener);}}; }
  onExit(listener: (value: {exitCode:number;signal?:number}) => void) { this.events.on('exit',listener); return {dispose:()=>{this.events.off('exit',listener);}}; }
  write(data: string | Buffer): void {
    if (!this.viewer || this.closed) throw new Error('SSH 未连接，输入未发送');
    this.viewer.write(data);
  }
  resize(cols:number,rows:number):void {this.cols=cols;this.rows=rows;this.viewer?.resize(cols,rows);}
  pause():void {this.viewer?.pause();}
  resume():void {this.viewer?.resume();}
  kill():void {this.closed=true;this.generation++;try{this.viewer?.kill();}catch{}this.viewer=null;}
  async connect():Promise<void> {
    if(this.closed)throw new Error('终端已关闭');
    const generation=++this.generation;
    this.notify({connection:'connecting',phase:'unknown',owner:'user',error:null});
    let posix=false;
    try {
      const probe=await executeFile(this.executable,sshArguments(this.config.host,"case x in x) printf AgentBerth_POSIX;; esac"),{windowsHide:true,timeout:12000,maxBuffer:16384});
      posix=probe.stdout.trimEnd().endsWith('AgentBerth_POSIX');
    } catch(error) {
      if((error as {code?:unknown}).code===255 || typeof (error as {code?:unknown}).code!=='number') {
        const message = '系统 SSH 配置登录失败；若使用密码，请在设置中新建 SSH 连接并填写用户名、密码。密钥登录请先在系统终端确认可登录及主机指纹。';
        this.notify({connection:'disconnected',error:message});throw new Error(message);
      }
      // A non-POSIX login Shell remains usable as a real terminal through keys/read-screen.
    }
    if(generation!==this.generation||this.closed)throw new Error('连接已取消');
    if(!posix&&this.config.directory)throw new Error('此登录 Shell 不支持自动切换目录；请将远端目录留空，登录后切换');
    this.notify({commandTracking:posix?'posix':'none'});
    const child=pty.spawn(this.executable,sshArguments(this.config.host,posix?shellBootstrap(this.sessionId,this.config.directory):undefined,true),{cols:this.cols,rows:this.rows,name:'xterm-256color',env:{...process.env,TERM:'xterm-256color'}});
    this.viewer=child;
    let settled=false;
    return new Promise<void>((resolve,reject)=>{
      const ready=()=>{if(settled)return;settled=true;clearTimeout(timer);this.notify({connection:'connected',error:null});resolve();};
      const markers=new ShellMarkers(this.sessionId,(kind,status,cwd,requestId)=>{if(generation!==this.generation)return;if(!requestId&&kind==='ready')ready();this.marker(kind,status,cwd,requestId);});
      const timer=setTimeout(()=>{if(settled)return;settled=true;child.kill();reject(new Error('SSH 登录超时，请检查主机密钥、登录方式与 Shell'));},15000);
      child.onData(text=>{
        if(generation!==this.generation||this.closed)return;
        if(posix)markers.feed(Buffer.from(text));else ready();
        this.events.emit('data',text);
      });
      child.onExit(({exitCode})=>{
        try{child.kill();}catch{} // Dispose native ConPTY handles as well as the process.
        if(generation!==this.generation||this.closed)return;
        this.viewer=null;clearTimeout(timer);
        this.notify({connection:'disconnected',phase:'unknown',owner:'user',error:exitCode===255?'SSH 链路已断开，远端任务结果未知。重新连接会新建 Shell，不会恢复或重放旧任务。':'SSH 会话已结束'});
        if(!settled){settled=true;reject(new Error('SSH 登录失败；请先确认系统终端可登录此主机'));}
        else if(exitCode!==255)this.events.emit('exit',{exitCode});
      });
    });
  }
  async reconnect():Promise<void> {
    if(this.reconnecting||this.closed)throw new Error('终端正在重新连接或已经关闭');
    this.reconnecting=true;
    try {
      this.notify({connection:'disconnected',phase:'unknown',owner:'user',error:'重新连接将建立新 Shell；原任务结果未知，不会重放命令。'});
      await this.closeChannel();
      this.events.emit('data','\r\n\x1b[0m[新 SSH 连接：原 Shell 和任务未恢复]\r\n');
      await this.connect();
    } catch(error) {this.notify({connection:'disconnected',phase:'unknown',error:String(error)});throw error;}
    finally {this.reconnecting=false;}
  }
  private async closeChannel():Promise<void> {
    this.generation++;
    const child=this.viewer;if(!child)return;
    let exited=false;
    const exit=new Promise<void>(resolve=>{child.onExit(()=>{exited=true;resolve();});});
    await terminateTree(child,()=>this.viewer===child&&!exited);
    await Promise.race([exit,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('本机 SSH 尚未退出，请重试')),5000);exit.finally(()=>clearTimeout(timer));})]);
    if(this.viewer===child)this.viewer=null;
    try{child.kill();}catch{}
  }
  async stop():Promise<void> {
    await this.closeChannel();this.closed=true;
    this.notify({connection:'disconnected',phase:'unknown',owner:'user',error:'SSH 已关闭；脱离 SSH 的远端进程不保证停止，未确认结果保留为未知。'});
    this.events.emit('exit',{exitCode:0});
  }
}
