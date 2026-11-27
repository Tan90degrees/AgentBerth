import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readWorkspaceServerToken, workspaceServerOptions, type WorkspaceServerOptions } from './workspace-server';
import { DaemonServer } from './server';
import { RunLog } from './logs';

const hosted = process.argv[2] === '--server';
const args = hosted ? parseArgs({ args: process.argv.slice(3), options: {
  'data-dir': { type:'string' }, bind:{type:'string'}, port:{type:'string'},
  'ssh-only':{type:'boolean'}, 'tls-cert':{type:'string'}, 'tls-key':{type:'string'}, token:{type:'boolean'}, help:{type:'boolean'},
} }).values : undefined;
if(hosted&&process.platform!=='linux')throw new Error('服务器版需要 Linux');
if(args?.help){
  console.log('AgentBerth Server\n  --data-dir <absolute path> [--bind <IP>] [--port <port>] [--tls-cert <PEM> --tls-key <PEM>] 或 --ssh-only\n  --data-dir <absolute path> --token    输出已有服务器令牌');
  process.exit(0);
}
const dataDirectory = hosted ? args?.['data-dir'] : process.argv[2];

if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error('An absolute data directory is required');
if(args?.token){console.log(readWorkspaceServerToken(dataDirectory));process.exit(0);}
if(hosted)process.umask(0o077);
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
// Monitor for evidence without suppressing unexpected fatal exceptions or
// continuing a potentially inconsistent daemon. Never log environment/input.
process.on('uncaughtExceptionMonitor',(error,origin)=>{
  try {new RunLog(dataDirectory,'daemon').append(`${new Date().toISOString()} ${origin}: ${error.stack??String(error)}\n`);}catch{}
});
const lock = path.join(dataDirectory, 'daemon.lock');
const startupError = path.join(dataDirectory, 'daemon-startup-error.json');
function reportStartupError(error: unknown, descriptor?: number): never {
  // The desktop launcher reads errors from exactly the process it spawned.
  // A prior boot's error cannot be mistaken for a new daemon startup.
  try { writeFileSync(startupError, JSON.stringify({ pid: process.pid, message: String(error), time: new Date().toISOString() }), { mode: 0o600 }); }
  catch { /* Preserve the original startup error even on a read-only volume. */ }
  console.error('AgentBerth daemon startup failed:', error);
  if (descriptor !== undefined) {
    try { closeSync(descriptor); } catch { /* Already closed. */ }
    try { rmSync(lock, { force: true }); } catch { /* Preserve the original error. */ }
  }
  process.exit(1);
}
function acquireLock(): number {
  try { return openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('后台正在启动，请稍后重新连接');
    try { process.kill(pid, 0); } catch (checkError) {
      if ((checkError as NodeJS.ErrnoException).code !== 'ESRCH') throw checkError;
      rmSync(lock, { force: true });
      return openSync(lock, 'wx', 0o600);
    }
    throw new Error('后台已在运行');
  }
}
let descriptor: number;
try { descriptor = acquireLock(); }
catch (error) { reportStartupError(error); }
writeFileSync(descriptor, String(process.pid));
rmSync(startupError, { force: true });
let server: DaemonServer;
let mode:WorkspaceServerOptions|undefined;
try {
  if(args)mode=workspaceServerOptions(dataDirectory,args);
  server = new DaemonServer(dataDirectory, () => { void shutdown(); },undefined,undefined,mode);
}
catch (error) { reportStartupError(error, descriptor); }
let quitting = false;
async function shutdown() {
  if (quitting) return;
  quitting = true;
  try { await server.close(); }
  catch (error) { quitting = false; console.error(error); return; }
  closeSync(descriptor); rmSync(lock, { force: true });
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
void server.listen().then(()=>{
  if(mode?.sshOnly)console.log('AgentBerth Server ready for SSH');
  else if(mode)console.log(`AgentBerth Server listening at ${mode.tls?'wss':'ws'}://${mode.host.includes(':')?'['+mode.host+']':mode.host}:${mode.port}`);
}).catch(error => reportStartupError(error, descriptor));
