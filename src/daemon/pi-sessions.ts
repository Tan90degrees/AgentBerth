import { createReadStream } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { History, HistoryMessage } from '../shared/protocol';
import { matchesProject } from './history';
import type { NativeCandidate } from './native-discovery';

const validId = /^[a-zA-Z0-9_-]{1,128}$/;
const metadataLimit = 128 * 1024;

export function piSessionRoot(project: string, home = homedir(), env = process.env): string {
  const expand = (value: string) => /^~[\\/]/.test(value) ? path.resolve(home, value.slice(2)) : path.resolve(value);
  if (env.PI_CODING_AGENT_SESSION_DIR) return expand(env.PI_CODING_AGENT_SESSION_DIR);
  const root = env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR) : path.join(home, '.pi', 'agent');
  const key = path.resolve(project).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return path.join(root, 'sessions', '--' + key + '--');
}

type Entry = { type?: string; id?: string; parentId?: string | null; version?: number; cwd?: string; timestamp?: string; name?: string; message?: { role?: string; content?: unknown } };

function entry(line: string): Entry | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function header(line: string) {
  const item = entry(line.replace(/^\uFEFF/, ''));
  return item?.type === 'session' && typeof item.id === 'string' && validId.test(item.id) &&
    typeof item.cwd === 'string' && [1, 2, 3].includes(item.version ?? 0)
    ? { id: item.id, cwd: item.cwd, legacy: item.version === 1 } : null;
}

function message(item: Entry): HistoryMessage | null {
  const { role, content } = item.message ?? {};
  if (item.type !== 'message' || (role !== 'user' && role !== 'assistant')) return null;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
  return text.trim() ? { role, text, timestamp: typeof item.timestamp === 'string' ? item.timestamp : null } : null;
}

export async function piSessionFile(file: string, project: string) {
  const canonical = await realpath(file);
  if (path.extname(canonical).toLowerCase() !== '.jsonl' || !(await stat(canonical)).isFile()) throw new Error('请选择 Pi 的 JSONL 原生对话记录');
  const handle = await open(canonical, 'r');
  try {
    const buffer = Buffer.alloc(metadataLimit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    const identity = header(lines[0]);
    if (!identity) throw new Error('Pi 会话头无效或版本不受支持');
    if (!await matchesProject(identity.cwd, project)) throw new Error('Pi 记录的工作目录与当前工作区不一致');
    let name = '', firstPrompt = '';
    for (const line of lines.slice(1)) {
      const item = entry(line);
      if (!item) continue;
      if (item.type === 'session_info' && typeof item.name === 'string') name = item.name.trim();
      if (!firstPrompt && item.message?.role === 'user') firstPrompt = message(item)?.text.trim() ?? '';
    }
    return { canonical, identity, title: (name || firstPrompt || identity.id).replace(/\s+/g, ' ').slice(0, 160) };
  } finally { await handle.close(); }
}

export async function discoverPiSessions(project: string, home = homedir(), env = process.env, expectedId?: string): Promise<NativeCandidate[]> {
  const paths = new Set([piSessionRoot(project, home, env)]);
  try { paths.add(piSessionRoot(await realpath(project), home, env)); } catch { /* The registered directory may have moved. */ }
  const files: { path: string; modified: number }[] = [];
  for (const root of paths) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const file of entries) {
      if (!file.isFile() || !file.name.endsWith(expectedId ? '_' + expectedId + '.jsonl' : '.jsonl')) continue;
      const filename = path.join(root, file.name);
      try { files.push({ path: filename, modified: (await stat(filename)).mtimeMs }); } catch { /* Session was removed. */ }
    }
  }
  files.sort((a, b) => b.modified - a.modified);
  const result = new Map<string, NativeCandidate>();
  for (const { path: filename, modified } of files.slice(0, 500)) {
    try {
      const { identity, title, canonical } = await piSessionFile(filename, project);
      if (expectedId && identity.id !== expectedId) continue;
      if (!result.has(identity.id)) result.set(identity.id, { nativeSessionId: identity.id, title, path: canonical, modified, updatedAt: new Date(modified).toISOString() });
    } catch { /* Ignore partial, foreign and unsupported records during discovery. */ }
  }
  return [...result.values()];
}

export async function readPiHistory(file: string, project: string, full = false): Promise<History> {
  const { canonical, identity } = await piSessionFile(file, project);
  const limit = 16 * 1024 * 1024;
  if (!full && (await stat(canonical)).size > limit) throw new Error('Pi 对话预览须小于 16 MiB，完整记录仍可导入 Wiki');
  const stream = createReadStream(canonical, { encoding: 'utf8', ...(full ? {} : { end: limit }) });
  const tree = new Map<string, Entry>();
  const linear: HistoryMessage[] = [];
  let first = true, leaf: string | null = null, incomplete = 0, remainder = '';
  const consume = (line: string) => {
    if (first) {
      first = false;
      const current = header(line);
      if (!current || current.id !== identity.id || current.cwd !== identity.cwd || current.legacy !== identity.legacy) throw new Error('Pi 会话头已变化，请重试');
      return;
    }
    if (!line.trim()) return;
    const item = entry(line);
    if (!item) { incomplete++; return; }
    if (identity.legacy) {
      const value = message(item);
      if (value) linear.push(value);
    } else if (typeof item.id === 'string' && (item.parentId === null || typeof item.parentId === 'string') && !tree.has(item.id)) {
      tree.set(item.id, item);
      leaf = item.id;
    } else incomplete++;
  };
  // JSONL is LF-framed. U+2028 and U+2029 can occur within a valid JSON string.
  for await (const chunk of stream) {
    const parts = (remainder + chunk).split('\n');
    remainder = parts.pop()!;
    for (const line of parts) consume(line);
  }
  if (remainder) consume(remainder);
  const branch: HistoryMessage[] = [];
  const seen = new Set<string>();
  for (let id: string | null = leaf; id !== null;) {
    const item = tree.get(id);
    if (!item || seen.has(id)) { incomplete++; break; }
    seen.add(id);
    const value = message(item);
    if (value) branch.push(value);
    id = item.parentId ?? null;
  }
  const selected = identity.legacy ? linear : branch.reverse();
  let chars = 0;
  const recent: HistoryMessage[] = [];
  for (let i = selected.length - 1; i >= 0 && (full || recent.length < 1000); i--) {
    const value = selected[i];
    const content = full ? value.text : value.text.slice(0, 32768);
    if (!full && chars + content.length > 512 * 1024) break;
    chars += content.length;
    recent.push({ ...value, text: content });
  }
  const warnings = incomplete ? ['部分 Pi 原生记录损坏或尚未写完'] : [];
  if (!full && (recent.length < selected.length || selected.some(value => value.text.length > 32768))) warnings.push('仅显示最近的对话文本，完整记录可导入 Wiki');
  return { path: canonical, nativeSessionId: identity.id, messages: recent.reverse(), warnings };
}

/** Pass the validated path as environment data, never interpolate it into shell input. */
export function piResumeCommand(executable: string, file: string): string {
  const shell = executable.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase();
  if (shell === 'powershell' || shell === 'pwsh') return 'pi --session "$env:AGENTBERTH_PI_SESSION_FILE"';
  if (shell === 'cmd' && !/[!%"\r\n]/.test(file)) return 'pi --session "%AGENTBERTH_PI_SESSION_FILE%"';
  if (['bash', 'sh', 'dash', 'zsh', 'fish', 'ksh'].includes(shell)) return 'pi --session "$AGENTBERTH_PI_SESSION_FILE"';
  throw new Error('这个终端或路径无法安全续接 Pi，请用 PowerShell 或 Bash，或在 Pi 中使用 /resume');
}
