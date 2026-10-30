import { call } from './harness';

/** Task obligations only. No timers, disconnect cleanup or guesses about age. */
export class TaskLifecycle {
  private used = false;
  private work = new Map<string, { sessionId?: string; status: string }>();
  observe(name: string, value: any): void {
    if (!value || typeof value !== 'object') return;
    if (name === 'terminal_dispose') { this.used = false; this.work.clear(); return; }
    if (value.info?.sessionId || value.sessionId || value.sessions?.length) this.used = true;
    const operation = value.output && value.id ? value : value.spec && value.id ? value : value.command;
    if (operation?.id && operation.status) {
      this.used = true;
      if (['running', 'unknown'].includes(operation.status)) this.work.set(operation.id, { sessionId: operation.sessionId, status: operation.status });
      else this.work.delete(operation.id);
    }
    if (['terminal_close', 'terminal_delete'].includes(name)) {
      const id = value.sessionId ?? value.id;
      for (const [key, work] of this.work) if (work.sessionId === id) this.work.delete(key);
    }
  }
  failure(code: string, args: Record<string, unknown>, details: {actionId?: string;transferId?: string;sessionId?: string} = {}): void {
    if (!['OUTCOME_UNKNOWN', 'CLEANUP_BLOCKED'].includes(code)) return;
    this.used = true;
    const id = details.transferId ?? details.actionId ?? args.requestId;
    if (typeof id === 'string') this.work.set(id, { sessionId: details.sessionId ?? (typeof args.sessionId === 'string' ? args.sessionId : undefined), status: 'unknown' });
  }
  hint(released = false, userControlled = false) {
    if (released) return { state: 'released', onTaskComplete: null };
    if (userControlled) return { state: 'preserve_user_control', onTaskComplete: null };
    if (this.work.size) return { state: 'retain_for_pending_work', pending: this.work.size, onTaskComplete: null };
    return { state: this.used ? 'cleanup_before_final' : 'no_sessions', onTaskComplete: this.used ? call('terminal_session', { action: 'dispose' }) : null };
  }
}
