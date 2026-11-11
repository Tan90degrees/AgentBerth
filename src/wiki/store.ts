import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logLine, pageHash, pageFromDocument, pageToDocument, skillFromDocument, skillToDocument, truncate, validateSkillName, slugify } from './core';
import type { WikiAnswer, WikiDraft, WikiLint, WikiPage, WikiSkill, WikiSource } from './types';

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export interface WikiMeta {
  lastLint: string | null;
  lint: WikiLint | null;
  answers: WikiAnswer[];
  revision: number;
}

const emptyMeta = (): WikiMeta => ({ lastLint: null, lint: null, answers: [], revision: 0 });

/** All writes go through a single in-process queue: the daemon may receive a
 * review, a timer tick and a manual edit at the same time. */
let writing: Promise<unknown> = Promise.resolve();
function serialize<T>(action: () => T): Promise<T> {
  const task = writing.catch(() => undefined).then(action);
  writing = task.catch(() => undefined);
  return task;
}

export class WikiStore {
  readonly root: string;
  revision = 0;
  invalidate(): void { this.cache.clear(); this.revision++; }
  private readonly cache = new Map<string, { stamp: string; value: unknown }>();
  private cached<T>(file: string, read: () => T): T {
    const info = statSync(file);
    const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
    const hit = this.cache.get(file);
    if (hit?.stamp === stamp) return structuredClone(hit.value) as T;
    const value = read();
    if (this.cache.size >= 2000) this.cache.delete(this.cache.keys().next().value!);
    if (info.size <= 1024 * 1024) this.cache.set(file, { stamp, value });
    return structuredClone(value);
  }
  private readonly wikiDir: string;
  private readonly rawDir: string;
  private readonly assetDir: string;
  private readonly skillDir: string;
  private readonly draftDir: string;
  private readonly historyDir: string;

  constructor(root: string) {
    this.root = root;
    this.wikiDir = path.join(root, 'wiki');
    this.rawDir = path.join(root, 'raw');
    this.assetDir = path.join(root, 'raw', 'assets');
    this.skillDir = path.join(root, 'skills');
    this.draftDir = path.join(root, 'drafts');
    this.historyDir = path.join(root, 'history');
    for (const dir of [root, this.wikiDir, this.rawDir, this.assetDir, this.skillDir, this.draftDir, this.historyDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(dir: string, name: string, suffix: string): string {
    const safe = path.basename(name);
    if (safe !== name || name.includes('..') || /[\\/\x00]/.test(name)) throw new Error('名称无效');
    return path.join(dir, safe + suffix);
  }
  private read(file: string): string { return existsSync(file) ? readFileSync(file, 'utf8') : ''; }
  private readJson<T>(file: string, fallback: T): T {
    if (!existsSync(file)) return fallback;
    try { return this.cached(file, () => JSON.parse(readFileSync(file, 'utf8')) as T); } catch { return fallback; }
  }
  private write(file: string, value: string, mode?: number): void {
    this.cache.delete(file); this.revision++;
    const tmp = file + '.' + randomUUID().slice(0, 8) + '.tmp';
    writeFileSync(tmp, value, { encoding: 'utf8', mode: mode ?? 0o600 });
    try { renameSync(tmp, file); }
    catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      writeFileSync(file, value, { encoding: 'utf8', mode: mode ?? 0o600 });
    }
  }
  private writeJson<T>(file: string, value: T, mode?: number): void { this.write(file, JSON.stringify(value, null, 2), mode); }

  // ---- Meta, index, log -------------------------------------------------
  meta(): WikiMeta { return this.readJson(path.join(this.root, 'meta.json'), emptyMeta()); }
  saveMeta(value: WikiMeta): void { this.writeJson(path.join(this.root, 'meta.json'), value); }
  index(): string { return this.read(path.join(this.root, 'index.md')); }
  saveIndex(value: string): void { this.write(path.join(this.root, 'index.md'), value); }
  log(): string { return this.read(path.join(this.root, 'log.md')); }
  appendLog(kind: Parameters<typeof logLine>[0], title: string, details: string[]): void {
    appendFileSync(path.join(this.root, 'log.md'), logLine(kind, title, details) + '\n', 'utf8');
  }
  schema(): string { return this.read(path.join(this.root, 'schema.md')); }
  saveSchema(value: string): void { this.write(path.join(this.root, 'schema.md'), truncate(String(value ?? ''), 20000)); }

  // ---- Credentials (never part of the plugin manifest config) -----------
  credentials(): { apiKey: string } { return this.readJson(path.join(this.root, 'credentials.json'), { apiKey: '' }); }
  saveCredentials(apiKey: string): void { this.writeJson(path.join(this.root, 'credentials.json'), { apiKey }, 0o600); }
  clearCredentials(): void { this.revision++; rmSync(path.join(this.root, 'credentials.json'), { force: true }); }

  // ---- Sources (immutable raw layer) ------------------------------------
  listSources(): WikiSource[] {
    return readdirSync(this.rawDir).filter(name => name.endsWith('.json'))
      .map(name => this.readJson<WikiSource | null>(path.join(this.rawDir, name), null))
      .filter((item): item is WikiSource => !!item && typeof item.id === 'string')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  getSource(id: string): WikiSource | null {
    return this.readJson<WikiSource | null>(this.file(this.rawDir, id, '.json'), null);
  }
  saveSource(source: WikiSource): void {
    this.writeJson(this.file(this.rawDir, source.id, '.json'), source);
  }
  deleteSource(id: string): void {
    this.revision++;
    const source = this.getSource(id);
    rmSync(this.file(this.rawDir, id, '.json'), { force: true });
    for (const image of source?.images ?? []) rmSync(this.file(this.assetDir, image, ''), { force: true });
  }
  hideSource(id: string): void { rmSync(this.file(this.rawDir, id, '.json'), { force: true }); this.invalidate(); }
  addDocument(bytes: Uint8Array): string {
    const name = randomUUID() + '.pdf'; writeFileSync(path.join(this.assetDir, name), bytes, { mode: 0o600 }); return name;
  }
  assetFile(name: string): string { return this.file(this.assetDir, name, ''); }
  assetBytes(name: string): Uint8Array { return new Uint8Array(readFileSync(this.file(this.assetDir, name, ''))); }
  addImage(mime: string, base64: string): string {
    const ext = IMAGE_TYPES[mime];
    if (!ext) throw new Error('图片仅支持 PNG / JPEG / WebP / GIF');
    const buffer = Buffer.from(String(base64 ?? ''), 'base64');
    if (!buffer.length) throw new Error('图片为空');
    const name = randomUUID() + '.' + ext;
    writeFileSync(path.join(this.assetDir, name), buffer, { mode: 0o600 });
    return name;
  }
  imageData(name: string): { mime: string; base64: string } | null {
    const ext = path.extname(name).slice(1);
    const mime = Object.keys(IMAGE_TYPES).find(key => IMAGE_TYPES[key] === ext);
    const file = this.file(this.assetDir, name, '');
    if (!mime || !existsSync(file)) return null;
    return { mime, base64: readFileSync(file).toString('base64') };
  }
  sourceHash(source: Pick<WikiSource, 'title' | 'text' | 'images' | 'vision'> & { document?: { hash?: string } }): string {
    const identity: (string | string[])[] = [source.text, source.images]; if (source.document?.hash) identity.push(source.document.hash);
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32);
  }

  // ---- Wiki pages -------------------------------------------------------
  listPages(): WikiPage[] {
    return readdirSync(this.wikiDir).filter(name => name.endsWith('.md')).map(name => {
      const slug = name.slice(0, -3), file = path.join(this.wikiDir, name);
      return this.cached(file, () => pageFromDocument(slug, readFileSync(file, 'utf8'), new Date(statSync(file).mtimeMs).toISOString()));
    }).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  }
  getPage(slug: string): WikiPage | null {
    const file = this.file(this.wikiDir, slugify(slug), '.md');
    if (!existsSync(file)) return null;
    return this.cached(file, () => pageFromDocument(slugify(slug), readFileSync(file, 'utf8'), new Date(statSync(file).mtimeMs).toISOString()));
  }
  pageText(slug: string): string { return this.read(this.file(this.wikiDir, slugify(slug), '.md')); }
  savePage(page: WikiPage): void { this.write(this.file(this.wikiDir, page.slug, '.md'), pageToDocument(page)); }
  deletePage(slug: string): void {
    this.revision++;
    this.snapshot(slug);
    rmSync(this.file(this.wikiDir, slugify(slug), '.md'), { force: true });
  }
  snapshot(slug: string): void {
    const text = this.pageText(slug);
    if (!text) return;
    let stamp = Date.now();
    while (existsSync(this.file(this.historyDir, `${slugify(slug)}.${stamp}`, '.md'))) stamp++;
    this.write(this.file(this.historyDir, `${slugify(slug)}.${stamp}`, '.md'), text);
    const previous = readdirSync(this.historyDir).filter(name => name.startsWith(slugify(slug) + '.')).sort().reverse();
    for (const name of previous.slice(10)) rmSync(path.join(this.historyDir, name), { force: true });
  }
  history(slug: string): { at: string; name: string }[] {
    return readdirSync(this.historyDir).filter(name => name.startsWith(slugify(slug) + '.') && name.endsWith('.md'))
      .map(name => ({ at: new Date(Number(name.split('.').at(-2))).toISOString(), name }))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  }
  revertPage(slug: string, name: string): WikiPage | null {
    if (!this.history(slug).some(item => item.name === name)) throw new Error('历史版本不属于此页面');
    const file = this.file(this.historyDir, path.basename(name, '.md'), '.md');
    if (!file.startsWith(this.historyDir) || !existsSync(file)) throw new Error('历史版本不存在');
    const parsed = pageFromDocument(slugify(slug), readFileSync(file, 'utf8'), new Date().toISOString());
    this.snapshot(slug);
    parsed.humanEdited = true; parsed.hash = pageHash(parsed); parsed.updatedAt = new Date().toISOString();
    this.savePage(parsed);
    return parsed;
  }

  // ---- Skills (Fabric-style Markdown templates) --------------------------
  listSkills(): WikiSkill[] {
    return readdirSync(this.skillDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
      const file = path.join(this.skillDir, entry.name, 'SKILL.md');
      if (!existsSync(file)) return [];
      return [skillFromDocument(entry.name, readFileSync(file, 'utf8'), false, new Date(statSync(file).mtimeMs).toISOString())];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  skillText(name: string): string | null {
    validateSkillName(name);
    const file = path.join(this.skillDir, name, 'SKILL.md');
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  saveSkill(skill: WikiSkill): void {
    validateSkillName(skill.name);
    mkdirSync(path.join(this.skillDir, skill.name), { recursive: true, mode: 0o700 });
    this.write(path.join(this.skillDir, skill.name, 'SKILL.md'), skillToDocument(skill));
  }
  deleteSkill(name: string): void {
    validateSkillName(name);
    rmSync(path.join(this.skillDir, name), { recursive: true, force: true });
  }

  // ---- Drafts (reviewable compile proposals) ----------------------------
  listDrafts(): WikiDraft[] {
    return readdirSync(this.draftDir).filter(name => name.endsWith('.json'))
      .map(name => this.readJson<WikiDraft | null>(path.join(this.draftDir, name), null))
      .filter((item): item is WikiDraft => !!item && typeof item.id === 'string')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  getDraft(id: string): WikiDraft | null { return this.readJson<WikiDraft | null>(this.file(this.draftDir, id, '.json'), null); }
  saveDraft(draft: WikiDraft): void { this.writeJson(this.file(this.draftDir, draft.id, '.json'), draft); }
  deleteDraft(id: string): void { rmSync(this.file(this.draftDir, id, '.json'), { force: true }); }
}

/** Public entry point used by the service; keeps disk writes ordered. */
export const withWriteLock = serialize;
