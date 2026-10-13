import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/daemon/store';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { DEFAULT_SETTINGS, type Project, type Run, type Session, type State } from '../src/shared/protocol';
import { loadSelections, loadSettingsDraft, readStored, saveStored } from '../src/renderer/storage';
import { matchesQuery } from '../src/renderer/QuickSwitcher';

test('unavailable/corrupt UI storage falls back safely and validated drafts keep terminal arguments intact', () => {
  const unavailable = { getItem() { throw new Error('cache denied'); }, setItem() { throw new Error('cache full'); }, removeItem() { throw new Error('cache denied'); } };
  assert.equal(readStored('berth.project', unavailable), null);
  assert.doesNotThrow(() => saveStored('berth.project', 'value', unavailable));
  assert.doesNotThrow(() => saveStored('berth.project', null, unavailable));
  assert.deepEqual(loadSelections(unavailable), {}); assert.equal(loadSettingsDraft(unavailable), null);
  const projectId = randomUUID(), sessionId = randomUUID();
  const data = new Map([
    ['berth.selections', JSON.stringify({ [projectId]: sessionId, arbitrary: 'not-a-session' })],
    ['berth.settingsDraft', JSON.stringify({ base: DEFAULT_SETTINGS, value: { ...DEFAULT_SETTINGS, fontSize: 19, terminal: { profile: 'custom', executable: '/path with spaces/shell', args: ['-i', 'argument with spaces'] } } })],
  ]);
  const storage = { getItem: (key: string) => data.get(key) ?? null };
  assert.deepEqual(loadSelections(storage), { [projectId]: sessionId });
  assert.deepEqual(loadSettingsDraft(storage)?.value.terminal.args, ['-i', 'argument with spaces']);
  data.set('berth.settingsDraft', '{partial'); assert.equal(loadSettingsDraft(storage), null);
  data.set('berth.settingsDraft', JSON.stringify({ base: DEFAULT_SETTINGS, value: { ...DEFAULT_SETTINGS, fontSize: 100 } }));
  assert.equal(loadSettingsDraft(storage), null);
});

test('workspace search combines words, is case insensitive and matches Windows directory separators', () => {
  const text = '开发项目 OpenCode D:\\Projects\\Agent Berth ses_example';
  assert.ok(matchesQuery(text, ' opencode   d:/projects/agent '));
  assert.ok(matchesQuery(text, '开发 ses_example'));
  assert.equal(matchesQuery(text, 'opencode missing'), false);
});

test('failed directory and shell preflight remain in run history and can be fixed and retried', { timeout: 20000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-launch-feedback-'));
  const projectDirectory = path.join(folder, 'project'); mkdirSync(projectDirectory);
  const data = path.join(folder, 'data');
  const server = new DaemonServer(data);
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await connection.rpc<Project>('createProject', { name: 'project', path: projectDirectory });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'feedback', agent: 'shell' });
  renameSync(projectDirectory, path.join(folder, 'moved'));
  await assert.rejects(connection.rpc('start', { sessionId: session.id, cols: 80, rows: 24 }), /目录不存在或已移动/);
  const failure = (await connection.rpc<State>('state')).sessions[0].latestRun!;
  assert.equal(failure.status, 'failed'); assert.equal(failure.pid, null); assert.match(failure.error!, /编辑项目/);
  await connection.rpc('updateProject', { projectId: project.id, name: 'fixed', path: path.join(folder, 'moved') });
  await connection.rpc('updateSession', { sessionId: session.id, title: 'feedback', agent: 'shell', terminal: { profile: 'custom', executable: path.join(folder, 'missing-shell'), args: [] } });
  await assert.rejects(connection.rpc('start', { sessionId: session.id, cols: 80, rows: 24 }), /找不到终端程序/);
  const failures = await connection.rpc<Run[]>('runs', { sessionId: session.id });
  assert.equal(failures.length, 2); assert.ok(failures.every(run => run.status === 'failed'));
  await connection.rpc('updateSession', { sessionId: session.id, title: 'feedback', agent: 'shell', terminal: null });
  const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 });
  assert.equal(run.status, 'running'); assert.ok(run.pid); assert.notEqual(run.id, failure.id);
  await connection.rpc('stop', { sessionId: session.id });
});

test('failure details survive daemon restart and are not marked interrupted', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-failure-history-'));
  let store = new Store(folder);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = store.createProject('project', folder);
  const session = store.createSession(project.id, 'failed', 'shell', '');
  const run = store.createRun(session.id, '', 80, 24, '/missing/shell');
  store.finish(run.id, 'failed', null, '找不到终端程序；请选择正确路径', '', 0, 80, 24);
  store.close(); store = new Store(folder);
  assert.equal(store.session(session.id).latestRun!.status, 'failed');
  assert.match(store.session(session.id).latestRun!.error!, /请选择正确路径/);
});
