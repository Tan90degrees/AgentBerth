import type { IBufferLine, Terminal } from '@xterm/xterm';

interface CellPosition { x: number; y: number; width: number }
interface TextRow { text: string; cells: CellPosition[] }
interface TextSource { cols: number; buffer: { active: { length: number; getLine(y: number): IBufferLine | undefined } } }
interface SearchOptions { incremental?: boolean; caseSensitive?: boolean }
interface Match { text: string; start: CellPosition; end: CellPosition }

function marginWrap(previous: IBufferLine, next: IBufferLine, cols: number) {
  const tail = previous.getCell(cols - 1), before = previous.getCell(cols - 2);
  if (!tail) return false;
  // ConPTY can emit CR/LF for a display wrap without xterm's isWrapped flag.
  if (tail.getWidth() === 0 && before?.getWidth() === 2) return true;
  if (tail.getChars() && !/\s$/.test(tail.getChars())) return true;
  // A wide glyph at the next row can leave one empty padding cell.
  const emptyTail = !tail.getChars() || /^\s+$/.test(tail.getChars());
  return emptyTail && !!before && (before.getWidth() === 0 || !!before.getChars().trim()) && next.getCell(0)?.getWidth() === 2;
}

export function terminalTextRows(source: TextSource, inferWindowsWrap = false): TextRow[] {
  const { active } = source.buffer, rows: TextRow[] = [];
  const wrapped = (y: number) => {
    const line = active.getLine(y), previous = active.getLine(y - 1);
    return !!line && (line.isWrapped || (inferWindowsWrap && !!previous && marginWrap(previous, line, source.cols)));
  };
  for (let y = 0; y < active.length; y++) {
    const line = active.getLine(y);
    if (!line) continue;
    if (!wrapped(y) || !rows.length) rows.push({ text: '', cells: [] });
    const row = rows.at(-1)!;
    let end = source.cols;
    if (!wrapped(y + 1)) {
      while (end > 0) {
        const cell = line.getCell(end - 1);
        if (cell?.getWidth() === 0 || (cell?.getChars() && !/\s$/.test(cell.getChars()))) break;
        end--;
      }
    } else {
      const tail = line.getCell(end - 1), next = active.getLine(y + 1);
      if (tail?.getWidth() === 1 && (!tail.getChars() || (inferWindowsWrap && !tail.getChars().trim())) && next?.getCell(0)?.getWidth() === 2) end--;
    }
    for (let x = 0; x < end; x++) {
      const cell = line.getCell(x), width = cell?.getWidth() ?? 1;
      if (!width) continue;
      const text = cell?.getChars() || ' ';
      row.text += text;
      for (let index = 0; index < text.length; index++) row.cells.push({ x, y, width });
    }
  }
  return rows;
}

const compare = (a: { x: number; y: number }, b: { x: number; y: number }) => a.y - b.y || a.x - b.x;
export class TerminalSearch {
  private cache: TextRow[] | null = null;
  private selected: { text: string; position: ReturnType<Terminal['getSelectionPosition']> } | null = null;
  private subscriptions;
  constructor(private terminal: Terminal, private inferWindowsWrap = false) {
    const invalidate = () => { this.cache = null; this.selected = null; };
    this.subscriptions = [terminal.onWriteParsed(invalidate), terminal.onResize(invalidate)];
  }
  dispose() { this.subscriptions.forEach(subscription => subscription.dispose()); }
  clearDecorations() { this.selected = null; this.terminal.clearSelection(); }
  selectionText() {
    const position = this.terminal.getSelectionPosition(), selected = this.selected;
    if (position && selected?.position && !compare(position.start, selected.position.start) && !compare(position.end, selected.position.end)) return selected.text;
    return this.terminal.getSelection();
  }
  findNext(term: string, options: SearchOptions = {}) { return this.find(term, options, false); }
  findPrevious(term: string, options: SearchOptions = {}) { return this.find(term, options, true); }
  private find(term: string, options: SearchOptions, previous: boolean): boolean {
    if (!term) { this.clearDecorations(); return false; }
    this.cache ??= terminalTextRows(this.terminal, this.inferWindowsWrap);
    const pattern = new RegExp(term.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&'), options.caseSensitive ? 'gu' : 'giu');
    const matches: Match[] = [];
    for (const row of this.cache) {
      for (const match of row.text.matchAll(pattern)) {
        const start = row.cells[match.index], last = row.cells[match.index + match[0].length - 1];
        if (start && last) matches.push({ text: match[0], start, end: { ...last, x: last.x + last.width } });
      }
    }
    const selection = this.terminal.getSelectionPosition();
    const anchor = selection && (previous || options.incremental ? selection.start : selection.end);
    const match = previous ? (anchor && matches.findLast(match => compare(match.start, anchor) < 0)) || matches.at(-1) : (anchor && matches.find(match => compare(match.start, anchor) >= 0)) || matches[0];
    if (!match) { this.clearDecorations(); return false; }
    const size = (match.end.y - match.start.y) * this.terminal.cols + match.end.x - match.start.x;
    this.terminal.select(match.start.x, match.start.y, size);
    this.selected = { text: match.text, position: this.terminal.getSelectionPosition() };
    const { viewportY } = this.terminal.buffer.active;
    if (match.start.y < viewportY || match.end.y >= viewportY + this.terminal.rows) this.terminal.scrollToLine(Math.max(0, match.start.y - Math.floor(this.terminal.rows / 2)));
    return true;
  }
}
