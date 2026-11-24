import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodexPreferences, Explanation, Project } from '../shared';
import type { ContextEntry } from '../engineering';
import { architectureDocId, type ArchitectureDocument, type ArchitectureVersionSummary } from '../architecture-workspace';

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
  recentProjectExplanations(projectId: string): Explanation[] {
    return this.db.prepare(`SELECT json FROM objects WHERE kind='explanation'
      AND json_extract(json,'$.result.binding.project_id')=? ORDER BY rowid DESC LIMIT 10`)
      .all(projectId).reverse().map(row => JSON.parse(String(row.json)));
  }
  latestOverview(project: Project, branchKey?: string): Explanation | undefined {
    if (!project.overview_scenario_id) return;
    const row = this.db.prepare(`SELECT json FROM objects WHERE kind='explanation'
      AND json_extract(json,'$.scenario_id')=? AND json_extract(json,'$.result.binding.project_id')=?
      AND (? IS NULL OR coalesce(json_extract(json,'$.branch_key'),json_extract(json,'$.architecture_branch'),'') IN ('',?))
      ORDER BY json_extract(json,'$.created_at') DESC, rowid DESC LIMIT 1`).get(project.overview_scenario_id, project.project_id, branchKey ?? null, branchKey ?? null);
    return row ? JSON.parse(String(row.json)) : undefined;
  }
  latestFeatureExplanations(project: Project, branchKey?:string): Explanation[] {
    return this.db.prepare(`SELECT json FROM (SELECT json, row_number() OVER (
      PARTITION BY json_extract(json,'$.scenario_id') ORDER BY json_extract(json,'$.created_at') DESC, rowid DESC
      ) AS recency FROM objects WHERE kind='explanation' AND json_extract(json,'$.result.binding.project_id')=?
      AND json_extract(json,'$.scenario_id') IS NOT ? AND (? IS NULL OR
      coalesce(json_extract(json,'$.branch_key'),json_extract(json,'$.architecture_branch'),'') IN ('',?))) WHERE recency=1`)
      .all(project.project_id, project.overview_scenario_id ?? null, branchKey ?? null, branchKey ?? null).map(row => JSON.parse(String(row.json)));
  }
  developmentExplanations(project: Project): Explanation[] {
    if (!project.overview_scenario_id) return [];
    return this.db.prepare(`SELECT json FROM objects WHERE kind='explanation'
      AND json_extract(json,'$.result.binding.project_id')=?
      AND (json_extract(json,'$.scenario_id')=? AND json_type(json,'$.result.feature_catalog')='object'
        OR json_extract(json,'$.source_status')='current' AND json_extract(json,'$.result.binding.source_snapshot_id')=?
          AND json_array_length(json,'$.result.function_walkthroughs')>0)
      ORDER BY json_extract(json,'$.created_at') DESC, rowid DESC`)
      .all(project.project_id, project.overview_scenario_id, project.snapshot_id).map(row => JSON.parse(String(row.json)));
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
  codexPreferences(): CodexPreferences {
    return this.maybe<CodexPreferences>('settings', 'codex_preferences') ?? { model: '', reasoning_effort: 'auto' };
  }
  private putJson(kind: string, key: string, json: string) {
    this.db.prepare('INSERT INTO objects VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind, key, json);
  }
  put(kind: string, key: string, value: unknown) { this.putJson(kind, key, JSON.stringify(value)); }
  putVersion(kind: string, key: string, version: number, value: unknown) {
    const json = JSON.stringify(value);
    this.db.prepare('INSERT INTO engineering_versions VALUES(?,?,?,?)').run(kind, key, version, json);
    this.putJson(kind, key, json);
    return json;
  }
  versions<T = any>(kind:string,key:string):T[] { return this.db.prepare('SELECT json FROM engineering_versions WHERE kind=? AND id=? ORDER BY version').all(kind,key).map((r:any)=>JSON.parse(r.json)); }
  getArchitectureDoc(projectId: string, branchKey?: string) {
    return this.getArchitectureDocById(architectureDocId(projectId, branchKey));
  }
  getArchitectureDocById(docId: string): ArchitectureDocument | undefined {
    const row = this.db.prepare("SELECT json FROM objects WHERE kind='architecture_doc' AND id=?").get(docId);
    return row && JSON.parse(String(row.json));
  }
  findArchitectureDocForSnapshot(projectId: string, snapshotId: string, preferredBranchKey?: string): ArchitectureDocument | undefined {
    // A check can update the current row without adding a version. Prefer it over its history copy.
    const row = this.db.prepare(`SELECT json FROM (
      SELECT json, 1 AS head FROM objects WHERE kind='architecture_doc'
      UNION ALL SELECT json, 0 AS head FROM engineering_versions WHERE kind='architecture_doc')
      WHERE json_extract(json,'$.project_id')=? AND
        ? IN (json_extract(json,'$.baseline.snapshot_id'), json_extract(json,'$.last_update.read_baseline.snapshot_id'))
      ORDER BY (json_extract(json,'$.branch_key')=?) DESC,
        (json_extract(json,'$.branch_key')=json_extract(json,'$.baseline.branch')) DESC, head DESC,
        json_extract(json,'$.updated_at') DESC, json_extract(json,'$.version') DESC, json_extract(json,'$.branch_key')
      LIMIT 1`).get(projectId, snapshotId, preferredBranchKey ?? null);
    return row && JSON.parse(String(row.json));
  }
  listArchitectureDocs(projectId: string): ArchitectureDocument[] {
    return this.db.prepare(`SELECT json FROM objects WHERE kind='architecture_doc'
      AND json_extract(json,'$.project_id')=? ORDER BY json_extract(json,'$.branch_key')`)
      .all(projectId).map(row => JSON.parse(String(row.json)));
  }
  saveArchitectureDoc(doc: ArchitectureDocument, expectedVersion?: number, companionWrite?: () => void): ArchitectureDocument {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT json_extract(json,'$.version') AS version FROM objects WHERE kind='architecture_doc' AND id=?").get(doc.id);
      const currentVersion = row ? Number(row.version) : 0;
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new Error(`Architecture document version conflict for ${doc.id}: expected ${expectedVersion}, current ${currentVersion}`);
      }
      const next = { ...doc, version: currentVersion + 1, updated_at: now() };
      companionWrite?.();
      return JSON.parse(this.putVersion('architecture_doc', doc.id, next.version, next));
    });
  }
  patchArchitectureCheckState(docId: string, expectedVersion: number,
    pending_changes_summary: ArchitectureDocument['pending_changes_summary'],
    update_status: ArchitectureDocument['update_status']): ArchitectureDocument {
    return this.transaction(() => {
      const current = this.getArchitectureDocById(docId);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        throw new Error(`Architecture document version conflict for ${docId}: expected ${expectedVersion}, current ${currentVersion}`);
      }
      if (!current) throw new Error(`未找到 architecture_doc：${docId}`);
      const json = JSON.stringify({ ...current, pending_changes_summary, update_status });
      this.putJson('architecture_doc', docId, json);
      return JSON.parse(json);
    });
  }
  listArchitectureDocVersions(docId: string): ArchitectureVersionSummary[] {
    return this.db.prepare(`SELECT version, json_extract(json,'$.title') AS title,
      json_extract(json,'$.updated_at') AS updated_at, json_extract(json,'$.update_status') AS update_status,
      json_array_length(json,'$.modules') AS module_count, json_array_length(json,'$.relations') AS relation_count
      FROM engineering_versions WHERE kind='architecture_doc' AND id=? ORDER BY version DESC`)
      .all(docId) as unknown as ArchitectureVersionSummary[];
  }
  getArchitectureDocVersion(docId: string, version: number): ArchitectureDocument | undefined {
    const row = this.db.prepare("SELECT json FROM engineering_versions WHERE kind='architecture_doc' AND id=? AND version=?").get(docId, version);
    return row && JSON.parse(String(row.json));
  }
  restoreArchitectureDocVersion(docId: string, targetVersion: number): ArchitectureDocument {
    const target = this.getArchitectureDocVersion(docId, targetVersion);
    if (!target) throw new Error(`Architecture document version ${targetVersion} not found for ${docId}`);
    const currentVersion = this.getArchitectureDocById(docId)?.version ?? 0;
    return this.saveArchitectureDoc({
      ...target, pending_changes_summary: undefined, update_status: 'changes_pending',
    }, currentVersion);
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  event(runId: string, eventId: string, sequence: number, value: unknown) {
    return this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(runId, eventId, sequence, JSON.stringify(value)).changes > 0;
  }
  events(runId: string) { return this.db.prepare('SELECT json FROM events WHERE run_id=? ORDER BY sequence').all(runId).map((r: any) => JSON.parse(r.json)); }
  overviewReadLocations(runId: string,limit:number) {
    // Return one successful discovery read per file without loading all tool responses.
    return this.db.prepare(`WITH reads AS (
      SELECT sequence, json_extract(json,'$.item.arguments.path') AS path,
        coalesce(json_extract(json,'$.item.arguments.line_start'),1) AS start,
        coalesce(json_extract(json,'$.item.arguments.line_count'),160) AS count
      FROM events WHERE run_id=? AND json_extract(json,'$.phase') IS NULL
        AND json_extract(json,'$.type')='item.completed'
        AND json_extract(json,'$.item.server')='arc_frozen_source'
        AND json_extract(json,'$.item.tool')='arc_read_source'
        AND json_extract(json,'$.item.status')='completed'
        AND json_extract(json,'$.item.error') IS NULL
        AND NOT coalesce(json_extract(json,'$.item.result.isError'),0)
    ) SELECT path,start,count FROM reads WHERE path IS NOT NULL GROUP BY path ORDER BY min(sequence) LIMIT ?`).all(runId,limit) as {path:string;start:number;count:number}[];
  }
  nextSequence(runId:string) { return Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE run_id=?').get(runId) as any).n); }
  backup(destination: string) {
    // VACUUM INTO makes a consistent SQLite backup, including committed WAL state.
    this.db.prepare('VACUUM INTO ?').run(destination);
  }
  close() { this.db.close(); }
}
