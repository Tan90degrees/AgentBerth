import { createElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FilePreview as Preview } from '../shared/protocol';
import { fileLanguage, fileSize, isMarkdown, previewLink } from '../shared/file-preview';
import { highlightCode } from './syntax';
import HighlightWorker from './highlight-worker?worker&inline';

let imageReaders = 0;
const waitingImages: (() => void)[] = [];
async function localImage(projectId: string, path: string, cancelled: () => boolean): Promise<Preview | null> {
  if (imageReaders < 1) imageReaders++;
  else await new Promise<void>(resolve => waitingImages.push(resolve));
  try { return cancelled() ? null : await window.berth.rpc<Preview>('previewFile', { projectId, path }); }
  finally { const next = waitingImages.shift(); if (next) next(); else imageReaders--; }
}

function textOf(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  return isValidElement<{ children?: ReactNode }>(value) ? textOf(value.props.children) : '';
}
function heading(level: number): Components['h1'] {
  return ({ children }) => createElement(`h${level}`, { id: textOf(children).trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/\s+/g, '-') }, children);
}
function MarkdownCode({ children, className }: { children?: ReactNode; className?: string }) {
  const language = /language-([\w+-]+)/.exec(className ?? '')?.[1];
  const text = textOf(children);
  const html = useMemo(() => language && text.length <= 16000 ? highlightCode(text, language) : null, [text, language]);
  return html === null ? <code className={className}>{children}</code> : <code className={`hljs ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
function MarkdownImage({ src, alt, projectId, path }: { src?: string; alt?: string; projectId: string; path: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const local = previewLink(path, src ?? '');
  useEffect(() => {
    let cancelled = false;
    setImage(null); setFailed(false);
    if (!src || !local) return;
    void localImage(projectId, local.path, () => cancelled).then(value => {
      if (!cancelled) { setImage(value?.kind === 'image' ? value.content : null); setFailed(value?.kind !== 'image'); }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [src, projectId, local?.path]);
  if (image) return <img src={image} alt={alt ?? ''} loading="lazy" onError={() => { setImage(null); setFailed(true); }} />;
  if (src && /^https?:\/\//i.test(src)) return <a href={src} onClick={event => { event.preventDefault(); void window.berth.openExternal(src).catch(() => {}); }}>外部图片：{alt || src}</a>;
  return <span className="markdown-image-placeholder">{failed ? '无法预览图片' : '图片'}{alt ? `：${alt}` : ''}</span>;
}
export function MarkdownDocument({ content, projectId, path, onNavigate, onError }: { content: string; projectId: string; path: string; onNavigate: (path: string, anchor?: string) => void; onError: (error: string) => void }) {
  const components = useMemo<Components>(() => ({
    h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6), code: MarkdownCode,
    img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} projectId={projectId} path={path} />,
    a: ({ href, children }) => !href ? <span>{children}</span> : <a href={href} onClick={event => {
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) { void window.berth.openExternal(href).catch(error => onError(String(error))); return; }
      const target = previewLink(path, href);
      if (target) onNavigate(target.path, target.anchor); else onError('此链接无法在项目中打开');
    }}>{children}</a>,
  }), [projectId, path, onNavigate, onError]);
  return <article className="markdown-document"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{content}</Markdown></article>;
}
function CodePreview({ text, filename, position }: { text: string; filename: string; position?: { line: number; column: number; nonce: number } | null }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position || !host.current) return;
    const row = Math.min(position.line, text.split('\n').length), lineHeight = 20.4;
    host.current.scrollTop = Math.max(0, (row - 1) * lineHeight - host.current.clientHeight / 3);
    host.current.scrollLeft = Math.max(0, (position.column - 1) * 7.2 - host.current.clientWidth / 2);
    host.current.dataset.location = `${row}:${position.column}`;
  }, [text, position]);
  const [highlighted, setHighlighted] = useState<{ text: string; html: string } | null>(null);
  const language = fileLanguage(filename);
  useEffect(() => {
    setHighlighted(null);
    if (!text || language === 'plaintext') return;
    let worker: Worker;
    try {
      worker = new HighlightWorker();
      worker.onmessage = event => { setHighlighted({ text, html: String(event.data) }); worker.terminate(); };
      worker.onerror = () => worker.terminate();
      worker.postMessage({ text, language });
    } catch { return; }
    return () => worker.terminate();
  }, [text, language]);
  const lineNumbers = useMemo(() => Array.from({ length: text.split('\n').length }, (_, index) => index + 1), [text]);
  const targetLine = position ? Math.min(position.line, lineNumbers.length) : 0;
  return <div ref={host} className="source-preview" tabIndex={0} aria-label="文件源码"><pre className="source-lines" aria-hidden="true">{lineNumbers.map(line => <span key={line} className={line === targetLine ? 'source-target-line' : ''}>{line}{'\n'}</span>)}</pre><pre className="source-code" style={targetLine ? { backgroundImage: 'linear-gradient(var(--selected), var(--selected))', backgroundSize: '100% 20.4px', backgroundPosition: `0 ${14 + (targetLine - 1) * 20.4}px`, backgroundRepeat: 'no-repeat' } : undefined}>{highlighted?.text === text ? <code className="hljs" data-language={language} dangerouslySetInnerHTML={{ __html: highlighted.html }} /> : <code data-language={language}>{text}</code>}</pre></div>;
}
export default function FilePreview({ position, file, projectId, markdown, onMarkdown, onNavigate, onRefresh, onError }: { position?: { path: string; line: number; column: number; nonce: number } | null; file: Preview; projectId: string; markdown: boolean; onMarkdown: (value: boolean) => void; onNavigate: (path: string, anchor?: string) => void; onRefresh: () => void; onError: (error: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [file.path]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);
  return <>
    <div className="file-preview-tools">
      <span className="file-relative-path" title={file.path}>{file.path}</span>
      {file.kind === 'text' && isMarkdown(file.name) && <div className="file-preview-modes" role="group" aria-label="Markdown 预览方式"><button aria-pressed={!markdown} onClick={() => onMarkdown(false)}>源码</button><button aria-pressed={markdown} onClick={() => onMarkdown(true)}>渲染</button></div>}
      {file.kind === 'text' && <button title="复制当前预览的内容" onClick={() => { void window.berth.copyText(file.content ?? '').then(() => setCopied(true)).catch(error => onError(String(error))); }}>{copied ? '已复制' : '复制内容'}</button>}
      {position?.path === file.path && <span title="终端跳转位置">{position.line}:{position.column}</span>}
      <span>{fileSize(file.size)}</span><button className="icon-button" aria-label="刷新文件预览" title="重新读取当前文件" onClick={onRefresh}>↻</button>
    </div>
    {file.truncated && <p className="file-preview-notice" role="status">文件较大，仅预览开头部分内容。</p>}
    {file.kind === 'text' ? markdown && isMarkdown(file.name) ? <div className="markdown-scroll"><MarkdownDocument content={file.content ?? ''} projectId={projectId} path={file.path} onNavigate={onNavigate} onError={onError} /></div> : <CodePreview position={position?.path === file.path ? position : null} text={file.content ?? ''} filename={file.name} /> : file.kind === 'image' ? <div className="image-preview"><img src={file.content ?? ''} alt={file.name} /><span>{file.name}</span></div> : <div className="file-preview-empty"><span>无法直接预览</span><p>{file.message ?? '此文件不是可预览的文本或图片。'}</p><small>{fileSize(file.size)}</small></div>}
  </>;
}
