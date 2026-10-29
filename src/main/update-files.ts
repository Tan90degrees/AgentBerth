import * as nodeFs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { compareVersions, parseUpdateManifest, stableVersion, type UpdateManifest } from '../shared/update-format.mjs';
import type { UpdateResume } from '../shared/updates';

// Electron virtualizes ASAR paths. Hash and inspect physical archive bytes.
export const physicalFs: typeof nodeFs = process.versions.electron ? require('original-fs') : nodeFs;
export function fileHash(file: string): string {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024), fd = physicalFs.openSync(file, 'r');
  try { let n; while ((n = physicalFs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { physicalFs.closeSync(fd); }
  return hash.digest('hex');
}
export function readJson(file: string, max = 1024 * 1024): any {
  if (physicalFs.statSync(file).size > max) throw new Error('更新元数据过大');
  return JSON.parse(physicalFs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
export interface UpdateDiskState {
  schema: 1; active: string | null; previous: string | null; staged: string | null; pending: boolean; attempted: boolean;
  backendPending: boolean; previousBackendPending: boolean; automatic: boolean; resume: UpdateResume | null; error: string | null;
}
const emptyState = (): UpdateDiskState => ({ schema: 1, active: null, previous: null, staged: null, pending: false, attempted: false, backendPending: false, previousBackendPending: false, automatic: true, resume: null, error: null });
export function cleanStorage(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('界面恢复数据无效');
  const result: Record<string, string> = {}; let bytes = 0;
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith('berth.') || key.length > 256 || typeof value !== 'string') throw new Error('界面恢复数据无效');
    bytes += Buffer.byteLength(key + value); if (bytes > 256 * 1024) throw new Error('界面恢复数据过大');
    result[key] = value;
  }
  return result;
}
function cleanResume(value: unknown): UpdateResume | null {
  if (value === null || value === undefined) return null;
  const v = value as UpdateResume;
  if (typeof v !== 'object' || typeof v.sshSession !== 'string' || v.sshSession.length > 256) throw new Error('窗口恢复数据无效');
  for (const w of [v.main, v.ssh]) {
    if (w === null) continue;
    if (!w || !w.bounds || ![w.bounds.x,w.bounds.y,w.bounds.width,w.bounds.height].every(Number.isFinite) || w.bounds.width < 100 || w.bounds.height < 100 || w.bounds.width > 20000 || w.bounds.height > 20000 || ![w.visible,w.minimized,w.maximized].every(b => typeof b === 'boolean')) throw new Error('窗口恢复数据无效');
  }
  return { storage: cleanStorage(v.storage), main: v.main, ssh: v.ssh, sshSession: v.sshSession };
}
export class UpdateStore {
  readonly root: string;
  constructor(dataDirectory: string) { if (!path.isAbsolute(dataDirectory)) throw new Error('更新目录必须为绝对路径'); this.root = path.join(dataDirectory, 'app-updates'); }
  versionRoot(version: string): string { return path.join(this.root, 'versions', stableVersion(version)); }
  read(): UpdateDiskState {
    try {
      const v = readJson(path.join(this.root, 'state.json'));
      if (v.schema !== 1 || (v.active !== null && stableVersion(v.active) !== v.active) || (v.previous !== null && stableVersion(v.previous) !== v.previous)) return emptyState();
      if (v.staged !== undefined && v.staged !== null) stableVersion(v.staged);
      for (const key of ['pending','attempted','backendPending','previousBackendPending']) if (v[key] !== undefined && typeof v[key] !== 'boolean') throw new Error('更新状态无效');
      return { ...emptyState(), ...v, resume: cleanResume(v.resume), error: typeof v.error === 'string' ? v.error.slice(0,500) : null, automatic: v.automatic !== false };
    } catch { return emptyState(); }
  }
  write(value: UpdateDiskState): void {
    physicalFs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, `state-${randomUUID()}.tmp`);
    try { physicalFs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); physicalFs.renameSync(temporary, path.join(this.root, 'state.json')); }
    finally { physicalFs.rmSync(temporary, { force: true }); }
  }
  activate(version: string, resume: UpdateResume): void {
    const old = this.read();
    this.write({ ...old, active: stableVersion(version), previous: old.active, pending: true, attempted: false, previousBackendPending: old.backendPending, backendPending: true, resume, error: null });
  }
  rollback(message: string): void {
    const old = this.read();
    this.write({ ...old, active: old.previous, previous: null, pending: false, attempted: false, backendPending: old.previousBackendPending, error: message });
  }
  confirm(): void { const old = this.read(); this.write({ ...old, pending: false, attempted: false, resume: null }); }
  backendUpdated(): void { const old = this.read(); this.write({ ...old, backendPending: false }); }
  verify(version: string, runtime: { electron: string; platform: string; arch: string }, all = true): UpdateManifest {
    const root = this.versionRoot(version), manifest = parseUpdateManifest(readJson(path.join(root, 'update.json'), 4 * 1024 * 1024));
    if (manifest.version !== version || manifest.electron !== runtime.electron || manifest.platform !== runtime.platform || manifest.arch !== runtime.arch || physicalFs.lstatSync(root).isSymbolicLink()) throw new Error('此更新与当前运行环境不兼容');
    for (const item of manifest.files.filter(item => all || item.path === 'mcp/server.cjs')) {
      const file = path.join(root, ...item.path.split('/')); let parent = path.dirname(file);
      while (parent !== root) { if (physicalFs.lstatSync(parent).isSymbolicLink()) throw new Error('更新目录不能包含符号链接'); parent = path.dirname(parent); }
      const s = physicalFs.lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.size !== item.size || fileHash(file) !== item.sha256) throw new Error('更新文件校验失败：' + item.path);
    }
    if (all) {
      const expected = new Set([...manifest.files.map(item => item.path), 'update.json']);
      const walk = (directory: string) => {
        for (const entry of physicalFs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name), relative = path.relative(root, file).split(path.sep).join('/');
          if (entry.isSymbolicLink()) throw new Error('更新目录不能包含符号链接');
          if (entry.isDirectory()) walk(file); else if (!entry.isFile() || !expected.has(relative)) throw new Error('更新目录包含清单外文件');
        }
      }; walk(root);
    }
    return manifest;
  }
}
export interface UpdateBoot { baseResources: string; resources: string; version: string; dataDirectory: string; resume: UpdateResume | null; pending: boolean }
const bootKey = Symbol.for('agentberth.updateBoot');
export function setUpdateBoot(value: UpdateBoot): void { (globalThis as any)[bootKey] = value; }
export function updateBoot(): UpdateBoot | undefined { return (globalThis as any)[bootKey]; }
export function selectUpdate(store: UpdateStore, baseVersion: string, runtime: { electron: string; platform: string; arch: string }): { version: string; root: string } | null {
  let state = store.read();
  if (!state.active) return null;
  if (compareVersions(state.active, baseVersion) <= 0) {
    store.write({ ...state, active: null, previous: null, pending: false, attempted: false });
    return null;
  }
  if (state.pending && state.attempted) { store.rollback('更新启动未完成，已恢复上一个可用版本。'); state = store.read(); }
  if (!state.active || compareVersions(state.active, baseVersion) <= 0) return null;
  try { store.verify(state.active, runtime); }
  catch (error) {
    store.rollback('更新文件校验失败，已恢复上一个版本。'); const previous = store.read().active;
    if (!previous || compareVersions(previous, baseVersion) <= 0) return null;
    try { store.verify(previous, runtime); return { version: previous, root: store.versionRoot(previous) }; }
    catch { const old = store.read(); store.write({ ...old, active: null, pending: false, backendPending: false }); return null; }
  }
  if (state.pending) store.write({ ...state, attempted: true });
  return { version: state.active, root: store.versionRoot(state.active) };
}
