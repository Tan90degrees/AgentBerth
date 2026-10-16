import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inventory } from '../scripts/installer-payload.mjs';
const { verify } = createRequire(import.meta.url)('../build/verify-payload.cjs');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'berth installer '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload'); await mkdir(path.join(payload, 'resources'), { recursive: true });
  await writeFile(path.join(payload, 'AgentBerth.exe'), 'fixture-executable');
  await writeFile(path.join(payload, 'resources', '中文🙂.txt'), 'payload with Unicode');
  await writeFile(path.join(payload, 'empty'), '');
  const manifest = path.join(root, 'inventory.json');
  await writeFile(manifest, JSON.stringify(await inventory(payload)));
  return { payload, manifest };
}
test('installer inventory verifies every staged file including empty and Unicode paths', async t => {
  const { payload, manifest } = await fixture(t);
  const result = await verify(payload, manifest);
  assert.equal(result.files, 3); assert.ok(result.bytes > 0);
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
