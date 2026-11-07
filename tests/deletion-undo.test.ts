import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/daemon/store';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { DeletionUndo, Project, Run, Session, State } from '../src/shared/protocol';

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'berth-undo-'));
const remove = (folder: string) => rmSync(folder, { recursive: true, force: true, maxRetries: 5 });

test('undo restores a session with its id, native link and run records intact', t => {
  const folder = temp();
  const store = new Store(folder);
  t.after(() => { store.close(); remove(folder); });
  const project = store.createProject('one', folder);
  const session = store.createSession(project.id, 'chat', 'codex', '');
  store.saveHistory(session.id, { nativeSessionId: 'ses_native', path: 'rollout.jsonl', messages: [], warnings: [] });
  const run = store.createRun(session.id, 'codex', 100, 30, '/bin/bash');
  store.finish(run.id, 'exited', 0, null, 'old output', 1, 100, 30);

  const { runIds, undo } = store.deleteSessionWithUndo(session.id);
  assert.deepEqual(runIds, [run.id]);
  assert.equal(undo.kind, 'session');
  assert.equal(undo.sessionId, session.id);
  assert.equal(undo.label, 'chat');
  assert.throws(() => store.session(session.id), /不存在/);
  assert.deepEqual(store.undoRunIds(), [run.id], 'deleted run logs must stay protected');

  const restored = store.restoreDeletion(undo.token);
  assert.equal(restored.sessionId, session.id);
  assert.equal(store.session(session.id).title, 'chat');
  assert.equal(store.session(session.id).nativeSessionId, 'ses_native');
  assert.equal(store.history(session.id).path, 'rollout.jsonl');
  assert.equal(store.run(run.id).shell, '/bin/bash');
  assert.equal(store.undoRunIds().length, 0);
  assert.throws(() => store.restoreDeletion(undo.token), /已过期或已使用/);
});

test('undo restores a whole project and refuses to overwrite a re-added directory', t => {
  const folder = temp();
  const store = new Store(folder);
  t.after(() => { store.close(); remove(folder); });
  const project = store.createProject('main', folder);
  const first = store.createSession(project.id, 'first', 'shell', '');
  const archived = store.createSession(project.id, 'archived', 'shell', '');
  store.archive(archived.id);
  const run = store.createRun(first.id, '', 80, 24);

  const { undo } = store.deleteProjectWithUndo(project.id);
  assert.equal(undo.kind, 'project');
  assert.equal(undo.projectId, project.id);
  assert.equal(store.state().projects.length, 0);
  assert.throws(() => store.session(first.id), /不存在/);

  const replacement = store.createProject('again', folder);
  assert.throws(() => store.restoreDeletion(undo.token), /已重新添加/);
  assert.equal(store.state().projects.length, 1, 'a refused undo must not touch live data');

  store.deleteProject(replacement.id);
  store.restoreDeletion(undo.token);
  assert.equal(store.project(project.id).name, 'main');
  assert.equal(store.session(first.id).title, 'first');
  assert.equal(store.session(archived.id).title, 'archived', 'archived sessions are restored too');
  assert.equal(store.run(run.id).sessionId, first.id);
});

test('undo refuses a session whose project has since been deleted', t => {
  const folder = temp();
  const store = new Store(folder);
  t.after(() => { store.close(); remove(folder); });
  const project = store.createProject('main', folder);
  const session = store.createSession(project.id, 'orphan', 'shell', '');
  const { undo } = store.deleteSessionWithUndo(session.id);
  store.deleteProject(project.id);
  assert.throws(() => store.restoreDeletion(undo.token), /所属项目已被删除/);
  assert.throws(() => store.session(session.id), /不存在/);
});

test('stale snapshots are pruned by age and count, releasing only unprotected logs', t => {
  const folder = temp();
  const store = new Store(folder);
  t.after(() => { store.close(); remove(folder); });
  const project = store.createProject('main', folder);
  const runIds: string[] = [], tokens: string[] = [];
  for (let n = 0; n < 12; n++) {
    const session = store.createSession(project.id, 'session-' + n, 'shell', '');
    const run = store.createRun(session.id, '', 80, 24);
    const { undo } = store.deleteSessionWithUndo(session.id);
    runIds.push(run.id); tokens.push(undo.token);
  }
  const purged = store.pruneDeletions();
  assert.deepEqual(purged.sort(), runIds.slice(0, 2).sort(), 'only the two oldest receipts are dropped');
  assert.equal(store.undoRunIds().length, 10);
  assert.throws(() => store.restoreDeletion(tokens[0]), /已过期或已使用/);
  assert.doesNotThrow(() => store.restoreDeletion(tokens[11]));

  const expired = store.pruneDeletions(Date.now() + 31 * 60 * 1000);
  assert.equal(expired.length, 9);
  assert.equal(store.undoRunIds().length, 0);
  assert.deepEqual(store.pruneDeletions(), []);
});

test('an expired receipt is refused even when no further deletion triggered a prune', t => {
  const folder = temp();
  const store = new Store(folder);
  t.after(() => { store.close(); remove(folder); });
  const project = store.createProject('main', folder);
  const session = store.createSession(project.id, 'shell', 'shell', '');
  const { undo } = store.deleteSessionWithUndo(session.id);
  // A daemon that stays open for hours without another delete still has the
  // row, but its 30-minute window is over and the logs are no longer protected.
  const db = new DatabaseSync(path.join(folder, 'berth.sqlite'));
  db.prepare('UPDATE deletions SET deletedAt = ? WHERE token = ?')
    .run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), undo.token);
  db.close();
  assert.throws(() => store.restoreDeletion(undo.token), /撤销时间已过/);
  assert.throws(() => store.session(session.id), /不存在/);
  assert.deepEqual(store.undoRunIds(), [], 'an expired receipt must not keep protecting logs');
  assert.deepEqual(store.pruneDeletions(), []);
  assert.throws(() => store.restoreDeletion(undo.token), /已过期或已使用/);
});

test('delete RPCs return an undo receipt and restoreDeleted republishes the exact session', async t => {
  const folder = temp();
  const server = new DaemonServer(path.join(folder, 'data'));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); remove(folder); });
  const project = await connection.rpc<Project>('createProject', { name: 'rpc', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'rpc session', agent: 'shell' });

  const undo = await connection.rpc<DeletionUndo>('deleteSession', { sessionId: session.id });
  assert.equal(undo.kind, 'session');
  assert.equal(undo.sessionId, session.id);
  assert.equal((await connection.rpc<State>('state')).sessions.length, 0);

  const restored = await connection.rpc<DeletionUndo>('restoreDeleted', { token: undo.token });
  assert.equal(restored.label, 'rpc session');
  const state = await connection.rpc<State>('state');
  assert.equal(state.sessions.some(item => item.id === session.id && item.title === 'rpc session'), true);
  await assert.rejects(connection.rpc('restoreDeleted', { token: undo.token }), /已过期或已使用/);
});

test('restoreDeleted RPC expires stale receipts before touching live data', async t => {
  const folder = temp();
  const server = new DaemonServer(path.join(folder, 'data'));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); remove(folder); });
  const project = await connection.rpc<Project>('createProject', { name: 'rpc', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'expired', agent: 'shell' });
  const undo = await connection.rpc<DeletionUndo>('deleteSession', { sessionId: session.id });
  const db = new DatabaseSync(path.join(folder, 'data', 'berth.sqlite'));
  db.prepare('UPDATE deletions SET deletedAt = ? WHERE token = ?')
    .run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), undo.token);
  db.close();
  await assert.rejects(connection.rpc('restoreDeleted', { token: undo.token }), /已过期或已使用|撤销时间已过/);
  assert.equal((await connection.rpc<State>('state')).sessions.length, 0, 'an expired undo must not resurrect the session');
});

test('run deletions snapshot every column and restore both single and batch removals', t => {
  const folder = temp();
  const store = new Store(folder);
  t.after(() => { store.close(); remove(folder); });
  const project = store.createProject('main', folder);
  const session = store.createSession(project.id, 'shell', 'shell', '');
  const first = store.createRun(session.id, '', 100, 30, '/bin/bash');
  store.finish(first.id, 'exited', 0, null, 'saved screen', 7, 100, 30);
  const second = store.createRun(session.id, '', 90, 24);
  store.finish(second.id, 'failed', 1, 'boom', '', 2, 90, 24);

  const single = store.deleteRunWithUndo(first.id)!;
  assert.equal(single.kind, 'runs');
  assert.equal(single.label, `运行 ${first.id.slice(0, 8)}`);
  assert.equal(single.sessionId, session.id);
  assert.equal(single.projectId, project.id);
  assert.deepEqual(single.runIds, [first.id]);
  assert.throws(() => store.run(first.id), /不存在/);
  assert.deepEqual(store.undoRunIds(), [first.id], 'a deleted run log must stay protected');

  const restored = store.restoreDeletion(single.token);
  assert.deepEqual(restored.runIds, [first.id]);
  assert.equal(store.run(first.id).shell, '/bin/bash');
  assert.equal(store.run(first.id).exitCode, 0);
  assert.equal(store.savedScreen(first.id).snapshot, 'saved screen');
  assert.equal(store.savedScreen(first.id).seq, 7);
  assert.equal(store.savedScreen(first.id).cols, 100);
  assert.deepEqual(store.undoRunIds(), []);
  assert.throws(() => store.restoreDeletion(single.token), /已过期或已使用/);

  const batch = store.clearFinishedRunsWithUndo(session.id)!;
  assert.equal(batch.kind, 'runs');
  assert.equal(batch.label, '2 条运行记录');
  assert.deepEqual(new Set(batch.runIds), new Set([first.id, second.id]));
  assert.deepEqual(store.runs(session.id), []);
  assert.equal(store.undoRunIds().length, 2);
  assert.equal(store.clearFinishedRunsWithUndo(session.id), null, 'nothing to delete means no receipt');

  store.restoreDeletion(batch.token);
  assert.deepEqual(new Set(store.runs(session.id).map(run => run.id)), new Set([first.id, second.id]));
  assert.equal(store.run(second.id).error, 'boom');
  assert.equal(store.savedScreen(second.id).rows, 24);
  assert.deepEqual(store.undoRunIds(), []);
});

test('run undo refuses to overwrite a recreated row or an orphaned session', t => {
  const folder = temp();
  const store = new Store(folder);
  t.after(() => { store.close(); remove(folder); });
  const project = store.createProject('main', folder);
  const session = store.createSession(project.id, 'shell', 'shell', '');
  const run = store.createRun(session.id, '', 80, 24);
  store.finish(run.id, 'exited', 0, null, '', 1, 80, 24);
  const undo = store.deleteRunWithUndo(run.id)!;

  // Simulate a freshly started run reusing the same id.
  const db = new DatabaseSync(path.join(folder, 'berth.sqlite'));
  db.prepare('INSERT INTO runs (id, sessionId, status, startedAt, command, cols, rows, shell) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(run.id, session.id, 'exited', new Date().toISOString(), 'fresh', 80, 24, '');
  db.close();
  assert.throws(() => store.restoreDeletion(undo.token), /已重新创建/);
  assert.equal(store.run(run.id).command, 'fresh', 'a refused undo must not replace live data');

  store.deleteRun(run.id);
  store.deleteSession(session.id);
  assert.throws(() => store.restoreDeletion(undo.token), /所属会话已被删除/);
  assert.throws(() => store.run(run.id), /不存在/);
});

test('run deletion RPCs return receipts and the output log stays readable after undo', { timeout: 20000 }, async t => {
  const folder = temp();
  const server = new DaemonServer(path.join(folder, 'data'));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); remove(folder); });
  const project = await connection.rpc<Project>('createProject', { name: 'rpc', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'shell', agent: 'shell' });
  const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 });
  await connection.rpc('attach', { sessionId: session.id });
  await connection.rpc('stop', { sessionId: session.id });
  const deadline = Date.now() + 6000;
  while (!['stopped', 'exited', 'failed', 'interrupted'].includes((await connection.rpc<State>('state')).sessions[0].latestRun?.status ?? '')) {
    assert.ok(Date.now() < deadline, 'Terminal did not stop');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const log = path.join(folder, 'data', 'logs', run.id + '.log');
  writeFileSync(log, 'KEPT_FOR_UNDO');

  const undo = await connection.rpc<DeletionUndo>('deleteRun', { runId: run.id });
  assert.equal(undo.kind, 'runs');
  assert.equal(readFileSync(log, 'utf8'), 'KEPT_FOR_UNDO');
  await assert.rejects(connection.rpc('output', { runId: run.id }), /不存在/);

  const restored = await connection.rpc<DeletionUndo>('restoreDeleted', { token: undo.token });
  assert.deepEqual(restored.runIds, [run.id]);
  assert.equal(await connection.rpc<string>('output', { runId: run.id }), 'KEPT_FOR_UNDO');

  const batch = await connection.rpc<DeletionUndo>('clearFinishedRuns', { sessionId: session.id });
  assert.equal(batch.label, '1 条运行记录');
  assert.deepEqual(await connection.rpc<Run[]>('runs', { sessionId: session.id }), []);
  await connection.rpc('restoreDeleted', { token: batch.token });
  assert.equal((await connection.rpc<Run[]>('runs', { sessionId: session.id })).length, 1);
  assert.equal(await connection.rpc<string>('output', { runId: run.id }), 'KEPT_FOR_UNDO');
});

test('restoring an older run preserves chronology and cannot hide a newer live terminal',t=>{
  const folder=temp(),store=new Store(folder);t.after(()=>{store.close();remove(folder);});
  const project=store.createProject('order',folder),session=store.createSession(project.id,'shell','shell','');
  const first=store.createRun(session.id,'first',80,24);store.finish(first.id,'exited',0,null,'first',1,80,24);
  const second=store.createRun(session.id,'second',80,24);store.finish(second.id,'exited',0,null,'second',1,80,24);
  const undo=store.deleteRunWithUndo(first.id)!;store.restoreDeletion(undo.token);
  assert.deepEqual(store.runs(session.id).map(run=>run.id),[second.id,first.id]);assert.equal(store.session(session.id).latestRun?.id,second.id);
  const newest=store.deleteRunWithUndo(second.id)!,live=store.createRun(session.id,'live',80,24);store.restoreDeletion(newest.token);
  assert.equal(store.session(session.id).latestRun?.id,live.id);assert.equal(store.state().sessions[0].latestRun?.status,'running');assert.deepEqual(store.runs(session.id).map(run=>run.id),[live.id,second.id,first.id]);
});

test('new runs reserve deleted row positions across empty tables and out-of-order project restores',t=>{
  const folder=temp(),store=new Store(folder);t.after(()=>{store.close();remove(folder);});
  const project=store.createProject('deleted',folder),session=store.createSession(project.id,'old','shell',''),old=store.createRun(session.id,'old',80,24);store.finish(old.id,'exited',0,null,'old',1,80,24);
  const undo=store.deleteProjectWithUndo(project.id).undo,other=store.createProject('new',path.join(folder,'new')),current=store.createSession(other.id,'new','shell',''),newRun=store.createRun(current.id,'new',80,24);
  store.restoreDeletion(undo.token);assert.equal(store.session(current.id).latestRun?.id,newRun.id);assert.equal(store.session(session.id).latestRun?.id,old.id);
  const db=new DatabaseSync(path.join(folder,'berth.sqlite'));try{assert.ok(Number(db.prepare('SELECT rowid FROM runs WHERE id=?').get(newRun.id)!.rowid)>Number(db.prepare('SELECT rowid FROM runs WHERE id=?').get(old.id)!.rowid));}finally{db.close();}
});
