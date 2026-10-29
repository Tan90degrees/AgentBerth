import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installAgentHook, integrationRoot } from '../src/main/agent-integration';
import { createBridge } from '../src/integrations/opencode/bridge';
import { OpenCodeHistory } from '../src/daemon/opencode-history';
import { AgentCli } from '../src/daemon/agent-cli';
import { openCodeLaunch } from '../src/daemon/opencode-launch';
import { installAgentFile } from '../src/main/plugin-files';
import { Store } from '../src/daemon/store';
import { petHookConfiguration } from '../src/main/pet-config';

async function temporary(t: any) { const folder = await mkdtemp(path.join(os.tmpdir(), "berth integration's ")); t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5 })); return folder; }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => boolean) { const end = Date.now() + 4000; while (!fn()) { assert.ok(Date.now() < end, 'Expected adapter event'); await pause(15); } }
function environment(t: any, values: NodeJS.ProcessEnv) {
  const previous = { ...process.env }; Object.assign(process.env, values);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
}
async function endpoint(t: any) {
  const folder = await temporary(t), packets: any[] = [], token = 'a'.repeat(64);
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { packets.push(JSON.parse(body)); res.end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await writeFile(path.join(folder, 'pet-hook.json'), JSON.stringify({ token, port: (server.address() as any).port }));
  const sessionId = randomUUID(), runId = randomUUID();
  environment(t, { AGENTBERTH_DATA_DIR: folder, AGENTBERTH_SESSION_ID: sessionId, AGENTBERTH_RUN_ID: runId, AGENTBERTH_AGENT: 'opencode', AGENTBERTH_NATIVE_SESSION_ID: '' });
  return { folder, packets, sessionId, runId };
}

test('Claude installer preserves settings and hooks, backs up, deduplicates and rejects malformed config', async t => {
  const project = await temporary(t), options = { provider: 'claude' as const, project, executable: process.execPath, script: path.resolve('dist/pet-hook.cjs'), dataDirectory: project, pluginDirectory: path.resolve('dist') };
  const file = path.join(project, '.claude', 'settings.local.json'); await mkdir(path.dirname(file));
  const command = petHookConfiguration(options.executable, options.script, options.dataDirectory).hooks.Stop[0].hooks[0].command.replace(' --provider claude', '');
  const original = JSON.stringify({ permissions: { allow: ['Read'] }, env: { USER_SETTING: 'keep' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }, { hooks: [{ type: 'command', command, onFailure: 'continue' }] }] } });
  await writeFile(file, original);
  const first = await installAgentHook(options); assert.equal(await readFile(first.backup!, 'utf8'), original);
  const merged = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(merged.permissions, { allow: ['Read'] }); assert.equal(merged.env.USER_SETTING, 'keep'); assert.equal(merged.hooks.Stop.length, 2);
  assert.match(merged.hooks.Stop[1].hooks[0].command, /--provider claude/);
  await Promise.all([installAgentHook(options), installAgentHook(options)]);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).hooks.Stop.length, 2);
  assert.equal((await installAgentHook(options)).backup, null);
  await writeFile(file, '{broken'); await assert.rejects(installAgentHook(options), /JSON/); assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('OpenCode installer selects the matching bundled API, updates atomically and preserves foreign plugins', async t => {
  const project = await temporary(t), options = { provider: 'opencode' as const, project, executable: process.execPath, script: '', dataDirectory: project, pluginDirectory: path.resolve('dist'), detectVersion: async () => '1.14.33\n' };
  const first = await installAgentHook(options), v1 = await readFile(first.path, 'utf8'); assert.ok(v1.includes('OpenCode major: 1'));
  // Both upstream autoloaders discover .js/.ts only, even though the bundled
  // resource itself uses .mjs for direct Node-based contract tests.
  assert.equal(path.extname(first.path), '.js');
  assert.deepEqual((await readdir(path.dirname(first.path))).filter(name => /\.(?:js|ts)$/.test(name)), ['agentberth-pet.js']);
  assert.equal((await installAgentHook(options)).backup, null);
  const second = await installAgentHook({ ...options, detectVersion: async () => 'opencode 2.0.1' });
  assert.equal(await readFile(second.backup!, 'utf8'), v1); assert.match(await readFile(first.path, 'utf8'), /OpenCode major: 2/);
  assert.equal(await openCodeLaunch('opencode --session ses_one', project, project, {}), 'opencode --standalone --session ses_one');
  assert.equal(await openCodeLaunch('opencode && echo done', project, project, {}), 'opencode --standalone && echo done');
  assert.equal(await openCodeLaunch('opencode --server http://localhost:1234', project, project, {}), 'opencode --server http://localhost:1234');
  assert.equal(await openCodeLaunch('my-wrapper', project, project, {}), 'my-wrapper');
  await writeFile(first.path, '// user plugin'); await assert.rejects(installAgentHook(options), /不是 AgentBerth/); assert.equal(await readFile(first.path, 'utf8'), '// user plugin');
  await assert.rejects(installAgentHook({ ...options, project: path.join(project, 'bad-version'), detectVersion: async () => 'future 3.0.0' }), /版本/);
  assert.equal(integrationRoot('claude', undefined, project, { CLAUDE_CONFIG_DIR: path.join(project, 'claude-custom') }), path.join(project, 'claude-custom'));
  assert.equal(integrationRoot('opencode', undefined, project, { XDG_CONFIG_HOME: path.join(project, 'xdg') }), path.join(project, 'xdg', 'opencode'));
});

test('OpenCode bridge tracks real state, child permissions and exact IDs without forwarding content', async t => {
  const { folder, packets, sessionId, runId } = await endpoint(t);
  const getInfo = async (id: string) => ({ id, directory: id === 'foreign' ? path.dirname(folder) : folder, ...(id === 'child' ? { parentID: 'root' } : {}) });
  const bridge = createBridge(folder, getInfo)!; t.after(() => bridge.close());
  await bridge.event({ type: 'session.status', properties: { sessionID: 'root', status: { type: 'busy' } } }); assert.equal(packets.length, 0);
  await bridge.prompt('child'); await bridge.prompt('foreign'); assert.equal(packets.length, 0);
  await bridge.prompt('root'); await bridge.event({ type: 'session.status', properties: { sessionID: 'root', status: { type: 'busy' } } });
  assert.equal(packets.length, 1, 'Repeated state is coalesced');
  await bridge.event({ type: 'permission.asked', properties: { sessionID: 'child', id: 'permission', command: 'PRIVATE_COMMAND' } });
  await bridge.event({ type: 'permission.replied', properties: { sessionID: 'child', requestID: 'permission' } });
  await bridge.event({ type: 'session.idle', properties: { sessionID: 'child' } }); assert.equal(packets.at(-1).status, 'working');
  await bridge.event({ type: 'session.error', properties: { sessionID: 'root', error: 'PRIVATE_ERROR' } });
  await bridge.event({ type: 'session.idle', properties: { sessionID: 'root' } }); assert.equal(packets.at(-1).status, 'error');
  await bridge.prompt('root'); await bridge.event({ type: 'session.idle', properties: { sessionID: 'root' } });
  assert.deepEqual(packets.map(packet => packet.status), ['working', 'waiting', 'working', 'error', 'working', 'completed']);
  assert.ok(packets.every(packet => packet.sessionId === sessionId && packet.runId === runId && packet.nativeSessionId === 'root' && packet.provider === 'opencode' && packet.cwd === folder));
  assert.ok(!JSON.stringify(packets).includes('PRIVATE_'));
  process.env.AGENTBERTH_AGENT = 'shell'; assert.equal(createBridge(folder, getInfo), null);
});

test('bundled OpenCode 1.x and 2.x entrypoints implement their separate plugin contracts', async t => {
  const { folder, packets } = await endpoint(t);
  const v1 = (await import(pathToFileURL(path.resolve('dist/opencode-pet-v1.mjs')).href)).default;
  const hooks = await v1({ directory: folder, client: { session: { get: async ({ path: value }: any) => ({ data: { id: value.id, directory: folder } }) } } });
  hooks['chat.message']({ sessionID: 'v1' }); await until(() => packets.length === 1);
  hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'v1' } } }); await until(() => packets.length === 2); assert.equal(packets.at(-1).status, 'completed');
  const v2 = (await import(pathToFileURL(path.resolve('dist/opencode-pet-v2.mjs')).href)).default;
  assert.equal(v2.id, 'agentberth.desktop-pet'); let prompt: any, push: ((event: any) => void) | undefined;
  const items: any[] = []; let resolve: (() => void) | undefined;
  const close = await v2.setup({ location: { directory: folder }, session: { get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: folder } }), hook: async (type: string, fn: any) => { assert.equal(type, 'prompt'); prompt = fn; } }, event: { subscribe: ({ signal }: any) => ({ async *[Symbol.asyncIterator]() {
    signal.addEventListener('abort', () => { resolve?.(); }, { once: true });
    push = event => { items.push(event); resolve?.(); };
    while (!signal.aborted) { if (!items.length) await new Promise<void>(done => { resolve = done; }); if (items.length) yield items.shift(); }
  } }) } });
  prompt({ sessionID: 'v2' }); await until(() => packets.length === 3);
  push!({ type: 'form.created', data: { form: { id: 'form', sessionID: 'v2', content: 'PRIVATE_FORM' } } }); await until(() => packets.length === 4);
  push!({ type: 'form.replied', data: { id: 'form', sessionID: 'v2' } }); await until(() => packets.length === 5);
  push!({ type: 'session.execution.succeeded', data: { sessionID: 'v2' } }); await until(() => packets.length === 6);
  assert.equal(packets.at(-1).status, 'completed'); assert.equal(packets.at(-1).nativeSessionId, 'v2'); await close();
});

test('OpenCode history supports both export generations, project filtering and request identity', async t => {
  const project = await temporary(t), calls: string[][] = [];
  const cli = { async run(args: string[]) {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify([{ id: 'one', title: 'First', directory: project, updated: 1000 }, { id: 'foreign', directory: path.dirname(project), updated: 2000 }, { id: 'child', parentID: 'one', directory: project, updated: 3000 }]);
    if (args[0] === 'session') throw new Error('1.x does not support session export');
    return JSON.stringify({ info: { id: 'one', directory: project }, messages: [{ info: { role: 'assistant', time: { created: 1000 } }, parts: [{ type: 'text', text: 'old format' }, { type: 'tool', text: 'PRIVATE_TOOL' }] }] });
  }, async close() {} };
  const history = new OpenCodeHistory(cli as any);
  assert.deepEqual((await history.list(project)).map(item => item.nativeSessionId), ['one']);
  assert.equal((await history.history('one', project)).messages[0].text, 'old format');
  assert.deepEqual(calls.at(-1), ['export', 'one']);
  await assert.rejects(history.history('wrong', project), /不一致/); await assert.rejects(history.history('bad;id', project), /无效/);
  cli.run = async () => JSON.stringify({ info: { id: 'two', location: { directory: project } }, messages: [{ type: 'user', text: 'question' }, { type: 'assistant', content: [{ type: 'text', text: 'new format' }, { type: 'reasoning', text: 'PRIVATE_REASONING' }] }] });
  assert.deepEqual((await history.history('two', project)).messages.map(item => item.text), ['question', 'new format']);
  await assert.rejects(history.history('two', path.dirname(project)), /工作目录/);
});

test('installed OpenCode CLI is resolved without profiles and reads JSON through Windows npm shims', async t => {
  const folder = await temporary(t), file = path.join(folder, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const payload = JSON.stringify({ info: { id: 'cli-session', directory: folder }, messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'CLI_TEXT' }] }] });
  await writeFile(file, process.platform === 'win32' ? '@echo off\r\necho ' + payload + '\r\n' : '#!/bin/sh\nprintf \'%s\\n\' \'' + payload.replaceAll("'", "'\\''") + "'\n", { mode: 0o755 });
  environment(t, { PATH: folder + path.delimiter + process.env.PATH });
  const cli = new AgentCli(); t.after(() => cli.close());
  assert.equal((await new OpenCodeHistory(cli).history('cli-session', folder)).messages[0].text, 'CLI_TEXT');
});

test('single-file Agent profiles retain provider inheritance through import, save and rename', async t => {
  const folder = await temporary(t), store = new Store(path.join(folder, 'data'));
  try {
    for (const integration of ['claude', 'opencode']) {
      const file = path.join(folder, integration + '.json'); await writeFile(file, JSON.stringify({ schemaVersion: 1, id: integration + '-profile', name: integration + ' profile', integration, command: integration, resumeCommand: integration + ' --resume {sessionId}' }));
      const config = await installAgentFile(file, folder), saved = store.saveAgent(config);
      assert.equal(store.saveAgent({ ...config, name: 'Renamed ' + integration }, saved.id).integration, integration);
    }
  } finally { store.close(); }
  assert.equal((await readdir(folder)).includes('node_modules'), false, 'Integration does not install an Agent engine');
});
