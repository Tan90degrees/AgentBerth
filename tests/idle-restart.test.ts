import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { ResourceSampler } from '../src/daemon/resources';
import { GitWorkspace, parseGitStatus } from '../src/daemon/git';
import type { GitStatus, Project, ResourceSnapshot } from '../src/shared/protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('idle restart ignores resource polling while protecting other requests in flight', { timeout: 5000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-idle-restart-'));
  const sample = deferred<ResourceSnapshot>();
  const sampling = deferred<void>();
  const inspection = deferred<GitStatus>();
  const inspecting = deferred<void>();
  const shutdown = deferred<void>();
  const snapshot: ResourceSnapshot = {
    sampledAt: new Date().toISOString(), cpuCount: 1, sessions: {}, projects: {}, desktopIncluded: false,
    workspace: { cpuPercent: 0, memoryBytes: 0, processCount: 0, partial: false },
  };
  t.mock.method(ResourceSampler.prototype, 'sample', () => { sampling.resolve(); return sample.promise; });
  t.mock.method(GitWorkspace.prototype, 'status', () => { inspecting.resolve(); return inspection.promise; });
  const server = new DaemonServer(path.join(folder, 'data'), () => shutdown.resolve());
  const runtime = await server.listen();
  const connection = await DaemonConnection.open(runtime, () => {});
  const restarting = await DaemonConnection.open(runtime, () => {});
  t.after(async () => {
    sample.resolve(snapshot); inspection.resolve(parseGitStatus('', folder));
    connection.close(); restarting.close(); await server.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  });
  const project = await connection.rpc<Project>('createProject', { name: 'project', path: folder });
  const resourceRequest = connection.rpc<ResourceSnapshot>('resources');
  void resourceRequest.catch(() => {});
  await sampling.promise;
  const workRequest = connection.rpc('gitStatus', { projectId: project.id });
  void workRequest.catch(() => {});
  await inspecting.promise;
  await assert.rejects(restarting.rpc('shutdownIdle'), /后台正在处理数据/);
  inspection.resolve(parseGitStatus('', folder));
  await workRequest;
  assert.equal(await restarting.rpc('shutdownIdle'), null);
  await shutdown.promise;
  sample.resolve(snapshot);
  assert.deepEqual(await resourceRequest, snapshot);
});
