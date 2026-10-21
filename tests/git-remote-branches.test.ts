import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitWorkspace } from '../src/daemon/git';
import type { GitOperation, GitRemoteBranch } from '../src/shared/protocol';
const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await execute('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })).stdout.trim(); }
async function fixture(t: any) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'berth-remote-中文 ')), remote = path.join(dir, 'remote.git'), a = path.join(dir, 'a'), b = path.join(dir, 'b');
  const service = new GitWorkspace();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  await git(dir, 'init', '--bare', '--initial-branch=main', remote); await git(dir, 'clone', remote, a);
  await git(a, 'config', 'user.name', 'Fixture'); await git(a, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(a, 'base.txt'), 'base\n'); await git(a, 'add', '.'); await git(a, 'commit', '-m', 'base'); await git(a, 'push', '-u', 'origin', 'main');
  await git(dir, 'clone', remote, b); await git(b, 'config', 'user.name', 'Fixture'); await git(b, 'config', 'user.email', 'fixture@example.invalid');
  const operation = async (action: GitOperation['action'], extra: Partial<GitOperation> = {}) => { const s = await service.status(a); return service.operate(a, { projectId: 'fixture', action, expected: { root: s.root, branch: s.branch, head: s.head }, remote: 'origin', ...extra }); };
  const select = async (branch: string, remote = 'origin') => { const item = (await service.status(a)).remoteBranches?.find(item => item.remote === remote && item.branch === branch); assert.ok(item, `missing ${remote}/${branch}`); return item; };
  const switchTo = (item: GitRemoteBranch, localBranch?: string) => operation('switchRemote', { remote: item.remote, branch: item.branch, remoteRef: item.ref, remoteHead: item.head, ...(localBranch ? { localBranch } : {}) });
  return { dir, remote, a, b, service, operation, select, switchTo };
}

test('remote branches exclude symbolic HEAD, distinguish remotes and follow custom fetch mappings', async t => {
  const { a, b, remote, operation, service, select } = await fixture(t);
  await git(b, 'push', 'origin', 'HEAD:refs/heads/feature/中文');
  await operation('fetch'); await git(a, 'remote', 'set-head', 'origin', '-a');
  await git(a, 'remote', 'add', 'team/upstream', remote);
  await operation('fetch', { remote: 'team/upstream' });
  assert.equal((await select('feature/中文', 'team/upstream')).remote, 'team/upstream');
  assert.ok(!(await service.status(a)).remoteBranches?.some(item => item.branch === 'HEAD'));
  await git(a, 'tag', 'main'); // Local branch names must not acquire a heads/ prefix when ambiguous.
  assert.ok((await service.status(a)).branches.includes('main'));
  assert.equal((await service.status(a)).upstreamRemote, 'origin');
  await git(a, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/vendor/origin/*');
  await operation('fetch');
  assert.equal((await select('feature/中文')).ref, 'refs/vendor/origin/feature/中文');
  const custom = await select('feature/中文');
  const result = await operation('switchRemote', { remote: custom.remote, branch: custom.branch, remoteRef: custom.ref, remoteHead: custom.head });
  assert.equal(result.status.upstreamRemote, 'origin'); assert.equal(result.status.upstreamBranch, 'feature/中文');
  await git(a, 'config', '--add', 'remote.origin.fetch', '^refs/heads/feature/*');
  assert.ok(!(await service.status(a)).remoteBranches?.some(item => item.remote === 'origin' && item.branch.startsWith('feature/')));
});

test('remote checkout creates tracking branches and reuses renamed tracking branches without resetting local commits', async t => {
  const { a, b, service, operation, select, switchTo } = await fixture(t);
  await git(b, 'push', 'origin', 'HEAD:refs/heads/feature/topic'); await operation('fetch');
  const target = await select('feature/topic'); const created = await switchTo(target, 'my-topic');
  assert.equal(created.status.branch, 'my-topic'); assert.equal(created.status.upstream, 'origin/feature/topic');
  await writeFile(path.join(a, 'local.txt'), 'keep commit\n'); await git(a, 'add', '.'); await git(a, 'commit', '-m', 'local commit');
  const head = await git(a, 'rev-parse', 'HEAD');
  await operation('switch', { branch: 'main' });
  const updated = await select('feature/topic'); assert.deepEqual(updated.localBranches, ['my-topic']);
  const reused = await switchTo(updated); assert.equal(reused.status.branch, 'my-topic'); assert.equal(reused.status.head, head); assert.equal(reused.status.ahead, 1);
  await operation('switch', { branch: 'main' }); await git(a, 'branch', 'feature/topic');
  await assert.rejects(switchTo(await select('feature/topic'), 'feature/topic'), /已存在且未跟踪/);
  assert.equal((await service.status(a)).branch, 'main');
  await switchTo(await select('feature/topic'), 'alternative'); assert.equal((await service.status(a)).upstreamBranch, 'feature/topic');
});

test('switching remote branches preserves unrelated edits and Git refuses overlapping or untracked overwrites', async t => {
  const { a, b, service, operation, select, switchTo } = await fixture(t);
  await git(b, 'switch', '-c', 'feature/changed'); await writeFile(path.join(b, 'base.txt'), 'remote change\n'); await writeFile(path.join(b, 'collision.txt'), 'remote file\n'); await git(b, 'add', '.'); await git(b, 'commit', '-m', 'changes'); await git(b, 'push', '-u', 'origin', 'feature/changed');
  await operation('fetch'); const target = await select('feature/changed');
  await writeFile(path.join(a, 'base.txt'), 'local change\n');
  await assert.rejects(switchTo(target), /覆盖本地改动/); assert.equal((await service.status(a)).branch, 'main');
  assert.equal(await readFile(path.join(a, 'base.txt'), 'utf8'), 'local change\n'); assert.ok(!(await service.status(a)).branches.includes('feature/changed'));
  await git(a, 'restore', 'base.txt'); await writeFile(path.join(a, 'collision.txt'), 'local untracked\n');
  await assert.rejects(switchTo(target), /overwritten|覆盖本地改动/); assert.equal(await readFile(path.join(a, 'collision.txt'), 'utf8'), 'local untracked\n');
  await rm(path.join(a, 'collision.txt')); await writeFile(path.join(a, 'unrelated.txt'), 'keep\n');
  await switchTo(target); assert.equal(await readFile(path.join(a, 'unrelated.txt'), 'utf8'), 'keep\n'); assert.equal(await git(a, 'stash', 'list'), '');
});

test('stale or foreign remote refs are rejected and fetch removes deleted remote branches', async t => {
  const { a, b, service, operation, select, switchTo } = await fixture(t);
  await git(a, 'config', 'fetch.pruneTags', 'true'); await git(a, 'tag', 'local-only');
  await git(b, 'push', 'origin', 'HEAD:refs/heads/topic'); await operation('fetch'); const old = await select('topic');
  assert.equal(await git(a, 'show-ref', '--verify', 'refs/tags/local-only').then(() => true, () => false), true);
  await writeFile(path.join(b, 'new.txt'), 'new'); await git(b, 'add', '.'); await git(b, 'commit', '-m', 'new'); await git(b, 'push', 'origin', 'HEAD:refs/heads/topic'); await operation('fetch');
  await assert.rejects(switchTo(old), /提交已变化/);
  const current = await select('topic');
  await assert.rejects(operation('switchRemote', { remote: 'other', branch: current.branch, remoteRef: current.ref, remoteHead: current.head }), /远端分支/);
  await assert.rejects(operation('switchRemote', { remote: 'origin', branch: current.branch, remoteRef: 'refs/heads/main', remoteHead: current.head }), /远端分支/);
  await assert.rejects(switchTo(current, '--bad'), /invalid|无效/);
  assert.equal((await service.status(a)).branch, 'main');
  await git(b, 'push', 'origin', '--delete', 'topic'); await operation('fetch');
  assert.ok(!(await service.status(a)).remoteBranches?.some(item => item.branch === 'topic'));
  await assert.rejects(switchTo(current), /远端分支/);
});

test('fetch never prunes local branches or tags when a custom refspec maps into local namespaces', async t => {
  const { a, b, service, operation } = await fixture(t);
  await git(b, 'push', 'origin', 'HEAD:refs/heads/topic');
  await git(a, 'config', 'fetch.prune', 'true'); await git(a, 'config', 'fetch.pruneTags', 'true');
  await git(a, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/heads/mirror/*');
  await git(a, 'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/tags/mirror/*');
  await operation('fetch');
  await git(b, 'push', 'origin', '--delete', 'topic');
  await operation('fetch');
  assert.equal(await git(a, 'show-ref', '--verify', 'refs/heads/mirror/topic').then(() => true, () => false), true);
  assert.equal(await git(a, 'show-ref', '--verify', 'refs/tags/mirror/topic').then(() => true, () => false), true);
  assert.ok(!(await service.status(a)).remoteBranches?.some(item => item.ref.startsWith('refs/heads/') || item.ref.startsWith('refs/tags/')));
});
