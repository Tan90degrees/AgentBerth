import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const uuid = /^[a-f0-9-]{36}$/i;
type Info = { id: string; parentID?: string; directory: string };
type Status = 'idle' | 'working' | 'waiting' | 'completed' | 'error';
export const eventTypes = ['session.created', 'session.updated', 'session.deleted', 'session.status', 'session.idle', 'session.error', 'permission.asked', 'permission.updated', 'permission.replied', 'question.asked', 'question.replied', 'question.rejected', 'form.created', 'form.replied', 'form.cancelled', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'];

/** State-only bridge; never collects prompts, tool arguments or output. */
export function createBridge(directory: string, getInfo: (id: string, signal: AbortSignal) => Promise<any>) {
  const env = process.env, data = env.AGENTBERTH_DATA_DIR, sessionId = env.AGENTBERTH_SESSION_ID, runId = env.AGENTBERTH_RUN_ID;
  if (env.AGENTBERTH_AGENT !== 'opencode' || !data || !path.isAbsolute(data) || !sessionId || !runId || !uuid.test(sessionId) || !uuid.test(runId) || !directory || !path.isAbsolute(directory)) return null;
  const same = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  const metadata = new Map<string, Info>(), waiting = new Set<string>();
  let active = idPattern.test(env.AGENTBERTH_NATIVE_SESSION_ID ?? '') ? env.AGENTBERTH_NATIVE_SESSION_ID! : '', stopped = false, failed = false;
  let queue = Promise.resolve(), queued = 0, last = '', lastAt = 0;
  const remember = (value: any) => {
    const id = value?.id ?? value?.sessionID, folder = value?.directory ?? value?.location?.directory;
    if (typeof id !== 'string' || !idPattern.test(id) || typeof folder !== 'string' || !path.isAbsolute(folder)) return;
    if (metadata.size >= 512) metadata.delete(metadata.keys().next().value!);
    metadata.set(id, { id, directory: folder, ...(typeof value.parentID === 'string' ? { parentID: value.parentID } : {}) });
  };
  const info = async (id: string): Promise<Info | undefined> => {
    if (metadata.has(id)) return metadata.get(id);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Session lookup timeout')); }, 750); });
    try { const result = await Promise.race([getInfo(id, controller.signal), timeout]); remember(result?.data ?? result); } catch { /* Unknown/foreign sessions are ignored. */ }
    finally { clearTimeout(timer!); }
    return metadata.get(id);
  };
  const root = async (id: string) => {
    if (!idPattern.test(id)) return null;
    const seen = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(id)) return null; seen.add(id);
      const item = await info(id);
      if (!item || !same(item.directory, directory)) return null;
      if (!item.parentID) return id;
      id = item.parentID;
    }
    return null;
  };
  const send = async (status: Status) => {
    if (stopped || !active) return;
    const key = active + ':' + status;
    if (last === key && Date.now() - lastAt < 30000) return;
    try {
      const endpoint = JSON.parse(await readFile(path.join(data, 'pet-hook.json'), 'utf8'));
      if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) return;
      const body = JSON.stringify({ sessionId, runId, status, provider: 'opencode', nativeSessionId: active, cwd: directory });
      if (Buffer.byteLength(body) > 4096) return;
      const accepted = await new Promise<boolean>(resolve => {
        const req = request({ hostname: '127.0.0.1', port: endpoint.port, path: '/hook', method: 'POST', createConnection: () => createConnection({ host: '127.0.0.1', port: endpoint.port }), headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode === 200); });
        req.setTimeout(1000, () => req.destroy()); req.on('error', () => resolve(false)); req.end(body);
      });
      if (accepted) { last = key; lastAt = Date.now(); }
    } catch { /* App absent, restarting or stale run: never block the Agent. */ }
  };
  const enqueue = (action: () => Promise<void>) => {
    if (stopped || queued >= 64) return Promise.resolve();
    queued++; queue = queue.then(() => stopped ? undefined : action()).catch(() => {}).finally(() => { queued--; });
    return queue;
  };
  const prompt = (id: string) => enqueue(async () => {
    const owner = await root(id);
    if (owner !== id) return;
    if (active !== id) waiting.clear(); active = id; failed = false;
    await send('working');
  });
  const event = (value: any) => {
    if (!eventTypes.includes(value?.type)) return Promise.resolve();
    return enqueue(async () => {
      const type = value.type, p = value.properties ?? value.data ?? {};
      if (type === 'session.created' || type === 'session.updated') { remember(p.info ?? p); return; }
      const id = p.sessionID ?? p.form?.sessionID;
      if (typeof id !== 'string' || !active || await root(id) !== active) return;
      const own = id === active, key = id + ':' + (p.id ?? p.requestID ?? p.permissionID ?? p.form?.id ?? 'request');
      if (['permission.asked', 'permission.updated', 'question.asked', 'form.created'].includes(type)) { waiting.add(key); await send('waiting'); return; }
      if (['permission.replied', 'question.replied', 'question.rejected', 'form.replied', 'form.cancelled'].includes(type)) { waiting.delete(key); await send(waiting.size ? 'waiting' : 'working'); return; }
      // A child finishing/failing cannot complete or fail the whole terminal.
      if (!own) return;
      if (type === 'session.deleted') { metadata.delete(id); waiting.clear(); await send('idle'); active = ''; return; }
      const status = p.status?.type;
      if (type === 'session.error' || type === 'session.execution.failed') { failed = true; await send('error'); }
      else if (type === 'session.execution.started' || type === 'session.status' && ['busy', 'retry'].includes(status)) { failed = false; await send(waiting.size ? 'waiting' : 'working'); }
      else if (type === 'session.execution.interrupted') { waiting.clear(); await send('idle'); }
      else if (type === 'session.idle' || type === 'session.execution.succeeded' || type === 'session.status' && status === 'idle') await send(waiting.size ? 'waiting' : failed ? 'error' : 'completed');
    });
  };
  return { prompt, event, close: () => { stopped = true; metadata.clear(); waiting.clear(); }, drain: () => queue };
}
