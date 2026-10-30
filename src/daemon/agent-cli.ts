import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolveExecutable } from './executables';
import { terminalEnvironment } from './paths';

const execute = promisify(execFile);
/** Read-only integration commands, bounded and cancelled with their owning service. */
export class AgentCli {
  private active = new Set<AbortController>();
  private tasks = new Set<Promise<string>>();
  private closing = false;
  async run(args: string[], cwd: string, maxBytes = 16 * 1024 * 1024): Promise<string> {
    if (this.closing) throw new Error('后台正在退出');
    if (this.active.size >= 4) throw new Error('正在读取其他 Agent 记录，请稍后重试');
    const controller = new AbortController(); this.active.add(controller);
    const task = this.perform(args, cwd, maxBytes, controller.signal);
    this.tasks.add(task);
    try { return await task; } finally { this.tasks.delete(task); this.active.delete(controller); }
  }
  private async perform(args: string[], cwd: string, maxBytes: number, signal: AbortSignal): Promise<string> {
    const windows = process.platform === 'win32';
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $env:Path=(@($env:Path,[Environment]::GetEnvironmentVariable('Path','Machine'),[Environment]::GetEnvironmentVariable('Path','User'))|Where-Object {$_}) -join ';'; $cmd=Get-Command opencode.exe,opencode.cmd -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1; if(!$cmd){throw 'OpenCode CLI not found'}; & $cmd.Source @(${args.map(quote).join(',')}); exit $LASTEXITCODE`;
    const file = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : await resolveExecutable('opencode');
    if (signal.aborted) throw new Error('Agent 读取已取消');
    return new Promise((resolve, reject) => {
      const child = spawn(file, windows ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : args, { cwd, env: terminalEnvironment(), windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let bytes = 0, failure: Error | null = null, killing: Promise<void> | null = null;
      const kill = () => killing ??= (async () => {
        if (!child.pid) return;
        if (windows && child.exitCode === null) { try { await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }); } catch { child.kill(); } }
        else if (!windows) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
      })();
      const fail = (message: string) => { failure ??= new Error(message); void kill(); };
      const abort = () => fail('Agent 读取已取消');
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => fail('OpenCode CLI 读取超时；请检查本机安装、配置及插件'), 8000);
      child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > maxBytes) fail('OpenCode 记录超过读取上限，请导出较小记录'); else chunks.push(data); });
      child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > maxBytes) fail('OpenCode CLI 输出过大'); });
      child.on('error', () => { failure ??= new Error('无法启动 OpenCode CLI，请检查本机安装与 PATH'); });
      child.on('close', code => { clearTimeout(timer); signal.removeEventListener('abort', abort); void kill().then(() => {
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error('OpenCode CLI 读取失败，请检查已安装版本及配置'));
        else { const output = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim(); output ? resolve(output) : reject(new Error('OpenCode CLI 未返回记录，请检查版本或使用手动导出')); }
      }); });
      if (signal.aborted) abort();
    });
  }
  async close() { this.closing = true; for (const controller of this.active) controller.abort(); await Promise.allSettled([...this.tasks]); }
}
