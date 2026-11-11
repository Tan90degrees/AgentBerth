import { buildIndex, extractLinks, byteTruncate } from './core';
import { withWriteLock } from './store';
import { WikiTransfers } from './transfers';
import type { WikiService } from './service';
import type { WikiTask } from './types';
type Params = Record<string, unknown>;
const str = (p: Params, key: string) => typeof p[key] === 'string' ? p[key] as string : '';
const num = (p: Params, key: string, fallback = 0) => typeof p[key] === 'number' ? p[key] as number : fallback;
const field = (type: string, extra: object = {}) => ({ type, ...extra });
const page = { offset: field('integer', { minimum: 0 }), limit: field('integer', { minimum: 1, maximum: 50 }) };
const slice = <T>(items: T[], p: Params) => items.slice(num(p, 'offset'), num(p, 'offset') + num(p, 'limit', 25));

function taskResult(task: WikiTask): unknown {
  const value = task.result;
  if (!value || typeof value !== 'object') return value;
  const result = value as Record<string, unknown>;
  if (task.kind === 'capture') return { id: result.id, events: result.events, pages: result.pages, skipped: result.skipped };
  if (task.kind === 'ask') return { at: result.at };
  if (task.kind === 'archive') return { slug: result.slug };
  if (task.kind === 'lint') return undefined;
  if (Array.isArray(result.published) && Array.isArray(result.skipped)) return {
    publishedCount: result.published.length, skippedCount: result.skipped.length,
    published: result.published.slice(0, 5).map(slug => byteTruncate(String(slug), 80)),
    skipped: result.skipped.slice(0, 5).map(slug => byteTruncate(String(slug), 80)),
    skippedDetails: Array.isArray(result.skippedDetails) ? result.skippedDetails.slice(0, 5).map(item => ({ slug: byteTruncate(String(item.slug), 80), reason: byteTruncate(String(item.reason), 200) })) : [],
  };
  return result.rejected ? { rejected: true } : undefined;
}

/** Local view commands. None of these mutating operations are exposed to MCP. */
export function registerWorkspaceCommands(service: WikiService, add: (name: string, description: string, input: Record<string, unknown>, handler: (p: Params) => unknown) => void, signal: AbortSignal): void {
  const workspace = service.workspace, store = service.store, transfers = new WikiTransfers(signal), uploads = new Map<string, Params>();
  signal.addEventListener('abort', () => uploads.clear(), { once: true });
  const write = <T>(run: () => T) => withWriteLock(() => { if (signal.aborted) throw new Error('插件已停止'); return run(); });
  const cmd = (name: string, description: string, props: Record<string, unknown>, required: string[], handler: (p: Params) => unknown) => add(name, description, { type: 'object', properties: props, required, additionalProperties: false }, p => { if (signal.aborted) throw new Error('插件已停止'); return handler(p); });
  const id = { id: field('string') };
  cmd('editor_drafts', '列出可恢复的编辑草稿', {}, [], () => workspace.editorDrafts().map(({ key, at }) => ({ key, at })));
  cmd('get_editor_draft', '恢复编辑草稿', { key: field('string') }, ['key'], p => workspace.editorDrafts().find(draft => draft.key === str(p, 'key')) ?? null);
  cmd('save_editor_draft', '自动保存编辑草稿（不含凭据）', { key: field('string'), fields: field('object'), discard: field('boolean') }, ['key'], p => write(() => { workspace.saveEditorDraft(str(p, 'key'), p.discard === true ? null : p.fields as Record<string, string>); return true; }));
  cmd('tasks', '任务队列与历史', page, [], p => slice(service.taskList(), p).map(task => ({ ...task, label: byteTruncate(task.label, 300), error: task.error ? byteTruncate(task.error, 400) : undefined, retry: task.retry ? { action: task.retry.action, params: {} } : undefined, result: taskResult(task) })));
  cmd('cancel_task', '取消排队或执行中的任务', id, ['id'], p => service.cancelTask(str(p, 'id')));
  cmd('retry_task', '重试失败或已取消的任务', id, ['id'], p => service.retryTask(str(p, 'id')));
  cmd('trash', '回收站', page, [], p => slice(workspace.trash(), p).map(({ id, kind, title, at }) => ({ id, kind, title, at })));
  cmd('restore_trash', '恢复已删除页面或素材', { ...id, asCopy: field('boolean') }, ['id'], p => write(() => { const item = workspace.restoreTrash(str(p, 'id'), p.asCopy === true); store.saveIndex(buildIndex(store.listPages())); return { kind: item.kind, slug: item.page?.slug, sourceId: item.source?.id }; }));
  cmd('delete_impact', '删除前查看引用影响', { kind: field('string'), ...id }, ['kind', 'id'], p => ({ pages: service.listPages().filter(item => p.kind === 'source' ? item.sources.includes(str(p, 'id')) || item.evidence.some(e => e.sourceId === p.id) : extractLinks(item.body).includes(str(p, 'id'))).map(item => item.title).slice(0, 100) }));
  cmd('edit_draft_page', '逐页选择、修改和合并提案', { ...id, slug: field('string'), selected: field('boolean'), body: field('string'), merge: field('boolean') }, ['id', 'slug', 'selected'], p => service.editDraftPage(str(p, 'id'), str(p, 'slug'), p.selected === true, typeof p.body === 'string' ? p.body : undefined, p.merge === true).then(() => true));
  cmd('draft_page_text', '读取提案的可编辑正文', { ...id, slug: field('string') }, ['id', 'slug'], p => { const draft = service.getDraft(str(p, 'id')), item = draft?.pages.find(item => item.slug === p.slug); return item ? { body: item.body, selected: item.selected !== false, merge: !!item.allowHumanMerge, action: item.action, editable: draft?.status === 'pending' } : null; });
  cmd('source_assets', '分页读取全部素材图片', { ...id, ...page }, ['id'], p => { const source = service.getSource(str(p, 'id')); if (!source) throw new Error('素材不存在'); return { names: slice(source.images, { ...p, limit: num(p, 'limit', 6) }), total: source.images.length }; });
  cmd('source_text', '分页读取原始素材全文和 PDF 页码', { ...id, offset: field('integer', { minimum: 0 }), limit: field('integer', { minimum: 1, maximum: 12000 }), quote: field('string'), page: field('integer', { minimum: 1 }) }, ['id'], p => {
    const source = service.getSource(str(p, 'id')); if (!source) throw new Error('素材不存在');
    const quote = str(p, 'quote'), found = quote ? source.text.indexOf(quote) : -1;
    const selectedPage = source.document?.ranges.find(range => range.page === num(p, 'page'));
    const offset = selectedPage ? selectedPage.start : found >= 0 ? Math.max(0, found - 150) : num(p, 'offset'), end = Math.min(source.text.length, offset + num(p, 'limit', 12000));
    return { offset, text: source.text.slice(offset, end), next: end, total: source.text.length, ranges: source.document?.ranges.slice(0, 30) ?? [] };
  });
  cmd('download_source_asset', '查看或下载素材图片和原 PDF', { ...id, name: field('string') }, ['id', 'name'], p => {
    const source = service.getSource(str(p, 'id')), name = str(p, 'name');
    if (!source || !source.images.includes(name) && source.document?.asset !== name) throw new Error('附件不属于此素材');
    return transfers.downloadFile(source.document?.asset === name ? source.document.name : name, store.assetFile(name), name.endsWith('.pdf') ? 'application/pdf' : 'image/' + (name.endsWith('.jpg') ? 'jpeg' : name.split('.').pop()));
  });
  cmd('binary_chunk', '读取下载分片', { ...id, offset: field('integer', { minimum: 0 }) }, ['id', 'offset'], p => transfers.read(str(p, 'id'), num(p, 'offset')));
  cmd('cancel_transfer', '取消文件传输', id, ['id'], p => { uploads.delete(str(p, 'id')); return transfers.cancel(str(p, 'id')); });
  cmd('text_upload_start', '开始导入文本或 Markdown 文件', { name: field('string') }, [], p => transfers.start(str(p, 'name'), 'text/plain'));
  cmd('text_upload_chunk', '上传文本分片，完成后保存素材', { ...id, name: field('string'), base64: field('string'), done: field('boolean') }, ['id', 'base64'], async p => {
    const bytes = transfers.append(str(p, 'id'), str(p, 'base64'), p.done === true); if (!bytes) return null;
    try { return await service.ingestInboxFile(str(p, 'name'), new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    finally { transfers.cancel(str(p, 'id')); }
  });
  const staged = (kind: string, p: Params) => { const result = transfers.start(kind); uploads.set(result.id, { ...p, kind }); return result; };
  cmd('source_text_start', '开始保存完整素材正文', { title: field('string'), staging: field('boolean') }, [], p => staged('source', p));
  cmd('image_upload_start', '上传原始图片', { sourceId: field('string'), mime: field('string') }, ['sourceId', 'mime'], p => staged('image', p));
  cmd('draft_upload_start', '分片保存完整编辑草稿', { key: field('string') }, ['key'], p => staged('draft', p));
  const finishUpload = async (p: Params) => {
    const id = str(p, 'id'), metadata = uploads.get(id); if (!metadata) throw new Error('上传已过期');
    const bytes = transfers.append(id, str(p, 'base64'), p.done === true); if (!bytes) return null;
    try {
      if (metadata.kind === 'image') return await service.addImage(str(metadata, 'sourceId'), str(metadata, 'mime'), Buffer.from(bytes).toString('base64'));
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (metadata.kind === 'draft') return await write(() => { workspace.saveEditorDraft(str(metadata, 'key'), JSON.parse(text)); return true; });
      const source = await service.addSource({ title: str(metadata, 'title'), text, staging: metadata.staging === true }); return { id: source.id, title: source.title, compiled: source.compiled };
    } finally { uploads.delete(id); transfers.cancel(id); }
  };
  for (const name of ['source_text_chunk', 'image_upload_chunk', 'draft_upload_chunk']) cmd(name, '写入文件分片', { ...id, base64: field('string'), done: field('boolean') }, ['id', 'base64'], finishUpload);
  cmd('editor_draft_download', '完整读取编辑草稿', { key: field('string') }, ['key'], p => { const draft = workspace.editorDraft(str(p, 'key')); if (!draft) return null; return transfers.download('draft.json', new TextEncoder().encode(JSON.stringify(draft)), 'application/json'); });
  cmd('export_backup', '导出完整知识库（不含模型密钥）', {}, [], () => write(() => transfers.download('AgentBerth-Wiki-' + new Date().toISOString().slice(0, 10) + '.zip', workspace.backup())));
  cmd('backup_upload_start', '开始导入知识库备份', {}, [], () => transfers.start('backup.zip', 'application/zip', 64 * 1024 * 1024));
  cmd('backup_upload_chunk', '上传备份并预览冲突', { ...id, base64: field('string'), done: field('boolean') }, ['id', 'base64'], p => { const bytes = transfers.append(str(p, 'id'), str(p, 'base64'), p.done === true); return bytes ? workspace.previewBackup(bytes) : null; });
  const idle = () => service.assertWorkspaceIdle();
  cmd('apply_backup', '导入备份，自动保留恢复前备份', { ...id, overwrite: field('boolean') }, ['id'], p => write(() => { idle(); const result = workspace.importBackup(transfers.bytes(str(p, 'id')), p.overwrite === true); service.reloadWorkspaceState(); transfers.cancel(str(p, 'id')); store.saveIndex(buildIndex(store.listPages())); return result; }));
  cmd('rollback_backups', '列出恢复前的自动备份', {}, [], () => workspace.rollbackBackups());
  cmd('rollback_snapshots', '按时间列出自动快照与大小', {}, [], () => workspace.rollbackSnapshots());
  cmd('preview_rollback', '预览完整快照恢复时移除的新增内容', { name: field('string') }, ['name'], p => workspace.previewRollback(str(p, 'name')));
  cmd('restore_backup', '完整恢复一份自动备份，移除快照之外的知识内容', { name: field('string') }, ['name'], p => write(() => { idle(); const result = workspace.restoreRollback(str(p, 'name')); service.reloadWorkspaceState(); store.saveIndex(buildIndex(store.listPages())); return result; }));
}
