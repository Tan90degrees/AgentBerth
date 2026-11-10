import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  buildIndex, byteTruncate, draftPages, evidenceList, extractLinks, lintWiki, pageHash, pageToDocument,
  parseDocument, parseJsonResponse, resolveExcerpts, searchPages, skillFromDocument,
  skillToDocument, slugify, snippet, truncate, validateSkillName,
} from './core';
import { chat, maskedKey, type ChatMessage } from './llm';
import {
  BUILTIN_SKILLS, DEFAULT_SCHEMA, compileContext, compileMessages, ingestMessages, lintMessages,
  queryMessages, resolveSkill, synthesizeMessages,
} from './prompts';
import { withWriteLock, type WikiStore } from './store';
import { WikiWorkspace } from './workspace';
import { extractPdfText, type PdfTextExtractor } from './pdf';
import type {
  SourceEvidence, SourceExcerpt, WikiAnswer, WikiConfig, WikiDraft, WikiLint, WikiPage, WikiSkill, WikiSource, WikiStatus, WikiTask,
} from './types';

export interface ServiceOptions {
  store: WikiStore;
  config: WikiConfig;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  publish?: () => void;
  /** Host RPC, used to read workbench sessions when capturing them as sources. */
  call?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Overridable PDF text extraction, so tests never need the real pdf.js. */
  pdfExtract?: PdfTextExtractor;
}

const now = () => new Date().toISOString();
/** After a failed auto-compile, wait before retrying the same source instead of
 * paying for a model call every 60 seconds forever. Manual retry is unaffected. */
const COMPILE_RETRY_MS = 5 * 60_000;
type SourceInput = { document?: { name: string; bytes: Uint8Array; pages: number; ranges: { page: number; start: number; end: number }[] }; guard?: () => void; title: string; text: string; images?: { mime: string; base64: string }[]; origin?: string; staging?: boolean };

/** Everything the UI can do lives here; plugin.ts is only a thin Cordis adapter.
 * Long model calls run in a background queue so no RPC ever blocks the daemon. */
export class WikiService {
  readonly store: WikiStore;
  readonly workspace: WikiWorkspace;
  private readonly operationContext = new AsyncLocalStorage<AbortSignal>();
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly pausedSources = new Set<string>();
  readonly config: WikiConfig;
  private readonly signal: AbortSignal;
  private readonly fetchImpl?: typeof fetch;
  private readonly publish?: () => void;
  private readonly call?: ServiceOptions['call'];
  private readonly pdfExtract: PdfTextExtractor;
  private readonly tasks = new Map<string, WikiTask>();
  private readonly queue: { id: string; run: (task: WikiTask) => Promise<unknown>; onError?: () => void }[] = [];
  private draining = false;
  private lastTickLint = 0;
  private counts?: { revision: number; at: number; pages: number; sources: number; pendingDrafts: number; skills: number; links: number; orphans: number };
  private readonly compiling = new Map<string, string>();
  private readonly failedSources = new Map<string, number>();

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.workspace = new WikiWorkspace(options.store);
    this.loadTaskHistory('后台已重启，请重试');
    this.config = options.config;
    this.signal = options.signal;
    this.fetchImpl = options.fetchImpl;
    this.publish = options.publish;
    this.call = options.call;
    this.pdfExtract = options.pdfExtract ?? extractPdfText;
    this.lastTickLint = Date.parse(this.store.meta().lastLint ?? '') || 0;
    // Abandoned uploads otherwise pin up to 20 MiB of buffers each. Sweep on a
    // timer as well as on every new upload, and release everything on shutdown.
    const sweep = setInterval(() => this.prunePdfUploads(), 60_000);
    sweep.unref?.();
    this.signal.addEventListener('abort', () => { clearInterval(sweep); this.pdfUploads.clear(); }, { once: true });
    if (this.signal.aborted) { clearInterval(sweep); this.pdfUploads.clear(); }
    if (!this.store.schema().trim()) this.store.saveSchema(DEFAULT_SCHEMA);
    if (!this.store.index().trim()) this.store.saveIndex(buildIndex([]));
  }

  // ---- Model access -----------------------------------------------------
  private key(): string { return this.store.credentials().apiKey; }
  private modelReady(): boolean { return !!this.config.textModel.trim() && (this.config.authRequired === false || !!this.key()); }
  private assertOperation(): void { if (this.signal.aborted || this.operationContext.getStore()?.aborted) throw new Error('任务已取消'); }
  private loadTaskHistory(reason: string): void {
    this.tasks.clear(); this.pausedSources.clear();
    const saved = this.workspace.tasks<WikiTask[]>([]);
    for (const task of (Array.isArray(saved) ? saved : []).slice(-200)) {
      if (!task || typeof task.id !== 'string' || typeof task.label !== 'string' || typeof task.startedAt !== 'string' || !['compile', 'ask', 'lint', 'vision', 'archive'].includes(task.kind) || !['queued', 'running', 'done', 'failed', 'cancelled'].includes(task.status)) continue;
      if (['queued', 'running'].includes(task.status)) { task.status = 'failed'; task.error = reason; task.finishedAt = now(); task.manualRetry = true; }
      if (task.retry && (!task.retry.params || typeof task.retry.params !== 'object' || Array.isArray(task.retry.params))) delete task.retry;
      if (typeof task.progress !== 'string') task.progress = '';
      this.tasks.set(task.id, task);
      if ((task.status === 'cancelled' || task.manualRetry) && task.retry?.action === 'compile') this.pausedSources.add(String(task.retry.params.sourceId));
    }
  }
  assertWorkspaceIdle(): void {
    this.prunePdfUploads();
    if (this.draining || this.queue.length || this.taskControllers.size || this.taskList().some(task => ['queued', 'running'].includes(task.status))) throw new Error('请先完成任务或等待取消处理结束，再恢复备份');
    if (this.pdfUploads.size) throw new Error('请先完成或取消 PDF 上传，再恢复备份');
  }
  reloadWorkspaceState(): void {
    this.assertWorkspaceIdle(); this.loadTaskHistory('备份中的未完成任务，请手动重试');
    this.compiling.clear(); this.failedSources.clear(); this.counts = undefined;
    this.lastTickLint = Date.parse(this.store.meta().lastLint ?? '') || 0; this.persistTasks();
  }
  private persistTasks(): void { this.workspace.saveTasks([...this.tasks.values()].slice(-200)); }
  taskList(): WikiTask[] { return [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  cancelTask(id: string): boolean {
    const task = this.tasks.get(id); if (!task || !['queued', 'running'].includes(task.status)) return false;
    task.status = 'cancelled'; task.progress = '已取消'; task.finishedAt = now();
    if (task.retry?.action === 'compile') this.pausedSources.add(String(task.retry.params.sourceId));
    this.taskControllers.get(id)?.abort(new Error('用户取消了任务'));
    for (const [source, active] of this.compiling) if (active === id) this.compiling.delete(source);
    this.persistTasks(); return true;
  }
  retryTask(id: string): string {
    const task = this.tasks.get(id), retry = task?.retry;
    if (!task || !['failed', 'cancelled'].includes(task.status) || !retry) throw new Error('此任务暂不能重试');
    const p = retry.params;
    switch (retry.action) {
      case 'compile': return this.compile(String(p.sourceId));
      case 'ask': return this.ask(String(p.question));
      case 'lint': return this.lint();
      case 'review': return this.reviewDraft(String(p.id), p.action === 'reject' ? 'reject' : 'approve', String(p.feedback ?? ''));
      case 'archive': return this.archiveAnswer(String(p.question), String(p.answer), Array.isArray(p.citations) ? p.citations as string[] : [], Array.isArray(p.evidence) ? p.evidence as SourceEvidence[] : []);
      default: throw new Error('任务类型不支持重试');
    }
  }
  private model(kind: 'text' | 'vision' = 'text') {
    return {
      baseURL: this.config.baseURL,
      apiKey: this.key(),
      model: kind === 'vision' && this.config.visionModel.trim() ? this.config.visionModel : this.config.textModel,
      fetchImpl: this.fetchImpl,
      signal: this.operationContext.getStore() ?? this.signal,
      authRequired: this.config.authRequired,
    };
  }
  private async complete(messages: ChatMessage[], kind: 'text' | 'vision' = 'text', images?: { mime: string; base64: string }[], timeoutMs = 110_000): Promise<string> {
    return chat({ ...this.model(kind), messages, images, timeoutMs });
  }
  private schema(): string { return this.store.schema() || DEFAULT_SCHEMA; }
  allSkills(): WikiSkill[] {
    const custom = this.store.listSkills();
    const names = new Set(custom.map(skill => skill.name));
    return [...custom, ...BUILTIN_SKILLS.filter(skill => !names.has(skill.name))].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- Status -----------------------------------------------------------
  status(): WikiStatus {
    if (!this.counts || this.counts.revision !== this.store.revision || Date.now() - this.counts.at > 5000) {
      const pages = this.store.listPages();
      this.counts = { revision: this.store.revision, at: Date.now(), pages: pages.length,
        sources: this.store.listSources().filter(source => !source.staging).length,
        pendingDrafts: this.store.listDrafts().filter(draft => draft.status === 'pending').length,
        skills: this.allSkills().length, links: new Set(pages.flatMap(page => extractLinks(page.body))).size, orphans: lintWiki(pages).orphans.length };
    }
    const meta = this.store.meta();
    return {
      pages: this.counts.pages, sources: this.counts.sources, pendingDrafts: this.counts.pendingDrafts,
      skills: this.counts.skills, links: this.counts.links, orphans: this.counts.orphans,
      model: {
        baseURL: this.config.baseURL, textModel: this.config.textModel, visionModel: this.config.visionModel,
        keyConfigured: !!this.key(), keyHint: maskedKey(this.key()),
      },
      automation: { autoCompile: this.config.autoCompile, autoApprove: false, lintMinutes: this.config.lintMinutes },
      lastLint: meta.lastLint,
      tasks: [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20),
      ready: this.modelReady(),
    };
  }
  taskStatus(id: string): WikiTask | null { return this.tasks.get(id) ?? null; }

  // ---- Background queue -------------------------------------------------
  private enqueue(kind: WikiTask['kind'], label: string, run: (task: WikiTask) => Promise<unknown>, onError?: () => void, retry?: WikiTask['retry']): string {
    if (this.queue.length >= 100) throw new Error('后台任务过多，请稍后重试');
    for (const [id, task] of this.tasks) {
      if (this.tasks.size < 200) break;
      if (['done', 'failed', 'cancelled'].includes(task.status)) this.tasks.delete(id);
    }
    const task: WikiTask = { id: randomUUID(), kind, label, status: 'queued', progress: '排队中', startedAt: now(), retry };
    this.tasks.set(task.id, task);
    this.queue.push({ id: task.id, run, onError });
    this.persistTasks();
    void this.drain();
    return task.id;
  }
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        const task = this.tasks.get(job.id)!;
        if (task.status === 'cancelled') continue;
        if (this.signal.aborted) { task.status = 'failed'; task.error = '插件已停止'; task.finishedAt = now(); continue; }
        task.status = 'running'; task.progress = '正在处理'; task.startedAt = now();
        const controller = new AbortController(); this.taskControllers.set(task.id, controller);
        const operationSignal = AbortSignal.any([this.signal, controller.signal]); this.persistTasks();
        try { task.result = await this.operationContext.run(operationSignal, () => job.run(task)); if (operationSignal.aborted) throw new Error('任务已取消'); task.status = 'done'; task.progress = '已完成'; }
        catch (error) {
          task.status = controller.signal.aborted ? 'cancelled' : 'failed';
          task.error = String(error instanceof Error ? error.message : error).slice(0, 500);
          task.progress = controller.signal.aborted ? '已取消' : '失败';
          if (!controller.signal.aborted) job.onError?.();
        }
        this.taskControllers.delete(task.id);
        task.finishedAt = now(); this.persistTasks();
        for (const [sourceId, id] of this.compiling) if (id === task.id) this.compiling.delete(sourceId);
        try { this.publish?.(); } catch { /* A view notification cannot stop the queue. */ }
      }
    } finally { this.draining = false; }
  }
  private queued(kind: WikiTask['kind']): boolean {
    return [...this.tasks.values()].some(task => task.kind === kind && ['queued', 'running'].includes(task.status)) || this.queue.some(job => this.tasks.get(job.id)?.kind === kind);
  }

  /** Called by api.interval: new material triggers a compile, and lint runs on
   * its own schedule. Nothing here writes to the wiki without a review. */
  tick(): void {
    if (this.signal.aborted) return;
    if (this.config.autoCompile && !this.queued('compile')) {
      const pending = this.store.listSources().find(source =>
        !source.staging && !source.compiled && !this.pausedSources.has(source.id) && Date.now() - (this.failedSources.get(source.id) ?? 0) > COMPILE_RETRY_MS);
      if (pending && this.modelReady()) void this.compile(pending.id);
    }
    const interval = Math.max(0, this.config.lintMinutes) * 60_000;
    if (interval > 0 && this.modelReady() && Date.now() - this.lastTickLint >= interval && !this.queued('lint')) {
      this.lastTickLint = Date.now();
      void this.lint();
    }
    for (const [id, task] of this.tasks) if (['done', 'failed', 'cancelled'].includes(task.status) && task.finishedAt && Date.now() - Date.parse(task.finishedAt) > 3_600_000) this.tasks.delete(id);
  }

  // ---- Raw sources ------------------------------------------------------
  private assertActive(): void {
    if (this.signal.aborted) throw new Error('插件已停止，素材未保存');
  }
  listSources(): WikiSource[] { return this.store.listSources(); }
  getSource(id: string): WikiSource | null { return this.store.getSource(id); }
  async addSource(input: SourceInput): Promise<WikiSource> {
    return (await this.createSource(input)).source;
  }
  private async createSource(input: SourceInput, deduplicate = false): Promise<{ source: WikiSource; skipped: boolean }> {
    this.assertActive();
    const title = truncate(String(input.title ?? '').trim() || '未命名素材', 160);
    const text = String(input.text ?? '');
    if (text.length > 200_000) throw new Error('素材超过 200000 字符上限，请拆分后导入');
    if (!text.trim() && !(input.images?.length) && !input.staging) throw new Error('素材内容不能为空');
    return withWriteLock(() => {
      // A parser can finish after its plugin generation has been disposed, or
      // disposal can happen while this write waits behind another operation.
      this.assertActive(); input.guard?.();
      if (deduplicate) {
        const hash = this.store.sourceHash({ title, text, images: [], vision: '' });
        const existing = this.store.listSources().find(source => this.store.sourceHash(source) === hash);
        if (existing) return { source: existing, skipped: true };
      }
      const images = (input.images ?? []).slice(0, 8).map(image => this.store.addImage(image.mime, image.base64));
      const source: WikiSource = { id: randomUUID(), title, text, images, vision: '', compiled: false, hash: '', createdAt: now(), ...(input.staging ? { staging: true } : {}) };
      if (input.document) { const d = input.document; source.document = { name: d.name, asset: this.store.addDocument(d.bytes), pages: d.pages, ranges: d.ranges }; }
      source.hash = this.store.sourceHash(source);
      this.store.saveSource(source);
      this.store.appendLog('ingest', title, [
        `素材 ID：${source.id}`, `${text.length} 字，${images.length} 张图片`,
        ...(input.origin ? [`来源：${truncate(String(input.origin).replace(/[\r\n]+/g, ' '), 120)}`] : []),
        '等待编译为审阅提案',
      ]);
      return { source, skipped: false };
    });
  }
  /** Files dropped into raw/inbox become immutable sources. A content hash
   * keeps a re-scan (or a duplicated fs.watch event) from importing twice. */
  async ingestInboxFile(name: string, text: string): Promise<{ id: string; skipped: boolean }> {
    const title = truncate(path.basename(name).replace(/\.(md|markdown|txt|json|pdf)$/i, ''), 160) || '导入素材';
    const body = String(text ?? '');
    if (body.length > 200_000) throw new Error('素材超过 200000 字符上限，请拆分后导入');
    return this.importText(title, body, `自动采集 ${path.basename(name)}`);
  }

  /** Shared dedupe-and-save for every ingest path (inbox file, PDF, session). */
  private async importText(title: string, body: string, origin: string, extra: Pick<SourceInput, 'guard' | 'document'> = {}): Promise<{ id: string; skipped: boolean }> {
    const cleanTitle = truncate(title.trim() || '未命名素材', 160);
    const text = String(body ?? '');
    if (!text.trim()) throw new Error('素材内容不能为空');
    const { source, skipped } = await this.createSource({ title: cleanTitle, text, origin, ...extra }, true);
    return { id: source.id, skipped };
  }

  // ---- PDF import -------------------------------------------------------
  /** The inbox watcher parses PDFs with this; the chunked upload path shares it. */
  async extractPdfText(name: string, bytes: Uint8Array): Promise<string> {
    this.assertActive();
    const { text } = await this.pdfExtract(bytes);
    this.assertActive();
    if (!text.trim()) throw new Error(`PDF「${path.basename(name)}」没有可提取的文本（可能是扫描件或纯图片 PDF）`);
    return text;
  }
  async ingestPdfFile(name: string, bytes: Uint8Array): Promise<{ id: string; skipped: boolean }> {
    const title = truncate(path.basename(name).replace(/\.pdf$/i, ''), 160) || '导入素材';
    this.assertActive();
    const { text, pages, ranges = [] } = await this.pdfExtract(bytes);
    this.assertActive();
    return this.importText(title, text, `自动采集 PDF ${path.basename(name)}`, { document: { name: path.basename(name), bytes, pages, ranges } });
  }

  // The iframe bridge caps one command's params at 64 KiB, so a PDF travels as
  // base64 chunks. Uploads live in memory only and expire after 10 minutes.
  private static readonly PDF_UPLOAD_TTL_MS = 10 * 60_000;
  private static readonly PDF_MAX_BYTES = 20 * 1024 * 1024;
  private readonly pdfUploads = new Map<string, { title: string; chunks: Buffer[]; bytes: number; at: number; finishing?: boolean; cancelled?: boolean }>();

  private prunePdfUploads(): void {
    const cutoff = Date.now() - WikiService.PDF_UPLOAD_TTL_MS;
    for (const [id, entry] of this.pdfUploads) if (entry.at < cutoff) this.pdfUploads.delete(id);
  }

  beginPdfUpload(title: string): { uploadId: string } {
    this.assertActive();
    this.prunePdfUploads();
    if (this.pdfUploads.size >= 8) {
      const oldest = this.pdfUploads.keys().next().value;
      if (oldest) this.pdfUploads.delete(oldest);
    }
    const uploadId = randomUUID();
    this.pdfUploads.set(uploadId, { title: truncate(String(title ?? '').trim(), 160), chunks: [], bytes: 0, at: Date.now() });
    return { uploadId };
  }
  async appendPdfChunk(uploadId: string, base64: string, done: boolean): Promise<{ id: string; skipped: boolean; pages: number } | null> {
    this.assertActive();
    if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw new Error('无效的上传标识');
    const entry = this.pdfUploads.get(uploadId);
    if (!entry) throw new Error('上传已过期，请重新导入 PDF');
    if (entry.finishing) throw new Error('PDF 正在解析，请勿重复提交');
    const chunk = Buffer.from(String(base64 ?? ''), 'base64');
    if (chunk.length > 64 * 1024) throw new Error('PDF 分片过大');
    entry.bytes += chunk.length;
    entry.at = Date.now();
    if (entry.bytes > WikiService.PDF_MAX_BYTES) { this.pdfUploads.delete(uploadId); throw new Error('PDF 超过 20 MiB 上限，请拆分后导入'); }
    entry.chunks.push(chunk);
    if (!done) return null;
    entry.finishing = true;
    try {
      const bytes = new Uint8Array(Buffer.concat(entry.chunks));
      const { text, pages, ranges = [] } = await this.pdfExtract(bytes);
      this.assertActive();
      const guard = () => { if (entry.cancelled) throw new Error('PDF 导入已取消'); };
      guard();
      if (!text.trim()) throw new Error('PDF 没有可提取的文本（可能是扫描件或纯图片 PDF）');
      return { ...await this.importText(entry.title || '导入素材', text, 'PDF 导入', { guard, document: { name: (entry.title || 'document') + '.pdf', bytes, pages, ranges } }), pages };
    } finally { this.pdfUploads.delete(uploadId); }
  }
  cancelPdfUpload(uploadId: string): boolean { const entry = this.pdfUploads.get(uploadId); if (entry) entry.cancelled = true; return this.pdfUploads.delete(uploadId); }

  /** Sessions that can be turned into an immutable source. ACP agents expose a
   * live conversation; custom agents (CLI / plugin based) expose an imported
   * transcript history. Both are selectable in the view. */
  async listCaptureSessions(): Promise<{ id: string; title: string; status: string; agent: string; agentName: string; kind: 'acp' | 'history' }[]> {
    if (!this.call) return [];
    try {
      const state = await this.call('state', {}) as {
        sessions?: { id: string; title?: string; agent?: string; service?: boolean; owner?: unknown; remote?: unknown; nativeSessionId?: string | null; transcriptPath?: string | null; updatedAt?: string; latestRun?: { status?: string } }[];
        agents?: { id: string; name?: string; acp?: unknown; plugin?: { history?: boolean } | null }[];
      } | null;
      const names = new Map((state?.agents ?? []).map(agent => [agent.id, agent.name ?? agent.id]));
      const builtin: Record<string, string> = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', shell: '终端', custom: '自定义' };
      const label = (id: string) => names.get(id) ?? builtin[id] ?? id;
      return (state?.sessions ?? [])
        .filter(session => !!session.id && !session.service && !session.owner && !session.remote && session.agent !== 'shell')
        .map(session => {
          const definition = state?.agents?.find(agent => agent.id === session.agent);
          const acp = !!definition?.acp;
          const history = !!session.transcriptPath || !!session.nativeSessionId || !!definition?.plugin?.history;
          if (!acp && !history) return null;
          return {
            id: session.id, title: truncate(String(session.title ?? session.id), 120),
            status: String(session.latestRun?.status ?? 'idle'),
            agent: String(session.agent ?? ''), agentName: label(String(session.agent ?? '')),
            kind: acp ? 'acp' as const : 'history' as const,
          };
        })
        .filter((value): value is NonNullable<typeof value> => value !== null)
        .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
        .slice(0, 50);
    } catch (error) {
      throw new Error('读取工作台会话失败：' + String(error instanceof Error ? error.message : error).slice(0, 160));
    }
  }

  /** Turn a conversation into an immutable source. This is the workbench's
   * highest-value ingest path: agent runs already produce the raw material. */
  async captureSession(sessionId: string): Promise<{ id: string; skipped: boolean; events: number }> {
    if (!this.call) throw new Error('会话捕获在当前环境不可用');
    let sessionTitle = sessionId.slice(0, 8);
    let events: { sequence?: number; kind?: string; text: string }[] = [];
    try {
      const state = await this.call('state', {}) as {
        sessions?: { id: string; title?: string; agent?: string; nativeSessionId?: string | null }[];
        agents?: { id: string; acp?: unknown }[];
      } | null;
      const session = state?.sessions?.find(item => item.id === sessionId);
      if (!session) throw new Error('会话不存在');
      if (session.agent === 'shell') throw new Error('普通终端会话没有可沉淀的对话记录');
      const definition = state?.agents?.find(agent => agent.id === session.agent);
      sessionTitle = session.title || sessionTitle;
      if (definition?.acp) {
        const snapshot = await this.call('acpSnapshot', { sessionId, limit: 200 }) as {
          events?: { sequence?: number; kind?: string; text?: string }[];
        } | null;
        events = (snapshot?.events ?? [])
          .filter(event => event && typeof event.text === 'string' && event.text.trim())
          .map(event => ({ sequence: event.sequence, kind: event.kind, text: String(event.text) }));
      } else {
        // `history` only holds imported transcripts. A session that is merely
        // linked to a native (Claude / OpenCode / plugin) record keeps its text
        // in nativeHistory, so try that before declaring the session empty.
        type Msg = { role?: string; text?: string; timestamp?: string | null };
        let messages: Msg[] = [];
        const history = await this.call('history', { sessionId }) as { messages?: Msg[] } | null;
        messages = history?.messages ?? [];
        if (!messages.length && session.nativeSessionId) {
          const native = await this.call('nativeHistory', {
            sessionId, nativeSessionId: session.nativeSessionId, refresh: false,
          }) as { messages?: Msg[] } | null;
          messages = native?.messages ?? [];
        }
        events = messages
          .filter(message => message && typeof message.text === 'string' && message.text.trim())
          .slice(-200)
          .map((message, index) => ({
            sequence: index + 1,
            kind: message.role === 'assistant' ? 'assistant' : 'user',
            text: (message.timestamp ? `（${message.timestamp}）\n\n` : '') + String(message.text),
          }));
      }
    } catch (error) {
      throw new Error('读取工作台会话失败：' + String(error instanceof Error ? error.message : error).slice(0, 160));
    }
    if (!events.length) throw new Error('该会话暂无可沉淀的对话记录；可先在会话的「对话历史」中导入或关联原生记录');
    const labels: Record<string, string> = { user: '用户', assistant: '助手', thought: '思考', tool: '工具', plan: '计划', notice: '提示', error: '错误', permission: '授权', turn: '轮次', terminal: '终端' };
    const lines = events.map(event => `### ${event.sequence ?? '-'} · ${labels[event.kind ?? ''] ?? event.kind ?? '记录'}\n\n${truncate(event.text, 4000)}`);
    const title = truncate(`会话记录：${sessionTitle}`, 160);
    const text = truncate(`# ${title}\n\n> 采集自工作台会话 ${sessionId}，仅包含最近最多 200 条记录；每条最多 4000 字，整体最多 200000 字符。共 ${events.length} 条记录。\n\n${lines.join('\n\n')}`, 200_000);
    return { ...await this.importText(title, text, `工作台会话 ${sessionId}`), events: events.length };
  }
  async deleteSource(id: string): Promise<void> {
    await withWriteLock(() => { this.workspace.deleteSource(id); this.store.appendLog('edit', '删除原始素材', [`素材 ID：${id}`, '已编译的 wiki 页面保留']); });
  }
  async addImage(sourceId: string, mime: string, base64: string): Promise<{ name: string; images: number }> {
    return withWriteLock(() => {
      const source = this.store.getSource(sourceId);
      if (!source) throw new Error('素材不存在');
      if (source.images.length >= 8) throw new Error('单个素材最多 8 张图片');
      const name = this.store.addImage(mime, base64);
      source.images.push(name);
      source.vision = '';
      source.compiled = false;
      source.hash = this.store.sourceHash(source);
      this.store.saveSource(source);
      return { name, images: source.images.length };
    });
  }

  async finalizeSource(id: string): Promise<WikiSource> {
    return withWriteLock(() => {
      const source = this.store.getSource(id);
      if (!source) throw new Error('素材不存在');
      if (!source.text.trim() && !source.images.length) throw new Error('素材内容不能为空');
      source.staging = false;
      this.store.saveSource(source);
      return source;
    });
  }

  // ---- Wiki pages -------------------------------------------------------
  listPages(): WikiPage[] { return this.store.listPages(); }
  getPage(slug: string): WikiPage | null { return this.store.getPage(slug); }
  async savePage(input: { slug: string; title?: string; summary?: string; body?: string; kind?: WikiPage['kind']; tags?: string[]; evidence?: SourceEvidence[]; createOnly?: boolean; expected?: string }, guard?: () => void): Promise<WikiPage> {
    let slug = slugify(input.slug);
    if (input.body !== undefined && Buffer.byteLength(input.body) > 60 * 1024) throw new Error('页面超过 60 KiB，请拆分内容后保存');
    if (!slug || slug === 'untitled') throw new Error('页面名称无效');
    return withWriteLock(() => {
      guard?.();
      if (input.createOnly) {
        const base = slug;
        let suffix = 2;
        while (this.store.getPage(slug)) slug = slugify(base.slice(0, 68) + '-' + suffix++);
      }
      const previous = this.store.getPage(slug);
      if (input.expected !== undefined && (previous ? pageHash(previous) : '') !== input.expected) throw new Error('页面已变化，请重新打开后编辑');
      const at = now();
      // Hand edits and archived answers must not be able to attach a quote to
      // an unknown source or a one-character "proof".
      const raw = this.store.listSources();
      const allowed = new Set(raw.map(source => source.id));
      const evidence = evidenceList(input.evidence ?? previous?.evidence ?? [], undefined, allowed)
        .filter(item => item.sourceId && evidenceList([item], raw.find(source => source.id === item.sourceId)?.text ?? '').length > 0);
      const page: WikiPage = {
        slug, title: truncate(String(input.title ?? previous?.title ?? slug), 160) || slug,
        summary: truncate(String(input.summary ?? previous?.summary ?? ''), 400),
        kind: input.kind ?? previous?.kind ?? 'note',
        sources: [...new Set([...(previous?.sources ?? []), ...evidence.map(item => item.sourceId)])], evidence,
        tags: input.tags ?? previous?.tags ?? [],
        body: byteTruncate(String(input.body ?? previous?.body ?? ''), 60 * 1024),
        humanEdited: true, hash: '', createdAt: previous?.createdAt ?? at, updatedAt: at,
      };
      page.hash = pageHash(page);
      this.store.snapshot(slug);
      this.store.savePage(page);
      this.store.saveIndex(buildIndex(this.store.listPages()));
      this.store.appendLog('edit', page.title, [`页面：${slug}`, '人工编辑，自动编译将跳过此页']);
      return page;
    });
  }
  async deletePage(slug: string): Promise<void> {
    await withWriteLock(() => {
      this.workspace.deletePage(slug);
      this.store.saveIndex(buildIndex(this.store.listPages()));
      this.store.appendLog('edit', '删除页面', [`页面：${slug}`, '仍保留历史版本，可恢复']);
    });
  }
  history(slug: string) { return this.store.history(slug); }
  async revertPage(slug: string, name: string): Promise<WikiPage | null> {
    return withWriteLock(() => {
      const page = this.store.revertPage(slug, name);
      this.store.saveIndex(buildIndex(this.store.listPages()));
      this.store.appendLog('edit', '恢复历史版本', [`页面：${slug}`, `版本：${name}`]);
      return page;
    });
  }

  // ---- Skills -----------------------------------------------------------
  listSkills(): WikiSkill[] { return this.allSkills(); }
  getSkill(name: string): WikiSkill | null {
    const text = this.store.skillText(name);
    if (text !== null) return skillFromDocument(name, text, false, now());
    return BUILTIN_SKILLS.find(skill => skill.name === name) ?? null;
  }
  exportSkill(name: string): string {
    const skill = this.getSkill(name);
    if (!skill) throw new Error('Skill 不存在');
    return this.store.skillText(name) ?? skillToDocument(skill);
  }
  async saveSkill(input: { name: string; description: string; kind?: WikiSkill['kind']; triggers?: string[]; body: string }): Promise<WikiSkill> {
    const name = String(input.name ?? '').trim();
    validateSkillName(name);
    const skill: WikiSkill = {
      name, description: truncate(String(input.description ?? '').trim(), 4096),
      kind: input.kind ?? 'custom', triggers: (input.triggers ?? []).slice(0, 20).map(value => truncate(String(value), 80)),
      body: truncate(String(input.body ?? ''), 60_000), builtin: false, updatedAt: now(),
    };
    if (!skill.description) throw new Error('请填写 Skill 描述');
    if (!skill.body.trim()) throw new Error('请填写 Skill 指令内容');
    await withWriteLock(() => { this.store.saveSkill(skill); this.store.appendLog('edit', '保存 Skill', [`名称：${name}`, `类型：${skill.kind}`]); });
    return skill;
  }
  async importSkill(text: string): Promise<WikiSkill> {
    const parsed = skillFromDocument('import', String(text ?? ''), false, now());
    const { data } = parseDocument(String(text ?? ''));
    const name = String(data.name ?? '').trim();
    validateSkillName(name);
    return this.saveSkill({ name, description: parsed.description || String(data.description ?? ''), kind: parsed.kind, triggers: parsed.triggers, body: parsed.body });
  }
  async deleteSkill(name: string): Promise<void> {
    validateSkillName(name);
    if (this.store.skillText(name) === null) throw new Error('内置 Skill 不能删除；可新建同名 Skill 覆盖，或编辑其指令');
    await withWriteLock(() => { this.store.deleteSkill(name); this.store.appendLog('edit', '删除 Skill', [`名称：${name}`]); });
  }
  schemaText(): string { return this.schema(); }
  async saveSchema(value: string): Promise<void> {
    await withWriteLock(() => { this.store.saveSchema(value); this.store.appendLog('edit', '更新 Schema', ['约定文件已更新，后续编译会采用新规则']); });
  }

  // ---- Credentials ------------------------------------------------------
  async setApiKey(value: string): Promise<string> {
    const key = String(value ?? '').trim();
    if (key.length > 4096) throw new Error('API Key 过长');
    await withWriteLock(() => this.store.saveCredentials(key));
    return maskedKey(key);
  }
  async clearApiKey(): Promise<void> { await withWriteLock(() => this.store.clearCredentials()); }
  async testConnection(): Promise<string> {
    const reply = await this.complete([
      { role: 'system', content: '你是连通性测试助手，只回复两个字：可用' },
      { role: 'user', content: '请确认连接' },
    ], 'text', undefined, 15_000);
    return truncate(reply, 100);
  }

  // ---- Compile → draft → review ----------------------------------------
  compile(sourceId?: string): string {
    const source = sourceId ? this.store.getSource(sourceId) : this.store.listSources().find(item => !item.compiled);
    if (!source) throw new Error(sourceId ? '素材不存在' : '没有待编译的素材');
    if (source.staging) throw new Error('图片仍在上传，请完成素材保存后编译');
    const existing = this.compiling.get(source.id);
    if (existing && ['queued', 'running'].includes(this.tasks.get(existing)?.status ?? '')) return existing;
    if (!this.modelReady()) throw new Error('请先配置文本模型和鉴权方式');
    this.pausedSources.delete(source.id);
    const id = this.enqueue('compile', `编译「${source.title}」`, async task => {
      const fresh = this.store.getSource(source.id);
      if (!fresh) throw new Error('素材已被删除');
      const inputHash = this.store.sourceHash(fresh);
      await this.describeImages(fresh, task);
      const schema = this.schema(), skills = this.allSkills();
      task.progress = '抽取概念';
      const ingested = await this.complete(ingestMessages(fresh, schema, resolveSkill(skills, 'ingest'), this.store.index(), fresh.vision));
      this.assertOperation();
      const feedback = this.store.listDrafts().filter(draft => draft.sourceId === fresh.id && draft.status === 'rejected').flatMap(draft => draft.feedback).slice(-5);
      task.progress = '生成页面提案';
      const baseline = this.store.listPages();
      const context = compileContext(fresh, ingested, baseline);
      const compiled = await this.complete(compileMessages(fresh, ingested, context, schema, resolveSkill(skills, 'compile'), feedback));
      this.assertOperation();
      const payload = parseJsonResponse(compiled);
      const draft: WikiDraft = {
        id: randomUUID(), sourceId: fresh.id, sourceTitle: fresh.title, createdAt: now(),
        model: this.model().model, summary: typeof payload.summary === 'string' ? truncate(payload.summary, 400) : '编译完成',
        pages: draftPages(payload.pages, baseline, fresh.id, fresh.text).map(page => ({ ...page,
          action: page.action === 'update' && !context.some(item => item.slug === page.slug) ? 'skip' as const : page.action,
        })),
        sourceHash: inputHash,
        contradictions: Array.isArray(payload.contradictions) ? payload.contradictions.filter((value): value is string => typeof value === 'string').slice(0, 20).map(value => truncate(value, 300)) : [],
        feedback: [], status: 'pending',
      };
      if (!draft.pages.length) throw new Error('模型没有生成任何可用页面，可在 Skill 中调整编译要求后重试');
      await withWriteLock(() => {
        // Re-read inside the lock: images/vision may have been written while the
        // model was running, and the in-memory `fresh` must not overwrite them.
        const current = this.store.getSource(fresh.id);
        if (!current) throw new Error('素材已被删除');
        this.assertOperation();
        if (this.store.sourceHash(current) !== inputHash) throw new Error('素材图片已变化，请重新编译');
        current.compiled = true;
        this.store.saveSource(current);
        this.store.saveDraft(draft);
        this.store.appendLog('compile', fresh.title, [
          `素材 ID：${fresh.id}`, `提案：${draft.id}`, `页面：${draft.pages.length} 个`,
          ...(draft.contradictions.length ? [`发现 ${draft.contradictions.length} 处矛盾`] : []),
          typeof payload.log === 'string' ? truncate(payload.log, 200) : '',
        ]);
      });
      this.failedSources.delete(source.id);
      return draft.id;
    }, () => this.failedSources.set(source.id, Date.now()), { action: 'compile', params: { sourceId: source.id } });
    this.compiling.set(source.id, id);
    return id;
  }

  private async describeImages(source: WikiSource, task?: WikiTask): Promise<void> {
    if (!source.images.length || source.vision) return;
    if (!this.config.visionModel.trim()) {
      if (!source.text.trim()) throw new Error('纯图片素材需要先配置视觉模型');
      return;
    }
    const images = source.images.map(name => this.store.imageData(name)).filter((value): value is { mime: string; base64: string } => !!value);
    if (images.length !== source.images.length) throw new Error('素材图片附件缺失，请检查原始文件后重试');
    if (task) task.progress = '理解图片';
    const description = await this.complete([
      { role: 'system', content: '你是图片理解助手。提取图片中的文字、图表结构、关键数据与结论，输出简洁中文 Markdown。不要臆测图中不存在的信息。' },
      { role: 'user', content: `请描述这些来自「${source.title}」的图片，供后续笔记编译使用。` },
    ], 'vision', images);
    await withWriteLock(() => {
      const fresh = this.store.getSource(source.id);
      this.assertOperation();
      if (!fresh || this.store.sourceHash(fresh) !== this.store.sourceHash(source)) throw new Error('素材图片已变化，请重新编译');
      fresh.vision = truncate(description, 8000);
      fresh.hash = this.store.sourceHash(fresh);
      this.store.saveSource(fresh);
      // Keep the caller's object in sync so this compile actually uses the
      // description (and never overwrites it with the stale empty value).
      source.vision = fresh.vision;
      source.hash = fresh.hash;
    });
  }

  listDrafts(status?: WikiDraft['status']): WikiDraft[] {
    return this.store.listDrafts().filter(draft => !status || draft.status === status);
  }
  getDraft(id: string): WikiDraft | null { return this.store.getDraft(id); }
  async editDraftPage(id: string, slug: string, selected: boolean, body?: string, merge = false): Promise<void> {
    await withWriteLock(() => {
      this.assertActive();
      const draft = this.store.getDraft(id), item = draft?.pages.find(page => page.slug === slug);
      if (!draft || draft.status !== 'pending' || !item) throw new Error('提案已处理或页面不存在');
      if (body !== undefined) { if (!body.trim() || body.length > 30000) throw new Error('页面正文须为 1–30000 字符'); item.body = body; item.reviewEdited = true; }
      item.selected = selected;
      item.allowHumanMerge = merge;
      if (merge) { if (item.previous === null) throw new Error('合并页面缺少原始版本，请重新编译'); item.action = 'update'; item.reviewEdited = true; }
      this.store.saveDraft(draft);
    });
  }
  reviewDraft(id: string, action: 'approve' | 'reject', feedback?: string): string {
    const draft = this.store.getDraft(id);
    if (!draft) throw new Error('审阅提案不存在');
    if (draft.status !== 'pending') throw new Error('此提案已处理');
    return this.enqueue('compile', `${action === 'approve' ? '发布' : '拒绝'}提案`, async () => withWriteLock(() => {
      // Re-read inside the lock: the queue may have waited while another view
      // resolved this same proposal.
      const current = this.store.getDraft(id);
      this.assertOperation();
      if (!current || current.status !== 'pending') throw new Error('此提案已处理');
      if (action === 'reject') {
        current.status = 'rejected'; current.resolvedAt = now();
        if (feedback?.trim()) current.feedback.push(truncate(feedback.trim(), 500));
        this.store.saveDraft(current);
        if (current.sourceId) {
          const source = this.store.getSource(current.sourceId);
          if (source) { source.compiled = false; this.store.saveSource(source); }
        }
        this.store.appendLog('publish', '拒绝编译提案', [`提案：${id}`, ...(feedback ? [`反馈：${truncate(feedback, 200)}`] : []), '反馈会注入下次编译']);
        return { rejected: true };
      }
      this.assertOperation();
      return this.publishDraftSync(current);
    }), undefined, { action: 'review', params: { id, action, feedback: feedback ?? '' } });
  }
  private publishDraftSync(draft: WikiDraft): { published: string[]; skipped: string[]; skippedDetails: { slug: string; reason: string }[] } {
    this.assertOperation();
    if (draft.sourceId) {
      const source = this.store.getSource(draft.sourceId);
      if (!source || (draft.sourceHash && this.store.sourceHash(source) !== draft.sourceHash)) throw new Error('原始素材已删除或变化，请重新编译');
    }
    const published: string[] = [], skipped: string[] = [];
    const skippedDetails: { slug: string; reason: string }[] = [];
    const skip = (slug: string, reason: string) => { skipped.push(slug); skippedDetails.push({ slug, reason }); };
    const at = now();
    for (const item of draft.pages) {
      const current = this.store.getPage(item.slug);
      if (item.selected === false) { skip(item.slug, '审阅时未选中'); continue; }
      if (item.action === 'skip' || current?.humanEdited && !item.allowHumanMerge) { skip(item.slug, '人工编辑保护或缺少完整上下文，可逐页审阅后合并'); continue; }
      // Compare normalized documents: hand edits and concurrent publishes must
      // never be silently overwritten by a stale proposal. A "create" page that
      // someone else published meanwhile is skipped for the same reason.
      if (item.previous === null && current) { skip(item.slug, '同名页面已存在'); continue; }
      if (item.previous !== null && (!current || pageToDocument(current) !== item.previous)) { skip(item.slug, '页面在提案生成后发生变化，请重新编译'); continue; }
      this.store.snapshot(item.slug);
      const page: WikiPage = {
        slug: item.slug, title: item.title, summary: item.summary, kind: item.kind,
        sources: item.sources, evidence: item.evidence, tags: item.tags, body: item.body,
        humanEdited: !!item.reviewEdited, hash: '', createdAt: current?.createdAt ?? at, updatedAt: at,
      };
      page.hash = pageHash(page);
      this.store.savePage(page);
      published.push(item.slug);
    }
    draft.status = 'approved'; draft.resolvedAt = at;
    this.store.saveDraft(draft);
    this.store.saveIndex(buildIndex(this.store.listPages()));
    this.store.appendLog('publish', `发布「${draft.sourceTitle}」`, [
      `提案：${draft.id}`, `发布 ${published.length} 页：${published.join('、') || '无'}`,
      ...(skipped.length ? [`跳过（页面已被改动）：${skipped.join('、')}`] : []),
    ]);
    const meta = this.store.meta(); meta.revision++;
    this.store.saveMeta(meta);
    return { published, skipped, skippedDetails };
  }

  // ---- Query / lint / synthesis ----------------------------------------
  /** Bounded search for MCP clients: a snippet lets an Agent decide which page
   * to read before spending context on full Markdown. */
  searchSnippets(query: string, limit = 8): { slug: string; title: string; summary: string; kind: string; updatedAt: string; snippet: string }[] {
    const text = truncate(String(query ?? '').trim(), 500);
    return searchPages(text, this.store.listPages(), Math.max(1, Math.min(20, limit))).map(page => ({
      slug: page.slug, title: page.title, summary: page.summary, kind: page.kind,
      updatedAt: page.updatedAt, snippet: snippet(page.body, text),
    }));
  }
  /** Full page plus resolved provenance. Read-only, safe to expose over MCP. */
  readForAgent(slug: string) {
    const page = this.store.getPage(slug);
    if (!page) return null;
    const inbound = this.store.listPages().filter(other => other.slug !== slug && extractLinks(other.body).includes(slug)).map(other => other.slug);
    return {
      slug: page.slug, title: page.title, summary: page.summary, kind: page.kind, updatedAt: page.updatedAt,
      body: byteTruncate(page.body, 60 * 1024), backlinks: inbound.slice(0, 100),
      sources: page.sources, excerpts: resolveExcerpts(page, this.store.listSources(), 6),
    };
  }
  ask(question: string): string {
    const text = truncate(String(question ?? '').trim(), 2000);
    if (!text) throw new Error('问题不能为空');
    if (!this.modelReady()) throw new Error('请先配置文本模型和鉴权方式');
    return this.enqueue('ask', `提问「${truncate(text, 30)}」`, async () => {
      const pages = searchPages(text, this.store.listPages(), Math.max(1, Math.min(20, this.config.maxContextPages)));
      const answer = byteTruncate(await this.complete(queryMessages(text, pages, this.schema(), resolveSkill(this.allSkills(), 'query'))), 60 * 1024);
      this.assertOperation();
      const citations = [...new Set(extractLinks(answer))].filter(slug => pages.some(page => page.slug === slug));
      const record: WikiAnswer = {
        question: text, answer, citations, pages: pages.map(page => page.slug),
        evidence: this.answerEvidence(citations), model: this.model().model, at: now(),
      };
      await withWriteLock(() => {
        const meta = this.store.meta();
        this.assertOperation();
        this.workspace.saveAnswer(record);
        meta.answers = [record, ...meta.answers].slice(0, 20);
        this.store.saveMeta(meta);
        this.store.appendLog('query', text, [`引用页面：${citations.join('、') || '无'}`, `检索页面：${pages.length} 个`]);
      });
      return record;
    }, undefined, { action: 'ask', params: { question: text } });
  }
  private answerEvidence(citations: string[]): SourceExcerpt[] {
    const sources = this.store.listSources();
    const out: SourceExcerpt[] = [];
    for (const slug of citations.slice(0, 10)) {
      const page = this.store.getPage(slug);
      if (!page) continue;
      for (const excerpt of resolveExcerpts(page, sources, 2)) {
        if (!out.some(item => item.sourceId === excerpt.sourceId && item.quote === excerpt.quote)) out.push(excerpt);
        if (out.length >= 8) return out;
      }
    }
    return out;
  }
  /** Resolve a page's quotes against the immutable sources. Used by both the
   * sandboxed view and MCP tools, so Agents see the same provenance as humans. */
  excerpts(slug: string): SourceExcerpt[] {
    const page = this.store.getPage(slug);
    return page ? resolveExcerpts(page, this.store.listSources(), 6) : [];
  }
  answers(): WikiAnswer[] {
    return this.workspace.answers().map(answer => ({ ...answer, evidence: Array.isArray(answer.evidence) ? answer.evidence : [] }));
  }
  archiveAnswer(question: string, answer: string, citations: string[], evidence: SourceEvidence[] = []): string {
    return this.enqueue('archive', '归档回答', () => this.saveAnswer(question, answer, citations, evidence), undefined, { action: 'archive', params: { question, answer, citations, evidence } });
  }
  async saveAnswer(question: string, answer: string, citations: string[], evidence: Pick<SourceExcerpt, 'sourceId' | 'quote'>[] = []): Promise<WikiPage> {
    const text = String(answer ?? '');
    if (Buffer.byteLength(text) > 60 * 1024) throw new Error('回答过长，请拆分后归档');
    if (!text.trim()) throw new Error('回答内容为空');
    let generated: Record<string, unknown> | null = null;
    if (this.modelReady()) {
      try {
        generated = parseJsonResponse(await this.complete(synthesizeMessages({ question, answer: text, citations }, this.schema(), resolveSkill(this.allSkills(), 'synthesize')), 'text', undefined, 20_000));
      } catch { /* Offline fallback still archives the answer as a page. */ }
    }
    const title = truncate(String(generated?.title ?? `问答：${truncate(question, 40)}`), 160);
    const body = String(generated?.body ?? `> 由问题「${question}」归档。\n\n${text}\n\n## 引用\n${citations.map(slug => `- [[${slug}]]`).join('\n') || '（无）'}`);
    this.assertOperation();
    return this.savePage({
      slug: slugify(title), title, createOnly: true, summary: truncate(String(generated?.summary ?? `由「${truncate(question, 40)}」生成的归档`), 400),
      body, kind: (generated?.kind as WikiPage['kind']) ?? 'note',
      evidence: evidence.slice(0, 8).map(item => ({ sourceId: item.sourceId, quote: item.quote })),
      tags: Array.isArray(generated?.tags) ? generated.tags.filter((value): value is string => typeof value === 'string').slice(0, 20) : ['问答归档'],
    }, () => this.assertOperation());
  }
  lint(): string {
    return this.enqueue('lint', '知识库体检', async () => {
      const pages = this.store.listPages();
      const local = lintWiki(pages);
      let model: Partial<WikiLint> = {};
      if (this.modelReady() && pages.length) {
        try {
          const reply = parseJsonResponse(await this.complete(lintMessages(pages, this.schema(), resolveSkill(this.allSkills(), 'lint'))));
          model = {
            contradictions: Array.isArray(reply.contradictions) ? reply.contradictions.flatMap(item => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? [{ page: String((item as { page?: unknown }).page ?? ''), text: truncate((item as { text: string }).text, 300) }] : []).slice(0, 50) : [],
            suggestions: Array.isArray(reply.suggestions) ? reply.suggestions.filter((value): value is string => typeof value === 'string').slice(0, 8).map(value => truncate(value, 300)) : [],
            // Orphans and broken links are computed deterministically from pages.
          };
        } catch (error) { model = { suggestions: ['模型体检不可用，已使用本地结构检查：' + String(error instanceof Error ? error.message : error).slice(0, 120)] }; }
      }
      const result: WikiLint = { ...local, ...model, at: now(), suggestions: [...(model.suggestions ?? []), ...local.suggestions].slice(0, 12) };
      this.assertOperation();
      await withWriteLock(() => {
        this.assertOperation();
        const meta = this.store.meta(); meta.lint = result; meta.lastLint = result.at;
        this.store.saveMeta(meta);
        this.store.appendLog('lint', '知识库体检', [
          `孤立页：${result.orphans.length}`, `断链：${result.brokenLinks.length}`,
          `矛盾：${result.contradictions.length}`, `建议：${result.suggestions.length}`,
        ]);
      });
      return result;
    }, undefined, { action: 'lint', params: {} });
  }
  lintResult(): WikiLint | null { return this.store.meta().lint; }
  indexText(): string { return this.store.index(); }
  logText(): string { return this.store.log().slice(-60_000); }

  /** Used by tests and by a manual "rebuild navigation" action. */
  async rebuildIndex(): Promise<string> {
    return withWriteLock(() => {
      const text = buildIndex(this.store.listPages());
      this.store.saveIndex(text);
      return text;
    });
  }
}
