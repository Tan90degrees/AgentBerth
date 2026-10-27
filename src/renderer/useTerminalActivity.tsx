import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Session } from '../shared/protocol';
import { TerminalActivity } from './terminal-activity';

export function OutputBadge() {
  return <span className="output-badge" title="有新输出，打开终端查看">新输出</span>;
}

export function useTerminalActivity(sessions: Session[], viewed: readonly string[]): ReadonlySet<string> {
  const tracker = useRef(new TerminalActivity());
  const currentView = useRef(viewed); currentView.current = viewed;
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const refreshView = () => tracker.current.view(document.visibilityState === 'visible' && document.hasFocus() ? currentView.current : []);
  useLayoutEffect(() => {
    const changed = tracker.current.reconcile(sessions);
    if (refreshView() || changed) setUnread(tracker.current.snapshot());
  }, [sessions, viewed]);
  useEffect(() => {
    const focus = () => { if (refreshView()) setUnread(tracker.current.snapshot()); };
    document.addEventListener('visibilitychange', focus); window.addEventListener('focus', focus); window.addEventListener('blur', focus);
    const off = window.berth?.onEvent(event => {
      let changed = refreshView();
      if (event.event === 'state') changed = tracker.current.reconcile(event.data.sessions) || changed;
      if (event.event === 'terminalActivity' || event.event === 'output' && !!event.data.text) changed = tracker.current.output(event.data) || changed;
      // A streaming terminal changes React state only when a reminder changes.
      if (changed) setUnread(tracker.current.snapshot());
    });
    return () => { off?.(); document.removeEventListener('visibilitychange', focus); window.removeEventListener('focus', focus); window.removeEventListener('blur', focus); };
  }, []);
  return unread;
}
