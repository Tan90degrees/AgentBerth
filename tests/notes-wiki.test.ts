import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIndex, byteTruncate, draftPages, extractLinks, lineDiff, lintWiki, pageFromDocument, pageHash,
  pageToDocument, parseDocument, parseJsonResponse, searchPages, skillFromDocument,
  skillToDocument, slugify, stringifyDocument, validateSkillName,
} from '../src/wiki/core';
import { completionUrl, maskedKey, userMessage, chat } from '../src/wiki/llm';
import { BUILTIN_SKILLS, DEFAULT_SCHEMA, resolveSkill } from '../src/wiki/prompts';
import { WikiStore } from '../src/wiki/store';
import { WikiService } from '../src/wiki/service';
import { notesWikiManifest } from '../src/wiki/manifest';
import { notesWikiView } from '../src/wiki/view';
import { notesWikiMarkup } from '../src/wiki/view-markup';
import type { WikiConfig, WikiDraft, WikiPage } from '../src/wiki/types';

function temp(t: { after: (fn: () => void) => void }): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-wiki-'));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }));
  return folder;
}
const config = (overrides: Partial<WikiConfig> = {}): WikiConfig => ({
  baseURL: 'https://api.example.com/v1', textModel: 'test-text', visionModel: 'test-vision',
  autoCompile: false, autoApprove: false, lintMinutes: 0, maxContextPages: 8, ...overrides,
});
const page = (slug: string, body: string, extra: Partial<WikiPage> = {}): WikiPage => ({
  slug, title: slug, summary: '摘要 ' + slug, kind: 'concept', sources: [], tags: [],
  body, humanEdited: false, hash: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
});

test('documents round-trip through YAML frontmatter and keep Markdown bodies', () => {
  const original = page('向量检索', '# 向量检索\n\n见 [[混合检索]] 与 [[重排序|Rerank]]。\n\n> 矛盾：旧结论认为召回足够。');
  const text = pageToDocument(original);
  assert.ok(text.startsWith('---\n'));
  const parsed = pageFromDocument('向量检索', text, '2026-01-01T00:00:00.000Z');
  assert.equal(parsed.title, original.title);
  assert.equal(parsed.body.trim(), original.body.trim());
  assert.equal(parsed.kind, 'concept');
  assert.deepEqual(extractLinks(original.body), ['混合检索', '重排序']);
  assert.equal(pageHash(parsed), pageHash(original));
  const { data, body } = parseDocument(stringifyDocument({ name: 'abc', triggers: ['一', '二'] }, '# 指令'));
  assert.equal(data.name, 'abc');
  assert.deepEqual(data.triggers, ['一', '二']);
  assert.equal(body.trim(), '# 指令');
});

test('slugify, scoring, index, lint and diff serve the wiki navigation layer', () => {
  assert.equal(slugify('  Hello / World!! '), 'hello-world');
  assert.equal(slugify('[[混合检索]]'), '混合检索');
  assert.equal(slugify('v1..2'), 'v1.2', 'store.file() rejects ".." so slugify must normalize it too');
  const long = '向'.repeat(100_000);
  assert.equal(byteTruncate('short', 1024), 'short');
  assert.ok(Buffer.byteLength(byteTruncate(long, 1024)) <= 1024, 'caps are byte-based for CJK text');
  assert.ok(byteTruncate(long, 1024).includes('内容已截断'));
  const pages = [
    page('向量检索', '向量检索用嵌入做召回，参见 [[重排序]]。'),
    page('重排序', 'Rerank 提升精度，链接 [[向量检索]]。'),
    page('孤岛', '没有任何人链接我。', { summary: '' }),
  ];
  const index = buildIndex(pages);
  assert.ok(index.includes('[[向量检索|向量检索]]'));
  assert.ok(index.includes('共 3 页'));
  const top = searchPages('向量检索', pages, 2);
  assert.equal(top[0].slug, '向量检索');
  const health = lintWiki(pages);
  assert.ok(health.orphans.includes('孤岛'));
  assert.ok(health.missingSummary.includes('孤岛'));
  assert.equal(health.contradictions.length, 0);
  const diff = lineDiff('第一行\n旧内容\n第三行', '第一行\n新内容\n第三行');
  assert.deepEqual(diff.map(row => row.type), ['same', 'del', 'add', 'same']);
  assert.deepEqual(extractLinks('[[a|显示]] 与 [[b#段]]'), ['a', 'b']);
});

test('parseJsonResponse tolerates fences and prose; skills use SKILL.md format', () => {
  assert.deepEqual(parseJsonResponse('```json\n{"pages":[1]}\n```'), { pages: [1] });
  assert.deepEqual(parseJsonResponse('这是结果：{"ok":true} 谢谢'), { ok: true });
  assert.throws(() => parseJsonResponse('没有 JSON'), /不是 JSON 对象/);
  const skill = { name: 'my-workflow', description: '自定义流程', kind: 'custom' as const, triggers: ['整理'], body: '# 步骤\n\n1. 阅读', builtin: false, updatedAt: '2026-01-01T00:00:00.000Z' };
  const doc = skillToDocument(skill);
  assert.ok(doc.startsWith('---\nname: my-workflow'));
  const parsed = skillFromDocument('my-workflow', doc, false, '2026-01-01T00:00:00.000Z');
  assert.equal(parsed.description, '自定义流程');
  assert.deepEqual(parsed.triggers, ['整理']);
  assert.equal(parsed.body.trim(), '# 步骤\n\n1. 阅读');
  assert.throws(() => validateSkillName('Bad_Name'), /小写字母/);
  assert.equal(BUILTIN_SKILLS.length, 5);
  assert.equal(resolveSkill([], 'query').name, 'wiki-query');
  assert.equal(resolveSkill([{ ...skill, name: 'wiki-query', kind: 'query', body: '覆盖' }], 'query').body, '覆盖');
});

test('draftPages snapshots existing pages and protects hand edits', () => {
  const existing = page('向量检索', '# 旧正文', { humanEdited: false });
  const manual = page('手改页', '# 我写的', { humanEdited: true });
  const payload = [
    { title: '向量检索', body: '# 新正文', kind: 'concept' },
    { title: '手改页', body: '# 模型想覆盖' },
    { title: '新概念', body: '参见 [[向量检索]]' },
  ];
  const drafts = draftPages(payload, [existing, manual], 'src-1');
  assert.equal(drafts.length, 3);
  assert.equal(drafts[0].action, 'update');
  assert.equal(drafts[0].previous, pageToDocument(existing));
  assert.equal(drafts[1].action, 'skip');
  assert.equal(drafts[2].action, 'create');
  assert.ok(drafts[2].sources.includes('src-1'));
  assert.equal(parseJsonResponse('{"a":1}').a, 1);
});

test('OpenAI-compatible client builds URLs, multimodal parts and friendly errors', async () => {
  assert.equal(completionUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(completionUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(completionUrl('https://x.test/v1/chat/completions?a=1'), 'https://x.test/v1/chat/completions');
  assert.throws(() => completionUrl('ftp://x.test'), /HTTP/);
  assert.equal(maskedKey('sk-abcdefgh'), '已配置 ····efgh');
  assert.equal(maskedKey('abcd'), '已配置 · 已隐藏', 'short keys must not be shown in full');
  assert.equal(maskedKey(''), '未配置');
  const parts = userMessage('看图', [{ mime: 'image/png', base64: 'AAAA' }]);
  assert.ok(Array.isArray(parts.content));
  assert.equal((parts.content as { type: string }[])[1].type, 'image_url');
  assert.ok((parts.content as { image_url: { url: string } }[])[1].image_url.url.startsWith('data:image/png;base64,'));
  await assert.rejects(chat({ baseURL: 'https://x.test/v1', apiKey: '', model: 'm', messages: [] }), /API Key/);
  const calls: Record<string, unknown>[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '可用' } }] }) } as Response;
  }) as unknown as typeof fetch;
  const reply = await chat({ baseURL: 'https://x.test/v1', apiKey: 'sk-1', model: 'm', messages: [{ role: 'user', content: 'ping' }], fetchImpl: fake });
  assert.equal(reply, '可用');
  assert.equal((calls[0].model as string), 'm');
  const failing = (async () => ({ ok: false, status: 429, text: async () => 'rate limited' } as Response)) as unknown as typeof fetch;
  await assert.rejects(chat({ baseURL: 'https://x.test/v1', apiKey: 'sk-1', model: 'm', messages: [], fetchImpl: failing }), /HTTP 429/);
  const echoing = (async () => ({ ok: false, status: 500, text: async () => 'Authorization: Bearer sk-secret-value / sk-secret-value' } as Response)) as unknown as typeof fetch;
  await assert.rejects(
    chat({ baseURL: 'https://x.test/v1', apiKey: 'sk-secret-value', model: 'm', messages: [], fetchImpl: echoing }),
    (error: unknown) => {
      assert.ok(!String(error).includes('sk-secret-value'), 'an echoing proxy must not leak the API key into task errors');
      return true;
    },
  );
});

test('store keeps the three-layer file layout, history and private credentials', t => {
  const root = temp(t);
  const store = new WikiStore(root);
  for (const dir of ['wiki', 'raw', 'raw/assets', 'skills', 'drafts', 'history']) assert.ok(existsSync(path.join(root, dir)));
  assert.equal(store.credentials().apiKey, '');
  store.saveCredentials('sk-secret');
  assert.equal(store.credentials().apiKey, 'sk-secret');
  assert.ok(readFileSync(path.join(root, 'credentials.json'), 'utf8').includes('sk-secret'));
  const source = { id: 'src-1', title: '素材', text: '正文', images: [] as string[], vision: '', compiled: false, hash: 'h', createdAt: '2026-01-01T00:00:00.000Z' };
  store.saveSource(source);
  assert.equal(store.getSource('src-1')!.text, '正文');
  const name = store.addImage('image/png', Buffer.from('png').toString('base64'));
  assert.ok(existsSync(path.join(root, 'raw', 'assets', name)));
  assert.equal(store.imageData(name)!.mime, 'image/png');
  const p = page('概念页', '# 正文');
  store.savePage(p);
  assert.equal(store.getPage('概念页')!.title, '概念页');
  store.snapshot('概念页');
  store.savePage({ ...p, body: '# 改过' });
  assert.ok(store.history('概念页').length >= 1);
  store.saveIndex(buildIndex(store.listPages()));
  store.appendLog('ingest', '素材', ['一条记录']);
  assert.ok(store.log().includes('## ['));
  store.saveSchema(DEFAULT_SCHEMA);
  assert.ok(store.schema().includes('三层'));
  const skill = { name: 'custom-one', description: '自定义', kind: 'custom' as const, triggers: ['x'], body: '# body', builtin: false, updatedAt: '2026-01-01T00:00:00.000Z' };
  store.saveSkill(skill);
  assert.equal(store.listSkills()[0].name, 'custom-one');
  store.deleteSkill('custom-one');
  assert.equal(store.listSkills().length, 0);
  assert.equal(store.getPage('../evil'), null, 'path-like slugs are normalized instead of escaping the wiki directory');
});

interface MockState { requests: string[]; }
function modelFetch(state: MockState): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: unknown }[] };
    const joined = JSON.stringify(body.messages);
    state.requests.push(joined);
    let content: string;
    if (joined.includes('素材摄入')) content = JSON.stringify({ summary: '一份关于向量检索的素材', concepts: [{ title: '向量检索', kind: 'concept', summary: '用嵌入召回', relevance: 0.9 }], claims: ['召回与精度需要平衡'], contradictions: [] });
    else if (joined.includes('编译（Compile）')) content = JSON.stringify({
      summary: '新增向量检索页面', log: '编译完成', contradictions: [],
      pages: [
        { slug: '向量检索', title: '向量检索', kind: 'concept', summary: '用嵌入召回候选', tags: ['检索'], body: '# 向量检索\n\n用嵌入召回候选，见 [[重排序]]。', sources: ['src'] },
        { slug: '重排序', title: '重排序', kind: 'concept', summary: '提升精度', tags: [], body: '# 重排序\n\n提升精度，见 [[向量检索]]。', sources: ['src'] },
      ],
    });
    else if (joined.includes('查询（Query）')) content = '要点：召回后需重排序 [[向量检索]]。依据见 [[重排序]]。';
    else if (joined.includes('体检（Lint）')) content = JSON.stringify({ contradictions: [], orphans: [], missing: [], stale: [], suggestions: ['补充混合检索页面'] });
    else if (joined.includes('答案归档')) content = JSON.stringify({ title: '问答归档', kind: 'note', summary: '归档', tags: [], body: '# 问答归档\n\n见 [[向量检索]]。' });
    else content = '图片中有折线图，横轴是召回率。';
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
  }) as unknown as typeof fetch;
}
async function waitFor(service: WikiService, id: string): Promise<{ status: string; result?: unknown; error?: string }> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const task = service.taskStatus(id)!;
    if (task.status === 'done' || task.status === 'failed') return { status: task.status, result: task.result, error: task.error };
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('后台任务超时');
}

test('end-to-end: compile produces a draft, approval publishes pages, ask cites them', async t => {
  const root = temp(t);
  const store = new WikiStore(root);
  const state: MockState = { requests: [] };
  const service = new WikiService({ store, config: config(), signal: new AbortController().signal, fetchImpl: modelFetch(state) });
  assert.equal(service.status().ready, false);
  await service.setApiKey('sk-test');
  assert.equal(service.status().ready, true);
  assert.ok(store.schema().includes('三层'));
  const source = await service.addSource({ title: '检索笔记', text: '向量检索与重排序的关系' });
  assert.equal(service.listSources().length, 1);
  const compileTask = await waitFor(service, service.compile(source.id));
  assert.equal(compileTask.status, 'done', compileTask.error);
  const draftId = compileTask.result as string;
  const drafts = service.listDrafts('pending');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].pages.length, 2);
  assert.equal(service.listPages().length, 0, 'nothing is published before review');
  const review = await waitFor(service, service.reviewDraft(draftId, 'approve'));
  assert.equal(review.status, 'done', review.error);
  const pages = service.listPages();
  assert.equal(pages.length, 2);
  assert.ok(store.index().includes('[[向量检索|向量检索]]'));
  assert.equal(pages.every(item => !item.humanEdited), true);
  assert.ok(store.log().includes('publish'));
  const answerTask = await waitFor(service, service.ask('召回和精度怎么处理？'));
  assert.equal(answerTask.status, 'done', answerTask.error);
  const answer = answerTask.result as { answer: string; citations: string[] };
  assert.ok(answer.answer.includes('[[向量检索]]'));
  assert.deepEqual(answer.citations.sort(), ['向量检索', '重排序'].sort());
  const lintTask = await waitFor(service, service.lint());
  assert.equal(lintTask.status, 'done', lintTask.error);
  assert.ok((lintTask.result as { suggestions: string[] }).suggestions.length > 0);
  const archived = await service.saveAnswer(answer.answer.includes('召回') ? '召回和精度怎么处理？' : 'q', answer.answer, answer.citations);
  assert.ok(archived.humanEdited, 'an archived answer is a human decision');
  assert.equal(service.getPage(archived.slug)!.slug, archived.slug);
  assert.ok(state.requests.some(request => request.includes('素材摄入') && request.includes('编译（Compile）') === false));
});

test('rejection feedback is injected into the next compile; hand edits survive publishing', async t => {
  const root = temp(t);
  const store = new WikiStore(root);
  const state: MockState = { requests: [] };
  const service = new WikiService({ store, config: config(), signal: new AbortController().signal, fetchImpl: modelFetch(state) });
  await service.setApiKey('sk-test');
  const source = await service.addSource({ title: '素材', text: '内容' });
  const first = await waitFor(service, service.compile(source.id));
  assert.equal(first.status, 'done', first.error);
  const draft = service.listDrafts('pending')[0];
  const reject = await waitFor(service, service.reviewDraft(draft.id, 'reject', '概述太笼统，需要具体例子'));
  assert.equal(reject.status, 'done', reject.error);
  assert.equal(service.listDrafts('pending').length, 0);
  assert.equal(service.getSource(source.id)!.compiled, false, 'a rejected compile can be retried');
  assert.throws(() => service.reviewDraft(draft.id, 'approve'), /已处理/);
  const second = await waitFor(service, service.compile(source.id));
  assert.equal(second.status, 'done', second.error);
  assert.ok(state.requests.some(request => request.includes('概述太笼统，需要具体例子')), 'feedback reaches the next compile prompt');
  const published = await waitFor(service, service.reviewDraft(second.result as string, 'approve'));
  assert.equal(published.status, 'done', published.error);
  assert.equal(service.listPages().length, 2);
  await service.savePage({ slug: '向量检索', body: '# 我手动改的正文' });
  assert.equal(service.getPage('向量检索')!.humanEdited, true);
  const third = await waitFor(service, service.compile(source.id));
  assert.equal(third.status, 'done', third.error);
  const thirdDraft = service.getDraft(third.result as string)!;
  assert.equal(thirdDraft.pages.find(item => item.slug === '向量检索')!.action, 'skip');
  await waitFor(service, service.reviewDraft(thirdDraft.id, 'approve'));
  assert.equal(service.getPage('向量检索')!.body, '# 我手动改的正文', 'hand edits are never overwritten');
});

test('skill CRUD, schema editing and credential handling stay local', async t => {
  const root = temp(t);
  const store = new WikiStore(root);
  const service = new WikiService({ store, config: config(), signal: new AbortController().signal });
  assert.equal(service.allSkills().length, 5);
  const custom = await service.saveSkill({ name: 'my-ingest', description: '先读图再摘要', kind: 'ingest', triggers: ['图片'], body: '# 指令\n只提取图注' });
  assert.equal(custom.builtin, false);
  assert.equal(service.getSkill('my-ingest')!.body, '# 指令\n只提取图注');
  assert.equal(resolveSkill(service.allSkills(), 'ingest').name, 'my-ingest', 'a custom skill of the same kind takes precedence');
  assert.equal(resolveSkill(service.allSkills(), 'ingest', 'my-ingest').name, 'my-ingest');
  const exported = service.exportSkill('my-ingest');
  assert.ok(exported.startsWith('---\nname: my-ingest'));
  const imported = await service.importSkill(exported.replace('name: my-ingest', 'name: imported-one'));
  assert.equal(imported.name, 'imported-one');
  await service.deleteSkill('imported-one');
  assert.equal(service.getSkill('imported-one'), null);
  await assert.rejects(service.deleteSkill('wiki-ingest'), /内置 Skill 不能删除/);
  await service.saveSchema('# 新约定\n用中文。');
  assert.equal(service.schemaText(), '# 新约定\n用中文。');
  assert.ok((await service.rebuildIndex()).includes('Wiki 索引'));
  await service.clearApiKey();
  assert.equal(service.status().ready, false);
});

test('manifest and the sandboxed view are self-contained and syntactically valid', () => {
  assert.equal(notesWikiManifest.id, 'notes-wiki');
  assert.equal(notesWikiManifest.icon, 'book');
  assert.equal(notesWikiManifest.views[0].id, 'wiki');
  assert.equal(notesWikiManifest.config.autoApprove.default, false);
  assert.equal(notesWikiManifest.config.autoCompile.default, true);
  assert.ok(notesWikiView.includes('<style>'));
  assert.ok(notesWikiView.includes('data-tab="wiki"'));
  assert.ok(!/<link|<script[^>]+src=|https?:\/\//i.test(notesWikiView), 'the iframe must not reference external resources');
  const script = notesWikiView.slice(notesWikiView.indexOf('<script>') + 8, notesWikiView.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(script.includes('agentberth.call'));
  assert.ok(script.includes('compressImage'));
  // Every static button must be wired to the delegated click handler;
  // otherwise primary actions silently do nothing inside the iframe.
  const buttons = [...notesWikiMarkup.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
  assert.ok(buttons.length >= 10);
  for (const button of buttons)
    assert.ok(/data-(?:tab|action|file)=/.test(button), `button has a delegated handler: ${button}`);
  for (const action of ['newPage', 'newSource', 'newSkill', 'runLint', 'ask', 'openPluginSettings'])
    assert.ok(new RegExp(`data-action="${action}"`).test(notesWikiMarkup), `${action} is reachable`);
});

test('vision descriptions persist and reach the same compile exactly once', async t => {
  const root = temp(t);
  const store = new WikiStore(root);
  const state: MockState = { requests: [] };
  const service = new WikiService({ store, config: config(), signal: new AbortController().signal, fetchImpl: modelFetch(state) });
  await service.setApiKey('sk-test');
  const source = await service.addSource({ title: '图表笔记', text: '一张图' });
  await service.addImage(source.id, 'image/png', Buffer.from('png').toString('base64'));
  const visionCalls = () => state.requests.filter(request => request.includes('图片理解助手')).length;
  const first = await waitFor(service, service.compile(source.id));
  assert.equal(first.status, 'done', first.error);
  assert.ok(service.getSource(source.id)!.vision.includes('折线图'), 'vision survives the compile write');
  assert.ok(state.requests.some(request => request.includes('图片中有折线图')), 'ingest sees the description');
  assert.equal(visionCalls(), 1);
  const second = await waitFor(service, service.compile(source.id));
  assert.equal(second.status, 'done', second.error);
  assert.equal(visionCalls(), 1, 'the same image is never described twice');
});

test('publishing is safe when two proposals create the same page', async t => {
  const root = temp(t);
  const store = new WikiStore(root);
  const service = new WikiService({ store, config: config(), signal: new AbortController().signal });
  const draft = (id: string, body: string): WikiDraft => ({
    id, sourceId: null, sourceTitle: '手工提案', createdAt: '2026-01-01T00:00:00.000Z',
    model: 'manual', summary: '', contradictions: [], feedback: [], status: 'pending',
    pages: [{ slug: '同名页', title: '同名页', summary: '', kind: 'concept', body, sources: [], tags: [], previous: null, action: 'create' }],
  });
  store.saveDraft(draft('d1', '# 第一份'));
  store.saveDraft(draft('d2', '# 第二份'));
  const first = await waitFor(service, service.reviewDraft('d1', 'approve'));
  assert.equal(first.status, 'done', first.error);
  assert.equal(store.getPage('同名页')!.body, '# 第一份');
  const second = await waitFor(service, service.reviewDraft('d2', 'approve'));
  assert.equal(second.status, 'done', second.error);
  assert.equal(store.getPage('同名页')!.body, '# 第一份', 'a late create skips instead of overwriting');
  assert.deepEqual((second.result as { skipped: string[] }).skipped, ['同名页']);
});

test('a failed auto-compile backs off instead of retrying every tick', async t => {
  const root = temp(t);
  const store = new WikiStore(root);
  const failing = (async () => ({ ok: false, status: 500, text: async () => 'down' } as Response)) as unknown as typeof fetch;
  const service = new WikiService({ store, config: config({ autoCompile: true }), signal: new AbortController().signal, fetchImpl: failing });
  await service.setApiKey('sk-test');
  await service.addSource({ title: '素材', text: '内容' });
  service.tick();
  const id = service.status().tasks.find(task => task.kind === 'compile')!.id;
  assert.equal((await waitFor(service, id)).status, 'failed');
  service.tick();
  assert.equal(service.status().tasks.filter(task => task.kind === 'compile' && ['queued', 'running'].includes(task.status)).length, 0,
    'a failed source waits for the retry window');
});
