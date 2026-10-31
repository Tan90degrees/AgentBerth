import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentPlugins } from '../src/daemon/plugins';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { Store } from '../src/daemon/store';
import { nextSessionTitle } from '../src/renderer/labels';
import type { AgentDefinition, Attachment, Project, Run, Session, State } from '../src/shared/protocol';

async function temporary(t: any) { const folder = await mkdtemp(path.join(os.tmpdir(), 'berth 安装 plugin ')); t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return folder; }
const manifest = { schemaVersion: 1, id: 'demo', name: 'Demo', command: 'demo', runtime: 'node', entry: 'plugin.cjs', capabilities: { history: true, resume: true } };

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

