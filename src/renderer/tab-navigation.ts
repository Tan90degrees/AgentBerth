import type { KeyboardEvent } from 'react';

export function handleTabKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
  const vertical = event.currentTarget.getAttribute('aria-orientation') === 'vertical';
  const previous = vertical ? 'ArrowUp' : 'ArrowLeft', nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
  if (![previous, nextKey, 'Home', 'End'].includes(event.key)) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
  if (!target || target.closest('[role="tablist"]') !== event.currentTarget) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
    .filter(tab => tab.getAttribute('aria-disabled') !== 'true' && tab.getClientRects().length && tab.closest('[role="tablist"]') === event.currentTarget);
  const current = tabs.indexOf(target);
  if (current < 0 || !tabs.length) return;
  event.preventDefault(); event.stopPropagation();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === nextKey ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus(); tabs[next].click();
}
