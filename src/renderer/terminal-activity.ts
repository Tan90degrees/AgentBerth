import type { Session } from '../shared/protocol';

/** Ephemeral per-window reminders; snapshots, resize and old runs are not new output. */
export class TerminalActivity {
  private runs = new Map<string, string>();
  private sequences = new Map<string, number>();
  private visible = new Set<string>();
  private unread = new Set<string>();
  snapshot(): ReadonlySet<string> { return new Set(this.unread); }
  reconcile(sessions: Pick<Session, 'id' | 'latestRun'>[]): boolean {
    const next = new Map(sessions.flatMap(session => session.latestRun ? [[session.id, session.latestRun.id] as const] : []));
    let changed = false;
    for (const [id, run] of this.runs) if (next.get(id) !== run) {
      this.sequences.delete(id); changed = this.unread.delete(id) || changed;
    }
    this.runs = next; return changed;
  }
  view(ids: readonly string[]): boolean {
    this.visible = new Set(ids); let changed = false;
    for (const id of ids) changed = this.unread.delete(id) || changed;
    return changed;
  }
  output({ sessionId, runId, seq }: { sessionId: string; runId: string; seq: number }): boolean {
    if (this.runs.get(sessionId) !== runId || seq <= (this.sequences.get(sessionId) ?? 0)) return false;
    this.sequences.set(sessionId, seq);
    if (this.visible.has(sessionId) || this.unread.has(sessionId)) return false;
    this.unread.add(sessionId); return true;
  }
}
