import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AppUpdates } from '../src/main/app-updates';
import { UpdateStore, selectUpdate, cleanStorage, fileHash } from '../src/main/update-files';
import { extractUpdate } from '../src/main/update-extract';
import { compareVersions, parseUpdateManifest, releaseAsset, updateNames, updatePath, RELEASE_API, RELEASE_REPOSITORY } from '../src/shared/update-format.mjs';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const runtime = { electron: '44.7.0', platform: 'win32', arch: 'x64' };
const resume = { storage: { 'berth.test': 'keep' }, main: null, ssh: null, sshSession: '' };
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'berth-update-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new UpdateStore(root), archive = Buffer.from('fixture archive');
  const files = [{ path: 'app.asar', data: 'physical archive' }, { path: 'mcp/server.cjs', data: 'module.exports={}' }, { path: 'docs/说明.md', data: '说明' }];
  const manifest = (version = '0.16.1') => ({ schema: 1, bootstrap: 1, version, ...runtime, protocol: 1, minimumBackendApi: 35, bundle: { name: updateNames(version).bundle, size: archive.length, sha256: hash(archive) }, files: files.map(f => ({ path: f.path, size: Buffer.byteLength(f.data), sha256: hash(f.data) })) });
  const write = (version = '0.16.1') => { const dir = store.versionRoot(version); fs.mkdirSync(dir, { recursive: true }); for (const f of files) { const target = path.join(dir, f.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.data); } fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify(manifest(version))); return dir; };
  const names = updateNames('0.16.1'), base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v0.16.1/`;
  const release = { tag_name: 'v0.16.1', draft: false, prerelease: false, assets: [names.bundle,names.manifest].map(name => ({ name, state: 'uploaded', size: name.endsWith('.zip') ? archive.length : 1024, browser_download_url: base + name })) };
  const calls: string[] = []; let download = archive, fail = false;
  const manager = () => new AppUpdates({ store, ...runtime, version: '0.16.0', supported: true, publish() {}, fetch: async url => { calls.push(url); if (fail) throw new Error('offline'); return url === RELEASE_API ? Response.json(release) : url.endsWith('.json') ? Response.json(manifest()) : new Response(new Uint8Array(download)); }, extract: async (_zip, destination) => { for (const f of files) { const target = path.join(destination, f.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.data); } } });
  return { root, store, archive, files, manifest, write, release, calls, manager, corrupt() { download = Buffer.from('bad'); }, offline() { fail = true; } };
}
test('update metadata enforces stable versions, portable paths, official assets and bounded unique files', t => {
  const f = fixture(t); assert.equal(compareVersions('0.16.10','0.16.9'),1); assert.equal(compareVersions('1.0.0','1.0.0'),0);
  for (const v of ['01.0.0','v1.0.0','1.0.0-beta','../x']) assert.throws(() => compareVersions(v,'0.1.0'));
  for (const p of ['../x','a/../b','/root','C:/x','a\\b','nul.txt','dir/CON','a.','a//b']) assert.throws(() => updatePath(p));
  assert.equal(updatePath('docs/中文.md'),'docs/中文.md');
  for (const change of [{ bootstrap: 2 }, { minimumBackendApi: 0 }, { files: [...f.manifest().files, f.manifest().files[0]] }, { files: f.manifest().files.slice(1) }]) assert.throws(() => parseUpdateManifest({ ...f.manifest(), ...change }));
  assert.ok(releaseAsset(f.release, updateNames('0.16.1').bundle));
  for (const r of [{ ...f.release, prerelease: true }, { ...f.release, assets: [...f.release.assets, f.release.assets[0]] }, { ...f.release, assets: f.release.assets.map(a => ({ ...a, browser_download_url: 'https://example.invalid/' + a.name })) }]) assert.throws(() => releaseAsset(r,updateNames('0.16.1').bundle));
});
test('download verifies payload, activates atomically, confirms and retains the prior usable version', async t => {
  const f = fixture(t), manager = f.manager(); assert.equal((await manager.check()).phase,'available');
  await Promise.all([manager.download(),manager.download()]); assert.equal(manager.state().phase,'ready');
  assert.equal(f.calls.filter(url => url.endsWith('.zip')).length,1); assert.equal(f.store.read().active,null);
  manager.prepare(resume,{ apiVersion: 35, active: true }); assert.equal(f.store.read().pending,true);
  assert.equal(selectUpdate(f.store,'0.16.0',runtime)?.version,'0.16.1'); assert.equal(f.store.read().attempted,true);
  f.store.confirm(); assert.equal(f.store.read().pending,false); assert.equal(f.store.read().resume,null);
  f.write('0.16.2'); f.store.activate('0.16.2',resume); selectUpdate(f.store,'0.16.0',runtime);
  assert.equal(selectUpdate(f.store,'0.16.0',runtime)?.version,'0.16.1','an unconfirmed boot rolls back');
  assert.match(f.store.read().error!,/恢复/);
});
test('corrupt transfers, modified payloads, extra files and incompatible runtimes cannot activate', async t => {
  const f = fixture(t), manager = f.manager(); await manager.check(); f.corrupt(); assert.equal((await manager.download()).phase,'error');
  assert.equal(f.store.read().active,null); assert.equal(f.store.read().staged,null);
  const dir = f.write(); assert.throws(() => f.store.verify('0.16.1',{ ...runtime, electron: '45.0.0' }));
  fs.writeFileSync(path.join(dir,'unlisted.txt'),'extra'); assert.throws(() => f.store.verify('0.16.1',runtime),/清单外/); fs.unlinkSync(path.join(dir,'unlisted.txt'));
  fs.writeFileSync(path.join(dir,'app.asar'),'changed'); assert.throws(() => f.store.verify('0.16.1',runtime),/校验/);
  f.store.activate('0.16.1',resume); assert.equal(selectUpdate(f.store,'0.16.0',runtime),null); assert.equal(f.store.read().active,null);
});
test('verified staged updates work offline and newer backend API never stops a live terminal', async t => {
  const f = fixture(t); f.write(); const disk = f.store.read(); f.store.write({ ...disk, staged: '0.16.1' });
  const manager = f.manager(); assert.equal(manager.state().phase,'ready'); f.offline(); await manager.check(); assert.equal(manager.state().phase,'ready');
  assert.throws(() => manager.prepare(resume,{ apiVersion: 34, active: true }),/终端结束/); assert.equal(f.store.read().active,null);
  manager.prepare(resume,{ apiVersion: 35, active: true }); manager.applyFailed(); assert.equal(manager.state().phase,'ready');
});
test('full installer supersedes old update pointers; corrupt recovery data is ignored safely', t => {
  const f = fixture(t); f.write(); f.store.activate('0.16.1',resume); assert.equal(selectUpdate(f.store,'0.17.0',runtime),null); assert.equal(f.store.read().active,null); assert.equal(f.store.read().pending,false);
  fs.writeFileSync(path.join(f.store.root,'state.json'),JSON.stringify({ ...f.store.read(), resume: { storage: { token: 'foreign' } } })); assert.equal(f.store.read().resume,null);
  assert.throws(() => cleanStorage({ token: 'foreign' })); assert.throws(() => cleanStorage({ 'berth.x': 'x'.repeat(300000) }));
  assert.deepEqual(cleanStorage(resume.storage),resume.storage);
});
test('update verifier reads physical ASAR bytes and rejects symbolic links', { skip: process.platform === 'win32' ? 'creating links requires Windows developer mode' : false }, t => {
  const f = fixture(t), dir = f.write(); const target = path.join(dir,'docs/说明.md'); fs.unlinkSync(target); fs.symlinkSync(path.join(dir,'app.asar'),target); assert.throws(() => f.store.verify('0.16.1',runtime));
});
test('Windows ZIP extraction supports Unicode/long paths and rejects traversal, links and collisions before writing', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), destination = path.join(f.root,'out'), zip = path.join(f.root,'input.zip'); fs.mkdirSync(destination);
  const python = process.env.PYTHON ?? 'python';
  const make = (entries: [string,number][]) => execFileSync(python,['-I','-c',`import sys,json,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for name,mode in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(name);i.external_attr=mode<<16;z.writestr(i,b'content')`,zip,JSON.stringify(entries)],{ windowsHide: true });
  const name = '目录/' + 'long-segment/'.repeat(25) + '说明.md'; make([[name,0o100644]]); await extractUpdate(zip,destination,new AbortController().signal);
  assert.equal(fs.readFileSync(path.join(destination,...name.split('/')),'utf8'),'content');
  for (const entries of [[['../escape',0o100644]],[['good',0o100644],['GOOD',0o100644]],[['link',0o120777]],[['nul.txt',0o100644]]] as [string,number][][]) {
    fs.rmSync(destination,{ recursive:true,force:true }); fs.mkdirSync(destination); make(entries);
    await assert.rejects(extractUpdate(zip,destination,new AbortController().signal)); assert.deepEqual(fs.readdirSync(destination),[]);
  }
});
