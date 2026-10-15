import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem { label: string; action: () => void; disabled?: boolean; danger?: boolean; separator?: boolean; hint?: string }
export interface TreeMenuTarget { kind: 'project' | 'session'; id: string; x: number; y: number; opener: HTMLElement }
export function ContextMenu({ target, items, onClose }: { target: TreeMenuTarget; items: MenuItem[]; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const box = host.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(target.y, window.innerHeight - box.height - 8)) });
    host.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [target]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...host.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    document.addEventListener('pointerdown', pointer, true); document.addEventListener('keydown', key, true); window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', onClose); queueMicrotask(() => { if (!document.querySelector('[role="dialog"]') && target.opener.isConnected) target.opener.focus(); }); };
  }, [target, onClose]);
  return <div ref={host} role="menu" aria-label={target.kind === 'project' ? '项目操作' : '会话操作'} className="tree-context-menu" style={position}>{items.map(item => <div key={item.label}>{item.separator && <div role="separator" className="menu-separator" />}<button role="menuitem" disabled={item.disabled} className={item.danger ? 'danger-text' : ''} title={item.hint} onClick={() => { onClose(); item.action(); }}>{item.label}</button></div>)}</div>;
}
