import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

interface AcceleratedRenderer extends ITerminalAddon { onContextLoss(listener: () => void): IDisposable }

// Keep the parser, buffer and PTY alive when graphics acceleration is unavailable.
// DOM uses font glyphs, so remove added row spacing on that fallback path.
export function attachTerminalRenderer(terminal: Terminal, host: HTMLElement, refit: () => void, create: () => AcceleratedRenderer): () => void {
  let addon: AcceleratedRenderer | null = null, loss: IDisposable | null = null, disposed = false, fallback = false;
  const useDom = () => {
    if (disposed || fallback) return;
    fallback = true;
    loss?.dispose(); loss = null;
    const old = addon; addon = null;
    old?.dispose();
    terminal.options.lineHeight = 1;
    host.dataset.renderer = 'dom';
    terminal.refresh(0, terminal.rows - 1);
    refit();
  };
  try {
    addon = create();
    loss = addon.onContextLoss(useDom);
    terminal.loadAddon(addon);
    host.dataset.renderer = 'webgl';
  } catch { useDom(); }
  return () => {
    disposed = true; loss?.dispose(); loss = null;
    addon?.dispose(); addon = null;
    delete host.dataset.renderer;
  };
}
