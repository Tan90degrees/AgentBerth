import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifyRelease(root, directory, commit) {
  const { version } = await json(path.join(root, 'package.json'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release requires a stable numeric version');
  const info = await json(path.join(directory, 'build-info.json'));
  if (info.version !== version || info.commit !== commit || info.packagedSmoke !== 'success' || info.installerSmoke !== 'success' || info.ref !== 'main') throw new Error('Package version, commit, main ref, installer or packaged smoke does not match this release');
  const names = [`AgentBerth-${version}-windows-x64-setup.exe`, `AgentBerth-${version}-windows-x64.zip`];
  const checksums = new Map();
  for (const line of (await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
    if (!match || !names.includes(match[2]) || checksums.has(match[2])) throw new Error('Unexpected or duplicate checksum entry');
    checksums.set(match[2], match[1]);
  }
  if (checksums.size !== names.length) throw new Error('Missing package checksum');
  const files = [];
  for (const name of [...names, 'SHA256SUMS.txt', 'build-info.json']) {
    const file = path.join(directory, name), metadata = await stat(file);
    if (!metadata.isFile() || !metadata.size) throw new Error(`Missing release file: ${name}`);
    const sha256 = await digest(file);
    if (checksums.has(name) && checksums.get(name) !== sha256) throw new Error(`Checksum mismatch: ${name}`);
    files.push({ name, file, size: metadata.size, digest: `sha256:${sha256}` });
  }
  const tag = `v${version}`;
  const notes = await readFile(path.join(root, 'docs', 'releases', `${tag}.md`), 'utf8');
  if (!notes.trim()) throw new Error('Release notes are empty');
  return { version, tag, notes, files, info };
}

const absent = async request => { try { return (await request()).data; } catch (error) { if (error.status === 404) return null; throw error; } };
const matches = (asset, file) => asset?.state === 'uploaded' && asset.size === file.size && asset.digest === file.digest;

// Called only by the main-branch job after both OS checks and packaged smoke.
export async function publishRelease({ github, context, core }, root, directory) {
  if (context.ref !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(context.eventName)) throw new Error('Release is only allowed from main');
  const bundle = await verifyRelease(root, directory, context.sha), repo = context.repo;
  let release = await absent(() => github.rest.repos.getReleaseByTag({ ...repo, tag: bundle.tag }));
  if (!release) {
    const drafts = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
    release = drafts.find(item => item.tag_name === bundle.tag) ?? null;
  }
  let ref = await absent(() => github.rest.git.getRef({ ...repo, ref: `tags/${bundle.tag}` }));
  if (release && !release.draft && ref?.object.sha !== context.sha) {
    core.info(`${bundle.tag} is already published; bump package version for a new release.`);
    return { url: release.html_url, skipped: true };
  }
  if (ref && (ref.object.type !== 'commit' || ref.object.sha !== context.sha)) throw new Error('Existing tag belongs to a different commit; refusing to move it');
  const list = release ? await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: release.id, per_page: 100 }) : [];
  const expected = new Set(bundle.files.map(file => file.name));
  if (list.some(asset => !expected.has(asset.name))) throw new Error('Release has unexpected assets; refusing to publish');
  if (release && !release.draft) {
    if (list.length !== bundle.files.length || !bundle.files.every(file => matches(list.find(asset => asset.name === file.name), file))) throw new Error('Published assets differ; refusing to overwrite them');
    return { url: release.html_url, skipped: true };
  }
  if (!ref) ref = (await github.rest.git.createRef({ ...repo, ref: `refs/tags/${bundle.tag}`, sha: context.sha })).data;
  const body = `${bundle.notes.trim()}\n\n构建提交：${context.sha}\n\n构建与测试：${bundle.info.run}\n`;
  const name = bundle.notes.split(/\r?\n/)[0].replace(/^#+\s*/, '').trim() || `AgentBerth ${bundle.tag}`;
  if (!release) release = (await github.rest.repos.createRelease({ ...repo, tag_name: bundle.tag, target_commitish: context.sha, name, body, draft: true, prerelease: false })).data;
  const uploaded = new Set();
  for (const file of bundle.files) {
    const previous = list.find(asset => asset.name === file.name);
    if (matches(previous, file)) continue;
    if (previous) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: previous.id });
    await github.rest.repos.uploadReleaseAsset({ ...repo, release_id: release.id, name: file.name, headers: { 'content-type': file.name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream', 'content-length': file.size }, data: await readFile(file.file) });
    uploaded.add(file.name);
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: release.id, per_page: 100 });
  if (assets.length !== bundle.files.length || !bundle.files.every(file => {
    const asset = assets.find(item => item.name === file.name);
    return asset?.state === 'uploaded' && asset.size === file.size && (asset.digest ? asset.digest === file.digest : uploaded.has(file.name));
  })) throw new Error('Uploaded release assets are incomplete or inconsistent');
  const main = (await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data;
  if (main.commit.sha !== context.sha) throw new Error('Main advanced while publishing; leaving the release as a draft');
  release = (await github.rest.repos.updateRelease({ ...repo, release_id: release.id, name, body, draft: false, prerelease: false, make_latest: 'true' })).data;
  core.info(`Published ${release.html_url}`);
  return { url: release.html_url, skipped: false };
}
