import { sshConnectionSchema, type SshConnectionConfig, type SshConnection } from '../shared/protocol';
import { release } from 'node:os';
import { windowsPtyFor } from '../shared/desktop';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RemoteConfig, RemoteAction, Agent, AgentDefinition, AgentDefinitionConfig, History, Project, Run, Session, Settings, State, TerminalConfig, HistoryQuery, NativeHistoryPage } from '../shared/protocol';
import { API_VERSION, DEFAULT_SETTINGS, MAX_ACTIVE_TERMINALS, settingsSchema, agentDefinitionSchema, isCustomAgent } from '../shared/protocol';

const emptyHistory = (): History => ({ messages: [], warnings: [], path: null, nativeSessionId: null });

export class Store {
  private db: DatabaseSync;

  constructor(private directory: string) {
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
      CREATE TABLE IF NOT EXISTS native_histories (
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, agent TEXT NOT NULL,
        nativeSessionId TEXT NOT NULL, title TEXT NOT NULL, updatedAt TEXT NOT NULL, history TEXT NOT NULL,
        PRIMARY KEY (projectId, agent, nativeSessionId)
      );
      CREATE INDEX IF NOT EXISTS histories_by_project ON native_histories(projectId, agent, updatedAt DESC, nativeSessionId);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
    `);
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_actions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, value TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS remote_actions_by_session ON remote_actions(sessionId, sequence);`);
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(row => row.name === 'remote')) this.db.exec('ALTER TABLE sessions ADD COLUMN remote TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_requests (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, value TEXT NOT NULL
    )`);
    // Additive migration preserves 0.1 projects, native history and saved screens.
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(row => row.name === 'terminal')) this.db.exec('ALTER TABLE sessions ADD COLUMN terminal TEXT');
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some(row => row.name === 'shell')) this.db.exec("ALTER TABLE runs ADD COLUMN shell TEXT NOT NULL DEFAULT ''");
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some(row => row.name === 'recordOutput')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN recordOutput INTEGER NOT NULL DEFAULT 1');
      this.db.exec("UPDATE runs SET recordOutput = 0 WHERE sessionId IN (SELECT id FROM sessions WHERE agent != 'shell')");
    }
    if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) < 5) {
      this.db.exec(`INSERT OR IGNORE INTO native_histories (projectId, agent, nativeSessionId, title, updatedAt, history)
        SELECT projectId, agent, nativeSessionId, title, updatedAt, history FROM sessions WHERE nativeSessionId IS NOT NULL ORDER BY updatedAt DESC`);
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS ssh_connections (id TEXT PRIMARY KEY, value TEXT NOT NULL, fingerprint TEXT)');
    this.db.exec('PRAGMA user_version = 5');
    for (const table of ['remote_actions', 'remote_requests']) for (const row of this.db.prepare(`SELECT id,value FROM ${table}`).all()) { const a = JSON.parse(String(row.value)); if (a.status === 'running') this.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify({ ...a, status: 'unknown', endedAt: new Date().toISOString() }), row.id); }
    // A new daemon cannot reattach a PTY owned by a previous process.
    this.db.prepare("UPDATE runs SET status = 'interrupted', endedAt = ?, error = '后台进程曾退出；可重新启动或通过 Agent 原生会话恢复' WHERE status IN ('running', 'stopping')").run(new Date().toISOString());
  }

  sshConnections(): SshConnection[] {
    return this.db.prepare('SELECT id,value FROM ssh_connections ORDER BY rowid').all().map(row => ({ id: String(row.id), ...sshConnectionSchema.parse(JSON.parse(String(row.value))) }));
  }
  sshConnection(id: string): SshConnection {
    const value = this.sshConnections().find(item => item.id === id);
    if (!value) throw new Error('SSH 连接不存在，请在设置中保存连接');
    return value;
  }
  saveSshConnection(config: SshConnectionConfig, id: string = randomUUID()): SshConnection {
    const value = sshConnectionSchema.parse(config), previous = this.sshConnections().find(item => item.id === id);
    if (this.sshConnections().some(item => item.id !== id && item.alias.toLowerCase() === value.alias.toLowerCase())) throw new Error('连接别名已存在');
    if (!previous && this.sshConnections().length >= 200) throw new Error('最多保存 200 个 SSH 连接');
    this.db.prepare('INSERT INTO ssh_connections (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value));
    this.db.prepare("UPDATE sessions SET remote=json_set(remote,'$.host',?) WHERE json_extract(remote,'$.connectionId')=?").run(value.alias,id);
    if (previous && (previous.hostname !== value.hostname || previous.port !== value.port)) this.db.prepare('UPDATE ssh_connections SET fingerprint=NULL WHERE id=?').run(id);
    return this.sshConnection(id);
  }
  sshFingerprint(id: string): string | null { return (this.db.prepare('SELECT fingerprint FROM ssh_connections WHERE id=?').get(id)?.fingerprint as string) ?? null; }
  trustSshFingerprint(id: string, fingerprint: string): void { this.db.prepare('UPDATE ssh_connections SET fingerprint=? WHERE id=?').run(fingerprint,id); }
  deleteSshConnection(id: string): void {
    this.sshConnection(id);
    if (this.db.prepare("SELECT id FROM sessions WHERE json_extract(remote,'$.connectionId')=? LIMIT 1").get(id)) throw new Error('请先删除或修改使用此连接的会话');
    this.db.prepare('DELETE FROM ssh_connections WHERE id=?').run(id);
  }

  state(): State {
    const projects = (this.db.prepare('SELECT id, name, path, createdAt FROM projects ORDER BY createdAt DESC').all() as unknown as Project[]).map(project => ({...project, remoteWorkspace: (process.platform==='win32'?path.resolve(project.path).toLowerCase():path.resolve(project.path)) === (process.platform==='win32'?path.resolve(this.directory,'remote-sessions').toLowerCase():path.resolve(this.directory,'remote-sessions'))}));
    const latest = this.db.prepare(`SELECT r.id, r.sessionId, r.pid, r.status, r.startedAt, r.endedAt, r.exitCode, r.command, r.shell, r.error, r.recordOutput
      FROM sessions s JOIN runs r ON r.rowid = (SELECT rowid FROM runs WHERE sessionId = s.id ORDER BY rowid DESC LIMIT 1)
      WHERE s.archived = 0`).all() as unknown as Run[];
    const bySession = new Map(latest.map(run => [run.sessionId, run]));
    const sessions = this.db.prepare('SELECT id, projectId, title, agent, command, terminal, remote, createdAt, updatedAt, nativeSessionId, transcriptPath FROM sessions WHERE archived = 0 ORDER BY updatedAt DESC').all()
      .map(row => ({ ...row, remote: row.remote ? JSON.parse(String(row.remote)) : null, terminal: row.terminal ? JSON.parse(String(row.terminal)) : null, latestRun: bySession.get(String(row.id)) ?? null })) as unknown as Session[];
    return { projects, sessions, agents: this.agents(), maxActiveTerminals: MAX_ACTIVE_TERMINALS, platform: process.platform, windowsPty: windowsPtyFor(process.platform, release()), settings: this.settings(), apiVersion: API_VERSION };
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
      if (previousKey !== key) this.db.prepare('DELETE FROM native_histories WHERE projectId = ?').run(id);
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
    const row = this.db.prepare('SELECT id, projectId, title, agent, command, terminal, remote, createdAt, updatedAt, nativeSessionId, transcriptPath FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error('会话不存在');
    const latestRun = this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, shell, error, recordOutput FROM runs WHERE sessionId = ? ORDER BY rowid DESC LIMIT 1').get(id) ?? null;
    return { ...row, remote: row.remote ? JSON.parse(String(row.remote)) : null, terminal: row.terminal ? JSON.parse(String(row.terminal)) : null, latestRun } as unknown as Session;
  }

  createSession(projectId: string, title: string, agent: Agent, command: string, terminal: TerminalConfig | null = null, remote: RemoteConfig | null = null): Session {
    this.project(projectId);
    command = this.sessionCommand(agent, command);
    if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE archived = 0').get()!.count) >= 2000) throw new Error('最多管理 2000 个未归档会话');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions (id, projectId, title, agent, command, terminal, remote, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, title, agent, command, terminal ? JSON.stringify(terminal) : null, remote ? JSON.stringify(remote) : null, now, now);
    return this.session(id);
  }

  rename(id: string, title: string): void { this.session(id); this.db.prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?').run(title, new Date().toISOString(), id); }
  archive(id: string): void { this.session(id); this.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id); }

  updateSession(id: string, title: string, agent: Agent, command: string, terminal: TerminalConfig | null, remote: RemoteConfig | null = null): Session {
    const previous = this.session(id);
    command = this.sessionCommand(agent, command);
    this.transaction(() => {
      if (previous.agent !== agent) this.writeHistory(id, emptyHistory());
      this.db.prepare('UPDATE sessions SET title = ?, agent = ?, command = ?, terminal = ?, remote = ?, updatedAt = ? WHERE id = ?').run(title, agent, command, terminal ? JSON.stringify(terminal) : null, remote ? JSON.stringify(remote) : null, new Date().toISOString(), id);
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

  saveRemoteAction(action: Omit<RemoteAction, 'sequence'>): RemoteAction {
    this.db.prepare('INSERT INTO remote_actions (id,sessionId,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(action.id, action.sessionId, JSON.stringify(action));
    if (action.kind === 'command') this.db.prepare('INSERT INTO remote_requests VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(action.id,action.sessionId,JSON.stringify(action));
    this.db.prepare('DELETE FROM remote_actions WHERE sessionId=? AND sequence NOT IN (SELECT sequence FROM remote_actions WHERE sessionId=? ORDER BY sequence DESC LIMIT 1000)').run(action.sessionId, action.sessionId);
    return this.remoteAction(action.id)!;
  }
  remoteAction(id: string): RemoteAction | null {
    const row = this.db.prepare('SELECT sequence,value FROM remote_actions WHERE id=?').get(id) ?? this.db.prepare('SELECT 0 AS sequence,value FROM remote_requests WHERE id=?').get(id);
    return row ? { ...JSON.parse(String(row.value)), sequence: Number(row.sequence) } : null;
  }
  remoteActions(sessionId: string, before = Number.MAX_SAFE_INTEGER): RemoteAction[] {
    this.session(sessionId);
    return this.db.prepare('SELECT sequence,value FROM remote_actions WHERE sessionId=? AND sequence<? ORDER BY sequence DESC LIMIT 50').all(sessionId, before).map(row => ({ ...JSON.parse(String(row.value)), sequence: Number(row.sequence) }));
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id = 1').get();
    if (row) { const parsed = settingsSchema.safeParse(JSON.parse(String(row.value))); if (parsed.success) return parsed.data; }
    return structuredClone(DEFAULT_SETTINGS);
  }
  saveSettings(value: Settings): Settings {
    const validated = settingsSchema.parse(value);
    if (validated.defaultAgent.startsWith('agent:')) this.agent(validated.defaultAgent);
    if (validated.defaultAgent === 'custom' && !validated.defaultCommand.trim()) throw new Error('请填写自定义 Agent 的默认启动命令');
    this.db.prepare('INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(JSON.stringify(validated));
    return validated;
  }
  agents(): AgentDefinition[] {
    return this.db.prepare('SELECT id, value FROM agents ORDER BY rowid').all().map(row => ({ id: String(row.id), ...agentDefinitionSchema.parse(JSON.parse(String(row.value))) }));
  }
  agent(id: string): AgentDefinition {
    const row = this.db.prepare('SELECT value FROM agents WHERE id = ?').get(id);
    if (!row) throw new Error('Agent 类型不存在，请重新选择');
    return { id, ...agentDefinitionSchema.parse(JSON.parse(String(row.value))) };
  }
  saveAgent(config: AgentDefinitionConfig, id = 'agent:' + randomUUID()): AgentDefinition {
    const value = agentDefinitionSchema.parse(config);
    const existing = this.db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!existing && this.agents().length >= 64) throw new Error('最多保存 64 种自定义 Agent');
    if (this.agents().some(agent => agent.id !== id && agent.name.toLocaleLowerCase() === value.name.toLocaleLowerCase())) throw new Error('Agent 名称已存在');
    this.db.prepare('INSERT INTO agents (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(id, JSON.stringify(value));
    return this.agent(id);
  }
  deleteAgent(id: string): void {
    this.agent(id);
    if (this.settings().defaultAgent === id) throw new Error('请先更换默认 Agent，再删除此类型');
    if (this.db.prepare('SELECT id FROM sessions WHERE agent = ? LIMIT 1').get(id)) throw new Error('此类型仍被会话使用，请先修改或删除这些会话');
    this.db.prepare('DELETE FROM native_histories WHERE agent = ?').run(id);
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }
  private sessionCommand(agent: Agent, command: string): string {
    if (agent.startsWith('agent:')) command = command.trim() ? command : this.agent(agent).command;
    if (agent.startsWith('agent:')) this.agent(agent);
    if (isCustomAgent(agent) && (!command.trim() || /[\r\n\x00]/.test(command) || command.length > 4096)) throw new Error('请填写单行启动命令');
    return command;
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
    this.db.prepare('DELETE FROM remote_requests WHERE sessionId=?').run(sessionId);
    this.db.prepare("INSERT INTO runs (id, sessionId, status, startedAt, command, cols, rows, shell) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)").run(id, sessionId, now, command, cols, rows, shell);
    this.db.prepare('UPDATE runs SET recordOutput = ? WHERE id = ?').run(this.session(sessionId).agent === 'shell' ? 1 : 0, id);
    this.db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(now, sessionId);
    return this.run(id);
  }

  run(id: string): Run {
    const row = this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, shell, error, recordOutput FROM runs WHERE id = ?').get(id);
    if (!row) throw new Error('运行记录不存在');
    return row as unknown as Run;
  }
  runs(id: string): Run[] { return this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, shell, error, recordOutput FROM runs WHERE sessionId = ? ORDER BY rowid DESC LIMIT 100').all(id) as unknown as Run[]; }
  deleteRun(id: string): void {
    const run = this.run(id);
    if (['running', 'stopping'].includes(run.status)) throw new Error('请先停止终端，再删除运行记录');
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }
  clearFinishedRuns(sessionId: string): string[] {
    this.session(sessionId);
    const ids = this.db.prepare("SELECT id FROM runs WHERE sessionId = ? AND status NOT IN ('running', 'stopping')").all(sessionId).map(row => String(row.id));
    this.db.prepare("DELETE FROM runs WHERE sessionId = ? AND status NOT IN ('running', 'stopping')").run(sessionId);
    return ids;
  }
  setPid(id: string, pid: number): void { this.db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, id); }
  stopping(id: string): void { this.db.prepare("UPDATE runs SET status = 'stopping' WHERE id = ?").run(id); }
  running(id: string): void { this.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(id); }
  finish(id: string, status: Run['status'], exitCode: number | null, error: string | null, snapshot: string, seq: number, cols: number, rows: number): void {
    if (!this.run(id).recordOutput) snapshot = '';
    this.db.prepare('UPDATE runs SET status = ?, endedAt = ?, exitCode = ?, error = ?, snapshot = ?, seq = ?, cols = ?, rows = ? WHERE id = ?').run(status, new Date().toISOString(), exitCode, error, snapshot, seq, cols, rows, id);
  }
  savedScreen(id: string): { snapshot: string; seq: number; cols: number; rows: number } {
    return this.db.prepare('SELECT snapshot, seq, cols, rows FROM runs WHERE id = ?').get(id) as unknown as { snapshot: string; seq: number; cols: number; rows: number };
  }
  saveHistoryEntry(id: string, history: History): void {
    const session = this.session(id);
    if (!history.nativeSessionId) return;
    const existing = this.nativeHistory(id, history.nativeSessionId);
    if (!existing && Number(this.db.prepare('SELECT COUNT(*) AS count FROM native_histories').get()!.count) >= 2000) throw new Error('最多保存 2000 条原生会话历史');
    const title = (history.messages.find(message => message.role === 'user')?.text.trim() || history.nativeSessionId).slice(0, 200);
    this.db.prepare(`INSERT INTO native_histories VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(projectId, agent, nativeSessionId)
      DO UPDATE SET title = excluded.title, updatedAt = excluded.updatedAt, history = excluded.history`).run(session.projectId, session.agent, history.nativeSessionId, title, new Date().toISOString(), JSON.stringify(history));
  }
  saveHistory(id: string, history: History): void {
    this.transaction(() => this.writeHistory(id, history));
  }
  private writeHistory(id: string, history: History): void {
    this.saveHistoryEntry(id, history);
    this.db.prepare('UPDATE sessions SET nativeSessionId = ?, transcriptPath = ?, history = ?, updatedAt = ? WHERE id = ?').run(history.nativeSessionId, history.path, JSON.stringify(history), new Date().toISOString(), id);
  }
  nativeHistory(id: string, nativeSessionId: string): History | null {
    const session = this.session(id);
    const row = this.db.prepare('SELECT history FROM native_histories WHERE projectId = ? AND agent = ? AND nativeSessionId = ?').get(session.projectId, session.agent, nativeSessionId);
    return row ? JSON.parse(String(row.history)) as History : null;
  }
  nativeHistories(id: string, options: HistoryQuery): NativeHistoryPage {
    const session = this.session(id);
    let after: { time: string; id: string } | null = null;
    if (options.cursor) {
      try {
        const value = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (value.project !== session.projectId || value.agent !== session.agent || value.query !== options.query || typeof value.time !== 'string' || typeof value.id !== 'string') throw new Error();
        after = value;
      } catch { throw new Error('分页已失效，请刷新会话列表'); }
    }
    const scope = [session.projectId, session.agent, options.query];
    const filter = 'projectId = ? AND agent = ? AND instr(lower(title || nativeSessionId), lower(?)) > 0';
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM native_histories WHERE ' + filter).get(...scope)!.count);
    const rows = this.db.prepare("SELECT nativeSessionId, title, updatedAt, json_extract(history, '$.path') AS path FROM native_histories WHERE " + filter + (after ? ' AND (updatedAt < ? OR (updatedAt = ? AND nativeSessionId > ?))' : '') + ' ORDER BY updatedAt DESC, nativeSessionId LIMIT ?').all(...scope, ...(after ? [after.time, after.time, after.id] : []), options.limit + 1);
    const page = rows.slice(0, options.limit), last = page.at(-1);
    const nextCursor = rows.length > options.limit && last ? Buffer.from(JSON.stringify({ project: session.projectId, agent: session.agent, query: options.query, time: last.updatedAt, id: last.nativeSessionId })).toString('base64url') : null;
    return { items: page.map(row => ({ nativeSessionId: String(row.nativeSessionId), title: String(row.title), updatedAt: String(row.updatedAt), path: row.path === null ? null : String(row.path) })), nextCursor, total, warnings: [] };
  }
  history(id: string): History {
    const row = this.db.prepare('SELECT history FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error('会话不存在');
    return JSON.parse(String(row.history)) as History;
  }
  close(): void { this.db.close(); }
}
