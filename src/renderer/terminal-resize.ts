type Size = { cols: number; rows: number };

// All layout notifications share one sampler. Measure when work can actually
// start: dimensions captured while an RPC/parser was busy are already stale.
export class ResizeScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private dirty = false;
  private disposed = false;
  constructor(private measure: () => Size | null, private apply: (size: Size) => Promise<void>, private onError: (error: unknown) => void) {}

  request(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (!this.busy && this.timer === undefined) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 80);
  }
  private async flush(): Promise<void> {
    if (this.disposed) return;
    this.dirty = false;
    this.busy = true;
    try {
      const size = this.measure();
      if (size) await this.apply(size);
    } catch (error) { if (!this.disposed) this.onError(error); }
    finally {
      this.busy = false;
      if (this.dirty) this.request();
    }
  }
  dispose(): void { this.disposed = true; this.dirty = false; clearTimeout(this.timer); }
}
