import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal, IDisposable } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';

interface Owner { terminal: Terminal; search: SearchAddon; canPaste: () => boolean; disposed: boolean; subscriptions: IDisposable[] }
export function useTerminalActions(onError: (error: string) => void, readOnly = false) {
  const owner = useRef<Owner | null>(null);
  const error = useRef(onError); error.current = onError;
  const input = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [found, setFound] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 2200); return () => clearTimeout(timer); }, [message]);

  const copy = useCallback(async () => {
    const current = owner.current, text = current?.terminal.getSelection();
    if (!current || current.disposed) return;
    if (!text) { setMessage('请先选中文本'); return; }
    try { await window.berth.copyText(text); if (!current.disposed) setMessage('已复制选中文本'); }
    catch (reason) { if (!current.disposed) error.current(String(reason)); }
  }, []);
  const paste = useCallback(async () => {
    const current = owner.current;
    if (!current || current.disposed || !current.canPaste()) return;
    try {
      setMessage('正在读取剪贴板…');
      const text = await window.berth.readClipboard();
      // A pending clipboard request must never paste into a switched/stopped run.
      if (current.disposed || owner.current !== current || !current.canPaste()) return;
      if (!text) { setMessage('剪贴板没有文字'); return; }
      current.terminal.paste(text); current.terminal.focus(); setMessage('已粘贴');
    } catch (reason) { if (!current.disposed) error.current(String(reason)); }
  }, []);
  const openSearch = useCallback(() => { setSearchOpen(true); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); }, []);
  const bind = useCallback((terminal: Terminal, canPaste: () => boolean) => {
    const search = new SearchAddon(); terminal.loadAddon(search);
    const current: Owner = { terminal, search, canPaste, disposed: false, subscriptions: [] };
    owner.current = current; setReady(false); setSelection(false); setFound(null);
    current.subscriptions.push(terminal.onSelectionChange(() => { if (!current.disposed) setSelection(terminal.hasSelection()); }));
    terminal.attachCustomKeyEventHandler(event => {
      if (event.defaultPrevented) return false;
      if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || !event.shiftKey) return true;
      const key = event.key.toLowerCase();
      if (!['c', 'v', 'f'].includes(key)) return true;
      if (event.type === 'keydown') {
        event.preventDefault(); event.stopPropagation();
        if (key === 'c') void copy(); else if (key === 'v') void paste(); else openSearch();
      }
      return false;
    });
    return () => {
      current.disposed = true; current.subscriptions.forEach(subscription => subscription.dispose());
      if (owner.current === current) owner.current = null;
      // Terminal disposal also disposes its search addon.
    };
  }, [copy, paste, openSearch]);
  useEffect(() => {
    if (!searchOpen || !ready) return;
    const timer = setTimeout(() => {
      const current = owner.current;
      if (!current || current.disposed) return;
      setFound(query ? current.search.findNext(query, { incremental: true, caseSensitive }) : null);
      if (!query) { current.search.clearDecorations(); current.terminal.clearSelection(); }
    }, 100);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, searchOpen, ready]);
  const find = (previous: boolean) => {
    const current = owner.current;
    if (!current || !query) return;
    setFound(previous ? current.search.findPrevious(query, { caseSensitive }) : current.search.findNext(query, { caseSensitive }));
  };
  const closeSearch = () => { setSearchOpen(false); setFound(null); owner.current?.search.clearDecorations(); owner.current?.terminal.clearSelection(); owner.current?.terminal.focus(); };
  const controls = <>
    {!searchOpen && <div className="terminal-toolbar" aria-label={readOnly ? '输出操作' : '终端操作'}>
      <span className="terminal-tool-status" role="status" title="选中文字后复制；Ctrl+点击打开网页链接">{message || (readOnly ? '只读输出' : '选中文字后可复制')}</span>
      <button disabled={!selection} onMouseDown={event => event.preventDefault()} onClick={() => void copy()} title="Ctrl+Shift+C">复制选中</button>
      {!readOnly && <button disabled={!ready} onClick={() => void paste()} title="Ctrl+Shift+V">粘贴</button>}
      <button disabled={!ready} onClick={openSearch} title="Ctrl+Shift+F">查找</button>
      <button disabled={!ready} onClick={() => { owner.current?.terminal.scrollToBottom(); owner.current?.terminal.focus(); }}>到底部</button>
    </div>}
    {searchOpen && <div className="terminal-search" role="search" aria-label="终端查找">
      <input ref={input} autoFocus aria-label="查找终端文字" placeholder="查找当前保留的输出…" value={query} maxLength={256} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); }
        if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey); }
      }} />
      <button className={caseSensitive ? 'enabled' : ''} aria-label="区分大小写" aria-pressed={caseSensitive} onClick={() => setCaseSensitive(value => !value)}>Aa</button>
      <button aria-label="上一个匹配" disabled={!query} onClick={() => find(true)}>↑</button><button aria-label="下一个匹配" disabled={!query} onClick={() => find(false)}>↓</button>
      <span role="status" title={message}>{found === null ? '' : found ? '已定位' : '未找到'}</span>
      <button disabled={!selection} onMouseDown={event => event.preventDefault()} onClick={() => void copy()} title={message === '已复制选中文本' ? message : 'Ctrl+Shift+C'}>复制选中</button>
      <button aria-label="关闭终端查找" onClick={closeSearch}>×</button>
    </div>}
  </>;
  return { bind, setReady, controls };
}
