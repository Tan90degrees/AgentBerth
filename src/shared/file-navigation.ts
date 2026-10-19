export interface FileLocation { path: string; line?: number; column?: number }
export function parseFileLocation(value: string): FileLocation {
  let path = value.trim().replace(/[,;]$/, '');
  try { if (/^file:\/\//i.test(path)) path = decodeURIComponent(new URL(path).pathname).replace(/^\/(\w:)/, '$1'); } catch {}
  const location = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))$/.exec(path);
  if (!location) return { path: path.replace(/^["'`]|["'`]$/g, '') };
  return { path: path.slice(0, location.index).replace(/^["'`]|["'`]$/g, ''), line: Math.max(1, Number(location[1] ?? location[3])), column: Math.max(1, Number(location[2] ?? location[4] ?? 1)) };
}
export function fileMatchScore(candidate: string, query: string): number {
  const name = candidate.toLocaleLowerCase(), target = query.toLocaleLowerCase().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (name === target) return 10000;
  if (name.endsWith('/' + target)) return 9000 - name.length;
  if (name.split('/').at(-1) === target) return 8000 - name.length;
  const at = name.indexOf(target);
  if (at >= 0) return 6000 - at - name.length;
  let index = 0, gaps = 0, previous = -1;
  for (const char of target) { const found = name.indexOf(char, index); if (found < 0) return -1; if (previous >= 0) gaps += found - previous - 1; previous = found; index = found + 1; }
  return 1000 - gaps - name.length;
}
// URL links are handled separately. Quoted paths can contain spaces; unquoted
// links require a separator or extension so normal prose is not made clickable.
export function terminalFileLinks(line: string): { text: string; start: number; end: number }[] {
  const pattern = /(?:"[^"\r\n]+"|'[^'\r\n]+')(?::\d+(?::\d+)?)?|[^\s<>"'`|*?]+/g;
  return [...line.matchAll(pattern)].flatMap(match => {
    let text = match[0], start = match.index!;
    if (text.startsWith('(') && text.endsWith(')')) { text = text.slice(1, -1); start++; }
    text = text.replace(/[,;]+$/, '');
    if (/^[\w+.-]+:\/\//.test(text) && !/^file:\/\//i.test(text)) return [];
    if (!/[\\/]/.test(text) && !/\.[A-Za-z][A-Za-z0-9]{0,15}(?:["']|:\d|\(|$)/.test(text)) return [];
    return [{ text, start, end: start + text.length }];
  });
}
