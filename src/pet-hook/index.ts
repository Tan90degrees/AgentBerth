import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hookStatus, petHookSchema } from '../shared/pet';

// Hooks must not block a TUI or turn a successful Agent operation into a failure.
async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const index = args.indexOf('--' + name); return index < 0 ? undefined : args[index + 1]; };
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
  const event = petHookSchema.parse({ sessionId: option('session-id') ?? process.env.AGENTBERTH_SESSION_ID, runId: option('run-id') ?? process.env.AGENTBERTH_RUN_ID, status });
  const descriptor = JSON.parse(readFileSync(path.join(directory, 'pet-hook.json'), 'utf8'));
  if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error('Hook endpoint unavailable');
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/hook`, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.token, 'Content-Type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(1000), redirect: 'error' });
  if (!response.ok) throw new Error('Hook rejected: ' + response.status);
}
void main().catch(error => { if (process.argv.includes('--verbose')) console.error('AgentBerth pet hook:', error instanceof Error ? error.message : String(error)); }).finally(() => { process.exitCode = 0; });
