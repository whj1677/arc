import type { Explanation, Feature, Project, Snapshot } from '../shared';
import {
  architectureDocId, architectureUpdateStatus, buildModuleExclusionSignature, buildRelationExclusionSignature,
  normalizeBranchKey, seedArchitectureFromExplanation, validateArchitectureDocument,
  moduleReferencePaths, type ModuleReferencePaths, type ArchitectureDocument, type ArchitectureModule, type CodeBaseline, type ModuleDeleteImpact,
} from '../architecture-workspace';
import { sha } from './snapshot';
import { now, type Store } from './store';
import { collectInScopeFileHashes, detectWorkspaceGitState, frozenManifest } from './architecture-change-detector';
import { ArchitectureUpdater, type ArchitectureUpdateOptions } from './architecture-updater';
import { computeEvidenceFingerprint, createCodexSemanticAnalyzer, type IncrementalSemanticAnalyzer } from './architecture-semantic';
import { resolveArchitectureReviewDecision } from './architecture-review';
export { collectInScopeFileHashes, detectWorkspaceGitState, workspaceBranchKey } from './architecture-change-detector';
export { computeEvidenceFingerprint };

export class ArchitectureWorkspaceService {
  private readonly updater: ArchitectureUpdater;
  constructor(private readonly store: Store, private readonly changed: () => void = () => {},
    analyzer: IncrementalSemanticAnalyzer = createCodexSemanticAnalyzer(store, process.cwd())) {
    this.updater = new ArchitectureUpdater(store, analyzer, this.getArchitectureDocument.bind(this),
      this.saveArchitectureDocument.bind(this), changed);
  }

  checkArchitectureUpdates(projectId: string, opts?: { branchKey?: string }) {
    return this.updater.check(projectId, opts);
  }

  updateAffectedArchitecture(projectId: string, opts?: ArchitectureUpdateOptions) {
    return this.updater.update(projectId, opts);
  }

  async resolveArchitectureReview(projectId: string, opts: {
    branchKey?: string; reviewId: string; decision: 'accept' | 'reject' | 'defer'; note?: string;
  }) {
    const doc = await this.getArchitectureDocument(projectId, { branchKey: opts.branchKey });
    const document = resolveArchitectureReviewDecision(this.store, doc, opts,
      (next, version, companionWrite) => this.saveArchitectureDocument(projectId, next, version, companionWrite));
    return { document, versions: this.store.listArchitectureDocVersions(doc.id) };
  }

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

  saveArchitectureDocument(projectId: string, doc: ArchitectureDocument, expectedVersion?: number, companionWrite?: () => void) {
    this.store.get<Project>('project', projectId);
    const errors = validateArchitectureDocument(doc);
    if (errors.length) throw Error('架构文档校验失败：' + errors.join('；'));
    if (doc.project_id !== projectId || doc.branch_key !== normalizeBranchKey(doc.branch_key) ||
        doc.id !== architectureDocId(projectId, doc.branch_key)) throw Error('架构文档的工程、分支与标识不一致');
    const current = this.store.getArchitectureDocById(doc.id);
    const update_status = doc.update_status === 'up_to_date' ? architectureUpdateStatus(doc) : doc.update_status;
    const normalizeBaseline = (next: CodeBaseline | undefined, previous?: CodeBaseline) => {
      if (!next) return previous;
      if (previous?.snapshot_id === next.snapshot_id && previous.workspace_fingerprint === next.workspace_fingerprint) {
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
      ...doc, exclusions, update_status, baseline: normalizeBaseline(doc.baseline, current?.baseline), last_update,
      last_confirmed_version: update_status === 'up_to_date' ? (current?.version ?? 0) + 1 : current?.last_confirmed_version,
    }, expectedVersion ?? doc.version, companionWrite);
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
      referenced_features: this.referencingFeatures(project, branchKey, draftPaths),
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
      referenced_features: this.referencingFeatures(project, branchKey, draftPaths ?? moduleReferencePaths(mod)),
    };
  }

  private referencingFeatures(project: Project, branchKey: string, paths: ModuleReferencePaths) {
    const files = new Set([...paths.files, ...paths.directories]);
    if (!files.size) return [];
    const dirs = paths.directories.map(dir => dir.replace(/\/$/, ''));
    const overlaps = (file: string, directory = false) => files.has(file) ||
      dirs.some(dir => dir === '.' || file.startsWith(dir + '/')) ||
      directory && [...files].some(bound => file === '.' || bound.startsWith(file + '/'));
    const featureIds = new Set<string>();
    for (const { result } of this.store.latestFeatureExplanations(project, branchKey)) {
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
