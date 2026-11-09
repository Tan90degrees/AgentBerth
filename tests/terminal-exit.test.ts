import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/daemon/store';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { Project, Session, Run, State } from '../src/shared/protocol';

test('terminal completion stores unknown native exit codes as NULL and preserves Windows status codes', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'berth-exit-code-'));
  const store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const project = store.createProject('Exit codes', root);
  const session = store.createSession(project.id, 'Shell', 'shell', '');
  for (const code of [undefined, NaN, Infinity, -Infinity, 0.5, '0', {}, null, 0, 1, -1, 0xC000013A]) {
    const run = store.createRun(session.id, '', 80, 24);
    store.finish(run.id, 'exited', code as never, null, '', 0, 80, 24);
    const saved = store.run(run.id);
    assert.equal(saved.status, 'exited');
    assert.equal(saved.exitCode, typeof code === 'number' && Number.isSafeInteger(code) ? code : null);
    assert.ok(saved.endedAt);
  }
});

test('an exit event without a usable code releases the live terminal and allows restarting it', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'berth-exit-event-'));
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const spawn = () => ({
    pid: 987654321, write() {}, resize() {}, pause() {}, resume() {},
    kill() { onExit?.({ exitCode: undefined as never }); },
    onData() {}, onExit(listener: typeof onExit) { onExit = listener; },
  });
  const server = new DaemonServer(path.join(root, 'data'), () => {}, spawn as never);
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await connection.rpc<Project>('createProject', { name: 'Exit fixture', path: root });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'Shell', agent: 'shell', command: '' });
  let previous: string | undefined;
  for (const code of [undefined, NaN]) {
    const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 });
    assert.notEqual(run.id, previous);
    onExit!({ exitCode: code as never });
    const deadline = Date.now() + 5000;
    while (true) {
      const current = (await connection.rpc<State>('state')).sessions.find(item => item.id === session.id)!.latestRun!;
      if (current.status === 'exited') { assert.equal(current.exitCode, null); break; }
      assert.ok(Date.now() < deadline, 'exit callback did not release the run');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    previous = run.id;
  }
});
