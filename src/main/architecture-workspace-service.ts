import { isUtf8 } from 'node:buffer';
import fs from 'node:fs/promises';
import type { Explanation, Feature, Project, Snapshot, SourceEvidence } from '../shared';
import {
  architectureDocId, buildModuleExclusionSignature, buildRelationExclusionSignature, canonicalEvidenceKey,
  normalizeBranchKey, seedArchitectureFromExplanation, validateArchitectureDocument,
  moduleReferencePaths, type ModuleReferencePaths, type ArchitectureDocument, type ArchitectureModule, type CodeBaseline, type ModuleDeleteImpact,
} from '../architecture-workspace';
import { git } from './live-radar-git';
import { safeFile, sha, workspaceGitDirectory, workspacePaths } from './snapshot';
import { now, type Store } from './store';

export function workspaceBranchKey(branch?: string | null, commit?: string | null) {
  return normalizeBranchKey(branch ?? (commit ? 'HEAD:' + commit : undefined));
}

export async function detectWorkspaceGitState(rootPath: string) {
  if (!await workspaceGitDirectory(rootPath)) {
    return { isGit: false, branch: undefined, branchKey: workspaceBranchKey(), commit: undefined, dirty: false };
  }
  const status = await git(rootPath, 'status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind',
    '--no-renames', '--untracked-files=normal', '--', '.');
  const [headHeader, branchHeader, ...changes] = status.split('\0');
  const oid = headHeader.match(/^# branch\.oid (.+)$/)?.[1];
  const name = branchHeader.match(/^# branch\.head (.+)$/)?.[1];
  if (!oid || !name) throw Error('无法读取 Git 工作区标识');
  const commit = oid === '(initial)' ? undefined : oid;
  const branch = name === '(detached)' ? undefined : name;
  return { isGit: true, branch, branchKey: workspaceBranchKey(branch, commit), commit, dirty: changes.some(line => line && !line.startsWith('#')) };
}

export function computeEvidenceFingerprint(evidence: SourceEvidence[], extra?: string) {
  return sha(canonicalEvidenceKey(evidence, extra));
}

const inScope = (file: string) => !/(?:^|\/)(?:logs?|cache|coverage|target)(?:\/|$)|\.log(?:\.\d+)?$/i.test(file);

function manifest(entries: [string, string][]) {
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { file_hashes: Object.fromEntries(entries), workspace_fingerprint: sha(JSON.stringify(entries)) };
}

// With a frozen snapshot, use its recorded bytes even if the checkout has moved.
export async function collectInScopeFileHashes(rootPath: string, snapshot?: Snapshot) {
  if (snapshot) return frozenManifest(snapshot);
  const entries: [string, string][] = [];
  for await (const file of workspacePaths(rootPath, inScope)) {
    const input = await safeFile(rootPath, file);
    if ((await fs.stat(input)).size > 2 * 1024 * 1024) continue;
    const bytes = await fs.readFile(input);
    if (!bytes.includes(0) && isUtf8(bytes)) entries.push([file, sha(bytes)]);
  }
  return manifest(entries);
}

function frozenManifest(snapshot: Snapshot) {
  return manifest(snapshot.files.filter(file => inScope(file.path)).map(file => [file.path, file.content_sha256]));
}

export class ArchitectureWorkspaceService {
  constructor(private readonly store: Store, private readonly changed: () => void = () => {}) {}

  async getActiveArchitectureBranch(projectId: string) {
    const project = this.store.get<Project>('project', projectId);
    return (await detectWorkspaceGitState(project.root_path)).branchKey;
  }

  async getArchitectureDocument(projectId: string, opts: { branchKey?: string; version?: number } = {}) {
    const project = this.store.get<Project>('project', projectId);
    const gitState = opts.branchKey === undefined ? await detectWorkspaceGitState(project.root_path) : undefined;
    const branchKey = gitState?.branchKey ?? normalizeBranchKey(opts.branchKey);
    const docId = architectureDocId(projectId, branchKey);
    if (opts.version !== undefined) {
      const version = this.store.getArchitectureDocVersion(docId, opts.version);
      if (!version) throw Error(`Architecture document version ${opts.version} not found for ${docId}`);
      return version;
    }
    const saved = this.store.getArchitectureDocById(docId);
    if (saved) return saved;
    const explanation = this.store.latestOverview(project);
    if (!explanation) {
      const at = now();
      const draft: ArchitectureDocument = {
        id: docId, project_id: projectId, branch_key: branchKey, version: 0, title: project.name, summary: '',
        modules: [], relations: [], layout: { positions: {}, manual_positions: [] },
        exclusions: [], review_items: [], update_status: 'up_to_date', created_at: at, updated_at: at,
      };
      return draft;
    }
    const snapshot = this.store.get<Snapshot>('snapshot', explanation.result.binding.source_snapshot_id);
    const state = gitState ?? await detectWorkspaceGitState(project.root_path);
    const baseline = frozenManifest(snapshot);
    const live = await collectInScopeFileHashes(project.root_path);
    const after = await detectWorkspaceGitState(project.root_path);
    if (after.branchKey !== state.branchKey || after.commit !== state.commit) throw Error('采集期间 Git 分支或提交变化，请重试');
    const matches = baseline.workspace_fingerprint === live.workspace_fingerprint;
    const previous = this.store.db.prepare(`SELECT json_extract(json,'$.baseline.branch') AS branch
      FROM objects WHERE kind='architecture_doc' AND json_extract(json,'$.project_id')=?
      AND json_extract(json,'$.baseline.snapshot_id')=? AND json_type(json,'$.baseline.branch')='text'
      ORDER BY rowid LIMIT 1`).get(projectId, snapshot.source_snapshot_id) as { branch: string } | undefined;
    const seeded = seedArchitectureFromExplanation({
      projectId, branchKey, explanation, snapshot, fileHashes: baseline.file_hashes,
      workspaceFingerprint: baseline.workspace_fingerprint, commit: snapshot.commit ?? undefined,
      branch: previous?.branch ?? (matches && (snapshot.commit ?? undefined) === state.commit ? state.branch : undefined),
      dirty: Boolean(snapshot.dirty),
    });
    if (!matches || branchKey !== state.branchKey) seeded.update_status = 'changes_pending';
    // Another connection may have published v1 while this reader was hashing.
    try { return this.saveArchitectureDocument(projectId, seeded, 0); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Architecture document version conflict ')) {
        return this.store.get<ArchitectureDocument>('architecture_doc', docId);
      }
      throw error;
    }
  }

  saveArchitectureDocument(projectId: string, doc: ArchitectureDocument, expectedVersion?: number) {
    this.store.get<Project>('project', projectId);
    const errors = validateArchitectureDocument(doc);
    if (errors.length) throw Error('架构文档校验失败：' + errors.join('；'));
    if (doc.project_id !== projectId || doc.branch_key !== normalizeBranchKey(doc.branch_key) ||
        doc.id !== architectureDocId(projectId, doc.branch_key)) throw Error('架构文档的工程、分支与标识不一致');
    const current = this.store.getArchitectureDocById(doc.id);
    const confirmed = doc.update_status === 'up_to_date' && !doc.review_items.some(item => item.status === 'pending') &&
      !doc.modules.some(mod => mod.analysis_status === 'failed') &&
      !Object.values(doc.last_update?.module_outcomes ?? {}).some(outcome => outcome.status === 'failed');
    const normalizeBaseline = (next: CodeBaseline | undefined, previous?: CodeBaseline) => {
      if (!next) return previous;
      if (previous?.snapshot_id === next.snapshot_id) {
        return { ...next, fingerprint: previous.fingerprint,
          file_hashes: previous.file_hashes, workspace_fingerprint: previous.workspace_fingerprint };
      }
      const snapshot = this.store.get<Snapshot>('snapshot', next.snapshot_id);
      if (snapshot.project_id !== projectId) throw Error('架构基线快照不属于当前工程');
      return { ...next, fingerprint: snapshot.fingerprint, ...frozenManifest(snapshot) };
    };
    const exclusions = doc.exclusions.map(item => {
      if (item.evidence_fingerprint) {
        // Pure browser edits carry a canonical evidence key until the host hashes it.
        return item.evidence_fingerprint.startsWith('[') ? { ...item, evidence_fingerprint: sha(item.evidence_fingerprint) } : item;
      }
      const previous = current?.exclusions.find(entry => entry.id === item.id && entry.signature === item.signature);
      const target = item.target_kind === 'module'
        ? current?.modules.find(mod => buildModuleExclusionSignature(mod.id) === item.signature)
        : current?.relations.find(rel => buildRelationExclusionSignature(rel.from, rel.to, rel.kind) === item.signature);
      return { ...item, evidence_fingerprint: previous?.evidence_fingerprint ?? computeEvidenceFingerprint(target?.evidence ?? [], item.signature) };
    });
    const last_update = doc.last_update && { ...doc.last_update,
      read_baseline: normalizeBaseline(doc.last_update.read_baseline, current?.last_update?.read_baseline)! };
    const saved = this.store.saveArchitectureDoc({
      ...doc, exclusions, baseline: normalizeBaseline(doc.baseline, current?.baseline), last_update,
      last_confirmed_version: confirmed ? (current?.version ?? 0) + 1 : current?.last_confirmed_version,
    }, expectedVersion ?? current?.version ?? 0);
    this.changed();
    return saved;
  }

  getModuleDeleteImpact(projectId: string, branchKey: string, moduleId: string, draftPaths?: ModuleReferencePaths): ModuleDeleteImpact {
    const project = this.store.get<Project>('project', projectId);
    const doc = this.store.getArchitectureDoc(projectId, branchKey);
    const mod = doc?.modules.find(item => item.id === moduleId);
    // Draft-only modules have no saved hierarchy. The editor computes structural impact from the current draft.
    if (!mod && draftPaths) return {
      module_id: moduleId, module_name: moduleId, child_modules: [], descendant_count: 0, incident_relations: [],
      referenced_features: this.referencingFeatures(project, draftPaths),
    };
    if (!doc || !mod) throw Error('找不到指定架构模块：' + moduleId);
    const children = new Map<string, ArchitectureModule[]>();
    for (const item of doc.modules) {
      if (!item.parent_id) continue;
      const siblings = children.get(item.parent_id) ?? [];
      siblings.push(item);
      children.set(item.parent_id, siblings);
    }
    const direct = children.get(moduleId) ?? [];
    const descendants = [...direct];
    for (const child of descendants) descendants.push(...(children.get(child.id) ?? []));
    return {
      module_id: moduleId, module_name: mod.name,
      child_modules: direct.map(({ id, name }) => ({ id, name })), descendant_count: descendants.length,
      incident_relations: doc.relations.filter(rel => rel.from === moduleId || rel.to === moduleId)
        .map(({ id, from, to, label }) => ({ id, from, to, label })),
      referenced_features: this.referencingFeatures(project, draftPaths ?? moduleReferencePaths(mod)),
    };
  }

  private referencingFeatures(project: Project, paths: ModuleReferencePaths) {
    const files = new Set([...paths.files, ...paths.directories]);
    if (!files.size) return [];
    const dirs = paths.directories.map(dir => dir.replace(/\/$/, ''));
    const overlaps = (file: string, directory = false) => files.has(file) ||
      dirs.some(dir => dir === '.' || file.startsWith(dir + '/')) ||
      directory && [...files].some(bound => file === '.' || bound.startsWith(file + '/'));
    const featureIds = new Set<string>();
    const rows = this.store.db.prepare(`SELECT json FROM (SELECT json, row_number() OVER (
      PARTITION BY json_extract(json,'$.scenario_id') ORDER BY json_extract(json,'$.created_at') DESC,rowid DESC
      ) AS recency FROM objects WHERE kind='explanation' AND json_extract(json,'$.result.binding.project_id')=?
      AND json_extract(json,'$.scenario_id') IS NOT ?) WHERE recency=1`)
      .all(project.project_id, project.overview_scenario_id ?? null);
    for (const row of rows) {
      const { result } = JSON.parse(String(row.json)) as Explanation;
      if (result.evidence.some(ev => overlaps(ev.path)) || result.nodes.some(node =>
        node.source_scope && overlaps(node.source_scope.path, node.source_scope.kind === 'folder'))) featureIds.add(result.binding.feature_id);
    }
    return this.store.all<Feature>('feature').filter(feature => {
      if (feature.project_id !== project.project_id) return false;
      if (featureIds.has(feature.feature_id)) return true;
      if (!feature.discovery) return false;
      const { result_id, node_id } = feature.discovery;
      const result = this.store.maybe<Explanation>('explanation', result_id)?.result;
      const node = result?.nodes.find(node => node.node_id === node_id);
      if (!node || !result || result.binding.project_id !== project.project_id) return false;
      const ids = new Set(node.evidence_ids);
      const reading = result.feature_catalog?.readings?.find(item => item.node_id === node_id);
      for (const step of reading?.steps ?? []) for (const id of step.evidence_ids) ids.add(id);
      return !!(node.source_scope && overlaps(node.source_scope.path, node.source_scope.kind === 'folder')) ||
        result.evidence.some(ev => ids.has(ev.evidence_id) && overlaps(ev.path));
    }).map(feature => ({ id: feature.feature_id, title: feature.name }));
  }

  async listArchitectureVersions(projectId: string, branchKey?: string) {
    const key = branchKey ?? await this.getActiveArchitectureBranch(projectId);
    return this.store.listArchitectureDocVersions(architectureDocId(projectId, key));
  }

  restoreArchitectureVersion(projectId: string, branchKey: string, version: number) {
    const restored = this.store.restoreArchitectureDocVersion(architectureDocId(projectId, branchKey), version);
    this.changed();
    return restored;
  }

  listArchitectureBranches(projectId: string) {
    return this.store.db.prepare(`SELECT json_extract(json,'$.branch_key') AS branch FROM objects
      WHERE kind='architecture_doc' AND json_extract(json,'$.project_id')=? ORDER BY branch`).all(projectId)
      .map(row => String(row.branch));
  }
}
