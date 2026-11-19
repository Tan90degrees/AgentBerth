import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';

type Status = 'idle' | 'working' | 'waiting' | 'completed' | 'error';
type Context = { cwd: string; isIdle(): boolean; sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } };
type Event = { aborted?: boolean; messages?: { role?: string; stopReason?: string }[] };
type Pi = { on(event: string, handler: (event: Event, context: Context) => void): void };

export default function desktop(pi: Pi) {
  const { AGENTBERTH_AGENT: agent, AGENTBERTH_DATA_DIR: data, AGENTBERTH_SESSION_ID: sessionId, AGENTBERTH_RUN_ID: runId } = process.env;
  const uuid = /^[a-f0-9-]{36}$/i;
  if (agent !== 'pi' || !data || !path.isAbsolute(data) || !sessionId || !runId || !uuid.test(sessionId) || !uuid.test(runId)) return;
  const endpointFile = path.join(data, 'pet-hook.json');
  let queue = Promise.resolve(), pending = 0, failed = false;
  function publish(status: Status, ctx: Context) {
    if (pending >= 16) return;
    const id = ctx.sessionManager.getSessionId();
    const body = JSON.stringify({ sessionId, runId, status, provider: 'pi', cwd: ctx.cwd,
      ...(ctx.sessionManager.getSessionFile() && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? { nativeSessionId: id } : {}) });
    if (Buffer.byteLength(body) > 4096) return;
    pending++;
    queue = queue.then(async () => {
      const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'));
      if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) return;
      await new Promise<void>(resolve => {
        const req = request({ hostname: '127.0.0.1', port: endpoint.port, path: '/hook', method: 'POST',
          createConnection: () => createConnection({ host: '127.0.0.1', port: endpoint.port }),
          headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => { res.resume(); resolve(); });
        req.setTimeout(800, () => req.destroy());
        req.on('error', () => resolve());
        req.end(body);
      });
    }).catch(() => {}).finally(() => { pending--; });
  }
  pi.on('session_start', (_, ctx) => publish('idle', ctx));
  pi.on('session_shutdown', (_, ctx) => publish('idle', ctx));
  pi.on('agent_start', (_, ctx) => { failed = false; publish('working', ctx); });
  pi.on('agent_end', (event) => {
    failed = event.messages?.findLast(message => message.role === 'assistant')?.stopReason === 'error';
  });
  pi.on('agent_settled', (event, ctx) => publish(event.aborted ? 'idle' : failed ? 'error' : 'completed', ctx));
  pi.on('ui_prompt_start', (_, ctx) => publish('waiting', ctx));
  pi.on('ui_prompt_end', (_, ctx) => publish(ctx.isIdle() ? 'idle' : 'working', ctx));
}
