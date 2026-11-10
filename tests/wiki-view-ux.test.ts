import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { apply } from '../src/wiki/plugin';
import { WikiStore } from '../src/wiki/store';
import { WikiService } from '../src/wiki/service';
import { notesWikiView } from '../src/wiki/view';
import { pageToDocument } from '../src/wiki/core';
import type { WikiDraft } from '../src/wiki/types';

async function until(check: () => unknown, label: string) { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(label); }
function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wiki-dom-')), controller = new AbortController(), store = new WikiStore(root);
  const config = { autoCompile: false, authRequired: true, baseURL: 'http://127.0.0.1:1/v1', textModel: 'local', visionModel: '', autoApprove: false, lintMinutes: 0, maxContextPages: 8 };
  const service = new WikiService({ store, config, signal: controller.signal });
  const commands = new Map<string, (params: Record<string, unknown>) => unknown>();
  const views: JSDOM[] = [];
  apply({ berth: { dataDirectory: root, signal: controller.signal, interval() {}, call: async () => ({ sessions: [] }), command(d: { name: string }, handler: (p: Record<string, unknown>) => unknown) { commands.set(d.name, handler); } }, effect() {} } as never, config);
  const open = () => {
    const dom = new JSDOM('<!doctype html><body>' + notesWikiView, { runScripts: 'outside-only', url: 'http://wiki.test' });
    (dom.window as unknown as { agentberth: unknown }).agentberth = { call: async (name: string, params: Record<string, unknown> = {}) => { const handler = commands.get(name); if (!handler) throw new Error('Unknown command ' + name); return handler(params); } };
    dom.window.Element.prototype.scrollIntoView = () => {};
    const script = notesWikiView.slice(notesWikiView.indexOf('<script>') + 8, notesWikiView.lastIndexOf('</script>'));
    dom.window.eval(script); views.push(dom); return dom;
  };
  t.after(() => { views.forEach(dom => dom.window.close()); controller.abort(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { store, service, commands, open };
}
function click(dom: JSDOM, selector: string) { const node = dom.window.document.querySelector<HTMLElement>(selector); assert.ok(node, selector); node.click(); }
function input(dom: JSDOM, selector: string, value: string) { const node = dom.window.document.querySelector<HTMLInputElement>(selector)!; assert.ok(node, selector); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('typing during a slow page save preserves the next draft and advances only its own conflict baseline', async t => {
  const { service, store, commands, open } = setup(t);
  await service.savePage({ slug: 'notes', title: 'notes', body: 'original' });
  const save = commands.get('save_page')!; let finish!: () => Promise<void>, calls = 0;
  commands.set('save_page', params => new Promise(resolve => { calls++; finish = async () => { resolve(await save(params)); }; }));
  const dom = open(); await until(() => dom.window.document.querySelector('[data-action="editPage"]'), 'page loaded');
  click(dom, '[data-action="editPage"]'); await until(() => dom.window.document.querySelector('[data-field="body"]'), 'editor loaded');
  input(dom, '#pageView [data-field="body"]', 'submitted text'); click(dom, '[data-action="savePage"]');
  await until(() => finish, 'save pending'); click(dom, '[data-action="savePage"]');
  input(dom, '#pageView [data-field="body"]', 'text typed after submission');
  await finish(); await settle();
  assert.equal(calls, 1, 'a pending save must not submit twice');
  assert.equal(store.getPage('notes')!.body, 'submitted text');
  assert.equal(service.workspace.editorDrafts().find(draft => draft.key === 'page:notes')?.fields.body, 'text typed after submission');
  assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('#pageView [data-field="body"]')?.value, 'text typed after submission');
  commands.set('save_page', save); click(dom, '[data-action="savePage"]');
  await until(() => store.getPage('notes')!.body === 'text typed after submission', 'next save uses the acknowledged version');
});

test('a late page save never selects the former page after the reader opens another one', async t => {
  const { service, commands, open } = setup(t);
  await service.savePage({ slug: 'one', title: 'one', body: 'first' }); await service.savePage({ slug: 'two', title: 'two', body: 'second' });
  const save = commands.get('save_page')!; let finish!: () => Promise<void>;
  commands.set('save_page', params => new Promise(resolve => { finish = async () => { resolve(await save(params)); }; }));
  const dom = open(); await until(() => dom.window.document.querySelector('#pageList [data-slug="one"]'), 'pages loaded');
  click(dom, '#pageList [data-slug="one"]'); await until(() => dom.window.document.querySelector('#pageView h2')?.textContent === 'one', 'first page loaded');
  click(dom, '[data-action="editPage"]'); await until(() => dom.window.document.querySelector('[data-field="body"]'), 'editor loaded');
  input(dom, '#pageView [data-field="body"]', 'saved first'); click(dom, '[data-action="savePage"]'); await until(() => finish, 'save pending');
  click(dom, '#pageList [data-slug="two"]'); await until(() => dom.window.document.querySelector('#pageView h2')?.textContent === 'two', 'second page loaded');
  await finish(); await settle();
  assert.equal(dom.window.document.querySelector('#pageView h2')?.textContent, 'two');
});

test('an answer completing in the background preserves the next question and the selected history entry', async t => {
  const { service, commands, open } = setup(t);
  const historical = { at: '2026-01-01T00:00:00.000Z', question: '历史问题', answer: '历史回答', citations: [], evidence: [], pages: [], model: 'local' };
  service.workspace.saveAnswer(historical);
  let finish!: (task: unknown) => void;
  commands.set('ask', () => 'pending-question'); commands.set('task', () => new Promise(resolve => { finish = resolve; }));
  const dom = open(); click(dom, '.tabs [data-tab="ask"]');
  await until(() => dom.window.document.querySelector('[data-action="openAnswer"]'), 'history loaded');
  input(dom, '#question', '正在等待的问题'); click(dom, '#ask'); await until(() => finish, 'answer pending');
  input(dom, '#question', '刚输入的下一个问题'); click(dom, '[data-action="openAnswer"]');
  await until(() => dom.window.document.querySelector('#answerView')!.textContent!.includes('历史回答'), 'history selected');
  finish({ id: 'pending-question', status: 'done', kind: 'ask', result: { ...historical, at: '2026-01-02T00:00:00.000Z', question: '正在等待的问题', answer: '新的回答' } });
  await settle();
  assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('#question')!.value, '刚输入的下一个问题');
  assert.equal(service.workspace.editorDrafts().find(draft => draft.key === 'question')?.fields.question, '刚输入的下一个问题');
  assert.ok(dom.window.document.querySelector('#answerView')!.textContent!.includes('历史回答'));
});

test('late full-text search results cannot replace a newer query', async t => {
  const { service, commands, open } = setup(t);
  await service.savePage({ slug: 'old', title: 'old', body: 'old needle' }); await service.savePage({ slug: 'new', title: 'new', body: 'new needle' });
  const list = commands.get('list_pages')!; let finish!: () => Promise<void>;
  commands.set('list_pages', params => params.query === 'old needle' ? new Promise(resolve => { finish = async () => { resolve(await list(params)); }; }) : list(params));
  const dom = open(); await until(() => dom.window.document.querySelectorAll('#pageList .item').length === 2, 'pages loaded');
  input(dom, '#pageSearch', 'old needle'); await until(() => finish, 'first query pending');
  input(dom, '#pageSearch', 'new needle'); await until(() => dom.window.document.querySelectorAll('#pageList .item').length === 1 && dom.window.document.querySelector('#pageList [data-slug="new"]'), 'second query applied');
  await finish(); await settle();
  assert.ok(dom.window.document.querySelector('#pageList [data-slug="new"]'));
  assert.equal(dom.window.document.querySelector('#pageList [data-slug="old"]'), null);
});

test('repeated delete clicks share one confirmation and one mutation', async t => {
  const { service, commands, open } = setup(t); await service.savePage({ slug: 'notes', title: 'notes', body: 'important' });
  let inspections = 0, deletions = 0; const pending: ((value: unknown) => void)[] = [], remove = commands.get('delete_page')!;
  commands.set('delete_impact', () => { inspections++; return new Promise(resolve => pending.push(resolve)); });
  commands.set('delete_page', params => { deletions++; return remove(params); });
  const dom = open(); await until(() => dom.window.document.querySelector('[data-action="deletePage"]'), 'page loaded');
  click(dom, '[data-action="deletePage"]'); click(dom, '[data-action="deletePage"]'); await until(() => pending.length, 'impact inspection');
  pending.forEach(resolve => resolve({ pages: [] })); await until(() => dom.window.document.querySelector('[data-action="dialogAccept"]'), 'confirmation');
  click(dom, '[data-action="dialogAccept"]'); await until(() => deletions, 'delete acknowledged');
  assert.equal(inspections, 1); assert.equal(deletions, 1);
});

test('a slow source save preserves subsequent edits and never pulls the reader away from another tab', async t => {
  const { service, commands, open } = setup(t), finalize = commands.get('finalize_source')!;
  let finish!: () => Promise<void>;
  commands.set('finalize_source', params => new Promise(resolve => { finish = async () => { resolve(await finalize(params)); }; }));
  const dom = open(); click(dom, '.tabs [data-tab="sources"]'); click(dom, '#newSource');
  input(dom, '#sourceView [data-field="title"]', 'first source'); input(dom, '#sourceView [data-field="text"]', 'submitted source');
  click(dom, '[data-action="saveSource"]'); await until(() => finish, 'source save pending');
  input(dom, '#sourceView [data-field="text"]', 'additional source text'); click(dom, '.tabs [data-tab="skills"]');
  await finish(); await settle();
  assert.equal(dom.window.document.querySelector('.panel.active')?.getAttribute('data-panel'), 'skills');
  assert.equal(service.listSources()[0].text, 'submitted source');
  assert.equal(service.workspace.editorDrafts().find(draft => draft.key === 'source:new')?.fields.text, 'additional source text');
});

test('new Skill saves retain subsequent input and keep the saved Skill open', async t => {
  const { commands, open, service } = setup(t), save = commands.get('save_skill')!; let finish!: () => Promise<void>;
  commands.set('save_skill', params => new Promise(resolve => { finish = async () => { resolve(await save(params)); }; }));
  const dom = open(); click(dom, '.tabs [data-tab="skills"]'); click(dom, '#newSkill');
  input(dom, '#skillView [data-field="name"]', 'slow-skill'); input(dom, '#skillView [data-field="description"]', 'A custom instruction'); input(dom, '#skillView [data-field="body"]', 'submitted skill');
  click(dom, '[data-action="saveSkill"]'); await until(() => finish, 'Skill save pending');
  input(dom, '#skillView [data-field="body"]', 'new instructions'); await finish();
  await until(() => dom.window.document.querySelector<HTMLInputElement>('#skillView [data-field="name"]')?.readOnly, 'saved Skill remains open');
  assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('#skillView [data-field="body"]')?.value, 'new instructions');
  assert.equal(service.workspace.editorDrafts().find(draft => draft.key === 'skill:slow-skill')?.fields.body, 'new instructions');
});

test('late Schema loading cannot replace an intentionally cleared draft', async t => {
  const { commands, open } = setup(t); let finish!: (value: unknown) => void;
  commands.set('schema', () => new Promise(resolve => { finish = resolve; }));
  const dom = open(); await until(() => dom.window.document.querySelector('#statusText')?.textContent?.includes('尚未完成模型配置'), 'status loaded');
  click(dom, '.tabs [data-tab="settings"]'); await until(() => finish, 'Schema read pending');
  input(dom, '#settingsView [data-field="schema"]', 'temporary'); input(dom, '#settingsView [data-field="schema"]', '');
  finish('original Schema must not overwrite the empty draft'); await settle();
  assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('#settingsView [data-field="schema"]')!.value, '');
});

test('full snapshot restore flushes pending drafts and never resurrects pre-restore editors', async t => {
  const { service, commands, open } = setup(t);
  const original = service.workspace.importBackup(service.workspace.backup(), true).rollback;
  const save = commands.get('save_editor_draft')!, restore = commands.get('restore_backup')!;
  let release!: () => void, restores = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  commands.set('save_editor_draft', params => pending.then(() => save(params)));
  commands.set('restore_backup', params => { restores++; return restore(params); });
  const dom = open(); await until(() => dom.window.document.querySelector('#statusText')?.textContent?.includes('尚未完成模型配置'), 'view ready');
  click(dom, '#newPage'); input(dom, '#pageView [data-field="body"]', 'last unsaved input before restoring');
  click(dom, '.tabs [data-tab="settings"]');
  await until(() => dom.window.document.querySelector('[data-action="restoreBackup"][data-name="' + original + '"]'), 'snapshot action');
  click(dom, '[data-action="restoreBackup"][data-name="' + original + '"]');
  await until(() => dom.window.document.querySelector('[data-action="dialogAccept"]'), 'restore confirmation'); click(dom, '[data-action="dialogAccept"]');
  await settle(); assert.equal(restores, 0, 'restore waits for pending draft writes');
  release(); await until(() => dom.window.document.querySelector('#uxNotice')!.textContent?.includes('完整快照已恢复'), 'snapshot restored');
  assert.equal(service.workspace.editorDrafts().length, 0);
  click(dom, '.tabs [data-tab="wiki"]'); click(dom, '.tabs [data-tab="tasks"]'); await settle();
  assert.equal(service.workspace.editorDrafts().length, 0, 'old mounted editors cannot write the removed draft back');
  const undo = service.workspace.rollbackBackups().find(name => name !== original)!;
  service.workspace.restoreRollback(undo);
  assert.equal(service.workspace.editorDrafts().find(draft => draft.key === 'page:new')!.fields.body, 'last unsaved input before restoring', 'the automatic undo snapshot contains the flushed draft');
});

test('page drafts survive tab switches and closing the view, retaining their original conflict baseline', async t => {
  const { store, service, open } = setup(t); await service.savePage({ slug: 'notes', title: 'notes', body: 'stored body' });
  const dom = open(); t.after(() => dom.window.close());
  await until(() => dom.window.document.querySelector('[data-action="editPage"]'), 'page loaded');
  click(dom, '[data-action="editPage"]'); await until(() => dom.window.document.querySelector('[data-field="body"]'), 'edit page');
  input(dom, '#pageView [data-field="body"]', '未提交的最后一行');
  await until(() => service.workspace.editorDrafts().length, 'draft persisted');
  dom.window.document.querySelector<HTMLDetailsElement>('#draftShelf details')!.open = true;
  input(dom, '#pageView [data-field="body"]', '未提交的最后一行');
  assert.equal(dom.window.document.querySelector<HTMLDetailsElement>('#draftShelf details')!.open, true, 'saving another keystroke keeps the recovery shelf expanded');
  click(dom, '[data-tab="skills"]'); click(dom, '[data-tab="wiki"]');
  await until(() => dom.window.document.querySelector<HTMLTextAreaElement>('#pageView [data-field="body"]')?.value === '未提交的最后一行', 'tab switch retains text');
  dom.window.close();
  const external = store.getPage('notes')!; external.body = 'external update'; store.savePage(external);
  const reopened = open(); t.after(() => reopened.window.close());
  await until(() => reopened.window.document.querySelector('[data-action="restoreEditorDraft"]'), 'draft recovery entry');
  click(reopened, '[data-action="restoreEditorDraft"]');
  await until(() => reopened.window.document.querySelector<HTMLTextAreaElement>('#pageView [data-field="body"]')?.value === '未提交的最后一行', 'reopen retains text');
  click(reopened, '#pageView [data-action="savePage"]');
  await until(() => reopened.window.document.querySelector('#error')!.textContent?.includes('页面已变化'), 'stale baseline is rejected');
  assert.equal(store.getPage('notes')!.body, 'external update');
});

test('delete requires an explicit decision and recovery is available from the same view', async t => {
  const { store, service, open } = setup(t); await service.savePage({ slug: 'notes', title: 'notes', body: 'important' });
  const dom = open(); t.after(() => dom.window.close());
  await until(() => dom.window.document.querySelector('[data-action="deletePage"]'), 'page loaded');
  click(dom, '[data-action="deletePage"]'); await until(() => dom.window.document.querySelector('[role="dialog"]'), 'delete confirmation');
  assert.ok(store.getPage('notes')); click(dom, '[data-action="dialogCancel"]'); assert.ok(store.getPage('notes'));
  await until(() => !dom.window.document.querySelector<HTMLButtonElement>('[data-action="deletePage"]')!.disabled, 'delete available after cancellation');
  click(dom, '[data-action="deletePage"]'); await until(() => dom.window.document.querySelector('[data-action="dialogAccept"]'), 'second confirmation'); click(dom, '[data-action="dialogAccept"]');
  await until(() => !store.getPage('notes'), 'page moved to trash'); click(dom, '[data-tab="trash"]');
  await until(() => dom.window.document.querySelector('[data-action="restoreTrash"]'), 'recovery entry'); click(dom, '[data-action="restoreTrash"]');
  await until(() => store.getPage('notes'), 'page restored'); assert.equal(store.getPage('notes')!.body, 'important');
});

test('saving a source clears its recovery draft even when model compilation is unavailable', async t => {
  const { service, open } = setup(t), dom = open();
  click(dom, '[data-tab="sources"]'); click(dom, '#newSource');
  input(dom, '#sourceView [data-field="title"]', '已保存的素材');
  input(dom, '#sourceView [data-field="text"]', '已经保存的正文不应该再次恢复成未保存草稿。');
  await until(() => service.workspace.editorDrafts().some(draft => draft.key === 'source:new'), 'source draft persisted');
  click(dom, '#sourceView [data-action="saveSource"]');
  await until(() => service.listSources().some(source => source.title === '已保存的素材'), 'source saved');
  await until(() => !service.workspace.editorDrafts().some(draft => draft.key === 'source:new'), 'saved draft cleared');
  click(dom, '#newSource');
  assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('#sourceView [data-field="text"]')!.value, '', 'the next source starts empty');
});

test('body search and question history paginate beyond their previous sidebar limits', async t => {
  const { service, commands, open } = setup(t);
  for (let i = 0; i < 28; i++) await service.savePage({ slug: 'page-' + i, title: 'page ' + i, body: i === 27 ? 'only-body-needle' : 'body' });
  const meta = service.store.meta(); meta.answers = Array.from({ length: 12 }, (_, i) => ({ at: new Date(Date.now() + i * 1000).toISOString(), question: 'question ' + i, answer: 'answer', citations: [], evidence: [], pages: [], model: 'local' })); service.store.saveMeta(meta);
  assert.equal((await commands.get('answers')!({ limit: 25 }) as unknown[]).length, 12);
  const dom = open(); t.after(() => dom.window.close()); await until(() => dom.window.document.querySelectorAll('#pageList .item').length === 25, 'first page');
  click(dom, '[data-action="pageNext"][data-kind="pages"]'); await until(() => dom.window.document.querySelectorAll('#pageList .item').length === 3, 'next page');
  input(dom, '#pageSearch', 'only-body-needle');
  await until(() => dom.window.document.querySelectorAll('#pageList .item').length === 1, 'full-text match');
  assert.ok(dom.window.document.querySelector('#pageList')!.textContent!.includes('page 27'));
  click(dom, '[data-tab="ask"]'); await until(() => dom.window.document.querySelectorAll('#answerList .item').length === 12, 'full available question history');
});

test('PDF selection waits for import and cancellation reaches the in-flight upload', async t => {
  const { commands, open, service } = setup(t); let starts = 0, cancellations = 0, finish!: () => void;
  commands.set('pdf_upload_start', async () => { starts++; return { uploadId: 'upload' }; });
  commands.set('pdf_upload_chunk', () => new Promise((_resolve, reject) => { finish = () => reject(new Error('已取消')); }));
  commands.set('pdf_upload_cancel', async () => { cancellations++; return true; });
  const dom = open(); t.after(() => dom.window.close()); click(dom, '[data-tab="sources"]'); click(dom, '#newSource');
  const input = dom.window.document.querySelector<HTMLInputElement>('[data-field="pdf"]')!;
  Object.defineProperty(input, 'files', { value: [{ name: 'paper.pdf', size: 1, slice: () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }) }] });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(starts, 0, 'selecting a file has no upload/model side effects'); click(dom, '[data-action="startImport"]');
  await until(() => finish, 'upload running'); click(dom, '[data-action="cancelImport"]'); await until(() => cancellations, 'cancel delivered'); finish();
  await until(() => dom.window.document.querySelector('#pdfProgress')!.textContent!.includes('取消'), 'cancel status visible');
  assert.equal(service.listSources().length, 0);
});

test('evidence opens the matching late passage instead of only the source beginning', async t => {
  const { service, open } = setup(t), quote = '位于长素材末尾的唯一逐字引文';
  const source = await service.addSource({ title: 'long source', text: '开头内容'.repeat(10000) + quote });
  await service.savePage({ slug: 'evidence', title: 'evidence', body: 'compiled', evidence: [{ sourceId: source.id, quote }] });
  const dom = open(); t.after(() => dom.window.close());
  await until(() => dom.window.document.querySelector('[data-action="openSource"][data-quote]'), 'evidence action');
  click(dom, '[data-action="openSource"][data-quote]');
  await until(() => dom.window.document.querySelector('#sourceText mark'), 'quote highlighted');
  assert.equal(dom.window.document.querySelector('#sourceText mark')!.textContent, quote);
  assert.ok(Number(dom.window.document.querySelector('#sourceTextPager')!.textContent!.match(/显示 (\d+)/)![1]) > 12000);
});

test('a protected page can be explicitly reviewed, merged and published with visible counts', async t => {
  const { service, store, open } = setup(t);
  const original = await service.savePage({ slug: 'reviewed', title: 'reviewed', body: 'original human page' });
  const draft: WikiDraft = { id: 'ui-review', sourceId: null, sourceTitle: 'Review this', createdAt: new Date().toISOString(), model: 'local', summary: '', contradictions: [], feedback: [], status: 'pending', pages: [{ slug: 'reviewed', title: 'reviewed', body: 'proposal', kind: 'note', summary: '', tags: [], sources: [], evidence: [], previous: pageToDocument(original), action: 'skip' }] };
  store.saveDraft(draft);
  const dom = open(); t.after(() => dom.window.close()); click(dom, '[data-tab="review"]');
  await until(() => dom.window.document.querySelector('[data-action="openDraft"]'), 'draft list'); click(dom, '[data-action="openDraft"]');
  await until(() => dom.window.document.querySelector('[data-action="draftPage"]'), 'draft page'); click(dom, '[data-action="draftPage"]');
  await until(() => dom.window.document.querySelector('#reviewEditor textarea'), 'page editor');
  input(dom, '#reviewEditor [data-field="draftBody"]', 'approved merged text');
  dom.window.document.querySelector<HTMLInputElement>('#reviewEditor [data-field="merge"]')!.checked = true;
  click(dom, '[data-action="saveDraftPage"]'); await until(() => dom.window.document.querySelector('[data-action="dialogAccept"]'), 'merge decision'); click(dom, '[data-action="dialogAccept"]');
  await until(() => store.getDraft('ui-review')!.pages[0].allowHumanMerge, 'review saved');
  click(dom, '[data-action="approveDraft"]');
  await until(() => store.getPage('reviewed')!.body === 'approved merged text', 'published');
  await until(() => dom.window.document.querySelector('#uxNotice')!.textContent!.includes('发布 1 页，跳过 0 页'), 'publish result visible');
});
