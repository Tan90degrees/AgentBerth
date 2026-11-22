import { ACCELERATOR_SAMPLE_INTERVAL_MS, type AcceleratorReading, type AcceleratorSample } from '../shared/accelerator';

export class PetMonitor {
  private ids: string[] = [];
  private readonly readings = new Map<string, AcceleratorReading>();
  private readonly pending = new Map<string, object>();
  private timer?: ReturnType<typeof setInterval>;
  private active = false;

  constructor(private sample: (id: string) => Promise<AcceleratorSample>, private changed: () => void) {}

  snapshot(): AcceleratorReading[] {
    return this.ids.flatMap(id => {
      const reading = this.readings.get(id);
      return reading ? [reading] : [];
    });
  }

  configure(ids: string[], active: boolean): void {
    const wasActive = this.active;
    this.active = active && ids.length > 0;
    const added = ids.filter(id => !this.ids.includes(id));
    for (const id of this.ids) {
      if (!ids.includes(id)) this.readings.delete(id);
      if (!ids.includes(id) || !this.active) this.pending.delete(id);
    }
    this.ids = [...ids];
    if (wasActive === this.active && !added.length) return;
    if (!this.active) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (!wasActive) this.timer = setInterval(() => this.poll(this.ids), ACCELERATOR_SAMPLE_INTERVAL_MS).unref();
    this.poll(wasActive ? added : this.ids);
  }

  reset(id: string): void {
    this.readings.delete(id);
    this.pending.delete(id);
    if (this.active && this.ids.includes(id)) this.poll([id]);
  }

  private poll(ids: string[]): void {
    for (const id of ids) {
      if (this.pending.has(id)) continue;
      const attempt = {};
      this.pending.set(id, attempt);
      void this.sample(id).then(sample => {
        if (this.pending.get(id) === attempt) this.readings.set(id, { id, sample });
      }, error => {
        if (this.pending.get(id) === attempt) this.readings.set(id, { id, sample: this.readings.get(id)?.sample, error: error instanceof Error ? error.message : '采集失败' });
      }).finally(() => {
        if (this.pending.get(id) !== attempt) return;
        this.pending.delete(id);
        this.changed();
      });
    }
  }
}
