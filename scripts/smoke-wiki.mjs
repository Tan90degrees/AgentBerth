import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const folder = await mkdtemp(path.join(os.tmpdir(), 'berth-wiki-window-'));
await mkdir('test-results', { recursive: true });
const requests = [];
const model = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body || '{}');
  const joined = JSON.stringify(payload.messages ?? []);
  requests.push(joined);
  let content;
  if (joined.includes('素材摄入')) content = JSON.stringify({ summary: '关于向量检索的素材', concepts: [{ title: '向量检索', kind: 'concept', summary: '用嵌入召回', relevance: 0.9 }], claims: ['召回与精度需要平衡'], contradictions: [] });
  else if (joined.includes('编译（Compile）')) content = JSON.stringify({ summary: '编译出两页', log: '窗口验证编译', contradictions: [], pages: [
    { slug: '向量检索', title: '向量检索', kind: 'concept', summary: '用嵌入召回候选', tags: ['检索'], body: '# 向量检索\n\n用嵌入召回候选，见 [[重排序]]。', sources: [] },
    { slug: '重排序', title: '重排序', kind: 'concept', summary: '提升精度', tags: [], body: '# 重排序\n\n提升精度，见 [[向量检索]]。', sources: [] },
  ] });
  else if (joined.includes('查询（Query）')) content = '要点：召回后需要重排序 [[向量检索]]，依据见 [[重排序]]。';
  else if (joined.includes('体检（Lint）')) content = JSON.stringify({ contradictions: [], orphans: [], missing: [], stale: [], suggestions: ['补充混合检索页面'] });
  else content = '可用';
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const port = model.address().port;

let application;
const errors = [];
const step = value => console.log('STEP', value);
const until = async (check, label) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('timeout: ' + label);
};
try {
  const args = [path.resolve('.'), '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + path.join(folder, 'profile')];
  const env = { ...process.env, AGENTBERTH_DATA_DIR: path.join(folder, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  step('launch isolated window');
  application = await electron.launch({ args, env, timeout: 30000 });
  const page = await application.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const ext = (request) => page.evaluate(value => window.berth.extensions(value), request);
  const call = (command, params = {}) => ext({ action: 'call', id: 'notes-wiki', command, params }).then(value => value);
  const rpc = (method, params = {}) => page.evaluate(({ method, params }) => window.berth.rpc(method, params), { method, params });
  const waitTask = async id => {
    await until(async () => {
      const task = await call('task', { id });
      return task && ['done', 'failed'].includes(task.status);
    }, 'task ' + id);
    const task = await call('task', { id });
    assert.equal(task.status, 'done', task.error);
    return task.result;
  };

  await until(async () => {
    const snapshot = await ext({ action: 'list' });
    return snapshot.plugins.some(plugin => plugin.manifest.id === 'notes-wiki' && plugin.status === 'active');
  }, 'notes-wiki extension active');
  step('extension is active');

  await ext({ action: 'configure', id: 'notes-wiki', config: {
    baseURL: `http://127.0.0.1:${port}/v1`, textModel: 'mock-text', visionModel: 'mock-vision',
    autoCompile: false, autoApprove: false, lintMinutes: 0, maxContextPages: 8,
  } });
  await call('set_api_key', { value: 'sk-window-test' });
  const status = await call('status');
  assert.equal(status.ready, true);
  assert.equal(status.model.textModel, 'mock-text');
  step('model configured against local mock endpoint');

  assert.equal((await call('list_skills')).length, 5);
  await call('save_skill', { name: 'window-skill', description: '窗口验证创建', kind: 'custom', triggers: ['验证'], body: '# 指令\n只回答中文' });
  assert.equal((await call('get_skill', { name: 'window-skill' })).body.trim(), '# 指令\n只回答中文');
  assert.ok((await call('export_skill', { name: 'window-skill' })).startsWith('---'));
  assert.ok((await call('schema')).includes('三层'));
  step('skill CRUD + schema available from the real daemon');

  const source = await call('add_source', { title: '窗口素材', text: '向量检索与重排序的关系。' });
  assert.equal(source.compiled, false);
  const draftId = await waitTask(await call('compile', { sourceId: source.id }));
  const drafts = await call('list_drafts', { status: 'pending' });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].pages.length, 2);
  assert.equal((await call('list_pages')).length, 0, 'nothing published before approval');
  assert.ok(requests.some(request => request.includes('素材摄入')) && requests.some(request => request.includes('编译（Compile）')));
  step('ingest + compile produced a reviewable draft');

  const diff = await call('draft_page', { id: draftId, slug: '向量检索' });
  assert.ok(diff.diff.some(line => line.type === 'add'));
  await waitTask(await call('review_draft', { id: draftId, action: 'approve' }));
  const pages = await call('list_pages');
  assert.equal(pages.length, 2);
  assert.ok((await call('index')).includes('[[向量检索|向量检索]]'));
  step('approval published pages and rebuilt index.md');

  const answer = await waitTask(await call('ask', { question: '召回和精度怎么处理？' }));
  assert.ok(answer.answer.includes('[[向量检索]]'));
  assert.deepEqual(answer.citations.sort(), ['向量检索', '重排序'].sort());
  const archived = await call('save_answer', { question: '召回和精度怎么处理？', answer: answer.answer, citations: answer.citations });
  assert.equal(archived.humanEdited, true);
  const lint = await waitTask(await call('lint'));
  assert.ok(lint.suggestions.length > 0);
  step('ask with citations, answer archiving and lint all work');

  step('open the sandboxed extension view');
  await page.getByRole('button', { name: '笔记 Wiki · 知识库' }).click();
  const frame = page.frameLocator('iframe.extension-view');
  await until(async () => (await frame.locator('#statusText').innerText()).includes('页'), 'wiki view status');
  await until(async () => (await frame.locator('#pageList').innerText()).includes('向量检索'), 'page list');
  await until(async () => (await frame.locator('#pageView').locator('.card').count()) > 0, 'first page auto-selected');
  await frame.locator('#pageList [data-action="openPage"]', { hasText: '向量检索' }).first().click();
  await until(async () => (await frame.locator('#pageView').innerText()).includes('向量检索'), 'selected page detail');
  await frame.locator('[data-tab="skills"]').click();
  await until(async () => (await frame.locator('#skillList').innerText()).includes('window-skill'), 'skill list');
  await frame.locator('[data-tab="review"]').click();
  await until(async () => (await frame.locator('#draftList').innerText()).includes('已发布'), 'draft list');
  await frame.locator('[data-tab="settings"]').click();
  await until(async () => (await frame.locator('#settingsView').innerText()).includes('mock-text'), 'settings view');
  await page.screenshot({ animations: 'disabled', path: 'test-results/wiki-window-settings.png' });
  await frame.locator('[data-tab="wiki"]').click();
  await until(async () => (await frame.locator('#pageView').innerText()).includes('向量检索'), 'page detail');
  await page.screenshot({ animations: 'disabled', path: 'test-results/wiki-window-pages.png' });
  step('view tabs render live daemon data');

  // The static buttons are delegated through [data-action]; exercise them for
  // real so a missing attribute can never ship as a dead primary action again.
  await frame.locator('[data-tab="sources"]').click();
  await frame.locator('#newSource').click();
  await until(async () => (await frame.locator('#sourceView [data-field="text"]').count()) > 0, 'new source form');
  await frame.locator('#sourceView [data-action="cancelSource"]').click();
  await frame.locator('[data-tab="wiki"]').click();
  await frame.locator('#newPage').click();
  await until(async () => (await frame.locator('#pageView [data-field="slug"]').count()) > 0, 'new page form');
  await frame.locator('#pageView [data-action="cancelPage"]').click();
  await frame.locator('[data-tab="skills"]').click();
  await frame.locator('#newSkill').click();
  await until(async () => (await frame.locator('#skillView [data-field="name"]').count()) > 0, 'new skill form');
  await frame.locator('#skillView [data-action="cancelSkill"]').click();
  await frame.locator('[data-tab="ask"]').click();
  await frame.locator('#question').fill('窗口里直接提问可以吗？');
  await frame.locator('#ask').click();
  await until(async () => (await frame.locator('#answerView').innerText()).includes('向量检索'), 'ask button produced an answer');
  await frame.locator('[data-tab="review"]').click();
  const lintBefore = (await call('status')).tasks.filter(task => task.kind === 'lint').length;
  await frame.locator('#runLint').click();
  await until(async () => (await call('status')).tasks.filter(task => task.kind === 'lint').length > lintBefore, 'lint button enqueued a task');
  step('all primary iframe buttons are wired');

  assert.equal((await frame.locator('#error').innerText()).trim(), '', 'no command errors in the view');
  assert.deepEqual(errors, [], 'no renderer page errors');
  console.log('RESULT OK', JSON.stringify({ pages: (await call('list_pages')).length, requests: requests.length, errors }));
} catch (error) {
  console.error('RESULT FAIL', error);
  if (application) {
    try { const page = await application.firstWindow(); await page.screenshot({ path: 'test-results/wiki-window-failure.png' }); } catch { /* ignore */ }
  }
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
  model.close();
  await rm(folder, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
