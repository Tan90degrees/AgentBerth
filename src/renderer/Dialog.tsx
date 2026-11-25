import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Dialog({ title, children, onClose, busy = false, dirty = false, error = '', returnFocus, variant }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; dirty?: boolean; error?: string; returnFocus?: HTMLElement | null; variant?: 'acp' | 'acp-wide';
}) {
  const host = useRef<HTMLElement>(null);
  const [closing, setClosing] = useState(false);
  const closingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const current = useRef({ onClose, busy, dirty, confirming }); current.current = { onClose, busy, dirty, confirming };
  const dismiss = () => {
    if (!variant || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      current.current.onClose();
    } else if (!closingTimer.current) {
      setClosing(true);
      closingTimer.current = setTimeout(() => current.current.onClose(), 140);
    }
  };
  const requestClose = () => {
    if (current.current.busy || closingTimer.current) return;
    if (current.current.confirming) setConfirming(false);
    else if (current.current.dirty) setConfirming(true);
    else dismiss();
  };
  useEffect(() => {
    const focusable = () => Array.from(host.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0 && !element.matches(':disabled') && !element.closest('[inert]'));
    if (!host.current?.contains(document.activeElement)) (focusable().find(element => element.matches('input:not([type=hidden]), select, textarea')) ?? focusable()[0])?.focus();
    const key = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== host.current) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (current.current.confirming) setConfirming(false); else requestClose();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || !host.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !host.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(closingTimer.current); closingTimer.current = undefined; document.removeEventListener('keydown', key, true); queueMicrotask(() => { const top = Array.from(document.querySelectorAll('[role="dialog"]')).at(-1); if (returnFocus?.isConnected && (!top || top.contains(returnFocus))) returnFocus.focus(); }); };
  }, []);
  return <div className="modal-shade" data-dialog-variant={variant} data-closing={closing||undefined} onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}><section ref={host} className="dialog" role="dialog" aria-modal="true" aria-label={title} onClickCapture={event => { if ((event.target as HTMLElement).closest('[data-dismiss="dialog"]')) { event.preventDefault(); event.stopPropagation(); requestClose(); } }}>
    <header><h2>{title}</h2><button className="icon-button" disabled={busy} onClick={requestClose} aria-label="关闭对话框">×</button></header>
    {confirming ? <div className="discard-confirm"><h3>放弃未保存的修改？</h3><p>填写的内容还没有保存，继续编辑可以保留这些修改。</p><footer><button autoFocus className="primary" onClick={() => setConfirming(false)}>继续编辑</button><button className="danger" onClick={dismiss}>放弃修改</button></footer></div> : <>
      {error && <div className="form-error" role="alert">{error.replace(/^Error: /, '')}</div>}
      <fieldset className="dialog-fields" disabled={busy}>{children}</fieldset>
    </>}
  </section></div>;
}
