/** A bounded model window, not a material length limit. Every character is
 * disclosed exactly once; surrogate pairs never split across requests. */
export function* materialSegments(text: string, size = 12000): Generator<{ text: string; start: number; end: number }> {
  if (!Number.isSafeInteger(size) || size < 2) throw new Error('分片窗口无效');
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    yield { text: text.slice(start, end), start, end }; start = end;
  }
}

/** Cursor metadata lets an Agent continue to the end instead of receiving a
 * silently shortened prefix. Offsets count UTF-16 units, as JS strings do. */
export function materialWindow(text: string, offset = 0, limit = 12000) {
  const start = Number.isSafeInteger(offset) ? Math.max(0, Math.min(offset, text.length)) : 0;
  const size = Number.isSafeInteger(limit) ? Math.max(2, Math.min(limit, 12000)) : 12000;
  let end = Math.min(start + size, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return { text: text.slice(start, end), offset: start, next: end, total: text.length, hasMore: end < text.length };
}

/** Keep an unusually long model result reviewable without rejecting or
 * truncating it. These are page boundaries, not discarded content. */
export function partitionProposalPages(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.body !== 'string' || Buffer.byteLength(item.body) <= 48 * 1024) return [item];
    return [...materialSegments(item.body)].map((part, offset) => ({ ...item, body: part.text, ...(offset ? { title: String(item.title ?? '').slice(0, 135) + `（续 ${offset + 1}）`, slug: String(item.slug ?? 'material-' + index).slice(0, 48) + '-part-' + (offset + 1) } : {}) }));
  });
}
