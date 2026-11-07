import { useEffect, useRef, useState } from 'react';

export interface ToastAction { label: string; onAction: () => void }

export function SuccessToast({ message, onDismiss, action }: { message: string; onDismiss: () => void; action?: ToastAction }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useEffect(() => {
    if (hovered || focused) return;
    // Destructive confirmations need longer than a plain success to be read
    // and reversed; hovering or focusing the toast pauses this timer.
    const timer = setTimeout(() => dismiss.current(), action ? 12000 : 4000);
    return () => clearTimeout(timer);
  }, [message, hovered, focused, action]);
  return <div className="toast success-toast" role="status" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span>{message}</span>
    {action && <button type="button" className="toast-copy" onClick={() => { action.onAction(); onDismiss(); }}>{action.label}</button>}
    <button type="button" onClick={onDismiss} aria-label="关闭成功提示">×</button>
  </div>;
}
