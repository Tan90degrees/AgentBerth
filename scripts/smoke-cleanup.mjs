import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
async function killOwnedProcess(pid) {
  if (!pid) return;
  try { process.kill(pid, 0); } catch { return; }
  if (process.platform === 'win32') {
    await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {});
  } else { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

// Only PIDs captured from this smoke's launcher/runtime are eligible for cleanup.
export async function cleanupSmoke(app, daemonPid, folder) {
  let failure;
  if (app) {
    const child = app.process(); let onExit, timer;
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => { onExit = resolve; child.once('exit', onExit); });
    try {
      // app.close() can resolve before the process exits. Conversely, inherited
      // daemon pipes can keep close() pending after exit. Always observe exit.
      await Promise.race([exited, app.close().then(() => exited), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Smoke application did not exit')), 20000); })]);
    } catch (error) { failure = error; }
    finally { clearTimeout(timer); if (onExit) child.removeListener('exit', onExit); await killOwnedProcess(child.pid); }
  }
  await killOwnedProcess(daemonPid);
  await rm(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  if (failure) throw failure;
}
