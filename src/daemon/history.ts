import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Agent, History, HistoryMessage } from '../shared/protocol';

type Json = Record<string, any>;
function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(item => item && typeof item.text === 'string' && ['text', 'input_text', 'output_text'].includes(item.type)).map(item => item.text).join('\n');
}
export function sameDirectory(a: string, b: string, platform = process.platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const resolved = api.resolve(value).replace(/[\\/]+$/, '');
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

export async function readHistory(file: string, agent: Agent, projectPath: string): Promise<History> {
  if (!['codex', 'claude'].includes(agent)) throw new Error('请为 Codex 或 Claude Code 会话关联原生 JSONL 记录');
  const canonical = await realpath(file);
  if (path.extname(canonical).toLowerCase() !== '.jsonl') throw new Error('请选择 .jsonl 对话记录');
  const info = await stat(canonical);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('对话文件须小于 16 MiB');
  const messages: HistoryMessage[] = [];
  const events: HistoryMessage[] = [];
  const warnings: string[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let malformed = 0;
  let chars = 0;
  const stream = createReadStream(canonical, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const add = (target: HistoryMessage[], role: unknown, text: string, timestamp: unknown) => {
    if (!['user', 'assistant'].includes(String(role)) || !text.trim()) return;
    const bounded = text.slice(0, 32768);
    target.push({ role: role as HistoryMessage['role'], text: bounded, timestamp: typeof timestamp === 'string' ? timestamp : null });
    if (target.length > 1000) target.shift();
  };
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > 1024 * 1024) { malformed++; continue; }
      let item: Json;
      try { item = JSON.parse(line); } catch { malformed++; continue; }
      if (!item || typeof item !== 'object') { malformed++; continue; }
      if (agent === 'codex') {
        const payload = item.payload ?? {};
        if (item.type === 'session_meta') {
          sessionId = payload.session_id ?? payload.id ?? sessionId;
          cwd = payload.cwd ?? cwd;
        } else if (item.type === 'response_item') {
          const message = payload.item ?? payload;
          if (message.type === 'message') add(messages, message.role, textContent(message.content), item.timestamp);
        } else if (item.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
          add(events, payload.type === 'user_message' ? 'user' : 'assistant', typeof payload.message === 'string' ? payload.message : '', item.timestamp);
        }
      } else {
        sessionId = item.sessionId ?? sessionId;
        cwd = item.cwd ?? cwd;
        if (['user', 'assistant'].includes(item.type)) add(messages, item.message?.role ?? item.type, textContent(item.message?.content), item.timestamp);
      }
    }
  } finally { lines.close(); stream.destroy(); }
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('记录缺少有效的原生会话 ID');
  if (typeof cwd !== 'string' || !sameDirectory(cwd, projectPath)) throw new Error('对话记录的工作目录与当前项目不一致');
  const selected = messages.length ? messages : events;
  const bounded: HistoryMessage[] = [];
  for (let index = selected.length - 1; index >= 0; index--) {
    const message = selected[index];
    if (chars + message.text.length > 512 * 1024) { warnings.push('仅显示最近 512 KiB 对话文本'); break; }
    chars += message.text.length;
    bounded.unshift(message);
  }
  if (malformed) warnings.push(`跳过 ${malformed} 行不完整或过大的记录`);
  warnings.push('只读导入最近最多 1000 条用户和助手文本；不改写 Agent 原生记录');
  return { messages: bounded, nativeSessionId: sessionId, path: canonical, warnings };
}
