import { memo, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Attachment, ServerEvent, WindowsPty } from '../shared/protocol';
import { inputChunks, terminalDimensions } from '../shared/desktop';
import { useTerminalActions } from './TerminalActions';

const options = {
  theme: { background: '#0c1017', foreground: '#d5dce8', cursor: '#65dfc0', selectionBackground: '#284446', black: '#19202d', red: '#ee8094', green: '#76d6a5', yellow: '#e3c688', blue: '#82acff', magenta: '#c4a2ef', cyan: '#78d8e5', white: '#d5dce8' },
  fontFamily: 'Cascadia Code, Consolas, Menlo, monospace', fontSize: 14, lineHeight: 1.25, scrollback: 2000, cursorBlink: true,
  overviewRuler: { width: 14 },
  allowProposedApi: true, // Required by xterm's Unicode version provider.
};

function loadWebLinks(terminal: Terminal, onError: (error: string) => void) {
  terminal.loadAddon(new WebLinksAddon((event, url) => {
    if (event.ctrlKey || event.metaKey) void window.berth.openExternal(url).catch(reason => onError(String(reason)));
  }));
}

function fitTerminal(terminal: Terminal, fit: FitAddon) {
  const proposed = fit.proposeDimensions();
  if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
  const dimensions = terminalDimensions(proposed.cols, proposed.rows);
  if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) terminal.resize(dimensions.cols, dimensions.rows);
  return dimensions;
}

export const TerminalView = memo(function TerminalView({ sessionId, fontSize = 14, autoFocus = true, windowsPty, onError }: { sessionId: string; fontSize?: number; autoFocus?: boolean; windowsPty?: WindowsPty; onError: (error: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const mayFocus = useRef(autoFocus); mayFocus.current = autoFocus;
  const { bind, setReady, controls } = useTerminalActions(onError);
  useEffect(() => {
    const terminal = new Terminal({ ...options, fontSize, windowsPty });
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    loadWebLinks(terminal, error => errorHandler.current(error));
    terminal.open(host.current!);
    let disposed = false;
    let ready = false;
    let runId: string | null = null;
    let running = false;
    const unbind = bind(terminal, () => ready && running && !!runId);
    let seq = 0;
    let pending: Extract<ServerEvent, { event: 'output' }>['data'][] = [];
    let pendingBytes = 0;
    const apply = (data: Extract<ServerEvent, { event: 'output' }>['data']) => {
      if (data.runId !== runId || data.seq <= seq) return;
      seq = data.seq; terminal.write(data.text);
    };
    const off = window.berth.onEvent(event => {
      if (event.event === 'state' && runId) {
        const latest = event.data.sessions.find(session => session.id === sessionId)?.latestRun;
        running = latest?.id === runId && latest.status === 'running';
        setReady(ready && running);
      }
      if (event.event !== 'output' || event.data.sessionId !== sessionId) return;
      if (!ready) {
        pendingBytes += event.data.text.length;
        if (pendingBytes > 2 * 1024 * 1024) { errorHandler.current('输出过快，请切换会话重新连接'); pending = []; return; }
        pending.push(event.data);
      } else apply(event.data);
    });
    let inputChain = Promise.resolve(), inputGeneration = 0;
    const input = terminal.onData(data => {
      if (!ready || !running || !runId) return;
      const targetRun = runId, generation = inputGeneration;
      for (const chunk of inputChunks(data)) {
        inputChain = inputChain.then(async () => {
          if (disposed || !ready || !running || targetRun !== runId || generation !== inputGeneration) return;
          await window.berth.rpc('input', { sessionId, runId: targetRun, data: chunk });
        }).catch(reason => { inputGeneration++; if (!disposed) errorHandler.current(String(reason)); });
      }
    });
    let lastCols = 0, lastRows = 0;
    const resize = () => {
      if (disposed || !ready || !host.current?.clientWidth) return;
      const dimensions = fitTerminal(terminal, fit);
      if (!dimensions) return;
      const { cols, rows } = dimensions;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols; lastRows = rows;
      if (running && runId) void window.berth.rpc('resize', { sessionId, runId, cols, rows }).catch(error => { if (!disposed && running) errorHandler.current(String(error)); });
    };
    let resizeTimer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 80); });
    observer.observe(host.current!);
    void window.berth.rpc<Attachment>('attach', { sessionId }).then(attachment => {
      if (disposed) return;
      runId = attachment.run?.id ?? null;
      running = attachment.run?.status === 'running';
      seq = attachment.seq;
      lastCols = attachment.cols; lastRows = attachment.rows;
      terminal.resize(attachment.cols, attachment.rows);
      terminal.write(attachment.snapshot, () => {
        if (disposed) return;
        ready = true;
        setReady(running);
        for (const event of pending) apply(event);
        pending = [];
        if (!attachment.run) terminal.writeln('\x1b[38;2;119;137;159m会话已就绪。点击“启动终端”，开始这个项目的工作。\x1b[0m');
        resize();
        const element = document.activeElement;
        if (mayFocus.current && (!element || element === document.body || host.current?.contains(element) || !element.matches('input, select, textarea'))) terminal.focus();
      });
    }).catch(error => { if (!disposed) errorHandler.current(String(error)); });
    return () => {
      disposed = true; clearTimeout(resizeTimer); observer.disconnect(); input.dispose(); off(); unbind(); terminal.dispose();
      void window.berth.rpc('detach', { sessionId }).catch(() => {});
    };
  }, [sessionId, fontSize, windowsPty, bind, setReady]);
  return <div className="terminal-surface">{controls}<div className="terminal-host" data-testid="terminal"><div className="terminal-mount" ref={host} /></div></div>;
});

export function OutputView({ text, fontSize = 14, windowsPty, onError }: { text: string; fontSize?: number; windowsPty?: WindowsPty; onError: (error: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const { bind, setReady, controls } = useTerminalActions(onError, true);
  useEffect(() => {
    const terminal = new Terminal({ ...options, fontSize, windowsPty, disableStdin: true, cursorBlink: false });
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    const fit = new FitAddon(); terminal.loadAddon(fit); loadWebLinks(terminal, error => errorHandler.current(error)); terminal.open(host.current!);
    const unbind = bind(terminal, () => false);
    let disposed = false, resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => { if (!disposed) fitTerminal(terminal, fit); };
    resize(); terminal.write(text, () => { if (!disposed) setReady(true); });
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 80); }); observer.observe(host.current!);
    return () => { disposed = true; clearTimeout(resizeTimer); observer.disconnect(); unbind(); terminal.dispose(); };
  }, [text, fontSize, windowsPty, bind, setReady]);
  return <div className="terminal-surface">{controls}<div className="terminal-host output-host"><div className="terminal-mount" ref={host} /></div></div>;
}
