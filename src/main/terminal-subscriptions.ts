/** Renderers share one daemon socket. A late detach from the old window must
 * never unsubscribe the new window during a panel handoff. */
export class TerminalSubscriptions {
  private owners = new Map<string, Set<number>>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(private rpc: (method: 'attach' | 'detach', sessionId: string) => Promise<unknown>) {}
  has(owner: number, sessionId: string): boolean { return this.owners.get(sessionId)?.has(owner) ?? false; }
  private enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(task);
    this.queues.set(sessionId, next);
    void next.finally(() => { if (this.queues.get(sessionId) === next) this.queues.delete(sessionId); }).catch(() => {});
    return next;
  }
  attach(owner: number, sessionId: string, alive: () => boolean): Promise<unknown> {
    return this.enqueue(sessionId, async () => {
      if (!alive()) throw new Error('终端窗口已关闭');
      const owners = this.owners.get(sessionId) ?? new Set<number>();
      owners.add(owner); this.owners.set(sessionId, owners);
      try { return await this.rpc('attach', sessionId); }
      catch (error) { owners.delete(owner); if (!owners.size) this.owners.delete(sessionId); throw error; }
      finally { if (!alive()) void this.detach(owner, sessionId).catch(() => {}); }
    });
  }
  detach(owner: number, sessionId: string): Promise<unknown> {
    return this.enqueue(sessionId, async () => {
      const owners = this.owners.get(sessionId);
      if (!owners?.delete(owner) || owners.size) return null;
      this.owners.delete(sessionId);
      return this.rpc('detach', sessionId);
    });
  }
  release(owner: number): void {
    for (const [sessionId, owners] of this.owners) if (owners.has(owner)) void this.detach(owner, sessionId).catch(() => {});
  }
}
