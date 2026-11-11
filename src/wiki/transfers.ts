import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Transport windows stay small; material size is not a transport limit.
 * Temporary bytes live on disk and are removed on cancellation or disposal. */
export class WikiTransfers {
  private stopped: boolean;
  private readonly directory = mkdtempSync(path.join(os.tmpdir(), 'berth-wiki-transfer-'));
  private readonly entries = new Map<string, { file: string; owned: boolean; size: number; at: number; name: string; mime: string; ready: boolean; maximum: number }>();
  constructor(signal: AbortSignal) {
    this.stopped = signal.aborted;
    const dispose = () => { this.stopped = true; for (const id of this.entries.keys()) this.cancel(id); rmSync(this.directory, { recursive: true, force: true }); };
    signal.addEventListener('abort', dispose, { once: true }); if (signal.aborted) dispose();
  }
  start(name: string, mime = 'application/zip', maximum = Infinity) {
    if (this.stopped) throw new Error('插件已停止');
    for (const [id, item] of this.entries) if (Date.now() - item.at > 600000) this.cancel(id);
    const id = randomUUID(), file = path.join(this.directory, id); writeFileSync(file, new Uint8Array(), { mode: 0o600 });
    this.entries.set(id, { file, owned: true, size: 0, at: Date.now(), name, mime, ready: false, maximum }); return { id };
  }
  download(name: string, bytes: Uint8Array, mime = 'application/zip') {
    const { id } = this.start(name, mime), entry = this.get(id); writeFileSync(entry.file, bytes); entry.size = bytes.length; entry.ready = true;
    return { id, name, mime, size: bytes.length };
  }
  downloadFile(name: string, file: string, mime: string) {
    const { id } = this.start(name, mime), entry = this.get(id); rmSync(entry.file); entry.file = file; entry.owned = false; entry.size = statSync(file).size; entry.ready = true;
    return { id, name, mime, size: entry.size };
  }
  private get(id: string) { const entry = this.entries.get(id); if (!entry || Date.now() - entry.at > 600000) { this.cancel(id); throw new Error('传输已过期，请重新选择文件'); } entry.at = Date.now(); return entry; }
  append(id: string, base64: string, done: boolean): Uint8Array | null {
    const entry = this.get(id); if (entry.ready) throw new Error('上传已完成');
    const chunk = Buffer.from(base64, 'base64'); if (chunk.length > 36 * 1024) throw new Error('分片过大');
    if (entry.size + chunk.length > entry.maximum) { this.cancel(id); throw new Error('文件超过备份传输上限'); }
    appendFileSync(entry.file, chunk); entry.size += chunk.length;
    if (!done) return null; entry.ready = true; return new Uint8Array(readFileSync(entry.file));
  }
  bytes(id: string): Uint8Array { const entry = this.get(id); if (!entry.ready) throw new Error('文件尚未上传完成'); return new Uint8Array(readFileSync(entry.file)); }
  read(id: string, offset: number) {
    const entry = this.get(id); if (!entry.ready || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.size) throw new Error('下载位置无效');
    const buffer = Buffer.alloc(Math.min(36 * 1024, entry.size - offset)), descriptor = openSync(entry.file, 'r'); let size: number;
    try { size = readSync(descriptor, buffer, 0, buffer.length, offset); } finally { closeSync(descriptor); }
    return { base64: buffer.subarray(0, size).toString('base64'), next: offset + size, done: offset + size >= entry.size };
  }
  cancel(id: string): boolean { const entry = this.entries.get(id); if (entry?.owned) rmSync(entry.file, { force: true }); return this.entries.delete(id); }
}
