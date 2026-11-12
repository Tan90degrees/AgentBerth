import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { unzipSync } from 'fflate';
import { cleanupSmoke } from './smoke-cleanup.mjs';

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
    { slug: '向量检索', title: '向量检索', kind: 'concept', summary: '用嵌入召回候选', tags: ['检索'], body: '# 向量检索\n\n用嵌入召回候选，见 [[重排序]]。', sources: [], evidence: [{ quote: '向量检索与重排序的关系' }] },
    { slug: '重排序', title: '重排序', kind: 'concept', summary: '提升精度', tags: [], body: '# 重排序\n\n提升精度，见 [[向量检索]]。', sources: [], evidence: [{ quote: '向量检索与重排序的关系' }] },
  ] });
  else if (joined.includes('查询（Query）')) content = '要点：召回后需要重排序 [[向量检索]]，依据见 [[重排序]]。';
  else if (joined.includes('体检（Lint）')) content = JSON.stringify({ contradictions: [], orphans: [], missing: [], stale: [], suggestions: ['补充混合检索页面'] });
  else content = '可用';
  if(joined.includes('编译（Compile）')&&joined.includes('混合资料窗口验证'))content+='\n提案已整理完成。';
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const port = model.address().port;

let application, daemonPid, failure;
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
  if (process.env.AGENTBERTH_SMOKE_HEADLESS === '1') args.push('--ozone-platform=headless');
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
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
  daemonPid = JSON.parse(await readFile(path.join(folder, 'data', 'runtime.json'), 'utf8')).pid;
  step('extension is active');

  await ext({ action: 'configure', id: 'notes-wiki', config: {
    baseURL: `http://127.0.0.1:${port}/v1`, textModel: 'mock-text', visionModel: 'mock-vision',
    autoCompile: false, allowAgentAccess: true, allowAgentQueries: true, lintMinutes: 0, maxContextPages: 8,
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

  const detail = await call('get_page', { slug: '向量检索' });
  assert.ok(detail.excerpts.length > 0 && detail.excerpts[0].verified, 'published quotes resolve back to raw text');
  assert.ok(detail.excerpts[0].context.includes('向量检索'));
  step('page citations trace back to the immutable source');

  const catalog = await ext({ action: 'list' });
  const plugin = catalog.plugins.find(item => item.manifest.id === 'notes-wiki');
  const tools = new Map(plugin.commands.map(command => [command.name, command]));
  for (const name of ['wiki_index', 'wiki_search', 'wiki_read', 'wiki_sources', 'wiki_source', 'wiki_status', 'wiki_ask', 'wiki_task'])
    assert.equal(tools.get(name)?.mcp, true, name + ' is exposed as an MCP tool');
  for (const name of ['save_page', 'add_source', 'compile', 'review_draft', 'set_api_key', 'delete_draft', 'purge_trash', 'clear_trash', 'scan_inbox'])
    assert.equal(tools.get(name)?.mcp, false, name + ' stays behind human review');
  const hits = await call('wiki_search', { query: '向量检索', agentId: 'smoke-agent' });
  assert.ok(hits.some(item => item.slug === '向量检索'), 'MCP search tolerates the injected agentId');
  const agentRead = await call('wiki_read', { slug: '向量检索', agentId: 'smoke-agent' });
  assert.ok(agentRead.excerpts.length > 0, 'Agents see the same provenance as the UI');
  const asked = await call('wiki_ask', { question: '怎么提升精度？' });
  await until(async () => {
    const task = await call('wiki_task', { id: asked.taskId });
    return task && ['done', 'failed'].includes(task.status);
  }, 'wiki_ask task');
  const askedTask = await call('wiki_task', { id: asked.taskId });
  assert.equal(askedTask.status, 'done', askedTask.error);
  assert.ok(askedTask.result.evidence.length > 0, 'MCP answers carry raw sources');
  step('MCP read-only tools, agentId tolerance and task polling work');

  const inbox = await call('inbox_status');
  assert.equal(inbox.watching, true);
  await writeFile(path.join(inbox.dir, 'window-note.md'), '# 窗口自动采集\n\n这是一份从文件落盘自动进入的素材。');
  await until(async () => (await call('list_sources')).some(item => item.title === 'window-note'), 'inbox auto import');
  assert.ok(Array.isArray(await call('list_capture_sessions')));
  step('raw/inbox watcher imports dropped files inside the real daemon');

  // PDF import goes through the chunked bridge commands and the real pdf.js.
  const samplePdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 68>>stream\nBT /F1 24 Tf 20 100 Td (Hello AgentBerth PDF) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const upload = await call('pdf_upload_start', { title: '窗口 PDF 导入' });
  for (let offset = 0; ; offset += 12000) {
    const piece = samplePdf.subarray(offset, offset + 12000);
    const done = offset + 12000 >= samplePdf.length;
    await call('pdf_upload_chunk', { uploadId: upload.uploadId, base64: piece.toString('base64'), done });
    if (done) break;
  }
  const uploaded = (await call('list_sources')).find(item => item.title === '窗口 PDF 导入');
  assert.ok(uploaded, 'chunked PDF upload created a source');
  assert.ok((await call('get_source', { id: uploaded.id })).text.includes('Hello AgentBerth PDF'), 'pdf.js extracted the real text');
  // sourceHash is content-only, so a byte-identical inbox drop would be deduped.
  // Use equal-length variants to prove each ingest path really parses PDFs.
  const inboxPdf = Buffer.from(samplePdf.toString('latin1').replace('Hello AgentBerth PDF', 'Hello AgentBerth INB'), 'latin1');
  const iframePdf = Buffer.from(samplePdf.toString('latin1').replace('Hello AgentBerth PDF', 'Hello AgentBerth IFR'), 'latin1');
  await writeFile(path.join(inbox.dir, 'window-paper.pdf'), inboxPdf);
  await until(async () => (await call('list_sources')).some(item => item.title === 'window-paper'), 'inbox pdf import');
  const inboxSource = (await call('list_sources')).find(item => item.title === 'window-paper');
  assert.ok((await call('get_source', { id: inboxSource.id })).text.includes('Hello AgentBerth INB'), 'inbox parsed its PDF through pdf.js');
  step('PDF import works through both the bridge and the inbox watcher');

  const answer = await waitTask(await call('ask', { question: '召回和精度怎么处理？' }));
  assert.ok(answer.answer.includes('[[向量检索]]'));
  assert.deepEqual(answer.citations.sort(), ['向量检索', '重排序'].sort());
  assert.ok(answer.evidence.length > 0, 'answers carry raw source excerpts');
  const archived = await waitTask(await call('save_answer', { question: '召回和精度怎么处理？', answer: answer.answer, citations: answer.citations }));
  assert.equal(archived.humanEdited, true);
  const lint = await waitTask(await call('lint'));
  assert.ok(lint.suggestions.length > 0);
  step('ask with citations, answer archiving and lint all work');

  step('open the sandboxed extension view');
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); window.webContents.focus(); });
  await page.bringToFront();
  await page.getByRole('button', { name: '笔记 Wiki · 知识库' }).click();
  const frame = page.frameLocator('iframe.extension-view');
  await frame.locator('body').evaluate(() => {
    window.__wikiSmokeEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
      window.__wikiSmokeEvents.push({ type, action: event.target.closest('[data-action]')?.dataset.action, tab: event.target.closest('[data-tab]')?.dataset.tab, x: event.clientX, y: event.clientY });
      window.__wikiSmokeEvents = window.__wikiSmokeEvents.slice(-12);
    }, true);
  });
  await until(async () => (await frame.locator('#statusText').innerText()).includes('页'), 'wiki view status');
  await until(async () => (await frame.locator('#pageList').innerText()).includes('向量检索'), 'page list');
  await until(async () => (await frame.locator('#pageView').locator('.card').count()) > 0, 'first page auto-selected');
  await frame.locator('#pageList [data-action="openPage"][data-slug="向量检索"]').focus();
  await page.keyboard.press('Enter');
  await frame.locator('#pageView').getByRole('heading',{name:'向量检索',level:2,exact:true}).waitFor();
  await frame.locator('.tabs [data-tab="skills"]').click();
  await until(async () => (await frame.locator('#skillList').innerText()).includes('window-skill'), 'skill list');
  await frame.locator('#skillList [data-action="openSkill"][data-name="window-skill"]').click();
  await frame.locator('#skillView [data-action="exportSkill"]').click();
  await until(async () => (await frame.locator('#skillExport textarea').inputValue()).includes('window-skill'), 'skill export appears in the editor');
  await frame.locator('.tabs [data-tab="review"]').click();
  await until(async () => (await frame.locator('#draftList').innerText()).includes('已发布'), 'draft list');
  await frame.locator('.tabs [data-tab="settings"]').click();
  await until(async () => (await frame.locator('#settingsView').innerText()).includes('mock-text'), 'settings view');
  // The in-page plugin settings popover replaces the jump to the plugin center.
  await frame.locator('#openPluginSettings').click();
  await until(async () => (await page.locator('.plugin-settings-popover').count()) > 0, 'plugin settings popover opens in place');
  assert.ok((await page.locator('.plugin-settings-popover').innerText()).includes('笔记 Wiki'), 'popover shows the plugin identity');
  assert.ok((await page.locator('.plugin-settings-popover').innerText()).includes('模型服务地址'), 'popover renders real config fields');
  await page.screenshot({ animations: 'disabled', path: 'test-results/wiki-plugin-popover.png' });
  await page.locator('.plugin-settings-popover [aria-label="关闭配置面板"]').click();
  await until(async () => (await page.locator('.plugin-settings-popover').count()) === 0, 'popover closed');
  await page.screenshot({ animations: 'disabled', path: 'test-results/wiki-window-settings.png' });
  await frame.locator('.tabs [data-tab="wiki"]').click();
  await until(async () => (await frame.locator('#pageView').innerText()).includes('向量检索'), 'page detail');
  await until(async () => (await frame.locator('#pageView').innerText()).includes('原始出处'), 'page provenance rendered');
  await page.screenshot({ animations: 'disabled', path: 'test-results/wiki-window-pages.png' });
  step('view tabs render live daemon data');
  step('capture selector exposes workspace and session identity');
  const captureProject = await rpc('createProject', { name: '知识库会话工作区', path: folder });
  const agentProgram = await application.evaluate(() => process.execPath);
  const captureAgent = await rpc('createAgent', { name: 'Wiki capture fixture', command: agentProgram, acp: { executable: agentProgram, args: [path.resolve('tests/fixtures/acp-agent.cjs'), folder], env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const captureSession = await rpc('createSession', { projectId: captureProject.id, title: 'UI 会话导入验证', agent: captureAgent.id });
  await rpc('start', { sessionId: captureSession.id, cols: 80, rows: 24 });
  await until(async () => (await rpc('acpSnapshot', { sessionId: captureSession.id, limit: 1 })).phase === 'ready', 'capture ACP connected');
  await rpc('acpSend', { sessionId: captureSession.id, requestId: randomUUID(), text: 'Wiki 全量会话导入验证' });
  await until(async () => (await rpc('acpSnapshot', { sessionId: captureSession.id, limit: 1 })).phase === 'ready', 'capture conversation finished');
  await frame.locator('.tabs [data-tab="sources"]').click();
  await frame.locator('[data-action="showCapture"]').click();
  await frame.locator('[data-action="refreshSessions"]').click();
  await until(async () => await frame.locator('[data-field="session"] option[value="' + captureSession.id + '"]').count() > 0, 'capture session listed');
  await frame.locator('#captureQuery').fill(captureSession.id);
  await frame.locator('[data-field="session"]').selectOption(captureSession.id);
  const selection = await frame.locator('#captureSelection').innerText();
  for (const value of ['知识库会话工作区', 'UI 会话导入验证', captureSession.id]) assert.ok(selection.includes(value), value);
  await frame.locator('[data-action="captureSession"]').click();
  await until(async () => (await call('list_sources')).some(source => source.title.includes('UI 会话导入验证')), 'background full conversation import completed');
  const capturedSource = (await call('list_sources')).find(source => source.title.includes('UI 会话导入验证'));
  assert.ok((await call('get_source', { id: capturedSource.id })).text.includes('Wiki 全量会话导入验证'));
  const inboxInfo = await call('inbox_status');
  assert.equal(inboxInfo.watching, true);
  await until(async () => await frame.locator('#inboxPath').count() > 0, 'collection status panel');
  assert.equal(await frame.locator('#inboxPath').inputValue(), inboxInfo.dir);
  await writeFile(path.join(inboxInfo.dir, 'window-collected.md'), 'Real watcher imported the entire window fixture.');
  await frame.locator('[data-action="scanInbox"]').click();
  await until(async () => (await call('list_sources')).some(item => item.title === 'window-collected'), 'real plugin inbox watcher saved source');
  const collected = (await call('list_sources')).find(item => item.title === 'window-collected');
  assert.equal((await call('get_source', { id: collected.id })).text, 'Real watcher imported the entire window fixture.');
  step('capture and actual inbox directory import work from the window');
  await frame.locator('.tabs [data-tab="wiki"]').click();
  await frame.locator('#pageList [data-action="openPage"][data-slug="向量检索"]').click();
  await until(async () => (await frame.locator('#pageView').innerText()).includes('原始出处'), 'return to selected page');


  // Activity bar: icons carry text labels, and re-clicking the selected icon
  // toggles the sidebar (the second click collapses, the third restores).
  const knowledge = page.getByRole('button', { name: '笔记 Wiki · 知识库' });
  assert.equal(await knowledge.locator('.activity-label').innerText(), '知识库', 'extension icons carry a text label');
  assert.ok((await page.locator('.activity-label').allInnerTexts()).includes('会话'), 'the sessions icon is labelled');
  assert.ok(await page.locator('#sidebar-content').isHidden(), 'wiki opens in its remembered focus layout');
  await knowledge.click();
  await until(async () => page.locator('#sidebar-content').isVisible(), 're-click restores the sidebar');
  await knowledge.click();
  await until(async () => page.locator('#sidebar-content').isHidden(), 'another click collapses the sidebar');
  // Wait for the embedding frame, not just the iframe-local button: Chromium
  // can still use the previous surface bounds just after the sidebar resizes.
  let previousBounds = '', stableBounds = 0;
  await until(async () => {
    const bounds = JSON.stringify(await page.locator('iframe.extension-view').boundingBox());
    stableBounds = bounds === previousBounds ? stableBounds + 1 : 0;
    previousBounds = bounds;
    return stableBounds >= 3;
  }, 'iframe bounds settle after sidebar resize');
  await page.screenshot({ animations: 'disabled', path: 'test-results/wiki-focus-layout.png' });
  step('labelled activity icons toggle the sidebar on re-click');

  // Markdown editor: preview renders in place and never loses the draft.
  await frame.locator('#pageView [data-action="editPage"]').click();
  await until(async () => (await frame.locator('#pageView [data-field="body"]').count()) > 0, 'edit form opens');
  const fence = '```';
  const md = [
    '# 编辑预览标题', '',
    '正文段落 **加粗**、`行内代码` 与 [[重排序]] 及 [[A&B]]', '',
    '- 第一项', '- 第二项', '',
    '1. 有序一', '2. 有序二', '',
    fence, '第一行代码', '第二行代码', fence, '',
    '| 列 A | 列 B |', '| --- | --- |', '| 1 | 2 |',
  ].join('\n');
  await frame.locator('#pageView [data-field="body"]').fill(md);
  await frame.locator('#pageView [data-action="mdPreview"]').click();
  const preview = frame.locator('#pageView .md-preview');
  await until(async () => (await preview.locator('h1').count()) > 0, 'markdown preview rendered');
  assert.ok(await frame.locator('#pageView [data-field="body"]').isHidden(), 'preview hides the editor');
  assert.equal(await preview.locator('ul li').count(), 2, 'unordered list renders');
  assert.equal(await preview.locator('ol li').count(), 2, 'ordered list renders');
  assert.equal(await preview.locator('table td').count(), 2, 'table renders');
  assert.ok((await preview.locator('pre').textContent()).includes('第一行代码\n第二行代码'), 'fenced code keeps its line breaks');
  assert.ok((await preview.locator('code').first().innerText()).includes('行内代码'), 'inline code renders');
  assert.ok((await preview.locator('.wikilink').allInnerTexts()).includes('A&B'), 'wikilink labels are not double-escaped');
  assert.equal(await preview.locator('.wikilink').filter({ hasText: 'A&B' }).getAttribute('data-slug'), 'a-b', 'wikilinks resolve the original target');
  await frame.locator('#pageView [data-action="mdPreview"]').click();
  assert.equal(await frame.locator('#pageView [data-field="body"]').inputValue(), md, 'preview round-trip keeps the draft');
  step('markdown editor renders lists, tables, code and links without losing the draft');

  // Keep the page editor mounted while another tab opens: field lookups must
  // resolve in the active panel, never in a stale background form.
  await frame.locator('.tabs [data-tab="skills"]').click();
  await frame.locator('#newSkill').click();
  await until(async () => (await frame.locator('#skillView [data-field="body"]').count()) > 0, 'skill editor');
  const scoped = await frame.locator('#skillView [data-field="body"]').evaluate(node => ({
    same: document.querySelector('.panel.active [data-field="body"]') === node,
    total: document.querySelectorAll('[data-field="body"]').length,
  }));
  assert.equal(scoped.total, 2, 'both panels keep their own editor mounted');
  assert.ok(scoped.same, 'field lookup resolves inside the active panel');
  await frame.locator('#skillView [data-action="cancelSkill"]').click();
  await frame.locator('.tabs [data-tab="wiki"]').click();
  assert.equal(await frame.locator('#pageView [data-field="body"]').inputValue(), md, 'switching tabs restores the unsaved page draft');
  await frame.locator('#pageView [data-action="cancelEdit"]').click();
  await frame.locator('[data-action="dialogAccept"]').click();
  step('form fields are scoped to the visible panel');

  await until(async () => (await call('editor_drafts')).some(draft => draft.key === 'page:向量检索'), 'draft persisted outside the iframe');
  await page.getByRole('button', { name: '关闭插件视图' }).click();
  await knowledge.click();
  const savedDraft = frame.locator('[data-action="restoreEditorDraft"][data-key="page:向量检索"]');
  await until(async () => await savedDraft.count() > 0, 'draft recovery survives closing the view');
  await frame.locator('#draftShelf > details > summary').focus();
  await page.keyboard.press('Enter');
  await until(async () => await frame.locator('#draftShelf > details').evaluate(node => node.open), 'draft recovery shelf expanded');
  await savedDraft.click();
  await until(async () => (await frame.locator('#pageView [data-field="body"]').inputValue()) === md, 'recovered body is complete');
  await frame.locator('#pageView [data-action="cancelEdit"]').click();
  await frame.locator('[data-action="dialogAccept"]').click();
  await frame.locator('[data-action="discardEditorDraft"][data-key="page:向量检索"]').click();
  await frame.locator('[data-action="dialogAccept"]').click();
  await until(async () => !(await call('editor_drafts')).some(draft => draft.key === 'page:向量检索'), 'explicit discard clears persistent draft');
  step('edit drafts survive real iframe teardown and explicit discard');


  // The static buttons are delegated through [data-action]; exercise them for
  // real so a missing attribute can never ship as a dead primary action again.
  await frame.locator('.tabs [data-tab="sources"]').click();
  await frame.locator('#newSource').click();
  await until(async () => (await frame.locator('#sourceView [data-field="text"]').count()) > 0, 'new source form');
  await frame.locator('#sourceView [data-action="cancelSource"]').click();
  await frame.locator('[data-action="showCapture"]').click();
  await until(async () => (await frame.locator('#sourceView').innerText()).includes('raw/inbox'), 'capture panel');
  await frame.locator('.tabs [data-tab="wiki"]').click();
  await frame.locator('#newPage').click();
  await until(async () => (await frame.locator('#pageView [data-field="slug"]').count()) > 0, 'new page form');
  await frame.locator('#pageView [data-action="cancelPage"]').click();
  await frame.locator('.tabs [data-tab="skills"]').click();
  await frame.locator('#newSkill').click();
  await until(async () => (await frame.locator('#skillView [data-field="name"]').count()) > 0, 'new skill form');
  await frame.locator('#skillView [data-action="cancelSkill"]').click();
  await frame.locator('.tabs [data-tab="sources"]').click();
  await frame.locator('#newSource').click();
  await frame.locator('#sourceView [data-field="title"]').fill('纯图片窗口素材');
  await frame.locator('#sourceView [data-field="images"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=', 'base64') });
  await frame.locator('#sourceView [data-field="compileImported"]').check();
  await frame.locator('#sourceView [data-action="saveSource"]').click();
  await until(async () => (await call('list_sources')).some(source => source.title === '纯图片窗口素材' && source.images === 1 && source.compiled), 'image-only source saved and compiled');
  await until(async () => await frame.locator('.tabs [data-tab="review"]').evaluate(node => node.classList.contains('active')), 'image compile task completed in the view');
  step('image-only source uploads before compilation');
  await frame.locator('.tabs [data-tab="sources"]').click();
  await frame.locator('#newSource').click();
  await frame.locator('#sourceView [data-field="pdf"]').setInputFiles({ name: 'window-upload.pdf', mimeType: 'application/pdf', buffer: iframePdf });
  await frame.locator('#sourceView [data-field="compileImported"]').check();
  await frame.locator('[data-action="startImport"]').click();
  await until(async () => (await call('list_sources')).some(item => item.title === 'window-upload' && item.compiled), 'iframe PDF upload imported and compiled');
  await frame.locator('.tabs [data-tab="tasks"]').click();
  await until(async () => (await frame.locator('[data-action="taskDraft"]').count()) > 0, 'completed import exposes a proposal action');
  await frame.locator('[data-action="taskDraft"]').first().click();
  await until(async () => await frame.locator('.tabs [data-tab="review"]').evaluate(node => node.classList.contains('active')), 'iframe PDF compile task completed in the view');
  assert.ok((await call('get_source', { id: (await call('list_sources')).find(item => item.title === 'window-upload').id })).text.includes('Hello AgentBerth IFR'), 'iframe upload extracted its own text');
  step('the iframe PDF input uploads, extracts and compiles');
  step('mixed Markdown, text, image and supplemental prose remain one review unit');
  const mixedSourceCount=(await call('list_sources')).length,mixedDraftCount=(await call('list_drafts')).length;
  await frame.locator('.tabs [data-tab="sources"]').click();
  await frame.locator('#newSource').click();
  await frame.locator('#sourceView [data-field="title"]').fill('混合资料窗口验证');
  await frame.locator('#sourceView [data-field="text"]').fill('补充说明：图中的箭头表示依赖方向。');
  await frame.locator('#sourceView [data-field="pdf"]').setInputFiles([
    {name:'article.md',mimeType:'text/markdown',buffer:Buffer.from('# 混合文档\n\n![结构](diagram.png)\n\n原文结尾证据。')},
    {name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('同组补充记录，不能单独变成另一个提案。')},
    {name:'diagram.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=','base64')},
  ]);
  assert.equal(await frame.locator('[data-field="separateImported"]').isChecked(),false);
  await frame.locator('[data-field="compileImported"]').check();
  await frame.locator('[data-action="saveSource"]').click();
  await until(async()=> (await call('list_sources')).some(source=>source.title==='混合资料窗口验证'&&source.compiled),'mixed source compiled');
  assert.equal((await call('list_sources')).length,mixedSourceCount+1,'one mixed source');
  assert.equal((await call('list_drafts')).length,mixedDraftCount+1,'one review proposal for the whole bundle');
  const mixedSource=(await call('list_sources')).find(source=>source.title==='混合资料窗口验证');
  const mixed=await call('get_source',{id:mixedSource.id});
  assert.equal(mixed.partCount,3);assert.equal(mixed.imageCount,1);
  for(const value of ['补充说明','![结构](diagram.png)','原文结尾证据','同组补充记录'])assert.ok(mixed.text.includes(value),value);
  assert.ok(requests.some(request=>request.includes('图片理解助手')&&request.includes('diagram.png')));
  await until(async()=> await frame.locator('.tabs [data-tab="review"]').evaluate(node=>node.classList.contains('active')),'mixed proposal opened');
  await frame.locator('.tabs [data-tab="sources"]').click();
  await until(async()=>await frame.locator('#sourceList [data-id="'+mixedSource.id+'"]').count()>0,'mixed source listed');
  await frame.locator('#sourceList [data-id="'+mixedSource.id+'"]').click();
  await until(async()=> (await frame.locator('#mixedParts').innerText()).includes('diagram.png'),'mixed components visible');
  await page.screenshot({animations:'disabled',path:'test-results/wiki-window-mixed.png'});
  await frame.locator('.tabs [data-tab="ask"]').click();
  await frame.locator('#question').fill('向量检索：窗口里直接提问可以吗？');
  await frame.locator('#ask').click();
  await until(async () => (await frame.locator('#answerView').innerText()).includes('向量检索'), 'ask button produced an answer');
  await until(async () => (await frame.locator('#answerView').innerText()).includes('原始出处'), 'answer provenance rendered');
  await waitTask(await call('ask', { question: '另一个 Agent 同时发来的问题' }));
  await until(async () => (await frame.locator('#answerList').innerText()).includes('另一个 Agent'), 'background answers refresh the list');
  assert.ok((await frame.locator('#answerView').innerText()).includes('窗口里直接提问可以吗？'), 'the selected answer is stable when history grows');
  const archivedBefore = (await call('list_pages')).length;
  await frame.locator('#answerView [data-action="saveAnswer"]').click();
  await until(async () => (await call('list_pages')).length > archivedBefore, 'iframe archives an answer with evidence');
  await until(async () => await frame.locator('.tabs [data-tab="wiki"]').evaluate(node => node.classList.contains('active')), 'archive task completed in the view');
  assert.ok((await call('list_pages')).some(page => page.title.includes('窗口里直接提问')), 'archive targets the visible answer, not its former array index');
  await frame.locator('.tabs [data-tab="review"]').click();
  const lintBefore = (await call('status')).tasks.filter(task => task.kind === 'lint').length;
  await frame.locator('#runLint').click();
  await until(async () => (await call('status')).tasks.filter(task => task.kind === 'lint').length > lintBefore, 'lint button enqueued a task');
  step('all primary iframe buttons are wired');


  await until(async () => (await call('status')).tasks.every(task => !['queued', 'running'].includes(task.status)), 'background tasks drained before backup');
  await frame.locator('.tabs [data-tab="review"]').click();
  await until(async () => await frame.locator('#draftList [data-id="' + draftId + '"]').count() > 0, 'approved review record listed');
  await frame.locator('#draftList [data-id="' + draftId + '"]').click();
  await until(async () => await frame.locator('[data-action="deleteDraft"]').count() > 0, 'review deletion available');
  await frame.locator('[data-action="deleteDraft"]').click();
  assert.ok(await call('get_draft', { id: draftId }), 'review still present before confirmation');
  await frame.locator('[data-action="dialogAccept"]').click();
  await until(async () => !(await call('get_draft', { id: draftId })), 'review record deleted');
  assert.ok(await call('get_page', { slug: '向量检索' })); assert.ok(await call('get_source', { id: source.id }));
  step('review deletion preserves published pages and original source');
  await call('save_page', { slug: 'window-trash', title: '窗口回收站验证', body: '恢复后仍然完整的正文' });
  await frame.locator('.tabs [data-tab="wiki"]').click();
  await until(async () => await frame.locator('#pageList [data-slug="window-trash"]').count() > 0, 'new page appears');
  await frame.locator('#pageList [data-slug="window-trash"]').click();
  await until(async () => (await frame.locator('#pageView').innerText()).includes('窗口回收站验证'), 'trash fixture opened');
  await frame.locator('[data-action="deletePage"]').click();
  assert.ok(await call('get_page', { slug: 'window-trash' }), 'confirmation has not deleted anything');
  await frame.locator('[data-action="dialogAccept"]').click();
  await until(async () => !(await call('get_page', { slug: 'window-trash' })), 'page moved to trash');
  await frame.locator('.tabs [data-tab="trash"]').click();
  await until(async () => (await frame.locator('#trashView').innerText()).includes('窗口回收站验证'), 'trash entry visible');
  await frame.locator('#trashView .card', { hasText: '窗口回收站验证' }).locator('[data-action="restoreTrash"]').click();
  await until(async () => (await call('get_page', { slug: 'window-trash' }))?.page.body.includes('恢复后仍然完整'), 'trash restores the actual content');
  step('confirmed deletion and recovery work in the real window');
  for (const slug of ['purge-one', 'purge-two']) { await call('save_page', { slug, body: 'discarded page' }); await call('delete_page', { slug }); }
  await frame.locator('.tabs [data-tab="trash"]').click();
  await until(async () => await frame.locator('[data-action="purgeTrash"]').count() === 2, 'permanent deletion actions');
  await frame.locator('[data-action="purgeTrash"]').first().click();
  assert.equal((await call('trash')).length, 2);
  await frame.locator('[data-action="dialogAccept"]').click();
  await until(async () => await frame.locator('[data-action="purgeTrash"]').count() === 1, 'one record purged');
  await frame.locator('[data-action="clearTrash"]').click();
  await frame.locator('[data-action="dialogAccept"]').click();
  await until(async () => (await call('trash')).length === 0, 'trash emptied');
  assert.ok(await call('get_page', { slug: 'window-trash' }), 'restored page survives purge');
  step('permanent deletion and empty trash work in the real window');
  await frame.locator('.tabs [data-tab="settings"]').click();
  await until(async () => await frame.locator('#backupControls').count() > 0, 'backup controls');
  const backupPath = path.join(folder, 'wiki-backup.zip');
  // Electron keeps its native download behavior; unlike a managed browser,
  // Playwright does not guarantee a Page.download event for that session.
  await application.evaluate(({ session }, file) => {
    globalThis.__wikiSmokeDownload = { state: 'waiting' };
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(file);
      globalThis.__wikiSmokeDownload = { state: 'downloading', name: item.getFilename() };
      item.once('done', (_event, state) => { globalThis.__wikiSmokeDownload = { state, bytes: item.getReceivedBytes() }; });
    });
  }, backupPath);
  await frame.locator('[data-action="exportBackup"]').click();
  await until(async () => {
    const download = await application.evaluate(() => globalThis.__wikiSmokeDownload);
    if (['cancelled', 'interrupted'].includes(download.state)) throw new Error('Native backup download failed: ' + JSON.stringify(download));
    return download.state === 'completed';
  }, 'native backup download completes');
  const backupBytes = await readFile(backupPath), archive = unzipSync(backupBytes);
  assert.ok(archive['wiki/window-trash.md'], 'download contains restored page');
  assert.equal(archive['credentials.json'], undefined, 'portable backup excludes credentials');
  assert.ok(Object.keys(archive).some(name => name.startsWith('raw/assets/') && name.endsWith('.pdf')), 'original PDFs are backed up');
  await frame.locator('#backupFile').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: backupBytes });
  await frame.locator('[data-action="previewBackup"]').click();
  await until(async () => (await frame.locator('#backupPreview').innerText()).includes('冲突'), 'backup preview reports conflicts');
  await frame.locator('[data-action="applyBackupMerge"]').click();
  await until(async () => (await frame.locator('#uxNotice').innerText()).includes('备份导入完成'), 'safe backup merge completed');
  assert.equal((await call('get_page', { slug: 'window-trash' })).page.body.includes('恢复后仍然完整'), true);
  step('sandboxed backup download, conflict preview and safe import work');

  const snapshotsBeforeRestore = await call('rollback_backups');
  const snapshotName = snapshotsBeforeRestore[0];
  assert.ok(snapshotName, 'import retained an automatic snapshot');
  await call('save_page', { slug: 'snapshot-addition', title: '快照后新增', body: '完整恢复时应移除，撤销恢复时应回来' });
  await frame.locator('.tabs [data-tab="wiki"]').click();
  await frame.locator('#newPage').click();
  await frame.locator('#pageView [data-field="body"]').fill('恢复之前最后输入的未保存草稿');
  await frame.locator('.tabs [data-tab="settings"]').click();
  await until(async () => await frame.locator('[data-action="restoreBackup"][data-name="' + snapshotName + '"]').count() > 0, 'snapshot controls reloaded');
  await frame.locator('#backupControls details > summary').click();
  await frame.locator('[data-action="restoreBackup"][data-name="' + snapshotName + '"]').click();
  await until(async () => (await frame.locator('[role="dialog"]').innerText()).includes('将移除快照后新增的'), 'snapshot removal impact is visible');
  await frame.locator('[data-action="dialogAccept"]').click();
  await until(async () => (await frame.locator('#uxNotice').innerText()).includes('完整快照已恢复'), 'full snapshot restored');
  assert.equal(await call('get_page', { slug: 'snapshot-addition' }), null, 'rollback removes additions');
  assert.equal((await call('editor_drafts')).some(draft => draft.key === 'page:new'), false, 'removed drafts do not return from hidden editors');
  assert.ok(await call('get_page', { slug: 'window-trash' }), 'original notes remain');
  const undoName = (await call('rollback_backups')).find(name => !snapshotsBeforeRestore.includes(name));
  assert.ok(undoName, 'restoring a snapshot retains an undo snapshot');
  await until(async () => await frame.locator('[data-action="restoreBackup"][data-name="' + undoName + '"]').count() > 0, 'undo snapshot is visible');
  await frame.locator('#backupControls details > summary').click();
  await frame.locator('[data-action="restoreBackup"][data-name="' + undoName + '"]').click();
  await frame.locator('[data-action="dialogAccept"]').click();
  await until(async () => !!await call('get_page', { slug: 'snapshot-addition' }), 'snapshot restoration can be undone');
  assert.equal((await call('get_editor_draft', { key: 'page:new' })).fields.body, '恢复之前最后输入的未保存草稿', 'undo retains the final editor input');
  step('full snapshot rollback removes additions and supports undo');

  assert.equal((await frame.locator('#error').innerText()).trim(), '', 'no command errors in the view');
  assert.deepEqual(errors, [], 'no renderer page errors');
  console.log('RESULT OK', JSON.stringify({ pages: (await call('list_pages')).length, requests: requests.length, errors }));
} catch (error) {
  failure = error;
  console.error('RESULT FAIL', error);
  if (application) {
    try {
      const page = await application.firstWindow();
      const frame = page.frameLocator('iframe.extension-view');
      console.error('Wiki view failure context', JSON.stringify({ errors, events: await frame.locator('body').evaluate(() => window.__wikiSmokeEvents), download: await application.evaluate(() => globalThis.__wikiSmokeDownload), notice: await frame.locator('#uxNotice').innerText(), error: await frame.locator('#error').innerText(), panel: await frame.locator('.panel.active').innerText() }));
      await page.screenshot({ path: 'test-results/wiki-window-failure.png' });
    } catch { /* ignore */ }
  }
  process.exitCode = 1;
} finally {
  model.close();
  try { await cleanupSmoke(application, daemonPid, folder); } catch (error) { if (!failure) throw error; }
}
