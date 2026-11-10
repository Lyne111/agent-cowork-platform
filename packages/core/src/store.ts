import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Event } from '../../protocol/src/index.js';

export type Table = 'projects' | 'profiles' | 'rules' | 'tasks' | 'runs' | 'commands' | 'artifacts' | 'reviews' | 'approvals' | 'questions' | 'acceptances';
const columns: Record<Table, Record<string, string>> = {
  projects: {}, profiles: {}, rules: { rule_id: 'id', version: 'version' },
  tasks: { project_id: 'projectId', owner_id: 'ownerId', status: 'status', version: 'version' },
  runs: { task_id: 'taskId', profile_id: 'profileId', role: 'role', status: 'status', workspace: 'workspacePath', flow: 'flow' },
  commands: { task_id: 'taskId', run_id: 'runId', status: 'status' },
  artifacts: { task_id: 'taskId', run_id: 'runId', version: 'version' },
  reviews: { task_id: 'taskId', run_id: 'runId', artifact_id: 'artifactId', profile_id: 'profileId' },
  approvals: { run_id: 'runId', native_id: 'nativeId' }, questions: { run_id: 'runId', native_id: 'nativeId' },
  acceptances: { task_id: 'taskId', artifact_id: 'artifactId' },
};

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('Database schema is newer than this application; refusing to open it.');
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(rule_id,version));
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_id TEXT NOT NULL REFERENCES profiles(id), status TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), profile_id TEXT NOT NULL REFERENCES profiles(id), role TEXT NOT NULL, status TEXT NOT NULL, workspace TEXT NOT NULL, flow INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(task_id,flow,role,profile_id));
        CREATE UNIQUE INDEX IF NOT EXISTS one_writer_per_task ON runs(task_id) WHERE role='implement' AND status NOT IN ('succeeded','failed','stopped');
        CREATE UNIQUE INDEX IF NOT EXISTS one_writer_per_workspace ON runs(workspace) WHERE role='implement' AND status NOT IN ('succeeded','failed','stopped');
        CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), run_id TEXT REFERENCES runs(id), status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT REFERENCES runs(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(task_id,version));
        CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT UNIQUE REFERENCES runs(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id), profile_id TEXT NOT NULL REFERENCES profiles(id), data TEXT NOT NULL, UNIQUE(artifact_id,profile_id));
        CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), native_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,native_id));
        CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), native_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,native_id));
        CREATE TABLE IF NOT EXISTS acceptances (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    });
  }
  transaction<T>(action: () => T): T {
    if (this.depth) return action();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  all<T>(table: Table): T[] {
    return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]).map(row => JSON.parse(row.data) as T);
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  put<T extends { id: string }>(table: Table, value: T): T {
    const record = value as T & Record<string, unknown>;
    const extra = columns[table];
    const names = ['id', ...Object.keys(extra), 'data'];
    const id = table === 'rules' ? String(record.revisionId) : value.id;
    const vals = [id, ...Object.values(extra).map(key => key === 'workspacePath' && process.platform === 'win32' ? String(record[key]).toLowerCase() : record[key] ?? null), JSON.stringify(value)] as (string | number | null)[];
    this.db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${names.slice(1).map(c => `${c}=excluded.${c}`).join(',')}`).run(...vals);
    return value;
  }
  event(event: Omit<Event, 'seq'>): Event {
    const result = this.db.prepare('INSERT INTO events(id,task_id,run_id,data) VALUES(?,?,?,?)').run(event.id,event.taskId,event.runId,JSON.stringify(event));
    return { ...event, seq: Number(result.lastInsertRowid) };
  }
  eventById(id: string): Event | undefined {
    const row = this.db.prepare('SELECT seq,data FROM events WHERE id=?').get(id) as { seq: number; data: string } | undefined;
    return row ? { ...JSON.parse(row.data), seq: row.seq } as Event : undefined;
  }
  eventsAfter(seq: number): Event[] {
    return (this.db.prepare('SELECT seq,data FROM events WHERE seq>? ORDER BY seq').all(seq) as { seq: number; data: string }[]).map(row => ({ ...JSON.parse(row.data), seq: row.seq } as Event));
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  }
  setSetting(key: string, value: unknown): void { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  close(): void { this.db.close(); }
}
