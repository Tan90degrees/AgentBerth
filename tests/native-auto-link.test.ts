import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeDiscovery, unambiguousNewHistory, type NativeCandidate } from '../src/daemon/native-discovery';
import { OpenCodeHistory } from '../src/daemon/opencode-history';
import { randomUUID } from 'node:crypto';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { History, NativeHistoryPage, Project, Session, State } from '../src/shared/protocol';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) { const end = Date.now() + 7000; while (Date.now() < end) { if (await check()) return; await wait(40); } throw new Error('Auto-link did not complete'); }
const record = (id: string, cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n';

test('exact provider hooks isolate concurrent runs, follow new conversations and yield to manual association', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'berth-exact-hooks-')), claude = path.join(dir, 'claude'); await mkdir(claude);
  const commands: string[][] = [], environments: NodeJS.ProcessEnv[] = [], writes: string[] = [], exits: (() => void)[] = [];
  const fakeCli = { async run(args: string[]) {
    commands.push(args);
    if (args[1] === 'list') return JSON.stringify([{ id: 'discovered', directory: dir, updated: Date.now(), title: 'Named conversation' }]);
    return JSON.stringify({ info: { id: args.at(-1), directory: dir }, messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'FINAL_NATIVE_TEXT' }] }] });
  }, async close() {} };
  const spawn = (_file: string, _args: string[], options: any) => {
    environments.push(options.env); let exit: ((event: { exitCode: number }) => void) | undefined;
    return { pid: 987654321, write(text: string) { writes.push(text); }, resize() {}, pause() {}, resume() {}, kill() { exit?.({ exitCode: 0 }); }, onData() {}, onExit(fn: any) { exit = fn; exits.push(() => fn({ exitCode: 0 })); } };
  };
  const discovery = new NativeDiscovery({ codex: path.join(dir, 'codex'), claude }, new OpenCodeHistory(fakeCli as any));
  const server = new DaemonServer(path.join(dir, 'data'), () => {}, spawn as any, discovery), c = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { exits.forEach(exit => exit()); await wait(50); c.close(); await server.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await c.rpc<Project>('createProject', { name: 'Hook project', path: dir });
  const definition: any = await c.rpc('createAgent', { name: 'OpenCode profile', integration: 'opencode', command: 'opencode --model fixture', resumeCommand: 'opencode --session {sessionId}' });
  const a = await c.rpc<Session>('createSession', { projectId: project.id, title: 'A', agent: 'opencode' });
  const b = await c.rpc<Session>('createSession', { projectId: project.id, title: 'B', agent: definition.id });
  const ra: any = await c.rpc('start', { sessionId: a.id, cols: 80, rows: 24 }), rb: any = await c.rpc('start', { sessionId: b.id, cols: 80, rows: 24 });
  assert.equal(commands.length, 0, 'Launching TUI must not execute history CLI queries');
  assert.equal(environments[1].AGENTBERTH_AGENT, 'opencode');
  assert.equal(environments[1].AGENTBERTH_RUN_ID, rb.id);
  const detect = (sessionId: string, runId: string, nativeSessionId: string, overrides = {}) => c.rpc('nativeSessionDetected', { sessionId, runId, nativeSessionId, provider: 'opencode', cwd: dir, ...overrides });
  assert.deepEqual(await detect(a.id, randomUUID(), 'stale'), { linked: false });
  assert.deepEqual(await detect(a.id, ra.id, 'foreign', { cwd: path.dirname(dir) }), { linked: false });
  assert.deepEqual(await detect(a.id, ra.id, 'native-a'), { linked: true });
  assert.deepEqual(await detect(b.id, rb.id, 'native-b'), { linked: true });
  assert.deepEqual(await detect(a.id, ra.id, 'native-a-next'), { linked: true });
  let state = await c.rpc<State>('state'); assert.equal(state.sessions.find(s => s.id === b.id)!.nativeSessionId, 'native-b');
  assert.equal((await c.rpc<History>('refreshHistory', { sessionId: b.id })).messages[0].text, 'FINAL_NATIVE_TEXT');
  await c.rpc('unlinkNativeSession', { sessionId: a.id });
  assert.deepEqual(await detect(a.id, ra.id, 'must-not-rebind'), { linked: false });
  await c.rpc('linkNativeSession', { sessionId: b.id, nativeSessionId: 'manual' });
  assert.deepEqual(await detect(b.id, rb.id, 'must-not-replace'), { linked: false });
  const list = await c.rpc<NativeHistoryPage>('discoverNativeHistories', { sessionId: b.id, query: 'Named' }); assert.equal(list.items[0].nativeSessionId, 'discovered');
  assert.equal((await c.rpc<History>('nativeHistory', { sessionId: b.id, nativeSessionId: 'discovered' })).messages[0].text, 'FINAL_NATIVE_TEXT');
  assert.equal((await c.rpc<State>('state')).sessions.find(s => s.id === b.id)!.nativeSessionId, 'manual', 'Preview must not change association');
  const ca = await c.rpc<Session>('createSession', { projectId: project.id, title: 'Claude', agent: 'claude' });
  const cr: any = await c.rpc('start', { sessionId: ca.id, cols: 80, rows: 24 });
  const cp = { sessionId: ca.id, runId: cr.id, nativeSessionId: 'claude-native', provider: 'claude', cwd: dir };
  assert.deepEqual(await c.rpc('nativeSessionDetected', cp), { linked: false }, 'Do not bind a pathless Claude transcript');
  const transcript = path.join(claude, 'claude-native.jsonl'); await writeFile(transcript, JSON.stringify({ sessionId: 'claude-native', cwd: dir, type: 'assistant', message: { role: 'assistant', content: 'CLAUDE_FINAL' } }) + '\n');
  assert.deepEqual(await c.rpc('nativeSessionDetected', cp), { linked: true });
  assert.equal((await c.rpc<History>('refreshHistory', { sessionId: ca.id })).messages[0].text, 'CLAUDE_FINAL');
  // These PTYs have deliberately nonexistent PIDs: simulate their actual exit,
  // rather than relying on OS signal delivery to trigger a fake onExit callback.
  exits[2](); exits[1]();
  await until(async () => (await c.rpc<State>('state')).sessions.find(s => s.id === b.id)!.latestRun?.status === 'exited');
  const resumed: any = await c.rpc('start', { sessionId: b.id, resume: true, cols: 80, rows: 24 });
  assert.match(writes.at(-1)!, /opencode --session manual/);
  assert.equal(environments.at(-1)!.AGENTBERTH_NATIVE_SESSION_ID, 'manual');
  assert.deepEqual(await detect(b.id, resumed.id, 'new-after-resume'), { linked: true });
  await c.rpc('unlinkNativeSession', { sessionId: b.id });
  assert.deepEqual(await detect(b.id, resumed.id, 'still-manual-unlink'), { linked: false });
});

test('native discovery retries partial metadata, isolates projects and never guesses among multiple new IDs', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'berth-native-discovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const codex = path.join(dir, 'native'); await mkdir(codex);
  const discovery = new NativeDiscovery({ codex, claude: path.join(dir, 'claude') });
  const file = path.join(codex, 'one.jsonl'); await writeFile(file, '{"type":"session_meta"');
  assert.equal((await discovery.list('codex', dir)).length, 0);
  await writeFile(file, record('one', dir)); await writeFile(path.join(codex, 'foreign.jsonl'), record('foreign', path.join(dir, 'foreign')));
  let items = await discovery.list('codex', dir); assert.deepEqual(items.map(item => item.nativeSessionId), ['one']);
  assert.equal(unambiguousNewHistory(items, new Set(), Date.now(), new Set())?.nativeSessionId, 'one');
  assert.equal(unambiguousNewHistory(items, new Set(['one']), Date.now(), new Set()), null);
  assert.equal(unambiguousNewHistory(items, new Set(), Date.now(), new Set(['one'])), null);
  items = [...items, { ...items[0], nativeSessionId: 'two' }]; assert.equal(unambiguousNewHistory(items, new Set(), Date.now(), new Set()), null);
});

test('fresh runs bind delayed native IDs, flush final history on exit, preserve old history and do not reuse stale IDs', { timeout: 18000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'berth-auto-link-')), codex = path.join(dir, 'native'); await mkdir(codex);
  const exits: ((event: { exitCode: number }) => void)[] = [];
  const fakeSpawn = () => ({ pid: 987654321, write() {}, resize() {}, pause() {}, resume() {}, kill() {}, onData() {}, onExit(fn: (event: { exitCode: number }) => void) { exits.push(fn); } });
  const server = new DaemonServer(path.join(dir, 'data'), () => {}, fakeSpawn as any, new NativeDiscovery({ codex, claude: path.join(dir, 'claude') }));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { exits.forEach(fn => fn({ exitCode: 0 })); await wait(50); connection.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const project = await connection.rpc<Project>('createProject', { path: dir, name: 'Project' });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'Agent', agent: 'codex' });
  await connection.rpc('linkNativeSession', { sessionId: session.id, nativeSessionId: 'previous' });
  await connection.rpc('start', { sessionId: session.id, cols: 80, rows: 24 });
  const current = async () => (await connection.rpc<State>('state')).sessions.find(item => item.id === session.id)!;
  assert.equal((await current()).nativeSessionId, null);
  const transcript = path.join(codex, 'new.jsonl'); await writeFile(transcript, record('new-native', dir));
  await until(async () => (await current()).nativeSessionId === 'new-native');
  await appendFile(transcript, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FINAL_MESSAGE' }] } }) + '\n');
  exits[0]({ exitCode: 0 });
  await until(async () => (await current()).latestRun?.status === 'exited');
  assert.equal((await connection.rpc<History>('history', { sessionId: session.id })).messages[0].text, 'FINAL_MESSAGE');
  assert.equal((await connection.rpc<NativeHistoryPage>('nativeHistories', { sessionId: session.id })).total, 2);
  // A second launch must not resume or rebind the first run's conversation.
  await connection.rpc('start', { sessionId: session.id, cols: 80, rows: 24 });
  assert.equal((await current()).nativeSessionId, null);
  exits[1]({ exitCode: 0 }); await until(async () => (await current()).latestRun?.status === 'exited');
  assert.equal((await current()).nativeSessionId, null);
  const discovered = await connection.rpc<NativeHistoryPage>('discoverNativeHistories', { sessionId: session.id });
  assert.equal(discovered.items[0].nativeSessionId, 'new-native');
});

test('a private TUI reuses its list/history/resume plugin for automatic binding and concurrent runs require selection', { timeout: 18000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'berth-private-binding-'));
  const records = path.join(dir, 'records'); await mkdir(records);
  const script = path.join(dir, 'plugin.cjs');
  await writeFile(script, `const fs=require('node:fs'),path=require('node:path');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const r=JSON.parse(input);let value;if(r.method==='describe')value={version:1,id:'private',name:'Private',command:'fixture-agent',capabilities:{history:true,resume:true,list:true}};else if(r.method==='list')value={version:1,items:fs.readdirSync(${JSON.stringify(records)}).map(file=>{const d=JSON.parse(fs.readFileSync(path.join(${JSON.stringify(records)},file),'utf8'));return{cwd:r.projectPath,nativeSessionId:d.id,title:d.id,updatedAt:d.time,path:null}}),nextCursor:null};else if(r.method==='history')value={version:1,cwd:r.projectPath,nativeSessionId:r.session.nativeSessionId,messages:[{role:'assistant',text:'PRIVATE_FINAL'}]};else value={version:1,command:'fixture-agent --resume '+r.session.nativeSessionId};console.log(JSON.stringify(value));});`);
  const exits: ((event: { exitCode: number }) => void)[] = [], writes: string[] = [];
  const spawn = () => ({ pid: 987654321, write(text: string) { writes.push(text); }, resize() {}, pause() {}, resume() {}, kill() {}, onData() {}, onExit(fn: (event: { exitCode: number }) => void) { exits.push(fn); } });
  const server = new DaemonServer(path.join(dir, 'data'), () => {}, spawn as any), connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { exits.forEach(fn => fn({ exitCode: 0 })); await wait(100); connection.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const project = await connection.rpc<Project>('createProject', { path: dir, name: 'Private project' });
  const definition: any = await connection.rpc('createAgent', { name: 'Private', sourceId: 'private', command: 'fixture-agent', plugin: { runtime: 'node', executable: script, args: [], history: true, resume: true, list: true } });
  const create = (title: string) => connection.rpc<Session>('createSession', { projectId: project.id, title, agent: definition.id });
  const session = await create('Private'), current = async (id: string) => (await connection.rpc<State>('state')).sessions.find(item => item.id === id)!;
  await connection.rpc('start', { sessionId: session.id, cols: 80, rows: 24 });
  await writeFile(path.join(records, 'first.json'), JSON.stringify({ id: 'private-first', time: new Date().toISOString() }));
  exits[0]({ exitCode: 0 }); await until(async () => (await current(session.id)).latestRun?.status === 'exited');
  assert.equal((await current(session.id)).nativeSessionId, 'private-first');
  assert.equal((await connection.rpc<History>('history', { sessionId: session.id })).messages[0].text, 'PRIVATE_FINAL');
  await connection.rpc('start', { sessionId: session.id, resume: true, cols: 80, rows: 24 });
  assert.match(writes.at(-1)!, /fixture-agent --resume private-first/); assert.equal((await current(session.id)).nativeSessionId, 'private-first');
  exits[1]({ exitCode: 0 }); await until(async () => (await current(session.id)).latestRun?.status === 'exited');
  const a = await create('A'), b = await create('B');
  await connection.rpc('start', { sessionId: a.id, cols: 80, rows: 24 }); await connection.rpc('start', { sessionId: b.id, cols: 80, rows: 24 });
  await writeFile(path.join(records, 'second.json'), JSON.stringify({ id: 'ambiguous', time: new Date().toISOString() }));
  exits[2]({ exitCode: 0 }); exits[3]({ exitCode: 0 });
  await until(async () => (await current(a.id)).latestRun?.status === 'exited' && (await current(b.id)).latestRun?.status === 'exited');
  assert.equal((await current(a.id)).nativeSessionId, null); assert.equal((await current(b.id)).nativeSessionId, null);
  const manualAgent: any = await connection.rpc('createAgent', { name: 'Manual', command: 'fixture-manual', resumeCommand: 'fixture-manual --resume {sessionId}' });
  const manual = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'Manual', agent: manualAgent.id });
  await connection.rpc('linkNativeSession', { sessionId: manual.id, nativeSessionId: 'old-manual' });
  await connection.rpc('start', { sessionId: manual.id, cols: 80, rows: 24 });
  assert.equal((await current(manual.id)).nativeSessionId, null);
  assert.equal((await connection.rpc<NativeHistoryPage>('nativeHistories', { sessionId: manual.id })).total, 1);
  exits[4]({ exitCode: 0 }); await until(async () => (await current(manual.id)).latestRun?.status === 'exited');
});
