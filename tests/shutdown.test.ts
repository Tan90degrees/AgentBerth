import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectDaemon, shutdownDaemon } from '../src/main/connection';
import { DaemonServer } from '../src/daemon/server';
import { Store } from '../src/daemon/store';
import type { Project, Run, RuntimeInfo, Session, Attachment } from '../src/shared/protocol';
import { DaemonConnection } from '../src/main/connection';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('shutdown waits for its reply write even when the transport is delayed', {timeout:5000}, async t => {
  const folder=mkdtempSync(path.join(os.tmpdir(),'berth-quit-ack-'));
  let shutdowns=0;
  const server=new DaemonServer(folder,()=>{shutdowns++;});
  const client=await DaemonConnection.open(await server.listen(),()=>{});
  t.after(async()=>{client.close(true);await server.close();rmSync(folder,{recursive:true,force:true,maxRetries:5});});
  const socket=[...(server as any).clients.keys()][0];
  const send=socket.send.bind(socket);
  let release:(()=>void)|undefined;
  socket.send=(data: string, callback: unknown)=>{release=()=>send(data,callback);};
  const quitting=client.rpc('shutdown');
  while(!release)await wait(5);
  await wait(100); // Deliberately hold the reply beyond the former 50 ms timer.
  assert.equal(shutdowns,0,'Shutdown ran before its response was written');
  release();await quitting;
  const deadline=Date.now()+1000;while(!shutdowns){assert.ok(Date.now()<deadline);await wait(5);}
  assert.equal(shutdowns,1);
});
function stopped(pid: number): boolean {
  try { process.kill(pid, 0); return process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch { return true; }
}
function command(script: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
  return process.platform === 'win32' ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${quote(process.execPath)} ${quote(script)}` : `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(script)}`;
}

test('full quit stops every terminal, foreground descendants and daemon, retaining stopped run records', { timeout: 30000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-full-quit-')), data = path.join(folder, 'data');
  const pidFile = path.join(folder, 'children.json'), script = path.join(folder, 'tree.cjs');
  writeFileSync(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));console.log('QUIT_TREE_READY');setInterval(()=>{},1000);`);
  const connection = await connectDaemon(data, path.resolve('dist/daemon.cjs'), process.execPath, () => {});
  const runtime = JSON.parse(readFileSync(path.join(data, 'runtime.json'), 'utf8')) as RuntimeInfo;
  let descendants: number[] = [];
  t.after(async () => {
    connection.close(true);
    try { await shutdownDaemon(data); } catch { try { process.kill(runtime.pid, 'SIGTERM'); } catch {} }
    for (const pid of descendants) if (!stopped(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  });
  const project = await connection.rpc<Project>('createProject', { name: 'project', path: folder });
  const tree = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'tree', agent: 'custom', command: command(script) });
  const shell = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'shell', agent: 'shell' });
  const runs = await Promise.all([tree, shell].map(session => connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 })));
  for (let n = 0; n < 100 && !existsSync(pidFile); n++) await wait(60);
  assert.ok(existsSync(pidFile)); descendants = JSON.parse(readFileSync(pidFile, 'utf8'));
  await shutdownDaemon(data);
  assert.ok([runtime.pid, ...runs.map(run => run.pid!), ...descendants].every(stopped));
  assert.equal(existsSync(path.join(data, 'runtime.json')), false);
  assert.equal(existsSync(path.join(data, 'daemon.lock')), false);
  const store = new Store(data);
  try {
    const state = store.state();
    assert.equal(state.sessions.length, 2);
    assert.ok(state.sessions.every(session => session.latestRun?.status === 'stopped'));
    assert.equal(store.savedScreen(runs[0].id).snapshot, '');
    assert.equal(store.run(runs[0].id).recordOutput, 0);
  } finally { store.close(); }
  await shutdownDaemon(data); // Already stopped must remain stopped, not restart.
});

test('batched terminal output preserves ordered text, final screen and log without excessive events', { timeout: 25000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-output-burst-')), script = path.join(folder, 'burst.cjs');
  writeFileSync(script, `let n=0;const tick=setInterval(()=>{for(let i=0;i<10;i++)process.stdout.write('BURST_'+String(n++).padStart(4,'0')+'\\n');if(n===1000){clearInterval(tick);console.log('BURST_DONE');}},1);`);
  const server = new DaemonServer(path.join(folder, 'data'));
  let events = 0;
  const connection = await DaemonConnection.open(await server.listen(), event => { if (event.event === 'output') events++; });
  t.after(async () => { connection.close(true); await server.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await connection.rpc<Project>('createProject', { name: 'burst', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'burst', agent: 'shell' });
  const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 });
  await connection.rpc('attach', { sessionId: session.id });
  await connection.rpc('input', { sessionId: session.id, runId: run.id, data: command(script) + '\r' });
  for (let n = 0; n < 150; n++) {
    if ((await connection.rpc<Attachment>('attach', { sessionId: session.id })).snapshot.includes('BURST_DONE')) break;
    await wait(40);
  }
  const text = await connection.rpc<string>('output', { runId: run.id });
  assert.deepEqual([...text.matchAll(/BURST_(\d{4})/g)].map(match => Number(match[1])), Array.from({ length: 1000 }, (_, index) => index));
  assert.match((await connection.rpc<Attachment>('attach', { sessionId: session.id })).snapshot, /BURST_DONE/);
  assert.ok(events < 150, `Expected batched events; received ${events}`);
  console.log(`Output burst: 1000 lines retained in ${events} output events`);
});

test('unverified live lock blocks quit rather than killing another process', async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-quit-lock-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(path.join(folder, 'daemon.lock'), String(process.pid));
  await assert.rejects(shutdownDaemon(folder), /后台正在启动或无法确认/);
  process.kill(process.pid, 0);
});
