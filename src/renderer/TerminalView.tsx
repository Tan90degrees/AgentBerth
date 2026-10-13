import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Attachment, ServerEvent } from '../shared/protocol';

const options = {
  theme: { background: '#0c1017', foreground: '#d5dce8', cursor: '#65dfc0', selectionBackground: '#284446', black: '#19202d', red: '#ee8094', green: '#76d6a5', yellow: '#e3c688', blue: '#82acff', magenta: '#c4a2ef', cyan: '#78d8e5', white: '#d5dce8' },
  fontFamily: 'Cascadia Code, Consolas, Menlo, monospace', fontSize: 14, lineHeight: 1.25, scrollback: 2000, cursorBlink: true,
};

export function TerminalView({ sessionId, fontSize = 14, onError }: { sessionId: string; fontSize?: number; onError: (error: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    const terminal = new Terminal({ ...options, fontSize });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, _url) => { /* External navigation is disabled in the terminal. */ }));
    terminal.open(host.current!);
    let disposed = false;
    let ready = false;
    let runId: string | null = null;
    let running = false;
    let seq = 0;
    let pending: Extract<ServerEvent, { event: 'output' }>['data'][] = [];
    let pendingBytes = 0;
    const apply = (data: Extract<ServerEvent, { event: 'output' }>['data']) => {
      if (data.runId !== runId || data.seq <= seq) return;
      seq = data.seq; terminal.write(data.text);
    };
    const off = window.berth.onEvent(event => {
      if (event.event !== 'output' || event.data.sessionId !== sessionId) return;
      if (!ready) {
        pendingBytes += event.data.text.length;
        if (pendingBytes > 2 * 1024 * 1024) { errorHandler.current('输出过快，请切换会话重新连接'); pending = []; return; }
        pending.push(event.data);
      } else apply(event.data);
    });
    const input = terminal.onData(data => {
      if (ready && running && runId) void window.berth.rpc('input', { sessionId, runId, data }).catch(error => errorHandler.current(String(error)));
    });
    const resize = () => {
      if (disposed || !ready || !host.current?.clientWidth) return;
      fit.fit();
      if (running && runId) void window.berth.rpc('resize', { sessionId, runId, cols: Math.min(300, Math.max(20, terminal.cols)), rows: Math.min(100, Math.max(5, terminal.rows)) }).catch(error => errorHandler.current(String(error)));
    };
    let resizeTimer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 80); });
    observer.observe(host.current!);
    void window.berth.rpc<Attachment>('attach', { sessionId }).then(attachment => {
      if (disposed) return;
      runId = attachment.run?.id ?? null;
      running = attachment.run?.status === 'running';
      seq = attachment.seq;
      terminal.resize(attachment.cols, attachment.rows);
      terminal.write(attachment.snapshot, () => {
        if (disposed) return;
        ready = true;
        for (const event of pending) apply(event);
        pending = [];
        if (!attachment.run) terminal.writeln('\x1b[38;2;119;137;159m会话已就绪。点击“启动终端”，开始这个项目的工作。\x1b[0m');
        resize(); terminal.focus();
      });
    }).catch(error => { if (!disposed) errorHandler.current(String(error)); });
    return () => {
      disposed = true; clearTimeout(resizeTimer); observer.disconnect(); input.dispose(); off(); terminal.dispose();
      void window.berth.rpc('detach', { sessionId }).catch(() => {});
    };
  }, [sessionId, fontSize]);
  return <div className="terminal-host" ref={host} data-testid="terminal" />;
}

export function OutputView({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = new Terminal({ ...options, disableStdin: true, cursorBlink: false });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!); fit.fit(); terminal.write(text);
    const observer = new ResizeObserver(() => fit.fit()); observer.observe(host.current!);
    return () => { observer.disconnect(); terminal.dispose(); };
  }, [text]);
  return <div className="terminal-host output-host" ref={host} />;
}
