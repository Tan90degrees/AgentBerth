import { access, realpath, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import type { Session, TerminalConfig } from '../shared/protocol';

export async function directory(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new Error('项目路径必须是绝对路径');
  const canonical = await realpath(input);
  if (!(await stat(canonical)).isDirectory()) throw new Error('项目路径不是目录');
  return canonical;
}

export function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('AGENTBERTH_') || key === 'ELECTRON_RUN_AS_NODE') continue;
    const normalized = process.platform === 'win32' ? key.toLowerCase() : key;
    if (keys.has(normalized)) continue;
    keys.add(normalized);
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

export function shell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { file: powershell, args: ['-NoLogo', '-NoExit'] };
  }
  const configured = process.env.SHELL;
  return { file: configured && path.isAbsolute(configured) && existsSync(configured) ? configured : '/bin/bash', args: ['-i'] };
}

async function executable(file: string): Promise<string> {
  if (!file.trim() || /[\r\n\x00]/.test(file)) throw new Error('请指定终端可执行文件，启动参数单独填写');
  const windows = process.platform === 'win32';
  if (windows && /\.(cmd|bat|ps1)$/i.test(file)) throw new Error('终端须为 .exe 可执行文件，例如 pwsh.exe 或 cmd.exe');
  if (!path.isAbsolute(file) && /[\\/]/.test(file)) throw new Error('终端路径必须是绝对路径，或 PATH 中的程序名');
  const envPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const names = windows && !path.extname(file) ? [file + '.exe', file] : [file];
  const candidates = path.isAbsolute(file) ? [file] : envPath.split(path.delimiter).filter(Boolean).filter(part => path.isAbsolute(part.replace(/^"|"$/g, ''))).flatMap(part => names.map(name => path.join(part.replace(/^"|"$/g, ''), name)));
  for (const candidate of candidates) {
    try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, windows ? constants.F_OK : constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`找不到终端程序 ${file}；请确认安装位置或选择完整路径`);
}

export async function resolveTerminal(config: TerminalConfig): Promise<{ file: string; args: string[] }> {
  let selected: { file: string; args: string[] };
  const windows = process.platform === 'win32';
  switch (config.profile) {
    case 'auto': selected = shell(); break;
    case 'powershell':
      if (!windows) throw new Error('Windows PowerShell 仅适用于 Windows');
      selected = shell(); break;
    case 'pwsh': {
      const installed = windows ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe') : '';
      selected = { file: installed && existsSync(installed) ? installed : 'pwsh', args: ['-NoLogo', '-NoExit'] }; break;
    }
    case 'cmd':
      if (!windows) throw new Error('CMD 仅适用于 Windows');
      selected = { file: path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/D'] }; break;
    case 'bash': {
      if (windows) {
        const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[];
        const gitBash = roots.map(root => path.join(root, 'Git', 'bin', 'bash.exe')).find(existsSync);
        if (!gitBash) throw new Error('未找到 Git Bash，请使用自定义终端指定 bash.exe 的完整路径');
        selected = { file: gitBash, args: ['--login', '-i'] };
      } else selected = { file: '/bin/bash', args: ['-i'] };
      break;
    }
    case 'custom': selected = { file: config.executable.trim(), args: config.args.filter(arg => arg !== '') }; break;
  }
  return { file: await executable(selected.file), args: selected.args };
}

export function launchCommand(session: Session, resume: boolean): string {
  if (resume) {
    if (!session.nativeSessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.nativeSessionId)) throw new Error('请先关联有效的原生对话记录');
    if (session.agent === 'codex') return `codex resume ${session.nativeSessionId}`;
    if (session.agent === 'claude') return `claude --resume ${session.nativeSessionId}`;
    if (session.agent === 'opencode') return `opencode --session ${session.nativeSessionId}`;
    throw new Error('当前 Agent 不支持原生会话恢复');
  }
  if (session.agent === 'shell') return '';
  if (session.agent === 'custom') {
    if (!session.command.trim() || /[\r\n\x00]/.test(session.command)) throw new Error('自定义启动命令须为非空单行命令');
    return session.command;
  }
  return session.agent;
}
