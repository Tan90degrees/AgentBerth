import type { ToastAction } from './SuccessToast';

export interface Notice { id: number; text: string; action?: ToastAction }

const MAX_ACTIONS = 2;
let nextId = 1;

/**
 * A plain notice replaces the previous plain notice, but actionable notices
 * (undo / retry) keep their own slot. Without this, copying a path right after
 * a delete silently removes the user's only chance to restore the deletion.
 */
export function pushNotice(list: Notice[], text: string, action?: ToastAction): Notice[] {
  const pending = list.filter(item => item.action).slice(-MAX_ACTIONS);
  if (!text) return pending;
  if (!action) return [...pending, { id: nextId++, text }];
  return [...pending.slice(-(MAX_ACTIONS - 1)), { id: nextId++, text, action }];
}

export function dismissNotice(list: Notice[], id: number): Notice[] {
  return list.filter(item => item.id !== id);
}
