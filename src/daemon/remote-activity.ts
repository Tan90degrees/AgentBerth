import { managedCommand } from './remote';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { OutputSearch, RemoteAction, RemoteCommandResult, RemoteInfo, RemoteKey, RemoteStatusUpdate } from '../shared/protocol';
import type { Store } from './store';
import { CommandOutput, COMMAND_OUTPUT_CAPACITY } from './remote-output';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { RemoteOperationError } from '../shared/remote-errors';

export const remoteKeys: Record<RemoteKey, string> = { Enter: '\r', Tab: '\t', Escape: '\x1b', Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', 'Ctrl+C': '\x03', 'Ctrl+D': '\x04', 'Ctrl+Z': '\x1a', Backspace: '\x7f' };

/** Operation state belongs to the daemon, not to a tool request or renderer. */
export class RemoteActivity {
  readonly events = new EventEmitter();
  private pending: RemoteAction | null = null;
  private started = false;
  private holder: object | null = null;
  private chosen = false;
  get controlChosen(): boolean { return this.chosen; }
  private outputs = new Map<string, CommandOutput>();
  constructor(readonly info: RemoteInfo, private store: Pick<Store, 'remoteAction' | 'saveRemoteAction'>,
    private publish: (info: RemoteInfo) => void, private publishAction: (action: RemoteAction) => void, private outputDirectory?:string) {}
  change(update: RemoteStatusUpdate): void {
    const previousConnection = this.info.connection;
    const owner = this.info.owner;
    Object.assign(this.info, update, { owner });
    if (update.connection === 'disconnected') this.unknown();
    this.publish({ ...this.info }); this.events.emit('change');
    if (update.connection && previousConnection !== update.connection) this.action('connection', update.connection === 'connected' ? 'SSH 已连接' : update.connection === 'connecting' ? '连接 SSH' : 'SSH 已断开，远端任务结果未知');
  }
  control(owner: 'user' | 'agent'): RemoteInfo {
    this.chosen = true;
    this.holder = null;
    this.info.owner = owner;
    this.change({}); this.action('control', owner === 'user' ? '人工接管' : '允许 Agent 操作');
    return { ...this.info };
  }
  // A disconnected MCP client frees its writer slot, not the user's grant.
  release(client: object): void { if (this.holder === client) this.holder = null; }
  assertManage(client:object):void {
    if(this.info.owner!=='agent')throw new RemoteOperationError('USER_CONTROLLED','终端由用户控制，请等待用户交还控制权',this.target());
    if(this.holder&&this.holder!==client)throw new RemoteOperationError('AGENT_BUSY','另一个 Agent 正在操作此终端',this.target());
    this.holder=client;
  }
  assertAgent(client: object): void {
    if (this.info.owner !== 'agent') throw new RemoteOperationError('USER_CONTROLLED','终端由用户控制，请让用户点击“交给 Agent”；不要自动抢回控制权',this.target());
    if (this.holder && this.holder !== client) throw new RemoteOperationError('AGENT_BUSY','另一个 Agent 正在操作此终端',this.target());
    if (this.info.connection !== 'connected') throw new RemoteOperationError('DISCONNECTED','SSH 尚未连接，操作未发送',this.target());
    this.holder = client;
  }
  execute(client: object, requestId: string, command: string, write: (text: string) => void, atPrompt = false): RemoteAction {
    this.assertAgent(client);
    const previous = this.store.remoteAction(requestId);
    if (previous) {
      if (previous.sessionId !== this.info.sessionId || previous.runId !== this.info.runId || previous.label !== command) throw new Error('requestId 已用于另一个操作');
      return previous; // A retried MCP request must never replay a command.
    }
    if (this.info.commandTracking === 'none') throw new RemoteOperationError('SHELL_UNSUPPORTED','当前登录 Shell 请使用读屏和按键操作；无需安装额外程序',this.target());
    if (this.pending || (this.info.phase !== 'idle' && !atPrompt)) throw new RemoteOperationError(this.pending?'COMMAND_RUNNING':'PROMPT_REQUIRED','终端不在已确认的 Shell 提示符，请先读取画面；交互程序请使用按键工具',{...this.target(),...(this.pending?{actionId:this.pending.id}:{})});
    const action = this.save({ id: requestId, sessionId: this.info.sessionId, runId: this.info.runId, kind: 'command', label: command, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null });
    if(this.outputDirectory)try{mkdirSync(this.outputDirectory,{recursive:true,mode:0o700});}catch{/* Output reports unavailable; command execution stays usable. */}
    this.outputs.set(requestId,new CommandOutput(COMMAND_OUTPUT_CAPACITY,this.outputDirectory?path.join(this.outputDirectory,requestId+'.bin'):undefined));
    if(this.outputs.size>8){const oldest=this.outputs.keys().next().value!;this.outputs.get(oldest)?.dispose();this.outputs.delete(oldest);}
    this.pending = action; this.started = false; this.change({ phase: 'busy' });
    try { write(managedCommand(this.info.sessionId,requestId,command)); }
    catch (error) { this.unknown(); throw new RemoteOperationError('OUTCOME_UNKNOWN',error instanceof Error?error.message:'终端写入结果未知',{...this.target(),actionId:requestId}); }
    return action;
  }
  private target() { return {sessionId:this.info.sessionId,runId:this.info.runId}; }
  keys(client: object, data: string, label: string, write: (text: string) => void): void {
    this.assertAgent(client); this.action('input', label);
    this.input(data);
    write(data);
  }
  input(data: string): void {
    // Ctrl+C can abort the rest of the managed line, including its completion
    // marker. Human takeover must not leave a permanently reserved command.
    if (data.includes('\x03')) this.unknown();
    if (!this.pending) this.change({phase:'unknown'});
  }
  marker(kind: 'ready' | 'start', status: number, cwd: string | null, requestId?: string): void {
    if (requestId && this.pending?.id !== requestId) return;
    if (kind === 'start') { this.started = true; this.change({ phase: 'busy' }); return; }
    if (this.pending && this.started) {
      const completed={ ...this.pending, status: 'completed' as const, exitCode: status, endedAt: new Date().toISOString() };
      this.pending = null;this.started=false;
      Object.assign(this.info,{phase:'idle',cwd});
      this.save(completed);
    }
    this.change({ phase: this.pending ? 'busy' : 'idle', cwd });
  }
  unknown(): void {
    this.info.phase = 'unknown';
    if (this.pending) {const action=this.pending;this.pending=null;this.started=false;this.save({ ...action, status: 'unknown', endedAt: new Date().toISOString() });}
  }
  finish(): void { this.unknown(); for(const output of this.outputs.values())output.dispose();this.outputs.clear();if(this.outputDirectory)try{rmSync(this.outputDirectory,{recursive:true,force:true});}catch{}this.events.emit('change'); this.events.removeAllListeners(); }
  capture(text:string):void {
    if(!this.pending||!this.started||!text)return;
    this.outputs.get(this.pending.id)?.append(text);
    this.events.emit('output');
  }
  latestCommand():RemoteAction|null {
    // Raw/partial input has no trustworthy command boundary. Never associate a
    // new untracked screen with a previous completed command.
    if(this.info.phase==='unknown'&&!this.pending)return null;
    const id=this.pending?.id??[...this.outputs.keys()].at(-1);
    return id?this.store.remoteAction(id):null;
  }
  latestOutputCommand():RemoteAction|null {
    // Reading an explicitly labelled previous command remains valid after raw
    // input. This does not associate that input/viewport with the old command.
    const id=this.pending?.id??[...this.outputs.keys()].at(-1);
    return id?this.store.remoteAction(id):null;
  }
  result(actionId:string,cursor=0,maxChars=32768,mode:'summary'|'page'='page',search?:OutputSearch):RemoteCommandResult {
    const action=this.store.remoteAction(actionId);
    if(!action||action.kind!=='command'||action.sessionId!==this.info.sessionId||action.runId!==this.info.runId)throw new Error('命令不属于当前运行实例');
    const cached=this.outputs.get(actionId);
    const page=!search&&mode==='page'?cached?.read(cursor,maxChars):undefined;
    const output=(search?cached?.search(search,cursor):mode==='summary'?cached?.summary(cursor):page?{...page,mode:'page' as const,cacheLost:page.truncated}:undefined)??{text:'',nextCursor:cursor,earliestCursor:null,truncated:true,hasMore:false,available:false,format:'terminal' as const};
    return {...action,output,info:{...this.info},elapsedMs:Math.max(0,Date.parse(action.endedAt??new Date().toISOString())-Date.parse(action.startedAt))};
  }
  async readOutput(actionId:string,cursor:number,maxChars:number,timeoutMs:number,waitFor:'output'|'completion',signal?:AbortSignal,mode:'summary'|'page'='page'):Promise<RemoteCommandResult> {
    const read=()=>this.result(actionId,cursor,maxChars,mode);
    const ready=(value:RemoteCommandResult)=>value.status!=='running'||(waitFor==='output'&&(!value.output.available||!!value.output.text||value.output.truncated));
    const current=read();if(ready(current)||!timeoutMs||signal?.aborted)return current;
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.events.off('change',change);this.events.off('output',change);signal?.removeEventListener('abort',end);};
      const end=()=>{cleanup();try{resolve(read());}catch(error){reject(error);}};
      const change=()=>{try{if(ready(read()))end();}catch(error){cleanup();reject(error);}};
      const timer=setTimeout(end,timeoutMs);
      this.events.on('change',change);if(waitFor==='output')this.events.on('output',change);signal?.addEventListener('abort',end,{once:true});change();
    });
  }
  private save(action: Omit<RemoteAction, 'sequence'>): RemoteAction { const value = this.store.saveRemoteAction(action); this.publishAction(value); this.events.emit('change'); return value; }
  private action(kind: RemoteAction['kind'], label: string): void {
    this.save({ id: randomUUID(), sessionId: this.info.sessionId, runId: this.info.runId, kind, label, status: 'completed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: null });
  }
  async wait(actionId: string, timeoutMs: number, signal?: AbortSignal): Promise<RemoteAction> {
    const read = () => {
      const action = this.store.remoteAction(actionId);
      if (!action || action.sessionId !== this.info.sessionId || action.runId !== this.info.runId) throw new Error('操作不属于当前运行实例');
      return action;
    };
    const current = read(); if (current.status !== 'running' || timeoutMs === 0 || signal?.aborted) return current;
    return new Promise((resolve,reject) => {
      const complete = () => { clearTimeout(timer); this.events.off('change', change); signal?.removeEventListener('abort', abort); };
      const change = () => { try { const action = read(); if (action.status !== 'running') { complete(); resolve(action); } } catch (error) { complete(); reject(error); } };
      const abort = () => { complete(); resolve(read()); };
      const timer = setTimeout(abort, timeoutMs);
      this.events.on('change', change); signal?.addEventListener('abort', abort, { once: true }); change();
    });
  }
}
