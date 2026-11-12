import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { byteTruncate, pageHash, slugify } from './core';
import type { WikiAnswer, WikiPage, WikiSource } from './types';
import type { WikiStore } from './store';

export interface EditorDraft { key: string; fields: Record<string, string>; at: string; }
export interface TrashEntry { id: string; kind: 'page' | 'source'; title: string; at: string; page?: WikiPage; source?: WikiSource; }
const allowed = /^(?:wiki\/[^/]+\.md|raw\/[^/]+\.json|raw\/assets\/[^/]+\.(?:png|jpg|jpeg|webp|gif|pdf)|skills\/[a-z0-9-]+\/SKILL\.md|(?:drafts|trash|answers|editor-drafts)\/[^/]+\.json|history\/[^/]+\.md|(?:schema|index|log)\.md|(?:meta|tasks)\.json)$/;
const safePath = (name: string) => name.length <= 240 && !name.includes('..') && !/[\\\x00<>:"|?*]/.test(name) && allowed.test(name);
const MAX_ARCHIVE = 64 * 1024 * 1024;

/** User state and portable data. Credentials, host settings and inbox watch
 * folders are excluded. Mutations run under the shared store write lock. */
export class WikiWorkspace {
  private readonly cache = new Map<string, { stamp: string; value: unknown }>();
  constructor(readonly store: WikiStore) {}
  private folder(name: string): string { const dir = path.join(this.store.root, name); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
  private json<T>(file: string, fallback: T): T { try { const info = statSync(file), stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`, cached = this.cache.get(file); if (cached?.stamp === stamp) return structuredClone(cached.value) as T; const value = JSON.parse(readFileSync(file, 'utf8')); if (this.cache.size >= 2000) this.cache.delete(this.cache.keys().next().value!); if (info.size <= 1024 * 1024) this.cache.set(file, { stamp, value }); return structuredClone(value) as T; } catch { return fallback; } }
  private write(file: string, value: string | Uint8Array): void {
    this.cache.delete(file);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID() + '.tmp'; writeFileSync(temp, value, { mode: 0o600 });
    try { renameSync(temp, file); } catch (error) { if (!['EPERM', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; writeFileSync(file, value, { mode: 0o600 }); } finally { rmSync(temp, { force: true }); }
    if (/^(?:wiki\/|raw\/|skills\/|drafts\/|meta\.json$)/.test(path.relative(this.store.root, file).replaceAll('\\', '/'))) this.store.invalidate();
  }
  private entries<T>(dir: string): T[] { return readdirSync(this.folder(dir)).filter(name => name.endsWith('.json')).flatMap(name => { const item = this.json<T | null>(path.join(this.folder(dir), name), null); return item ? [item] : []; }); }
  editorDraft(key: string): EditorDraft | null { return this.json(path.join(this.folder('editor-drafts'), createHash('sha256').update(key).digest('hex') + '.json'), null); }
  editorDrafts(): EditorDraft[] { return this.entries<EditorDraft>('editor-drafts').sort((a, b) => b.at.localeCompare(a.at)); }
  saveEditorDraft(key: string, fields: Record<string, string> | null): void {
    if (!/^(?:page:|source:|skill:|review:|schema$|question$)/.test(key) || key.length > 150) throw new Error('草稿标识无效');
    const file = path.join(this.folder('editor-drafts'), createHash('sha256').update(key).digest('hex') + '.json');
    if (fields === null) { rmSync(file, { force: true }); return; }
    if(key.startsWith('review:')&&!this.store.getDraft(key.split(':')[1]))return; // Late save after explicit record deletion.
    if (Object.keys(fields).length > 20 || Object.entries(fields).some(([name, value]) => /key|password|token|secret/i.test(name) || typeof value !== 'string')) throw new Error('草稿字段无效或过长');
    if (!existsSync(file) && this.editorDrafts().length >= 100) throw new Error('已有 100 份未保存草稿，请先处理旧草稿');
    this.write(file, JSON.stringify({ key, fields, at: new Date().toISOString() }));
  }
  trash(): TrashEntry[] { return this.entries<TrashEntry>('trash').sort((a, b) => b.at.localeCompare(a.at)); }
  purgeTrash(id?: string): { deleted: number; assetsRemoved: number; retainedAssets: number; failedAssets: string[]; failedAssetCount: number } {
    if(id!==undefined&&!/^[a-f0-9-]{36}$/.test(id))throw new Error('回收记录无效');
    const all=this.trash(),selected=all.filter(item=>id===undefined||item.id===id);
    if(id!==undefined&&!selected.length)throw new Error('回收记录不存在');
    const assets=new Set(selected.flatMap(item=>item.source?[...item.source.images,...(item.source.document?[item.source.document.asset]:[]),...(item.source.parts??[]).flatMap(part=>part.asset?[part.asset]:[])]:[]));
    const retained=new Set<string>();
    for(const source of [...this.store.listSources(),...all.filter(item=>!selected.includes(item)).flatMap(item=>item.source?[item.source]:[])]){
      source.images.forEach(name=>retained.add(name));if(source.document)retained.add(source.document.asset);
      for(const part of source.parts??[])if(part.asset)retained.add(part.asset);
    }
    // Pages, review bodies and historical versions may still embed an asset.
    const texts=[...this.store.listPages().map(page=>page.body),...all.filter(item=>!selected.includes(item)).flatMap(item=>item.page?[item.page.body]:[]),...this.store.listDrafts().flatMap(draft=>draft.pages.flatMap(page=>[page.body,page.previous??''])),...this.editorDrafts().flatMap(draft=>Object.values(draft.fields))];
    const history=path.join(this.store.root,'history');
    if(existsSync(history))for(const file of readdirSync(history,{withFileTypes:true}))if(file.isFile()&&file.name.endsWith('.md'))texts.push(readFileSync(path.join(history,file.name),'utf8'));
    for(const body of texts)for(const name of body.match(/[a-zA-Z0-9-]+\.(?:png|jpe?g|webp|gif|pdf)\b/g)??[])retained.add(name);
    // Remove the records before best-effort attachment cleanup: a locked asset
    // must not leave a restorable record whose other assets were already erased.
    for(const entry of selected)rmSync(path.join(this.folder('trash'),entry.id+'.json'));
    let assetsRemoved=0,retainedAssets=0;const failedAssets:string[]=[];
    for(const name of assets){if(retained.has(name)){retainedAssets++;continue;}try{const file=this.store.assetFile(name);if(existsSync(file)){rmSync(file);assetsRemoved++;}}catch{failedAssets.push(name);}}
    this.store.invalidate();return {deleted:selected.length,assetsRemoved,retainedAssets,failedAssets:failedAssets.slice(0,20),failedAssetCount:failedAssets.length};
  }
  deleteReviewEditors(id: string): void {
    for(const draft of this.editorDrafts())if(draft.key==='review:'+id||draft.key.startsWith('review:'+id+':'))this.saveEditorDraft(draft.key,null);
  }
  deletePage(slug: string): TrashEntry {
    const page = this.store.getPage(slug); if (!page) throw new Error('页面不存在');
    const entry: TrashEntry = { id: randomUUID(), kind: 'page', title: page.title, at: new Date().toISOString(), page };
    this.write(path.join(this.folder('trash'), entry.id + '.json'), JSON.stringify(entry));
    this.store.deletePage(slug); return entry;
  }
  deleteSource(id: string): TrashEntry {
    const source = this.store.getSource(id); if (!source) throw new Error('素材不存在');
    const entry: TrashEntry = { id: randomUUID(), kind: 'source', title: source.title, at: new Date().toISOString(), source };
    this.write(path.join(this.folder('trash'), entry.id + '.json'), JSON.stringify(entry));
    this.store.hideSource(id); return entry; // Retain assets for restoration.
  }
  restoreTrash(id: string, asCopy = false): TrashEntry {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('回收记录无效');
    const file = path.join(this.folder('trash'), id + '.json'), entry = this.json<TrashEntry | null>(file, null);
    if (!entry) throw new Error('回收记录不存在');
    if (entry.page) {
      if (this.store.getPage(entry.page.slug)) {
        if (!asCopy) throw new Error('同名页面已存在，可选择恢复为副本');
        const base = slugify(entry.page.slug.slice(0, 60) + '-restored'); let slug = base, suffix = 2;
        while (this.store.getPage(slug)) slug = base + '-' + suffix++;
        entry.page.slug = slug; entry.page.humanEdited = true; entry.page.hash = pageHash(entry.page);
      }
      this.store.savePage(entry.page);
    }
    else if (entry.source) { if (this.store.getSource(entry.source.id)) throw new Error('素材已存在'); this.store.saveSource(entry.source); }
    else throw new Error('回收记录已损坏');
    rmSync(file); this.store.invalidate(); return entry;
  }
  saveAnswer(answer: WikiAnswer): void {
    const directory = this.folder('answers');
    let file = path.join(directory, createHash('sha256').update(answer.at).digest('hex') + '.json');
    // Fast local endpoints can complete twice in one millisecond. The record's
    // timestamp is also its UI identity, so retain both instead of replacing one.
    while (existsSync(file)) { answer.at = new Date(Date.parse(answer.at) + 1).toISOString(); file = path.join(directory, createHash('sha256').update(answer.at).digest('hex') + '.json'); }
    this.write(file, JSON.stringify(answer));
  }
  answers(): WikiAnswer[] {
    const records = new Map(this.store.meta().answers.map(answer => [answer.at, answer]));
    for (const answer of this.entries<WikiAnswer>('answers')) records.set(answer.at, answer);
    return [...records.values()].sort((a, b) => b.at.localeCompare(a.at));
  }
  saveTasks(value: import('./types').WikiTask[]): void { const records = new Map(this.tasks<import('./types').WikiTask[]>([]).map(task => [task.id, task])); for (const task of value) records.set(task.id, task); this.write(path.join(this.store.root, 'tasks.json'), JSON.stringify([...records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-200))); }
  tasks<T>(fallback: T): T { return this.json(path.join(this.store.root, 'tasks.json'), fallback); }
  private portableFiles(): string[] {
    const files: string[] = []; let total = 0;
    const visit = (dir: string, prefix = '') => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const name = prefix + item.name;
        if (item.isDirectory() && /^(?:wiki|raw|raw\/assets|skills|skills\/[a-z0-9-]+|drafts|history|trash|answers|editor-drafts)$/.test(name)) visit(path.join(dir, item.name), name + '/');
        else if (item.isFile() && safePath(name)) { total += statSync(path.join(dir, item.name)).size; if (files.length >= 10000 || total > 256 * 1024 * 1024) throw new Error('备份原始数据超过 256 MiB 或 10000 个文件'); files.push(name); }
      }
    };
    visit(this.store.root);
    return files;
  }
  backup(): Uint8Array {
    const files: Record<string, Uint8Array> = {};
    for (const name of this.portableFiles()) files[name] = new Uint8Array(readFileSync(path.join(this.store.root, name)));
    files['wiki-backup.json'] = new TextEncoder().encode(JSON.stringify({ format: 'agentberth-wiki', version: 1, at: new Date().toISOString() }));
    const data = zipSync(files, { level: 6 }); if (data.length > MAX_ARCHIVE) throw new Error('备份超过 64 MiB，请先整理附件'); return data;
  }
  private unpack(bytes: Uint8Array): Record<string, Uint8Array> {
    if (bytes.length > MAX_ARCHIVE) throw new Error('备份超过 64 MiB');
    let size = 0, count = 0;
    const files = unzipSync(bytes, { filter: file => {
      if (file.name === 'wiki-backup.json') { if (file.originalSize > 16384) throw new Error('备份清单过大'); return true; }
      if (++count > 10000 || (size += file.originalSize) > 256 * 1024 * 1024) throw new Error('备份展开后过大');
      if (file.name !== 'wiki-backup.json' && !safePath(file.name)) throw new Error('备份包含不允许的路径：' + file.name);
      return true;
    } });
    const metadata = JSON.parse(new TextDecoder().decode(files['wiki-backup.json'] ?? new Uint8Array()));
    if (metadata.format !== 'agentberth-wiki' || metadata.version !== 1) throw new Error('不是支持的知识库备份');
    delete files['wiki-backup.json'];
    for (const [name, data] of Object.entries(files)) {
      const text = new TextDecoder().decode(data);
      if (name.endsWith('.json')) {
        const item = JSON.parse(text), object = item && typeof item === 'object';
        const validAnswer = (a: WikiAnswer) => a && typeof a.at === 'string' && typeof a.question === 'string' && typeof a.answer === 'string' && Array.isArray(a.citations) && Array.isArray(a.pages);
        if (!object) throw new Error('备份数据无效：' + name);
        if (name.startsWith('raw/') && (item.id !== name.slice(4, -5) || typeof item.text !== 'string' || typeof item.title !== 'string' || typeof item.createdAt !== 'string' || !Array.isArray(item.images) || item.images.some((image: unknown) => typeof image !== 'string' || !/^[a-z0-9-]+\.(?:png|jpg|jpeg|webp|gif)$/.test(image)))) throw new Error('备份素材无效：' + name);
        if (item.document && (typeof item.document.asset !== 'string' || !/^[a-f0-9-]+\.pdf$/.test(item.document.asset) || !Array.isArray(item.document.ranges))) throw new Error('备份 PDF 元数据无效');
        const source=item.source??item;
        if(source.parts!==undefined&&(!Array.isArray(source.parts)||typeof source.text!=='string'||source.parts.some((part:NonNullable<WikiSource['parts']>[number])=>!part||typeof part.id!=='string'||typeof part.name!=='string'||!['text','image','pdf'].includes(part.kind)||typeof part.hash!=='string'||!Number.isSafeInteger(part.start)||!Number.isSafeInteger(part.end)||part.start<0||part.end<part.start||part.end>source.text.length||(part.asset!==undefined&&!/^[a-f0-9-]+\.(?:png|jpe?g|webp|gif|pdf)$/.test(part.asset)))))throw new Error('备份混合素材元数据无效');
        if (name.startsWith('answers/') && !validAnswer(item)) throw new Error('备份问答无效');
        if (name === 'meta.json' && (!Array.isArray(item.answers) || !item.answers.every(validAnswer))) throw new Error('备份索引无效');
        if (name === 'tasks.json' && (!Array.isArray(item) || item.some((task: { id?: string; kind?: string; status?: string }) => !task || typeof task.id !== 'string' || typeof task.kind !== 'string' || typeof (task as { label?: string }).label !== 'string' || typeof (task as { startedAt?: string }).startedAt !== 'string' || !['queued', 'running', 'done', 'failed', 'cancelled'].includes(task.status ?? '')))) throw new Error('备份任务记录无效');
        if (name.startsWith('drafts/') && (item.id !== name.slice(7, -5) || !Array.isArray(item.pages) || !Array.isArray(item.feedback) || !['pending', 'approved', 'rejected'].includes(item.status))) throw new Error('备份提案无效');
        if (name.startsWith('editor-drafts/') && (typeof item.key !== 'string' || !/^(?:page:|source:|skill:|review:|schema$|question$)/.test(item.key) || !item.fields || Object.values(item.fields).some(value => typeof value !== 'string'))) throw new Error('备份草稿无效');
        if (name.startsWith('trash/') && (item.id !== name.slice(6, -5) || !['page', 'source'].includes(item.kind) || typeof item.title !== 'string')) throw new Error('备份回收记录无效');
      }
      if (name.startsWith('editor-drafts/') && Object.keys(JSON.parse(text).fields ?? {}).some(key => /key|password|token|secret/i.test(key))) throw new Error('备份草稿含凭据字段');
    }
    return files;
  }
  private previewFiles(files: Record<string, Uint8Array>) {
    const conflicts: string[] = []; let added = 0, identical = 0;
    for (const [name, value] of Object.entries(files)) {
      const file = path.join(this.store.root, name);
      if (!existsSync(file)) added++;
      else if (Buffer.from(value).equals(readFileSync(file))) identical++;
      else conflicts.push(name);
    }
    return { files: Object.keys(files).length, added, identical, conflictCount: conflicts.length, conflicts: conflicts.slice(0, 50).map(name => byteTruncate(name, 300)) };
  }
  previewBackup(bytes: Uint8Array) { return this.previewFiles(this.unpack(bytes)); }
  importBackup(bytes: Uint8Array, overwrite = false, exact = false): { imported: number; skipped: number; removed: number; rollback: string } {
    const files = this.unpack(bytes), previousFiles = exact ? this.portableFiles() : [], before = new Map<string, Buffer | null>(), rollback = randomUUID() + '.zip';
    this.write(path.join(this.folder('backups'), rollback), this.backup());
    let imported = 0, skipped = 0, removed = 0;
    try {
      for (const [name, value] of Object.entries(files)) {
        const file = path.join(this.store.root, name);
        if (existsSync(file) && (!overwrite || Buffer.from(value).equals(readFileSync(file)))) { skipped++; continue; }
        before.set(file, existsSync(file) ? readFileSync(file) : null); this.write(file, value); imported++;
      }
      if (exact) for (const name of previousFiles) {
        if (Object.hasOwn(files, name)) continue;
        const file = path.join(this.store.root, name); before.set(file, readFileSync(file)); rmSync(file); this.cache.delete(file); removed++;
      }
    } catch (error) { for (const [file, value] of before) if (value === null) rmSync(file, { force: true }); else this.write(file, value); throw error; }
    this.store.invalidate(); return { imported, skipped, removed, rollback };
  }
  previewRollback(name: string) { const files = this.unpack(this.readRollback(name)), removed = this.portableFiles().filter(file => !Object.hasOwn(files, file)); return { ...this.previewFiles(files), removedCount: removed.length, removed: removed.slice(0, 50).map(file => byteTruncate(file, 300)) }; }
  restoreRollback(name: string) { return this.importBackup(this.readRollback(name), true, true); }
  rollbackSnapshots() { const folder = this.folder('backups'); return readdirSync(folder).filter(name => /^[a-f0-9-]{36}\.zip$/.test(name)).map(name => { const info = statSync(path.join(folder, name)); return { name, at: info.mtime.toISOString(), size: info.size }; }).sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name)); }
  rollbackBackups(): string[] { return this.rollbackSnapshots().map(item => item.name); }
  readRollback(name: string): Uint8Array { if (!this.rollbackBackups().includes(name)) throw new Error('备份不存在'); return new Uint8Array(readFileSync(path.join(this.folder('backups'), name))); }
}
