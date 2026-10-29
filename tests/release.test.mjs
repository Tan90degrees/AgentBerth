import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { verifyRelease, publishRelease } from '../scripts/release.mjs';

const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40);
const hash = data => 'sha256:' + createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'berth-release-')), directory = path.join(root, 'release');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory); await mkdir(path.join(root, 'docs', 'releases'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.8.0' }));
  await writeFile(path.join(root, 'docs', 'releases', 'v0.8.0.md'), '# AgentBerth v0.8.0\n\n发布说明');
  const info = { version: '0.8.0', commit: sha, ref: 'main', packagedSmoke: 'success', installerSmoke: 'success', run: 'https://github.com/Tan90degrees/AgentBerth/actions/runs/1' };
  await writeFile(path.join(directory, 'build-info.json'), '\uFEFF' + JSON.stringify(info));
  let sums = '\uFEFF';
  for (const [name, data] of [['AgentBerth-0.8.0-windows-x64-setup.exe', 'installer'], ['AgentBerth-0.8.0-windows-x64.zip', 'application']]) {
    await writeFile(path.join(directory, name), data); sums += hash(data).slice(7) + '  ' + name + '\r\n';
  }
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums);
  return { root, directory, info };
}
function githubFixture() {
  const state = { ref: null, release: null, assets: [], calls: [], main: sha, failUpload: false, corrupt: false };
  const record = (name, fn) => async args => { state.calls.push([name, args]); return { data: await fn(args) }; };
  const missing = () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
  const github = { rest: {
    git: {
      getRef: record('getRef', () => state.ref ?? missing()),
      createRef: record('createRef', args => state.ref = { object: { type: 'commit', sha: args.sha } }),
    },
    repos: {
      getReleaseByTag: record('getReleaseByTag', () => state.release ?? missing()),
      listReleases: record('listReleases', () => state.release ? [state.release] : []),
      listReleaseAssets: record('listReleaseAssets', () => state.assets),
      createRelease: record('createRelease', args => state.release = { ...args, id: 1, html_url: 'https://github.com/Tan90degrees/AgentBerth/releases/tag/v0.8.0' }),
      deleteReleaseAsset: record('deleteReleaseAsset', args => { state.assets = state.assets.filter(asset => asset.id !== args.asset_id); }),
      uploadReleaseAsset: record('uploadReleaseAsset', args => {
        if (state.failUpload && state.assets.length === 1) { state.failUpload = false; throw new Error('Network interrupted'); }
        const asset = { id: state.assets.length + 1, name: args.name, size: args.data.length, state: 'uploaded', digest: state.corrupt ? 'sha256:wrong' : hash(args.data) };
        state.assets.push(asset); return asset;
      }),
      getBranch: record('getBranch', () => ({ commit: { sha: state.main } })),
      updateRelease: record('updateRelease', args => state.release = { ...state.release, ...args }),
    },
  }, paginate: async (method, args) => (await method(args)).data };
  const context = { ref: 'refs/heads/main', eventName: 'push', sha, repo: { owner: 'Tan90degrees', repo: 'AgentBerth' } };
  return { state, options: { github, context, core: { info() {} } } };
}
const publishes = state => state.calls.filter(([name, args]) => name === 'updateRelease' && args.draft === false);

test('current repository version has matching lock metadata, release notes and changelog before packaging', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const notes = await readFile(path.join(root, 'docs', 'releases', `v${pkg.version}.md`), 'utf8');
  assert.equal(notes.split(/\r?\n/)[0].trim(), `# ${pkg.build.productName} v${pkg.version}`);
  assert.ok(notes.trim().split(/\r?\n/).length > 1, 'release notes must include a description');
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.split(/\r?\n/).some(line => line.trim() === `## v${pkg.version}`), 'current version needs a changelog entry');
});

test('release verifies exact package names, BOM checksums, provenance and notes', async t => {
  const f = await fixture(t), bundle = await verifyRelease(f.root, f.directory, sha);
  assert.equal(bundle.tag, 'v0.8.0'); assert.equal(bundle.files.length, 4);
  assert.ok(bundle.files.every(file => file.size > 0 && /^sha256:[a-f0-9]{64}$/.test(file.digest)));
});

test('failed smoke, wrong commit/version/ref and non-stable versions cannot release', async t => {
  const f = await fixture(t);
  for (const change of [{ packagedSmoke: 'failure' }, { installerSmoke: 'failure' }, { installerSmoke: undefined }, { commit: otherSha }, { version: '0.7.1' }, { ref: 'feat/session-workbench' }]) {
    await writeFile(path.join(f.directory, 'build-info.json'), JSON.stringify({ ...f.info, ...change }));
    await assert.rejects(verifyRelease(f.root, f.directory, sha), /does not match/);
  }
  await writeFile(path.join(f.root, 'package.json'), '{"version":"0.8.0-beta"}');
  await assert.rejects(verifyRelease(f.root, f.directory, sha), /stable/);
});

test('split packaged suites must both pass even if the aggregate claims success', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'build-info.json');
  await writeFile(file, JSON.stringify({ ...f.info, packagedSuites: { workbench: 'success', files: 'success' } }));
  assert.equal((await verifyRelease(f.root, f.directory, sha)).info.packagedSmoke, 'success');
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    for (const failed of ['workbench', 'files']) {
      await writeFile(file, JSON.stringify({ ...f.info, packagedSuites: { workbench: 'success', files: 'success', [failed]: result } }));
      await assert.rejects(verifyRelease(f.root, f.directory, sha), /does not match/);
    }
  }
  await writeFile(file, JSON.stringify({ ...f.info, packagedSuites: null }));
  await assert.rejects(verifyRelease(f.root, f.directory, sha), /does not match/);
});

test('missing, duplicate, traversal and tampered package checksums are rejected', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'SHA256SUMS.txt'), original = await readFile(file, 'utf8');
  for (const text of [original.split('\r\n')[0], original + original, original.replace('AgentBerth-', '../AgentBerth-')]) {
    await writeFile(file, text); await assert.rejects(verifyRelease(f.root, f.directory, sha), /checksum/i);
  }
  await writeFile(file, original); await writeFile(path.join(f.directory, 'AgentBerth-0.8.0-windows-x64.zip'), 'tampered');
  await assert.rejects(verifyRelease(f.root, f.directory, sha), /Checksum mismatch/);
});

test('publishing is gated to main and creates draft, uploads four verified assets, then publishes', async t => {
  const f = await fixture(t), { state, options } = githubFixture();
  await assert.rejects(publishRelease({ ...options, context: { ...options.context, ref: 'refs/heads/feat/test' } }, f.root, f.directory), /only allowed from main/);
  assert.equal(state.calls.length, 0);
  const result = await publishRelease(options, f.root, f.directory);
  assert.equal(result.skipped, false); assert.equal(state.ref.object.sha, sha); assert.equal(state.assets.length, 4); assert.equal(state.release.draft, false);
  assert.equal(state.calls.find(([name]) => name === 'createRelease')[1].draft, true);
  assert.ok(state.calls.findLastIndex(([name]) => name === 'uploadReleaseAsset') < state.calls.findIndex(([name]) => name === 'updateRelease'));
  assert.equal(publishes(state).length, 1);
});

test('interrupted draft uploads resume without publishing incomplete assets', async t => {
  const f = await fixture(t), { state, options } = githubFixture(); state.failUpload = true;
  await assert.rejects(publishRelease(options, f.root, f.directory), /Network interrupted/);
  assert.equal(state.release.draft, true); assert.equal(state.assets.length, 1); assert.equal(publishes(state).length, 0);
  await publishRelease(options, f.root, f.directory);
  assert.equal(state.assets.length, 4); assert.equal(state.calls.filter(([name]) => name === 'uploadReleaseAsset').length, 5); assert.equal(publishes(state).length, 1);
});

test('published releases are idempotent and are never overwritten', async t => {
  const f = await fixture(t), { state, options } = githubFixture();
  await publishRelease(options, f.root, f.directory); const writes = state.calls.length;
  assert.equal((await publishRelease(options, f.root, f.directory)).skipped, true); assert.equal(publishes(state).length, 1);
  assert.ok(state.calls.slice(writes).every(([name]) => !/create|upload|delete|update/.test(name)));
  state.assets[0].digest = 'sha256:wrong';
  await assert.rejects(publishRelease(options, f.root, f.directory), /refusing to overwrite/); assert.equal(publishes(state).length, 1);
});

test('existing conflicting tag is not moved; later main commits require a version bump', async t => {
  const f = await fixture(t), { state, options } = githubFixture(); state.ref = { object: { type: 'commit', sha: otherSha } };
  await assert.rejects(publishRelease(options, f.root, f.directory), /refusing to move/); assert.equal(state.release, null);
  state.release = { id: 1, draft: false, html_url: 'existing' };
  assert.equal((await publishRelease(options, f.root, f.directory)).skipped, true); assert.equal(publishes(state).length, 0);
});

test('main advancement, corrupted upload and unknown assets leave drafts unpublished', async t => {
  for (const kind of ['advanced', 'corrupt', 'unknown']) {
    const f = await fixture(t), { state, options } = githubFixture();
    if (kind === 'advanced') state.main = otherSha;
    if (kind === 'corrupt') state.corrupt = true;
    if (kind === 'unknown') { state.ref = { object: { type: 'commit', sha } }; state.release = { id: 1, draft: true }; state.assets = [{ name: 'unknown', id: 9 }]; }
    await assert.rejects(publishRelease(options, f.root, f.directory), /advanced|inconsistent|unexpected/);
    assert.equal(state.release.draft, true); assert.equal(publishes(state).length, 0);
  }
});

test('release packaging includes a square RGBA icon and Windows ICO sizes down to tray scale', async () => {
  const root = path.resolve(import.meta.dirname, '..'), png = await readFile(path.join(root, 'assets', 'app.png')), ico = await readFile(path.join(root, 'assets', 'app.ico'));
  assert.equal(png.subarray(1,4).toString(), 'PNG'); assert.equal(png.readUInt32BE(16),512); assert.equal(png.readUInt32BE(20),512); assert.equal(png[25],6);
  assert.equal(ico.readUInt16LE(0),0); assert.equal(ico.readUInt16LE(2),1);
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_,i) => ico[6+16*i] || 256);
  for (const size of [16,24,32,48,128,256]) assert.ok(sizes.includes(size));
  for (let i=0;i<ico.readUInt16LE(4);i++) {
    const size = ico[6+16*i] || 256, length = ico.readUInt32LE(6+16*i+8), offset = ico.readUInt32LE(6+16*i+12);
    assert.ok(offset + length <= ico.length);
    if (size === 256) assert.equal(ico.subarray(offset+1,offset+4).toString(),'PNG');
    else {
      assert.equal(ico.readUInt32LE(offset),40); assert.equal(ico.readInt32LE(offset+4),size); assert.equal(ico.readInt32LE(offset+8),size*2);
      assert.equal(ico.readUInt16LE(offset+14),32);
      assert.equal(length,40+size*size*4+Math.ceil(size/32)*4*size);
    }
  }
  const pkg = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.build.win.icon,'assets/app.ico'); assert.ok(pkg.build.extraResources.some(resource => resource.to === 'assets'));
});

test('release verification follows the new product name while retaining old fixture compatibility', async t => {
  const { root, directory } = await fixture(t);
  const { rename } = await import('node:fs/promises');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.8.0', build: { productName: 'StackIsle' } }));
  for (const extension of ['-setup.exe', '.zip']) await rename(path.join(directory, `AgentBerth-0.8.0-windows-x64${extension}`), path.join(directory, `StackIsle-0.8.0-windows-x64${extension}`));
  const sums = await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums.replaceAll('AgentBerth-', 'StackIsle-'));
  const verified = await verifyRelease(root, directory, sha);
  assert.ok(verified.files.some(file => file.name === 'StackIsle-0.8.0-windows-x64-setup.exe'));
});
