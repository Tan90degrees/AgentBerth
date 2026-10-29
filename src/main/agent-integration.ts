import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AgentCli } from '../daemon/agent-cli';
import { petHookConfiguration } from './pet-config';

export type IntegrationProvider = 'claude' | 'opencode';
export interface HookInstallation { path: string; backup: string | null; provider: IntegrationProvider; message: string }
const pending = new Map<string, Promise<unknown>>();
const marker = '// AgentBerth desktop-pet adapter; managed file.';
export function integrationRoot(provider: IntegrationProvider, project?: string, home = os.homedir(), env = process.env) {
  if (project) return path.join(project, provider === 'claude' ? '.claude' : '.opencode');
  const custom = provider === 'claude' ? env.CLAUDE_CONFIG_DIR : env.XDG_CONFIG_HOME;
  if (custom && !path.isAbsolute(custom)) throw new Error('Agent 配置目录环境变量必须是绝对路径');
  return provider === 'claude' ? custom || path.join(home, '.claude') : path.join(custom || path.join(home, '.config'), 'opencode');
}
async function existing(file: string) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('配置目标必须是小于 1 MiB 的普通文件，不能覆盖链接');
    return await readFile(file, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function replace(file: string, before: string | null, after: string) {
  if (before === after) return null;
  await mkdir(path.dirname(file), { recursive: true });
  // Detect edits made since reading instead of overwriting another editor.
  if (await existing(file) !== before) throw new Error('配置已被其他程序修改，请重试');
  const backup = before === null ? null : file + '.agentberth-' + randomUUID() + '.bak';
  if (backup) await writeFile(backup, before!, { flag: 'wx', mode: 0o600 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, after, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  return backup;
}
export async function installAgentHook(options: {
  provider: IntegrationProvider; project?: string; executable: string; script: string; dataDirectory: string;
  pluginDirectory: string; version?: 'auto' | '1' | '2'; home?: string; env?: NodeJS.ProcessEnv;
  detectVersion?: () => Promise<string>;
}): Promise<HookInstallation> {
  const { provider } = options, root = integrationRoot(provider, options.project, options.home, options.env);
  const file = provider === 'claude' ? path.join(root, options.project ? 'settings.local.json' : 'settings.json') : path.join(root, 'plugins', 'agentberth-pet.mjs');
  const previous = pending.get(file) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const before = await existing(file);
    let after: string;
    if (provider === 'claude') {
      let config: Record<string, any> = {};
      try { config = before === null ? {} : JSON.parse(before); } catch { throw new Error('Claude 配置不是有效 JSON，请先修复；原文件未修改'); }
      if (!config || Array.isArray(config) || typeof config !== 'object' || config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error('Claude 配置 hooks 格式无效；原文件未修改');
      const hooks = config.hooks ??= {};
      for (const [event, entries] of Object.entries(petHookConfiguration(options.executable, options.script, options.dataDirectory).hooks)) {
        if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`Claude ${event} hook 格式无效；原文件未修改`);
        const handler = entries[0].hooks[0];
        const list = hooks[event] ??= [];
        const legacyCommand = handler.command.replace(' --provider claude', '');
        let found = false;
        for (const entry of list) if (Array.isArray(entry?.hooks)) entry.hooks = entry.hooks.map((item: any) => {
          if (item?.type !== 'command' || ![handler.command, legacyCommand].includes(item.command)) return item;
          found = true; return handler;
        });
        if (!found) list.push(entries[0]);
      }
      after = JSON.stringify(config, null, 2) + '\n';
    } else {
      let version = options.version ?? 'auto';
      if (version === 'auto') {
        const cli = new AgentCli();
        let output: string;
        try { output = await (options.detectVersion ? options.detectVersion() : cli.run(['--version'], options.project ?? options.home ?? os.homedir(), 8192)); }
        finally { await cli.close(); }
        const major = output.match(/(?:^|\s|v)([12])\.\d+\.\d+(?:\S*)?\s*$/)?.[1];
        if (major !== '1' && major !== '2') throw new Error('无法识别 OpenCode 版本，请确认已安装 1.x 或 2.x');
        version = major;
      }
      if (before !== null && !before.startsWith(marker)) throw new Error('同名插件文件不是 AgentBerth 管理的文件，请先改名；原文件未修改');
      after = await readFile(path.join(options.pluginDirectory, `opencode-pet-v${version}.mjs`), 'utf8');
      if (!after.startsWith(marker)) throw new Error('应用中的 OpenCode 适配文件不完整，请重新安装应用');
    }
    const backup = await replace(file, before, after);
    return { path: file, backup, provider, message: '适配已安装；重新启动对应 Agent 会话后生效。未安装 Agent 或修改模型、账号配置。' };
  });
  pending.set(file, task);
  try { return await task; } finally { if (pending.get(file) === task) pending.delete(file); }
}
