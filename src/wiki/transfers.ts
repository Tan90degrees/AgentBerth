import { randomUUID } from 'node:crypto';

/** Bounded transport for the iframe's 64 KiB RPC envelope. Entries expire and
 * belong to one plugin generation; cancellation releases their buffers. */
export class WikiTransfers {
  private stopped: boolean;
  private readonly entries = new Map<string, { chunks: Buffer[]; size: number; at: number; name: string; mime: string; ready: boolean }>();
  constructor(signal: AbortSignal) { this.stopped = signal.aborted; signal.addEventListener('abort', () => { this.stopped = true; this.entries.clear(); }, { once: true }); }
  start(name: string, mime = 'application/zip') {
    if (this.stopped) throw new Error('插件已停止');
    for (const [id, item] of this.entries) if (Date.now() - item.at > 600000) this.entries.delete(id);
    if (this.entries.size >= 4) throw new Error('正在传输其他文件，请先完成或取消');
    const id = randomUUID(); this.entries.set(id, { chunks: [], size: 0, at: Date.now(), name: name.slice(0, 160), mime, ready: false }); return { id };
  }
  download(name: string, bytes: Uint8Array, mime = 'application/zip') {
    if (bytes.length > 64 * 1024 * 1024) throw new Error('文件超过 64 MiB');
    const { id } = this.start(name, mime), entry = this.get(id); entry.chunks = [Buffer.from(bytes)]; entry.size = bytes.length; entry.ready = true;
    return { id, name, mime, size: bytes.length };
  }
  private get(id: string) { const entry = this.entries.get(id); if (!entry || Date.now() - entry.at > 600000) { this.entries.delete(id); throw new Error('传输已过期，请重新选择文件'); } entry.at = Date.now(); return entry; }
  append(id: string, base64: string, done: boolean): Uint8Array | null {
    const entry = this.get(id); if (entry.ready) throw new Error('上传已完成');
    const chunk = Buffer.from(base64, 'base64'); if (chunk.length > 36 * 1024) throw new Error('分片过大');
    if (entry.size + chunk.length > 64 * 1024 * 1024) { this.entries.delete(id); throw new Error('文件超过 64 MiB'); }
    entry.chunks.push(chunk); entry.size += chunk.length;
    if (!done) return null;
    entry.chunks = [Buffer.concat(entry.chunks)]; entry.ready = true; return new Uint8Array(entry.chunks[0]);
  }
  bytes(id: string): Uint8Array { const entry = this.get(id); if (!entry.ready) throw new Error('文件尚未上传完成'); return new Uint8Array(entry.chunks[0]); }
  read(id: string, offset: number) {
    const entry = this.get(id); if (!entry.ready || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.size) throw new Error('下载位置无效');
    const chunk = entry.chunks[0].subarray(offset, offset + 36 * 1024);
    return { base64: chunk.toString('base64'), next: offset + chunk.length, done: offset + chunk.length >= entry.size };
  }
  cancel(id: string): boolean { return this.entries.delete(id); }
}
