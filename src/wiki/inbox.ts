import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

const IMPORTABLE = /\.(md|markdown|txt|json)$/i;
const MAX_BYTES = 1024 * 1024;
const DEBOUNCE_MS = 400;
/** A file must stop changing for this long before it is considered complete. */
const SETTLE_MS = 700;
const MAX_SETTLE_CHECKS = 25;
const RETRY_MS = 30_000;
const MAX_FAILURES = 3;
const KEEP_IMPORTED = 200;

/** Deterministic rejections should not be retried for 30 seconds. */
class PermanentInboxError extends Error {}

export interface InboxOptions {
  /** Plugin data directory; the watched folder is <root>/raw/inbox. */
  root: string;
  onFile: (name: string, text: string) => Promise<void>;
  onError?: (name: string, error: unknown) => void;
}
export interface InboxHandle {
  readonly dir: string;
  readonly importedDir: string;
  readonly failedDir: string;
  readonly pending: string[];
  readonly archived: number;
  scan(): Promise<void>;
  stop(): void;
}

/** Karpathy/olw-style `watch`: dropping a Markdown or text file into raw/inbox
 * ingests it automatically. Files are moved to imported/ after a successful
 * import so a restart, or duplicate OS watch events, never re-import them. */
export function startInbox(options: InboxOptions): InboxHandle {
  const dir = path.join(options.root, 'raw', 'inbox');
  const importedDir = path.join(dir, 'imported');
  const failedDir = path.join(dir, 'failed');
  for (const folder of [dir, importedDir, failedDir]) mkdirSync(folder, { recursive: true, mode: 0o700 });

  const failedAt = new Map<string, number>();
  const attempts = new Map<string, number>();
  const settling = new Map<string, number>();
  let busy: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const archivedName = (name: string): string => `${Date.now()}-${randomUUID().slice(0, 6)}-${path.basename(name)}`;
  const list = (): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && IMPORTABLE.test(entry.name) && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .filter(name => Date.now() - (failedAt.get(name) ?? 0) >= RETRY_MS);
    } catch { return []; }
  };
  const prune = (): void => {
    try {
      const names = readdirSync(importedDir).sort().reverse();
      for (const name of names.slice(KEEP_IMPORTED)) rmSync(path.join(importedDir, name), { force: true });
    } catch { /* pruning is best-effort */ }
  };
  const quarantine = (file: string, name: string, targetDir: string): void => {
    try { renameSync(file, path.join(targetDir, archivedName(name))); }
    catch { /* a locked file stays in the inbox for the next scan */ }
  };

  function schedule(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { busy = busy.catch(() => undefined).then(scan); }, DEBOUNCE_MS);
  }

  async function scan(): Promise<void> {
    if (stopped) return;
    let rescan = false;
    for (const name of list()) {
      const file = path.join(dir, name);
      try {
        const info = statSync(file);
        // Two observations separated by a debounce, plus a quiet mtime, keep a
        // slow copy from being imported as a truncated immutable source.
        if (info.size === 0 || Date.now() - info.mtimeMs < SETTLE_MS) {
          const checks = (settling.get(name) ?? 0) + 1;
          settling.set(name, checks);
          if (checks <= MAX_SETTLE_CHECKS) { rescan = true; continue; }
          throw new PermanentInboxError('文件长时间未写完');
        }
        if (info.size > MAX_BYTES) throw new PermanentInboxError('文件超过 1 MiB 上限');
        settling.delete(name);
        const text = readFileSync(file, 'utf8');
        if (!text.trim()) continue;
        await options.onFile(name, text);
        renameSync(file, path.join(importedDir, archivedName(name)));
        failedAt.delete(name); attempts.delete(name);
        prune();
      } catch (error) {
        settling.delete(name);
        const count = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, count);
        failedAt.set(name, Date.now());
        if (error instanceof PermanentInboxError || count >= MAX_FAILURES) {
          quarantine(file, name, failedDir);
          failedAt.delete(name); attempts.delete(name);
        }
        options.onError?.(name, error);
      }
    }
    if (rescan) schedule();
  }

  const watcher: FSWatcher = watch(dir, () => schedule());
  watcher.on('error', () => { /* startup scans still cover files if watching fails */ });
  busy = busy.then(scan);

  return {
    dir, importedDir, failedDir,
    get pending() { return list(); },
    get archived() { try { return readdirSync(importedDir).length; } catch { return 0; } },
    scan,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
