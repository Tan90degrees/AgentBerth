import { request } from 'node:http';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hookStatus, petHookSchema } from '../shared/pet';

// Hooks must not block a TUI or turn a successful Agent operation into a failure.
async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const index = args.indexOf('--' + name); return index < 0 ? undefined : args[index + 1]; };
  const provider = option('provider');
  if (provider && provider !== 'claude') return;
  if (provider && process.env.AGENTBERTH_AGENT && process.env.AGENTBERTH_AGENT !== provider) return;
  let payload: Record<string, unknown> = {};
  if (!process.stdin.isTTY) {
    let size = 0; const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { process.stdin.destroy(); resolve(); }, 300); timer.unref();
      process.stdin.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) { process.stdin.destroy(); reject(new Error('Hook input too large')); } else chunks.push(chunk); });
      process.stdin.once('end', () => { clearTimeout(timer); resolve(); }); process.stdin.once('error', reject); process.stdin.resume();
    });
    if (chunks.length) { try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Hook stdin must be JSON'); } }
  }
  const eventName = option('event') ?? String(payload.hook_event_name ?? payload.event ?? '');
  const status = eventName === 'PreToolUse' && payload.tool_name === 'AskUserQuestion' ? 'waiting' : hookStatus(eventName, String(payload.notification_type ?? ''));
  if (!status) return;
  const directory = option('data-dir') ?? process.env.AGENTBERTH_DATA_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error('AGENTBERTH_DATA_DIR is missing');
  // Subagent events cannot finish or bind their parent's terminal.
  if (provider === 'claude' && (payload.agent_id || payload.is_sidechain)) return;
  const native = provider === 'claude' && typeof payload.session_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(payload.session_id) && typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd)
    ? { provider, nativeSessionId: payload.session_id, cwd: payload.cwd } : {};
  const event = petHookSchema.parse({ sessionId: option('session-id') ?? process.env.AGENTBERTH_SESSION_ID, runId: option('run-id') ?? process.env.AGENTBERTH_RUN_ID, status, ...native });
  const descriptor = JSON.parse(readFileSync(path.join(directory, 'pet-hook.json'), 'utf8'));
  if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error('Hook endpoint unavailable');
  const body = JSON.stringify(event);
  await new Promise<void>((resolve, reject) => {
    // A direct loopback socket avoids global HTTP(S) proxies in Agent environments.
    const req = request({ hostname: '127.0.0.1', port: descriptor.port, path: '/hook', method: 'POST', createConnection: () => createConnection({ host: '127.0.0.1', port: descriptor.port }), headers: { Authorization: 'Bearer ' + descriptor.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      response.resume();
      if (response.statusCode === 200) resolve(); else reject(new Error('Hook rejected: ' + response.statusCode));
    });
    req.setTimeout(1000, () => req.destroy(new Error('Hook timeout')));
    req.on('error', reject); req.end(body);
  });
}
void main().catch(error => { if (process.argv.includes('--verbose')) console.error('AgentBerth pet hook:', error instanceof Error ? error.message : String(error)); }).finally(() => { process.exitCode = 0; });
