export interface DiffLine { kind: 'add' | 'remove' | 'context' | 'hunk' | 'meta'; text: string; oldLine?: number; newLine?: number }
export function parseDiff(patch: string, limit = 6000): { lines: DiffLine[]; truncated: boolean } {
  const source = patch.split('\n'); if (source.at(-1) === '') source.pop();
  let oldLine = 0, newLine = 0, inHunk = false;
  const lines = source.slice(0, limit).map((text): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; return { kind: 'hunk', text }; }
    if (text.startsWith('diff --git ')) inHunk = false;
    if (inHunk && text.startsWith('+')) return { kind: 'add', text: text.slice(1), newLine: newLine++ };
    if (inHunk && text.startsWith('-')) return { kind: 'remove', text: text.slice(1), oldLine: oldLine++ };
    if (inHunk && text.startsWith(' ')) return { kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ };
    return { kind: 'meta', text };
  });
  return { lines, truncated: source.length > limit };
}
