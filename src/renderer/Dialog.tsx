import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Dialog({ title, children, onClose, busy = false, dirty = false, error = '', returnFocus }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; dirty?: boolean; error?: string; returnFocus?: HTMLElement | null;
}) {
  const host = useRef<HTMLElement>(null);
  const [confirming, setConfirming] = useState(false);
  const current = useRef({ onClose, busy, dirty, confirming }); current.current = { onClose, busy, dirty, confirming };
  const requestClose = () => { if (!current.current.busy) { if (current.current.confirming) setConfirming(false); else if (current.current.dirty) setConfirming(true); else current.current.onClose(); } };
  useEffect(() => {
    const focusable = () => Array.from(host.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
    if (!host.current?.contains(document.activeElement)) (host.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? focusable()[0])?.focus();
    const key = (event: KeyboardEvent) => {
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
    return () => { document.removeEventListener('keydown', key, true); queueMicrotask(() => { if (!document.querySelector('[role="dialog"]') && returnFocus?.isConnected) returnFocus.focus(); }); };
  }, []);
  return <div className="modal-shade" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}><section ref={host} className="dialog" role="dialog" aria-modal="true" aria-label={title} onClickCapture={event => { if ((event.target as HTMLElement).closest('[data-dismiss="dialog"]')) { event.preventDefault(); event.stopPropagation(); requestClose(); } }}>
    <header><h2>{title}</h2><button className="icon-button" disabled={busy} onClick={requestClose} aria-label="关闭对话框">×</button></header>
    {confirming ? <div className="discard-confirm"><h3>放弃未保存的修改？</h3><p>填写的内容还没有保存，继续编辑可以保留这些修改。</p><footer><button autoFocus className="primary" onClick={() => setConfirming(false)}>继续编辑</button><button className="danger" onClick={() => current.current.onClose()}>放弃修改</button></footer></div> : <>
      {error && <div className="form-error" role="alert">{error.replace(/^Error: /, '')}</div>}
      <fieldset className="dialog-fields" disabled={busy}>{children}</fieldset>
    </>}
  </section></div>;
}
