import { realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Session } from '../shared/protocol';

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

export function launchCommand(session: Session, resume: boolean): string {
  if (resume) {
    if (!session.nativeSessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.nativeSessionId)) throw new Error('请先关联有效的原生对话记录');
    if (session.agent === 'codex') return `codex resume ${session.nativeSessionId}`;
    if (session.agent === 'claude') return `claude --resume ${session.nativeSessionId}`;
    throw new Error('当前 Agent 不支持原生会话恢复');
  }
  if (session.agent === 'shell') return '';
  if (session.agent === 'custom') {
    if (!session.command.trim() || /[\r\n\x00]/.test(session.command)) throw new Error('自定义启动命令须为非空单行命令');
    return session.command;
  }
  return session.agent;
}
