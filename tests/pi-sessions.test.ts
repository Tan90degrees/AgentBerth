import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DaemonServer } from '../src/daemon/server';
import { Store } from '../src/daemon/store';
import { DaemonConnection } from '../src/main/connection';
import { AcpTransport } from '../src/daemon/acp-transport';
import { discoverPiSessions, piLaunchCommand, piResumeCommand, piSessionFile, piSessionRoot, readPiHistory } from '../src/daemon/pi-sessions';
import type { History, NativeHistoryPage, Project, Session, State } from '../src/shared/protocol';
import { shouldResume } from '../src/daemon/recovery';

const session = (id: string, cwd: string, version = 3) => ({ type: 'session', version, id, cwd });
const message = (id: string, parentId: string | null, role: string, content: unknown) => ({ type: 'message', id, parentId, message: { role, content } });
const lines = (values: unknown[]) => values.map(value => JSON.stringify(value)).join('\r\n') + '\r\n';

test('Pi discovery uses workspace headers, honors location overrides and reads only the persisted branch', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'berth pi 中文 '));
  t.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5 }));
  const project = await realpath(tmp), root = piSessionRoot(project, tmp, {});
  assert.equal(root, path.join(tmp, '.pi', 'agent', 'sessions', '--' + project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'));
  assert.equal(piSessionRoot(project, tmp, { PI_CODING_AGENT_SESSION_DIR: '~/overridden' }), path.join(tmp, 'overridden'));
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'pi-sample_native-pi.jsonl');
  await writeFile(file, lines([
    session('native-pi', project),
    message('first', null, 'user', '中文\u2028原样'),
    message('discarded', 'first', 'assistant', '另一条分支'),
    message('tool', 'first', 'toolResult', '内部结果'),
    { type: 'compaction', id: 'compact', parentId: 'tool', summary: '模型内部摘要' },
    message('second', 'compact', 'assistant', [{ type: 'thinking', thinking: '私有推理' }, { type: 'text', text: '继续' }]),
    { type: 'session_info', id: 'name', parentId: 'second', name: '我的 Pi 会话' },
  ]));
  await writeFile(path.join(root, 'foreign.jsonl'), lines([session('foreign', path.join(project, 'other'))]));
  await writeFile(path.join(root, 'bad.jsonl'), lines([{ type: 'message', id: 'bad', cwd: project }]));
  const candidates = await discoverPiSessions(project, tmp, {});
  assert.deepEqual(candidates.map(({ nativeSessionId, title }) => ({ nativeSessionId, title })), [{ nativeSessionId: 'native-pi', title: '我的 Pi 会话' }]);
  assert.equal((await discoverPiSessions(project, tmp, {}, 'native-pi')).length, 1);
  assert.equal((await discoverPiSessions(project, tmp, {}, 'foreign')).length, 0);
  const old = await readFile(file, 'utf8');
  const history = await readPiHistory(file, project, true);
  assert.deepEqual(history.messages.map(({ text }) => text), ['中文\u2028原样', '继续']);
  assert.equal(await readFile(file, 'utf8'), old);
  await assert.rejects(piSessionFile(file, path.join(project, 'elsewhere')), /工作区不一致/);
});

test('Pi preview bounds do not apply to full history and legacy linear records still import', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'berth-pi-full-'));
  t.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(tmp, 'legacy.jsonl');
  await writeFile(file, lines([session('legacy', tmp, 1),
    ...Array.from({ length: 1001 }, (_, i) => ({ type: 'message', message: { role: 'user', content: 'msg ' + i } })),
    message('long', null, 'assistant', '字'.repeat(50000)),
  ]));
  const [preview, full] = await Promise.all([readPiHistory(file, tmp), readPiHistory(file, tmp, true)]);
  assert.equal(preview.messages.length, 1000);
  assert.equal(preview.messages.at(-1)?.text.length, 32768);
  assert.equal(full.messages.length, 1002);
  assert.equal(full.messages.at(-1)?.text.length, 50000);
  assert.equal(full.messages[0].text, 'msg 0');
  assert.equal(piResumeCommand('pwsh', file, 'linux'), 'pi --session "$env:AGENTBERTH_PI_SESSION_FILE"');
  assert.match(piResumeCommand('powershell.exe', file, 'win32'), /Get-Command pi\.cmd.*--session "\$env:AGENTBERTH_PI_SESSION_FILE"$/);
  assert.match(piLaunchCommand('powershell.exe', 'fresh', 'win32'), /Get-Command pi\.cmd.*--session-id fresh$/);
  assert.equal(piResumeCommand('/bin/bash', file), 'pi --session "$AGENTBERTH_PI_SESSION_FILE"');
  assert.throws(() => piResumeCommand('cmd.exe', 'C:\\unsafe!\\file.jsonl'), /安全续接/);
});

test('Pi terminal and ACP are registered and native history reaches normal RPC entry points', { timeout: 20000 }, async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'berth-pi-rpc-'));
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  const root = path.join(tmp, 'native');
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  });
  const data = path.join(tmp, 'data');
  const legacy = new Store(data);
  const existing = legacy.saveAgent({ name: 'Pi', command: 'legacy-pi', resumeCommand: '', plugin: null });
  legacy.close();
  const backend = new DaemonServer(data);
  const client = await DaemonConnection.open(await backend.listen(), () => {});
  t.after(async () => {
    client.close();
    await backend.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });
  const state = await client.rpc<State>('state');
  const tui = state.agents?.find(agent => agent.id === 'pi');
  assert.equal(tui?.command, 'pi');
  assert.equal(tui?.name, 'Pi · 内置');
  assert.equal(state.agents?.find(agent => agent.id === existing.id)?.command, 'legacy-pi');
  assert.equal(tui?.skills?.project, '.pi/skills');
  assert.equal(state.agents?.find(agent => agent.name === 'Pi (ACP)')?.acp?.executable, 'openma-pi-acp');
  const project = await client.rpc<Project>('createProject', { name: 'Pi', path: tmp });
  const item = await client.rpc<Session>('createSession', { projectId: project.id, agent: 'pi', title: 'Pi 会话', command: '' });
  assert.equal(item.agent, 'pi');
  await mkdir(root);
  const file = path.join(root, 'existing.jsonl');
  await writeFile(file, lines([session('existing', project.path), message('a', null, 'user', '完整原生记录')]));
  const list = await client.rpc<NativeHistoryPage>('discoverNativeHistories', { sessionId: item.id, cursor: null, limit: 5, query: '' });
  assert.equal(list.items[0].nativeSessionId, 'existing');
  await client.rpc('linkNativeSession', { sessionId: item.id, nativeSessionId: 'existing' });
  const history = await client.rpc<History>('history', { sessionId: item.id, full: true });
  assert.equal(history.messages[0].text, '完整原生记录');
  assert.ok(shouldResume({ ...item, nativeSessionId: 'existing' }));
});

const liveInstall = process.env.AGENTBERTH_PI_TEST_DIRECTORY;
test('installed Pi ACP negotiates managed workspace support without calling a model', { skip: !liveInstall, timeout: 30000 }, async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'berth-pi-acp-'));
  t.after(() => rm(work, { recursive: true, force: true, maxRetries: 5 }));
  const modules = path.join(liveInstall!, 'node_modules');
  const agentDir = path.join(work, 'pi');
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { fixture: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'local-test',
      models: [{ id: 'fixture-model' }] } },
  }));
  const transport = await AcpTransport.open({
    executable: 'node',
    args: [path.join(modules, '@openma', 'pi-acp', 'dist', 'bin.js'), '--agent-dir', agentDir, '--model', 'fixture/fixture-model'],
    env: { PI_ACP_DELEGATION: '1' }, startupTimeoutMs: 20000,
  }, work, async () => { throw new Error('Connection probe may not use tools'); }, () => {}, () => {});
  try {
    const info = await transport.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, elicitation: { form: {} } },
    });
    assert.equal(info.protocolVersion, 1);
    assert.equal(info.agentCapabilities.loadSession, true);
    assert.ok(Object.hasOwn(info.agentCapabilities.sessionCapabilities, 'additionalDirectories'));
    assert.deepEqual(info.agentCapabilities._meta.pi.delegation, { readTextFile: true, writeTextFile: true, terminal: false });
    const created = await transport.call('session/new', { cwd: work, mcpServers: [], additionalDirectories: [] });
    assert.equal(typeof created.sessionId, 'string');
    assert.equal(created._meta.pi.additionalDirectoriesEnforced, true);
    await transport.call('session/close', { sessionId: created.sessionId });
  } finally { await transport.stop(); }
});
