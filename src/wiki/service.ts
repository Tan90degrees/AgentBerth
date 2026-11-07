import { randomUUID } from 'node:crypto';
import {
  buildIndex, byteTruncate, draftPages, extractLinks, lintWiki, pageHash, pageToDocument,
  parseDocument, parseJsonResponse, searchPages, skillFromDocument, skillToDocument,
  slugify, truncate, validateSkillName,
} from './core';
import { chat, maskedKey, type ChatMessage } from './llm';
import {
  BUILTIN_SKILLS, DEFAULT_SCHEMA, compileMessages, ingestMessages, lintMessages,
  queryMessages, resolveSkill, synthesizeMessages,
} from './prompts';
import { withWriteLock, type WikiStore } from './store';
import type {
  WikiAnswer, WikiConfig, WikiDraft, WikiLint, WikiPage, WikiSkill, WikiSource, WikiStatus, WikiTask,
} from './types';

export interface ServiceOptions {
  store: WikiStore;
  config: WikiConfig;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  publish?: () => void;
}

const now = () => new Date().toISOString();
/** After a failed auto-compile, wait before retrying the same source instead of
 * paying for a model call every 60 seconds forever. Manual retry is unaffected. */
const COMPILE_RETRY_MS = 5 * 60_000;

/** Everything the UI can do lives here; plugin.ts is only a thin Cordis adapter.
 * Long model calls run in a background queue so no RPC ever blocks the daemon. */
export class WikiService {
  readonly store: WikiStore;
  readonly config: WikiConfig;
  private readonly signal: AbortSignal;
  private readonly fetchImpl?: typeof fetch;
  private readonly publish?: () => void;
  private readonly tasks = new Map<string, WikiTask>();
  private readonly queue: { id: string; run: (task: WikiTask) => Promise<unknown>; onError?: () => void }[] = [];
  private draining = false;
  private lastTickLint = 0;
  private readonly failedSources = new Map<string, number>();

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.signal = options.signal;
    this.fetchImpl = options.fetchImpl;
    this.publish = options.publish;
    if (!this.store.schema().trim()) this.store.saveSchema(DEFAULT_SCHEMA);
    if (!this.store.index().trim()) this.store.saveIndex(buildIndex([]));
  }

  // ---- Model access -----------------------------------------------------
  private key(): string { return this.store.credentials().apiKey; }
  private model(kind: 'text' | 'vision' = 'text') {
    return {
      baseURL: this.config.baseURL,
      apiKey: this.key(),
      model: kind === 'vision' && this.config.visionModel.trim() ? this.config.visionModel : this.config.textModel,
      fetchImpl: this.fetchImpl,
      signal: this.signal,
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
    const pages = this.store.listPages();
    const links = new Set(pages.flatMap(page => extractLinks(page.body))).size;
    const meta = this.store.meta();
    return {
      pages: pages.length,
      sources: this.store.listSources().length,
      pendingDrafts: this.store.listDrafts().filter(draft => draft.status === 'pending').length,
      skills: this.allSkills().length,
      links,
      orphans: (meta.lint?.orphans.length ?? 0) || lintWiki(pages).orphans.length,
      model: {
        baseURL: this.config.baseURL, textModel: this.config.textModel, visionModel: this.config.visionModel,
        keyConfigured: !!this.key(), keyHint: maskedKey(this.key()),
      },
      automation: { autoCompile: this.config.autoCompile, autoApprove: this.config.autoApprove, lintMinutes: this.config.lintMinutes },
      lastLint: meta.lastLint,
      tasks: [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20),
      ready: !!this.key() && !!this.config.textModel.trim(),
    };
  }
  taskStatus(id: string): WikiTask | null { return this.tasks.get(id) ?? null; }

  // ---- Background queue -------------------------------------------------
  private enqueue(kind: WikiTask['kind'], label: string, run: (task: WikiTask) => Promise<unknown>, onError?: () => void): string {
    const task: WikiTask = { id: randomUUID(), kind, label, status: 'queued', progress: '排队中', startedAt: now() };
    this.tasks.set(task.id, task);
    this.queue.push({ id: task.id, run, onError });
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
        if (this.signal.aborted) { task.status = 'failed'; task.error = '插件已停止'; task.finishedAt = now(); continue; }
        task.status = 'running'; task.progress = '正在处理'; task.startedAt = now();
        try { task.result = await job.run(task); task.status = 'done'; task.progress = '已完成'; }
        catch (error) {
          task.status = 'failed';
          task.error = String(error instanceof Error ? error.message : error).slice(0, 500);
          task.progress = '失败';
          job.onError?.();
        }
        task.finishedAt = now();
        this.publish?.();
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
        !source.compiled && Date.now() - (this.failedSources.get(source.id) ?? 0) > COMPILE_RETRY_MS);
      if (pending && this.key()) void this.compile(pending.id);
    }
    const interval = Math.max(0, this.config.lintMinutes) * 60_000;
    if (interval > 0 && this.key() && Date.now() - this.lastTickLint >= interval && !this.queued('lint')) {
      this.lastTickLint = Date.now();
      void this.lint();
    }
    for (const [id, task] of this.tasks) if (['done', 'failed'].includes(task.status) && task.finishedAt && Date.now() - Date.parse(task.finishedAt) > 3_600_000) this.tasks.delete(id);
  }

  // ---- Raw sources ------------------------------------------------------
  listSources(): WikiSource[] { return this.store.listSources(); }
  getSource(id: string): WikiSource | null { return this.store.getSource(id); }
  async addSource(input: { title: string; text: string; images?: { mime: string; base64: string }[] }): Promise<WikiSource> {
    const title = truncate(String(input.title ?? '').trim() || '未命名素材', 160);
    const text = truncate(String(input.text ?? ''), 200_000);
    if (!text.trim() && !(input.images?.length)) throw new Error('素材内容不能为空');
    const images = (input.images ?? []).slice(0, 8).map(image => this.store.addImage(image.mime, image.base64));
    const source: WikiSource = { id: randomUUID(), title, text, images, vision: '', compiled: false, hash: '', createdAt: now() };
    source.hash = this.store.sourceHash(source);
    await withWriteLock(() => { this.store.saveSource(source); this.store.appendLog('ingest', title, [`素材 ID：${source.id}`, `${text.length} 字，${images.length} 张图片`, '等待编译为审阅提案']); });
    return source;
  }
  async deleteSource(id: string): Promise<void> {
    await withWriteLock(() => { this.store.deleteSource(id); this.store.appendLog('edit', '删除原始素材', [`素材 ID：${id}`, '已编译的 wiki 页面保留']); });
  }
  async addImage(sourceId: string, mime: string, base64: string): Promise<{ name: string; images: number }> {
    return withWriteLock(() => {
      const source = this.store.getSource(sourceId);
      if (!source) throw new Error('素材不存在');
      if (source.images.length >= 8) throw new Error('单个素材最多 8 张图片');
      const name = this.store.addImage(mime, base64);
      source.images.push(name);
      source.compiled = false;
      source.hash = this.store.sourceHash(source);
      this.store.saveSource(source);
      return { name, images: source.images.length };
    });
  }

  // ---- Wiki pages -------------------------------------------------------
  listPages(): WikiPage[] { return this.store.listPages(); }
  getPage(slug: string): WikiPage | null { return this.store.getPage(slug); }
  async savePage(input: { slug: string; title?: string; summary?: string; body?: string; kind?: WikiPage['kind']; tags?: string[] }): Promise<WikiPage> {
    const slug = slugify(input.slug);
    if (!slug || slug === 'untitled') throw new Error('页面名称无效');
    return withWriteLock(() => {
      const previous = this.store.getPage(slug);
      const at = now();
      const page: WikiPage = {
        slug, title: truncate(String(input.title ?? previous?.title ?? slug), 160) || slug,
        summary: truncate(String(input.summary ?? previous?.summary ?? ''), 400),
        kind: input.kind ?? previous?.kind ?? 'note',
        sources: previous?.sources ?? [], tags: input.tags ?? previous?.tags ?? [],
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
      this.store.deletePage(slug);
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
    if (!this.key()) throw new Error('请先在「设置」中填写 API Key');
    return this.enqueue('compile', `编译「${source.title}」`, async task => {
      const fresh = this.store.getSource(source.id);
      if (!fresh) throw new Error('素材已被删除');
      await this.describeImages(fresh, task);
      const schema = this.schema(), skills = this.allSkills();
      task.progress = '抽取概念';
      const ingested = await this.complete(ingestMessages(fresh, schema, resolveSkill(skills, 'ingest'), this.store.index(), fresh.vision));
      if (this.signal.aborted) throw new Error('编译已取消');
      const feedback = this.store.listDrafts().filter(draft => draft.sourceId === fresh.id && draft.status === 'rejected').flatMap(draft => draft.feedback).slice(-5);
      task.progress = '生成页面提案';
      const compiled = await this.complete(compileMessages(fresh, ingested, this.store.listPages(), schema, resolveSkill(skills, 'compile'), feedback));
      const payload = parseJsonResponse(compiled);
      const draft: WikiDraft = {
        id: randomUUID(), sourceId: fresh.id, sourceTitle: fresh.title, createdAt: now(),
        model: this.model().model, summary: typeof payload.summary === 'string' ? truncate(payload.summary, 400) : '编译完成',
        pages: draftPages(payload.pages, this.store.listPages(), fresh.id),
        contradictions: Array.isArray(payload.contradictions) ? payload.contradictions.filter((value): value is string => typeof value === 'string').slice(0, 20).map(value => truncate(value, 300)) : [],
        feedback: [], status: 'pending',
      };
      if (!draft.pages.length) throw new Error('模型没有生成任何可用页面，可在 Skill 中调整编译要求后重试');
      await withWriteLock(() => {
        // Re-read inside the lock: images/vision may have been written while the
        // model was running, and the in-memory `fresh` must not overwrite them.
        const current = this.store.getSource(fresh.id);
        if (!current) throw new Error('素材已被删除');
        current.compiled = true;
        this.store.saveSource(current);
        this.store.saveDraft(draft);
        this.store.appendLog('compile', fresh.title, [
          `素材 ID：${fresh.id}`, `提案：${draft.id}`, `页面：${draft.pages.length} 个`,
          ...(draft.contradictions.length ? [`发现 ${draft.contradictions.length} 处矛盾`] : []),
          typeof payload.log === 'string' ? truncate(payload.log, 200) : '',
        ]);
      });
      if (this.config.autoApprove) return this.publishDraft(draft.id);
      return draft.id;
    }, () => this.failedSources.set(source.id, Date.now()));
  }

  private async describeImages(source: WikiSource, task?: WikiTask): Promise<void> {
    if (!source.images.length || !this.config.visionModel.trim() || source.vision) return;
    const images = source.images.map(name => this.store.imageData(name)).filter((value): value is { mime: string; base64: string } => !!value);
    if (!images.length) return;
    if (task) task.progress = '理解图片';
    const description = await this.complete([
      { role: 'system', content: '你是图片理解助手。提取图片中的文字、图表结构、关键数据与结论，输出简洁中文 Markdown。不要臆测图中不存在的信息。' },
      { role: 'user', content: `请描述这些来自「${source.title}」的图片，供后续笔记编译使用。` },
    ], 'vision', images);
    await withWriteLock(() => {
      const fresh = this.store.getSource(source.id);
      if (!fresh) return;
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
  reviewDraft(id: string, action: 'approve' | 'reject', feedback?: string): string {
    const draft = this.store.getDraft(id);
    if (!draft) throw new Error('审阅提案不存在');
    if (draft.status !== 'pending') throw new Error('此提案已处理');
    return this.enqueue('compile', `${action === 'approve' ? '发布' : '拒绝'}提案`, async () => withWriteLock(() => {
      // Re-read inside the lock: the queue may have waited while another view
      // resolved this same proposal.
      const current = this.store.getDraft(id);
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
      return this.publishDraftSync(current);
    }));
  }
  private publishDraft(id: string): Promise<unknown> {
    const draft = this.store.getDraft(id);
    return draft ? withWriteLock(() => this.publishDraftSync(draft)) : Promise.resolve(null);
  }
  private publishDraftSync(draft: WikiDraft): { published: string[]; skipped: string[] } {
    const published: string[] = [], skipped: string[] = [];
    const at = now();
    for (const item of draft.pages) {
      const current = this.store.getPage(item.slug);
      if (current?.humanEdited) { skipped.push(item.slug); continue; }
      // Compare normalized documents: hand edits and concurrent publishes must
      // never be silently overwritten by a stale proposal. A "create" page that
      // someone else published meanwhile is skipped for the same reason.
      if (item.previous === null && current) { skipped.push(item.slug); continue; }
      if (item.previous !== null && (!current || pageToDocument(current) !== item.previous)) { skipped.push(item.slug); continue; }
      this.store.snapshot(item.slug);
      const page: WikiPage = {
        slug: item.slug, title: item.title, summary: item.summary, kind: item.kind,
        sources: item.sources, tags: item.tags, body: item.body,
        humanEdited: false, hash: '', createdAt: current?.createdAt ?? at, updatedAt: at,
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
    return { published, skipped };
  }

  // ---- Query / lint / synthesis ----------------------------------------
  ask(question: string): string {
    const text = truncate(String(question ?? '').trim(), 2000);
    if (!text) throw new Error('问题不能为空');
    if (!this.key()) throw new Error('请先在「设置」中填写 API Key');
    return this.enqueue('ask', `提问「${truncate(text, 30)}」`, async () => {
      const pages = searchPages(text, this.store.listPages(), Math.max(1, Math.min(20, this.config.maxContextPages)));
      const answer = byteTruncate(await this.complete(queryMessages(text, pages, this.schema(), resolveSkill(this.allSkills(), 'query'))), 60 * 1024);
      const citations = [...new Set(extractLinks(answer))].filter(slug => !!this.store.getPage(slug));
      const record: WikiAnswer = { question: text, answer, citations, pages: pages.map(page => page.slug), model: this.model().model, at: now() };
      await withWriteLock(() => {
        const meta = this.store.meta();
        meta.answers = [record, ...meta.answers].slice(0, 20);
        this.store.saveMeta(meta);
        this.store.appendLog('query', text, [`引用页面：${citations.join('、') || '无'}`, `检索页面：${pages.length} 个`]);
      });
      return record;
    });
  }
  answers(): WikiAnswer[] { return this.store.meta().answers; }
  async saveAnswer(question: string, answer: string, citations: string[]): Promise<WikiPage> {
    const text = truncate(String(answer ?? ''), 20_000);
    if (!text.trim()) throw new Error('回答内容为空');
    let generated: Record<string, unknown> | null = null;
    if (this.key()) {
      try {
        generated = parseJsonResponse(await this.complete(synthesizeMessages({ question, answer: text, citations }, this.schema(), resolveSkill(this.allSkills(), 'synthesize')), 'text', undefined, 20_000));
      } catch { /* Offline fallback still archives the answer as a page. */ }
    }
    const title = truncate(String(generated?.title ?? `问答：${truncate(question, 40)}`), 160);
    const body = String(generated?.body ?? `> 由问题「${question}」归档。\n\n${text}\n\n## 引用\n${citations.map(slug => `- [[${slug}]]`).join('\n') || '（无）'}`);
    return this.savePage({
      slug: slugify(title), title, summary: truncate(String(generated?.summary ?? `由「${truncate(question, 40)}」生成的归档`), 400),
      body, kind: (generated?.kind as WikiPage['kind']) ?? 'note',
      tags: Array.isArray(generated?.tags) ? generated.tags.filter((value): value is string => typeof value === 'string').slice(0, 20) : ['问答归档'],
    });
  }
  lint(): string {
    return this.enqueue('lint', '知识库体检', async () => {
      const pages = this.store.listPages();
      const local = lintWiki(pages);
      let model: Partial<WikiLint> = {};
      if (this.key() && pages.length) {
        try {
          const reply = parseJsonResponse(await this.complete(lintMessages(pages, this.schema(), resolveSkill(this.allSkills(), 'lint'))));
          model = {
            contradictions: Array.isArray(reply.contradictions) ? reply.contradictions.flatMap(item => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? [{ page: String((item as { page?: unknown }).page ?? ''), text: truncate((item as { text: string }).text, 300) }] : []).slice(0, 50) : [],
            suggestions: Array.isArray(reply.suggestions) ? reply.suggestions.filter((value): value is string => typeof value === 'string').slice(0, 8).map(value => truncate(value, 300)) : [],
            orphans: Array.isArray(reply.orphans) ? reply.orphans.filter((value): value is string => typeof value === 'string').slice(0, 50) : [],
          };
        } catch (error) { model = { suggestions: ['模型体检不可用，已使用本地结构检查：' + String(error instanceof Error ? error.message : error).slice(0, 120)] }; }
      }
      const result: WikiLint = { ...local, ...model, at: now(), suggestions: [...(model.suggestions ?? []), ...local.suggestions].slice(0, 12) };
      await withWriteLock(() => {
        const meta = this.store.meta(); meta.lint = result; meta.lastLint = result.at;
        this.store.saveMeta(meta);
        this.store.appendLog('lint', '知识库体检', [
          `孤立页：${result.orphans.length}`, `断链：${result.brokenLinks.length}`,
          `矛盾：${result.contradictions.length}`, `建议：${result.suggestions.length}`,
        ]);
      });
      return result;
    });
  }
  lintResult(): WikiLint | null { return this.store.meta().lint; }
  indexText(): string { return this.store.index(); }
  logText(): string { return truncate(this.store.log(), 60_000); }

  /** Used by tests and by a manual "rebuild navigation" action. */
  async rebuildIndex(): Promise<string> {
    return withWriteLock(() => {
      const text = buildIndex(this.store.listPages());
      this.store.saveIndex(text);
      return text;
    });
  }
}
