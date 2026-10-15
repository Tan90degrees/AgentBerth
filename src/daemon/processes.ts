import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { IPty } from 'node-pty';

const execute = promisify(execFile);

export async function terminateTree(terminal: IPty, stillOwned: () => boolean): Promise<void> {
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    try { await execute(executable, ['/PID', String(terminal.pid), '/T', '/F'], { windowsHide: true }); }
    catch (error) { if (stillOwned()) throw error; }
    return;
  }
  // Interactive shells put foreground jobs in a different process group.
  // Signalling only the shell's group would leave the agent alive.
  let stdout: string;
  try { ({ stdout } = await execute('ps', ['-axo', 'pid=,ppid=,pgid='], { maxBuffer: 4 * 1024 * 1024 })); }
  catch {
    // Minimal containers may lack ps/procfs. A hangup asks the interactive shell
    // to terminate its jobs, and closes the PTY without depending on procfs.
    if (stillOwned()) terminal.kill('SIGHUP');
    return;
  }
  if (!stillOwned()) return;
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([terminal.pid]);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); added = true; }
  }
  const groups = new Set(rows.filter(([pid, _parent, group]) => owned.has(pid) && owned.has(group)).map(row => row[2]));
  for (const group of groups) { try { process.kill(-group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  for (const pid of [...owned].reverse()) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
}
