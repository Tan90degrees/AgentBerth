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
  click(dom, '[data-action="deletePage"]'); await until(() => dom.window.document.querySelector('[data-action="dialogAccept"]'), 'second confirmation'); click(dom, '[data-action="dialogAccept"]');
  await until(() => !store.getPage('notes'), 'page moved to trash'); click(dom, '[data-tab="trash"]');
  await until(() => dom.window.document.querySelector('[data-action="restoreTrash"]'), 'recovery entry'); click(dom, '[data-action="restoreTrash"]');
  await until(() => store.getPage('notes'), 'page restored'); assert.equal(store.getPage('notes')!.body, 'important');
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
