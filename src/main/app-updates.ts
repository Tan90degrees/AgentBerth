import path from 'node:path';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { compareVersions, parseUpdateManifest, releaseAsset, RELEASE_API, RELEASES_URL, updateNames, type UpdateManifest } from '../shared/update-format.mjs';
import { fileHash, physicalFs, UpdateStore } from './update-files';
import type { AppUpdateState, UpdateResume } from '../shared/updates';

interface UpdateOptions {
  store: UpdateStore; version: string; electron: string; platform: string; arch: string; supported: boolean;
  fetch: (url: string, options?: RequestInit) => Promise<Response>;
  extract: (archive: string, destination: string, signal: AbortSignal) => Promise<void>;
  publish: (value: AppUpdateState) => void;
}
export class AppUpdates {
  private value: AppUpdateState;
  private manifest: UpdateManifest | null = null;
  private bundleUrl = '';
  private busy: Promise<void> | null = null;
  private abort: AbortController | null = null;
  constructor(private options: UpdateOptions) {
    const disk = options.store.read();
    this.value = { supported: options.supported, phase: 'idle', currentVersion: options.version, latestVersion: null, downloaded: 0, total: 0, notes: '', releaseUrl: RELEASES_URL, message: options.supported ? disk.error ?? '' : '软件内更新目前支持 Windows 安装包和 ZIP 版。', checkedAt: null, automatic: disk.automatic, backendPending: disk.backendPending };
    if (options.supported && disk.staged && compareVersions(disk.staged, options.version) > 0) try {
      this.manifest = options.store.verify(disk.staged, options);
      Object.assign(this.value, { phase: 'ready', latestVersion: disk.staged, downloaded: this.manifest.bundle.size, total: this.manifest.bundle.size, message: '更新已下载，可直接应用。' });
    } catch { /* A damaged cache is never activated. */ }
  }
  state(): AppUpdateState { return { ...this.value, supported: this.options.supported }; }
  private change(update: Partial<AppUpdateState>): void { Object.assign(this.value, update); this.options.publish(this.state()); }
  automatic(value: boolean): AppUpdateState { const disk = this.options.store.read(); this.options.store.write({ ...disk, automatic: value }); this.change({ automatic: value }); return this.state(); }
  private async json(url: string, signal: AbortSignal, maximum = 4 * 1024 * 1024): Promise<any> {
    const response = await this.options.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? '检查更新过于频繁，请稍后重试。' : `获取更新失败（HTTP ${response.status}）`);
    if (!response.body) throw new Error('更新服务没有返回内容');
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) throw new Error('更新元数据过大'); parts.push(value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, ''));
  }
  private async run(work: (signal: AbortSignal) => Promise<void>): Promise<AppUpdateState> {
    if (this.busy) { await this.busy; return this.state(); }
    this.abort = new AbortController();
    const abort = this.abort;
    const previous = this.value.phase;
    this.busy = work(abort.signal).catch(error => {
      if (abort.signal.aborted) this.change({ phase: previous === 'ready' ? 'ready' : this.manifest ? 'available' : 'idle', message: '更新已取消，当前软件和终端保持运行。' });
      else this.change({ phase: previous === 'ready' ? 'ready' : 'error', message: String(error instanceof Error ? error.message : error).slice(0, 500) });
    }).finally(() => { this.busy = null; this.abort = null; });
    await this.busy; return this.state();
  }
  async check(): Promise<AppUpdateState> {
    if (!this.options.supported) return this.state();
    return this.run(async signal => {
      this.change({ phase: 'checking', message: '', checkedAt: new Date().toISOString() });
      const release = await this.json(RELEASE_API, signal), version = String(release.tag_name ?? '').replace(/^v/, '');
      if (compareVersions(version, this.options.version) <= 0) { this.change({ phase: 'current', latestVersion: null, message: '当前已是最新稳定版本。' }); return; }
      const details = { latestVersion: version, notes: typeof release.body === 'string' ? release.body.slice(0, 12000) : '' };
      const names = updateNames(version);
      let asset;
      try { asset = releaseAsset(release, names.manifest); }
      catch { this.change({ ...details, phase: 'runtime_required', message: '此版本需要完整安装包，请从发布页下载。' }); return; }
      if (asset.size > 4 * 1024 * 1024) throw new Error('更新元数据过大');
      const manifest = parseUpdateManifest(await this.json(asset.browser_download_url, signal));
      if (manifest.version !== version) throw new Error('更新版本与发布信息不一致');
      if (manifest.electron !== this.options.electron || manifest.platform !== this.options.platform || manifest.arch !== this.options.arch) { this.change({ ...details, phase: 'runtime_required', message: '此版本升级了运行环境，需要使用完整安装包。日常应用代码更新可直接在软件内完成。' }); return; }
      const bundle = releaseAsset(release, names.bundle);
      if (bundle.size !== manifest.bundle.size) throw new Error('更新包大小与清单不一致');
      this.manifest = manifest; this.bundleUrl = bundle.browser_download_url;
      this.change(details);
      try { this.options.store.verify(version, this.options); this.change({ phase: 'ready', total: manifest.bundle.size, downloaded: manifest.bundle.size, message: '更新已下载，应用时界面会重载，终端继续运行。' }); }
      catch { this.change({ phase: 'available', total: manifest.bundle.size, downloaded: 0, message: '发现新版本，可在后台下载。' }); }
    });
  }
  async download(): Promise<AppUpdateState> {
    if (!this.options.supported || !this.manifest || !this.bundleUrl) return this.state();
    return this.run(async userSignal => {
      const signal = AbortSignal.any([userSignal, AbortSignal.timeout(10 * 60 * 1000)]);
      const manifest = this.manifest!, temporary = path.join(this.options.store.root, `download-${randomUUID()}`), archive = path.join(temporary, 'update.zip'), staging = path.join(temporary, 'files');
      await mkdir(staging, { recursive: true, mode: 0o700 });
      this.change({ phase: 'downloading', message: '正在后台下载，终端可继续使用。', downloaded: 0, total: manifest.bundle.size });
      try {
        const response = await this.options.fetch(this.bundleUrl, { signal });
        if (!response.ok || !response.body) throw new Error(`下载更新失败（HTTP ${response.status}）`);
        let bytes = 0, emitted = 0;
        const meter = new Transform({ transform: (chunk, _encoding, callback) => {
          bytes += chunk.length;
          if (bytes > manifest.bundle.size) { callback(new Error('更新包大小不匹配')); return; }
          if (Date.now() - emitted > 100) { emitted = Date.now(); this.change({ downloaded: bytes }); }
          callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body as any), meter, physicalFs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
        if (bytes !== manifest.bundle.size || fileHash(archive) !== manifest.bundle.sha256) throw new Error('更新包校验失败，请重新下载。');
        this.change({ phase: 'extracting', downloaded: bytes, message: '正在解压并核对更新文件…' });
        await this.options.extract(archive, staging, signal); signal.throwIfAborted();
        await writeFile(path.join(staging, 'update.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
        const final = this.options.store.versionRoot(manifest.version);
        await mkdir(path.dirname(final), { recursive: true });
        if (physicalFs.existsSync(final)) {
          const disk = this.options.store.read();
          if ([disk.active, disk.previous].includes(manifest.version)) throw new Error('该版本仍在使用，当前终端未受影响，请在任务结束后重试。');
          await rename(final, final + '.invalid-' + randomUUID());
        }
        await rename(staging, final);
        this.options.store.verify(manifest.version, this.options);
        const disk = this.options.store.read(); this.options.store.write({ ...disk, staged: manifest.version });
        this.change({ phase: 'ready', message: '更新已就绪，应用时只重载界面，正在运行的终端保持。' });
      } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {}); }
    });
  }
  cancel(): AppUpdateState { this.abort?.abort(); return this.state(); }
  prepare(resume: UpdateResume, backend: { apiVersion: number; active: boolean }): void {
    if (this.busy || this.value.phase !== 'ready' || !this.manifest) throw new Error('请先完成更新下载');
    this.options.store.verify(this.manifest.version, this.options);
    if (this.manifest.minimumBackendApi > backend.apiVersion && backend.active) throw new Error('此版本需要同时更新后台，请等终端结束后再应用；已下载的更新会保留。');
    this.options.store.activate(this.manifest.version, resume);
    this.change({ phase: 'applying', message: '正在更新界面，终端保持运行…' });
  }
  applyFailed(): void { this.change({ phase: 'ready', message: '应用更新未完成，当前版本仍在运行，可重试。' }); }
  needsIdleBackend(apiVersion: number): boolean { return !!this.manifest && this.manifest.minimumBackendApi > apiVersion; }
  backendApplied(): void { this.options.store.backendUpdated(); this.change({ backendPending: false }); }
}
