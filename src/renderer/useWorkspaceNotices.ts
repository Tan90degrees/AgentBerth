import { useEffect, useRef } from 'react';
import type { WorkspaceRecovery } from '../shared/protocol';
import type { Notice } from './notice-queue';
import type { ToastAction } from './SuccessToast';

export function recoveryNotice(recovery: WorkspaceRecovery): Pick<Notice, 'text' | 'level'> | null {
  if (!recovery.total && !recovery.errors.length) return null;
  if (recovery.status === 'restoring') return { text: `正在恢复上次会话 · ${recovery.total} 个`, level: 'info' };
  const title = recovery.errors.length ? '部分会话未恢复' : '上次会话恢复完成';
  const counts = `已重新打开 ${recovery.restored}/${recovery.total} · 续接 Agent 对话 ${recovery.resumed}`;
  const skipped = recovery.skipped ? ` · 跳过 ${recovery.skipped}` : '';
  const errors = recovery.errors.map(item => `${item.title}：${item.message}`).join('\n');
  return { text: `${title} · ${counts}${skipped}${errors ? '\n' + errors : ''}`, level: recovery.errors.length ? 'warning' : 'info' };
}

/** Backend snapshots repeat on reconnect and polling. Announce each transition
 * once, including StrictMode effect replay; clearing history is explicit. */
export function useWorkspaceNotices({ connected, recovery, apiVersion, expectedApi, notify, inspectFailure, updateBackend }: {
  connected: boolean; recovery?: WorkspaceRecovery; apiVersion: number; expectedApi: number;
  notify: (text: string, action?: ToastAction, level?: Notice['level']) => void;
  inspectFailure: (sessionId: string) => void; updateBackend: () => void;
}) {
  const announced = useRef(new Set<string>());
  useEffect(() => {
    if (!connected || !recovery) return;
    const key = `recovery:${recovery.id}:${recovery.status}`, notice = recoveryNotice(recovery);
    if (!notice || announced.current.has(key)) return;
    announced.current.add(key);
    const firstError = recovery.status === 'completed' ? recovery.errors[0] : undefined;
    notify(notice.text, firstError ? { label: '查看会话', retain: true, onAction: () => inspectFailure(firstError.sessionId) } : undefined, notice.level);
  }, [connected, recovery, notify, inspectFailure]);
  useEffect(() => {
    if (!connected || apiVersion <= 0 || apiVersion >= expectedApi) return;
    const key = `backend:${apiVersion}:${expectedApi}`;
    if (announced.current.has(key)) return;
    announced.current.add(key);
    notify('后台有可用更新', { label: '更新后台', retain: true, onAction: updateBackend }, 'warning');
  }, [connected, apiVersion, expectedApi, notify, updateBackend]);
}
