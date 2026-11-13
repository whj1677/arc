import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export const now = () => new Date().toISOString();
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'arc.sqlite'));
    const version = (this.db.prepare('PRAGMA user_version').get() as any).user_version;
    if (version > 1) { this.db.close(); throw new Error(`数据库版本 ${version} 高于本程序支持的 1，已保留原数据。`); }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(run_id,event_id));
      CREATE INDEX IF NOT EXISTS events_order ON events(run_id,sequence);
      PRAGMA user_version=1;`);
  }
  all<T = any>(kind: string): T[] { return this.db.prepare('SELECT json FROM objects WHERE kind=? ORDER BY rowid').all(kind).map((r: any) => JSON.parse(r.json)); }
  get<T = any>(kind: string, key: string): T {
    const row = this.db.prepare('SELECT json FROM objects WHERE kind=? AND id=?').get(kind, key) as any;
    if (!row) throw new Error(`未找到 ${kind}：${key}`);
    return JSON.parse(row.json);
  }
  maybe<T = any>(kind: string, key: string): T | null { try { return this.get(kind, key); } catch { return null; } }
  put(kind: string, key: string, value: unknown) { this.db.prepare('INSERT INTO objects VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind, key, JSON.stringify(value)); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  event(runId: string, eventId: string, sequence: number, value: unknown) {
    return this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(runId, eventId, sequence, JSON.stringify(value)).changes > 0;
  }
  events(runId: string) { return this.db.prepare('SELECT json FROM events WHERE run_id=? ORDER BY sequence').all(runId).map((r: any) => JSON.parse(r.json)); }
  nextSequence(runId:string) { return Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE run_id=?').get(runId) as any).n); }
  backup(destination: string) {
    // VACUUM INTO makes a consistent SQLite backup, including committed WAL state.
    this.db.prepare('VACUUM INTO ?').run(destination);
  }
  close() { this.db.close(); }
}
