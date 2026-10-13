import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { connectDaemon, DaemonConnection, stopIdleDaemon } from '../src/main/connection';
import type { Attachment, RuntimeInfo, State } from '../src/shared/protocol';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('independent daemon survives launcher exit and upgrades only after draining terminals', { timeout: 30000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-persist-'));
  const launched = spawnSync(process.execPath, [path.resolve('dist/tests/launcher.cjs'), folder], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 12000 });
  assert.equal(launched.status, 0, launched.stderr);
  const run = JSON.parse(launched.stdout.trim());
  const data = path.join(folder, 'data');
  let runtime = JSON.parse(readFileSync(path.join(data, 'runtime.json'), 'utf8')) as RuntimeInfo;
  let connection: DaemonConnection | null = null;
  t.after(async () => {
    if (connection) { try { await connection.rpc('stop', { sessionId: run.sessionId }); } catch {} connection.close(); }
    try { process.kill(runtime.pid, 'SIGTERM'); } catch {}
    for (let n = 0; n < 50; n++) { try { process.kill(runtime.pid, 0); await wait(50); } catch { break; } }
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await wait(1000);
  connection = await connectDaemon(data, path.resolve('dist/daemon.cjs'), process.execPath, () => {});
  for (let n = 0; n < 70; n++) {
    if ((await connection.rpc<Attachment>('attach', { sessionId: run.sessionId })).snapshot.includes('PERSIST_42')) break;
    await wait(100);
  }
  const screen = await connection.rpc<Attachment>('attach', { sessionId: run.sessionId });
  assert.equal(screen.run!.pid, run.pid);
  assert.equal(screen.run!.id, run.runId);
  assert.equal(screen.run!.status, 'running');
  assert.match(screen.snapshot, /PERSIST_42/);
  assert.equal((await connection.rpc<State>('state')).sessions.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(data, 'runtime.json'), 'utf8')).pid, runtime.pid);
  await assert.rejects(stopIdleDaemon(data), /停止全部终端/);
  assert.equal((await connection.rpc<Attachment>('attach', { sessionId: run.sessionId })).run!.pid, run.pid);
  await connection.rpc('stop', { sessionId: run.sessionId });
  for (let n = 0; n < 100; n++) { if ((await connection.rpc<State>('state')).sessions[0].latestRun?.status === 'stopped') break; await wait(60); }
  await stopIdleDaemon(data);
  connection.close(true);
  connection = await connectDaemon(data, path.resolve('dist/daemon.cjs'), process.execPath, () => {});
  const next = JSON.parse(readFileSync(path.join(data, 'runtime.json'), 'utf8')) as RuntimeInfo;
  assert.notEqual(next.pid, runtime.pid); runtime = next;
  const upgraded = await connection.rpc<State>('state');
  assert.equal(upgraded.apiVersion, 4);
  assert.equal(upgraded.sessions[0].id, run.sessionId);
  assert.equal(upgraded.sessions[0].latestRun!.status, 'stopped');
});
