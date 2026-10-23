import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DaemonConnection, DaemonRpcError } from '../main/connection';
import type { RuntimeInfo } from '../shared/protocol';
import { McpError, TerminalMcp } from './server';

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) { process.stderr.write('Usage: agentberth-mcp <absolute-data-directory>\n'); process.exit(1); }
let connection: DaemonConnection | null = null;
let connecting: Promise<DaemonConnection> | null = null;
async function connect(): Promise<DaemonConnection> {
  if (connection?.connected) return connection;
  if (!connecting) connecting = (async () => {
    const runtime: RuntimeInfo = JSON.parse(readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    if (runtime.version !== 1 || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 || !/^[a-f0-9]{64}$/.test(runtime.token)) throw new Error('请先启动 AgentBerth，并更新后台');
    connection = await DaemonConnection.open(runtime, () => {}); if (ending) { connection.close(true); throw new Error('MCP client disconnected'); } return connection;
  })().catch(() => { throw new DaemonRpcError('AgentBerth 后台不可用，请打开应用并在设置中更新后台后重连 MCP。','BACKEND_UNAVAILABLE'); }).finally(() => { connecting = null; });
  return connecting;
}
const server = new TerminalMcp({ rpc: async (method,params) => (await connect()).rpc(method,params) });
let buffer = '', pending = 0, ending = false;
const controllers = new Map<string | number, AbortController>();
const send = (value: unknown) => { if (!ending) process.stdout.write(JSON.stringify(value) + '\n'); };
async function line(text: string): Promise<void> {
  let message: any;
  try { message = JSON.parse(text); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const id = message?.id;
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string' || (id !== undefined && typeof id !== 'string' && typeof id !== 'number')) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return; }
  if (id === undefined) {
    // Cancellation stops the wait by closing this client, never the remote job.
    if (message.method === 'notifications/cancelled' && controllers.has(message.params?.requestId)) { connection?.close(true); connection = null; }
    return;
  }
  if (pending >= 32 || controllers.has(id)) { send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Too many or duplicate requests' } }); return; }
  pending++; controllers.set(id,new AbortController());
  try { send({ jsonrpc: '2.0', id, result: await server.request(message.method,message.params) }); }
  catch (error) { send({ jsonrpc: '2.0', id, error: { code: error instanceof McpError ? error.code : -32603, message: String(error) } }); }
  finally { pending--; controllers.delete(id); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text: string) => {
  buffer += text;
  if (buffer.length > 256 * 1024) { process.stderr.write('MCP input too large\n'); process.exitCode = 1; process.stdin.destroy(); shutdown(); return; }
  let end: number;
  while ((end = buffer.indexOf('\n')) >= 0) { const text = buffer.slice(0,end).trim(); buffer = buffer.slice(end+1); if (text) void line(text); }
});
function shutdown() { ending = true; connection?.close(true); process.stdin.destroy(); }
process.stdin.on('end',shutdown); process.stdin.on('error',shutdown);
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
process.stdout.on('error',shutdown);
