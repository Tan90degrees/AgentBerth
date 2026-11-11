import type { Context } from 'cordis';
import path from 'node:path';
import { byteTruncate, extractLinks, lineDiff, pageHash, parseDocument, truncate } from './core';
import { startInbox, type InboxHandle } from './inbox';
import type { ServiceOptions } from './service';
import { WikiService } from './service';
import { WikiStore } from './store';
import { registerWorkspaceCommands } from './commands-ux';
import { materialWindow } from './material';
import type { WikiConfig } from './types';

type Params = Record<string, unknown>;
type Properties = Record<string, unknown>;
type Handler = (params: Params) => unknown | Promise<unknown>;

const text = (params: Params, key: string, fallback = ''): string => typeof params[key] === 'string' ? params[key] as string : fallback;
const bool = (params: Params, key: string): boolean => params[key] === true;
const number = (params: Params, key: string, fallback = 0): number => typeof params[key] === 'number' ? params[key] as number : fallback;
const strings = (params: Params, key: string): string[] => Array.isArray(params[key]) ? (params[key] as unknown[]).filter((value): value is string => typeof value === 'string') : [];
const paging = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } };
const pageSlice = <T>(items: T[], params: Params) => items.slice(number(params, 'offset'), number(params, 'offset') + Math.max(1, Math.min(50, number(params, 'limit', 50))));
const field = (type: string, extra: Record<string, unknown> = {}): Properties[string] => ({ type, ...extra });
const schema = (properties: Properties, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, additionalProperties: false, required });

// The MCP bridge injects an optional `agentId` into every exposed tool's
// arguments, and the workbench forbids declaring that key ourselves. MCP-only
// commands therefore tolerate unknown keys; the handlers read named fields
// only. All human-facing and write commands keep strict schemas.
const mcpSchema = (properties: Properties, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, additionalProperties: true, required });

/** Read-only tools exposed to workbench Agents over MCP. Writes stay behind
 * human review: a model can query the wiki but cannot publish to it. */
export const MCP_READ_ONLY_COMMANDS = [
  'wiki_index', 'wiki_search', 'wiki_read', 'wiki_sources', 'wiki_source', 'wiki_status', 'wiki_ask', 'wiki_task',
] as const;

// The extension bridge rejects results above 128 KiB. Keep every command well
// below that, with a clear error instead of an opaque timeout when it is not
// possible. Chinese Markdown costs ~3 bytes per character, so caps are bytes.
const MAX_RESULT_BYTES = 120 * 1024;
const resultBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null));
function trimDeep(node: unknown, maxBytes: number): unknown {
  if (typeof node === 'string') return byteTruncate(node, maxBytes);
  if (Array.isArray(node)) return node.map(item => trimDeep(item, maxBytes));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = trimDeep(value, maxBytes);
    return out;
  }
  return node;
}
function fit(value: unknown): unknown {
  if (resultBytes(value) <= MAX_RESULT_BYTES) return value;
  const trimmed = trimDeep(value, 16 * 1024);
  if (resultBytes(trimmed) <= MAX_RESULT_BYTES) return trimmed;
  throw new Error('结果过大，请缩小查询范围或精简页面内容');
}

function readConfig(config: Record<string, string | number | boolean>): WikiConfig {
  return {
    baseURL: String(config.baseURL ?? 'https://api.openai.com/v1'),
    textModel: String(config.textModel ?? 'gpt-4o-mini'),
    visionModel: String(config.visionModel ?? ''),
    autoCompile: config.autoCompile !== false,
    autoApprove: false,
    allowAgentAccess: config.allowAgentAccess === true,
    allowAgentQueries: config.allowAgentQueries === true,
    lintMinutes: Number(config.lintMinutes ?? 0),
    maxContextPages: Number(config.maxContextPages ?? 8),
    authRequired: config.authRequired !== false,
  };
}

/** Register the wiki's command surface. The iframe never sees the Node store:
 * every call is a small, bounded JSON request through the existing bridge. */
export function apply(ctx: Context, config: Record<string, string | number | boolean>): void {
  const api = ctx.berth;
  const store = new WikiStore(api.dataDirectory);
  const options: ServiceOptions = {
    store, config: readConfig(config), signal: api.signal,
    call: (method, params) => api.call(method, params),
  };
  const service = new WikiService(options);
  const commands: { name: string; description: string; input: Record<string, unknown>; handler: Handler; mcp: boolean }[] = [];
  const add = (name: string, description: string, input: Record<string, unknown>, handler: Handler, mcp = false) =>
    commands.push({ name, description, input, handler, mcp });
  let inbox: InboxHandle | null = null;

  // Navigation & status
  // status is polled every 2 seconds: never ship the (potentially large)
  // results of 20 background tasks along with it.
  add('status', '读取知识库概览与后台任务', schema({}), () => {
    const status = service.status();
    return { ...status, tasks: status.tasks.map(({ id, kind, label, status: state, progress, startedAt, finishedAt, error }) =>
      ({ id, kind, label, status: state, progress, startedAt, finishedAt, error })) };
  });
  add('task', '查询后台任务结果', schema({ id: field('string') }, ['id']), params => service.taskStatus(text(params, 'id')));
  add('index', '读取 index.md', schema({}), () => byteTruncate(service.indexText(), 96 * 1024));
  add('log', '读取 log.md（最近记录）', schema({}), () => byteTruncate(service.logText(), 96 * 1024));
  add('rebuild_index', '重建导航索引', schema({}), () => service.rebuildIndex());
  add('schema', '读取 Schema 约定', schema({}), () => byteTruncate(service.schemaText(), 96 * 1024));
  add('save_schema', '更新 Schema 约定', schema({ value: field('string', { maxLength: 20000 }) }, ['value']), params => service.saveSchema(text(params, 'value')).then(() => true));

  // Pages
  add('list_pages', '全文搜索和分页浏览 wiki 页面', schema({ ...paging, query: field('string'), kind: field('string'), tag: field('string') }), params => {
    const query = text(params, 'query').trim().toLocaleLowerCase();
    const pages = service.listPages().filter(page => (!query || [page.title, page.summary, page.body, ...page.tags].join(' ').toLocaleLowerCase().includes(query)) && (!text(params, 'kind') || page.kind === params.kind) && (!text(params, 'tag') || page.tags.some(tag => tag.toLocaleLowerCase() === text(params, 'tag').trim().toLocaleLowerCase())));
    const inbound = new Map<string, number>();
    for (const page of pages) for (const target of extractLinks(page.body)) inbound.set(target, (inbound.get(target) ?? 0) + 1);
    return pageSlice(pages, params).map(page => ({ slug: page.slug, title: byteTruncate(page.title, 300), summary: byteTruncate(page.summary, 600), kind: page.kind, humanEdited: page.humanEdited, updatedAt: page.updatedAt, links: extractLinks(page.body).length, backlinks: inbound.get(page.slug) ?? 0 }));
  });
  add('get_page', '读取单页全文、反向链接与原始出处', schema({ slug: field('string') }, ['slug']), params => {
    const page = service.getPage(text(params, 'slug'));
    if (!page) return null;
    const inbound = service.listPages().filter(other => extractLinks(other.body).includes(page.slug)).map(other => other.slug);
    // The view renders page.body; shipping the raw document as `text` too would
    // double the payload and can push a long Chinese page past the bridge cap.
    return {
      page: { ...page, body: byteTruncate(page.body, 60 * 1024) },
      editToken: pageHash(page), truncated: Buffer.byteLength(page.body) > 60 * 1024,
      backlinks: inbound.slice(0, 200), history: service.history(page.slug),
      excerpts: service.excerpts(page.slug),
    };
  });
  add('save_page', '人工编辑页面（自动编译将跳过）', schema({
    slug: field('string'), title: field('string'), summary: field('string'), body: field('string'), expected: field('string'), createOnly: field('boolean'),
    kind: field('string', { enum: ['concept', 'entity', 'source', 'comparison', 'overview', 'note'] }),
    tags: field('array', { items: { type: 'string' } }),
  }, ['slug', 'body']), params => service.savePage({
    slug: text(params, 'slug'), expected: typeof params.expected === 'string' ? params.expected : undefined, createOnly: bool(params, 'createOnly'),
    ...(typeof params.title === 'string' ? { title: params.title as string } : {}),
    ...(typeof params.summary === 'string' ? { summary: params.summary as string } : {}),
    body: text(params, 'body'),
    ...(typeof params.kind === 'string' ? { kind: params.kind as never } : {}),
    ...(Array.isArray(params.tags) ? { tags: strings(params, 'tags') } : {}),
  }));
  add('delete_page', '删除页面（保留历史版本）', schema({ slug: field('string') }, ['slug']), params => service.deletePage(text(params, 'slug')).then(() => true));
  add('revert_page', '恢复页面的历史版本', schema({ slug: field('string'), name: field('string') }, ['slug', 'name']), params => service.revertPage(text(params, 'slug'), text(params, 'name')));

  // Raw sources and multimodal attachments (one image per call: the view
  // bridge caps a command's params at 64 KiB).
  add('list_sources', '列出原始素材', schema(paging), params => pageSlice(service.listSources(), params).map(source => ({
    id: source.id, title: byteTruncate(source.title, 300), createdAt: source.createdAt, compiled: source.compiled,
    images: source.images.length, hasVision: !!source.vision, length: source.text.length,
  })));
  add('get_source', '读取素材全文', schema({ id: field('string') }, ['id']), params => {
    const source = service.getSource(text(params, 'id'));
    return source ? {
      ...source,
      text: byteTruncate(source.text, 60 * 1024),
      totalCharacters: source.text.length,
      document: source.document ? { ...source.document, ranges: source.document.ranges.slice(0, 30) } : undefined,
      vision: byteTruncate(source.vision, 20 * 1024),
      images: source.images.slice(0, 6), imageCount: source.images.length,
    } : null;
  });
  add('add_source', '新增原始素材（不可变）', schema({ title: field('string'), text: field('string'), staging: field('boolean') }, ['text']), params => service.addSource({ title: text(params, 'title'), text: text(params, 'text'), staging: bool(params, 'staging') }));
  add('add_image', '为素材追加一张压缩后的图片', schema({ sourceId: field('string'), mime: field('string'), base64: field('string') }, ['sourceId', 'mime', 'base64']), params => service.addImage(text(params, 'sourceId'), text(params, 'mime'), text(params, 'base64')));
  add('finalize_source', '完成素材图片上传', schema({ id: field('string') }, ['id']), params => service.finalizeSource(text(params, 'id')));
  add('delete_source', '删除原始素材', schema({ id: field('string') }, ['id']), params => service.deleteSource(text(params, 'id')).then(() => true));

  // PDF import: the bridge caps a command's params at 64 KiB, so the file is
  // uploaded as base64 chunks and parsed (text extraction) on the last one.
  add('pdf_upload_start', '开始一次 PDF 分片上传', schema({ title: field('string') }), params => service.beginPdfUpload(text(params, 'title')));
  add('pdf_upload_chunk', '追加 PDF 分片（base64 ≤ 48 KiB），done=true 时完成解析导入', schema({ uploadId: field('string'), base64: field('string'), done: field('boolean') }, ['uploadId', 'base64']), params => service.appendPdfChunk(text(params, 'uploadId'), text(params, 'base64'), bool(params, 'done')));
  add('pdf_upload_finish', '后台解析完整 PDF', schema({ uploadId: field('string') }, ['uploadId']), params => service.finishPdfUpload(text(params, 'uploadId')));
  add('pdf_upload_cancel', '取消 PDF 上传', schema({ uploadId: field('string') }, ['uploadId']), params => ({ cancelled: service.cancelPdfUpload(text(params, 'uploadId')) }));

  // Automatic capture: watch raw/inbox and import finished workbench sessions.
  add('inbox_status', '查看自动采集目录与待处理文件', schema({}), () => ({
    dir: inbox?.dir ?? path.join(api.dataDirectory, 'raw', 'inbox'),
    importedDir: inbox?.importedDir ?? path.join(api.dataDirectory, 'raw', 'inbox', 'imported'),
    failedDir: inbox?.failedDir ?? path.join(api.dataDirectory, 'raw', 'inbox', 'failed'),
    pending: inbox?.pending ?? [], archived: inbox?.archived ?? 0, watching: !!inbox,
  }));
  add('list_capture_sessions', '列出可沉淀为素材的工作台会话（ACP 对话与已导入历史的自定义 Agent 会话）', schema(paging), async params => pageSlice(await service.listCaptureSessions(), params));
  add('capture_session_start', '后台全量导入会话', schema({ sessionId: field('string') }, ['sessionId']), params => service.beginCaptureSession(text(params, 'sessionId')));
  add('capture_session', '把一次 Agent 会话沉淀成不可变素材', schema({ sessionId: field('string') }, ['sessionId']), params => service.captureSession(text(params, 'sessionId')));

  // Skills (CRUD over Markdown workflow templates)
  add('list_skills', '列出全部 Skill', schema({}), () => service.allSkills().slice(0, 200).map(skill => ({
    name: skill.name, description: byteTruncate(skill.description, 600), kind: skill.kind, triggers: skill.triggers.slice(0, 30), builtin: skill.builtin, updatedAt: skill.updatedAt,
  })));
  add('get_skill', '读取 Skill 指令', schema({ name: field('string') }, ['name']), params => service.getSkill(text(params, 'name')));
  add('save_skill', '新建或覆盖 Skill', schema({
    name: field('string'), description: field('string'), body: field('string'),
    kind: field('string', { enum: ['ingest', 'compile', 'query', 'lint', 'synthesize', 'custom'] }),
    triggers: field('array', { items: { type: 'string' } }),
  }, ['name', 'description', 'body']), params => service.saveSkill({
    name: text(params, 'name'), description: text(params, 'description'), body: text(params, 'body'),
    ...(typeof params.kind === 'string' ? { kind: params.kind as never } : {}),
    triggers: strings(params, 'triggers'),
  }));
  add('delete_skill', '删除自定义 Skill', schema({ name: field('string') }, ['name']), params => service.deleteSkill(text(params, 'name')).then(() => true));
  add('import_skill', '从 SKILL.md 文本导入', schema({ text: field('string') }, ['text']), params => service.importSkill(text(params, 'text')));
  add('export_skill', '导出 SKILL.md（可交给外部 Agent）', schema({ name: field('string') }, ['name']), params => service.exportSkill(text(params, 'name')));

  // Compile → draft → review
  add('compile', '把素材编译成待审阅提案', schema({ sourceId: field('string') }), params => service.compile(text(params, 'sourceId') || undefined));
  add('list_drafts', '列出编译提案', schema({ ...paging, status: field('string', { enum: ['pending', 'approved', 'rejected'] }) }), params => pageSlice(service.listDrafts(typeof params.status === 'string' ? params.status as 'pending' | 'approved' | 'rejected' : undefined), { ...params, limit: Math.min(10, number(params, 'limit', 10)) }).map(draft => ({ id: draft.id, sourceId: draft.sourceId, sourceTitle: byteTruncate(draft.sourceTitle, 300), createdAt: draft.createdAt, status: draft.status, model: byteTruncate(draft.model, 80), summary: byteTruncate(draft.summary, 600), pages: draft.pages.slice(0, 20).map(page => ({ action: page.action })), contradictions: [], feedback: [] })));
  add('get_draft', '读取单个提案（页摘要）', schema({ id: field('string') }, ['id']), params => {
    const draft = service.getDraft(text(params, 'id'));
    return draft ? { ...draft, pages: draft.pages.map(page => ({ slug: page.slug, title: page.title, action: page.action, summary: page.summary, selected: page.selected !== false, merge: !!page.allowHumanMerge })) } : null;
  });
  add('draft_page', '读取提案中某一页的完整 diff', schema({ id: field('string'), slug: field('string'), offset: field('integer', { minimum: 0 }) }, ['id', 'slug']), params => {
    const draft = service.getDraft(text(params, 'id'));
    const page = draft?.pages.find(item => item.slug === text(params, 'slug'));
    if (!page) return null;
    const lines = lineDiff(page.previous ? parseDocument(page.previous).body : '', page.body);
    const offset = number(params, 'offset');
    const diff: typeof lines = [];
    let bytes = 0;
    for (const line of lines.slice(offset)) {
      const size = resultBytes(line);
      if (diff.length && (bytes + size > 72 * 1024 || diff.length >= 200)) break;
      diff.push(line); bytes += size;
    }
    return { slug: page.slug, title: page.title, action: page.action, diff, nextOffset: offset + diff.length,
      hasMore: offset + diff.length < lines.length, totalLines: lines.length };
  });
  add('review_draft', '批准或拒绝提案（可附反馈）', schema({
    id: field('string'), action: field('string', { enum: ['approve', 'reject'] }), feedback: field('string'),
  }, ['id', 'action']), params => service.reviewDraft(text(params, 'id'), params.action === 'reject' ? 'reject' : 'approve', text(params, 'feedback')));

  // Query / lint / synthesis
  add('ask', '基于 wiki 提问（引用页面并回溯原文）', schema({ question: field('string') }, ['question']), params => service.ask(text(params, 'question')));
  add('answers', '搜索并分页读取问答历史', schema({ ...paging, query: field('string') }), params => pageSlice(service.answers().filter(answer => !text(params, 'query') || (answer.question + answer.answer).toLocaleLowerCase().includes(text(params, 'query').toLocaleLowerCase())), { ...params, limit: number(params, 'limit', 5) }).map(answer => ({ ...answer, question: byteTruncate(answer.question, 600), model: byteTruncate(answer.model, 80), citations: answer.citations.slice(0, 10).map(slug => byteTruncate(slug, 80)), pages: [], evidence: [], answer: byteTruncate(answer.answer, 800) })));
  add('archive_answer', '将完整问答记录归档为新页面', schema({ at: field('string') }, ['at']), params => {
    const answer = service.answers().find(item => item.at === text(params, 'at'));
    if (!answer) throw new Error('问答记录已过期，请重新提问');
    return service.archiveAnswer(answer.question, answer.answer, answer.citations, answer.evidence);
  });
  add('get_answer', '读取完整问答记录', schema({ at: field('string') }, ['at']), params => service.answers().find(answer => answer.at === text(params, 'at')) ?? null);
  add('save_answer', '把回答归档成新页面', schema({
    question: field('string'), answer: field('string'),
    citations: field('array', { items: { type: 'string' } }),
    evidence: field('array', { items: { type: 'object', properties: { sourceId: field('string'), quote: field('string') } } }),
  }, ['question', 'answer']), params => service.archiveAnswer(
    text(params, 'question'), text(params, 'answer'), strings(params, 'citations'),
    (Array.isArray(params.evidence) ? params.evidence : [])
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .filter(item => typeof item.sourceId === 'string' && typeof item.quote === 'string')
      .map(item => ({ sourceId: item.sourceId as string, quote: (item.quote as string).slice(0, 300) })),
  ));
  add('lint', '运行知识库体检', schema({}), () => service.lint());
  add('lint_result', '读取最近一次体检结果', schema({}), () => service.lintResult());

  // Credentials (private file, never in the manifest config form)
  add('set_api_key', '保存模型 API Key', schema({ value: field('string') }, ['value']), params => service.setApiKey(text(params, 'value')));
  add('clear_api_key', '清除模型 API Key', schema({}), () => service.clearApiKey().then(() => true));
  add('test_connection', '测试模型连通性', schema({}), () => service.testConnection());

  // ---- MCP tools: read-only surface for workbench Agents -----------------
  const windowFields = { offset: field('integer', { minimum: 0 }), limit: field('integer', { minimum: 2, maximum: 12000 }) };
  add('wiki_index', 'MCP：分页读取导航索引；hasMore 时用 next 作为 offset 继续读取',
    mcpSchema(windowFields), params => { const { text: index, ...cursor } = materialWindow(service.indexText(), number(params, 'offset'), number(params, 'limit', 12000)); return { index, ...cursor, pages: service.listPages().length }; }, true);
  add('wiki_search', 'MCP：按关键词检索 wiki 页面，返回摘要与命中片段；再用 wiki_read 读取全文',
    mcpSchema({ query: field('string', { maxLength: 500 }), limit: field('integer', { minimum: 1, maximum: 20 }) }, ['query']),
    params => service.searchSnippets(text(params, 'query'), Math.max(1, Math.min(20, number(params, 'limit', 8) || 8))), true);
  add('wiki_read', 'MCP：分页读取页面、反向链接与出处；hasMore 时用 next 作为 offset 继续',
    mcpSchema({ slug: field('string'), ...windowFields }, ['slug']), params => service.readForAgent(text(params, 'slug'), number(params, 'offset'), number(params, 'limit', 12000)), true);
  add('wiki_sources', 'MCP：分页列出全部原始素材；hasMore 时用 next 作为 offset 继续',
    mcpSchema(paging), params => { const sources = service.listSources(), offset = Math.max(0, number(params, 'offset')), items = pageSlice(sources, params).map(source => ({
      id: source.id, title: source.title, createdAt: source.createdAt, compiled: source.compiled, characters: source.text.length, images: source.images.length,
    })), next = offset + items.length; return { items, offset, next, total: sources.length, hasMore: next < sources.length }; }, true);
  add('wiki_source', 'MCP：按需读取完整原始素材，quote 可定位；hasMore 时用 next 作为 offset 继续。section=vision 可读取图片理解',
    mcpSchema({ id: field('string'), ...windowFields, quote: field('string'), section: field('string', { enum: ['text', 'vision'] }) }, ['id']), params => {
      const source = service.getSource(text(params, 'id'));
      if (!source) return null;
      const section = params.section === 'vision' ? 'vision' : 'text', content = source[section], quote = text(params, 'quote'), found = quote ? content.indexOf(quote) : -1;
      return { id: source.id, title: source.title, createdAt: source.createdAt, section, images: source.images.length, ...materialWindow(content, found >= 0 ? Math.max(0, found - 150) : number(params, 'offset'), number(params, 'limit', 12000)) };
    }, true);
  add('wiki_status', 'MCP：读取知识库规模与模型配置状态',
    mcpSchema({}), () => {
      const { tasks, ...rest } = service.status();
      return { ...rest, activeTasks: tasks.filter(task => ['queued', 'running'].includes(task.status)).length };
    }, true);
  add('wiki_ask', 'MCP：基于已发布页面提问；返回任务 ID，再用 wiki_task 轮询取带引用的答案',
    mcpSchema({ question: field('string', { maxLength: 2000 }) }, ['question']),
    params => ({ taskId: service.ask(text(params, 'question')), pollWith: 'wiki_task' }), true);
  add('wiki_task', 'MCP：查询 wiki_ask 等后台任务的状态与结果',
    mcpSchema({ id: field('string') }, ['id']), params => {
      const task = service.taskStatus(text(params, 'id'));
      if (!task) return null;
      const { result, ...rest } = task;
      return { ...rest, result: result === undefined ? null : trimDeep(result, 32 * 1024) };
    }, true);

  registerWorkspaceCommands(service, add, api.signal);
  for (const command of commands) {
    api.command({ name: command.name, description: command.description, mcp: command.mcp && !!options.config.allowAgentAccess && (command.name !== 'wiki_ask' || !!options.config.allowAgentQueries), inputSchema: command.input },
      async params => {
        if (command.mcp && (!options.config.allowAgentAccess || (command.name === 'wiki_ask' && !options.config.allowAgentQueries))) throw new Error('请先在插件设置中启用 Agent 知识库访问权限');
        const result = await command.handler(params);
        if (['get_page', 'get_skill', 'schema'].includes(command.name) && resultBytes(result) > MAX_RESULT_BYTES) throw new Error('内容过大，请在本地文件中编辑完整内容');
        return fit(result);
      });
  }

  // Automatic maintenance: new material is compiled into a reviewable draft,
  // and lint runs on its own schedule. Both are no-ops without an API key.
  api.interval(() => service.tick(), 60_000);
  ctx.effect(() => {
    const timer = setTimeout(() => service.tick(), 3_000);
    return () => clearTimeout(timer);
  });
  // Watching the inbox is a Cordis effect: the watcher dies when the plugin is
  // disabled or reloaded, so no stray handles survive a config change.
  ctx.effect(() => {
    inbox = startInbox({
      root: api.dataDirectory,
      parse: (name, bytes) => service.extractPdfText(name, new Uint8Array(bytes)),
      onPdf: async (name, bytes) => { await service.ingestPdfFile(name, new Uint8Array(bytes)); },
      onFile: async (name, value) => { await service.ingestInboxFile(name, value); },
      onError: (name, error) => store.appendLog('ingest', '自动采集失败', [
        `文件：${path.basename(name)}`, String(error instanceof Error ? error.message : error).slice(0, 200),
      ]),
    });
    return () => { inbox?.stop(); inbox = null; };
  });
}
