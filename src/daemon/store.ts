import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Agent, History, Project, Run, Session, State } from '../shared/protocol';
import { MAX_ACTIVE_TERMINALS } from '../shared/protocol';

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
      PRAGMA user_version = 1;
    `);
    // A new daemon cannot reattach a PTY owned by a previous process.
    this.db.prepare("UPDATE runs SET status = 'interrupted', endedAt = ?, error = '后台进程曾退出；可重新启动或通过 Agent 原生会话恢复' WHERE status IN ('running', 'stopping')").run(new Date().toISOString());
  }

  state(): State {
    const projects = this.db.prepare('SELECT id, name, path, createdAt FROM projects ORDER BY createdAt DESC').all() as unknown as Project[];
    const sessions = this.db.prepare('SELECT id FROM sessions WHERE archived = 0 ORDER BY updatedAt DESC').all().map(row => this.session(String(row.id)));
    return { projects, sessions, maxActiveTerminals: MAX_ACTIVE_TERMINALS, platform: process.platform };
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

  session(id: string): Session {
    const row = this.db.prepare('SELECT id, projectId, title, agent, command, createdAt, updatedAt, nativeSessionId, transcriptPath FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error('会话不存在');
    return { ...row, latestRun: this.runs(id)[0] ?? null } as unknown as Session;
  }

  createSession(projectId: string, title: string, agent: Agent, command: string): Session {
    this.project(projectId);
    if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE archived = 0').get()!.count) >= 2000) throw new Error('最多管理 2000 个未归档会话');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions (id, projectId, title, agent, command, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, projectId, title, agent, command, now, now);
    return this.session(id);
  }

  rename(id: string, title: string): void { this.session(id); this.db.prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?').run(title, new Date().toISOString(), id); }
  archive(id: string): void { this.session(id); this.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id); }

  createRun(sessionId: string, command: string, cols: number, rows: number): Run {
    this.session(sessionId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO runs (id, sessionId, status, startedAt, command, cols, rows) VALUES (?, ?, 'running', ?, ?, ?, ?)").run(id, sessionId, now, command, cols, rows);
    this.db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(now, sessionId);
    return this.run(id);
  }

  run(id: string): Run {
    const row = this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, error FROM runs WHERE id = ?').get(id);
    if (!row) throw new Error('运行记录不存在');
    return row as unknown as Run;
  }
  runs(id: string): Run[] { return this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, error FROM runs WHERE sessionId = ? ORDER BY rowid DESC LIMIT 100').all(id) as unknown as Run[]; }
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
