import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentDefinition, History, Session } from '../shared/protocol';
import { matchesProject } from './history';

const execute = promisify(execFile);
const nativeId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const historyResult = z.object({
  version: z.literal(1), cwd: z.string().max(4096), nativeSessionId: nativeId.nullable(),
  path: z.string().max(4096).nullable().optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(32768), timestamp: z.string().max(100).nullable().default(null) }).strict()).max(1000),
  warnings: z.array(z.string().max(1000)).max(20).default([]),
}).strict();
const resumeResult = z.object({ version: z.literal(1), command: z.string().max(4096).refine(value => !!value.trim() && !/[\r\n\x00]/.test(value)) }).strict();

export class AgentPlugins {
  private active = new Map<AbortController, Promise<unknown>>();
  private closing = false;
  constructor(private timeout = 10000) {}

  private call(agent: AgentDefinition, method: 'history' | 'resume' | 'describe', session: Session | null, projectPath: string, file: string | null): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error('后台正在退出'));
    if (!agent.plugin || (method !== 'describe' && !agent.plugin[method])) return Promise.reject(new Error('此 Agent 未启用相应插件能力'));
    if (!path.isAbsolute(agent.plugin.executable)) return Promise.reject(new Error('插件程序须使用完整路径'));
    if (this.active.size >= 4) return Promise.reject(new Error('插件正在处理其他请求，请稍后重试'));
    const controller = new AbortController();
    const request = method === 'describe' ? { version: 1, method, agent: { id: agent.id, name: agent.name } } : { version: 1, method, agent: { id: agent.id, name: agent.name }, projectPath, session: { id: session!.id, title: session!.title, command: session!.command, nativeSessionId: session!.nativeSessionId }, path: file };
    const task = this.run(agent.plugin, request, projectPath, controller.signal).finally(() => this.active.delete(controller));
    this.active.set(controller, task);
    return task;
  }
  private run(plugin: NonNullable<AgentDefinition['plugin']>, request: unknown, cwd: string, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const node = plugin.runtime === 'node';
      const child = spawn(node ? process.execPath : plugin.executable, node ? [plugin.executable, ...plugin.args] : plugin.args, { cwd, env: node ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let failure: Error | null = null;
      let bytes = 0;
      let stderr = '';
      const output: Buffer[] = [];
      let killing: Promise<void> | null = null;
      const kill = () => killing ??= (async () => {
        if (!child.pid) return;
        if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null) {
          try { await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }); } catch { child.kill(); }
        } else if (process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); }
        }
      })();
      const fail = (message: string) => { failure ??= new Error(message); void kill(); };
      const abort = () => fail('插件请求已取消，后台正在退出');
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => fail('插件请求超时（10 秒），请检查插件程序'), this.timeout);
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail('插件输出超过 2 MiB'); else output.push(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail('插件输出超过 2 MiB'); });
      child.on('error', error => { failure ??= new Error(`无法启动插件：${error.message}`); });
      child.stdin.on('error', () => { /* Early exit is reported by close below. */ });
      child.on('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        void (async () => {
          await kill();
          if (failure) throw failure;
          if (code !== 0) throw new Error(`插件退出码 ${code ?? '未知'}${stderr.trim() ? '：' + stderr.trim().slice(-1000) : '；请检查插件程序'}`);
          try { return JSON.parse(Buffer.concat(output).toString('utf8').replace(/^\uFEFF/, '')); }
          catch { throw new Error('插件须向 stdout 返回单个 JSON 对象；日志请写入 stderr'); }
        })().then(resolve, reject);
      });
      if (signal.aborted) abort();
      else child.stdin.end(JSON.stringify(request) + '\n');
    });
  }
  async check(agent: AgentDefinition): Promise<{ name: string; message: string }> {
    if (!agent.plugin) throw new Error('当前类型未安装插件');
    const schema = z.object({ version: z.literal(1), name: z.string().min(1).max(100), capabilities: z.object({ history: z.boolean(), resume: z.boolean() }).strict() }).strict();
    const result = schema.safeParse(await this.call(agent, 'describe', null, path.dirname(agent.plugin!.executable), null));
    if (!result.success) throw new Error('插件自检返回格式无效，请让开发 Agent 实现 describe 接口');
    if ((agent.plugin!.history && !result.data.capabilities.history) || (agent.plugin!.resume && !result.data.capabilities.resume)) throw new Error('插件实际支持的能力与声明不一致，请重新导入修正后的插件');
    return { name: result.data.name, message: '插件连接正常' };
  }
  async history(agent: AgentDefinition, session: Session, projectPath: string, file: string | null): Promise<History> {
    let canonical: string | null = null;
    if (file) { canonical = await realpath(file); const info = await stat(canonical); if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('对话文件须小于 16 MiB'); }
    const parsed = historyResult.safeParse(await this.call(agent, 'history', session, projectPath, canonical));
    if (!parsed.success) throw new Error('插件历史返回格式无效，请检查 version、cwd、会话 ID 与 messages');
    if (!await matchesProject(parsed.data.cwd, projectPath)) throw new Error('插件对话记录的工作目录与当前项目不一致');
    if (session.nativeSessionId && parsed.data.nativeSessionId !== session.nativeSessionId && !file) throw new Error('插件返回的会话 ID 与已关联会话不一致');
    // The selected file is authoritative; a plugin cannot replace it with another file.
    if (!canonical && parsed.data.path) { canonical = await realpath(parsed.data.path); const info = await stat(canonical); if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('插件对话文件须小于 16 MiB'); }
    let chars = 0;
    const messages: History['messages'] = [];
    const warnings = [...parsed.data.warnings];
    for (const message of [...parsed.data.messages].reverse()) {
      if (chars + message.text.length > 512 * 1024) { warnings.push('仅显示最近 512 KiB 对话文本'); break; }
      messages.unshift(message); chars += message.text.length;
    }
    return { messages, warnings, path: canonical, nativeSessionId: parsed.data.nativeSessionId };
  }
  async resume(agent: AgentDefinition, session: Session, projectPath: string): Promise<string> {
    if (!nativeId.safeParse(session.nativeSessionId).success) throw new Error('请先关联有效的原生对话记录');
    if (agent.plugin?.resume) {
      const parsed = resumeResult.safeParse(await this.call(agent, 'resume', session, projectPath, null));
      if (!parsed.success) throw new Error('插件恢复命令须为非空单行命令');
      return parsed.data.command;
    }
    if (!agent.resumeCommand) throw new Error('此 Agent 尚未配置恢复命令或恢复插件');
    return agent.resumeCommand.replaceAll('{sessionId}', session.nativeSessionId!);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
  }
}
