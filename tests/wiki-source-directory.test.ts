import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { WikiService } from '../src/wiki/service';
import { WikiStore } from '../src/wiki/store';
import { WikiWorkspace } from '../src/wiki/workspace';
import { prepareSourceDirectory, sourceReference } from '../src/wiki/source-directory';
import { sourceExcerpt } from '../src/wiki/core';
import { materialSegments } from '../src/wiki/material';

async function waitForTask(service: WikiService, id: string) {
  for (let i = 0; i < 400; i++) {
    const task = service.taskStatus(id);
    if (task && ['done', 'failed', 'cancelled'].includes(task.status)) {
      assert.equal(task.status, 'done', task.error);
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('task did not finish');
}

function setup(t: import('node:test').TestContext) {
  const controller = new AbortController();
  return mkdtemp(path.join(os.tmpdir(), 'berth-wiki-sources-')).then(root => {
    t.after(async () => { controller.abort(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
    return { root, signal: controller.signal };
  });
}

test('ZIP source import rejects traversal, portable name collisions, and symlinks', async t => {
  const { root, signal } = await setup(t);
  const file = path.join(root, 'raw.zip');
  const staged = path.join(root, 'stage');
  const pdf = async () => ({ text: '', pages: 0 });
  const bytes = Buffer.from('notes');
  for (const [entries, expected] of [
    [{ '../escape.txt': bytes }, /invalid relative path|无效/],
    [{ 'Dir/a.md': bytes, 'dir/b.txt': bytes }, /路径冲突/],
    [{ 'link.txt': [bytes, { os: 3, attrs: (0o120777 << 16) >>> 0 }] }, /链接或特殊文件/],
  ] as [Parameters<typeof zipSync>[0], RegExp][]) {
    await mkdir(staged);
    await writeFile(file, zipSync(entries));
    await assert.rejects(prepareSourceDirectory(staged, file, 'raw.zip', pdf, signal, () => {}), expected);
    await rm(staged, { recursive: true });
  }
});

test('the model chooses its file order and one proposal retains exact paths, original bytes and evidence', async t => {
  const { root, signal } = await setup(t);
  const store = new WikiStore(path.join(root, 'wiki'));
  const reads: string[] = [], discoveries: string[] = [], query: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const prompt = request.messages.at(-1).content;
    const system = request.messages[0].content;
    let content: string;
    if (system.includes('只读素材目录')) {
      const { listing } = JSON.parse(prompt);
      discoveries.push(listing.directory);
      content = JSON.stringify(listing.directory ? { path: listing.items[0].name } : { directory: '专题' });
    } else if (system.includes('素材摄入')) {
      reads.push(prompt.includes('先整理专家笔记') ? 'notes' : 'article');
      content = '{"summary":"证据","concepts":[]}';
    } else content = JSON.stringify({ summary: '证据', pages: [{ slug: 'report', title: 'Report', body: prompt.includes('先整理专家笔记') ? '结果 A' : '结果 B' }] });
    return Response.json({ choices: [{ message: { content } }] });
  };
  const service = new WikiService({
    store, signal, fetchImpl: query, config: { baseURL: 'http://127.0.0.1:1/v1', authRequired: false, textModel: 'fixture',
      visionModel: '', autoCompile: false, autoApprove: false, lintMinutes: 0, maxContextPages: 4 },
  });
  const uploaded = path.join(root, 'materials.zip'), notes = Buffer.from('先整理专家笔记，然后回查资料。');
  await writeFile(uploaded, zipSync({ 'article.md': Buffer.from('# 文档\n参考笔记内容。'), '专题/专家.txt': notes, '图表/': new Uint8Array() }));
  const source = await service.addSource({ title: '项目资料', text: '', staging: true });
  await waitForTask(service, service.finishSourceUpload(source.id, 'materials.zip', uploaded, () => {}));
  const saved = await service.finalizeSource(source.id, false);
  assert.deepEqual(service.directory(saved.id).items.map(item => [item.kind, item.name]).sort(), [
    ['directory', '专题'], ['directory', '图表'], ['text', 'article.md'],
  ].sort());
  assert.deepEqual(await readFile(store.sourceFile(saved.id, '专题/专家.txt')), notes);
  const task = await waitForTask(service, service.compile(saved.id));
  assert.deepEqual(discoveries, ['', '专题']);
  assert.deepEqual(reads, ['notes', 'article']);
  assert.equal(store.listDrafts().length, 1);
  const proposal = store.getDraft(String(task.result))!;
  assert.equal(proposal.coverage?.complete, true);
  assert.ok(proposal.pages[0].body.includes(sourceReference(saved.id, '专题/专家.txt')));
  assert.equal(sourceExcerpt(saved, '先整理专家笔记，然后回查资料').path, '专题/专家.txt');
  const backup = service.workspace.backup();
  const restored = new WikiStore(path.join(root, 'restored'));
  const workspace = new WikiWorkspace(restored);
  workspace.importBackup(backup);
  assert.deepEqual(await readFile(restored.sourceFile(saved.id, '专题/专家.txt')), notes);
});

test('invalid or repeated directory choices fall back to unread files and never repeat a long file window', async t => {
  const { root, signal } = await setup(t);
  const store = new WikiStore(path.join(root, 'wiki'));
  const long = '全文保留🙂'.repeat(3000) + '末尾证据';
  const entries = { '资料/a.txt': long, '资料/b.txt': 'file B', '资料/c.txt': 'file C', '资料/d.txt': 'file D', 'index.md': '根文件专用字句' };
  const selections = [
    '{"directory":"资料"}', '{"directory":"资料","offset":0}',
    '{"path":"资料/a.txt"}', '{"directory":"","offset":1000}', '{malformed',
  ];
  const reads: string[] = [];
  let choiceCalls = 0, repairs = 0;
  const service = new WikiService({
    store, signal,
    config: { baseURL: 'http://127.0.0.1:1/v1', authRequired: false, textModel: 'fixture', visionModel: '', autoCompile: false, autoApprove: false, lintMinutes: 0, maxContextPages: 4 },
    fetchImpl: async (_url, init) => {
      const messages = JSON.parse(String(init?.body)).messages;
      const system = messages[0].content, user = messages.at(-1).content;
      let content: string;
      if (system.includes('JSON 格式修复器')) { repairs++; content = '{}'; }
      else if (system.includes('只读素材目录')) {
        const { listing, navigation } = JSON.parse(user);
        if (choiceCalls === 0) assert.deepEqual(navigation, [{ directory: '资料', offset: 0 }]);
        if (choiceCalls === 1) { assert.equal(listing.directory, '资料'); assert.deepEqual(navigation, []); }
        content = selections[choiceCalls++] ?? '{}';
      } else if (system.includes('素材摄入')) { reads.push(user); content = '{"summary":"原文","concepts":[]}'; }
      else content = JSON.stringify({ pages: [{ slug: 'report', title: 'Report', body: '原文内容' }] });
      return Response.json({ choices: [{ message: { content } }] });
    },
  });
  const zip = path.join(root, 'sources.zip');
  await writeFile(zip, zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)]))));
  const source = await service.addSource({ title: '多文件', text: '', staging: true });
  await waitForTask(service, service.finishSourceUpload(source.id, 'sources.zip', zip, () => {}));
  await service.finalizeSource(source.id, false);
  const task = await waitForTask(service, service.compile(source.id));
  const windows = [...materialSegments(long)];
  assert.equal(choiceCalls, selections.length);
  assert.equal(repairs, 0, 'invalid navigation does not send format-repair requests');
  for (const [index, window] of windows.entries()) assert.ok(reads[index].includes(window.text), 'the selected file is read through its tail before selecting again');
  for (const text of Object.values(entries).slice(1)) assert.equal(reads.filter(prompt => prompt.includes(text)).length, 1, text);
  const drafts = store.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, task.result);
  assert.deepEqual(drafts[0].coverage, { characters: Object.values(entries).reduce((sum, text) => sum + text.length, 0), segments: windows.length + 4, complete: true });
  for (const name of Object.keys(entries)) assert.ok(drafts[0].pages.some(page => page.body.includes(sourceReference(source.id, name))), name);
});

test('forward pagination is offered and deep directory navigation cannot starve file reads', async t => {
  const { root, signal } = await setup(t);
  const store = new WikiStore(path.join(root, 'wiki'));
  const deep = 'z/one/two/three/four/five/six/seven/deep.txt';
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`dir-${i}/`, new Uint8Array()]));
  files[deep] = Buffer.from('deep evidence');
  files['index.md'] = Buffer.from('root evidence');
  const visited: string[] = [];
  const service = new WikiService({
    store, signal,
    config: { baseURL: 'http://127.0.0.1:1/v1', authRequired: false, textModel: 'fixture', visionModel: '', autoCompile: false, autoApprove: false, lintMinutes: 0, maxContextPages: 4 },
    fetchImpl: async (_url, init) => {
      const messages = JSON.parse(String(init?.body)).messages;
      let result: unknown = { pages: [{ slug: 'report', title: 'Report', body: 'evidence' }] };
      if (messages[0].content.includes('只读素材目录')) {
        const { navigation, listing } = JSON.parse(messages.at(-1).content);
        visited.push(listing.directory);
        result = navigation[0];
        if (visited.length === 1) assert.deepEqual(result, { directory: '', offset: 20 });
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    },
  });
  const uploaded = path.join(root, 'deep.zip');
  await writeFile(uploaded, zipSync(files));
  const source = await service.addSource({ title: '深层目录', text: '', staging: true });
  await waitForTask(service, service.finishSourceUpload(source.id, 'deep.zip', uploaded, () => {}));
  await service.finalizeSource(source.id, false);
  const task = await waitForTask(service, service.compile(source.id));
  assert.deepEqual(visited, ['', '', 'z', 'z/one', 'z/one/two', 'z/one/two/three']);
  const draft = store.getDraft(String(task.result))!;
  assert.equal(draft.coverage?.segments, 2);
  for (const name of [deep, 'index.md']) assert.ok(draft.pages.some(page => page.body.includes(sourceReference(source.id, name))), name);
});
