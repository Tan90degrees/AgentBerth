import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bestExcerpt, buildIndex, byteTruncate, draftPages, evidenceList, extractLinks, lineDiff, lintWiki,
  pageFromDocument, pageHash, pageToDocument, parseDocument, parseJsonResponse, resolveExcerpts,
  searchPages, skillFromDocument, skillToDocument, slugify, snippet, sourceExcerpt,
  stringifyDocument, validateSkillName,
} from '../src/wiki/core';
import { startInbox } from '../src/wiki/inbox';
import { completionUrl, maskedKey, userMessage, chat } from '../src/wiki/llm';
import { BUILTIN_SKILLS, DEFAULT_SCHEMA, resolveSkill } from '../src/wiki/prompts';
import { apply, MCP_READ_ONLY_COMMANDS } from '../src/wiki/plugin';
import { WikiStore } from '../src/wiki/store';
import { WikiService } from '../src/wiki/service';
import { notesWikiManifest } from '../src/wiki/manifest';
import { notesWikiView } from '../src/wiki/view';
import { notesWikiMarkup } from '../src/wiki/view-markup';
import type { SourceExcerpt, WikiConfig, WikiDraft, WikiPage, WikiSource } from '../src/wiki/types';

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
  slug, title: slug, summary: '摘要 ' + slug, kind: 'concept', sources: [], evidence: [], tags: [],
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
        { slug: '向量检索', title: '向量检索', kind: 'concept', summary: '用嵌入召回候选', tags: ['检索'], body: '# 向量检索\n\n用嵌入召回候选，见 [[重排序]]。', sources: ['src'], evidence: [{ quote: '向量检索与重排序的关系' }] },
        { slug: '重排序', title: '重排序', kind: 'concept', summary: '提升精度', tags: [], body: '# 重排序\n\n提升精度，见 [[向量检索]]。', sources: ['src'], evidence: [{ quote: '向量检索与重排序的关系' }] },
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
  assert.ok(pages.find(item => item.slug === '向量检索')!.evidence.length > 0, 'model quotes survive publishing');
  const excerpts = service.excerpts('向量检索');
  assert.ok(excerpts.length > 0 && excerpts[0].verified, 'a published quote resolves back to the raw source');
  assert.ok(excerpts[0].context.includes('向量检索'));
  assert.ok(service.searchSnippets('向量检索')[0].snippet.includes('向量'));
  assert.ok(service.readForAgent('向量检索')!.excerpts.length > 0, 'MCP reads see the same provenance');
  assert.equal(pages.every(item => !item.humanEdited), true);
  assert.ok(store.log().includes('publish'));
  const answerTask = await waitFor(service, service.ask('召回和精度怎么处理？'));
  assert.equal(answerTask.status, 'done', answerTask.error);
  const answer = answerTask.result as { answer: string; citations: string[]; evidence: SourceExcerpt[] };
  assert.ok(answer.answer.includes('[[向量检索]]'));
  assert.deepEqual(answer.citations.sort(), ['向量检索', '重排序'].sort());
  assert.ok(answer.evidence.length > 0, 'answers carry resolvable provenance');
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
    pages: [{ slug: '同名页', title: '同名页', summary: '', kind: 'concept', body, sources: [], evidence: [], tags: [], previous: null, action: 'create' }],
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

async function pollUntil(check: () => boolean, label: string, timeout = 6000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timeout: ' + label);
}

test('evidence only stores verbatim quotes and resolves to readable raw context', () => {
  const source: WikiSource = {
    id: 'src-evidence', title: '检索笔记',
    text: '第一段讲别的。\n向量检索与重排序的关系：先召回，再精排。\n结尾。',
    images: [], vision: '', compiled: false, hash: '', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const kept = evidenceList([
    { quote: '向量检索与重排序的关系' },
    { quote: '模型编造的一句话' },
    { quote: '向量检索 与 重排序 的 关系' },
  ], source.text);
  assert.equal(kept.length, 2, 'fabricated quotes are dropped, whitespace-wrapped ones survive');
  assert.equal(evidenceList([{ quote: '的' }, { quote: '向量' }], source.text).length, 0,
    'a one/two-character quote matches anything and proves nothing');
  const excerpt = sourceExcerpt(source, kept[0].quote);
  assert.equal(excerpt.verified, true);
  assert.ok(excerpt.context.includes('先召回，再精排'), 'the surrounding source text is shown');
  assert.equal(sourceExcerpt(source, '不存在的引文').verified, false);
  const original = page('向量检索', '向量检索用于召回', {
    sources: ['src-evidence'],
    evidence: kept.map(item => ({ sourceId: 'src-evidence', quote: item.quote })),
  });
  const parsed = pageFromDocument('向量检索', pageToDocument(original), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(parsed.evidence, original.evidence, 'evidence round-trips through frontmatter');
  assert.equal(pageHash(parsed), pageHash(original));
  assert.ok(resolveExcerpts(parsed, [source])[0].context.includes('先召回'));
  assert.equal(resolveExcerpts(page('无来源', '正文'), [source]).length, 0, 'no sources means no invented provenance');
  assert.equal(bestExcerpt(source, '重排序 精度').verified, true, 'local fallback still quotes real text');
  assert.ok(snippet('开头一堆文字，然后向量检索出现在后面，还有更多内容', '向量检索').includes('向量检索'));
});

test('MCP exposes only read-only wiki commands and tolerates the injected agentId', async t => {
  const cleanups: (() => void)[] = [];
  // Register the cleanup hook BEFORE temp() registers the directory removal:
  // on Windows a live fs.watch handle keeps the directory locked (EPERM).
  t.after(() => { while (cleanups.length) cleanups.pop()!(); });
  const root = temp(t);
  const registered: { description: Record<string, unknown>; handler: (params: Record<string, unknown>) => unknown | Promise<unknown> }[] = [];
  const effect = (setup: () => unknown): void => {
    const dispose = setup();
    if (typeof dispose === 'function') cleanups.push(dispose as () => void);
  };
  const ctx = {
    berth: {
      id: 'notes-wiki', dataDirectory: root, signal: new AbortController().signal,
      command: (description: Record<string, unknown>, handler: (params: Record<string, unknown>) => unknown) => registered.push({ description, handler }),
      interval: () => {}, effect, call: async () => ({ sessions: [] }),
    },
    effect,
  };
  apply(ctx as never, {});
  const byName = new Map(registered.map(item => [String(item.description.name), item]));
  for (const name of MCP_READ_ONLY_COMMANDS) {
    const entry = byName.get(name)!;
    assert.equal(entry.description.mcp, true, name + ' is discoverable by Agents');
    assert.notEqual((entry.description.inputSchema as Record<string, unknown>).additionalProperties, false,
      name + ' accepts the MCP-injected agentId');
  }
  for (const name of ['save_page', 'add_source', 'compile', 'review_draft', 'set_api_key', 'delete_page'])
    assert.equal(byName.get(name)!.description.mcp, false, name + ' stays behind human review');
  const search = byName.get('wiki_search')!;
  assert.ok(Array.isArray(await search.handler({ query: '向量', agentId: 'agent-1' })));
  assert.ok(((await byName.get('wiki_index')!.handler({ agentId: 'agent-1' })) as { index: string }).index.includes('Wiki 索引'));
  assert.equal(await byName.get('wiki_read')!.handler({ slug: '不存在', agentId: 'agent-1' }), null);
  assert.equal(byName.get('inbox_status')!.description.mcp, false);
  // Regression: the view ships full excerpts (title/context/verified); the
  // command must accept them and keep only the two fields it persists. Short
  // quotes and unknown source ids are rejected at the service boundary.
  const evidenceStore = new WikiStore(root);
  const quote = '逐字引文来自原始素材，用于验证归档路径的出处校验。';
  evidenceStore.saveSource({
    id: 'src-evidence', title: '素材', text: quote, images: [], vision: '',
    compiled: false, hash: '', createdAt: '2026-01-01T00:00:00.000Z',
  });
  const archived = await byName.get('save_answer')!.handler({
    question: '证据会保留吗？', answer: '会 [[向量检索]]', citations: ['向量检索'],
    evidence: [
      { sourceId: 'src-evidence', quote, title: '额外字段', verified: true },
      { sourceId: 'unknown-source', quote: '另一个无效的引文片段' },
      { sourceId: 'src-evidence', quote: '的' },
    ],
  }) as WikiPage;
  assert.deepEqual(archived.evidence, [{ sourceId: 'src-evidence', quote }]);
});

test('inbox watcher imports dropped files once and archives them', async t => {
  // Own the temp directory here so the watcher-stop hook runs before removal.
  const root = mkdtempSync(path.join(os.tmpdir(), 'berth-wiki-'));
  const store = new WikiStore(root);
  const service = new WikiService({ store, config: config({ autoCompile: false }), signal: new AbortController().signal });
  const inbox = startInbox({ root, onFile: async (name, value) => { await service.ingestInboxFile(name, value); } });
  t.after(() => inbox.stop());
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const content = '# 采集笔记\n\n向量检索先召回再重排序。';
  writeFileSync(path.join(inbox.dir, 'note.md'), content);
  await pollUntil(() => service.listSources().length === 1, 'inbox import');
  const source = service.listSources()[0];
  assert.equal(source.title, 'note');
  assert.ok(source.text.includes('先召回再重排序'));
  assert.equal(readdirSync(inbox.dir).filter(name => name.endsWith('.md')).length, 0, 'file moved out of the inbox');
  assert.ok(readdirSync(inbox.importedDir).some(name => name.endsWith('note.md')));
  writeFileSync(path.join(inbox.dir, 'note.md'), content);
  await pollUntil(() => readdirSync(inbox.importedDir).length >= 2, 'duplicate archived');
  assert.equal(service.listSources().length, 1, 'identical content is never imported twice');
  assert.ok(store.log().includes('自动采集'));
});

test('workbench sessions can be captured as immutable sources, exactly once', async t => {
  const root = temp(t);
  const store = new WikiStore(root);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const call = async (method: string) => {
    if (method === 'state') return { sessions: [{ id: sessionId, title: '检索方案讨论', latestRun: { status: 'completed' } }] };
    if (method === 'acpSnapshot') return { events: [
      { sequence: 1, kind: 'user', text: '讨论向量检索' },
      { sequence: 2, kind: 'assistant', text: '建议先召回再重排序' },
    ] };
    return {};
  };
  const service = new WikiService({ store, config: config(), signal: new AbortController().signal, call });
  assert.deepEqual(await service.listCaptureSessions(), [{ id: sessionId, title: '检索方案讨论', status: 'completed' }]);
  const first = await service.captureSession(sessionId);
  assert.equal(first.events, 2);
  assert.equal(first.skipped, false);
  const source = store.getSource(first.id)!;
  assert.ok(source.text.includes('建议先召回再重排序'));
  assert.ok(source.text.includes('采集自工作台会话'));
  assert.ok(store.log().includes('工作台会话'));
  const second = await service.captureSession(sessionId);
  assert.equal(second.skipped, true);
  assert.equal(service.listSources().length, 1, 'an unchanged session snapshot is not duplicated');
  await assert.rejects(service.captureSession('unknown'), /会话不存在/);
  const offline = new WikiService({ store: new WikiStore(temp(t)), config: config(), signal: new AbortController().signal });
  assert.deepEqual(await offline.listCaptureSessions(), []);
  await assert.rejects(offline.captureSession(sessionId), /不可用/);
});

test('inbox quarantines oversized files and never imports a half-written file', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'berth-wiki-'));
  const store = new WikiStore(root);
  const service = new WikiService({ store, config: config({ autoCompile: false }), signal: new AbortController().signal });
  const inbox = startInbox({
    root, onFile: async (name, value) => { await service.ingestInboxFile(name, value); }, onError: () => {},
  });
  t.after(() => inbox.stop());
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

  writeFileSync(path.join(inbox.dir, 'big.md'), 'x'.repeat(1024 * 1024 + 1));
  await pollUntil(() => readdirSync(inbox.failedDir).length > 0, 'oversized file quarantined', 12000);
  assert.equal(service.listSources().length, 0, 'a deterministic failure never becomes a source');

  const slow = path.join(inbox.dir, 'slow.md');
  writeFileSync(slow, '# 慢速写入\n\n前半段');
  setTimeout(() => writeFileSync(slow, '# 慢速写入\n\n前半段 + 完整结尾。'), 250);
  await pollUntil(() => service.listSources().some(item => item.title === 'slow'), 'settled import', 12000);
  const imported = service.listSources().filter(item => item.title === 'slow');
  assert.equal(imported.length, 1);
  assert.ok(imported[0].text.includes('完整结尾'), 'only complete text becomes an immutable source');
  assert.ok(inbox.archived >= 1);
});
