import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitWorkspace } from '../src/daemon/git';
import type { GitOperation } from '../src/shared/protocol';
import { parseDiff } from '../src/shared/git-diff';

const execute = promisify(execFile);
async function fixture(t: any, initial = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'berth-changes-')), service = new GitWorkspace();
  const git = async (...args: string[]) => (await execute('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true })).stdout.trim();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Change Fixture'); await git('config', 'user.email', 'changes@example.invalid'); await git('config', 'commit.gpgsign', 'false');
  if (initial) { await writeFile(path.join(root, 'base.txt'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'base'); }
  const act = async (action: GitOperation['action'], extra: Partial<GitOperation> = {}) => { const status = await service.status(root); return service.operate(root, { projectId: 'fixture', action, expected: { root: status.root, head: status.head, branch: status.branch }, ...extra }); };
  const diff = (filename: string, staged = false, cwd = root, projectPath = false) => service.diff(cwd, { projectId: 'fixture', path: filename, staged, projectPath });
  return { root, service, git, act, diff };
}

test('selected literal filenames stage independently; partial index and worktree diffs stay separate and commits include only index content', async t => {
  const { root, git, act, diff } = await fixture(t);
  await writeFile(path.join(root, 'base.txt'), 'staged version\n');
  await writeFile(path.join(root, 'literal[1].txt'), 'selected\n');
  await writeFile(path.join(root, 'literal1.txt'), 'not selected\n');
  assert.match((await diff('literal[1].txt')).patch, /\+selected/);
  await act('stage', { paths: ['base.txt', 'literal[1].txt'] });
  assert.equal(await git('diff', '--cached', '--name-only'), 'base.txt\nliteral[1].txt');
  await writeFile(path.join(root, 'base.txt'), 'working version\n');
  assert.match((await diff('base.txt', true)).patch, /\+staged version/);
  assert.doesNotMatch((await diff('base.txt', true)).patch, /working version/);
  assert.match((await diff('base.txt')).patch, /-staged version\n\+working version/);
  await act('commit', { message: 'Commit staged files\n\nBody preserved' });
  assert.equal(await git('show', 'HEAD:base.txt'), 'staged version');
  assert.equal(await readFile(path.join(root, 'base.txt'), 'utf8'), 'working version\n');
  assert.equal(await git('ls-files', 'literal1.txt'), '');
  assert.match(await git('log', '-1', '--format=%B'), /Body preserved/);
});

test('unborn repositories unstage even after edits, preserve files and create the first commit', async t => {
  const { root, act, git, diff } = await fixture(t, false);
  await writeFile(path.join(root, 'first.md'), '# First\n');
  await act('stage', { paths: ['first.md'] });
  assert.match((await diff('first.md', true)).patch, /\+# First/);
  await writeFile(path.join(root, 'first.md'), '# Edited\n');
  await act('unstage', { paths: ['first.md'] });
  assert.equal(await git('ls-files'), ''); assert.equal(await readFile(path.join(root, 'first.md'), 'utf8'), '# Edited\n');
  await act('stage', { paths: ['first.md'] }); await act('commit', { message: 'Initial commit' });
  assert.equal(await git('show', 'HEAD:first.md'), '# Edited');
});

test('renames, deletions and index removal preserve the working tree', async t => {
  const { root, act, git, diff } = await fixture(t);
  await rename(path.join(root, 'base.txt'), path.join(root, 'renamed.txt'));
  await act('stage', { paths: ['base.txt', 'renamed.txt'] });
  assert.match((await diff('renamed.txt', true)).patch, /rename from base.txt/);
  await writeFile(path.join(root, 'renamed.txt'), 'base\nx\n');
  await act('stage', { paths: ['renamed.txt'] });
  await act('unstage', { paths: ['renamed.txt'] });
  assert.equal(await git('diff', '--cached', '--name-only'), '');
  assert.equal(await readFile(path.join(root, 'renamed.txt'), 'utf8'), 'base\nx\n');
  assert.match((await diff('base.txt')).patch, /deleted file mode/);
});

test('diff handles binary, nested project scope, empty files and oversized text; invalid mutation paths are rejected', async t => {
  const { root, act, diff, service } = await fixture(t);
  await mkdir(path.join(root, 'nested')); await writeFile(path.join(root, 'nested', '中文 文件.txt'), 'hello\n');
  assert.match((await diff('中文 文件.txt', false, path.join(root, 'nested'), true)).patch, /\+hello/);
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 255])); assert.equal((await diff('binary.bin')).binary, true);
  await writeFile(path.join(root, 'empty.txt'), ''); assert.match((await diff('empty.txt')).message!, /为空/);
  await writeFile(path.join(root, 'large.txt'), '文件🙂\n'.repeat(60000)); const large = await diff('large.txt'); assert.equal(large.truncated, true); assert.equal(large.binary, false);
  await assert.rejects(act('stage', { paths: ['../outside'] }), /路径无效/);
  await assert.rejects(act('stage', { paths: ['.git/config'] }), /路径无效/);
  await assert.rejects(act('stage', { paths: ['nested'] }), /状态已变化/);
  await assert.rejects(act('commit', { message: 'nothing' }), /没有已暂存/);
  await assert.rejects(service.diff(root, { projectId: 'fixture', path: '../outside', staged: false, projectPath: false }), /路径无效/);
});

test('unified diff line numbers distinguish file headers, additions, removals and multiple hunks', () => {
  const parsed = parseDiff('--- a/file\n+++ b/file\n@@ -2,2 +2,2 @@\n same\n-old\n+new\n@@ -10 +20 @@\n-removed\n+added\n\\ No newline at end of file\n');
  assert.equal(parsed.lines[1].kind, 'meta');
  assert.deepEqual(parsed.lines[3], { kind: 'context', text: 'same', oldLine: 2, newLine: 2 });
  assert.equal(parsed.lines[4].oldLine, 3); assert.equal(parsed.lines[5].newLine, 3);
  assert.equal(parsed.lines[7].oldLine, 10); assert.equal(parsed.lines[8].newLine, 20);
  assert.equal(parseDiff('a\nb\nc', 2).truncated, true);
});
