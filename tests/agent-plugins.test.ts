import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/daemon/store';
import { AgentPlugins } from '../src/daemon/plugins';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { agentDefinitionSchema, DEFAULT_SETTINGS, requestSchema, type AgentDefinition, type History, type Project, type Session, type State } from '../src/shared/protocol';

function setup(t: any) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth plugins 中文 '));
  return folder;
}
function adapter(folder: string, body: string): AgentDefinition {
  const file = path.join(folder, 'plugin.cjs');
  writeFileSync(file, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',async()=>{const r=JSON.parse(input);${body}});`);
  return { id: 'agent:67c082df-af5a-4b4c-8b0a-174f0598315c', name: '插件', command: 'echo AGENT_READY', resumeCommand: '', plugin: { executable: process.execPath, args: [file], history: true, resume: true } };
}
const session = { id: '1234', title: '中文会话', agent: 'custom', command: 'echo AGENT_READY', nativeSessionId: 'native-123' } as Session;
const valid = `process.stdout.write(JSON.stringify({version:1,cwd:r.projectPath,nativeSessionId:'native-123',messages:[{role:'user',text:'你好🙂'},{role:'assistant',text:r.session.title}],warnings:[]}));`;

test('multiple Agent types persist with stable IDs and preserve legacy custom settings, sessions and runs', t => {
  const folder = setup(t); let store = new Store(folder); t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = store.createProject('项目', folder);
  const legacy = store.createSession(project.id, '旧会话', 'custom', 'echo LEGACY');
  const run = store.createRun(legacy.id, 'echo LEGACY', 80, 24); store.finish(run.id, 'stopped', 0, null, 'LEGACY', 1, 80, 24);
  store.saveSettings({ ...DEFAULT_SETTINGS, defaultAgent: 'custom', defaultCommand: 'echo OLD_DEFAULT' });
  const a = store.saveAgent({ name: 'Alpha', command: 'echo ALPHA', resumeCommand: 'alpha --session {sessionId}', plugin: null });
  const b = store.saveAgent({ name: 'Beta', command: 'echo BETA', resumeCommand: '', plugin: null });
  const saved = store.createSession(project.id, 'Alpha 会话', a.id, '');
  assert.equal(saved.command, 'echo ALPHA');
  store.saveAgent({ name: 'Alpha renamed', command: 'echo NEXT', resumeCommand: a.resumeCommand, plugin: null }, a.id);
  store.close(); store = new Store(folder);
  assert.equal(store.state().agents!.length, 2);
  assert.equal(store.agent(a.id).name, 'Alpha renamed');
  assert.equal(store.agent(b.id).command, 'echo BETA');
  assert.equal(store.session(saved.id).command, 'echo ALPHA');
  assert.equal(store.session(legacy.id).command, 'echo LEGACY');
  assert.equal(store.session(legacy.id).latestRun!.id, run.id);
  assert.equal(store.settings().defaultCommand, 'echo OLD_DEFAULT');
});

test('Agent definitions enforce naming, reference protection and independent session commands', t => {
  const folder = setup(t); let store = new Store(folder); t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const p = store.createProject('项目', folder);
  const a = store.saveAgent({ name: 'Alpha', command: 'echo ALPHA', resumeCommand: '', plugin: null });
  const b = store.saveAgent({ name: 'Beta', command: 'echo BETA', resumeCommand: '', plugin: null });
  assert.throws(() => store.saveAgent({ name: 'alpha', command: 'x', resumeCommand: '', plugin: null }), /名称/);
  const s = store.createSession(p.id, '保留', a.id, 'echo OVERRIDE');
  store.saveHistory(s.id, { nativeSessionId: 'native-123', path: null, messages: [], warnings: [] });
  store.saveAgent({ name: 'Renamed', command: 'echo NEW', resumeCommand: '', plugin: null }, a.id);
  assert.equal(store.session(s.id).command, 'echo OVERRIDE');
  assert.equal(store.createSession(p.id, '新的', a.id, '').command, 'echo NEW');
  assert.throws(() => store.deleteAgent(a.id), /会话/);
  store.saveSettings({ ...DEFAULT_SETTINGS, defaultAgent: b.id });
  assert.throws(() => store.deleteAgent(b.id), /默认/);
  store.updateSession(s.id, '保留', b.id, '', null);
  assert.equal(store.session(s.id).nativeSessionId, null);
  assert.throws(() => store.createSession(p.id, '不存在', 'agent:67c082df-af5a-4b4c-8b0a-174f0598315c', ''), /不存在/);
  store.close(); store = new Store(folder);
  assert.equal(store.agent(a.id).name, 'Renamed');
  assert.equal(store.settings().defaultAgent, b.id);
  assert.equal(store.state().agents!.length, 2);
  store.saveSettings(DEFAULT_SETTINGS);
  store.deleteSession(s.id); store.deleteAgent(b.id);
  assert.equal(store.state().agents!.length, 1);
});

test('Agent protocol accepts stable custom IDs and rejects multiline commands and invalid resume tokens', () => {
  const id = '67c082df-af5a-4b4c-8b0a-174f0598315c';
  assert.ok(requestSchema.safeParse({ id, method: 'createSession', params: { projectId: id, title: '会话', agent: 'agent:' + id, command: '' } }).success);
  assert.ok(!requestSchema.safeParse({ id, method: 'createSession', params: { projectId: id, title: '会话', agent: 'unknown', command: '' } }).success);
  assert.ok(!agentDefinitionSchema.safeParse({ name: '类型', command: 'a\nb' }).success);
  assert.ok(!agentDefinitionSchema.safeParse({ name: '类型', command: 'a', resumeCommand: 'a {cwd}' }).success);
  assert.ok(!agentDefinitionSchema.safeParse({ name: '类型', command: 'a', resumeCommand: 'a' }).success);
  assert.equal(agentDefinitionSchema.parse({ name: '类型', command: 'a', resumeCommand: '  ' }).resumeCommand, '');
});

test('history plugin receives session context, preserves Unicode and validates directory and native identity', async t => {
  const folder = setup(t); const plugins = new AgentPlugins(); t.after(async () => { await plugins.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const a = adapter(folder, valid);
  const h = await plugins.history(a, session, folder, null);
  assert.deepEqual(h.messages.map(item => item.text), ['你好🙂', '中文会话']); assert.equal(h.path, null);
  await assert.rejects(plugins.history(a, { ...session, nativeSessionId: 'another' }, folder, null), /会话 ID/);
  adapter(folder, valid.replace('cwd:r.projectPath', "cwd:r.projectPath+'other'"));
  await assert.rejects(plugins.history(a, session, folder, null), /工作目录/);
});

test('plugin import preserves selected path, refresh uses linked identity, and recent text stays bounded', async t => {
  const folder = setup(t); const plugins = new AgentPlugins(); t.after(async () => { await plugins.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const file = path.join(folder, '历史.jsonl'); writeFileSync(file, '{}');
  const a = adapter(folder, `process.stdout.write(JSON.stringify({version:1,cwd:r.projectPath,path:'ignored',nativeSessionId:'native-123',messages:Array.from({length:20},(_,i)=>({role:'assistant',text:String(i)+'x'.repeat(32000)}))}));`);
  const h = await plugins.history(a, session, folder, file);
  assert.equal(h.path, realpathSync(file)); assert.equal(h.messages.length, 16); assert.ok(h.warnings.some(item => item.includes('512 KiB')));
  assert.ok(h.messages.at(-1)!.text.startsWith('19'));
});

test('resume plugin and template validate IDs and cannot return multiline commands', async t => {
  const folder = setup(t); const plugins = new AgentPlugins(); t.after(async () => { await plugins.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const a = adapter(folder, `process.stdout.write(JSON.stringify({version:1,command:r.session.command+' --resume '+r.session.nativeSessionId}));`);
  assert.equal(await plugins.resume(a, session, folder), 'echo AGENT_READY --resume native-123');
  assert.equal(await plugins.resume({ ...a, plugin: null, resumeCommand: 'agent --id {sessionId}' }, session, folder), 'agent --id native-123');
  await assert.rejects(plugins.resume(a, { ...session, nativeSessionId: 'x; injected' }, folder), /有效/);
  adapter(folder, `process.stdout.write(JSON.stringify({version:1,command:'echo bad\\nnext'}));`);
  await assert.rejects(plugins.resume(a, session, folder), /单行/);
});

test('malformed, excessive, failed and disabled plugins fail without accepting partial data', async t => {
  const folder = setup(t); const plugins = new AgentPlugins(); t.after(async () => { await plugins.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const a = adapter(folder, `process.stdout.write('not JSON');`);
  await assert.rejects(plugins.history(a, session, folder, null), /JSON/);
  adapter(folder, `process.stdout.write(JSON.stringify({version:2,messages:[]}));`);
  await assert.rejects(plugins.history(a, session, folder, null), /格式/);
  adapter(folder, `process.stdout.write('x'.repeat(3*1024*1024));`);
  await assert.rejects(plugins.history(a, session, folder, null), /2 MiB/);
  adapter(folder, `console.error('PLUGIN_ERROR_DETAIL');process.exitCode=3;`);
  await assert.rejects(plugins.history(a, session, folder, null), /退出码 3：PLUGIN_ERROR_DETAIL/);
  await assert.rejects(plugins.history({ ...a, plugin: null }, session, folder, null), /未启用/);
  await assert.rejects(plugins.history({ ...a, plugin: { ...a.plugin!, executable: 'node' } }, session, folder, null), /完整路径/);
});

test('plugin timeout and shutdown clean up running program and descendants', { timeout: 15000 }, async t => {
  const folder = setup(t); const pidFile = path.join(folder, 'child.pid');
  const a = adapter(folder, `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
  const plugins = new AgentPlugins(2000); t.after(async () => { await plugins.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await assert.rejects(plugins.history(a, session, folder, null), /超时/);
  assert.ok(existsSync(pidFile)); const childPid = Number(readFileSync(pidFile, 'utf8'));
  try { process.kill(childPid, 0); assert.ok(process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${childPid}/stat`, 'utf8'))); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
  const pending = plugins.history(a, session, folder, null); const rejected = assert.rejects(pending, /取消/);
  await new Promise(resolve => setTimeout(resolve, 100)); await plugins.close(); await rejected;
});

test('daemon exposes Agent CRUD, plugin history and resume while retaining prior history on failure', { timeout: 20000 }, async t => {
  const folder = setup(t); const a = adapter(folder, `if(r.method==='history'){${valid}}else process.stdout.write(JSON.stringify({version:1,command:'echo RESUMED_PLUGIN'}));`);
  const server = new DaemonServer(path.join(folder, 'data')); const runtime = await server.listen(); const c = await DaemonConnection.open(runtime, () => {});
  t.after(async () => { c.close(); await server.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const p = await c.rpc<Project>('createProject', { name: '项目', path: folder });
  const { id: _id, ...config } = a;
  const saved = await c.rpc<AgentDefinition>('createAgent', config);
  const s = await c.rpc<Session>('createSession', { projectId: p.id, title: '中文会话', agent: saved.id, command: '' });
  assert.equal(s.command, a.command);
  const h = await c.rpc<History>('refreshHistory', { sessionId: s.id }); assert.equal(h.messages.length, 2);
  adapter(folder, `process.stdout.write('invalid');`);
  await assert.rejects(c.rpc('refreshHistory', { sessionId: s.id }), /JSON/);
  assert.deepEqual(await c.rpc('history', { sessionId: s.id }), h);
  adapter(folder, `process.stdout.write(JSON.stringify({version:1,command:'echo RESUMED_PLUGIN'}));`);
  await c.rpc('start', { sessionId: s.id, resume: true, cols: 80, rows: 24 });
  assert.equal((await c.rpc<State>('state')).sessions[0].latestRun!.command, 'echo RESUMED_PLUGIN');
  await assert.rejects(c.rpc('updateAgent', { agentId: saved.id, ...config }), /停止/);
  await assert.rejects(c.rpc('deleteAgent', { agentId: saved.id }), /会话/);
  await c.rpc('stop', { sessionId: s.id });
  const deadline = Date.now() + 5000;
  while ((await c.rpc<State>('state')).sessions.find(item => item.id === s.id)?.latestRun?.status !== 'stopped') { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 50)); }
  await c.rpc('deleteSession', { sessionId: s.id }); await c.rpc('deleteAgent', { agentId: saved.id });
  assert.equal((await c.rpc<State>('state')).agents!.length, 0);
});
