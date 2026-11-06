import { useEffect, useRef, useState } from 'react';

export function SuccessToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(() => dismiss.current(), 4000);
    return () => clearTimeout(timer);
  }, [message, hovered, focused]);
  return <div className="toast success-toast" role="status" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span>{message}</span><button type="button" onClick={onDismiss} aria-label="关闭成功提示">×</button>
  </div>;
}
