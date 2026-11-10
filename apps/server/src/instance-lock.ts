import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { HttpError } from './validation.js';

/** An operating-system-backed SQLite lock avoids guessing whether an old PID
 * was reused. It is released by the OS on process exit, including a crash.
 * This database contains no application records and is separate from WAL. */
export function acquireInstanceLock(dataDir: string): () => void {
  const lease = new DatabaseSync(join(dataDir, 'instance.lock.sqlite'));
  try {
    lease.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;');
    lease.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, acquired_at TEXT NOT NULL);');
    lease.exec('BEGIN EXCLUSIVE;');
    lease.prepare('INSERT INTO owner(id,pid,acquired_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,acquired_at=excluded.acquired_at').run(process.pid, new Date().toISOString());
    lease.exec('COMMIT; BEGIN EXCLUSIVE;');
  } catch (error) {
    lease.close();
    const code = (error as { errcode?: number }).errcode;
    if (code === 5 || code === 6 || /locked|busy/i.test(String(error))) throw new HttpError('INSTANCE_RUNNING', '该数据目录已由另一个工作台服务占用。请先关闭原服务，或使用独立的数据目录；不会强制接管活动任务。', 409);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { lease.exec('ROLLBACK;'); } finally { lease.close(); }
  };
}
