import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { RemoteAction, RemoteInfo, RemoteKey } from '../shared/protocol';
import type { Store } from './store';

export const remoteKeys: Record<RemoteKey, string> = { Enter: '\r', Tab: '\t', Escape: '\x1b', Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', 'Ctrl+C': '\x03', 'Ctrl+D': '\x04', 'Ctrl+Z': '\x1a', Backspace: '\x7f' };

/** Operation state belongs to the daemon, not to a tool request or renderer. */
export class RemoteActivity {
  readonly events = new EventEmitter();
  private pending: RemoteAction | null = null;
  private started = false;
  private holder: object | null = null;
  constructor(readonly info: RemoteInfo, private store: Pick<Store, 'remoteAction' | 'saveRemoteAction'>,
    private publish: (info: RemoteInfo) => void, private publishAction: (action: RemoteAction) => void) {}
  change(update: Partial<RemoteInfo>): void {
    const previousConnection = this.info.connection;
    Object.assign(this.info, update);
    if (update.connection === 'disconnected') this.unknown();
    this.publish({ ...this.info }); this.events.emit('change');
    if (update.connection && previousConnection !== update.connection) this.action('connection', update.connection === 'connected' ? 'SSH 已连接' : update.connection === 'connecting' ? '连接 SSH' : 'SSH 已断开，保留远端任务');
  }
  control(owner: 'user' | 'agent'): RemoteInfo {
    this.holder = null;
    this.change({ owner }); this.action('control', owner === 'user' ? '人工接管' : '允许 Agent 操作');
    return { ...this.info };
  }
  release(client: object): void { if (this.holder === client) this.control('user'); }
  assertAgent(client: object): void {
    if (this.info.owner !== 'agent') throw new Error('终端由用户控制，请让用户点击“交给 Agent”；不要自动抢回控制权');
    if (this.holder && this.holder !== client) throw new Error('另一个 Agent 正在操作此终端');
    if (this.info.connection !== 'connected') throw new Error('SSH 尚未连接，操作未发送');
    this.holder = client;
  }
  execute(client: object, requestId: string, command: string, write: (text: string) => void): RemoteAction {
    this.assertAgent(client);
    const previous = this.store.remoteAction(requestId);
    if (previous) {
      if (previous.sessionId !== this.info.sessionId || previous.runId !== this.info.runId || previous.label !== command) throw new Error('requestId 已用于另一个操作');
      return previous; // A retried MCP request must never replay a command.
    }
    if (this.pending || this.info.phase !== 'idle') throw new Error('终端不在已确认的 Shell 提示符，请先读取画面；交互程序请使用按键工具');
    const action = this.save({ id: requestId, sessionId: this.info.sessionId, runId: this.info.runId, kind: 'command', label: command, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null });
    this.pending = action; this.started = false; this.change({ phase: 'busy' });
    try { write(command + '\r'); }
    catch (error) { this.unknown(); throw error; }
    return action;
  }
  keys(client: object, data: string, label: string, write: (text: string) => void): void {
    this.assertAgent(client); this.action('input', label); write(data);
  }
  marker(kind: 'ready' | 'start', status: number, cwd: string | null): void {
    if (kind === 'start') { this.started = true; this.change({ phase: 'busy' }); return; }
    if (this.pending && this.started) {
      this.save({ ...this.pending, status: 'completed', exitCode: status, endedAt: new Date().toISOString() }); this.pending = null;
    }
    this.change({ phase: this.pending ? 'busy' : 'idle', cwd });
  }
  unknown(): void {
    if (this.pending) { this.save({ ...this.pending, status: 'unknown', endedAt: new Date().toISOString() }); this.pending = null; }
    this.info.phase = 'unknown';
  }
  finish(): void { this.unknown(); this.events.emit('change'); this.events.removeAllListeners(); }
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
