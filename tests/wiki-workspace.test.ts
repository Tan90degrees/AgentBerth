import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import { WikiStore } from '../src/wiki/store';
import { WikiService } from '../src/wiki/service';
import { WikiWorkspace } from '../src/wiki/workspace';
import { WikiTransfers } from '../src/wiki/transfers';
import { apply } from '../src/wiki/plugin';
import { pageHash, pageToDocument } from '../src/wiki/core';
import { chat } from '../src/wiki/llm';
import type { WikiConfig, WikiDraft, WikiPage, WikiTask } from '../src/wiki/types';

const config: WikiConfig = { baseURL: 'http://localhost:1234/v1', textModel: 'local', visionModel: '', autoCompile: false, autoApprove: false, authRequired: false, lintMinutes: 0, maxContextPages: 8 };
function fixture(t: { after: (fn: () => void) => void }, extra: Partial<ConstructorParameters<typeof WikiService>[0]> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wiki-workspace-')), store = new WikiStore(root), controller = new AbortController();
  const service = new WikiService({ store, config, signal: controller.signal, ...extra });
  t.after(() => { controller.abort(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, store, service, workspace: service.workspace, controller };
}
function page(slug: string, body: string): WikiPage { const p: WikiPage = { slug, title: slug, summary: '', kind: 'note', body, sources: [], evidence: [], tags: [], humanEdited: true, hash: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; p.hash = pageHash(p); return p; }
async function finished(service: WikiService, id: string): Promise<WikiTask> { for (let i = 0; i < 1000; i++) { const task = service.taskStatus(id)!; if (!['queued', 'running'].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('task did not complete'); }

test('mixed text, Markdown and named images compile together once with full context and retry idempotency', async t => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (_url,init) => { const body=JSON.parse(String(init?.body));const prompt=JSON.stringify(body.messages);requests.push(prompt);const value=prompt.includes('图片理解助手')?'图中关系：入口连接数据库':JSON.stringify({ summary:'整组总结',concepts:[],claims:[],contradictions:[],pages:[{slug:'mixed',title:'mixed',kind:'note',summary:'统一资料',body:'文章、补充说明与结构图共同表明入口连接数据库',sources:[],tags:[]}] });return new Response(JSON.stringify({choices:[{message:{content:value}}]})); };
  const {service,store,workspace}=fixture(t,{config:{...config,autoCompile:true,visionModel:'vision'},fetchImpl});
  const source=await service.addSource({title:'完整混合资料',text:'用户补充：查看架构图。',staging:true});
  const md='# 文章\n\n![架构](images/design.png)\n\n'+'全文不能截断。'.repeat(3000)+'结尾证据。',id=randomUUID();
  await service.appendSourcePart(source.id,id,'article.md','text/markdown',new TextEncoder().encode(md));
  await service.appendSourcePart(source.id,randomUUID(),'notes.txt','text/plain',new TextEncoder().encode('补充记录：入口和数据库之间有队列。'));
  await service.appendSourcePart(source.id,randomUUID(),'images/design.png','image/png',new Uint8Array([1,2,3]));
  assert.equal((await service.appendSourcePart(source.id,id,'article.md','text/markdown',new TextEncoder().encode(md))).skipped,true);
  await assert.rejects(service.appendSourcePart(source.id,id,'article.md','text/plain',new TextEncoder().encode('changed')),/内容已变化/);
  service.tick();assert.equal(requests.length,0,'part uploads cannot trigger premature model work');
  assert.throws(()=>service.compile(source.id),/整组保存/);
  await service.finalizeSource(source.id);const task=await finished(service,service.compile(source.id,true));assert.equal(task.status,'done',task.error);
  assert.equal(store.listSources().length,1);assert.equal(store.listDrafts().length,1);assert.equal(store.listPages().length,0);
  const saved=store.getSource(source.id)!;assert.ok(saved.text.includes(md));assert.equal(saved.parts!.length,3);assert.equal(saved.images.length,1);
  const vision=requests.find(value=>value.includes('图片理解助手'))!;assert.ok(vision.includes('images/design.png'));assert.ok(vision.includes('![架构]'));
  assert.ok(requests.some(value=>value.includes('结尾证据')));assert.ok(requests.some(value=>value.includes('补充记录')));assert.ok(requests.some(value=>value.includes('图中关系')));
  const count=requests.length;assert.equal(service.compile(source.id,true),task.id);assert.equal(requests.length,count,'ambiguous submit retries reuse the existing proposal');
  await assert.rejects(service.appendSourcePart(source.id,randomUUID(),'late.txt','text/plain',new TextEncoder().encode('late')),/不能修改/);
  const archive=workspace.backup(),other=fixture(t);other.workspace.importBackup(archive,false);assert.deepEqual(other.store.getSource(source.id)!.parts,saved.parts);
});

test('mixed PDFs preserve every original, shared offsets and purge/restore ownership', async t => {
  const {service,store,workspace}=fixture(t,{pdfExtract:async bytes=>({text:'page '+bytes[0],pages:1,ranges:[{page:1,start:0,end:6}]})});
  const source=await service.addSource({title:'two PDFs and prose',text:'preamble',staging:true});
  for(const name of ['one','two']){const partId=randomUUID(),upload=service.beginPdfUpload(name,source.id,partId);await service.appendPdfChunk(upload.uploadId,Buffer.from([name==='one'?1:2]).toString('base64'),false);const task=await finished(service,service.finishPdfUpload(upload.uploadId));assert.equal(task.status,'done',task.error);}
  await service.finalizeSource(source.id,false);service.tick();const saved=store.getSource(source.id)!;
  assert.equal(saved.parts!.length,2);assert.equal(saved.autoCompilePaused,true);assert.ok(saved.text.includes('preamble'));assert.ok(saved.text.includes('page 1'));assert.ok(saved.text.includes('page 2'));
  for(const part of saved.parts!){assert.equal(saved.text.slice(part.start,part.end),'page '+(part.name==='one.pdf'?1:2));assert.equal(part.ranges![0].start,part.start);assert.equal(store.assetBytes(part.asset!)[0],part.name==='one.pdf'?1:2);}
  const trash=workspace.deleteSource(source.id);workspace.restoreTrash(trash.id);const second=workspace.deleteSource(source.id);assert.equal(workspace.purgeTrash(second.id).assetsRemoved,2);
  for(const part of saved.parts!)assert.equal(existsSync(store.assetFile(part.asset!)),false);
});

test('JSON repair is bounded and failed repairs preserve original material without publishing', async t => {
  let calls=0;
  const {service,store}=fixture(t,{config:{...config,autoCompile:true},fetchImpl:async (_url,init)=>{calls++;const messages=JSON.parse(String(init?.body)).messages,repair=messages.some((item:{content:unknown})=>String(item.content).includes('JSON 格式修复器'));return new Response(JSON.stringify({choices:[{message:{content:repair?'{still invalid}':String(messages[0].content).includes('素材摄入')?'{}':'{"pages":[]} {"pages":[]}'} }]}));}});
  const source=await service.addSource({title:'original',text:'complete evidence'});const task=await finished(service,service.compile(source.id));
  assert.equal(task.status,'failed');assert.match(task.error!,/已尝试一次格式修复/);assert.equal(calls,3,'one ingest, one compile and exactly one format repair');
  assert.equal(store.getSource(source.id)!.text,'complete evidence');assert.equal(store.getSource(source.id)!.compiled,false);assert.equal(store.listDrafts().length,0);assert.equal(store.listPages().length,0);
  service.tick();assert.equal(calls,3,'failed format repair pauses automatic paid retries');assert.equal(store.getSource(source.id)!.autoCompilePaused,true);assert.equal(task.manualRetry,true);
});

test('one format repair recovers malformed model keys and retains the complete proposal',async t=>{
  let repairs=0;
  const result={summary:'修复后的完整提案',contradictions:[],pages:[{slug:'repaired',title:'repaired',kind:'note',body:'完整正文与尾部证据。',summary:'完整',sources:[],tags:[]}]};
  const {service,store}=fixture(t,{fetchImpl:async (_url,init)=>{const messages=JSON.parse(String(init?.body)).messages,repair=messages.some((message:{content:unknown})=>String(message.content).includes('JSON 格式修复器'));if(repair)repairs++;const content=repair?JSON.stringify(result):String(messages[0].content).includes('素材摄入')?'{}':'{pages: [{body: "完整正文与尾部证据。"}]}';return new Response(JSON.stringify({choices:[{message:{content}}]}));}});
  const source=await service.addSource({title:'repair',text:'完整正文与尾部证据。'}),task=await finished(service,service.compile(source.id));
  assert.equal(task.status,'done',task.error);assert.equal(repairs,1);assert.equal(store.listDrafts().length,1);assert.equal(store.listDrafts()[0].pages[0].body,result.pages[0].body);assert.equal(store.listPages().length,0);
});

test('Agents cannot read a partially uploaded mixed group before it is sealed',async t=>{
  const {root,controller}=fixture(t),commands=new Map<string,(params:Record<string,unknown>)=>unknown>();
  apply({berth:{dataDirectory:root,signal:controller.signal,interval(){},call:async()=>({sessions:[]}),command(d:{name:string},handler:(params:Record<string,unknown>)=>unknown){commands.set(d.name,handler);}},effect(){}} as never,{...config,allowAgentAccess:true});
  const source=await commands.get('add_source')!({title:'in progress',text:'first component',staging:true}) as {id:string};
  const listing=await commands.get('wiki_sources')!({}) as {items:{id:string}[]};assert.ok(!listing.items.some(item=>item.id===source.id));
  await assert.rejects(async()=>commands.get('wiki_source')!({id:source.id}),/完成整组保存/);
  await commands.get('finalize_source')!({id:source.id,autoCompile:false});const ready=await commands.get('wiki_source')!({id:source.id}) as {text:string};assert.equal(ready.text,'first component');
});

test('purging trash removes only selected records and unreferenced image/PDF assets', async t => {
  const { service, store, workspace } = fixture(t);
  const source = await service.addSource({ title: 'disposable', text: 'complete raw', images: [{ mime: 'image/png', base64: 'eA==' }] });
  const pdf = store.addDocument(new TextEncoder().encode('original PDF'));
  source.document = { name: 'original.pdf', asset: pdf, pages: 1, ranges: [] }; store.saveSource(source);
  const shared = await service.addSource({ title: 'live', text: 'another source' }); shared.images = [...source.images]; store.saveSource(shared);
  store.savePage(page('recoverable', 'page kept in trash'));
  const other = workspace.deletePage('recoverable'), removed = workspace.deleteSource(source.id);
  assert.throws(() => workspace.purgeTrash('../raw'), /无效/);
  const result = workspace.purgeTrash(removed.id);
  assert.deepEqual(result, { deleted: 1, assetsRemoved: 1, retainedAssets: 1, failedAssets: [], failedAssetCount: 0 });
  assert.equal(existsSync(store.assetFile(pdf)), false); assert.ok(existsSync(store.assetFile(shared.images[0])));
  assert.deepEqual(workspace.trash().map(item => item.id), [other.id]);
  assert.throws(() => workspace.restoreTrash(removed.id), /不存在/);
  workspace.restoreTrash(other.id); assert.equal(store.getPage('recoverable')!.body, 'page kept in trash');
  workspace.deleteSource(shared.id); assert.equal(workspace.purgeTrash().assetsRemoved, 1);
  assert.equal(workspace.trash().length, 0); assert.equal(workspace.purgeTrash().deleted, 0);
});

test('purging keeps attachments referenced by other trash, pages, review editors and history', async t => {
  const { service, store, workspace, root } = fixture(t);
  const source = await service.addSource({ title: 'images', text: 'raw', images: Array.from({ length: 6 }, () => ({ mime: 'image/png', base64: 'eA==' })) });
  const [live, trash, history, editor, shared, unused] = source.images;
  store.savePage(page('live', `![live](${live})`));
  store.savePage(page('trashed-page', `![trash](${trash})`)); workspace.deletePage('trashed-page');
  writeFileSync(path.join(root, 'history', 'old.1.md'), `![old](${history})`);
  workspace.saveEditorDraft('page:new', { body: `![unsaved](${editor})` });
  const other = await service.addSource({ title: 'other trash', text: 'raw two' }); other.images = [shared]; store.saveSource(other); workspace.deleteSource(other.id);
  const entry = workspace.deleteSource(source.id), backup = workspace.backup();
  const result = workspace.purgeTrash(entry.id);
  assert.equal(result.retainedAssets, 5); assert.equal(result.assetsRemoved, 1);
  for (const asset of [live, trash, history, editor, shared]) assert.ok(existsSync(store.assetFile(asset)), asset);
  assert.equal(existsSync(store.assetFile(unused)), false);
  assert.ok(unzipSync(backup)['raw/assets/' + unused], 'existing backup keeps its snapshot');
});

test('attachment cleanup failures are reported without leaving half-restorable trash records', async t => {
  const { service, store, workspace } = fixture(t);
  const source = await service.addSource({ title: 'cleanup failure', text: 'source', images: [{ mime: 'image/png', base64: 'eA==' }, { mime: 'image/png', base64: 'eA==' }] });
  const blocked = store.assetFile(source.images[0]); rmSync(blocked); mkdirSync(blocked);
  const entry = workspace.deleteSource(source.id), result = workspace.purgeTrash(entry.id);
  assert.equal(result.deleted, 1); assert.equal(result.assetsRemoved, 1); assert.equal(result.failedAssetCount, 1); assert.deepEqual(result.failedAssets, [source.images[0]]);
  assert.equal(workspace.trash().length, 0); assert.ok(existsSync(blocked)); assert.equal(existsSync(store.assetFile(source.images[1])), false);
});

test('deleting review records clears only their editors and preserves published pages and raw material', async t => {
  const { service, store, workspace } = fixture(t);
  const source = await service.addSource({ title: 'original', text: 'original complete source' });
  store.savePage(page('published', 'already published'));
  const draft: WikiDraft = { id: 'record', sourceId: source.id, sourceTitle: source.title, createdAt: new Date().toISOString(), status: 'pending', model: 'local', summary: 'proposal', pages: [], contradictions: [], feedback: [] };
  store.saveDraft(draft); workspace.saveEditorDraft('review:record', { feedback: 'unsaved feedback' });
  workspace.saveEditorDraft('review:record:page', { body: 'unsaved edit' }); workspace.saveEditorDraft('page:new', { body: 'other editor' });
  assert.equal(service.status().pendingDrafts, 1);
  await service.deleteDraft(draft.id);
  assert.equal(store.getDraft(draft.id), null); assert.equal(service.status().pendingDrafts, 0);
  assert.deepEqual(workspace.editorDrafts().map(item => item.key), ['page:new']);
  workspace.saveEditorDraft('review:record:page', { body: 'late autosave' }); assert.equal(workspace.editorDrafts().length, 1);
  assert.equal(store.getPage('published')!.body, 'already published'); assert.equal(store.getSource(source.id)!.text, source.text);
  assert.equal(store.getSource(source.id)!.autoCompilePaused, true);
  await assert.rejects(service.deleteDraft(draft.id), /不存在/);
  for (const status of ['approved', 'rejected'] as const) { store.saveDraft({ ...draft, id: status, status }); await service.deleteDraft(status); assert.equal(store.getDraft(status), null); }
});

test('deleted review stays paused across restart and manual compile resumes the complete source', async t => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'compiled', concepts: [], claims: [], contradictions: [], pages: [{ slug: 'compiled', title: 'compiled', kind: 'note', summary: 'summary', body: 'compiled full source', sources: [], tags: [] }] }) } }] })); };
  const { service, store } = fixture(t, { config: { ...config, autoCompile: true }, fetchImpl });
  const source = await service.addSource({ title: 'pause me', text: 'complete source text' });
  store.saveDraft({ id: 'rejected', sourceId: source.id, sourceTitle: source.title, createdAt: new Date().toISOString(), status: 'rejected', model: 'local', summary: '', pages: [], contradictions: [], feedback: [] });
  await service.deleteDraft('rejected'); service.tick(); assert.equal(requests, 0);
  const controller = new AbortController(); t.after(() => controller.abort());
  const reopened = new WikiService({ store: new WikiStore(store.root), config: { ...config, autoCompile: true }, signal: controller.signal, fetchImpl });
  reopened.tick(); assert.equal(requests, 0);
  const task = await finished(reopened, reopened.compile(source.id)); assert.equal(task.status, 'done', task.error); assert.ok(requests > 0);
  assert.equal(store.getSource(source.id)!.autoCompilePaused, undefined); assert.equal(store.listDrafts().length, 1);
});

test('review deletion refuses an active compile and automatic compilation drains all queued sources', async t => {
  let release!: (response: Response) => void, requests = 0;
  const response = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'compiled', concepts: [], claims: [], contradictions: [], pages: [{ slug: 'compiled', title: 'compiled', kind: 'note', summary: 'summary', body: 'compiled full source', sources: [], tags: [] }] }) } }] }));
  const { service, store } = fixture(t, { config: { ...config, autoCompile: true }, fetchImpl: async () => { if (++requests === 1) return new Promise(resolve => { release = resolve; }); return response(); } });
  const one = await service.addSource({ title: 'one', text: 'first full source' });
  const two = await service.addSource({ title: 'two', text: 'second full source' });
  store.saveDraft({ id: 'busy', sourceId: one.id, sourceTitle: one.title, createdAt: new Date().toISOString(), status: 'pending', model: 'local', summary: '', pages: [], contradictions: [], feedback: [] });
  const id = service.compile(one.id);
  await assert.rejects(service.deleteDraft('busy'), /正在编译或审阅/); assert.ok(store.getDraft('busy'));
  release(response()); const task = await finished(service, id); assert.equal(task.status, 'done', task.error);
  for (let i = 0; i < 300 && !store.getSource(two.id)?.compiled; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.getSource(two.id)!.compiled, true, 'next source starts without a one-minute poll');
  const count = requests; service.tick(); assert.equal(requests, count, 'compiled sources are not replayed');
});

test('editor drafts survive reopen, clear explicitly and exclude credential fields', t => {
  const { store, workspace } = fixture(t);
  workspace.saveEditorDraft('page:notes', { title: 'draft', body: '未提交的最后一行', baseline: 'before-edit' });
  assert.equal(new WikiWorkspace(new WikiStore(store.root)).editorDrafts()[0].fields.body, '未提交的最后一行');
  assert.throws(() => workspace.saveEditorDraft('schema', { apiKey: 'private' }), /凭据|字段/);
  workspace.saveEditorDraft('page:notes', null); assert.equal(workspace.editorDrafts().length, 0);
});

test('restoring an automatic snapshot removes imported additions and can itself be undone', async t => {
  const before = fixture(t), imported = fixture(t);
  before.store.saveCredentials('keep-this-key'); before.store.savePage(page('existing', 'before import'));
  imported.store.savePage(page('existing', 'imported replacement')); imported.store.savePage(page('added', 'imported addition'));
  await imported.service.addSource({ title: 'imported source', text: 'imported source body', images: [{ mime: 'image/png', base64: 'eA==' }] });
  imported.workspace.saveEditorDraft('page:added', { body: 'imported draft' });
  const result = before.workspace.importBackup(imported.workspace.backup(), true);
  assert.ok(before.store.getPage('added')); assert.equal(before.store.listSources().length, 1);
  const preview = before.workspace.previewRollback(result.rollback);
  assert.ok(preview.removed.includes('wiki/added.md')); assert.ok(preview.removedCount >= 4);
  const undo = before.workspace.restoreRollback(result.rollback);
  assert.equal(before.store.getPage('existing')!.body, 'before import'); assert.equal(before.store.getPage('added'), null);
  assert.equal(before.store.listSources().length, 0); assert.equal(before.workspace.editorDrafts().length, 0);
  assert.equal(before.store.credentials().apiKey, 'keep-this-key');
  before.workspace.restoreRollback(undo.rollback);
  assert.equal(before.store.getPage('existing')!.body, 'imported replacement'); assert.ok(before.store.getPage('added'));
  assert.equal(before.store.listSources().length, 1); assert.equal(before.store.credentials().apiKey, 'keep-this-key');
});

test('restoring workspace state waits for cancelled requests and incomplete PDF transfers', async t => {
  let release!: (response: Response) => void;
  const { service } = fixture(t, { fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const task = service.ask('pending request'); service.cancelTask(task);
  assert.throws(() => service.assertWorkspaceIdle(), /取消处理/);
  release(new Response(JSON.stringify({ choices: [{ message: { content: 'late reply' } }] })));
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => service.assertWorkspaceIdle());
  const upload = service.beginPdfUpload('incomplete'); assert.throws(() => service.assertWorkspaceIdle(), /上传/);
  service.cancelPdfUpload(upload.uploadId); assert.doesNotThrow(() => service.assertWorkspaceIdle());
});

test('interrupted compile history stays paused after restore and restart until explicitly retried', async t => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'compiled', concepts: [], claims: [], contradictions: [], pages: [{ slug: 'compiled', title: 'compiled', kind: 'note', summary: 'summary', body: 'compiled full source', sources: [], tags: [] }] }) } }] })); };
  const { store, service, workspace } = fixture(t, { config: { ...config, autoCompile: true }, fetchImpl });
  const source = await service.addSource({ title: 'interrupted', text: 'source awaiting manual retry' });
  workspace.saveTasks([{ id: 'interrupted', kind: 'compile', status: 'running', progress: 'running', label: 'Interrupted compile', startedAt: new Date().toISOString(), retry: { action: 'compile', params: { sourceId: source.id } } }]);
  service.reloadWorkspaceState(); service.tick(); assert.equal(calls, 0);
  assert.equal(service.taskStatus('interrupted')!.status, 'failed'); assert.equal(service.taskStatus('interrupted')!.manualRetry, true);
  const controller = new AbortController(); t.after(() => controller.abort());
  const reopened = new WikiService({ store: new WikiStore(store.root), config: { ...config, autoCompile: true }, signal: controller.signal, fetchImpl });
  reopened.tick(); assert.equal(calls, 0, 'automatic compilation must not replay an interrupted request');
  await finished(reopened, reopened.retryTask('interrupted')); assert.ok(calls > 0);
});

test('backup commands refresh task history immediately and normalise unfinished imported work', async t => {
  const a = fixture(t), b = fixture(t), commands = new Map<string, (p: Record<string, unknown>) => unknown>();
  a.workspace.saveTasks([{ id: 'imported-task', kind: 'ask', status: 'queued', progress: '', label: 'Imported task', startedAt: new Date().toISOString(), retry: { action: 'ask', params: { question: 'manual retry only' } } }]);
  const bytes = a.workspace.backup();
  apply({ berth: { dataDirectory: b.root, signal: b.controller.signal, interval() {}, call: async () => ({ sessions: [] }), command(d: { name: string }, handler: (p: Record<string, unknown>) => unknown) { commands.set(d.name, handler); } }, effect() {} } as never, { ...config });
  const upload = await commands.get('backup_upload_start')!({}) as { id: string };
  for (let i = 0; i < bytes.length; i += 36000) await commands.get('backup_upload_chunk')!({ id: upload.id, base64: Buffer.from(bytes.subarray(i, i + 36000)).toString('base64'), done: i + 36000 >= bytes.length });
  await commands.get('apply_backup')!({ id: upload.id, overwrite: true });
  const tasks = await commands.get('tasks')!({}) as WikiTask[];
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'failed'); assert.equal(tasks[0].manualRetry, true); assert.match(tasks[0].error!, /手动重试/);
});

test('large backup conflict previews retain accurate totals within the desktop RPC budget', t => {
  const { store, workspace } = fixture(t), files: Record<string, Uint8Array> = { 'wiki-backup.json': new TextEncoder().encode(JSON.stringify({ format: 'agentberth-wiki', version: 1 })) };
  for (let i = 0; i < 220; i++) {
    const slug = '多语言知识页面'.repeat(7) + '-' + i; store.savePage(page(slug, 'current'));
    files['wiki/' + slug + '.md'] = new TextEncoder().encode('different archived body');
  }
  const preview = workspace.previewBackup(zipSync(files));
  assert.equal(preview.conflictCount, 220); assert.equal(preview.conflicts.length, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 24 * 1024);
});

test('trash restores original sources and image bytes without overwriting an existing page', async t => {
  const { store, service, workspace } = fixture(t);
  const source = await service.addSource({ title: 'source', text: 'raw', images: [{ mime: 'image/png', base64: Buffer.from('original').toString('base64') }] });
  const asset = source.images[0], removed = workspace.deleteSource(source.id);
  assert.equal(store.getSource(source.id), null); assert.ok(store.imageData(asset));
  workspace.restoreTrash(removed.id); assert.equal(store.getSource(source.id)!.images[0], asset);
  const original = page('note', 'first'); store.savePage(original); const deleted = workspace.deletePage('note');
  store.savePage(page('note', 'newer')); assert.throws(() => workspace.restoreTrash(deleted.id), /同名/);
  assert.equal(store.getPage('note')!.body, 'newer'); store.deletePage('note'); workspace.restoreTrash(deleted.id);
  assert.equal(store.getPage('note')!.body, 'first');
});

test('backups preserve documents and drafts, exclude credentials, reject traversal and preview conflicts before import', async t => {
  const a = fixture(t), b = fixture(t); a.store.saveCredentials('must-not-export'); a.store.savePage(page('note', 'backup value'));
  a.workspace.saveEditorDraft('schema', { schema: 'local edits' });
  const pdf = await a.service.ingestPdfFile('paper.pdf', new Uint8Array([1])).catch(() => null); assert.equal(pdf, null);
  const bytes = a.workspace.backup(), entries = unzipSync(bytes);
  assert.equal(entries['credentials.json'], undefined); assert.ok(!Buffer.from(bytes).includes(Buffer.from('must-not-export')));
  b.store.saveCredentials('retain-local-key'); b.store.savePage(page('note', 'current value'));
  assert.ok(b.workspace.previewBackup(bytes).conflicts.includes('wiki/note.md'));
  b.workspace.importBackup(bytes, false); assert.equal(b.store.getPage('note')!.body, 'current value');
  const restored = b.workspace.importBackup(bytes, true); assert.equal(b.store.getPage('note')!.body, 'backup value');
  assert.equal(b.store.credentials().apiKey, 'retain-local-key'); assert.ok(b.workspace.rollbackBackups().includes(restored.rollback));
  const malicious = zipSync({ ...entries, '../outside.txt': new TextEncoder().encode('bad') });
  assert.throws(() => b.workspace.importBackup(malicious, true), /路径/); assert.equal(b.store.getPage('note')!.body, 'backup value');
  const secret = zipSync({ ...entries, 'credentials.json': new TextEncoder().encode('{}') });
  assert.throws(() => b.workspace.previewBackup(secret), /路径/);
});

test('PDF uploads can be cancelled during parsing and completed originals retain page offsets', async t => {
  let resolve!: (result: { text: string; pages: number; ranges: { page: number; start: number; end: number }[] }) => void;
  const { store, service } = fixture(t, { pdfExtract: () => new Promise(done => { resolve = done; }) });
  const upload = service.beginPdfUpload('cancel'); const pending = service.appendPdfChunk(upload.uploadId, 'eA==', true);
  assert.equal(service.cancelPdfUpload(upload.uploadId), true); resolve({ text: 'content', pages: 1, ranges: [] });
  await assert.rejects(pending, /取消/); assert.equal(store.listSources().length, 0);
  const next = service.beginPdfUpload('preserved'); const complete = service.appendPdfChunk(next.uploadId, 'eA==', true);
  resolve({ text: 'content', pages: 1, ranges: [{ page: 1, start: 0, end: 7 }] });
  const result = await complete, document = store.getSource(result!.id)!.document!;
  assert.equal(document.pages, 1); assert.equal(document.ranges[0].end, 7); assert.equal(Buffer.from(store.assetBytes(document.asset)).toString(), 'x');
});

test('active model tasks cancel without storing answers, queued tasks cancel, and retries survive a restart', async t => {
  let calls = 0;
  const { store, service } = fixture(t, { fetchImpl: async (_url, init) => { calls++; return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); } });
  const first = service.ask('cancel active'), queued = service.ask('cancel queued');
  service.cancelTask(queued); service.cancelTask(first);
  assert.equal((await finished(service, first)).status, 'cancelled'); assert.equal(service.taskStatus(queued)!.status, 'cancelled');
  assert.equal(calls, 1); assert.equal(service.answers().length, 0);
  const controller = new AbortController(); t.after(() => controller.abort());
  const reopened = new WikiService({ store: new WikiStore(store.root), config, signal: controller.signal, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'retried answer' } }] })) });
  const retried = await finished(reopened, reopened.retryTask(queued)); assert.equal(retried.status, 'done'); assert.equal(reopened.answers()[0].answer, 'retried answer');
});

test('review selection and explicit human merge preserve conflict checks and explain every skipped page', async t => {
  const { store, service } = fixture(t); const original = page('manual', 'original'); store.savePage(original);
  const draft: WikiDraft = { id: 'draft', sourceId: null, sourceTitle: 'review', createdAt: new Date().toISOString(), model: 'local', summary: '', contradictions: [], feedback: [], status: 'pending', pages: [
    { slug: 'manual', title: 'manual', summary: '', kind: 'note', body: 'proposal', sources: [], evidence: [], tags: [], previous: pageToDocument(original), action: 'skip' },
    { slug: 'skip', title: 'skip', summary: '', kind: 'note', body: 'not selected', sources: [], evidence: [], tags: [], previous: null, action: 'create' },
  ] }; store.saveDraft(draft);
  await service.editDraftPage('draft', 'manual', true, 'human reviewed proposal', true); await service.editDraftPage('draft', 'skip', false);
  const task = await finished(service, service.reviewDraft('draft', 'approve')); assert.equal(task.status, 'done');
  const result = task.result as { published: string[]; skippedDetails: { reason: string }[] }; assert.deepEqual(result.published, ['manual']); assert.match(result.skippedDetails[0].reason, /未选中/);
  assert.equal(store.getPage('manual')!.body, 'human reviewed proposal'); assert.equal(store.getPage('manual')!.humanEdited, true);
  store.saveDraft({ ...draft, id: 'stale', status: 'pending' }); await service.editDraftPage('stale', 'manual', true, 'stale proposal', true);
  const stale = await finished(service, service.reviewDraft('stale', 'approve')); assert.ok(!(stale.result as { published: string[] }).published.includes('manual'));
  assert.equal(store.getPage('manual')!.body, 'human reviewed proposal');
});

test('no-auth local models send no Authorization header and complete histories are not trimmed to twenty', async t => {
  let authorization: string | null = 'unset';
  const { service, store } = fixture(t, { fetchImpl: async (_url, init) => { authorization = new Headers(init?.headers).get('Authorization'); return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] })); } });
  assert.equal(service.status().ready, true);
  for (let i = 0; i < 23; i++) assert.equal((await finished(service, service.ask('question ' + i))).status, 'done');
  assert.equal(authorization, null); assert.equal(new WikiWorkspace(new WikiStore(store.root)).answers().length, 23);
  await assert.rejects(chat({ baseURL: config.baseURL, apiKey: '', model: 'cloud', messages: [] }), /API Key/);
});

test('binary transfers enforce bounds, expiration identity and generation cancellation', () => {
  const controller = new AbortController(), transfers = new WikiTransfers(controller.signal);
  const output = transfers.download('test.zip', new Uint8Array([1, 2, 3]));
  assert.equal(transfers.read(output.id, 0).base64, 'AQID'); assert.throws(() => transfers.read(output.id, -1), /位置/);
  const input = transfers.start('input.zip'); assert.throws(() => transfers.append(input.id, Buffer.alloc(40000).toString('base64'), false), /分片/);
  controller.abort(); assert.throws(() => transfers.read(output.id, 0), /过期/);
});

test('view commands paginate full-text matches, locate late evidence and scope binary reads to their source', async t => {
  const { root, service, controller } = fixture(t);
  const first = await service.addSource({ title: 'long source', text: '开头'.repeat(15000) + '末尾的独有证据', images: [{ mime: 'image/png', base64: 'eA==' }] });
  const second = await service.addSource({ title: 'other', text: 'other', images: [{ mime: 'image/png', base64: 'eQ==' }] });
  await service.savePage({ slug: 'body-only', title: 'title', body: 'only-full-text-match', tags: ['project'] });
  const commands = new Map<string, { mcp: boolean; handler: (p: Record<string, unknown>) => unknown }>();
  apply({ berth: { dataDirectory: root, signal: controller.signal, interval() {}, command(d: { name: string; mcp: boolean }, handler: (p: Record<string, unknown>) => unknown) { commands.set(d.name, { ...d, handler }); }, call: async () => ({ sessions: [] }) }, effect() {} } as never, { ...config });
  const call = async (name: string, params: Record<string, unknown> = {}) => commands.get(name)!.handler(params);
  const matches = await call('list_pages', { query: 'only-full-text-match', tag: 'project', offset: 0, limit: 1 }) as { slug: string }[];
  assert.deepEqual(matches.map(item => item.slug), ['body-only']);
  const located = await call('source_text', { id: first.id, quote: '末尾的独有证据' }) as { text: string; offset: number };
  assert.ok(located.text.includes('末尾的独有证据')); assert.ok(located.offset > 12000);
  await assert.rejects(call('download_source_asset', { id: first.id, name: second.images[0] }), /不属于/);
  const download = await call('download_source_asset', { id: first.id, name: first.images[0] }) as { id: string };
  assert.equal((await call('binary_chunk', { id: download.id, offset: 0 }) as { base64: string }).base64, 'eA==');
  for (const name of ['save_editor_draft', 'cancel_task', 'restore_trash', 'edit_draft_page', 'apply_backup']) assert.equal(commands.get(name)!.mcp, false, name);
});

test('malformed backup records are refused before any file is overwritten', t => {
  const { store, workspace } = fixture(t); store.savePage(page('original', 'keep this'));
  const entries = unzipSync(workspace.backup());
  const bytes = zipSync({ ...entries, 'raw/bad.json': new TextEncoder().encode(JSON.stringify({ id: 'bad', title: 'missing body' })) });
  assert.throws(() => workspace.importBackup(bytes, true), /素材无效/);
  assert.equal(store.getPage('original')!.body, 'keep this'); assert.equal(existsSync(path.join(store.root, 'raw', 'bad.json')), false);
});

test('large question and proposal summaries stay within the view message budget', async t => {
  const { root, store, service, controller } = fixture(t), long = '长内容'.repeat(2000), meta = store.meta();
  meta.answers = Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.now() + i * 1000).toISOString(), question: long.slice(0, 2000), answer: long, citations: [], pages: [], evidence: [], model: 'model' })); store.saveMeta(meta);
  for (let i = 0; i < 10; i++) store.saveDraft({ id: 'draft-' + i, sourceId: null, sourceTitle: long.slice(0, 160), model: 'local', createdAt: new Date().toISOString(), summary: long.slice(0, 400), contradictions: [], feedback: [], status: 'pending', pages: Array.from({ length: 20 }, (_, n) => ({ slug: 'page-' + n, title: long.slice(0, 160), body: 'body', summary: long.slice(0, 400), sources: [], tags: [], evidence: [], kind: 'note', action: 'create', previous: null })) });
  const commands = new Map<string, (p: Record<string, unknown>) => unknown>();
  apply({ berth: { dataDirectory: root, signal: controller.signal, interval() {}, command(d: { name: string }, handler: (p: Record<string, unknown>) => unknown) { commands.set(d.name, handler); }, call: async () => ({ sessions: [] }) }, effect() {} } as never, { ...config });
  const answers = await commands.get('answers')!({ limit: 25 }); const drafts = await commands.get('list_drafts')!({ limit: 10 });
  assert.ok(Buffer.byteLength(JSON.stringify(answers)) < 96 * 1024); assert.equal((answers as unknown[]).length, 25);
  assert.ok(Buffer.byteLength(JSON.stringify(drafts)) < 96 * 1024); assert.equal((drafts as unknown[]).length, 10);
  assert.equal(service.answers().length, 30, 'summary budgets never change the full stored history');
});

test('answers completed in the same millisecond keep distinct records and UI identities', t => {
  const { workspace } = fixture(t);
  const first = { at: '2026-11-10T00:00:00.000Z', question: 'first', answer: 'one', citations: [], pages: [], evidence: [], model: 'local' };
  const second = { ...first, question: 'second', answer: 'two' };
  workspace.saveAnswer(first); workspace.saveAnswer(second);
  assert.notEqual(first.at, second.at); assert.equal(workspace.answers().length, 2);
  assert.deepEqual(workspace.answers().map(answer => answer.answer).sort(), ['one', 'two']);
});
