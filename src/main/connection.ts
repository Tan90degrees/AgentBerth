import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type Method, type Response, type RuntimeInfo, type ServerEvent } from '../shared/protocol';

export class DaemonConnection {
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
      this.onEvent({ event: 'connection', data: { connected: false } });
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
  close(): void { this.socket.close(); }
}

function runtimeFile(directory: string): RuntimeInfo | null {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    if (value.version !== PROTOCOL_VERSION || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isInteger(value.pid) || value.pid < 1) return null;
    return value as RuntimeInfo;
  } catch { return null; }
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
