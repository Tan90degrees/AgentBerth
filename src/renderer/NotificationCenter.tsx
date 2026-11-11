import { useCallback, useEffect, useRef, useState } from 'react';
import type { Notice } from './notice-queue';
import './notification-center.css';

export function NotificationCenter({ notices, open: controlledOpen, onOpenChange, onDismiss, onClear, onCopy }: { notices: Notice[]; open?: boolean; onOpenChange?: (open: boolean) => void; onDismiss: (id: number) => void; onClear: () => void; onCopy: (text: string) => void }) {
  const [localOpen, setLocalOpen] = useState(false), [seen, setSeen] = useState(0), [visible, setVisible] = useState(100);
  const controlled = controlledOpen !== undefined, open = controlledOpen ?? localOpen;
  const setOpen = useCallback((value: boolean) => { if (!controlled) setLocalOpen(value); onOpenChange?.(value); }, [controlled, onOpenChange]);
  const host = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announced=useRef(0);
  const latest = notices.at(-1)?.id ?? 0, unread = notices.filter(item => item.id > seen).length;
  useEffect(() => {
    if (!latest) { clearTimeout(timer.current); setOpen(false); return; }
    if(latest<=announced.current)return;announced.current=latest;
    setOpen(true); clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 5000);
  }, [latest, setOpen]);
  useEffect(() => () => { clearTimeout(timer.current); announced.current = 0; }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open, setOpen]);
  return <div ref={host} className="notification-center">
    <button type="button" className="workbench-control notification-toggle" title="通知与告警" aria-label={`通知中心${unread ? `，${unread} 条未读` : ''}`} aria-expanded={open} aria-controls="notification-panel" onClick={() => { clearTimeout(timer.current); setOpen(!open); setSeen(latest); }}>
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h12l-2-3V7a4 4 0 0 0-8 0v4l-2 3Zm4 2a2 2 0 0 0 4 0" /></svg><span className="workbench-control-label">通知</span>{unread > 0 && <span className="notification-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
    <span className="notification-announcement" role={notices.at(-1)?.level === 'error' ? 'alert' : 'status'}>{notices.at(-1)?.text}</span>
    {open && <section id="notification-panel" className="notification-panel" aria-label="通知与告警" data-native-overlay="notifications">
      <header><strong>通知与告警</strong><button type="button" onClick={onClear} disabled={!notices.length}>清空</button><button type="button" aria-label="收起通知中心" onClick={() => setOpen(false)}>×</button></header>
      {!notices.length ? <p className="muted">暂无通知</p> : <ol>{notices.slice(-visible).reverse().map(item => <li key={item.id} className={`notification-item ${item.level ?? 'info'}`}>
        <div className="notification-meta"><span>{item.level === 'error' ? '错误' : item.level === 'warning' ? '告警' : '信息'}</span>{item.at && <time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleTimeString()}</time>}</div>
        <p>{item.text}</p><div className="notification-actions">{item.action && <button type="button" onClick={() => { item.action!.onAction(); onDismiss(item.id); }}>{item.action.label}</button>}<button type="button" onClick={() => onCopy(item.text)}>复制</button><button type="button" onClick={() => onDismiss(item.id)} aria-label="关闭提示">移除</button></div>
      </li>)}</ol>}
      {notices.length > visible && <button type="button" onClick={() => setVisible(value => value + 100)}>加载更早通知（还有 {notices.length - visible} 条）</button>}
    </section>}
  </div>;
}
