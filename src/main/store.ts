import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Explanation, Project } from '../shared';
import type { ContextEntry } from '../engineering';

export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export const now = () => new Date().toISOString();
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'arc.sqlite'));
    const version = (this.db.prepare('PRAGMA user_version').get() as any).user_version;
    if (version > 2) { this.db.close(); throw new Error(`数据库版本 ${version} 高于本程序支持的 2，已保留原数据。`); }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    // The upgrade only adds version history. SQLite rolls back a failed migration;
    // existing reading objects and committed WAL content are never rebuilt.
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.exec(`CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(run_id,event_id));
      CREATE INDEX IF NOT EXISTS events_order ON events(run_id,sequence);
      CREATE TABLE IF NOT EXISTS engineering_versions(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(kind,id,version));
      PRAGMA user_version=2;`); this.db.exec('COMMIT'); }
    catch(error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  all<T = any>(kind: string): T[] { return this.db.prepare('SELECT json FROM objects WHERE kind=? ORDER BY rowid').all(kind).map((r: any) => JSON.parse(r.json)); }
  latestOverview(project: Project): Explanation | undefined {
    if (!project.overview_scenario_id) return;
    const row = this.db.prepare(`SELECT json FROM objects WHERE kind='explanation'
      AND json_extract(json,'$.scenario_id')=? AND json_extract(json,'$.result.binding.project_id')=?
      ORDER BY json_extract(json,'$.created_at') DESC, rowid DESC LIMIT 1`).get(project.overview_scenario_id, project.project_id);
    return row ? JSON.parse(String(row.json)) : undefined;
  }
  projectContextEntries(projectId: string): ContextEntry[] {
    return this.db.prepare(`SELECT json FROM objects WHERE kind='engineering_context'
      AND json_extract(json,'$.project_id')=? ORDER BY rowid`).all(projectId).map(row => JSON.parse(String(row.json)));
  }
  get<T = any>(kind: string, key: string): T {
    const row = this.db.prepare('SELECT json FROM objects WHERE kind=? AND id=?').get(kind, key) as any;
    if (!row) throw new Error(`未找到 ${kind}：${key}`);
    return JSON.parse(row.json);
  }
  maybe<T = any>(kind: string, key: string): T | null { try { return this.get(kind, key); } catch { return null; } }
  put(kind: string, key: string, value: unknown) { this.db.prepare('INSERT INTO objects VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind, key, JSON.stringify(value)); }
  putVersion(kind:string,key:string,version:number,value:unknown) { this.db.prepare('INSERT INTO engineering_versions VALUES(?,?,?,?)').run(kind,key,version,JSON.stringify(value)); this.put(kind,key,value); }
  versions<T = any>(kind:string,key:string):T[] { return this.db.prepare('SELECT json FROM engineering_versions WHERE kind=? AND id=? ORDER BY version').all(kind,key).map((r:any)=>JSON.parse(r.json)); }
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
