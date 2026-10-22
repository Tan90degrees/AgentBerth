import type { RemoteCommandOutput } from '../shared/protocol';

/** A bounded, in-memory command stream. Cursors are opaque UTF-16 offsets;
 * readers must pass nextCursor back with the same actionId and runId. */
export class CommandOutput {
  private chunks: { start: number; text: string }[] = [];
  private end = 0;
  constructor(private capacity = 128 * 1024) {}

  append(text: string): void {
    if (!text) return;
    const last=this.chunks.at(-1);
    if(last&&last.text.length+text.length<=8192)last.text+=text;
    else this.chunks.push({ start: this.end, text });
    this.end += text.length;
    const floor = Math.max(0, this.end - this.capacity);
    while (this.chunks.length && this.chunks[0].start + this.chunks[0].text.length <= floor) this.chunks.shift();
    const first = this.chunks[0];
    if (first && first.start < floor) {
      let drop = floor - first.start;
      if (/[\uDC00-\uDFFF]/.test(first.text[drop] ?? '')) drop++;
      first.text = first.text.slice(drop); first.start += drop;
    }
  }

  read(cursor: number, maxChars: number): RemoteCommandOutput {
    if (cursor > this.end) throw new Error('输出游标超出当前命令，请使用此 actionId 返回的 nextCursor');
    const earliestCursor = this.chunks[0]?.start ?? this.end;
    const start = Math.max(cursor, earliestCursor);
    let text = '';
    for (const chunk of this.chunks) {
      if (chunk.start + chunk.text.length <= start) continue;
      text += chunk.text.slice(Math.max(0, start - chunk.start), Math.max(0, start - chunk.start) + maxChars - text.length);
      if (text.length >= maxChars) break;
    }
    // Do not split a Unicode scalar at a response boundary.
    if (/[\uD800-\uDBFF]/.test(text.at(-1) ?? '')) text = text.slice(0,-1);
    if (/[\uDC00-\uDFFF]/.test(text[0] ?? '')) throw new Error('输出游标无效，请原样使用 nextCursor');
    const nextCursor = start + text.length;
    return { text, nextCursor, earliestCursor, truncated: cursor < earliestCursor, hasMore: nextCursor < this.end, available: true, format: 'terminal' };
  }
}
