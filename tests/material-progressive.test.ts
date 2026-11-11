import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WikiStore } from '../src/wiki/store';
import { WikiService } from '../src/wiki/service';
import { WikiTransfers } from '../src/wiki/transfers';
import { materialSegments, partitionProposalPages } from '../src/wiki/material';
import { readHistory } from '../src/daemon/history';
import type { WikiConfig } from '../src/wiki/types';

const config: WikiConfig = { baseURL: 'http://localhost/v1', textModel: 'local', visionModel: '', autoCompile: false, autoApprove: false, authRequired: false, lintMinutes: 0, maxContextPages: 8 };
function setup(t: { after: (fn: () => void) => void }, options: Partial<ConstructorParameters<typeof WikiService>[0]> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'berth-full-material-')), controller = new AbortController(), store = new WikiStore(root);
  const service = new WikiService({ store, signal: controller.signal, config, ...options });
  t.after(() => { controller.abort(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, store, service, controller };
}
async function finished(service: WikiService, id: string) { for (let i = 0; i < 1000; i++) { const task = service.taskStatus(id)!; if (!['queued', 'running'].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('task timeout'); }

test('material windows reconstruct the entire Unicode source without splitting pairs', () => {
  const text = 'BEGIN-' + 'A😀汉字\n'.repeat(120000) + '-TAIL';
  const parts = [...materialSegments(text)]; assert.ok(parts.length > 20);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.ok(parts.every(part => part.text.length <= 12000 && !/[\uD800-\uDBFF]$/.test(part.text) && !/^[\uDC00-\uDFFF]/.test(part.text)));
});

test('long model page results are partitioned without discarding their tail', () => {
  const body = '生成的长页面😀\n'.repeat(10000) + 'FINAL-PROPOSAL';
  const pages = partitionProposalPages([{ title: 'Long proposal', slug: 'long', body }]) as { body: string; slug: string }[];
  assert.ok(pages.length > 1); assert.equal(pages.map(page => page.body).join(''), body);
  assert.equal(new Set(pages.map(page => page.slug)).size, pages.length);
});

test('long material is saved completely and every segment including the tail reaches the model', async t => {
  const disclosed: string[] = []; let part = '';
  const { service, store } = setup(t, { fetchImpl: async (_url, init) => {
    const messages = JSON.parse(String(init!.body)).messages as { content: string }[];
    const prompt = messages.at(-1)!.content, ingest = prompt.includes('# 正文');
    let payload: object;
    if (ingest) { part = prompt.split('# 正文\n')[1]; disclosed.push(part); payload = { summary: 'part', concepts: [], claims: [], contradictions: [] }; }
    else payload = { summary: 'compiled', contradictions: [], pages: [{ slug: 'all-material', title: 'All material', kind: 'note', body: 'segment ' + disclosed.length + ': ' + part.slice(-80) }] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  } });
  const text = 'FIRST-MARKER\n' + 'large material 中英混合\n'.repeat(20000) + '\nLAST-MARKER';
  const source = await service.addSource({ title: 'full source', text });
  assert.equal(store.getSource(source.id)!.text, text);
  const task = await finished(service, service.compile(source.id)); assert.equal(task.status, 'done', task.error);
  assert.equal(disclosed.join(''), text, 'the model must see all characters, not only the source prefix');
  assert.ok(disclosed.every(part => part.length <= 12000));
  const draft = service.getDraft(String(task.result))!;
  assert.equal(draft.coverage?.characters, text.length); assert.equal(draft.coverage?.segments, disclosed.length);
  assert.ok(draft.pages.map(page => page.body).join('\n').includes('LAST-MARKER'));
});

test('full ACP capture walks all pages and retains long events, IDs and workspace labels', async t => {
  const records = Array.from({ length: 523 }, (_, i) => ({ sequence: i + 1, kind: i % 2 ? 'assistant' : 'user', text: i === 0 ? 'FIRST-' + 'x'.repeat(50000) : i === 522 ? 'LAST-EVENT' : 'message-' + i }));
  const id = '12345678-1234-4234-8234-123456789012'; const pages: number[] = [];
  const { service } = setup(t, { call: async (method, p = {}) => {
    if (method === 'state') return { projects: [{ id: 'workspace', name: '研发工作区', path: '/example/project' }], sessions: [{ id, projectId: 'workspace', title: '完整讨论', agent: 'agent:test', nativeSessionId: 'native-123' }], agents: [{ id: 'agent:test', name: 'Test ACP', acp: {} }] };
    if (method === 'acpSnapshot') { if (p.after === undefined) return { events: records.slice(-1) }; pages.push(Number(p.after)); const page = records.filter(record => record.sequence > Number(p.after)).slice(0, Number(p.limit)); return { events: page, hasMore: page.at(-1)!.sequence < records.length }; }
    throw new Error(method);
  } });
  const sessions = await service.listCaptureSessions(); assert.equal(sessions[0].projectName, '研发工作区'); assert.equal(sessions[0].nativeSessionId, 'native-123');
  const captured = await service.captureSession(id), source = service.getSource(captured.id)!;
  assert.equal(captured.events, 523); assert.ok(pages.length > 5); assert.ok(source.text.includes('x'.repeat(50000)));
  for (const marker of ['FIRST-', 'LAST-EVENT', id, 'native-123', '研发工作区', '完整讨论']) assert.ok(source.text.includes(marker), marker);
});

test('native full history bypasses presentation caps while keeping normal previews bounded', async t => {
  const { root } = setup(t), file = path.join(root, 'history.jsonl');
  const messages = Array.from({ length: 1205 }, (_, index) => ({ type: 'response_item', payload: { type: 'message', role: index % 2 ? 'assistant' : 'user', content: [{ type: 'output_text', text: index === 0 ? 'ORIGINAL-' + 'a'.repeat(50000) : 'message-' + index + '-END' + 'b'.repeat(700) }] } }));
  writeFileSync(file, [{ type: 'session_meta', payload: { id: 'native-full', cwd: root } }, ...messages].map(record => JSON.stringify(record)).join('\n'));
  const preview = await readHistory(file, 'codex', root), complete = await readHistory(file, 'codex', root, { full: true });
  assert.ok(preview.messages.length < 1205); assert.equal(complete.messages.length, 1205);
  assert.equal(complete.messages[0].text.length, 50009); assert.ok(complete.messages.at(-1)!.text.includes('message-1204-END'));
});

test('material transfers accept data beyond the old 64 MiB ceiling and clean up on cancellation', t => {
  const controller = new AbortController(), transfers = new WikiTransfers(controller.signal); t.after(() => controller.abort());
  const upload = transfers.start('large-material.txt', 'text/plain'), chunk = Buffer.alloc(36 * 1024, 65).toString('base64');
  for (let offset = 0; offset < 65 * 1024 * 1024; offset += 36 * 1024) assert.equal(transfers.append(upload.id, chunk, false), null);
  assert.equal(transfers.cancel(upload.id), true); assert.throws(() => transfers.bytes(upload.id), /过期/);
});

test('image material keeps original bytes and all images beyond previous count and size limits', async t => {
  const { service, store } = setup(t), bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 97);
  const source = await service.addSource({ title: 'original images', text: 'images', images: Array.from({ length: 12 }, () => ({ mime: 'image/png', base64: 'eA==' })) });
  assert.equal(source.images.length, 12);
  const added = await service.addImage(source.id, 'image/png', bytes.toString('base64'));
  assert.equal(added.images, 13); assert.deepEqual(Buffer.from(store.assetBytes(added.name)), bytes);
});

test('PDF originals with identical extracted text are distinct unless their original bytes match', async t => {
  const { service, store } = setup(t, { pdfExtract: async () => ({ text: 'same extracted text', pages: 1 }) });
  const first = await service.ingestPdfFile('document.pdf', new Uint8Array([1, 2, 3]));
  const second = await service.ingestPdfFile('document.pdf', new Uint8Array([4, 5, 6]));
  const repeat = await service.ingestPdfFile('document.pdf', new Uint8Array([1, 2, 3]));
  assert.notEqual(first.id, second.id); assert.equal(repeat.id, first.id); assert.equal(repeat.skipped, true);
  assert.deepEqual([...store.assetBytes(store.getSource(second.id)!.document!.asset)], [4, 5, 6]);
});

test('a completely uploaded PDF survives queue waits beyond the idle upload TTL', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const { service, store } = setup(t, { pdfExtract: async bytes => {
    if (bytes[0] === 1) await gate;
    return { text: 'complete PDF ' + bytes[0], pages: 1 };
  } });
  const first = service.beginPdfUpload('first'); await service.appendPdfChunk(first.uploadId, 'AQ==', false);
  const firstTask = service.finishPdfUpload(first.uploadId);
  const second = service.beginPdfUpload('queued'); await service.appendPdfChunk(second.uploadId, 'Ag==', false);
  const secondTask = service.finishPdfUpload(second.uploadId);
  assert.equal(service.taskStatus(secondTask)!.status, 'queued');
  const abandoned = service.beginPdfUpload('abandoned browser upload');
  clock += 11 * 60_000;
  const idle = service.beginPdfUpload('sweep expired idle uploads');
  await assert.rejects(service.appendPdfChunk(abandoned.uploadId, 'Aw==', false), /过期/);
  release();
  assert.equal((await finished(service, firstTask)).status, 'done');
  const result = await finished(service, secondTask);
  assert.equal(result.status, 'done', result.error);
  const source = store.getSource((result.result as { id: string }).id)!;
  assert.equal(source.text, 'complete PDF 2');
  assert.deepEqual([...store.assetBytes(source.document!.asset)], [2]);
  assert.equal(service.cancelPdfUpload(idle.uploadId), true);
});

test('submitting a PDF freezes its bytes while another PDF is still being parsed', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const { service } = setup(t, { pdfExtract: async bytes => {
    if (bytes[0] === 1) await gate;
    return { text: 'complete PDF ' + bytes[0], pages: 1 };
  } });
  const first = service.beginPdfUpload('blocker'); await service.appendPdfChunk(first.uploadId, 'AQ==', false);
  const active = service.finishPdfUpload(first.uploadId);
  const next = service.beginPdfUpload('immutable'); await service.appendPdfChunk(next.uploadId, 'Ag==', false);
  const queued = service.finishPdfUpload(next.uploadId);
  await assert.rejects(service.appendPdfChunk(next.uploadId, 'Aw==', false), /已提交|正在解析/);
  await assert.rejects(service.appendPdfChunk(next.uploadId, '', true), /已提交|正在解析/);
  assert.equal(service.cancelTask(queued), true); release();
  assert.equal((await finished(service, active)).status, 'done');
});

test('a full task queue leaves the completed PDF upload available for a later submission', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const { service, store } = setup(t, { pdfExtract: async bytes => {
    if (bytes[0] === 1) await gate;
    return { text: 'complete PDF ' + bytes[0], pages: 1 };
  } });
  const first = service.beginPdfUpload('blocker'); await service.appendPdfChunk(first.uploadId, 'AQ==', false);
  const active = service.finishPdfUpload(first.uploadId);
  const backlog = Array.from({ length: 100 }, () => service.lint());
  const upload = service.beginPdfUpload('retry without reupload'); await service.appendPdfChunk(upload.uploadId, 'Ag==', false);
  assert.throws(() => service.finishPdfUpload(upload.uploadId), /后台任务过多/);
  assert.equal(await service.appendPdfChunk(upload.uploadId, '', false), null, 'failed submission must not freeze the upload');
  backlog.forEach(id => assert.equal(service.cancelTask(id), true)); release();
  assert.equal((await finished(service, active)).status, 'done');
  const parsed = await finished(service, service.finishPdfUpload(upload.uploadId));
  assert.equal(parsed.status, 'done', parsed.error);
  const source = store.getSource((parsed.result as { id: string }).id)!;
  assert.deepEqual([...store.assetBytes(source.document!.asset)], [2]);
});
