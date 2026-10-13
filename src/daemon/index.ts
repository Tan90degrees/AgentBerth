import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import { DaemonServer } from './server';

const dataDirectory = process.argv[2];
if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error('An absolute data directory is required');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const lock = path.join(dataDirectory, 'daemon.lock');
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
const descriptor = acquireLock();
writeFileSync(descriptor, String(process.pid));
const server = new DaemonServer(dataDirectory, () => { void shutdown(); });
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
void server.listen().catch(error => { console.error(error); closeSync(descriptor); rmSync(lock, { force: true }); process.exit(1); });
