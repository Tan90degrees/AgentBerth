import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { Server, utils } from 'ssh2';
import { acceleratorProbe, parseAcceleratorProbe, parseAscendSmi, parseNvidiaSmi } from '../src/daemon/accelerators';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { PetMonitor } from '../src/main/pet-monitor';
import { PetState } from '../src/main/pet-state';
import { petPreferencesSchema, petRequestSchema } from '../src/shared/pet';
import type { AcceleratorSample } from '../src/shared/accelerator';
import type { SshConnection } from '../src/shared/protocol';

const gpu = '0, NVIDIA A100, 82, 8192, 40960, 57\n2, NVIDIA L20, [N/A], 0, 49152, 36';
const npu = [
  '| NPU     Name  | Health   | Power(W) Temp(C)  | Hugepages-Usage(page) |',
  '| Chip         | Bus-Id   | AICore(%) Memory-Usage(MB) | HBM-Usage(MB) |',
  '| 0       910B1 | OK       | 93.1  46  | 0 / 0 |',
  '| 0             | 0000:C1:00.0 | 32   0 / 0 | 4313 / 65536 |',
  '| 1536    310P3 | OK       | 39.2  55 | 0 / 0 |',
  '| 0             | 0000:07:00.0 | 92   1924 / 44215 |',
  '| 1             | 0000:08:00.0 | 3    1024 / 44215 |',
  '| NPU Chip   | Process id | Process name | Process memory(MB) |',
].join('\n');
function framed(nvidia: string, ascend: string, gpuCode = 0, npuCode = 0) {
  return ['login banner', '__AGENTBERTH_NVIDIA__', nvidia, '__AGENTBERTH_ASCEND__ ' + gpuCode, ascend, '__AGENTBERTH_END__ ' + npuCode].join('\n');
}

test('per-card NVIDIA and Ascend metrics keep physical/chip identifiers and distinguish missing readings from zero', () => {
  const devices = parseAcceleratorProbe(framed(gpu, npu)).devices;
  assert.deepEqual(devices.map(device => [device.id, device.utilization, device.temperature, device.memory?.kind, device.memory?.used]), [
    ['0', 82, 57, 'VRAM', 8192], ['2', null, 36, 'VRAM', 0],
    ['0:0', 32, 46, 'HBM', 4313], ['1536:0', 92, 55, 'DDR', 1924], ['1536:1', 3, 55, 'DDR', 1024],
  ]);
  assert.equal(parseNvidiaSmi('invalid').length, 0);
  assert.equal(parseAscendSmi('Permission denied').length, 0);
  assert.throws(() => parseAcceleratorProbe(framed('', '', 127, 127)), /未找到/);
  assert.throws(() => parseAcceleratorProbe(framed('', '', 1, 127)), /NVIDIA GPU 未返回/);
  assert.throws(() => parseAcceleratorProbe('short output'), /输出不完整/);
  assert.equal(parseAcceleratorProbe(framed(gpu, '', 0, 1)).warning, '昇腾 NPU 未返回可用数据');
});

test('desktop keeps three independent readings, drops late results after selection changes, and persists the node and limit', async t => {
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const requests: { id: string; finish: (result: AcceleratorSample) => void; fail: (error: Error) => void }[] = [];
  const monitor = new PetMonitor(id => new Promise((finish, fail) => requests.push({ id, finish, fail })), () => {});
  t.after(() => monitor.configure([], false));
  monitor.configure(ids.slice(0, 3), true);
  assert.deepEqual(requests.map(task => task.id), ids.slice(0, 3));
  monitor.configure(ids.slice(0, 3), true);
  assert.equal(requests.length, 3);
  monitor.configure(ids.slice(1), true);
  assert.equal(requests.at(-1)?.id, ids[3]);
  for (const [index, task] of requests.entries()) task.finish({ sampledAt: index, devices: [] });
  await nextTurn();
  assert.deepEqual(monitor.snapshot().map(reading => reading.id), ids.slice(1));
  monitor.configure(ids.slice(1), false);
  monitor.configure(ids.slice(1), true);
  requests[4].fail(new Error('offline'));
  requests[5].finish({ sampledAt: 5, devices: [] });
  requests[6].finish({ sampledAt: 6, devices: [] });
  await nextTurn();
  assert.deepEqual(monitor.snapshot()[0], { id: ids[1], sample: { sampledAt: 1, devices: [] }, error: 'offline' });
  monitor.configure(ids.slice(1), false);
  monitor.reset(ids[1]);
  assert.equal(requests.length, 7, 'hiding stops new requests');
  assert.equal(petPreferencesSchema.safeParse({ monitorNodeIds: ids }).success, false);
  assert.equal(petPreferencesSchema.safeParse({ monitorNodeIds: [ids[0], ids[0]] }).success, false);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'pet-monitor-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const pet = new PetState(dir);
  assert.equal(pet.preferences.monitorRefreshSeconds, 20);
  pet.save({ monitorNodeIds: ids.slice(1), monitorSelectedId: ids[2], monitorRefreshSeconds: 35 });
  const restored = new PetState(dir);
  assert.equal(restored.preferences.monitorSelectedId, ids[2]);
  assert.equal(restored.preferences.monitorRefreshSeconds, 35);
  pet.save({ monitorNodeIds: [ids[3]], monitorSelectedId: ids[2] });
  assert.equal(pet.preferences.monitorSelectedId, ids[3]);
});

test('changing the refresh interval replaces the timer and skips samples still in flight', async t => {
  const id = randomUUID();
  const pending: Array<(sample: AcceleratorSample) => void> = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  const monitor = new PetMonitor(() => new Promise(resolve => pending.push(resolve)), () => {});
  monitor.configure([id], true);
  assert.equal(pending.length, 1);
  monitor.configure([id], true, 5);
  t.mock.timers.tick(5_000);
  assert.equal(pending.length, 1, 'a changed interval does not duplicate a live request');
  pending[0]({ sampledAt: 0, devices: [] });
  await nextTurn();
  t.mock.timers.tick(5_000);
  assert.equal(pending.length, 2, 'new interval is applied without reopening the window');
  pending[1]({ sampledAt: 10_000, devices: [] });
  await nextTurn();
  monitor.configure([id], true, 60);
  t.mock.timers.tick(59_000);
  assert.equal(pending.length, 2, 'old timer has stopped');
  t.mock.timers.tick(1_000);
  assert.equal(pending.length, 3);
  monitor.configure([id], false);
  t.mock.timers.tick(60_000);
  assert.equal(pending.length, 3);
  for (const seconds of [0, 4, 5.5, 301]) {
    assert.equal(petRequestSchema.safeParse({ action: 'saveMonitorInterval', seconds }).success, false);
  }
  for (const seconds of [5, 300]) {
    assert.equal(petRequestSchema.safeParse({ action: 'saveMonitorInterval', seconds }).success, true);
  }
});

test('accelerator RPC uses the registered desktop provider and verified SSH host, and executes only the fixed probe', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pet-accelerator-ssh-'));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const parsed = utils.parseKey(key);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  const fingerprint = 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const peers = new Set<import('ssh2').Connection>();
  let executions = 0, auth = 0;
  const ssh = new Server({ hostKeys: [key] }, peer => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('error', () => {});
    peer.on('authentication', request => {
      auth++;
      if (request.username === 'monitor-fixture' && request.method === 'password' && request.password === 'fixture-value') request.accept();
      else request.reject(['password']);
    });
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        if (info.command !== acceleratorProbe) { reject?.(); return; }
        executions++;
        const channel = accept();
        channel.exit(0);
        channel.end(framed(gpu, npu));
      });
    }));
  });
  await new Promise<void>(resolve => ssh.listen(0, '127.0.0.1', resolve));
  const address = ssh.address();
  assert.ok(address && typeof address !== 'string');
  const daemon = new DaemonServer(directory);
  const runtime = await daemon.listen();
  let desktop: DaemonConnection;
  desktop = await DaemonConnection.open(runtime, event => {
    if (event.event === 'sshChallenge' && event.data.kind === 'credentials') void desktop.rpc('sshChallengeReply', {
      challengeId: event.data.id, secret: { password: 'fixture-value' },
    }).catch(() => {});
  });
  const outsider = await DaemonConnection.open(runtime, () => {});
  t.after(async () => {
    outsider.close(true); desktop.close(true); await daemon.close();
    for (const peer of peers) peer.end();
    await new Promise<void>(resolve => ssh.close(() => resolve()));
    await rm(directory, { force: true, recursive: true, maxRetries: 5 });
  });
  await desktop.rpc('registerSshProvider');
  const profile = await desktop.rpc<SshConnection>('saveSshConnection', { config: {
    alias: 'monitor-fixture', hostname: '127.0.0.1', port: address.port, username: 'monitor-fixture', authentication: 'password', allowAgent: false,
  } });
  const params = { connectionId: profile.id };
  await assert.rejects(outsider.rpc('sampleAccelerators', params), /仅桌面监控/);
  await assert.rejects(desktop.rpc('sampleAccelerators', params), /确认主机指纹/);
  assert.equal(auth, 0);
  daemon.sshCorePort().store.trustSshFingerprint(profile.id, 'SHA256:wrong');
  await assert.rejects(desktop.rpc('sampleAccelerators', params), /指纹|握手/);
  assert.equal(auth, 0, 'a mismatched host key never receives credentials');
  daemon.sshCorePort().store.trustSshFingerprint(profile.id, fingerprint);
  const samples = await Promise.all([desktop.rpc<AcceleratorSample>('sampleAccelerators', params), desktop.rpc<AcceleratorSample>('sampleAccelerators', params)]);
  assert.equal(samples[0].devices.length, 5);
  assert.deepEqual(samples[0], samples[1]);
  assert.equal(executions, 1, 'simultaneous requests share the same bounded probe');
});
