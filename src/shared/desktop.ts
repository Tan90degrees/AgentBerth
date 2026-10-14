export const MAX_CLIPBOARD_TEXT = 1024 * 1024;
export const MAX_PASTE_TEXT = 65536;

export function externalWebUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n\x00]/.test(value)) throw new Error('网页链接格式无效');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('网页链接格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持不含用户名和密码的 HTTP / HTTPS 网页链接');
  return url.href;
}

// Bound both UTF-8 and JSON escaped payloads, preserving surrogate pairs.
export function inputChunks(text: string): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 8192);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    result.push(text.slice(offset, end)); offset = end;
  }
  return result;
}

export function terminalDimensions(cols: number, rows: number): { cols: number; rows: number } {
  return { cols: Math.min(300, Math.max(20, Math.floor(cols))), rows: Math.min(100, Math.max(5, Math.floor(rows))) };
}
