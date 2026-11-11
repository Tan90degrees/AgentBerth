import type { ToastAction } from './SuccessToast';

export interface Notice { id: number; text: string; action?: ToastAction; level?: 'info' | 'warning' | 'error'; at?: number }

let nextId = 1;

/** Keep notification history until explicitly dismissed; auto-collapse is a view concern. */
export function pushNotice(list: Notice[], text: string, action?: ToastAction, level: Notice['level'] = 'info'): Notice[] {
  if (!text) return list;
  return [...list, { id: nextId++, text, action, level, at: Date.now() }];
}

export function dismissNotice(list: Notice[], id: number): Notice[] {
  return list.filter(item => item.id !== id);
}
