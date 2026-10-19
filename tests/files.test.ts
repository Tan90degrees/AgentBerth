import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitWorkspace } from '../src/daemon/git';
import { ProjectFiles, MAX_TEXT_BYTES, MAX_IMAGE_BYTES } from '../src/daemon/files';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { FilePreview, Project, ProjectFilePage } from '../src/shared/protocol';

const execute = promisify(execFile);
async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'berth 文件 '));
  const project = path.join(root, 'project'); await mkdir(project);
  const git = new GitWorkspace(), files = new ProjectFiles(git);
  t.after(async () => { await git.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const command = async (...args: string[]) => execute('git', ['-c', 'core.autocrlf=false', '-C', project, ...args], { windowsHide: true });
  return { root, project, files, command };
}

test('directory pages use native Git ignores, negation, nested rules and tracked-file semantics', async t => {
  const { project, files, command } = await fixture(t);
  await command('init');
  await mkdir(path.join(project, 'src')); await mkdir(path.join(project, 'cache'));
  await writeFile(path.join(project, '.gitignore'), 'cache/\n*.log\n!keep.log\n');
  for (const name of ['trace.log', 'keep.log', 'tracked.log', '空 格🙂.log', 'line\nname.log', 'README.md', 'local.txt', 'global.txt']) {
    if (process.platform === 'win32' && name.includes('\n')) continue;
    await writeFile(path.join(project, name), 'text');
  }
  await command('add', '-f', 'tracked.log');
  await writeFile(path.join(project, '.git', 'info', 'exclude'), 'local.txt\n');
  await writeFile(path.join(project, 'global-ignore'), 'global.txt\n');
  await command('config', 'core.excludesFile', path.join(project, 'global-ignore'));
  await writeFile(path.join(project, 'src', '.gitignore'), '*.tmp\n!keep.tmp\n');
  await writeFile(path.join(project, 'src', 'drop.tmp'), 'drop'); await writeFile(path.join(project, 'src', 'keep.tmp'), 'keep');
  await writeFile(path.join(project, 'cache', 'inside.txt'), 'ignored parent');
  const root = await files.list(project);
  assert.equal(root.gitAvailable, true);
  const ignored = new Map(root.entries.map(entry => [entry.name, entry.ignored]));
  for (const name of ['cache', 'trace.log', '空 格🙂.log', 'local.txt', 'global.txt']) assert.equal(ignored.get(name), true, name);
  assert.equal(ignored.get('keep.log'), false); assert.equal(ignored.get('tracked.log'), false);
  if (process.platform !== 'win32') assert.equal(ignored.get('line\nname.log'), true);
  const nested = await files.list(project, 'src');
  assert.equal(nested.entries.find(entry => entry.name === 'drop.tmp')!.ignored, true);
  assert.equal(nested.entries.find(entry => entry.name === 'keep.tmp')!.ignored, false);
  assert.equal((await files.list(project, 'cache')).entries[0].ignored, true);
  assert.equal(root.entries[0].kind, 'directory');
  const first = await files.list(project, '', 0, 2), second = await files.list(project, '', 2, 2);
  assert.equal(first.entries.length, 2); assert.equal(first.nextOffset, 2);
  assert.deepEqual([...first.entries, ...second.entries].map(entry => entry.path), root.entries.slice(0, 4).map(entry => entry.path));
});

test('plain directories remain browsable and file previews decode Unicode, UTF-16, empty files and images', async t => {
  const { project, files } = await fixture(t);
  const text = '中文🙂\nconst value = 1;\n';
  await writeFile(path.join(project, 'code.ts'), text);
  await writeFile(path.join(project, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  const be = Buffer.from(text, 'utf16le'); be.swap16();
  await writeFile(path.join(project, 'be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  await writeFile(path.join(project, 'empty'), ''); await writeFile(path.join(project, 'binary'), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(project, 'invalid'), Buffer.from([0xff, 0xff, 0x80]));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNw2NDwHwAFFAJwhVSspQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(project, 'pixel.png'), png);
  assert.equal((await files.list(project)).gitAvailable, false);
  assert.equal((await files.preview(project, 'code.ts')).content, text);
  assert.equal((await files.preview(project, 'utf16.txt')).content, text);
  assert.equal((await files.preview(project, 'be.txt')).content, text);
  assert.equal((await files.preview(project, 'empty')).kind, 'text');
  assert.equal((await files.preview(project, 'empty')).content, '');
  for (const name of ['binary', 'invalid']) assert.equal((await files.preview(project, name)).kind, 'binary');
  const image = await files.preview(project, 'pixel.png');
  assert.equal(image.kind, 'image'); assert.equal(image.content, `data:image/png;base64,${png.toString('base64')}`);
});

test('previews bound bytes and line count without breaking a UTF-8 character at the boundary', async t => {
  const { project, files } = await fixture(t);
  await writeFile(path.join(project, 'large.ts'), 'a'.repeat(MAX_TEXT_BYTES - 1) + '汉字🙂');
  const large = await files.preview(project, 'large.ts');
  assert.equal(large.kind, 'text'); assert.equal(large.truncated, true);
  assert.equal(large.content, 'a'.repeat(MAX_TEXT_BYTES - 1));
  await writeFile(path.join(project, 'lines.txt'), 'row\n'.repeat(10050));
  const lines = await files.preview(project, 'lines.txt');
  assert.equal(lines.truncated, true); assert.equal(lines.content!.split('\n').length, 10000);
  await writeFile(path.join(project, 'large.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
  const image = await files.preview(project, 'large.png');
  assert.equal(image.kind, 'binary'); assert.equal(image.content, null); assert.match(image.message!, /4 MB/);
});

test('project boundaries reject traversal and outside junctions while allowing internal directory links', async t => {
  const { root, project, files } = await fixture(t);
  await writeFile(path.join(root, 'secret.txt'), 'OUTSIDE');
  await mkdir(path.join(project, 'inside')); await writeFile(path.join(project, 'inside', 'ok.txt'), 'INSIDE');
  await symlink(path.join(project, 'inside'), path.join(project, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(root, path.join(project, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const listing = await files.list(project);
  assert.equal(listing.entries.find(entry => entry.name === 'alias')!.kind, 'directory');
  assert.equal(listing.entries.find(entry => entry.name === 'outside')!.unavailable, true);
  assert.equal((await files.preview(project, 'alias/ok.txt')).content, 'INSIDE');
  for (const name of ['../secret.txt', '..\\secret.txt', path.join(root, 'secret.txt'), 'C:\\Windows\\win.ini', 'outside/secret.txt', 'inside/../inside/ok.txt', 'nul\0name']) await assert.rejects(files.preview(project, name));
  await assert.rejects(files.list(project, 'outside'), /项目目录之外/);
  await assert.rejects(files.preview(project, 'inside'), /普通文件/);
  await assert.rejects(files.preview(project, 'missing.txt'), /刷新目录树/);
});

test('file RPCs use registered project roots and validate directory pagination', async t => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(project, 'hello.ts'), 'export const ready = true;');
  const server = new DaemonServer(path.join(root, 'data'));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); });
  const p = await connection.rpc<Project>('createProject', { name: 'Files', path: project });
  const page = await connection.rpc<ProjectFilePage>('projectFiles', { projectId: p.id });
  assert.equal(page.entries[0].path, 'hello.ts');
  assert.equal((await connection.rpc<FilePreview>('previewFile', { projectId: p.id, path: 'hello.ts' })).content, 'export const ready = true;');
  await writeFile(path.join(project, 'large.png'), Buffer.alloc(MAX_IMAGE_BYTES, 7));
  const pictures = await Promise.all([connection.rpc<FilePreview>('previewFile', { projectId: p.id, path: 'large.png' }), connection.rpc<FilePreview>('previewFile', { projectId: p.id, path: 'large.png' })]);
  assert.ok(pictures.every(picture => picture.kind === 'image' && picture.content!.length > 5 * 1024 * 1024));
  assert.equal((await connection.rpc<ProjectFilePage>('projectFiles', { projectId: p.id })).entries.length, 2);
  await assert.rejects(connection.rpc('projectFiles', { projectId: p.id, limit: 1000 }), /参数无效/);
  await assert.rejects(connection.rpc('previewFile', { projectId: p.id, path: '../secret.txt' }), /路径无效/);
});
