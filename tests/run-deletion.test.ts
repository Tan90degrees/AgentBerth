import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/daemon/store';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { Attachment, Project, Run, Session, State } from '../src/shared/protocol';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Terminal state did not settle'); await new Promise(resolve => setTimeout(resolve, 30)); }
}

test('deleting finished records removes saved screens and recalculates latest state, including records beyond the list limit', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'berth-run-delete-')); let store = new Store(folder);
  t.after(() => { store.close(); return rm(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const p = store.createProject('Project', folder); const s = store.createSession(p.id, 'Shell', 'shell', '');
  const first = store.createRun(s.id, '', 80, 24); assert.throws(() => store.deleteRun(first.id), /先停止/);
  store.stopping(first.id); assert.throws(() => store.deleteRun(first.id), /先停止/);
  store.finish(first.id, 'stopped', 0, null, 'old screen', 1, 80, 24);
  for (let n=0;n<105;n++) { const r=store.createRun(s.id, '', 80, 24); store.finish(r.id, n % 2 ? 'failed' : 'exited', 0, null, 'saved screen', 1, 80, 24); }
  const last = store.session(s.id).latestRun!; store.deleteRun(last.id);
  assert.throws(() => store.run(last.id), /不存在/); assert.equal(store.savedScreen(last.id), undefined);
  assert.notEqual(store.session(s.id).latestRun!.id, last.id);
  assert.equal(store.clearFinishedRuns(s.id).length, 105); assert.deepEqual(store.runs(s.id), []); assert.equal(store.session(s.id).latestRun, null);
  store.close(); store = new Store(folder);
  assert.equal(store.session(s.id).latestRun, null); assert.equal(store.state().sessions[0].latestRun, null);
});

test('run deletion RPC removes all log rotations and preserves current terminals and other sessions', { timeout: 20000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'berth-run-rpc-')); const data = path.join(folder, 'data');
  const server = new DaemonServer(data); const c = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { c.close(); await server.close(); await rm(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const p = await c.rpc<Project>('createProject', { name: 'Project', path: folder });
  const s = await c.rpc<Session>('createSession', { projectId: p.id, title: 'Shell', agent: 'shell', command: 'echo RUN_DELETE_READY' });
  const old = await c.rpc<Run>('start', { sessionId: s.id, cols: 80, rows: 24 });
  await c.rpc('attach', { sessionId: s.id });
  await c.rpc('input', { sessionId: s.id, runId: old.id, data: 'echo RUN_DELETE_READY\r' });
  await until(async () => (await c.rpc<Attachment>('attach', { sessionId: s.id })).snapshot.includes('RUN_DELETE_READY'));
  await c.rpc('stop', { sessionId: s.id });
  await until(async () => (await c.rpc<State>('state')).sessions[0].latestRun!.status === 'stopped');
  for (const suffix of ['', '.1', '.2', '.3']) await writeFile(path.join(data, 'logs', old.id + '.log' + suffix), 'delete me');
  const live = await c.rpc<Run>('start', { sessionId: s.id, cols: 80, rows: 24 });
  await assert.rejects(c.rpc('deleteRun', { runId: live.id }), /先停止/);
  await c.rpc('deleteRun', { runId: old.id });
  for (const suffix of ['', '.1', '.2', '.3']) await assert.rejects(readFile(path.join(data, 'logs', old.id + '.log' + suffix)), /ENOENT/);
  await assert.rejects(c.rpc('output', { runId: old.id }), /不存在/);
  const other = await c.rpc<Session>('createSession', { projectId: p.id, title: 'Other', agent: 'shell', command: 'echo OTHER_READY' });
  const otherRun = await c.rpc<Run>('start', { sessionId: other.id, cols: 80, rows: 24 });
  await c.rpc('attach', { sessionId: other.id });
  await c.rpc('input', { sessionId: other.id, runId: otherRun.id, data: 'echo OTHER_READY\r' });
  await until(async () => (await c.rpc<Attachment>('attach', { sessionId: other.id })).snapshot.includes('OTHER_READY'));
  await c.rpc('clearFinishedRuns', { sessionId: s.id });
  assert.equal((await c.rpc<Run[]>('runs', { sessionId: s.id }))[0].id, live.id);
  assert.equal((await c.rpc<Attachment>('attach', { sessionId: s.id })).run!.pid, live.pid);
  await c.rpc('stop', { sessionId: s.id });
  await until(async () => (await c.rpc<State>('state')).sessions.find(item => item.id === s.id)!.latestRun!.status === 'stopped');
  await c.rpc('clearFinishedRuns', { sessionId: s.id });
  assert.deepEqual(await c.rpc('runs', { sessionId: s.id }), []);
  assert.equal((await c.rpc<Attachment>('attach', { sessionId: s.id })).run, null);
  assert.equal((await c.rpc<Attachment>('attach', { sessionId: other.id })).run!.id, otherRun.id);
  assert.ok((await c.rpc<string>('output', { runId: otherRun.id })).includes('OTHER_READY'));
});
