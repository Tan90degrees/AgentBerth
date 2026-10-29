import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defaultPetPreferences, petPreferencesSchema, type PetHook, type PetPreferences, type PetSession, type PetSnapshot, type PetStatus } from '../shared/pet';
import type { State, RemoteInfo } from '../shared/protocol';

const MAX_GIF_BYTES = 8 * 1024 * 1024;
export function gifData(bytes: Buffer): string {
  if (bytes.length < 14 || bytes.length > MAX_GIF_BYTES || !['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) throw new Error('请选择有效的 GIF，文件不能超过 8 MiB');
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
  if (!width || !height || width > 2048 || height > 2048) throw new Error('GIF 尺寸需在 1–2048 像素之间');
  return 'data:image/gif;base64,' + bytes.toString('base64');
}

export class PetState {
  preferences: PetPreferences = { ...defaultPetPreferences };
  private state: State | null = null;
  private connected = false;
  private remoteSignals = new Map<string, { runId: string; status: PetStatus; label: string }>();
  private hooks = new Map<string, PetHook & { updatedAt: number }>();
  private imageVersion = 0;
  private images: Partial<Record<PetStatus, string>> = {};
  constructor(private folder: string, private changed: () => void = () => {}) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    try { this.preferences = petPreferencesSchema.parse(JSON.parse(readFileSync(path.join(folder, 'settings.json'), 'utf8'))); } catch { /* Missing or invalid preferences use safe defaults. */ }
  }
  private persist(preferences: PetPreferences) {
    const file = path.join(this.folder, 'settings.json');
    writeFileSync(file + '.tmp', JSON.stringify(preferences), { mode: 0o600 }); renameSync(file + '.tmp', file);
  }
  save(value: unknown) { const preferences = petPreferencesSchema.parse(value); this.persist(preferences); this.preferences = preferences; this.changed(); }
  connection(connected: boolean) { this.connected = connected; this.changed(); }
  update(state: State) {
    this.state = state;
    const live = new Map(state.sessions.map(session => [session.id, session.latestRun]));
    for (const [id, hook] of this.hooks) if (live.get(id)?.id !== hook.runId) this.hooks.delete(id);
    for (const [id, signal] of this.remoteSignals) if (live.get(id)?.id !== signal.runId) this.remoteSignals.delete(id);
    this.changed();
  }
  remote(info: RemoteInfo) {
    const previous = this.remoteSignals.get(info.sessionId);
    const status: PetStatus = info.connection !== 'connected' ? 'unknown' : info.phase === 'busy' ? 'working' : info.phase === 'idle' ? (previous?.status === 'working' || previous?.status === 'completed' ? 'completed' : 'idle') : 'unknown';
    this.remoteSignals.set(info.sessionId, { runId: info.runId, status, label: info.connection !== 'connected' ? 'SSH 连接未就绪' : status === 'working' ? 'SSH 命令执行中' : status === 'completed' ? 'SSH 命令已结束' : 'SSH 终端' });
    this.changed();
  }
  accept(hook: PetHook, now = Date.now()): boolean {
    const session = this.state?.sessions.find(session => session.id === hook.sessionId);
    if (!this.connected || !session?.latestRun || session.latestRun.id !== hook.runId || !['running', 'stopping'].includes(session.latestRun.status)) return false;
    this.hooks.set(hook.sessionId, { ...hook, updatedAt: now });
    if (this.preferences.autoSwitch && ['waiting', 'error'].includes(hook.status)) { this.preferences = { ...this.preferences, selectedSessionId: hook.sessionId }; }
    this.changed(); return true;
  }
  snapshot(now = Date.now()): PetSnapshot {
    const projects = new Map(this.state?.projects.map(project => [project.id, project.name]));
    const sessions: PetSession[] = (this.state?.sessions ?? []).filter(session => session.latestRun).map(session => {
      const run = session.latestRun!, hook = this.hooks.get(session.id);
      const live = ['running', 'stopping'].includes(run.status);
      let status: PetStatus = live ? hook?.status ?? 'idle' : run.status === 'failed' || (run.exitCode !== null && run.exitCode !== 0) ? 'error' : hook?.status === 'completed' ? 'completed' : 'idle';
      const remote = this.remoteSignals.get(session.id);
      let label = live ? hook?.label ?? (hook ? '' : '终端运行中 · 未接入 hook') : '终端已停止';
      if (live && !hook && remote?.runId === run.id) { status = remote.status; label = remote.label; }
      if (hook?.status === 'working' && live && now - hook.updatedAt > 10 * 60_000) { status = 'unknown'; label = '超过 10 分钟未收到 hook'; }
      if (!this.connected) { status = 'unknown'; label = '后台连接已断开'; }
      return { sessionId: session.id, runId: run.id, title: session.title, project: projects.get(session.projectId) ?? '', status, label, hooked: !!hook, updatedAt: hook?.updatedAt ?? Date.parse(run.startedAt) };
    });
    return { preferences: { ...this.preferences }, sessions, connected: this.connected, images: { ...this.images }, imageVersion: this.imageVersion };
  }
  importImage(status: PetStatus, bytes: Buffer, name: string) {
    gifData(bytes);
    writeFileSync(path.join(this.folder, status + '.gif'), bytes, { mode: 0o600 });
    this.images[status] = path.basename(name); this.imageVersion++; this.changed();
  }
  resetImage(status: PetStatus) { rmSync(path.join(this.folder, status + '.gif'), { force: true }); delete this.images[status]; this.imageVersion++; this.changed(); }
  image(status: PetStatus): string | null {
    try { return gifData(readFileSync(path.join(this.folder, status + '.gif'))); } catch { return null; }
  }
  loadImages(statuses: readonly PetStatus[]) {
    for (const status of statuses) if (this.image(status)) this.images[status] = status + '.gif';
  }
}
