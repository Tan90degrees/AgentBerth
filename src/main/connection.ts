import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type Method, type Response, type RuntimeInfo, type ServerEvent, type State } from '../shared/protocol';

export class DaemonConnection {
  private silent = false;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private socket: WebSocket, private onEvent: (event: ServerEvent) => void) {
    socket.on('message', bytes => {
      let message: Response | ServerEvent;
      try { message = JSON.parse(bytes.toString()); } catch { socket.close(); return; }
      if ('event' in message) { this.onEvent(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    socket.on('close', () => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('后台连接已断开')); }
      this.pending.clear();
      if (!this.silent) this.onEvent({ event: 'connection', data: { connected: false } });
    });
    socket.on('error', () => {});
  }
  static open(runtime: RuntimeInfo, onEvent: (event: ServerEvent) => void): Promise<DaemonConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/rpc`, { headers: { Authorization: `Bearer ${runtime.token}` }, handshakeTimeout: 1000 });
      const error = (reason: Error) => { socket.terminate(); reject(reason); };
      socket.once('error', error);
      socket.once('open', () => { socket.removeListener('error', error); resolve(new DaemonConnection(socket, onEvent)); });
    });
  }
  rpc<T = unknown>(method: Method, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('后台连接已断开，请重新连接'));
    if (this.pending.size >= 128) return Promise.reject(new Error('请求过多，请稍后重试'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('后台响应超时')); }, 15000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close(silent = false): void { this.silent = silent; this.socket.close(); }
  get connected(): boolean { return this.socket.readyState === WebSocket.OPEN; }
}

function runtimeFile(directory: string): RuntimeInfo | null {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    if (value.version !== PROTOCOL_VERSION || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isInteger(value.pid) || value.pid < 1) return null;
    return value as RuntimeInfo;
  } catch { return null; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('后台尚未退出，请稍后重试');
}

// Never launch a new daemon while quitting, and never signal a PID from an
// unauthenticated or replaced runtime descriptor.
export async function shutdownDaemon(directory: string): Promise<void> {
  const runtime = runtimeFile(directory);
  if (!runtime) {
    const lock = path.join(directory, 'daemon.lock');
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1 || isAlive(pid)) throw new Error('后台正在启动或无法确认，请稍后重试退出');
    }
    return;
  }
  if (!isAlive(runtime.pid)) return;
  const candidate = await DaemonConnection.open(runtime, () => {});
  try {
    let state = await candidate.rpc<State>('state');
    if (runtimeFile(directory)?.token !== runtime.token) throw new Error('后台实例已变化，请重新连接后重试');
    if (state.apiVersion >= 4) await candidate.rpc('shutdown');
    else {
      // Older backends have stop + idle shutdown. Drain first, then use their
      // atomic idle gate; never forcibly abandon still-running process trees.
      const deadline = Date.now() + 10000;
      while (state.sessions.some(session => ['running', 'stopping'].includes(session.latestRun?.status ?? ''))) {
        await Promise.all(state.sessions.filter(session => session.latestRun?.status === 'running').map(session => candidate.rpc('stop', { sessionId: session.id })));
        if (Date.now() >= deadline) throw new Error('部分终端尚未停止，请重试退出');
        await new Promise(resolve => setTimeout(resolve, 100));
        state = await candidate.rpc<State>('state');
      }
      await stopIdleDaemon(directory);
    }
    await waitForExit(runtime.pid);
  } finally { candidate.close(true); }
}

export async function stopIdleDaemon(directory: string): Promise<void> {
  const runtime = runtimeFile(directory);
  if (!runtime) throw new Error('无法确认后台进程，请重新连接后重试');
  const candidate = await DaemonConnection.open(runtime, () => {});
  try {
    const state = await candidate.rpc<State>('state');
    if (state.sessions.some(session => ['running', 'stopping'].includes(session.latestRun?.status ?? ''))) throw new Error('请先停止全部终端，再更新后台');
    if (runtimeFile(directory)?.token !== runtime.token) throw new Error('后台实例已变化，请重新连接后重试');
    if (state.apiVersion >= 2) await candidate.rpc('shutdownIdle');
    else process.kill(runtime.pid, 'SIGTERM'); // Explicit upgrade of an authenticated, idle 0.1 daemon.
    await waitForExit(runtime.pid);
  } finally { candidate.close(true); }
}

export async function connectDaemon(directory: string, daemonFile: string, executable: string, onEvent: (event: ServerEvent) => void): Promise<DaemonConnection> {
  const runtime = runtimeFile(directory);
  if (runtime) {
    let candidate: DaemonConnection | null = null;
    try { candidate = await DaemonConnection.open(runtime, onEvent); await candidate.rpc('state'); return candidate; }
    catch {
      candidate?.close();
      try { process.kill(runtime.pid, 0); throw new Error('后台进程仍在运行但无法连接，请稍后重试'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  const child = spawn(executable, [daemonFile, directory], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let spawnError: Error | null = null;
  child.once('error', error => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const next = runtimeFile(directory);
    if (next) { try { return await DaemonConnection.open(next, onEvent); } catch { /* Another client may be starting the daemon. */ } }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('后台启动失败，请查看数据目录中的 daemon.log');
}
