import { realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Session, TerminalConfig } from '../shared/protocol';
import { resolveExecutable } from './executables';

export async function directory(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new Error('项目路径必须是绝对路径');
  try {
    const canonical = await realpath(input);
    if (!(await stat(canonical)).isDirectory()) throw new Error('项目路径不是目录');
    return canonical;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`项目目录不存在或已移动，请编辑项目重新选择目录：${input}`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`无法访问项目目录，请检查目录访问权限：${input}`);
    throw error;
  }
}

export function terminalEnvironment(executable = ''): Record<string, string> {
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
  if (process.platform === 'win32' && path.basename(executable).toLowerCase() === 'bash.exe') {
    // Git Bash login profiles otherwise move to HOME or discard the Windows PATH.
    env.CHERE_INVOKING = '1';
    env.MSYSTEM ??= 'MINGW64';
    env.MSYS2_PATH_TYPE = 'inherit';
  }
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

export async function resolveTerminal(config: TerminalConfig): Promise<{ file: string; args: string[] }> {
  let selected: { file: string; args: string[] };
  const windows = process.platform === 'win32';
  switch (config.profile) {
    case 'auto': selected = shell(); break;
    case 'powershell':
      if (!windows) throw new Error('Windows PowerShell 仅适用于 Windows');
      selected = shell(); break;
    case 'pwsh': {
      selected = { file: config.executable.trim() || 'pwsh', args: ['-NoLogo', '-NoExit'] }; break;
    }
    case 'cmd':
      if (!windows) throw new Error('CMD 仅适用于 Windows');
      selected = { file: path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/D'] }; break;
    case 'bash': {
      if (windows) {
        const roots = [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[];
        const gitBash = roots.map(root => path.join(root, 'Git', 'bin', 'bash.exe')).find(existsSync);
        if (!gitBash) throw new Error('未找到 Git Bash，请使用自定义终端指定 bash.exe 的完整路径');
        selected = { file: gitBash, args: ['--login', '-i'] };
      } else selected = { file: '/bin/bash', args: ['-i'] };
      break;
    }
    case 'custom': selected = { file: config.executable.trim(), args: config.args.filter(arg => arg !== '') }; break;
  }
  return { file: await resolveExecutable(selected.file), args: selected.args };
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
