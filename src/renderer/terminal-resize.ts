type Size = { cols: number; rows: number };
const same = (a: Size, b: Size) => a.cols === b.cols && a.rows === b.rows;

export class ResizeQueue {
  private pending: Size | null = null;
  private busy = false;
  private disposed = false;
  constructor(private applied: Size, private send: (size: Size) => Promise<void>, private onError: (error: unknown) => void) {}

  request(size: Size): void {
    if (this.disposed) return;
    this.pending = size;
    if (!this.busy) void this.drain();
  }
  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (!this.disposed && this.pending) {
        const size = this.pending; this.pending = null;
        if (same(size, this.applied)) continue;
        try { await this.send(size); this.applied = size; }
        catch (error) { if (!this.disposed) this.onError(error); }
      }
    } finally { this.busy = false; }
  }
  dispose(): void { this.disposed = true; this.pending = null; }
}
