import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { IPty } from 'node-pty';

const execute = promisify(execFile);

export async function terminateWindowsTree(pid:number,stillOwned:()=>boolean,operations={
  kill:async()=>{const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe');await execute(executable,['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:8000});},
  probe:()=>process.kill(pid,0),
}):Promise<void> {
  if(!stillOwned())return;
  let failure:unknown;
  try {await operations.kill();}catch(error){failure=error;}
  // ConPTY may miss onExit and taskkill may race natural exit or time out after
  // killing the tree. Verify the actual process in both success/error paths.
  const deadline=Date.now()+2000;
  while(stillOwned()){
    try {operations.probe();}
    catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw failure??error;}
    if(Date.now()>=deadline)throw failure??new Error('终端进程尚未退出，请重试停止');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

export async function terminateTree(terminal: IPty, stillOwned: () => boolean): Promise<void> {
  if (process.platform === 'win32') {
    await terminateWindowsTree(terminal.pid,stillOwned);
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
