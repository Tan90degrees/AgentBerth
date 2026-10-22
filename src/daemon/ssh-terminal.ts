import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { StringDecoder } from 'node:string_decoder';
import { shellBootstrap, ShellMarkers, type TerminalProcess } from './remote';
import type { RemoteInfo, SshConnection, SshSecret } from '../shared/protocol';

export interface SshAccess {
  credentials(): Promise<SshSecret>;
  verify(fingerprint: string): Promise<boolean>;
}

/** Local SSH protocol client. The remote only needs sshd and its existing Shell. */
export class SshTerminal implements TerminalProcess {
  readonly pid = 0;
  private events = new EventEmitter();
  private client: Client | null = null;
  private channel: ClientChannel | null = null;
  private generation = 0;
  private closed = false;
  private reconnecting = false;
  constructor(private config: SshConnection, private sessionId: string, private directory: string, private cols: number, private rows: number,
    private access: SshAccess, private notify: (change: Partial<RemoteInfo>) => void,
    private marker: (kind: 'ready' | 'start', status: number, cwd: string | null, requestId: string) => void) {}
  onData(listener: (text: string) => void) { this.events.on('data', listener); return { dispose: () => { this.events.off('data', listener); } }; }
  onExit(listener: (value: {exitCode: number; signal?: number}) => void) { this.events.on('exit', listener); return { dispose: () => { this.events.off('exit', listener); } }; }
  write(data: string | Buffer): void { if (!this.channel || this.closed) throw new Error('SSH 未连接，输入未发送'); this.channel.write(data); }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.channel?.setWindow(rows, cols, 0, 0); }
  pause(): void { this.channel?.pause(); }
  resume(): void { this.channel?.resume(); }
  kill(): void { this.closed = true; this.generation++; this.channel?.destroy(); this.channel = null; this.client?.destroy(); this.client = null; }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('终端已关闭');
    const generation = ++this.generation;
    this.notify({ connection: 'connecting', phase: 'unknown', owner: 'user', error: null });
    const secret = this.config.authentication === 'agent' ? {} : await this.access.credentials();
    if (this.config.authentication === 'password' && !secret.password) throw new Error('请在 SSH 连接设置中输入密码并保存；未记住的密码仅在本次应用运行期间有效');
    let privateKey: Buffer | undefined;
    if (this.config.authentication === 'key') {
      try { privateKey = await readFile(this.config.privateKeyPath); }
      catch { throw new Error('无法读取私钥，请在连接设置中重新选择私钥文件'); }
    }
    if (generation !== this.generation || this.closed) throw new Error('连接已取消');
    const client = this.client = new Client();
    let verificationError: Error | null = null;
    return new Promise<void>((resolve, reject) => {
      let settled = false, online = false, shellExit: number | null = null;
      const active = () => generation === this.generation && !this.closed;
      const fail = (message: string) => {
        if (!active()) return;
        this.notify({ connection: 'disconnected', phase: 'unknown', owner: 'user', error: message });
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(message)); }
        client.destroy();
      };
      const ready = () => { if (!active() || settled) return; settled = true; online = true; clearTimeout(timer); this.notify({ connection: 'connected', error: null }); resolve(); };
      const timer = setTimeout(() => fail('SSH 连接超时，请检查地址、端口、认证方式或主机指纹确认窗口'), 45000);
      client.on('error', (error: Error & { level?: string; code?: string }) => {
        fail(verificationError?.message ?? (error.level === 'client-authentication' ? 'SSH 认证失败，请检查用户名、密码或密钥，以及服务器允许的登录方式' : error.code === 'ECONNREFUSED' ? '服务器拒绝 SSH 连接，请检查端口和 SSH 服务' : error.code === 'ENOTFOUND' ? '无法解析 SSH 主机名，请检查连接地址' : 'SSH 连接中断，请检查网络、登录方式或密钥口令；未确认的任务结果保留为未知'));
      });
      client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
        // A password is never substituted for OTP/MFA or an echoing prompt.
        finish(prompts.length === 1 && !prompts[0].echo && /password|密码/i.test(prompts[0].prompt) && secret.password ? [secret.password] : []);
      });
      client.on('close', () => {
        if (!active()) return;
        clearTimeout(timer); this.channel = null; this.client = null;
        if (!settled) { settled = true; reject(new Error(verificationError?.message ?? 'SSH 登录未完成，请检查连接设置')); }
        this.notify({ connection: 'disconnected', phase: 'unknown', owner: 'user', error: shellExit === null ? 'SSH 链路已断开，远端任务结果未知。重新连接将新建 Shell。' : 'SSH 会话已结束' });
        if (online && shellExit !== null) this.events.emit('exit', { exitCode: shellExit });
      });
      client.once('ready', () => {
        client.exec('case x in x) printf AgentBerth_POSIX;; esac', (error, probe) => {
          if (error) { fail('无法启动远端登录 Shell，请检查服务器是否允许 Shell 会话'); return; }
          let output = '';
          probe.on('data', (data: Buffer) => { if (output.length < 16384) output += data.toString(); });
          probe.on('error', () => fail('远端 Shell 检测失败'));
          probe.on('close', () => {
            if (!active()) return;
            const posix = output.trimEnd().endsWith('AgentBerth_POSIX');
            if (!posix && this.directory) { fail('此登录 Shell 不支持自动切换目录，请将远端目录留空'); return; }
            this.notify({ commandTracking: posix ? 'posix' : 'none' });
            const opened = (error: Error | undefined, channel: ClientChannel) => {
              if (error) { fail('服务器无法创建交互终端，请检查 PTY 权限'); return; }
              if (!active()) { channel.destroy(); return; }
              this.channel = channel;
              const decoder = new StringDecoder('utf8');
              const markers = new ShellMarkers(this.sessionId, (kind, status, cwd, requestId) => { if (!requestId && kind === 'ready') ready(); this.marker(kind, status, cwd, requestId); });
              const data = (bytes: Buffer) => { if (!active()) return; if (posix) markers.feed(bytes); else ready(); this.events.emit('data', decoder.write(bytes)); };
              channel.on('data', data); channel.stderr.on('data', data);
              channel.on('error', () => fail('SSH 终端连接中断，任务结果未知'));
              channel.on('exit', (code: number | null) => { shellExit = typeof code === 'number' ? code : null; });
              channel.on('close', () => { if (!active()) return; client.end(); });
              if (!posix) ready();
            };
            const pty = { term: 'xterm-256color', cols: this.cols, rows: this.rows, width: 0, height: 0 };
            if (posix) client.exec(shellBootstrap(this.sessionId, this.directory), { pty }, opened);
            else client.shell(pty, opened);
          });
        });
      });
      const config: ConnectConfig = {
        host: this.config.hostname, port: this.config.port, username: this.config.username,
        password: this.config.authentication === 'password' ? secret.password : undefined,
        privateKey, passphrase: secret.passphrase,
        agent: this.config.authentication === 'agent' ? (process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)) : undefined,
        tryKeyboard: this.config.authentication === 'password',
        keepaliveInterval: 10000, keepaliveCountMax: 3, readyTimeout: 45000,
        hostVerifier: (key: Buffer, callback: (accepted: boolean) => void) => {
          const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          void this.access.verify(fingerprint).then(accepted => { if (!accepted) verificationError = new Error('SSH 主机指纹未被信任，连接已取消'); callback(active() && accepted); }).catch((error: unknown) => { verificationError = new Error(error instanceof Error ? error.message : '请在 AgentBerth 中确认 SSH 主机指纹后重试'); callback(false); });
        },
      };
      try { client.connect(config); }
      catch { fail('SSH 登录配置无效，请检查私钥格式、密钥口令或登录方式'); }
    });
  }
  async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed) throw new Error('终端正在重新连接或已经关闭');
    this.reconnecting = true;
    try { this.generation++; this.channel?.destroy(); this.client?.destroy(); this.channel = null; this.client = null; this.events.emit('data', '\r\n[新 SSH 连接：原 Shell 和任务未恢复]\r\n'); await this.connect(); }
    finally { this.reconnecting = false; }
  }
  async stop(): Promise<void> {
    this.kill();
    this.notify({ connection: 'disconnected', phase: 'unknown', owner: 'user', error: 'SSH 已关闭；脱离 SSH 的远端进程不保证停止。' });
    this.events.emit('exit', { exitCode: 0 });
  }
}
