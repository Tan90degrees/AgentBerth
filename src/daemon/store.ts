import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Agent, History, Project, Run, Session, Settings, State, TerminalConfig } from '../shared/protocol';
import { API_VERSION, DEFAULT_SETTINGS, MAX_ACTIVE_TERMINALS, settingsSchema } from '../shared/protocol';

const emptyHistory = (): History => ({ messages: [], warnings: [], path: null, nativeSessionId: null });

export class Store {
  private db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'berth.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, pathKey TEXT UNIQUE NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
        agent TEXT NOT NULL, command TEXT NOT NULL, nativeSessionId TEXT, transcriptPath TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        history TEXT NOT NULL DEFAULT '{"messages":[],"warnings":[],"path":null,"nativeSessionId":null}'
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), pid INTEGER,
        status TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, exitCode INTEGER,
        command TEXT NOT NULL, error TEXT, snapshot TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL DEFAULT 0,
        cols INTEGER NOT NULL DEFAULT 100, rows INTEGER NOT NULL DEFAULT 30
      );
      CREATE INDEX IF NOT EXISTS runs_by_session ON runs(sessionId, startedAt DESC);
      CREATE INDEX IF NOT EXISTS runs_by_session_row ON runs(sessionId);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
    `);
    // Additive migration preserves 0.1 projects, native history and saved screens.
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(row => row.name === 'terminal')) this.db.exec('ALTER TABLE sessions ADD COLUMN terminal TEXT');
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some(row => row.name === 'shell')) this.db.exec("ALTER TABLE runs ADD COLUMN shell TEXT NOT NULL DEFAULT ''");
    this.db.exec('PRAGMA user_version = 2');
    // A new daemon cannot reattach a PTY owned by a previous process.
    this.db.prepare("UPDATE runs SET status = 'interrupted', endedAt = ?, error = '后台进程曾退出；可重新启动或通过 Agent 原生会话恢复' WHERE status IN ('running', 'stopping')").run(new Date().toISOString());
  }

  state(): State {
    const projects = this.db.prepare('SELECT id, name, path, createdAt FROM projects ORDER BY createdAt DESC').all() as unknown as Project[];
    const latest = this.db.prepare(`SELECT r.id, r.sessionId, r.pid, r.status, r.startedAt, r.endedAt, r.exitCode, r.command, r.shell, r.error
      FROM sessions s JOIN runs r ON r.rowid = (SELECT rowid FROM runs WHERE sessionId = s.id ORDER BY rowid DESC LIMIT 1)
      WHERE s.archived = 0`).all() as unknown as Run[];
    const bySession = new Map(latest.map(run => [run.sessionId, run]));
    const sessions = this.db.prepare('SELECT id, projectId, title, agent, command, terminal, createdAt, updatedAt, nativeSessionId, transcriptPath FROM sessions WHERE archived = 0 ORDER BY updatedAt DESC').all()
      .map(row => ({ ...row, terminal: row.terminal ? JSON.parse(String(row.terminal)) : null, latestRun: bySession.get(String(row.id)) ?? null })) as unknown as Session[];
    return { projects, sessions, maxActiveTerminals: MAX_ACTIVE_TERMINALS, platform: process.platform, settings: this.settings(), apiVersion: API_VERSION };
  }

  project(id: string): Project {
    const row = this.db.prepare('SELECT id, name, path, createdAt FROM projects WHERE id = ?').get(id);
    if (!row) throw new Error('项目不存在');
    return row as unknown as Project;
  }

  createProject(name: string, canonicalPath: string): Project {
    const key = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
    const existing = this.db.prepare('SELECT id FROM projects WHERE pathKey = ?').get(key);
    if (existing) return this.project(String(existing.id));
    if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM projects').get()!.count) >= 200) throw new Error('最多管理 200 个项目');
    const id = randomUUID();
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(id, name, canonicalPath, key, new Date().toISOString());
    return this.project(id);
  }

  updateProject(id: string, name: string, canonicalPath: string): Project {
    const previous = this.project(id);
    const key = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
    const duplicate = this.db.prepare('SELECT id FROM projects WHERE pathKey = ? AND id != ?').get(key, id);
    if (duplicate) throw new Error('这个目录已属于另一个项目');
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET name = ?, path = ?, pathKey = ? WHERE id = ?').run(name, canonicalPath, key, id);
      const previousKey = process.platform === 'win32' ? previous.path.toLowerCase() : previous.path;
      if (previousKey !== key) this.db.prepare('UPDATE sessions SET nativeSessionId = NULL, transcriptPath = NULL, history = ?, updatedAt = ? WHERE projectId = ?').run(JSON.stringify(emptyHistory()), new Date().toISOString(), id);
    });
    return this.project(id);
  }

  projectSessionIds(id: string): string[] {
    this.project(id);
    return this.db.prepare('SELECT id FROM sessions WHERE projectId = ?').all(id).map(row => String(row.id));
  }

  deleteProject(id: string): string[] {
    this.project(id);
    const runIds = this.db.prepare('SELECT runs.id FROM runs JOIN sessions ON sessions.id = runs.sessionId WHERE sessions.projectId = ?').all(id).map(row => String(row.id));
    this.transaction(() => {
      this.db.prepare('DELETE FROM runs WHERE sessionId IN (SELECT id FROM sessions WHERE projectId = ?)').run(id);
      this.db.prepare('DELETE FROM sessions WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    return runIds;
  }

  session(id: string): Session {
    const row = this.db.prepare('SELECT id, projectId, title, agent, command, terminal, createdAt, updatedAt, nativeSessionId, transcriptPath FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error('会话不存在');
    const latestRun = this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, shell, error FROM runs WHERE sessionId = ? ORDER BY rowid DESC LIMIT 1').get(id) ?? null;
    return { ...row, terminal: row.terminal ? JSON.parse(String(row.terminal)) : null, latestRun } as unknown as Session;
  }

  createSession(projectId: string, title: string, agent: Agent, command: string, terminal: TerminalConfig | null = null): Session {
    this.project(projectId);
    if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE archived = 0').get()!.count) >= 2000) throw new Error('最多管理 2000 个未归档会话');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions (id, projectId, title, agent, command, terminal, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, title, agent, command, terminal ? JSON.stringify(terminal) : null, now, now);
    return this.session(id);
  }

  rename(id: string, title: string): void { this.session(id); this.db.prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?').run(title, new Date().toISOString(), id); }
  archive(id: string): void { this.session(id); this.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id); }

  updateSession(id: string, title: string, agent: Agent, command: string, terminal: TerminalConfig | null): Session {
    const previous = this.session(id);
    this.transaction(() => {
      if (previous.agent !== agent) this.saveHistory(id, emptyHistory());
      this.db.prepare('UPDATE sessions SET title = ?, agent = ?, command = ?, terminal = ?, updatedAt = ? WHERE id = ?').run(title, agent, command, terminal ? JSON.stringify(terminal) : null, new Date().toISOString(), id);
    });
    return this.session(id);
  }

  deleteSession(id: string): string[] {
    this.session(id);
    const runIds = this.db.prepare('SELECT id FROM runs WHERE sessionId = ?').all(id).map(row => String(row.id));
    this.transaction(() => {
      this.db.prepare('DELETE FROM runs WHERE sessionId = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
    return runIds;
  }

  settings(): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id = 1').get();
    if (row) { const parsed = settingsSchema.safeParse(JSON.parse(String(row.value))); if (parsed.success) return parsed.data; }
    return structuredClone(DEFAULT_SETTINGS);
  }
  saveSettings(value: Settings): Settings {
    const validated = settingsSchema.parse(value);
    this.db.prepare('INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(JSON.stringify(validated));
    return validated;
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createRun(sessionId: string, command: string, cols: number, rows: number, shell = ''): Run {
    this.session(sessionId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO runs (id, sessionId, status, startedAt, command, cols, rows, shell) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)").run(id, sessionId, now, command, cols, rows, shell);
    this.db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(now, sessionId);
    return this.run(id);
  }

  run(id: string): Run {
    const row = this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, shell, error FROM runs WHERE id = ?').get(id);
    if (!row) throw new Error('运行记录不存在');
    return row as unknown as Run;
  }
  runs(id: string): Run[] { return this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, shell, error FROM runs WHERE sessionId = ? ORDER BY rowid DESC LIMIT 100').all(id) as unknown as Run[]; }
  setPid(id: string, pid: number): void { this.db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, id); }
  stopping(id: string): void { this.db.prepare("UPDATE runs SET status = 'stopping' WHERE id = ?").run(id); }
  running(id: string): void { this.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(id); }
  finish(id: string, status: Run['status'], exitCode: number | null, error: string | null, snapshot: string, seq: number, cols: number, rows: number): void {
    this.db.prepare('UPDATE runs SET status = ?, endedAt = ?, exitCode = ?, error = ?, snapshot = ?, seq = ?, cols = ?, rows = ? WHERE id = ?').run(status, new Date().toISOString(), exitCode, error, snapshot, seq, cols, rows, id);
  }
  savedScreen(id: string): { snapshot: string; seq: number; cols: number; rows: number } {
    return this.db.prepare('SELECT snapshot, seq, cols, rows FROM runs WHERE id = ?').get(id) as unknown as { snapshot: string; seq: number; cols: number; rows: number };
  }
  saveHistory(id: string, history: History): void {
    this.db.prepare('UPDATE sessions SET nativeSessionId = ?, transcriptPath = ?, history = ?, updatedAt = ? WHERE id = ?').run(history.nativeSessionId, history.path, JSON.stringify(history), new Date().toISOString(), id);
  }
  history(id: string): History {
    const row = this.db.prepare('SELECT history FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error('会话不存在');
    return JSON.parse(String(row.history)) as History;
  }
  close(): void { this.db.close(); }
}
