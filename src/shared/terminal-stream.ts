import type { TerminalEvent } from './protocol';

interface Grid {
  write(text: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
}

// xterm writes are asynchronous. A size boundary belongs inside the same write
// queue, so output before/after it is parsed against the matching grid.
export function writeTerminalEvent(grid: Grid, event: TerminalEvent, alive: () => boolean): void {
  if (event.event === 'output') grid.write(event.data.text);
  else grid.write('', () => { if (alive()) grid.resize(event.data.cols, event.data.rows); });
}
