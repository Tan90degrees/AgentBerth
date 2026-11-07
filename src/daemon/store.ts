import { sshConnectionSchema, type SshConnectionConfig, type SshConnection } from '../shared/protocol';
import { release } from 'node:os';
import { windowsPtyFor } from '../shared/desktop';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { RemoteTransfer, RemoteConfig, RemoteAction, Agent, AgentDefinition, AgentDefinitionConfig, DeletionUndo, History, Project, Run, Session, Settings, State, TerminalConfig, HistoryQuery, NativeHistoryPage } from '../shared/protocol';
import { API_VERSION, DEFAULT_SETTINGS, settingsSchema, agentDefinitionSchema, isCustomAgent } from '../shared/protocol';
import { restartPlanSchema, type RestartEntry } from './recovery';
import type {ManagedSessions,SessionOwner} from '../shared/protocol';
import type { AcpEvent } from '../shared/acp';

const emptyHistory = (): History => ({ messages: [], warnings: [], path: null, nativeSessionId: null });

// Deletions keep an exact, short-lived snapshot instead of a "recreate from
// the form" approximation: ids, native-session links and run records survive
// an undo. Order matters when restoring because several tables have foreign
// keys into projects/sessions.
const UNDO_TABLES = ['projects', 'sessions', 'runs', 'session_owners', 'native_histories', 'remote_actions', 'remote_requests', 'acp_sessions', 'acp_events', 'acp_turns'] as const;
type UndoTable = typeof UNDO_TABLES[number];
type Row = Record<string, unknown>;
interface DeletionPayload { tables: Partial<Record<UndoTable, Row[]>>; runIds: string[] }
type DeletionKind = 'project' | 'session' | 'runs';
interface DeletionRow { token: string; kind: DeletionKind; label: string; projectId: string; sessionId: string | null; deletedAt: string; payload: string }
const UNDO_TTL_MS = 30 * 60 * 1000;
const UNDO_LIMIT = 10;
const parsePayload = (value: unknown): DeletionPayload => {
  try {
    const parsed = JSON.parse(String(value)) as DeletionPayload;
    return { tables: parsed?.tables ?? {}, runIds: Array.isArray(parsed?.runIds) ? parsed.runIds.filter(id => typeof id === 'string') : [] };
  } catch { return { tables: {}, runIds: [] }; }
};

export class Store {
  private db: DatabaseSync;

  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const database=path.join(directory,'berth.sqlite');
    const existing=existsSync(database);
    this.db=new DatabaseSync(database);
    // Schema 6 is the first Cordis-only data format. Schema 7 adds a nullable
    // session worktree path. Schema 8 adds opt-in, read-only service sessions.
    // Schema 9 adds the short-lived deletion snapshots used by undo.
    const schemaVersion=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if(existing&&![6,7,8,9].includes(schemaVersion)){
      this.db.close();
      throw new Error('检测到旧版 AgentBerth 数据。新架构不支持原地升级，请退出应用并清除旧数据目录后重新启动。');
    }
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
        remote TEXT, terminal TEXT, worktreePath TEXT, service INTEGER NOT NULL DEFAULT 0,
        history TEXT NOT NULL DEFAULT '{"messages":[],"warnings":[],"path":null,"nativeSessionId":null}'
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), pid INTEGER,
        status TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, exitCode INTEGER,
        command TEXT NOT NULL, error TEXT, snapshot TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL DEFAULT 0,
        shell TEXT NOT NULL DEFAULT '', recordOutput INTEGER NOT NULL DEFAULT 1,
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
      CREATE TABLE IF NOT EXISTS restart_plan (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
    `);
    if(existing&&schemaVersion===6)this.db.exec('ALTER TABLE sessions ADD COLUMN worktreePath TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_actions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, value TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS remote_actions_by_session ON remote_actions(sessionId, sequence);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_requests (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, value TEXT NOT NULL
    )`);
    this.db.exec('CREATE TABLE IF NOT EXISTS ssh_connections (id TEXT PRIMARY KEY, value TEXT NOT NULL, fingerprint TEXT)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_owners(sessionId TEXT PRIMARY KEY,projectId TEXT NOT NULL,pluginId TEXT NOT NULL,taskId TEXT NOT NULL,kind TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS remove_session_owner AFTER DELETE ON sessions BEGIN DELETE FROM session_owners WHERE sessionId=old.id;END;`);
    if(existing&&schemaVersion<8)this.db.exec('ALTER TABLE sessions ADD COLUMN service INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`CREATE TABLE IF NOT EXISTS deletions (
      token TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL,
      projectId TEXT NOT NULL, sessionId TEXT, deletedAt TEXT NOT NULL, payload TEXT NOT NULL
    );`);
    this.db.exec('PRAGMA user_version = 9');
    this.db.exec(`CREATE TABLE IF NOT EXISTS acp_sessions(sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS acp_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS acp_events_session ON acp_events(sessionId,sequence);
      CREATE TABLE IF NOT EXISTS acp_turns(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,state TEXT NOT NULL);
      UPDATE acp_turns SET state='interrupted' WHERE state='running';`);
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
    const owners=new Map(this.db.prepare('SELECT sessionId,kind,pluginId,taskId,projectId FROM session_owners').all().map(({sessionId,...owner})=>[String(sessionId),owner]));
    const sessions = this.db.prepare('SELECT id, projectId, title, agent, command, terminal, remote, worktreePath, service, createdAt, updatedAt, nativeSessionId, transcriptPath FROM sessions WHERE archived = 0 ORDER BY updatedAt DESC').all()
      .map(row => ({ ...row, service:!!row.service, owner:owners.get(String(row.id)), remote: row.remote ? JSON.parse(String(row.remote)) : null, terminal: row.terminal ? JSON.parse(String(row.terminal)) : null, latestRun: bySession.get(String(row.id)) ?? null })) as unknown as Session[];
    const settings=this.settings();
    return { projects, sessions, agents: this.agents(), maxActiveTerminals: settings.maxActiveTerminals, maxSshTerminals: settings.maxSshTerminals, platform: process.platform, windowsPty: windowsPtyFor(process.platform, release()), settings, apiVersion: API_VERSION };
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

  private deleteProjectRows(id: string): string[] {
    this.project(id);
    const runIds = this.db.prepare('SELECT runs.id FROM runs JOIN sessions ON sessions.id = runs.sessionId WHERE sessions.projectId = ?').all(id).map(row => String(row.id));
    this.db.prepare('DELETE FROM runs WHERE sessionId IN (SELECT id FROM sessions WHERE projectId = ?)').run(id);
    this.db.prepare('DELETE FROM sessions WHERE projectId = ?').run(id);
    this.db.prepare('DELETE FROM session_owners WHERE projectId=?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return runIds;
  }

  deleteProject(id: string): string[] {
    return this.transaction(() => this.deleteProjectRows(id));
  }

  /** Delete a project while keeping an exact snapshot for the UI undo action. */
  deleteProjectWithUndo(id: string): { runIds: string[]; undo: DeletionUndo } {
    const project = this.project(id);
    return this.transaction(() => {
      const payload = this.captureDeletion('project', id);
      const runIds = this.deleteProjectRows(id);
      return { runIds, undo: this.recordDeletion('project', project.name, id, null, payload) };
    });
  }

  session(id: string): Session {
    const row = this.db.prepare('SELECT id, projectId, title, agent, command, terminal, remote, worktreePath, service, createdAt, updatedAt, nativeSessionId, transcriptPath FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error('会话不存在');
    const latestRun = this.db.prepare('SELECT id, sessionId, pid, status, startedAt, endedAt, exitCode, command, shell, error, recordOutput FROM runs WHERE sessionId = ? ORDER BY rowid DESC LIMIT 1').get(id) ?? null;
    return { ...row, service:!!row.service, owner:this.sessionOwner(String(row.id)), remote: row.remote ? JSON.parse(String(row.remote)) : null, terminal: row.terminal ? JSON.parse(String(row.terminal)) : null, latestRun } as unknown as Session;
  }

  sessionOwner(sessionId:string):SessionOwner|undefined{const row=this.db.prepare('SELECT kind,pluginId,taskId,projectId FROM session_owners WHERE sessionId=?').get(sessionId);return row as unknown as SessionOwner|undefined;}
  manageSessions(pluginId:string,value:ManagedSessions){
    if(!this.db.prepare('SELECT id FROM projects WHERE id=?').get(value.projectId))return;this.transaction(()=>{for(const sessionId of value.sessionIds){const previous=this.sessionOwner(sessionId),session=this.db.prepare('SELECT projectId,remote FROM sessions WHERE id=?').get(sessionId);if(previous&&(previous.pluginId!==pluginId||previous.taskId!==value.taskId||previous.projectId!==value.projectId))throw new Error('会话已由其他任务管理');if(session&&(session.projectId!==value.projectId||session.remote))throw new Error('不能接管其他项目或 SSH 会话');if(!previous)this.db.prepare('INSERT INTO session_owners VALUES (?,?,?,?,?)').run(sessionId,value.projectId,pluginId,value.taskId,value.kind);}});
  }
  createSession(projectId: string, title: string, agent: Agent, command: string, terminal: TerminalConfig | null = null, remote: RemoteConfig | null = null, worktreePath: string | null = null,requestedId?:string,service=false): Session {
    this.project(projectId);
    const owner=requestedId?this.sessionOwner(requestedId):undefined;if(owner&&(owner.projectId!==projectId||remote))throw new Error('任务会话归属与项目不匹配');
    command = this.sessionCommand(agent, command, service, remote);
    if(requestedId&&this.db.prepare('SELECT id FROM sessions WHERE id=?').get(requestedId)){
      const previous=this.session(requestedId),saved=this.db.prepare('SELECT archived FROM sessions WHERE id=?').get(requestedId);
      if(saved?.archived||JSON.stringify([previous.projectId,previous.agent,previous.command,previous.terminal,previous.remote??null,previous.worktreePath??null,!!previous.service])!==JSON.stringify([projectId,agent,command,terminal,remote,worktreePath,service]))throw new Error('会话创建请求 ID 已用于不同的启动配置');
      return previous;
    }
    if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE archived = 0').get()!.count) >= 2000) throw new Error('最多管理 2000 个未归档会话');
    const id = requestedId??randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions (id, projectId, title, agent, command, terminal, remote, worktreePath, service, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, title, agent, command, terminal ? JSON.stringify(terminal) : null, remote ? JSON.stringify(remote) : null, worktreePath, Number(service), now, now);
    return this.session(id);
  }

  rename(id: string, title: string): void { this.session(id); this.db.prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?').run(title, new Date().toISOString(), id); }
  archive(id: string): void { this.session(id); this.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id); }

  updateSession(id: string, title: string, agent: Agent, command: string, terminal: TerminalConfig | null, remote: RemoteConfig | null = null, worktreePath: string | null = null,service=false): Session {
    const previous = this.session(id);
    command = this.sessionCommand(agent, command, service, remote);
    this.transaction(() => {
      if (previous.agent !== agent || (previous.worktreePath??null)!==worktreePath) this.writeHistory(id, emptyHistory());
      this.db.prepare('UPDATE sessions SET title = ?, agent = ?, command = ?, terminal = ?, remote = ?, worktreePath = ?, service = ?, updatedAt = ? WHERE id = ?').run(title, agent, command, terminal ? JSON.stringify(terminal) : null, remote ? JSON.stringify(remote) : null, worktreePath, Number(service), new Date().toISOString(), id);
    });
    return this.session(id);
  }

  sessionIdsUnderPath(root:string):string[]{
    const canonical=path.resolve(root),windows=process.platform==='win32';
    return this.db.prepare('SELECT id,worktreePath FROM sessions WHERE worktreePath IS NOT NULL').all().filter(row=>{
      const value=path.resolve(String(row.worktreePath)),relative=path.relative(canonical,value);
      return windows?relative!== '..'&&!relative.startsWith('..\\')&&!path.isAbsolute(relative):relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
    }).map(row=>String(row.id));
  }
  deleteSessions(ids:string[]):string[]{
    const sessions=[...new Set(ids)];if(!sessions.length)return [];
    const runIds=sessions.flatMap(sessionId=>this.db.prepare('SELECT id FROM runs WHERE sessionId=?').all(sessionId).map(row=>String(row.id)));
    this.transaction(()=>{for(const sessionId of sessions){this.db.prepare('DELETE FROM runs WHERE sessionId=?').run(sessionId);this.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);}});
    return runIds;
  }

  private deleteSessionRows(id: string): string[] {
    this.session(id);
    const runIds = this.db.prepare('SELECT id FROM runs WHERE sessionId = ?').all(id).map(row => String(row.id));
    this.db.prepare('DELETE FROM runs WHERE sessionId = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return runIds;
  }

  deleteSession(id: string): string[] {
    return this.transaction(() => this.deleteSessionRows(id));
  }

  /** Delete a session while keeping an exact snapshot for the UI undo action. */
  deleteSessionWithUndo(id: string): { runIds: string[]; undo: DeletionUndo } {
    const session = this.session(id);
    return this.transaction(() => {
      const payload = this.captureDeletion('session', id);
      const runIds = this.deleteSessionRows(id);
      return { runIds, undo: this.recordDeletion('session', session.title, session.projectId, id, payload) };
    });
  }

  private rows(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as unknown as Row[];
  }

  private captureDeletion(kind: 'project' | 'session', id: string): DeletionPayload {
    const project = kind === 'project';
    const bySession = project ? 'IN (SELECT id FROM sessions WHERE projectId = ?)' : '= ?';
    const tables: Partial<Record<UndoTable, Row[]>> = {
      sessions: this.rows(project ? 'SELECT * FROM sessions WHERE projectId = ?' : 'SELECT * FROM sessions WHERE id = ?', id),
      runs: this.rows(project ? 'SELECT rowid, * FROM runs WHERE sessionId IN (SELECT id FROM sessions WHERE projectId = ?)' : 'SELECT rowid, * FROM runs WHERE sessionId = ?', id),
      session_owners: this.rows(project ? 'SELECT * FROM session_owners WHERE projectId = ?' : 'SELECT * FROM session_owners WHERE sessionId = ?', id),
    };
    if (project) {
      tables.projects = this.rows('SELECT * FROM projects WHERE id = ?', id);
      tables.native_histories = this.rows('SELECT * FROM native_histories WHERE projectId = ?', id);
    }
    for (const table of ['remote_actions', 'remote_requests', 'acp_sessions', 'acp_events', 'acp_turns'] as UndoTable[])
      tables[table] = this.rows(`SELECT * FROM ${table} WHERE sessionId ${bySession}`, id);
    const runIds = (tables.runs ?? []).map(row => String(row.id));
    return { tables, runIds };
  }

  private recordDeletion(kind: DeletionKind, label: string, projectId: string, sessionId: string | null, payload: DeletionPayload): DeletionUndo {
    const token = randomUUID();
    this.db.prepare('INSERT INTO deletions (token, kind, label, projectId, sessionId, deletedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(token, kind, label.slice(0, 100), projectId, sessionId, new Date().toISOString(), JSON.stringify(payload));
    return { token, kind, label, projectId, ...(sessionId ? { sessionId } : {}) };
  }

  /** Restore the exact rows captured by a deletion, or explain why it cannot be restored. */
  restoreDeletion(token: string): DeletionUndo {
    return this.transaction(() => {
      const row = this.rows('SELECT * FROM deletions WHERE token = ?', token)[0] as unknown as DeletionRow | undefined;
      if (!row) throw new Error('撤销记录已过期或已使用');
      // A long-running daemon may not have pruned yet, but the receipt is no
      // longer valid: its log files are already outside the protection window.
      const deletedAt = Date.parse(row.deletedAt);
      if (!Number.isFinite(deletedAt) || deletedAt < Date.now() - UNDO_TTL_MS) throw new Error('撤销时间已过，无法恢复');
      const payload = parsePayload(row.payload);
      const project = payload.tables.projects?.[0], session = payload.tables.sessions?.[0];
      if (row.kind === 'project') {
        if (!project) throw new Error('撤销记录已损坏，无法恢复');
        if (this.rows('SELECT id FROM projects WHERE id = ? OR pathKey = ?', String(project.id), String(project.pathKey)).length)
          throw new Error('同名项目目录已重新添加，无法撤销');
      } else if (row.kind === 'session') {
        if (!session) throw new Error('撤销记录已损坏，无法恢复');
        if (this.rows('SELECT id FROM sessions WHERE id = ?', String(session.id)).length) throw new Error('此会话已重新创建，无法撤销');
        if (!this.rows('SELECT id FROM projects WHERE id = ?', String(session.projectId)).length) throw new Error('所属项目已被删除，无法单独恢复此会话');
      } else {
        const runRows = payload.tables.runs ?? [];
        if (!runRows.length) throw new Error('撤销记录已损坏，无法恢复');
        for (const run of runRows) {
          if (this.rows('SELECT id FROM runs WHERE id = ?', String(run.id)).length) throw new Error('此运行记录已重新创建，无法撤销');
          if (!this.rows('SELECT id FROM sessions WHERE id = ?', String(run.sessionId)).length) throw new Error('所属会话已被删除，无法单独恢复运行记录');
        }
      }
      for (const table of UNDO_TABLES) this.insertRows(table, payload.tables[table] ?? []);
      this.db.prepare('DELETE FROM deletions WHERE token = ?').run(token);
      const result: DeletionUndo = { token, kind: row.kind, label: row.label, projectId: row.projectId, ...(row.sessionId ? { sessionId: row.sessionId } : {}) };
      if (row.kind === 'runs') result.runIds = payload.runIds;
      return result;
    });
  }

  private insertRows(table: UndoTable, rows: Row[]): void {
    if (!rows.length) return;
    const columns = Object.keys(rows[0]);
    const statement = this.db.prepare(`INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    for (const row of rows) statement.run(...columns.map(column => row[column] as string | number | null));
  }

  /** Drop stale snapshots and return the log run ids that are now safe to remove. */
  pruneDeletions(now = Date.now()): string[] {
    const rows = this.rows('SELECT token, deletedAt, payload FROM deletions ORDER BY rowid DESC');
    const stale = rows.filter((row, index) => index >= UNDO_LIMIT || Date.parse(String(row.deletedAt)) < now - UNDO_TTL_MS);
    if (!stale.length) return [];
    this.transaction(() => { for (const row of stale) this.db.prepare('DELETE FROM deletions WHERE token = ?').run(String(row.token)); });
    const protectedIds = new Set(this.undoRunIds());
    return [...new Set(stale.flatMap(row => parsePayload(row.payload).runIds))].filter(id => !protectedIds.has(id));
  }

  /** Log files of a recently deleted run must survive until its undo expires. */
  undoRunIds(): string[] {
    const now = Date.now();
    return [...new Set(this.rows('SELECT deletedAt, payload FROM deletions')
      .filter(row => Date.parse(String(row.deletedAt)) >= now - UNDO_TTL_MS)
      .flatMap(row => parsePayload(row.payload).runIds))];
  }

  saveRemoteAction(action: Omit<RemoteAction, 'sequence'>): RemoteAction {
    this.db.prepare('INSERT INTO remote_actions (id,sessionId,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(action.id, action.sessionId, JSON.stringify(action));
    if (action.kind === 'command'||action.kind==='transfer') this.db.prepare('INSERT INTO remote_requests VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(action.id,action.sessionId,JSON.stringify(action));
    this.db.prepare('DELETE FROM remote_actions WHERE sessionId=? AND sequence NOT IN (SELECT sequence FROM remote_actions WHERE sessionId=? ORDER BY sequence DESC LIMIT 1000)').run(action.sessionId, action.sessionId);
    return this.remoteAction(action.id)!;
  }
  remoteAction(id: string): RemoteAction | null {
    const row = this.db.prepare('SELECT sequence,value FROM remote_actions WHERE id=?').get(id) ?? this.db.prepare('SELECT 0 AS sequence,value FROM remote_requests WHERE id=?').get(id);
    return row ? { ...JSON.parse(String(row.value)), sequence: Number(row.sequence) } : null;
  }
  unresolvedRemoteAction(sessionId: string): RemoteAction | null {
    const row = this.db.prepare("SELECT value FROM remote_requests WHERE (sessionId=? OR json_extract(value,'$.transfer.spec.destination.sessionId')=?) AND json_extract(value,'$.status') IN ('running','unknown') ORDER BY CASE json_extract(value,'$.status') WHEN 'running' THEN 0 ELSE 1 END, rowid LIMIT 1").get(sessionId, sessionId);
    return row ? JSON.parse(String(row.value)) : null;
  }
  remoteActions(sessionId: string, before = Number.MAX_SAFE_INTEGER): RemoteAction[] {
    this.session(sessionId);
    return this.db.prepare('SELECT sequence,value FROM remote_actions WHERE sessionId=? AND sequence<? ORDER BY sequence DESC LIMIT 50').all(sessionId, before).map(row => ({ ...JSON.parse(String(row.value)), sequence: Number(row.sequence) }));
  }
  remoteTransfers(sessionId:string):RemoteTransfer[] {
    return this.db.prepare("SELECT value FROM remote_requests WHERE json_extract(value,'$.kind')='transfer' AND (sessionId=? OR json_extract(value,'$.transfer.spec.destination.sessionId')=?) ORDER BY rowid DESC LIMIT 20").all(sessionId,sessionId).map(row=>{
      const action=JSON.parse(String(row.value)) as RemoteAction;
      return {...action.transfer!,status:action.status==='unknown'?'unknown':action.transfer!.status};
    });
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
  acpState(sessionId:string):Record<string,any>{this.session(sessionId);const row=this.db.prepare('SELECT value FROM acp_sessions WHERE sessionId=?').get(sessionId);return row?JSON.parse(String(row.value)):{};}
  saveAcpState(sessionId:string,value:Record<string,unknown>):void{this.session(sessionId);this.db.prepare('INSERT INTO acp_sessions VALUES (?,?) ON CONFLICT(sessionId) DO UPDATE SET value=excluded.value').run(sessionId,JSON.stringify(value));}
  appendAcp(sessionId:string,turnId:string|null,kind:AcpEvent['kind'],text:string,data?:Record<string,unknown>):AcpEvent{
    const value={id:randomUUID(),sessionId,turnId,kind,text:text.slice(0,8192),...(data?{data}:{}),createdAt:new Date().toISOString()};
    const result=this.db.prepare('INSERT INTO acp_events(id,sessionId,value) VALUES (?,?,?)').run(value.id,sessionId,JSON.stringify(value));
    this.db.prepare('DELETE FROM acp_events WHERE sessionId=? AND sequence < COALESCE((SELECT sequence FROM acp_events WHERE sessionId=? ORDER BY sequence DESC LIMIT 1 OFFSET 4999),0)').run(sessionId,sessionId);
    return {...value,sequence:Number(result.lastInsertRowid)};
  }
  acpEvents(sessionId:string,{before,after,limit=100}:{before?:number;after?:number;limit?:number}={}):{events:AcpEvent[];before:number|null;hasMore:boolean}{
    this.session(sessionId);const rows=this.db.prepare(`SELECT sequence,value FROM acp_events WHERE sessionId=? AND sequence ${after!==undefined?'>':'<'} ? ORDER BY sequence ${after!==undefined?'ASC':'DESC'} LIMIT ?`).all(sessionId,after??before??Number.MAX_SAFE_INTEGER,limit+1);
    const hasMore=rows.length>limit,items=rows.slice(0,limit).map(row=>({...JSON.parse(String(row.value)),sequence:Number(row.sequence)}));if(after===undefined)items.reverse();return {events:items,before:items[0]?.sequence??null,hasMore};
  }
  acpTurn(id:string):{sessionId:string;state:string}|null{return this.db.prepare('SELECT sessionId,state FROM acp_turns WHERE id=?').get(id) as {sessionId:string;state:string}|undefined??null;}
  beginAcpTurn(sessionId:string,id:string):void{this.db.prepare('INSERT INTO acp_turns VALUES (?,?,?)').run(id,sessionId,'running');}
  finishAcpTurn(id:string,state:string):void{this.db.prepare('UPDATE acp_turns SET state=? WHERE id=?').run(state,id);}
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
  private sessionCommand(agent: Agent, command: string,service=false,remote?:RemoteConfig|null): string {
    if(service&&(agent!=='shell'||remote||!command.trim()||/[\r\n\x00]/.test(command)||command.length>4096))throw new Error('服务须使用本机普通终端并指定单行启动命令');
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

  createRun(sessionId: string, command: string, cols: number, rows: number, shell = '', preserveRequests = false): Run {
    this.session(sessionId);
    const id = randomUUID();
    const now = new Date().toISOString();
    if (!preserveRequests) this.db.prepare('DELETE FROM remote_requests WHERE sessionId=?').run(sessionId);
    // Undo must restore the original ordering used by latestRun. SQLite would
    // otherwise reuse deleted rowids, including when the runs table is empty.
    this.db.prepare(`INSERT INTO runs (rowid, id, sessionId, status, startedAt, command, cols, rows, shell)
      SELECT COALESCE(MAX(position), 0) + 1, ?, ?, 'running', ?, ?, ?, ?, ? FROM (
        SELECT MAX(rowid) AS position FROM runs
        UNION ALL
        SELECT CAST(json_extract(entry.value, '$.rowid') AS INTEGER) AS position
        FROM deletions, json_each(deletions.payload, '$.tables.runs') AS entry
      )`).run(id, sessionId, now, command, cols, rows, shell);
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

  /** Delete finished runs but keep their exact rows and logs until the undo receipt expires. */
  private deleteRunsWithUndo(rows: Row[], sessionId: string, label: string): DeletionUndo | null {
    if (!rows.length) return null;
    const { projectId } = this.session(sessionId);
    return this.transaction(() => {
      const ids = rows.map(row => String(row.id));
      const statement = this.db.prepare('DELETE FROM runs WHERE id = ?');
      for (const id of ids) statement.run(id);
      const undo = this.recordDeletion('runs', label, projectId, sessionId, { tables: { runs: rows }, runIds: ids });
      return { ...undo, runIds: ids };
    });
  }
  deleteRunWithUndo(id: string): DeletionUndo | null {
    const run = this.run(id);
    if (['running', 'stopping'].includes(run.status)) throw new Error('请先停止终端，再删除运行记录');
    return this.deleteRunsWithUndo(this.rows('SELECT rowid, * FROM runs WHERE id = ?', id), run.sessionId, `运行 ${id.slice(0, 8)}`);
  }
  clearFinishedRunsWithUndo(sessionId: string): DeletionUndo | null {
    const rows = this.rows("SELECT rowid, * FROM runs WHERE sessionId = ? AND status NOT IN ('running', 'stopping')", sessionId);
    return this.deleteRunsWithUndo(rows, sessionId, `${rows.length} 条运行记录`);
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
  saveRestartPlan(entries: RestartEntry[]): void {
    this.db.prepare('INSERT INTO restart_plan(id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(restartPlanSchema.parse(entries)));
  }
  takeRestartPlan(): RestartEntry[] {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT value FROM restart_plan WHERE id=1').get();
      const entries = row ? restartPlanSchema.parse(JSON.parse(String(row.value))) : [];
      this.db.prepare('DELETE FROM restart_plan WHERE id=1').run();
      return entries;
    });
  }
}
