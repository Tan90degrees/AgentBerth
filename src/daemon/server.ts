import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_ACTIVE_TERMINALS, PROTOCOL_VERSION, requestSchema, type Attachment, type Request, type Run, type RuntimeInfo, type ServerEvent } from '../shared/protocol';
import { Store } from './store';
import { directory, launchCommand, shell, terminalEnvironment } from './paths';
import { RunLog } from './logs';
import { readHistory } from './history';
import { terminateTree } from './processes';

interface LiveTerminal {
  run: Run; pty: pty.IPty; terminal: Terminal; serialize: SerializeAddon;
  seq: number; committedSeq: number; queuedBytes: number; stopping: boolean; closed: boolean;
  log: RunLog;
}
interface Client { subscriptions: Set<string>; pending: number }

export class DaemonServer {
  private store: Store;
  private http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  private ws = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  private clients = new Map<WebSocket, Client>();
  private live = new Map<string, LiveTerminal>();
  private token = randomBytes(32).toString('hex');
  private closing = false;
  private logs: string;
  private historyBusy = new Set<string>();

  constructor(readonly dataDirectory: string) {
    this.store = new Store(dataDirectory);
    this.logs = path.join(dataDirectory, 'logs');
    mkdirSync(this.logs, { recursive: true, mode: 0o700 });
    this.http.on('upgrade', (request, socket, head) => {
      if (!this.authorized(request)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      this.ws.handleUpgrade(request, socket, head, ws => this.ws.emit('connection', ws, request));
    });
    this.ws.on('connection', socket => {
      const client: Client = { subscriptions: new Set(), pending: 0 };
      this.clients.set(socket, client);
      socket.on('error', () => socket.close());
      socket.on('close', () => this.clients.delete(socket));
      socket.on('message', (bytes, isBinary) => {
        if (isBinary || client.pending >= 128) { socket.close(1008, 'Invalid or excessive requests'); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(bytes.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
        const result = requestSchema.safeParse(parsed);
        if (!result.success) {
          const id = parsed && typeof parsed === 'object' && 'id' in parsed ? String(parsed.id) : '';
          this.send(socket, { id, error: '请求参数无效' });
          return;
        }
        client.pending++;
        void this.dispatch(result.data, client).then(value => this.send(socket, { id: result.data.id, result: value })).catch(error => this.send(socket, { id: result.data.id, error: error instanceof Error ? error.message : '操作失败' })).finally(() => { client.pending--; });
      });
    });
  }

  private authorized(request: IncomingMessage): boolean {
    if (request.url !== '/rpc' || request.headers.origin) return false;
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${this.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    // A slow or closed UI must never stop output consumption by the daemon.
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, 'Reconnect to restore terminal'); return; }
    socket.send(JSON.stringify(message));
  }
  private broadcast(event: ServerEvent): void {
    for (const [socket, client] of this.clients) {
      if (event.event === 'output' && !client.subscriptions.has(event.data.sessionId)) continue;
      this.send(socket, event);
    }
  }
  private changed(): void { this.broadcast({ event: 'state', data: this.store.state() }); }

  async listen(): Promise<RuntimeInfo> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', () => { this.http.removeListener('error', reject); resolve(); });
    });
    const address = this.http.address();
    if (!address || typeof address === 'string') throw new Error('无法启动本地后台服务');
    const runtime = { version: PROTOCOL_VERSION, pid: process.pid, port: address.port, token: this.token };
    writeFileSync(path.join(this.dataDirectory, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 });
    return runtime;
  }

  private terminal(sessionId: string, runId?: string): LiveTerminal {
    const live = this.live.get(sessionId);
    if (!live || live.closed) throw new Error('终端已结束，请重新启动');
    if (runId && live.run.id !== runId) throw new Error('终端运行实例已变化，请重新连接');
    return live;
  }

  private async dispatch(request: Request, client: Client): Promise<unknown> {
    if (this.closing) throw new Error('后台正在退出');
    switch (request.method) {
      case 'state': return this.store.state();
      case 'createProject': { const project = this.store.createProject(request.params.name, await directory(request.params.path)); this.changed(); return project; }
      case 'createSession': {
        if (request.params.agent === 'custom' && (!request.params.command.trim() || /[\r\n\x00]/.test(request.params.command))) throw new Error('请填写单行启动命令');
        const session = this.store.createSession(request.params.projectId, request.params.title, request.params.agent, request.params.command);
        this.changed(); return session;
      }
      case 'renameSession': this.store.rename(request.params.sessionId, request.params.title); this.changed(); return null;
      case 'archiveSession':
        if (this.live.has(request.params.sessionId)) throw new Error('请先停止终端，再归档会话');
        this.store.archive(request.params.sessionId); this.changed(); return null;
      case 'start': return this.start(request.params.sessionId, request.params.resume, request.params.cols, request.params.rows);
      case 'stop': await this.stop(request.params.sessionId); return null;
      case 'attach': client.subscriptions.add(request.params.sessionId); return this.attach(request.params.sessionId);
      case 'detach': client.subscriptions.delete(request.params.sessionId); return null;
      case 'input': {
        if (!client.subscriptions.has(request.params.sessionId)) throw new Error('请先连接终端');
        this.terminal(request.params.sessionId, request.params.runId).pty.write(request.params.data); return null;
      }
      case 'resize': {
        if (!client.subscriptions.has(request.params.sessionId)) throw new Error('请先连接终端');
        const live = this.terminal(request.params.sessionId, request.params.runId);
        live.pty.resize(request.params.cols, request.params.rows); live.terminal.resize(request.params.cols, request.params.rows); return null;
      }
      case 'runs': this.store.session(request.params.sessionId); return this.store.runs(request.params.sessionId);
      case 'output': this.store.run(request.params.runId); return new RunLog(this.logs, request.params.runId).read();
      case 'history': return this.store.history(request.params.sessionId);
      case 'importHistory': return this.importHistory(request.params.sessionId, request.params.path);
      case 'refreshHistory': {
        const session = this.store.session(request.params.sessionId);
        if (!session.transcriptPath) throw new Error('请先关联原生对话记录');
        return this.importHistory(request.params.sessionId, session.transcriptPath);
      }
    }
  }

  private async importHistory(sessionId: string, file: string): Promise<unknown> {
    if (this.historyBusy.has(sessionId)) throw new Error('此会话正在读取对话记录');
    if (this.historyBusy.size >= 2) throw new Error('正在读取其他对话记录，请稍后重试');
    this.historyBusy.add(sessionId);
    try {
      const session = this.store.session(sessionId);
      const history = await readHistory(file, session.agent, this.store.project(session.projectId).path);
      this.store.saveHistory(sessionId, history); this.changed(); return history;
    } finally { this.historyBusy.delete(sessionId); }
  }

  private async start(sessionId: string, resume: boolean, cols: number, rows: number): Promise<Run> {
    if (this.live.has(sessionId)) throw new Error('此会话的终端已在运行');
    if (this.live.size >= MAX_ACTIVE_TERMINALS) throw new Error(`最多同时运行 ${MAX_ACTIVE_TERMINALS} 个终端`);
    const session = this.store.session(sessionId);
    const command = launchCommand(session, resume);
    const cwd = await directory(this.store.project(session.projectId).path);
    // Recheck after async path validation so concurrent starts cannot duplicate a session.
    if (this.live.has(sessionId)) throw new Error('此会话的终端已在运行');
    if (this.live.size >= MAX_ACTIVE_TERMINALS || this.closing) throw new Error('后台无法再启动终端');
    const run = this.store.createRun(sessionId, command, cols, rows);
    const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    const selected = shell();
    let child: pty.IPty;
    try { child = pty.spawn(selected.file, selected.args, { cwd, cols, rows, name: 'xterm-256color', env: terminalEnvironment() }); }
    catch (error) {
      terminal.dispose();
      this.store.finish(run.id, 'failed', null, String(error), '', 0, cols, rows); this.changed(); throw error;
    }
    this.store.setPid(run.id, child.pid);
    const live: LiveTerminal = { run: this.store.run(run.id), pty: child, terminal, serialize, seq: 0, committedSeq: 0, queuedBytes: 0, stopping: false, closed: false, log: new RunLog(this.logs, run.id) };
    this.live.set(sessionId, live);
    this.pruneLogs();
    child.onData(text => {
      const seq = ++live.seq;
      const bytes = Buffer.byteLength(text);
      live.queuedBytes += bytes;
      if (live.queuedBytes > 1024 * 1024) child.pause();
      try { live.log.append(text); } catch (error) { this.logError(error); }
      terminal.write(text, () => {
        live.committedSeq = seq;
        live.queuedBytes -= bytes;
        if (live.queuedBytes < 512 * 1024 && !live.closed) child.resume();
        this.broadcast({ event: 'output', data: { sessionId, runId: run.id, seq, text } });
      });
    });
    child.onExit(({ exitCode }) => { void this.finish(sessionId, live, exitCode); });
    if (command) child.write(`${command}\r`);
    this.changed();
    return live.run;
  }

  private async screen(live: LiveTerminal): Promise<{ snapshot: string; seq: number; cols: number; rows: number }> {
    // This callback follows all prior writes. seq and the screen describe the same point in time.
    return new Promise(resolve => live.terminal.write('', () => resolve({ snapshot: live.serialize.serialize({ scrollback: 200 }), seq: live.committedSeq, cols: live.terminal.cols, rows: live.terminal.rows })));
  }
  private async attach(sessionId: string): Promise<Attachment> {
    const session = this.store.session(sessionId);
    const live = this.live.get(sessionId);
    if (live) return { run: this.store.run(live.run.id), ...await this.screen(live) };
    if (session.latestRun) return { run: session.latestRun, ...this.store.savedScreen(session.latestRun.id) };
    return { run: null, snapshot: '', seq: 0, cols: 100, rows: 30 };
  }
  private async finish(sessionId: string, live: LiveTerminal, exitCode: number): Promise<void> {
    live.closed = true;
    const screen = await this.screen(live);
    this.store.finish(live.run.id, live.stopping ? 'stopped' : 'exited', exitCode, null, screen.snapshot, screen.seq, screen.cols, screen.rows);
    if (this.live.get(sessionId) === live) this.live.delete(sessionId);
    live.terminal.dispose();
    this.changed();
  }
  private async stop(sessionId: string): Promise<void> {
    this.store.session(sessionId);
    const live = this.live.get(sessionId);
    if (!live || live.closed || live.stopping) return;
    live.stopping = true; this.store.stopping(live.run.id); this.changed();
    try { await terminateTree(live.pty, () => this.live.get(sessionId) === live && !live.closed); }
    catch (error) {
      this.logError(error);
      if (!live.closed) { live.stopping = false; this.store.running(live.run.id); this.changed(); throw new Error('停止终端失败，请重试'); }
    }
  }
  private pruneLogs(): void {
    const active = new Set([...this.live.values()].map(item => item.run.id));
    const files = readdirSync(this.logs).filter(name => /^[a-f0-9-]+\.log(?:\.[123])?$/.test(name)).map(name => ({ name, ...statSync(path.join(this.logs, name)) })).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= 128 * 1024 * 1024) break;
      if (active.has(file.name.split('.log')[0])) continue;
      rmSync(path.join(this.logs, file.name), { force: true }); total -= file.size;
    }
  }
  private logError(error: unknown): void {
    try { const log = new RunLog(this.dataDirectory, 'daemon'); log.append(`${new Date().toISOString()} ${String(error)}\n`); } catch { /* Disk failure must not throw from PTY callbacks. */ }
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.keys()].map(sessionId => this.stop(sessionId).catch(error => this.logError(error))));
    const deadline = Date.now() + 4000;
    while (this.live.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    for (const socket of this.clients.keys()) socket.terminate();
    await new Promise<void>(resolve => this.ws.close(() => resolve()));
    await new Promise<void>(resolve => this.http.close(() => resolve()));
    rmSync(path.join(this.dataDirectory, 'runtime.json'), { force: true });
    this.store.close();
  }
}
