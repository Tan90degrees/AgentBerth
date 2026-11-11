import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

const IMPORTABLE = /\.(md|markdown|txt|json|pdf)$/i;
const isPdf = (name: string) => /\.pdf$/i.test(name);
/** Text files stay small; PDFs are allowed more room because text extraction
 * shrinks them by an order of magnitude. */
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
  /** Binary → text conversion (used for PDF). Defaults to UTF-8 for text types. */
  parse?: (name: string, bytes: Buffer) => Promise<string>;
  onPdf?: (name: string, bytes: Buffer) => Promise<void>;
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
  const observed = new Map<string, { signature: string; at: number }>();
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
    timer = setTimeout(() => { void scan(); }, DEBOUNCE_MS);
  }

  async function processScan(): Promise<void> {
    if (stopped) return;
    let rescan = false;
    for (const name of list()) {
      const file = path.join(dir, name);
      try {
        if (stopped) return;
        const info = statSync(file);
        const signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
        const last = observed.get(name);
        if (!last || last.signature !== signature) observed.set(name, { signature, at: Date.now() });
        // Two observations separated by a debounce, plus a quiet mtime, keep a
        // slow copy from being imported as a truncated immutable source.
        if (!last || last.signature !== signature || Date.now() - last.at < SETTLE_MS || Date.now() - info.mtimeMs < SETTLE_MS) {
          const checks = (settling.get(name) ?? 0) + 1;
          settling.set(name, checks);
          if (checks <= MAX_SETTLE_CHECKS) { rescan = true; continue; }
          throw new PermanentInboxError('文件长时间未写完');
        }
        settling.delete(name);
        const buffer = readFileSync(file);
        let text: string;
        try {
          // A binary parse failure is deterministic: the bytes will not change,
          // so unlike a transient FS error it must not be retried forever.
          if (isPdf(name) && options.onPdf) { await options.onPdf(name, buffer); text = 'PDF 已导入'; }
          else text = isPdf(name) && options.parse ? await options.parse(name, buffer) : buffer.toString('utf8');
        } catch (error) {
          throw new PermanentInboxError(String(error instanceof Error ? error.message : error).slice(0, 200));
        }
        if (!text.trim()) throw new PermanentInboxError('文件内容为空');
        if (!isPdf(name) || !options.onPdf) await options.onFile(name, text);
        if (stopped) return;
        const after = statSync(file);
        if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.ino}` !== signature) { rescan = true; continue; }
        renameSync(file, path.join(importedDir, archivedName(name)));
        observed.delete(name);
        failedAt.delete(name); attempts.delete(name);
        prune();
      } catch (error) {
        if (stopped) return;
        settling.delete(name);
        const count = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, count);
        failedAt.set(name, Date.now());
        if (error instanceof PermanentInboxError || count >= MAX_FAILURES) {
          quarantine(file, name, failedDir);
          if (!readdirSync(dir).includes(name)) { failedAt.delete(name); attempts.delete(name); observed.delete(name); }
        }
        try { options.onError?.(name, error); } catch { /* Reporting must not break retries. */ }
      }
    }
    if (rescan) schedule();
  }

  function scan(): Promise<void> {
    const next = busy.catch(() => undefined).then(processScan);
    busy = next;
    return next;
  }
  const retryTimer = setInterval(() => { void scan(); }, RETRY_MS);
  retryTimer.unref();
  const watcher: FSWatcher = watch(dir, () => schedule());
  watcher.on('error', () => { /* startup scans still cover files if watching fails */ });
  void scan();

  return {
    dir, importedDir, failedDir,
    get pending() { return list(); },
    get archived() { try { return readdirSync(importedDir).length; } catch { return 0; } },
    scan,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(retryTimer);
      watcher.close();
    },
  };
}
