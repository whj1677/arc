import { isDeepStrictEqual } from 'node:util';
import {
  architectureUpdateStatus, moduleReferencePaths, type ArchitectureDocument, type CodeBaseline,
  type CodeBinding, type ReviewItem, type UpdateRunRecord,
} from '../architecture-workspace';
import type { Project, Snapshot, SourceEvidence } from '../shared';
import { detectArchitectureChanges, detectWorkspaceGitState, frozenManifest, type ArchitectureDetection } from './architecture-change-detector';
import { analyzeArchitectureImpact, captureArchitectureSnapshot } from './architecture-impact';
import { getCodeIndex } from './code-index';
import {
  makeReviewItem, type IncrementalSemanticAnalyzer, type SemanticProposal, type SemanticUnit, validateSemanticProposals,
} from './architecture-semantic';
import { sha } from './snapshot';
import { id, now, type Store } from './store';

export type { IncrementalSemanticAnalyzer } from './architecture-semantic';
export interface ArchitectureUpdateOptions { branchKey?: string; moduleIds?: string[]; retryFailedOnly?: boolean }
type Impact = Awaited<ReturnType<typeof analyzeArchitectureImpact>>;
type Outcome = UpdateRunRecord['module_outcomes'][string];
const staleReason = '分析期间代码已变更为新状态，本次分析结果仅绑定读取快照 S1，不能标记为最新结果，请重新检查更新';
const unitKey = (unit: SemanticUnit) => JSON.stringify([unit.kind, unit.explanation?.scenario_id ?? unit.id]);

function sameReadState(baseline: CodeBaseline | undefined, detection: ArchitectureDetection) {
  const git = detection.live_git;
  return baseline && detection.detection_summary.detection_reliable &&
    baseline.workspace_fingerprint === detection.live_workspace_fingerprint &&
    baseline.commit === git.commit && baseline.branch === git.branch && baseline.dirty === git.dirty;
}

function semanticUnits(doc: ArchitectureDocument, impact: Impact, detection: ArchitectureDetection,
  store: Store, project: Project): SemanticUnit[] {
  const files = Object.keys(detection.live_hashes);
  const moves = new Map(detection.rename_details.map(move => [move.old_path, move.path]));
  function paths(bindings: { files: string[]; directories: string[] }) {
    const selected = new Set(bindings.files.map(file => moves.get(file) ?? file));
    return files.filter(file => selected.has(file) || bindings.directories.some(dir => dir === '.' || file.startsWith(dir.replace(/\/$/, '') + '/')));
  }
  const units: SemanticUnit[] = [];
  for (const mod of doc.modules) {
    if (impact.impact_summary.affected_module_ids.includes(mod.id) || mod.analysis_status === 'failed') {
      units.push({ kind: 'module', id: mod.id, paths: paths(moduleReferencePaths(mod)) });
    }
  }
  for (const file of impact.impact_summary.unmapped_files) units.push({ kind: 'unmapped', id: file, paths: [file] });
  if (impact.affectedScenarioIds.length) {
    for (const explanation of store.latestFeatureExplanations(project, doc.branch_key)) {
      if (!impact.affectedScenarioIds.includes(explanation.scenario_id)) continue;
      units.push({ kind: 'feature', id: explanation.result.binding.feature_id,
        paths: impact.scenarioPaths[explanation.scenario_id], explanation });
    }
  }
  return units;
}

function applyRelocations(doc: ArchitectureDocument, impact: Impact, run: UpdateRunRecord) {
  for (const move of impact.autoRelocations) {
    const target = move.target_kind === 'module' ? doc.modules.find(m => m.id === move.target_id) : doc.relations.find(r => r.id === move.target_id);
    if (!target) continue;
    const list: Array<CodeBinding | SourceEvidence> = move.field === 'evidence' ? target.evidence : 'code_links' in target ? target.code_links : [];
    // Compare the individual binding. Concurrent edits to another binding or to layout are independent.
    const pos = list.findIndex(entry => isDeepStrictEqual(entry, move.before));
    if (pos < 0) continue;
    list[pos] = move.after;
    const moved = move.before.path !== move.after.path;
    run.auto_updates.push({ id: id('auto'), kind: moved ? 'file_moved' : move.field === 'evidence' ? 'evidence_refreshed' : 'code_link_relocated',
      target_id: target.id, target_name: 'name' in target ? target.name : target.label,
      description: moved ? '已按相同文件内容迁移引用' : '已按未变化的源码符号更新行号与哈希',
      old_path: move.before.path, new_path: move.after.path, at: now() });
  }
}

// A changed rename candidate has no trustworthy old line numbers. Show the new file
// as context and let review confirm the association before replacing any binding.
function uncertainRenames(doc: ArchitectureDocument, detection: ArchitectureDetection, snapshot: Snapshot) {
  const proposals: SemanticProposal[] = [];
  for (const move of detection.rename_details.filter(item => item.rename_confidence === 'uncertain')) {
    const file = snapshot.files.find(f => f.path === move.path)!;
    if (!file.line_count) continue;
    for (const target of [...doc.modules, ...doc.relations]) {
      const links = 'code_links' in target ? target.code_links.filter(link => link.path === move.old_path) : [];
      const oldEvidence = target.evidence.filter(ev => ev.path === move.old_path);
      const directoryOwner = 'code_links' in target && target.code_links.some(link => link.kind === 'directory' &&
        (link.path === '.' || move.old_path.startsWith(link.path.replace(/\/$/, '') + '/')));
      if (!links.length && !oldEvidence.length && !directoryOwner) continue;
      const note = `疑似文件移动：${move.old_path} → ${move.path}，需确认源码引用`;
      const context: SourceEvidence = { evidence_id: id('evidence'), source_snapshot_id: snapshot.source_snapshot_id,
        content_sha256: file.content_sha256, path: file.path, line_start: 1, line_end: file.line_count, role: 'context', note };
      const evidence = oldEvidence.map(ev => ({ ...context, evidence_id: ev.evidence_id }));
      const code_links = links.map(link => ({ ...link, kind: 'file', path: file.path, file_sha256: file.content_sha256,
        symbol_name: undefined, symbol_id: undefined, start_line: undefined, end_line: undefined }));
      proposals.push({ category: 'rename_uncertain', target_id: target.id, target_kind: 'code_links' in target ? 'module' : 'relation',
        title: note, proposed: 'code_links' in target ? { code_links, evidence } : { evidence }, evidence: [context] });
    }
  }
  return proposals;
}

function reviewNotice(doc: ArchitectureDocument, snapshot: Snapshot, category: 'rename_uncertain' | 'uncertain',
  title: string, filePath?: string, target_id?: string, target_kind?: ReviewItem['target_kind']): ReviewItem {
  const file = snapshot.files.find(entry => entry.path === filePath);
  const evidence: SourceEvidence[] = file?.line_count ? [{ evidence_id: id('evidence'), source_snapshot_id: snapshot.source_snapshot_id,
    path: file.path, content_sha256: file.content_sha256, line_start: 1, line_end: file.line_count, role: 'context', note: title }] : [];
  const evidence_fingerprint = sha(JSON.stringify([filePath, file?.content_sha256, title]));
  return { id: id('review'), dedupe_key: sha(JSON.stringify([category, target_id, evidence_fingerprint])), evidence_fingerprint,
    category, target_id, target_kind, title, scope_summary: title, status: 'pending', branch: doc.branch_key,
    evidence, code_baseline_fingerprint: snapshot.fingerprint, created_at: now() };
}

export class ArchitectureUpdater {
  private readonly running = new Set<string>();
  constructor(private readonly store: Store, private readonly analyzer: IncrementalSemanticAnalyzer,
    private readonly load: (projectId: string, opts?: { branchKey?: string }) => Promise<ArchitectureDocument>,
    private readonly save: (projectId: string, doc: ArchitectureDocument, expectedVersion: number) => ArchitectureDocument,
    private readonly changed: () => void) {}

  private persistCheckState(doc: ArchitectureDocument): ArchitectureDocument {
    if (doc.version === 0) return doc;
    const saved = this.store.patchArchitectureCheckState(doc.id, doc.version, doc.pending_changes_summary, doc.update_status);
    this.changed();
    return saved;
  }

  private async inputs(projectId: string, branchKey?: string) {
    const project = this.store.get<Project>('project', projectId);
    if (branchKey === undefined) {
      try { branchKey = (await detectWorkspaceGitState(project.root_path)).branchKey; }
      catch (error) {
        // A lost checkout cannot identify an active branch. A sole saved document
        // can still record the failed check without borrowing another branch's state.
        const saved = this.store.listArchitectureDocs(projectId);
        if (saved.length !== 1) throw error;
        branchKey = saved[0].branch_key;
      }
    }
    const doc = await this.load(projectId, { branchKey });
    const detection = await detectArchitectureChanges(project.root_path, doc);
    if (detection.detection_summary.detection_reliable && detection.live_git.branchKey !== doc.branch_key) {
      throw Error('当前工作区与架构文档分支不一致，请切换到目标分支再检查更新');
    }
    return { project, doc, detection };
  }

  async check(projectId: string, opts: { branchKey?: string } = {}) {
    const { project, doc, detection } = await this.inputs(projectId, opts.branchKey);
    const impact = await analyzeArchitectureImpact({ project, doc, detection, rootPath: project.root_path, store: this.store });
    const latest = this.store.getArchitectureDocById(doc.id) ?? doc;
    if (latest.baseline?.snapshot_id !== doc.baseline?.snapshot_id) throw Error('检查期间架构基线已更新，请重新检查变更');
    latest.pending_changes_summary = { ...detection.detection_summary, checked_at: now(),
      has_changes: detection.has_changes, impact_preview: impact.impact_summary,
      checked_read_snapshot_id: sameReadState(latest.last_update?.read_baseline, detection) ? latest.last_update!.read_baseline.snapshot_id : undefined };
    if (!['needs_review', 'partial', 'update_failed'].includes(latest.update_status)) {
      latest.update_status = architectureUpdateStatus(latest);
    }
    return { document: this.persistCheckState(latest), detection, impact };
  }

  async update(projectId: string, opts: ArchitectureUpdateOptions = {}) {
    const started_at = now();
    const { project, doc, detection } = await this.inputs(projectId, opts.branchKey);
    if (this.running.has(doc.id)) throw Error('该分支已有架构更新正在执行');
    if (opts.moduleIds?.some(moduleId => !doc.modules.some(mod => mod.id === moduleId))) throw Error('指定的架构模块不存在');
    this.running.add(doc.id);
    try { return await this.run(project, doc, detection, opts, started_at); }
    finally { this.running.delete(doc.id); }
  }

  private async run(project: Project, doc: ArchitectureDocument, detection: ArchitectureDetection,
    opts: ArchitectureUpdateOptions, started_at: string) {
    const { project_id: projectId, root_path: rootPath } = project;
    const store = this.store, previous = doc.last_update;
    if (!detection.detection_summary.detection_reliable) {
      const latest = store.getArchitectureDocById(doc.id) ?? doc;
      latest.pending_changes_summary = { ...detection.detection_summary, checked_at: now(), has_changes: true };
      latest.update_status = architectureUpdateStatus(latest);
      this.persistCheckState(latest);
      throw Error('无法可靠检测工作区变更：' + detection.detection_summary.detection_error);
    }
    const snapshot = await captureArchitectureSnapshot(project, store, detection);
    const manifest = frozenManifest(snapshot);
    const git = await detectWorkspaceGitState(rootPath);
    if (!isDeepStrictEqual(git, detection.live_git) || manifest.workspace_fingerprint !== detection.live_workspace_fingerprint) {
      throw Error('冻结读取快照期间工作区已变化，请重新检查更新');
    }
    const read_baseline: CodeBaseline = { ...manifest, snapshot_id: snapshot.source_snapshot_id,
      fingerprint: snapshot.fingerprint, captured_at: snapshot.captured_at, commit: git.commit, branch: git.branch, dirty: git.dirty };
    const impact = await analyzeArchitectureImpact({ doc, project, detection, rootPath, store, newSnapshot: snapshot });
    const summary = impact.impact_summary;
    const run: UpdateRunRecord = { id: id('update'), started_at, read_baseline, base_doc_version: doc.version,
      detection_summary: detection.detection_summary, impact_summary: summary, post_check_consistent: true,
      model_calls: 0, auto_updates: [], review_item_ids: [], module_outcomes: {}, overall_status: 'updating' };
    const outcomes: Record<string, Outcome> = {};
    const results: Array<{ unit: SemanticUnit; proposals: SemanticProposal[] }> = [];
    const notices: ReviewItem[] = [];
    const units = semanticUnits(doc, impact, detection, store, project);
    const sameSnapshot = sameReadState(previous?.read_baseline, detection);
    const remaining: string[] = [];
    let index: Awaited<ReturnType<typeof getCodeIndex>> | undefined;
    for (const unit of units) {
      const key = unitKey(unit);
      const prior = previous?.unit_outcomes?.[key] ?? (unit.kind === 'module' ? previous?.module_outcomes[unit.id] : undefined);
      const failed = prior?.status === 'failed' || unit.kind === 'module' && doc.modules.find(m => m.id === unit.id)?.analysis_status === 'failed';
      const selected = opts.retryFailedOnly ? failed : !opts.moduleIds || unit.kind === 'module' && opts.moduleIds.includes(unit.id);
      const referenceOnly = summary.mode === 'reference_only' || summary.mode === 'none';
      const alreadyAnalyzed = sameSnapshot && (prior?.status === 'succeeded' || prior?.status === 'needs_review');
      if (referenceOnly || !selected || alreadyAnalyzed && !failed) {
        if (sameSnapshot && prior && prior.status !== 'reused') outcomes[key] = prior;
        else if (!referenceOnly) remaining.push(key);
        continue;
      }
      if (!unit.paths.length) {
        notices.push(reviewNotice(doc, snapshot, 'uncertain', '读取快照中没有该单元的源码，请核实是否已删除或迁移：' + unit.id,
          undefined, unit.id, unit.kind === 'unmapped' ? undefined : unit.kind));
        outcomes[key] = { status: 'needs_review' };
        continue;
      }
      try {
        index ??= await getCodeIndex(store.directory, snapshot);
        if (!this.analyzer.countsModelCalls) run.model_calls++;
        const input = { doc, snapshot, index, unit, onModelCall: this.analyzer.countsModelCalls ? () => { run.model_calls++; } : undefined };
        const proposals = await this.analyzer.analyze(input);
        validateSemanticProposals(proposals, input);
        outcomes[key] = { status: 'succeeded' };
        results.push({ unit, proposals });
      } catch (error) {
        outcomes[key] = { status: 'failed', error: String(error) };
      }
    }
    const post = await detectArchitectureChanges(rootPath, { ...doc, baseline: read_baseline });
    run.post_check_consistent = !!sameReadState(read_baseline, post) && post.live_git.branchKey === doc.branch_key;
    if (!run.post_check_consistent) run.stale_reason = staleReason;

    // No awaits between reading the latest version and its optimistic SQLite write.
    const latest = store.getArchitectureDocById(doc.id) ?? structuredClone(doc);
    function enqueue(item: ReviewItem | undefined) {
      if (!item) return;
      const existing = latest.review_items.find(old => old.dedupe_key === item.dedupe_key &&
        (old.status === 'pending' || old.status === 'deferred' || old.evidence_fingerprint === item.evidence_fingerprint));
      if (existing) return existing;
      latest.review_items.push(item);
      run.review_item_ids.push(item.id);
      return item;
    }
    const renames = uncertainRenames(doc, detection, snapshot);
    for (const move of impact.unresolvedRelocations) {
      notices.push(reviewNotice(doc, snapshot, 'uncertain', move.reason, move.path, move.target_id, move.target_kind));
    }
    for (const proposal of renames) enqueue(makeReviewItem(proposal, doc, latest, snapshot));
    for (const move of detection.rename_details) {
      if (move.rename_confidence === 'uncertain' && !renames.some(p => p.evidence[0].path === move.path))
        notices.push(reviewNotice(doc, snapshot, 'rename_uncertain', `需核实文件移动及模块归属：${move.old_path} → ${move.path}`, move.path));
    }
    for (const notice of notices) enqueue(notice);
    for (const { unit, proposals } of results) {
      for (const proposal of proposals) {
        const item = enqueue(makeReviewItem(proposal, doc, latest, snapshot, unit.explanation));
        if (item?.status === 'pending' || item?.status === 'deferred') outcomes[unitKey(unit)] = { status: 'needs_review' };
      }
    }
    applyRelocations(latest, impact, run);
    for (const mod of latest.modules) {
      const outcome = outcomes[JSON.stringify(['module', mod.id])];
      run.module_outcomes[mod.id] = outcome ?? { status: 'reused' };
      if (!outcome) {
        if (!sameSnapshot && (summary.mode === 'none' || summary.mode === 'reference_only') && mod.analysis_status === 'failed') {
          mod.analysis_status = 'current';
          delete mod.analysis_error;
        }
        continue;
      }
      mod.analysis_status = outcome.status === 'failed' ? 'failed' : outcome.status === 'needs_review' ? 'needs_review' : 'updated';
      if (outcome.error) mod.analysis_error = outcome.error;
      else delete mod.analysis_error;
    }
    run.unit_outcomes = outcomes;
    run.remaining_units = remaining;
    run.finished_at = now();
    latest.last_update = run;
    latest.pending_changes_summary = { ...post.detection_summary, checked_at: run.finished_at, impact_preview: summary,
      has_changes: !run.post_check_consistent || remaining.length > 0 || Object.values(outcomes).some(o => o.status === 'failed') };
    run.overall_status = latest.update_status = architectureUpdateStatus(latest);
    const complete = !['partial', 'update_failed'].includes(run.overall_status) && !remaining.length;
    if (complete && (run.overall_status === 'up_to_date' || !run.post_check_consistent ||
      summary.mode === 'reference_only' || summary.mode === 'none')) latest.baseline = read_baseline;
    const document = this.save(projectId, latest, latest.version);
    return { document, update_run: document.last_update!, versions: store.listArchitectureDocVersions(doc.id) };
  }
}
