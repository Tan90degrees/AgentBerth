import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { connectDaemon, DaemonConnection, stopIdleDaemon } from '../src/main/connection';
import { Store } from '../src/daemon/store';
import { API_VERSION, DEFAULT_SETTINGS, type Attachment, type History, type RuntimeInfo, type State } from '../src/shared/protocol';

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
  assert.equal(upgraded.apiVersion, API_VERSION);
  assert.equal(upgraded.sessions[0].id, run.sessionId);
  assert.equal(upgraded.sessions[0].latestRun!.status, 'stopped');
});


test('combined build replaces an idle legacy Wiki daemon and retains the Pi database', { timeout: 30000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-pi-upgrade-'));
  const data = path.join(folder, 'data'), database = new Store(data);
  const project = database.createProject('已有项目', folder);
  database.saveAgent({ name: 'Pi', command: 'pi', integration: 'pi', resumeCommand: '', plugin: null }, 'pi');
  database.saveSettings({ ...DEFAULT_SETTINGS, defaultAgent: 'pi', fontSize: 19 });
  const session = database.createSession(project.id, '已有 Pi 会话', 'pi', '');
  const history: History = { nativeSessionId: 'pi-native-id', path: null, messages: [{ role: 'user', text: '已保存的历史', timestamp: null }], warnings: [] };
  database.saveHistory(session.id, history);
  database.close();

  const legacy = fork(path.resolve('tests/fixtures/legacy-pi-daemon.cjs'), [data, '--busy'], {
    silent: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let connection: DaemonConnection | undefined;
  t.after(async () => {
    if (connection) { try { await stopIdleDaemon(data); } finally { connection.close(true); } }
    if (legacy.exitCode === null && legacy.signalCode === null) { const exit = once(legacy, 'exit'); legacy.kill(); await exit; }
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assert.equal((await once(legacy, 'message'))[0], 'ready');
  const askLegacy = async (message: string) => {
    const reply = once(legacy, 'message');
    legacy.send(message);
    assert.equal((await reply)[0], message);
  };
  const connect = () => connectDaemon(data, path.resolve('dist/daemon.cjs'), process.execPath, () => {});
  await assert.rejects(connect(), /先停止全部终端和 ACP 会话/);
  assert.equal(legacy.exitCode, null, 'a busy legacy daemon must stay running');
  await askLegacy('idle');
  await askLegacy('unrelated-error');
  await assert.rejects(connect(), /"option"/);
  assert.equal(legacy.exitCode, null, 'an unrelated validation error must not restart the daemon');
  await askLegacy('integration-error');

  connection = await connect();
  const upgraded = await connection.rpc<State>('state');
  assert.equal(upgraded.apiVersion, API_VERSION);
  assert.equal(upgraded.settings.defaultAgent, 'pi');
  assert.equal(upgraded.settings.fontSize, 19);
  assert.equal(upgraded.agents?.find(agent => agent.id === 'pi')?.integration, 'pi');
  assert.ok(upgraded.agents?.some(agent => agent.name === 'Pi (ACP)'));
  assert.equal(upgraded.sessions.find(item => item.id === session.id)?.nativeSessionId, history.nativeSessionId);
  assert.deepEqual(await connection.rpc<History>('history', { sessionId: session.id }), history);
  const wiki = await connection.rpc<{ ready: boolean }>('extensions', { request: { action: 'call', id: 'notes-wiki', command: 'status', params: {} } });
  assert.equal(typeof wiki.ready, 'boolean');
});
