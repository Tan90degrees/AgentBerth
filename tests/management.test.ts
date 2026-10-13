import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/daemon/store';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { DEFAULT_SETTINGS, type Attachment, type Project, type Run, type Session, type Settings, type State } from '../src/shared/protocol';
import { shell, resolveTerminal } from '../src/daemon/paths';
import { matchesProject } from '../src/daemon/history';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean>) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await wait(60); }
  throw new Error('Condition did not become true');
}

test('transcript directories accept canonical aliases but reject other and relative directories', async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-path-alias-'));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }));
  const real = path.join(folder, 'project'); mkdirSync(real);
  const alias = path.join(folder, 'alias'); symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await matchesProject(alias, realpathSync(real)), true);
  assert.equal(await matchesProject(folder, realpathSync(folder)), true);
  assert.equal(await matchesProject(folder, real), false);
  assert.equal(await matchesProject('.', real), false);
});

test('Bash profile starts inside the project and preserves inherited executable lookup', { timeout: 15000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-bash-project-'));
  const server = new DaemonServer(path.join(folder, 'data'));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await connection.rpc<Project>('createProject', { name: 'bash project', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'bash', agent: 'shell', terminal: { profile: 'bash', executable: '', args: [] } });
  const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 140, rows: 30 });
  await connection.rpc('attach', { sessionId: session.id });
  await connection.rpc('input', { sessionId: session.id, runId: run.id, data: 'printf "BERTH_CWD_%s\\n" "$PWD"; command -v git\r' });
  await eventually(async () => (await connection.rpc<string>('output', { runId: run.id })).includes('BERTH_CWD_'));
  // Wait for actual command output, not merely the input echoed by the PTY.
  const expected = process.platform === 'win32' ? project.path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : project.path;
  await eventually(async () => (await connection.rpc<Attachment>('attach', { sessionId: session.id })).snapshot.includes('BERTH_CWD_' + expected));
  assert.match(await connection.rpc<string>('output', { runId: run.id }), /(?:bin|cmd)\/git/);
});

test('0.1 database migrates without losing projects, transcripts, run screens or IDs', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-migration-'));
  const old = new DatabaseSync(path.join(folder, 'berth.sqlite'));
  old.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,pathKey TEXT UNIQUE NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,agent TEXT NOT NULL,command TEXT NOT NULL,nativeSessionId TEXT,transcriptPath TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,history TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id),pid INTEGER,status TEXT NOT NULL,startedAt TEXT NOT NULL,endedAt TEXT,exitCode INTEGER,command TEXT NOT NULL,error TEXT,snapshot TEXT NOT NULL DEFAULT '',seq INTEGER NOT NULL DEFAULT 0,cols INTEGER NOT NULL DEFAULT 100,rows INTEGER NOT NULL DEFAULT 30);
    PRAGMA user_version=1;`);
  const projectId = randomUUID(), sessionId = randomUUID(), runId = randomUUID();
  const history = { nativeSessionId: 'old-native-id', path: 'old.jsonl', messages: [{ role: 'user', text: '旧版对话', timestamp: null }], warnings: [] };
  old.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(projectId, '旧项目', folder, folder, '2026-01-01');
  old.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(sessionId, projectId, '旧会话', 'codex', '', history.nativeSessionId, history.path, '2026-01-01', '2026-01-01', 0, JSON.stringify(history));
  old.prepare('INSERT INTO runs(id,sessionId,status,startedAt,command,snapshot,seq) VALUES(?,?,?,?,?,?,?)').run(runId, sessionId, 'exited', '2026-01-01', 'codex', 'old-screen', 7);
  old.close();
  let store = new Store(folder);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  assert.equal(store.project(projectId).name, '旧项目');
  assert.equal(store.session(sessionId).terminal, null);
  assert.deepEqual(store.history(sessionId), history);
  assert.equal(store.run(runId).shell, '');
  assert.equal(store.savedScreen(runId).snapshot, 'old-screen');
  assert.deepEqual(store.settings(), DEFAULT_SETTINGS);
  const config: Settings = { defaultAgent: 'opencode', fontSize: 18, terminal: { profile: 'custom', executable: shell().file, args: shell().args } };
  store.saveSettings(config);
  store.updateSession(sessionId, '编辑后', 'codex', '', config.terminal);
  store.close(); store = new Store(folder);
  assert.deepEqual(store.settings(), config);
  assert.equal(store.session(sessionId).nativeSessionId, history.nativeSessionId);
  assert.deepEqual(store.session(sessionId).terminal, config.terminal);
});

test('editing keeps prior runs and clears incompatible native links; deletion cascades all runs and archived sessions', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-crud-'));
  const store = new Store(folder);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = store.createProject('one', folder);
  const other = store.createProject('two', path.join(folder, 'two'));
  const session = store.createSession(project.id, 'chat', 'codex', '');
  store.saveHistory(session.id, { nativeSessionId: 'codex-native', path: 'rollout.jsonl', messages: [], warnings: [] });
  const run = store.createRun(session.id, 'codex', 100, 30, '/shell-original');
  store.finish(run.id, 'exited', 0, null, 'old output', 1, 100, 30);
  store.updateSession(session.id, 'edited', 'opencode', '', null);
  assert.equal(store.session(session.id).nativeSessionId, null);
  assert.equal(store.run(run.id).command, 'codex');
  assert.equal(store.run(run.id).shell, '/shell-original');
  store.saveHistory(session.id, { nativeSessionId: 'ses_123', path: 'session.json', messages: [], warnings: [] });
  assert.throws(() => store.updateProject(project.id, 'bad', other.path), /另一个项目/);
  assert.equal(store.project(project.id).name, 'one');
  assert.equal(store.session(session.id).nativeSessionId, 'ses_123');
  store.updateProject(project.id, 'moved', path.join(folder, 'moved'));
  assert.equal(store.history(session.id).nativeSessionId, null);
  const archived = store.createSession(project.id, 'archived', 'shell', '');
  store.archive(archived.id);
  for (let n = 0; n < 110; n++) store.createRun(archived.id, '', 80, 24);
  assert.equal(store.deleteSession(session.id).length, 1);
  assert.throws(() => store.run(run.id), /不存在/);
  assert.equal(store.deleteProject(project.id).length, 110);
  assert.throws(() => store.session(archived.id), /不存在/);
  assert.equal(store.state().projects[0].id, other.id);
});

test('management protects running and starting PTYs, applies shell defaults only to new runs and deletes only workbench data', { timeout: 20000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-management-'));
  const moved = path.join(folder, 'moved'); mkdirSync(moved);
  const projectFile = path.join(folder, 'keep.txt'); writeFileSync(projectFile, 'keep');
  const server = new DaemonServer(path.join(folder, 'data'));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await connection.rpc<Project>('createProject', { name: 'project', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'chat', agent: 'shell' });
  const [started, deleted] = await Promise.allSettled([connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 }), connection.rpc('deleteSession', { sessionId: session.id })]);
  assert.equal(started.status, 'fulfilled'); assert.equal(deleted.status, 'rejected');
  const run = (started as PromiseFulfilledResult<Run>).value;
  await assert.rejects(connection.rpc('deleteProject', { projectId: project.id }), /停止终端/);
  await assert.rejects(connection.rpc('updateProject', { projectId: project.id, name: 'moved', path: moved }), /停止终端/);
  await assert.rejects(connection.rpc('updateSession', { sessionId: session.id, title: 'chat', agent: 'opencode' }), /停止终端/);
  await assert.rejects(connection.rpc('shutdownIdle'), /停止全部终端/);
  await connection.rpc('updateProject', { projectId: project.id, name: 'renamed', path: folder });
  await connection.rpc('updateSession', { sessionId: session.id, title: 'renamed session', agent: 'shell' });
  const selected = shell();
  await connection.rpc('saveSettings', { ...DEFAULT_SETTINGS, defaultAgent: 'opencode', fontSize: 18, terminal: { profile: 'custom', executable: selected.file, args: selected.args } });
  assert.equal((await connection.rpc<Attachment>('attach', { sessionId: session.id })).run!.pid, run.pid);
  await connection.rpc('input', { sessionId: session.id, runId: run.id, data: 'echo LOG_DELETE_CHECK\r' });
  await eventually(async () => (await connection.rpc<string>('output', { runId: run.id })).includes('LOG_DELETE_CHECK'));
  const logFile = path.join(folder, 'data', 'logs', run.id + '.log'); assert.ok(existsSync(logFile));
  await connection.rpc('stop', { sessionId: session.id });
  await eventually(async () => (await connection.rpc<State>('state')).sessions[0].latestRun?.status === 'stopped');
  const second = await connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 });
  assert.equal(second.shell, (await resolveTerminal({ profile: 'custom', executable: selected.file, args: selected.args })).file);
  await connection.rpc('stop', { sessionId: session.id });
  await eventually(async () => (await connection.rpc<State>('state')).sessions[0].latestRun?.status === 'stopped');
  await connection.rpc('deleteSession', { sessionId: session.id });
  assert.equal(existsSync(logFile), false); assert.ok(existsSync(projectFile));
  await connection.rpc('deleteProject', { projectId: project.id });
  assert.equal((await connection.rpc<State>('state')).projects.length, 0); assert.ok(existsSync(projectFile));
  await assert.rejects(connection.rpc('saveSettings', { ...DEFAULT_SETTINGS, terminal: { profile: 'custom', executable: path.join(folder, 'missing-shell'), args: [] } }), /找不到终端/);
  assert.equal((await connection.rpc<State>('state')).settings.defaultAgent, 'opencode');
});
