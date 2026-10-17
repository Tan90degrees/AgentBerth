import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { electronExecutable } from '../scripts/electron-runtime.mjs';
import { inventory } from '../scripts/installer-payload.mjs';
const { verify, copyPayload } = createRequire(import.meta.url)('../build/verify-payload.cjs');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'berth installer '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload'); await mkdir(path.join(payload, 'resources'), { recursive: true });
  await writeFile(path.join(payload, 'AgentBerth.exe'), 'fixture-executable');
  await writeFile(path.join(payload, 'resources', '中文🙂.txt'), 'payload with Unicode');
  await writeFile(path.join(payload, 'empty'), '');
  await writeFile(path.join(payload, 'resources', 'app.asar'), 'physical archive fixture');
  const manifest = path.join(root, 'inventory.json');
  await writeFile(manifest, JSON.stringify(await inventory(payload)));
  return { payload, manifest };
}
test('installer inventory verifies every staged file including empty and Unicode paths', async t => {
  const { payload, manifest } = await fixture(t);
  const result = await verify(payload, manifest);
  assert.equal(result.files, 4); assert.ok(result.bytes > 0);
});
test('incomplete or corrupted staging fails before an old install can be replaced', async t => {
  const { payload, manifest } = await fixture(t);
  await writeFile(path.join(payload, 'AgentBerth.exe'), 'fixture-Executable');
  await assert.rejects(verify(payload, manifest), /verification failed/);
  await rm(path.join(payload, 'AgentBerth.exe'));
  await assert.rejects(verify(payload, manifest), /ENOENT/);
});
test('installer verifier rejects traversal and case-folded duplicate inventory entries', async t => {
  const { payload, manifest } = await fixture(t);
  const original = JSON.parse(await readFile(manifest, 'utf8'));
  for (const invalid of ['../outside', '/absolute', 'C:/outside', 'resources/../outside']) {
    await writeFile(manifest, JSON.stringify({ version: 1, files: [{ ...original.files[0], path: invalid }] }));
    await assert.rejects(verify(payload, manifest), /Invalid inventory entry/);
  }
  await writeFile(manifest, JSON.stringify({ version: 1, files: [original.files[0], { ...original.files[0], path: original.files[0].path.toUpperCase() }] }));
  await assert.rejects(verify(payload, manifest), /Duplicate inventory path/);
});

test('staged Electron verifies physical ASAR bytes instead of its virtual filesystem', async t => {
  const { payload, manifest } = await fixture(t);
  const child = spawnSync(electronExecutable(), [fileURLToPath(new URL('../build/verify-payload.cjs', import.meta.url)), payload, manifest], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, String(child.error ?? child.stderr));
  assert.match(child.stdout, /VERIFIED: 4 files/);
});

test('payload copy preserves Unicode paths, physical archive bytes and the full inventory', async t => {
  const { payload, manifest } = await fixture(t);
  const target = path.join(path.dirname(payload), 'installed 中文 with spaces');
  const result = await copyPayload(payload, manifest, target);
  assert.deepEqual(await verify(target, manifest), result);
  assert.equal(await readFile(path.join(target, 'resources', 'app.asar'), 'utf8'), 'physical archive fixture');
  const installed = path.join(path.dirname(payload), 'embedded runtime 安装');
  const child = spawnSync(electronExecutable(), [fileURLToPath(new URL('../build/verify-payload.cjs', import.meta.url)), payload, manifest, '--copy-to', installed], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, String(child.error ?? child.stderr));
  assert.match(child.stdout, /INSTALLED: 4 files/);
  assert.deepEqual(await verify(installed, manifest), result);
});
