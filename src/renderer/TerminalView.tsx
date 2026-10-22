import { isTerminalReply } from '../shared/terminal-replies';
import { memo, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { attachTerminalRenderer } from './terminal-renderer';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Attachment, TerminalEvent, WindowsPty } from '../shared/protocol';
import { inputChunks, terminalDimensions } from '../shared/desktop';
import { useTerminalActions } from './TerminalActions';
import { writeTerminalEvent } from '../shared/terminal-stream';
import { terminalThemes } from '../shared/appearance';
import { useAppearance } from './appearance';
import { bindTerminalPaths } from './terminal-paths';
import { ResizeScheduler } from './terminal-resize';

const options = {
  fontFamily: 'Cascadia Mono, Cascadia Code, Consolas, DejaVu Sans Mono, Liberation Mono, monospace', fontSize: 14, lineHeight: 1.25, scrollback: 2000, cursorBlink: true,
  overviewRuler: { width: 14 },
  minimumContrastRatio: 4.5, customGlyphs: true, rescaleOverlappingGlyphs: true, letterSpacing: 0,
  macOptionClickForcesSelection: true,
  allowProposedApi: true, // Required by xterm's Unicode version provider.
};

function loadWebLinks(terminal: Terminal, onError: (error: string) => void) {
  terminal.loadAddon(new WebLinksAddon((event, url) => {
    if (event.ctrlKey || event.metaKey) void window.berth.openExternal(url).catch(reason => onError(String(reason)));
  }));
}

function proposedSize(fit: FitAddon) {
  const proposed = fit.proposeDimensions();
  return proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows) ? terminalDimensions(proposed.cols, proposed.rows) : null;
}

function fitTerminal(terminal: Terminal, fit: FitAddon) {
  const dimensions = proposedSize(fit);
  if (!dimensions) return null;
  if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) terminal.resize(dimensions.cols, dimensions.rows);
  return dimensions;
}

export const TerminalView = memo(function TerminalView({ sessionId, remoteSession = false, inputEnabled = true, fontSize = 14, autoFocus = true, binaryMouse = true, windowsPty, orderedResize = true, onError, onOpenPath }: { sessionId: string; remoteSession?: boolean; inputEnabled?: boolean; onOpenPath?: (path: string) => void; binaryMouse?: boolean; orderedResize?: boolean; fontSize?: number; autoFocus?: boolean; windowsPty?: WindowsPty; onError: (error: string) => void }) {
  const allowedInput = useRef(inputEnabled); allowedInput.current = inputEnabled;
  const host = useRef<HTMLDivElement>(null);
  const appearance=useAppearance(),palette=useRef(terminalThemes[appearance]),instance=useRef<Terminal|null>(null);palette.current=terminalThemes[appearance];
  useEffect(()=>{if(instance.current){instance.current.options.theme=terminalThemes[appearance];instance.current.refresh(0,instance.current.rows-1);}},[appearance]);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const pathHandler = useRef(onOpenPath); pathHandler.current = onOpenPath;
  useEffect(() => { if (autoFocus && host.current?.clientWidth) instance.current?.focus(); }, [autoFocus]);
  useEffect(() => { if (instance.current) instance.current.options.disableStdin = !inputEnabled; }, [inputEnabled]);
  const mayFocus = useRef(autoFocus); mayFocus.current = autoFocus;
  const { bind, setReady, controls } = useTerminalActions(onError, false, !!windowsPty);
  const inputReady = useRef(false);
  useEffect(() => { setReady(inputEnabled && inputReady.current); }, [inputEnabled, setReady]);
  useEffect(() => {
    const terminal = new Terminal({ ...options, disableStdin: !allowedInput.current, theme: palette.current, fontSize, windowsPty });
    instance.current=terminal;
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    loadWebLinks(terminal, error => errorHandler.current(error));
    terminal.open(host.current!);
    const disposePaths = onOpenPath ? bindTerminalPaths(terminal, path => pathHandler.current?.(path)) : () => {};
    const sizeChanged = terminal.onResize(({ cols, rows }) => {
      if (host.current) { host.current.dataset.cols = String(cols); host.current.dataset.rows = String(rows); }
    });
    let disposed = false;
    let ready = false;
    let runId: string | null = null;
    let running = false;
    const unbind = bind(terminal, () => ready && running && !!runId && allowedInput.current);
    let seq = 0;
    let pending: TerminalEvent[] = [];
    let pendingBytes = 0;
    const apply = (event: TerminalEvent) => {
      if (event.data.runId !== runId || event.data.seq <= seq) return;
      seq = event.data.seq; writeTerminalEvent(terminal, event, () => !disposed);
    };
    const off = window.berth.onEvent(event => {
      if (event.event === 'state' && runId) {
        const latest = event.data.sessions.find(session => session.id === sessionId)?.latestRun;
        running = latest?.id === runId && latest.status === 'running';
        inputReady.current = ready && running; setReady(inputReady.current && allowedInput.current);
      }
      if ((event.event !== 'output' && event.event !== 'resize') || event.data.sessionId !== sessionId) return;
      if (!ready) {
        pendingBytes += event.event === 'output' ? event.data.text.length : 32;
        if (pendingBytes > 2 * 1024 * 1024) { errorHandler.current('输出过快，请切换会话重新连接'); pending = []; return; }
        pending.push(event);
      } else apply(event);
    });
    let inputChain = Promise.resolve(), inputGeneration = 0;
    const sendInput = (data: string, binary = false) => {
      if (remoteSession && !binary && isTerminalReply(data)) return; // The daemon headless terminal owns query responses, including with no UI.
      if (!allowedInput.current || !ready || !running || !runId) return;
      const targetRun = runId, generation = inputGeneration;
      for (const chunk of inputChunks(data)) {
        inputChain = inputChain.then(async () => {
          if (!allowedInput.current || disposed || !ready || !running || targetRun !== runId || generation !== inputGeneration) return;
          await window.berth.rpc('input', { sessionId, runId: targetRun, data: chunk, ...(binary ? { binary: true } : {}) });
        }).catch(reason => { inputGeneration++; if (!disposed) errorHandler.current(String(reason)); });
      }
    };
    const input = terminal.onData(data => sendInput(data));
    const binaryInput = terminal.onBinary(data => {
      if (binaryMouse) sendInput(data, true);
      else if ([...data].every(char => char.charCodeAt(0) < 128)) sendInput(data);
      else errorHandler.current('请在设置中更新后台，以恢复完整的终端鼠标支持');
    });
    let appliedSize: { cols: number; rows: number } | null = null;
    const resize = new ResizeScheduler(() => {
      if (disposed || !ready || !host.current?.clientWidth || !host.current?.clientHeight) return null;
      return proposedSize(fit);
    }, async dimensions => {
      if (!orderedResize || !running || !runId) fitTerminal(terminal, fit);
      if (running && runId && (appliedSize?.cols !== dimensions.cols || appliedSize?.rows !== dimensions.rows)) {
        await window.berth.rpc('resize', { sessionId, runId, ...dimensions });
        // The daemon's boundary arrives before its RPC reply, but xterm parses
        // it asynchronously. Do not start another PTY resize ahead of that grid.
        if (disposed) return;
        await new Promise<void>(resolve => terminal.write('', resolve));
        if (disposed) return;
        appliedSize = { cols: terminal.cols, rows: terminal.rows };
      }
      terminal.refresh(0, terminal.rows - 1);
    }, error => { if (!disposed && running) errorHandler.current(String(error)); });
    const requestResize = () => resize.request();
    const disposeRenderer = attachTerminalRenderer(terminal, host.current!, requestResize, () => new WebglAddon());
    host.current!.dataset.cols = String(terminal.cols); host.current!.dataset.rows = String(terminal.rows);
    const observer = new ResizeObserver(requestResize);
    observer.observe(host.current!);
    // Native window events, sidebar dragging and hidden/visible transitions
    // must use the same bounded path. Never fit directly inside an event storm.
    window.addEventListener('resize', requestResize);
    const metricsChanged = terminal.onResize(size => {
      if (orderedResize) appliedSize = size;
      requestResize();
    });
    void window.berth.rpc<Attachment>('attach', { sessionId }).then(attachment => {
      if (disposed) return;
      runId = attachment.run?.id ?? null;
      running = attachment.run?.status === 'running';
      seq = attachment.seq;
      appliedSize = { cols: attachment.cols, rows: attachment.rows };
      terminal.resize(attachment.cols, attachment.rows);
      terminal.write(attachment.snapshot, () => {
        if (disposed) return;
        ready = true;
        inputReady.current = running; setReady(running && allowedInput.current);
        for (const event of pending) apply(event);
        pending = []; pendingBytes = 0;
        if (!attachment.run) terminal.writeln('\x1b[2m会话已就绪。右键左侧会话，选择“启动终端”。\x1b[0m');
        requestResize();
        const element = document.activeElement;
        if (mayFocus.current && (!element || element === document.body || host.current?.contains(element) || !element.matches('input, select, textarea'))) terminal.focus();
      });
    }).catch(error => { if (!disposed) errorHandler.current(String(error)); });
    void document.fonts.ready.then(() => { if (!disposed) requestResize(); });
    return () => {
      instance.current=null;inputReady.current=false;disposed = true; resize.dispose(); metricsChanged.dispose(); observer.disconnect(); window.removeEventListener('resize', requestResize); disposeRenderer(); disposePaths(); sizeChanged.dispose(); input.dispose(); binaryInput.dispose(); off(); unbind(); terminal.dispose();
      void window.berth.rpc('detach', { sessionId }).catch(() => {});
    };
  }, [sessionId, remoteSession, fontSize, windowsPty, orderedResize, binaryMouse, bind, setReady]);
  return <div className="terminal-surface">{controls}<div className="terminal-host" data-testid="terminal"><div className="terminal-mount" ref={host} /></div></div>;
});

export function OutputView({ text, fontSize = 14, windowsPty, onError }: { text: string; fontSize?: number; windowsPty?: WindowsPty; onError: (error: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const appearance=useAppearance(),palette=useRef(terminalThemes[appearance]),instance=useRef<Terminal|null>(null);palette.current=terminalThemes[appearance];
  useEffect(()=>{if(instance.current){instance.current.options.theme=terminalThemes[appearance];instance.current.refresh(0,instance.current.rows-1);}},[appearance]);
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const { bind, setReady, controls } = useTerminalActions(onError, true, !!windowsPty);
  useEffect(() => {
    const terminal = new Terminal({ ...options, theme: palette.current, fontSize, windowsPty, disableStdin: true, cursorBlink: false });
    instance.current=terminal;
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    const fit = new FitAddon(); terminal.loadAddon(fit); loadWebLinks(terminal, error => errorHandler.current(error)); terminal.open(host.current!);
    const unbind = bind(terminal, () => false);
    let disposed = false;
    const resize = new ResizeScheduler(() => !disposed && host.current?.clientWidth && host.current?.clientHeight ? proposedSize(fit) : null, async () => {
      fitTerminal(terminal, fit); terminal.refresh(0, terminal.rows - 1);
    }, error => { if (!disposed) errorHandler.current(String(error)); });
    const requestResize = () => resize.request();
    const disposeRenderer = attachTerminalRenderer(terminal, host.current!, requestResize, () => new WebglAddon());
    const sizeChanged = terminal.onResize(({cols,rows}) => { if(host.current){host.current.dataset.cols=String(cols);host.current.dataset.rows=String(rows);} });
    host.current!.dataset.cols=String(terminal.cols);host.current!.dataset.rows=String(terminal.rows);
    fitTerminal(terminal, fit); requestResize(); terminal.write(text, () => { if (!disposed) setReady(true); });
    const observer = new ResizeObserver(requestResize); observer.observe(host.current!);
    window.addEventListener('resize', requestResize);
    const metricsChanged = terminal.onResize(requestResize);
    void document.fonts.ready.then(requestResize);
    return () => { instance.current=null;disposed = true; resize.dispose(); metricsChanged.dispose(); observer.disconnect(); window.removeEventListener('resize', requestResize); disposeRenderer(); sizeChanged.dispose(); unbind(); terminal.dispose(); };
  }, [text, fontSize, windowsPty, bind, setReady]);
  return <div className="terminal-surface">{controls}<div className="terminal-host output-host"><div className="terminal-mount" ref={host} /></div></div>;
}
