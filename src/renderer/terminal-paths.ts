import type { IBuffer, Terminal } from '@xterm/xterm';
import { terminalFileLinks } from '../shared/file-navigation';

export interface PathLink { text: string; start: { x: number; y: number }; end: { x: number; y: number } }
export function terminalPathRanges(buffer: IBuffer, row: number): PathLink[] {
  let first = row - 1, last = row - 1;
  while (first > 0 && row - first <= 8 && buffer.getLine(first)?.isWrapped) first--;
  while (last - first < 8 && buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  const offsets: { x: number; y: number; width: number }[] = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y); if (!line) continue;
    // A wide character wrapping with one cell left creates an empty padding
    // cell. It is not a space in the printed path; keep actual space cells.
    let columns = line.length;
    if (y < last) while (columns > 0 && line.getCell(columns - 1)?.getWidth() === 1 && !line.getCell(columns - 1)?.getChars()) columns--;
    const rendered = line.translateToString(y === last, 0, columns); let offset = text.length;
    for (let col = 0; col < columns; col++) {
      const cell = line.getCell(col); if (!cell?.getWidth()) continue;
      const chars = cell.getChars() || ' ';
      for (let i = 0; i < chars.length; i++) offsets[offset++] = { x: col + 1, y: y + 1, width: cell.getWidth() };
    }
    text += rendered;
  }
  return terminalFileLinks(text).flatMap(link => {
    const start = offsets[link.start], end = offsets[link.end - 1];
    return start && end && start.y <= row && end.y >= row ? [{ text: link.text, start, end: { x: end.x + end.width - 1, y: end.y } }] : [];
  });
}

/** File paths are intentionally absent from xterm's link provider: that provider
 * changes ordinary double-click selection even when activation is disabled. */
export function bindTerminalPaths(terminal: Terminal, open: (path: string) => void): () => void {
  const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!;
  const layer = document.createElement('div'); layer.className = 'terminal-path-hints'; screen.appendChild(layer);
  const mac = /Mac/.test(navigator.platform);
  const modifier = (event: MouseEvent | KeyboardEvent) => (event.ctrlKey || mac && event.metaKey) && !event.altKey;
  let point: { x: number; y: number } | null = null, enabled = false, modifierHeld = false, hovered: PathLink | undefined, pressed: string | undefined;
  const clear = () => { hovered = undefined; layer.replaceChildren(); screen.classList.remove('terminal-path-active'); };
  const update = () => {
    clear();
    if (!enabled || !point || !screen.clientWidth || !screen.clientHeight) return;
    const box = screen.getBoundingClientRect(), cw = box.width / terminal.cols, ch = box.height / terminal.rows;
    const x = Math.floor((point.x - box.left) / cw) + 1, viewportRow = Math.floor((point.y - box.top) / ch);
    if (x < 1 || x > terminal.cols || viewportRow < 0 || viewportRow >= terminal.rows) return;
    const row = terminal.buffer.active.viewportY + viewportRow + 1;
    hovered = terminalPathRanges(terminal.buffer.active, row).find(link => x >= (row === link.start.y ? link.start.x : 1) && x <= (row === link.end.y ? link.end.x : terminal.cols));
    if (!hovered) return;
    screen.classList.add('terminal-path-active');
    for (let y = Math.max(hovered.start.y, terminal.buffer.active.viewportY + 1); y <= Math.min(hovered.end.y, terminal.buffer.active.viewportY + terminal.rows); y++) {
      const start = y === hovered.start.y ? hovered.start.x : 1, end = y === hovered.end.y ? hovered.end.x : terminal.cols;
      const hint = document.createElement('div'); hint.className = 'terminal-path-underline';
      Object.assign(hint.style, { left: `${(start - 1) * cw}px`, top: `${(y - terminal.buffer.active.viewportY) * ch - 1}px`, width: `${(end - start + 1) * cw}px` }); layer.appendChild(hint);
    }
  };
  const move = (event: MouseEvent) => { point = { x: event.clientX, y: event.clientY }; enabled = modifierHeld && modifier(event); update(); if (hovered && event.type === 'mousemove') event.stopPropagation(); };
  const key = (event: KeyboardEvent) => {
    // Mouse modifier flags can survive a missed key-up across native focus changes.
    // Activation requires a modifier press observed in this focused window too.
    const physicalModifier = event.ctrlKey || mac && event.metaKey;
    if (event.type === 'keydown' && (event.key === 'Control' || mac && event.key === 'Meta')) modifierHeld = physicalModifier;
    else if (!physicalModifier) modifierHeld = false;
    const next = modifierHeld && modifier(event);
    if (next !== enabled) { enabled = next; update(); }
  };
  const leave = () => { point = null; pressed = undefined; clear(); };
  const blur = () => { modifierHeld = false; enabled = false; leave(); };
  const down = (event: MouseEvent) => { move(event); pressed = hovered?.text; if (event.button === 0 && hovered) { event.preventDefault(); event.stopPropagation(); } };
  const up = (event: MouseEvent) => {
    move(event);
    if (event.button === 0 && hovered && pressed === hovered.text) { event.preventDefault(); event.stopPropagation(); open(hovered.text); }
    pressed = undefined;
  };
  screen.addEventListener('mousemove', move, true); screen.addEventListener('mouseleave', leave);
  screen.addEventListener('mousedown', down, true); screen.addEventListener('mouseup', up, true);
  window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true); window.addEventListener('blur', blur);
  const render = terminal.onRender(() => { if (enabled && point) update(); });
  return () => {
    render.dispose(); clear(); layer.remove(); screen.removeEventListener('mousemove', move, true); screen.removeEventListener('mouseleave', leave);
    screen.removeEventListener('mousedown', down, true); screen.removeEventListener('mouseup', up, true);
    window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true); window.removeEventListener('blur', blur);
  };
}
