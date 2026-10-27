import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import * as pty from 'node-pty';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { Attachment, Project, Run, Session, State } from '../src/shared/protocol';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean>, timeout = 7000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(70); }
  throw new Error('Condition did not become true before timeout');
}

test('real terminals keep running with no UI and restore the same PID, screen and independent sessions', { timeout: 25000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth 项目 spaces-'));
  const server = new DaemonServer(path.join(folder, 'data'));
  const runtime = await server.listen();
  let connection = await DaemonConnection.open(runtime, () => {});
  t.after(async () => { connection.close(); await server.close(); rmSync(folder, { recursive: true, force: true }); });
  const project = await connection.rpc<Project>('createProject', { name: '项目', path: folder });
  const a = await connection.rpc<Session>('createSession', { projectId: project.id, title: '会话 A', agent: 'shell', command: '' });
  const b = await connection.rpc<Session>('createSession', { projectId: project.id, title: '会话 B', agent: 'shell', command: '' });
  const runA = await connection.rpc<Run>('start', { sessionId: a.id, cols: 100, rows: 30 });
  const runB = await connection.rpc<Run>('start', { sessionId: b.id, cols: 100, rows: 30 });
  await connection.rpc('attach', { sessionId: a.id });
  const heartbeat = process.platform === 'win32' ? '1..12 | ForEach-Object { Write-Output "BERTH_TICK_$_"; Start-Sleep -Milliseconds 100 }\r' : 'for i in $(seq 1 12); do echo BERTH_TICK_$i; sleep .1; done\r';
  await connection.rpc('input', { sessionId: a.id, runId: runA.id, data: heartbeat });
  connection.close();
  await wait(1700);
  connection = await DaemonConnection.open(runtime, () => {});
  await eventually(async () => (await connection.rpc<Attachment>('attach', { sessionId: a.id })).snapshot.includes('BERTH_TICK_12'));
  const attachment = await connection.rpc<Attachment>('attach', { sessionId: a.id });
  assert.equal(attachment.run!.id, runA.id);
  assert.equal(attachment.run!.pid, runA.pid);
  assert.equal(attachment.run!.status, 'running');
  assert.match(attachment.snapshot, /BERTH_TICK_12/);
  await connection.rpc('resize', { sessionId: a.id, runId: runA.id, cols: 120, rows: 40 });
  assert.equal((await connection.rpc<Attachment>('attach', { sessionId: a.id })).cols, 120);
  await connection.rpc('attach', { sessionId: b.id });
  await connection.rpc('input', { sessionId: b.id, runId: runB.id, data: 'echo SECOND_SESSION_MARKER\r' });
  await eventually(async () => (await connection.rpc<Attachment>('attach', { sessionId: b.id })).snapshot.includes('SECOND_SESSION_MARKER'));
  assert.ok(!(await connection.rpc<Attachment>('attach', { sessionId: a.id })).snapshot.includes('SECOND_SESSION_MARKER'));
  await assert.rejects(connection.rpc('input', { sessionId: a.id, runId: runB.id, data: 'anything' }), /运行实例/);
  await connection.rpc('stop', { sessionId: a.id });
  await eventually(async () => (await connection.rpc<State>('state')).sessions.find(s => s.id === a.id)?.latestRun?.status === 'stopped');
  assert.equal((await connection.rpc<State>('state')).sessions.find(s => s.id === b.id)!.latestRun!.status, 'running');
});

test('concurrent starts create exactly one PTY and unauthorized clients are rejected', { timeout: 15000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-race-'));
  const server = new DaemonServer(path.join(folder, 'data'));
  const runtime = await server.listen();
  const connection = await DaemonConnection.open(runtime, () => {});
  t.after(async () => { connection.close(); await server.close(); rmSync(folder, { recursive: true, force: true }); });
  await assert.rejects(new Promise<void>((resolve, reject) => { const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/rpc`); socket.on('open', () => { socket.close(); resolve(); }); socket.on('error', reject); }), /401/);
  await assert.rejects(new Promise<void>((resolve, reject) => { const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/rpc`, { headers: { Authorization: `Bearer ${runtime.token}`, Origin: 'https://example.com' } }); socket.on('open', () => { socket.close(); resolve(); }); socket.on('error', reject); }), /401/);
  const project = await connection.rpc<Project>('createProject', { name: 'project', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'one', agent: 'shell', command: '' });
  const results = await Promise.allSettled([connection.rpc('start', { sessionId: session.id, cols: 80, rows: 24 }), connection.rpc('start', { sessionId: session.id, cols: 80, rows: 24 })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await connection.rpc<Run[]>('runs', { sessionId: session.id })).length, 1);
});

test('stopping a terminal terminates its foreground process and descendants', { timeout: 20000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-tree-'));
  const pidFile = path.join(folder, 'child.pid');
  const script = path.join(folder, 'parent.cjs');
  writeFileSync(script, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`);
  const server = new DaemonServer(path.join(folder, 'data'));
  const runtime = await server.listen();
  const connection = await DaemonConnection.open(runtime, () => {});
  t.after(async () => { connection.close(); await server.close(); rmSync(folder, { recursive: true, force: true }); });
  const project = await connection.rpc<Project>('createProject', { name: 'project', path: folder });
  const quote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
  const command = process.platform === 'win32' ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${quote(process.execPath)} ${quote(script)}` : `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(script)}`;
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'tree', agent: 'custom', command });
  await connection.rpc('start', { sessionId: session.id, cols: 80, rows: 24 });
  await eventually(async () => existsSync(pidFile));
  const childPid = Number(readFileSync(pidFile, 'utf8'));
  await connection.rpc('stop', { sessionId: session.id });
  await eventually(async () => {
    try {
      process.kill(childPid, 0);
      // A briefly unreaped Linux zombie has already stopped executing.
      if (process.platform === 'linux') return /\) Z /.test(readFileSync(`/proc/${childPid}/stat`, 'utf8'));
      return false;
    } catch { return true; }
  });
});

test('Windows stop completes after confirmed tree termination even when ConPTY drops its exit event', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-missing-pty-exit-'));
  const children: pty.IPty[] = [];
  const withoutExit: typeof pty.spawn = (file, args, options) => {
    const child = pty.spawn(file, args, options); children.push(child);
    return new Proxy(child, { get(target, key) {
      if (key === 'onExit') return () => ({ dispose() {} });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const server = new DaemonServer(path.join(folder, 'data'), () => {}, withoutExit);
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); for (const child of children) { try { child.kill(); } catch {} } rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await connection.rpc<Project>('createProject', { name: 'race', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'no exit event', agent: 'shell', terminal: { profile: 'cmd', executable: '', args: [] } });
  const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 });
  await eventually(async () => (await connection.rpc<Attachment>('attach', { sessionId: session.id })).snapshot.length > 0);
  await connection.rpc('stop', { sessionId: session.id });
  const stopped = (await connection.rpc<State>('state')).sessions[0].latestRun!;
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.exitCode, null);
  assert.throws(() => process.kill(run.pid!, 0));
  assert.equal((await connection.rpc<Attachment>('attach', { sessionId: session.id })).run!.status, 'stopped');
});

test('Windows PowerShell can be stopped immediately and restarted without waiting for prompt output', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-early-stop-'));
  const server = new DaemonServer(path.join(folder, 'data'));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await connection.rpc<Project>('createProject', { name: 'race', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'early stop', agent: 'shell' });
  for (let index = 0; index < 3; index++) {
    const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 });
    await connection.rpc('stop', { sessionId: session.id });
    await eventually(async () => (await connection.rpc<State>('state')).sessions[0].latestRun!.status === 'stopped');
    assert.throws(() => process.kill(run.pid!, 0));
  }
});
