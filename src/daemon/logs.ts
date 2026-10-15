import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export const LOG_SEGMENT_BYTES = 1024 * 1024;
export class RunLog {
  private file: string;
  private size = 0;
  constructor(directory: string, runId: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, `${runId}.log`);
    this.size = existsSync(this.file) ? statSync(this.file).size : 0;
  }
  append(text: string): void {
    // Bound disk use to 4 x 1 MiB per run, even for noisy background processes.
    const chunks = Buffer.from(text);
    for (let offset = 0; offset < chunks.length; ) {
      if (this.size >= LOG_SEGMENT_BYTES) {
        rmSync(`${this.file}.3`, { force: true });
        for (let n = 2; n >= 0; n--) {
          const from = n ? `${this.file}.${n}` : this.file;
          if (existsSync(from)) renameSync(from, `${this.file}.${n + 1}`);
        }
        this.size = 0;
      }
      const length = Math.min(chunks.length - offset, LOG_SEGMENT_BYTES - this.size);
      appendFileSync(this.file, chunks.subarray(offset, offset + length), { mode: 0o600 });
      this.size += length;
      offset += length;
    }
  }
  read(): string {
    const parts: Buffer[] = [];
    for (let n = 3; n >= 0; n--) {
      const file = n ? `${this.file}.${n}` : this.file;
      if (existsSync(file)) parts.push(readFileSync(file));
    }
    return Buffer.concat(parts).toString('utf8');
  }
}
