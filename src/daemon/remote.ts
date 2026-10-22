import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import * as pty from 'node-pty';
import type { RemoteConfig, RemoteInfo } from '../shared/protocol';

export type TerminalProcess = Pick<pty.IPty, 'pid' | 'write' | 'resize' | 'pause' | 'resume' | 'kill' | 'onData' | 'onExit'>;
export const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const executeFile = promisify(execFile);
const tmux = 'tmux -L agentberth -f /dev/null';
export const sshArguments = (host: string, command: string, tty = false) => [
  tty ? '-tt' : '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
  '--', host, command,
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

/** tmux escapes control bytes with three octal digits; decode before decoding UTF-8. */
export function decodeTmuxOutput(text: string): Buffer {
  const pieces: Buffer[] = []; let start = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\\' && /^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) {
    pieces.push(Buffer.from(text.slice(start, i)), Buffer.from([parseInt(text.slice(i + 1, i + 4), 8)])); i += 3; start = i + 1;
  }
  pieces.push(Buffer.from(text.slice(start))); return Buffer.concat(pieces);
}

export function shellBootstrap(sessionId: string, directory: string): string {
  // The marker lives on the control connection; it does not depend on tmux forwarding an OSC to the viewer.
  const prefix = `\\033]777;AgentBerth;${sessionId};`;
  const rc = `[[ -r ~/.bashrc ]] && source ~/.bashrc
cd -- ${shellQuote(directory)} || { printf '\\n无法进入配置的远端目录\\n'; exit 1; }
__ab_active=1
__ab_prompt() {
  local __ab_status=$?
  printf '${prefix}ready;%s;%s\\007' "$__ab_status" "$(printf %s "$PWD" | base64 | tr -d '\\r\\n')"
  __ab_active=0
}
PROMPT_COMMAND=__ab_prompt
trap 'if [[ $__ab_active != 1 && $BASH_COMMAND != __ab_prompt* ]]; then __ab_active=1; printf "${prefix}start\\007"; fi' DEBUG
`;
  // bash is an explicit prerequisite. No user-controlled text is parsed by the local shell.
  return `bash -c ${shellQuote(`exec bash --noprofile --rcfile <(printf %s ${shellQuote(rc)}) -i`)}`;
}

export class ShellMarkers {
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  constructor(private sessionId: string, private onMarker: (kind: 'ready' | 'start', status: number, cwd: string | null) => void) {}
  feed(bytes: Buffer): void {
    this.buffer += this.decoder.write(bytes);
    const prefix = `\x1b]777;AgentBerth;${this.sessionId};`;
    for (;;) {
      const start = this.buffer.indexOf(prefix);
      if (start < 0) { this.buffer = this.buffer.slice(-prefix.length); return; }
      const end = this.buffer.indexOf('\x07', start);
      if (end < 0) { this.buffer = this.buffer.slice(start, start + 16384); return; }
      const [kind, status, cwd] = this.buffer.slice(start + prefix.length, end).split(';');
      this.buffer = this.buffer.slice(end + 1);
      if (kind === 'start') this.onMarker('start', 0, null);
      else if (kind === 'ready' && /^\d{1,3}$/.test(status ?? '') && /^[A-Za-z0-9+/=]*$/.test(cwd ?? '')) this.onMarker('ready', Number(status), Buffer.from(cwd ?? '', 'base64').toString('utf8'));
    }
  }
}

/** A persistent machine-readable observer plus a native attached viewer of the same tmux pane.
 * The native viewer owns rendering, mouse modes and redraws; the observer never resizes the pane.
 */
export class RemoteTerminal implements TerminalProcess {
  private events = new EventEmitter();
  private viewer: pty.IPty | null = null;
  private control: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private retries = 0;
  private pending: { resolve: (text: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  private connected = false;
  private cols: number;
  private rows: number;
  private name: string;
  constructor(readonly config: RemoteConfig, readonly sessionId: string, cols: number, rows: number,
    private notify: (change: Partial<RemoteInfo>) => void,
    private marker: (kind: 'ready' | 'start', status: number, cwd: string | null) => void,
    private executable = 'ssh') {
    this.cols = cols; this.rows = rows; this.name = `ab-${sessionId}`;
  }
  get pid(): number { return this.viewer?.pid ?? this.control?.pid ?? 0; }
  onData(listener: (text: string) => void) { this.events.on('data', listener); return { dispose: () => { this.events.off('data', listener); } }; }
  onExit(listener: (value: { exitCode: number; signal?: number }) => void) { this.events.on('exit', listener); return { dispose: () => { this.events.off('exit', listener); } }; }
  write(data: string | Buffer): void {
    if (!this.connected || !this.viewer) throw new Error('远端尚未连接，输入未发送');
    this.viewer.write(data);
  }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.viewer?.resize(cols, rows); }
  pause(): void { this.viewer?.pause(); }
  resume(): void { this.viewer?.resume(); }
  kill(): void { this.dispose(); }
  private dispose(): void {
    this.closed = true; this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null; this.connected = false;
    this.control?.kill(); this.control = null;
    try { this.viewer?.kill(); } catch { /* Already exited. */ }
    this.viewer = null;
    this.rejectPending(new Error('远端连接已关闭'));
  }
  private rejectPending(error: Error): void { for (const item of this.pending.splice(0)) { clearTimeout(item.timer); item.reject(error); } }
  private command(text: string): Promise<string> {
    if (!this.control || this.control.killed) return Promise.reject(new Error('远端控制连接已断开'));
    return new Promise((resolve,reject) => {
      const entry = { resolve, reject, timer: setTimeout(() => { this.control?.kill(); reject(new Error('远端控制响应超时，结果未知')); }, 12000) };
      this.pending.push(entry); this.control!.stdin.write(text + '\n');
    });
  }
  async connect(create = true): Promise<void> {
    if (this.closed) throw new Error('终端已关闭');
    const generation = ++this.generation;
    this.notify({ connection: 'connecting', phase: 'unknown', error: null });
    const remoteCommand = create
      ? `${tmux} -C new-session -A -s ${this.name} -x ${this.cols} -y ${this.rows} -- ${shellQuote(shellBootstrap(this.sessionId, this.config.directory))}`
      : `${tmux} -C attach-session -t ${this.name}`;
    const child = spawn(this.executable, sshArguments(this.config.host, remoteCommand), { windowsHide: true });
    this.control = child;
    let buffer = '', errorText = '', frame: string[] | null = null, initial = true;
    const markers = new ShellMarkers(this.sessionId, (kind,status,cwd) => { if (generation === this.generation && !this.closed) this.marker(kind,status,cwd); });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve,reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => { readyReject(new Error('SSH 连接超时，请检查密钥、known_hosts 和跳板机')); child.kill(); }, 14000);
    child.stderr.on('data', bytes => { errorText = (errorText + bytes.toString()).slice(-4096); });
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', bytes => {
      buffer += decoder.write(bytes);
      if (buffer.length > 1024 * 1024) { child.kill(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,end).replace(/\r$/, ''); buffer = buffer.slice(end+1);
        if (line.startsWith('%output ')) { const offset = line.indexOf(' ', 8); if (offset >= 0) markers.feed(decodeTmuxOutput(line.slice(offset+1))); }
        else if (line.startsWith('%begin ')) frame = [];
        else if (line.startsWith('%end ') || line.startsWith('%error ')) {
          const failed = line.startsWith('%error '), text = frame?.join('\n') ?? ''; frame = null;
          if (initial) { initial = false; if (failed) readyReject(new Error(text || '无法创建远端 tmux 会话')); else readyResolve(); }
          else { const entry = this.pending.shift(); if (entry) { clearTimeout(entry.timer); if (failed) entry.reject(new Error(text)); else entry.resolve(text); } }
        } else if (frame) frame.push(line);
      }
    });
    child.once('error', error => readyReject(error));
    child.once('close', code => {
      clearTimeout(timer);
      readyReject(new Error(errorText || 'SSH 连接已断开；远端需要安装 bash 和 tmux，并预先确认主机密钥'));
      if (generation !== this.generation || this.closed) return;
      if (this.stopping) { this.connected = false; this.control = null; return; }
      this.connected = false; this.rejectPending(new Error('控制连接中断，命令结果未知；不要自动重放'));
      if (code === 0 && !initial) { this.dispose(); this.events.emit('exit', { exitCode: 0 }); }
      else this.lost(errorText || 'SSH 连接中断，正在重连', generation);
    });
    try {
      await ready; clearTimeout(timer);
      if (generation !== this.generation || this.closed) throw new Error('远端连接已取消');
      await this.command(`set-option -t ${this.name} status off`);
      await this.command(`set-option -t ${this.name} destroy-unattached off`);
      // Capture current shell state on reattach without inventing completion for a disconnected action.
      const pane = await this.command(`display-message -p -t ${this.name} '#{pane_current_command}'`);
      if (generation !== this.generation || this.closed) throw new Error('远端连接已取消');
      this.viewer = pty.spawn(this.executable, sshArguments(this.config.host, `${tmux} attach-session -t ${this.name}`, true), { cols: this.cols, rows: this.rows, name: 'xterm-256color', env: { ...process.env, TERM: 'xterm-256color' } });
      const viewer = this.viewer;
      viewer.onData(text => { if (generation === this.generation && !this.closed) this.events.emit('data', text); });
      viewer.onExit(() => { if (generation === this.generation && !this.closed && !this.stopping) { try { viewer.kill(); } catch {} this.lost('终端显示连接已断开，正在重连', generation); } });
      this.connected = true; this.retries = 0;
      this.notify({ connection: 'connected', error: null });
      // An idle Bash emits its prompt again after a harmless refresh only on initial bootstrap.
      // Reattached shells remain unknown until a real prompt marker is observed; never send Enter automatically.
      void pane;
    } catch (error) {
      clearTimeout(timer);
      if (generation === this.generation) { this.generation++; child.kill(); this.rejectPending(error instanceof Error ? error : new Error(String(error))); }
      throw error;
    }
  }
  private lost(message: string, generation: number): void {
    if (generation !== this.generation || this.closed) return;
    this.generation++; this.connected = false;
    this.control?.kill(); this.control = null;
    try { this.viewer?.kill(); } catch {} this.viewer = null;
    this.rejectPending(new Error(message));
    this.notify({ connection: 'disconnected', phase: 'unknown', error: message });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(false).catch(error => { if (!this.closed) this.lost(String(error), this.generation); }); }, Math.min(1000 * 2 ** Math.min(this.retries++, 4), 10000));
  }
  reconnect(): void { this.lost('正在重新连接原会话；不会重放命令', this.generation); }
  async stop(): Promise<void> {
    // Use an independent acknowledgement channel: killing the tmux session also
    // closes its attached clients, which must not cancel the stop confirmation.
    this.stopping = true;
    try {
      await executeFile(this.executable, sshArguments(this.config.host, `command -v tmux >/dev/null || exit 127; if ${tmux} has-session -t ${this.name} 2>/dev/null; then ${tmux} kill-session -t ${this.name} || exit $?; fi; ! ${tmux} has-session -t ${this.name} 2>/dev/null`), { windowsHide: true, timeout: 14000, maxBuffer: 16384 });
      this.dispose(); this.events.emit('exit', { exitCode: 0 });
    } catch (error) {
      this.stopping = false;
      if (!this.connected) this.lost('停止未确认；正在恢复连接以便重试', this.generation);
      throw error;
    }
  }
}
