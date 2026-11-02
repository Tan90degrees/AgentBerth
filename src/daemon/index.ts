import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import { DaemonServer } from './server';

const dataDirectory = process.argv[2];
if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error('An absolute data directory is required');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
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
try { server = new DaemonServer(dataDirectory, () => { void shutdown(); }); }
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
void server.listen().catch(error => reportStartupError(error, descriptor));
