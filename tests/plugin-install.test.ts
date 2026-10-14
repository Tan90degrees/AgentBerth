import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installPluginManifest, exportPluginKit, developmentPrompt } from '../src/main/plugin-files';
import { AgentPlugins } from '../src/daemon/plugins';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { Store } from '../src/daemon/store';
import { nextSessionTitle } from '../src/renderer/labels';
import type { AgentDefinition, Attachment, Project, Run, Session, State } from '../src/shared/protocol';

async function temporary(t: any) { const folder = await mkdtemp(path.join(os.tmpdir(), 'berth 安装 plugin ')); t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return folder; }
const manifest = { schemaVersion: 1, id: 'demo', name: 'Demo', command: 'demo', runtime: 'node', entry: 'plugin.cjs', capabilities: { history: true, resume: true } };

test('plugin kit exports to a new folder and installs with the embedded runtime and complete Agent instructions', async t => {
  const folder = await temporary(t);
  const kit = await exportPluginKit(folder, path.resolve('.'));
  const guide = await readFile(path.join(kit, 'AGENT_PLUGIN_DEVELOPMENT.md'), 'utf8');
  assert.ok(guide.includes('describe') && guide.includes('history') && guide.includes('resume'));
  assert.ok(developmentPrompt(guide, kit).includes(kit));
  assert.ok(developmentPrompt(guide).includes('不要记录 TUI'));
  const config = await installPluginManifest(path.join(kit, 'agentberth-plugin.json'), path.join(folder, 'data'));
  assert.equal(config.plugin!.runtime, 'node');
  assert.equal(config.plugin!.args.length, 0);
  assert.ok(config.plugin!.executable.startsWith(await realpath(path.join(folder, 'data'))));
  await rm(kit, { recursive: true });
  const plugins = new AgentPlugins();
  try { assert.equal((await plugins.check({ id: 'test', ...config })).message, '插件连接正常'); } finally { await plugins.close(); }
});

test('manifest import copies declared resources, resolves portable asset paths and never depends on the source folder', async t => {
  const folder = await temporary(t); const source = path.join(folder, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'plugin.cjs'), 'original'); await writeFile(path.join(source, 'data.json'), '{}');
  await writeFile(path.join(source, 'agentberth-plugin.json'), JSON.stringify({ ...manifest, files: ['data.json'], args: ['{pluginDir}/data.json'] }));
  const config = await installPluginManifest(path.join(source, 'agentberth-plugin.json'), path.join(folder, 'installed'));
  await writeFile(path.join(source, 'plugin.cjs'), 'changed');
  assert.equal(await readFile(config.plugin!.executable, 'utf8'), 'original');
  assert.equal(await readFile(config.plugin!.args[0], 'utf8'), '{}');
  assert.equal(config.plugin!.sourceId, 'demo');
});

test('manifest validation rejects invalid versions, missing entry files, traversal and excessive resources', async t => {
  const folder = await temporary(t); const file = path.join(folder, 'agentberth-plugin.json');
  for (const value of [{ ...manifest, schemaVersion: 2 }, { ...manifest, entry: '../outside.cjs' }, { ...manifest, entry: '/absolute.cjs' }, { ...manifest, command: 'a\nb' }]) {
    await writeFile(file, JSON.stringify(value)); await assert.rejects(installPluginManifest(file, path.join(folder, 'data')), /格式/);
  }
  await writeFile(file, JSON.stringify(manifest)); await assert.rejects(installPluginManifest(file, path.join(folder, 'data')), /缺少资源/);
  await writeFile(path.join(folder, 'plugin.cjs'), Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(installPluginManifest(file, path.join(folder, 'data')), /16 MiB/);
});

test('manifest entry cannot escape its directory through a symlink or Windows junction', async t => {
  const folder = await temporary(t); const source = path.join(folder, 'source'); const outside = path.join(folder, 'outside');
  await mkdir(source); await mkdir(outside); await writeFile(path.join(outside, 'plugin.cjs'), 'outside');
  await symlink(outside, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(source, 'agentberth-plugin.json'), JSON.stringify({ ...manifest, entry: 'link/plugin.cjs' }));
  await assert.rejects(installPluginManifest(path.join(source, 'agentberth-plugin.json'), path.join(folder, 'data')), /目录外/);
});

test('describe self-check rejects malformed replies and mismatched manifest capabilities', async t => {
  const folder = await temporary(t); const file = path.join(folder, 'plugin.cjs');
  const config: AgentDefinition = { id: 'test', name: 'Test', command: 'test', resumeCommand: '', plugin: { runtime: 'node', executable: file, args: [], history: true, resume: true } };
  const plugins = new AgentPlugins();
  try {
    await writeFile(file, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({version:1,name:'Test',capabilities:{history:true,resume:false}})));`);
    await assert.rejects(plugins.check(config), /能力与声明/);
    await writeFile(file, `process.stdin.resume();process.stdin.on('end',()=>console.log('invalid'));`);
    await assert.rejects(plugins.check(config), /JSON/);
  } finally { await plugins.close(); }
});

test('only ordinary Shell runs record output; all Agent modes retain status without recording TUI screens', async t => {
  const folder = await temporary(t); const store = new Store(path.join(folder, 'data'));
  try {
    const p = store.createProject('Test', folder);
    for (const agent of ['codex', 'claude', 'opencode', 'custom']) {
      const s = store.createSession(p.id, agent, agent, 'echo TEST'); const r = store.createRun(s.id, 'test', 80, 24);
      store.finish(r.id, 'stopped', 0, null, '\x1b[HOVERWRITTEN_TUI', 1, 80, 24);
      assert.equal(store.run(r.id).recordOutput, 0); assert.equal(store.savedScreen(r.id).snapshot, ''); assert.equal(store.session(s.id).latestRun!.status, 'stopped');
    }
    const s = store.createSession(p.id, 'shell', 'shell', ''); const r = store.createRun(s.id, '', 80, 24);
    store.finish(r.id, 'stopped', 0, null, 'SHELL_OUTPUT', 1, 80, 24);
    assert.equal(store.savedScreen(r.id).snapshot, 'SHELL_OUTPUT'); assert.equal(store.run(r.id).recordOutput, 1);
  } finally { store.close(); }
});

test('real Agent TUI remains attachable in memory but exposes neither output logs nor run history', { timeout: 15000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'berth-tui-recording-'));
  const server = new DaemonServer(path.join(folder, 'data')); const c = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { c.close(); await server.close(); await rm(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const p = await c.rpc<Project>('createProject', { name: 'Test', path: folder });
  const a = await c.rpc<Session>('createSession', { projectId: p.id, title: 'Agent', agent: 'custom', command: 'echo TUI_IN_MEMORY' });
  const run = await c.rpc<Run>('start', { sessionId: a.id, cols: 80, rows: 24 });
  const deadline = Date.now() + 5000;
  while (!(await c.rpc<Attachment>('attach', { sessionId: a.id })).snapshot.includes('TUI_IN_MEMORY')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.deepEqual(await c.rpc('runs', { sessionId: a.id }), []);
  await assert.rejects(c.rpc('output', { runId: run.id }), /仅普通终端/);
  await assert.rejects(readFile(path.join(folder, 'data', 'logs', run.id + '.log')), /ENOENT/);
  await c.rpc('stop', { sessionId: a.id });
  while ((await c.rpc<State>('state')).sessions[0].latestRun!.status !== 'stopped') { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal((await c.rpc<Attachment>('attach', { sessionId: a.id })).snapshot, '');
});

test('automatic session names avoid existing names', () => {
  assert.equal(nextSessionTitle('Codex', []), 'Codex 会话');
  assert.equal(nextSessionTitle('Codex', ['Codex 会话', 'Codex 会话 2']), 'Codex 会话 3');
});
