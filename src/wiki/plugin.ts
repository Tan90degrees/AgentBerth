import type { Context } from 'cordis';
import path from 'node:path';
import { byteTruncate, extractLinks, lineDiff, truncate } from './core';
import { startInbox, type InboxHandle } from './inbox';
import type { ServiceOptions } from './service';
import { WikiService } from './service';
import { WikiStore } from './store';
import type { WikiConfig } from './types';

type Params = Record<string, unknown>;
type Properties = Record<string, unknown>;
type Handler = (params: Params) => unknown | Promise<unknown>;

const text = (params: Params, key: string, fallback = ''): string => typeof params[key] === 'string' ? params[key] as string : fallback;
const bool = (params: Params, key: string): boolean => params[key] === true;
const number = (params: Params, key: string, fallback = 0): number => typeof params[key] === 'number' ? params[key] as number : fallback;
const strings = (params: Params, key: string): string[] => Array.isArray(params[key]) ? (params[key] as unknown[]).filter((value): value is string => typeof value === 'string') : [];
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
    autoApprove: config.autoApprove === true,
    lintMinutes: Number(config.lintMinutes ?? 0),
    maxContextPages: Number(config.maxContextPages ?? 8),
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
  add('list_pages', '列出所有 wiki 页面（摘要）', schema({}), () => {
    const pages = service.listPages();
    const inbound = new Map<string, number>();
    for (const page of pages) for (const target of extractLinks(page.body)) inbound.set(target, (inbound.get(target) ?? 0) + 1);
    return pages.slice(0, 500).map(page => ({ slug: page.slug, title: byteTruncate(page.title, 300), summary: byteTruncate(page.summary, 600), kind: page.kind, humanEdited: page.humanEdited, updatedAt: page.updatedAt, links: extractLinks(page.body).length, backlinks: inbound.get(page.slug) ?? 0 }));
  });
  add('get_page', '读取单页全文、反向链接与原始出处', schema({ slug: field('string') }, ['slug']), params => {
    const page = service.getPage(text(params, 'slug'));
    if (!page) return null;
    const inbound = service.listPages().filter(other => extractLinks(other.body).includes(page.slug)).map(other => other.slug);
    // The view renders page.body; shipping the raw document as `text` too would
    // double the payload and can push a long Chinese page past the bridge cap.
    return {
      page: { ...page, body: byteTruncate(page.body, 60 * 1024) },
      backlinks: inbound.slice(0, 200), history: service.history(page.slug),
      excerpts: service.excerpts(page.slug),
    };
  });
  add('save_page', '人工编辑页面（自动编译将跳过）', schema({
    slug: field('string'), title: field('string'), summary: field('string'), body: field('string'),
    kind: field('string', { enum: ['concept', 'entity', 'source', 'comparison', 'overview', 'note'] }),
    tags: field('array', { items: { type: 'string' } }),
  }, ['slug', 'body']), params => service.savePage({
    slug: text(params, 'slug'),
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
  add('list_sources', '列出原始素材', schema({}), () => service.listSources().slice(0, 300).map(source => ({
    id: source.id, title: byteTruncate(source.title, 300), createdAt: source.createdAt, compiled: source.compiled,
    images: source.images.length, hasVision: !!source.vision, length: source.text.length,
  })));
  add('get_source', '读取素材全文', schema({ id: field('string') }, ['id']), params => {
    const source = service.getSource(text(params, 'id'));
    return source ? {
      ...source,
      text: byteTruncate(source.text, 60 * 1024),
      vision: byteTruncate(source.vision, 20 * 1024),
      images: source.images.slice(0, 40),
    } : null;
  });
  add('add_source', '新增原始素材（不可变）', schema({ title: field('string'), text: field('string') }, ['text']), params => service.addSource({ title: text(params, 'title'), text: text(params, 'text') }));
  add('add_image', '为素材追加一张压缩后的图片', schema({ sourceId: field('string'), mime: field('string'), base64: field('string') }, ['sourceId', 'mime', 'base64']), params => service.addImage(text(params, 'sourceId'), text(params, 'mime'), text(params, 'base64')));
  add('delete_source', '删除原始素材', schema({ id: field('string') }, ['id']), params => service.deleteSource(text(params, 'id')).then(() => true));

  // Automatic capture: watch raw/inbox and import finished workbench sessions.
  add('inbox_status', '查看自动采集目录与待处理文件', schema({}), () => ({
    dir: inbox?.dir ?? path.join(api.dataDirectory, 'raw', 'inbox'),
    importedDir: inbox?.importedDir ?? path.join(api.dataDirectory, 'raw', 'inbox', 'imported'),
    failedDir: inbox?.failedDir ?? path.join(api.dataDirectory, 'raw', 'inbox', 'failed'),
    pending: inbox?.pending ?? [], archived: inbox?.archived ?? 0, watching: !!inbox,
  }));
  add('list_capture_sessions', '列出可沉淀为素材的工作台会话', schema({}), () => service.listCaptureSessions());
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
  add('list_drafts', '列出编译提案', schema({ status: field('string', { enum: ['pending', 'approved', 'rejected'] }) }), params => service.listDrafts(typeof params.status === 'string' ? params.status as 'pending' | 'approved' | 'rejected' : undefined)
    .slice(0, 100).map(draft => ({ id: draft.id, sourceId: draft.sourceId, sourceTitle: draft.sourceTitle, createdAt: draft.createdAt, status: draft.status, model: draft.model, summary: byteTruncate(draft.summary, 600), pages: draft.pages.slice(0, 20).map(page => ({ slug: page.slug, title: byteTruncate(page.title, 300), action: page.action, summary: byteTruncate(page.summary, 600) })), contradictions: draft.contradictions.slice(0, 20).map(value => byteTruncate(value, 600)), feedback: draft.feedback.slice(0, 10) })));
  add('get_draft', '读取单个提案（页摘要）', schema({ id: field('string') }, ['id']), params => {
    const draft = service.getDraft(text(params, 'id'));
    return draft ? { ...draft, pages: draft.pages.map(page => ({ slug: page.slug, title: page.title, action: page.action, summary: page.summary })) } : null;
  });
  add('draft_page', '读取提案中某一页的完整 diff', schema({ id: field('string'), slug: field('string') }, ['id', 'slug']), params => {
    const draft = service.getDraft(text(params, 'id'));
    const page = draft?.pages.find(item => item.slug === text(params, 'slug'));
    if (!page) return null;
    const previous = page.previous ? byteTruncate(page.previous, 24 * 1024) : null;
    const body = byteTruncate(page.body, 48 * 1024);
    return { ...page, previous, body, diff: lineDiff(previous ?? '', body).slice(0, 300)
      .map(line => ({ ...line, text: byteTruncate(line.text, 2 * 1024) })) };
  });
  add('review_draft', '批准或拒绝提案（可附反馈）', schema({
    id: field('string'), action: field('string', { enum: ['approve', 'reject'] }), feedback: field('string'),
  }, ['id', 'action']), params => service.reviewDraft(text(params, 'id'), params.action === 'reject' ? 'reject' : 'approve', text(params, 'feedback')));

  // Query / lint / synthesis
  add('ask', '基于 wiki 提问（引用页面并回溯原文）', schema({ question: field('string') }, ['question']), params => service.ask(text(params, 'question')));
  add('answers', '最近的问答记录', schema({}), () => service.answers().slice(0, 5).map(answer => ({ ...answer, answer: truncate(answer.answer, 4000) })));
  add('save_answer', '把回答归档成新页面', schema({
    question: field('string'), answer: field('string'),
    citations: field('array', { items: { type: 'string' } }),
    evidence: field('array', { items: { type: 'object', properties: { sourceId: field('string'), quote: field('string') } } }),
  }, ['question', 'answer']), params => service.saveAnswer(
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
  add('wiki_index', 'MCP：读取 index.md 导航索引与页面总数，查询知识库时先用它定位页面',
    mcpSchema({}), () => ({ index: byteTruncate(service.indexText(), 32 * 1024), pages: service.listPages().length }), true);
  add('wiki_search', 'MCP：按关键词检索 wiki 页面，返回摘要与命中片段；再用 wiki_read 读取全文',
    mcpSchema({ query: field('string', { maxLength: 500 }), limit: field('integer', { minimum: 1, maximum: 20 }) }, ['query']),
    params => service.searchSnippets(text(params, 'query'), Math.max(1, Math.min(20, number(params, 'limit', 8) || 8))), true);
  add('wiki_read', 'MCP：读取单页全文、反向链接与可验证的原始素材出处',
    mcpSchema({ slug: field('string') }, ['slug']), params => service.readForAgent(text(params, 'slug')), true);
  add('wiki_sources', 'MCP：列出不可变的原始素材清单',
    mcpSchema({}), () => service.listSources().slice(0, 100).map(source => ({
      id: source.id, title: source.title, createdAt: source.createdAt, compiled: source.compiled, characters: source.text.length,
    })), true);
  add('wiki_source', 'MCP：读取一份原始素材全文（可用 quote 定位证据片段）',
    mcpSchema({ id: field('string') }, ['id']), params => {
      const source = service.getSource(text(params, 'id'));
      return source ? { id: source.id, title: source.title, createdAt: source.createdAt, text: byteTruncate(source.text, 60 * 1024) } : null;
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

  for (const command of commands) {
    api.command({ name: command.name, description: command.description, mcp: command.mcp, inputSchema: command.input },
      async params => fit(await command.handler(params)));
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
      onFile: async (name, value) => { await service.ingestInboxFile(name, value); },
      onError: (name, error) => store.appendLog('ingest', '自动采集失败', [
        `文件：${path.basename(name)}`, String(error instanceof Error ? error.message : error).slice(0, 200),
      ]),
    });
    return () => { inbox?.stop(); inbox = null; };
  });
}
