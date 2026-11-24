import type { AnalysisResult, NodeKind, EdgeKind, NodeIO, TransferSpec, SourceEvidence } from '../contracts/agent-adapter.js';
import type { Explanation, Snapshot } from './shared.js';

export type ContentOrigin = 'code_analysis' | 'manual' | 'manual_override' | 'needs_verification';
export type ImplementationStatus = 'implemented' | 'planned' | 'needs_verification';
export type LayerKind = 'entry' | 'core' | 'foundation';
export type ArchitectureUpdateStatus = 'up_to_date' | 'changes_pending' | 'updating' | 'needs_review' | 'update_failed' | 'partial';

export interface CodeBinding {
  id: string;
  kind: 'directory' | 'file' | 'symbol';
  path: string;
  symbol_name?: string;
  symbol_id?: string;
  start_line?: number;
  end_line?: number;
  file_sha256?: string;
  source_snapshot_id?: string;
  origin: ContentOrigin;
}

export interface ArchitectureModule {
  id: string;
  name: string;
  kind: NodeKind;
  layer: LayerKind;
  parent_id?: string;
  summary: string;
  notes?: string;
  io?: { inputs: NodeIO[]; outputs: NodeIO[] };
  code_links: CodeBinding[];
  evidence: SourceEvidence[];
  origin: ContentOrigin;
  implementation_status: ImplementationStatus;
  hidden?: boolean;
  analysis_status?: 'current' | 'updated' | 'needs_review' | 'failed';
  analysis_error?: string;
  updated_at: string;
}

export interface ArchitectureRelation {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
  notes?: string;
  transfers?: TransferSpec[];
  evidence: SourceEvidence[];
  origin: ContentOrigin;
  status: 'confirmed' | 'inferred' | 'needs_verification' | 'manual';
  hidden?: boolean;
  updated_at: string;
}

export interface ManualExclusion {
  id: string;
  target_kind: 'module' | 'relation';
  signature: string;
  label: string;
  reason?: string;
  evidence_fingerprint: string;
  evidence_paths: string[];
  excluded_at: string;
  excluded_version: number;
}

export interface ArchitectureLayout {
  positions: Record<string, { x: number; y: number }>;
  manual_positions: string[];
  auto_layout_version?: number;
  updated_at?: string;
}

export interface CodeBaseline {
  snapshot_id: string;
  fingerprint: string;
  branch?: string;
  commit?: string;
  dirty: boolean;
  workspace_fingerprint: string;
  file_hashes: Record<string, string>;
  captured_at: string;
}

export interface ReviewItem {
  id: string;
  dedupe_key: string;
  category: 'module_add' | 'module_remove' | 'module_update' | 'hierarchy_change' | 'relation_add'
    | 'relation_remove' | 'relation_update' | 'exclusion_conflict' | 'manual_conflict'
    | 'rename_uncertain' | 'dataflow_change' | 'uncertain';
  operation?: ReviewItem['category'];
  analysis_run_id?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'deferred';
  target_id?: string;
  target_kind?: 'module' | 'relation' | 'feature';
  title: string;
  scope_summary: string;
  before?: unknown;
  proposed?: unknown;
  evidence: SourceEvidence[];
  evidence_fingerprint: string;
  code_baseline_fingerprint: string;
  branch?: string;
  decision_note?: string;
  decided_at?: string;
  created_at: string;
}

export interface AutoUpdateSummary {
  id: string;
  kind: 'code_link_relocated' | 'file_moved' | 'evidence_refreshed' | 'dataflow_refreshed';
  target_id: string;
  target_name: string;
  description: string;
  old_path?: string;
  new_path?: string;
  at: string;
}

export interface UpdateRunRecord {
  id: string;
  started_at: string;
  finished_at?: string;
  base_doc_version: number;
  read_baseline: CodeBaseline;
  post_check_consistent: boolean;
  stale_reason?: string;
  detection_summary: {
    git_branch?: string;
    git_commit?: string;
    base_branch?: string;
    base_commit?: string;
    changed_files: Array<{
      path: string;
      status: 'added' | 'modified' | 'deleted' | 'renamed';
      old_path?: string;
      rename_confidence?: 'exact' | 'uncertain';
      source: 'committed' | 'staged' | 'unstaged' | 'untracked' | 'snapshot_diff';
      category: 'code' | 'config_or_contract' | 'rule';
    }>;
    detection_reliable: boolean;
    detection_error?: string;
  };
  impact_summary: {
    mode: 'none' | 'reference_only' | 'local_module' | 'dataflow_only' | 'cross_module' | 'wide_recheck';
    reason: string;
    affected_module_ids: string[];
    affected_feature_ids: string[];
    reused_module_ids: string[];
    unmapped_files: string[];
  };
  model_calls: number;
  auto_updates: AutoUpdateSummary[];
  review_item_ids: string[];
  module_outcomes: Record<string, { status: 'succeeded' | 'failed' | 'needs_review' | 'reused'; error?: string }>;
  unit_outcomes?: UpdateRunRecord['module_outcomes'];
  remaining_units?: string[];
  overall_status: ArchitectureUpdateStatus;
}

export interface ArchitectureDocument {
  id: string;
  project_id: string;
  branch_key: string;
  version: number;
  source_explanation_id?: string;
  title: string;
  summary: string;
  modules: ArchitectureModule[];
  relations: ArchitectureRelation[];
  layout: ArchitectureLayout;
  exclusions: ManualExclusion[];
  review_items: ReviewItem[];
  baseline?: CodeBaseline;
  last_confirmed_version?: number;
  update_status: ArchitectureUpdateStatus;
  last_update?: UpdateRunRecord;
  pending_changes_summary?: UpdateRunRecord['detection_summary'] & {
    checked_at: string; has_changes: boolean; checked_read_snapshot_id?: string; impact_preview?: UpdateRunRecord['impact_summary'];
  };
  created_at: string;
  updated_at: string;
}

export interface ArchitectureVersionSummary {
  version: number;
  updated_at: string;
  update_status: ArchitectureUpdateStatus;
  title: string;
  module_count: number;
  relation_count: number;
}

export function architectureUpdateStatus(doc: ArchitectureDocument): ArchitectureUpdateStatus {
  const run = doc.last_update;
  const review = doc.review_items.some(item => item.status === 'pending' || item.status === 'deferred');
  const outcomes = Object.values(run?.unit_outcomes ?? run?.module_outcomes ?? {});
  if (doc.modules.some(mod => mod.analysis_status === 'failed') || outcomes.some(unit => unit.status === 'failed')) {
    return review || outcomes.some(unit => unit.status === 'succeeded' || unit.status === 'needs_review') ? 'partial' : 'update_failed';
  }
  if (review) return 'needs_review';
  const pending = doc.pending_changes_summary;
  if (run?.post_check_consistent === false || run?.remaining_units?.length ||
      pending?.has_changes && (!run || pending.checked_read_snapshot_id !== run.read_baseline.snapshot_id)) return 'changes_pending';
  return 'up_to_date';
}

export interface ModuleReferencePaths { files: string[]; directories: string[] }
export function moduleReferencePaths(mod: ArchitectureModule): ModuleReferencePaths {
  return {
    files: mod.evidence.map(ev => ev.path).concat(mod.code_links.filter(link => link.kind !== 'directory').map(link => link.path)),
    directories: mod.code_links.filter(link => link.kind === 'directory').map(link => link.path),
  };
}

export interface ModuleDeleteImpact {
  module_id: string;
  module_name: string;
  child_modules: Array<{ id: string; name: string }>;
  descendant_count: number;
  incident_relations: Array<{ id: string; from: string; to: string; label: string }>;
  referenced_features: Array<{ id: string; title: string }>;
}

export function normalizeBranchKey(branch?: string): string {
  return branch?.trim() || 'default';
}

export function architectureDocId(projectId: string, branchKey?: string): string {
  return 'architecture:' + encodeURIComponent(projectId) + ':' + encodeURIComponent(normalizeBranchKey(branchKey));
}

export function wouldCreateHierarchyCycle(modules: ArchitectureModule[], moduleId: string, nextParentId?: string): boolean {
  const parents = new Map(modules.map(m => [m.id, m.parent_id]));
  const seen = new Set([moduleId]);
  for (let parent = nextParentId; parent !== undefined; parent = parents.get(parent)) {
    if (seen.has(parent)) return true;
    seen.add(parent);
  }
  return false;
}

export function buildRelationExclusionSignature(fromId: string, toId: string, kind: string): string {
  return JSON.stringify(['relation', fromId, toId, kind]);
}

export function buildModuleExclusionSignature(moduleIdOrPath: string): string {
  return JSON.stringify(['module', moduleIdOrPath]);
}

export function canonicalEvidenceKey(evidence: SourceEvidence[], extra = ''): string {
  const anchors = evidence.map(e => JSON.stringify([e.path, e.content_sha256, e.symbol_id ?? null, e.line_start, e.line_end]));
  return JSON.stringify([extra, anchors.sort()]);
}

/** Resolve the forest once; previously resolved parent chains can be reused. */
function hierarchyRoots(parents: Map<string, string | undefined>) {
  const roots = new Map<string, string>();
  for (const id of parents.keys()) {
    const chain = new Set<string>();
    let current = id;
    while (!roots.has(current)) {
      if (chain.has(current)) throw new Error('Hierarchy cycle / 父子循环：' + current);
      chain.add(current);
      const parent = parents.get(current);
      if (parent === undefined || !parents.has(parent)) break;
      current = parent;
    }
    const root = roots.get(current) ?? current;
    for (const member of chain) roots.set(member, root);
  }
  return roots;
}

// Validate the renderer's JSON before following references or recording a new SQLite version.
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const integer = (v: unknown) => Number.isSafeInteger(v);
const boolean = (v: unknown) => typeof v === 'boolean';
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);
const arrayOf = (v: unknown, check: (value: unknown) => boolean) => Array.isArray(v) && v.every(check);
const strings = (v: unknown) => arrayOf(v, string);
const fieldsAreStrings = (v: Record<string, unknown>, ...fields: string[]) => fields.every(k => string(v[k]));
const optionalStrings = (v: Record<string, unknown>, ...fields: string[]) => fields.every(k => optional(v[k], string));
const oneOf = (v: unknown, ...values: string[]) => typeof v === 'string' && values.includes(v);
const origin = (v: unknown) => oneOf(v, 'code_analysis', 'manual', 'manual_override', 'needs_verification');
const updateStatus = (v: unknown) => oneOf(v, 'up_to_date', 'changes_pending', 'updating', 'needs_review', 'update_failed', 'partial');
const claimStatus = (v: unknown) => oneOf(v, 'source_supported', 'inferred', 'user_clue', 'unknown');

function evidenceShape(v: unknown) {
  return record(v) && fieldsAreStrings(v, 'evidence_id', 'source_snapshot_id', 'path', 'content_sha256', 'note')
    && optional(v.symbol_id, string) && integer(v.line_start) && integer(v.line_end)
    && oneOf(v.role, 'definition', 'callsite', 'read', 'write', 'declaration', 'context');
}
function bindingShape(v: unknown) {
  return record(v) && fieldsAreStrings(v, 'id', 'path') && oneOf(v.kind, 'directory', 'file', 'symbol') && origin(v.origin)
    && optionalStrings(v, 'symbol_name', 'symbol_id', 'file_sha256', 'source_snapshot_id') && optional(v.start_line, integer) && optional(v.end_line, integer);
}
function ioShape(v: unknown) {
  return record(v) && fieldsAreStrings(v, 'io_id', 'name', 'description') && oneOf(v.availability, 'specified', 'partial', 'unknown')
    && (v.data_type === null || string(v.data_type)) && (v.value_or_shape === null || string(v.value_or_shape))
    && strings(v.claim_ids) && strings(v.evidence_ids);
}
function moduleShape(v: unknown) {
  return record(v) && fieldsAreStrings(v, 'id', 'name', 'summary', 'updated_at') && optionalStrings(v, 'parent_id', 'analysis_error', 'notes')
    && oneOf(v.kind, 'stage', 'function', 'resource', 'decision', 'execution_boundary') && origin(v.origin)
    && oneOf(v.layer, 'entry', 'core', 'foundation') && oneOf(v.implementation_status, 'implemented', 'planned', 'needs_verification')
    && (v.analysis_status === undefined || oneOf(v.analysis_status, 'current', 'updated', 'needs_review', 'failed'))
    && optional(v.hidden, boolean) && arrayOf(v.code_links, bindingShape) && arrayOf(v.evidence, evidenceShape)
    && optional(v.io, io => record(io) && arrayOf(io.inputs, ioShape) && arrayOf(io.outputs, ioShape));
}
function relationShape(v: unknown) {
  return record(v) && fieldsAreStrings(v, 'id', 'from', 'to', 'label', 'updated_at') && optional(v.notes, string)
    && origin(v.origin) && oneOf(v.status, 'confirmed', 'inferred', 'needs_verification', 'manual') && optional(v.hidden, boolean)
    && oneOf(v.kind, 'sync_call', 'return', 'queue_send', 'queue_receive', 'data_publish', 'data_read', 'dependency', 'control_flow', 'execution_boundary')
    && arrayOf(v.evidence, evidenceShape) && optional(v.transfers, ts => arrayOf(ts, t => record(t)
      && fieldsAreStrings(t, 'label', 'source_output_id', 'target_input_id') && claimStatus(t.status) && strings(t.claim_ids) && strings(t.evidence_ids)));
}
function baselineShape(v: unknown) {
  return record(v) && fieldsAreStrings(v, 'snapshot_id', 'fingerprint', 'workspace_fingerprint', 'captured_at')
    && optionalStrings(v, 'branch', 'commit') && boolean(v.dirty)
    && optional(v.file_hashes, h => record(h) && Object.values(h).every(string)); // A save may omit the server's hash map.
}
function reviewShape(v: unknown) {
  return record(v) && fieldsAreStrings(v, 'id', 'dedupe_key', 'title', 'scope_summary', 'evidence_fingerprint', 'code_baseline_fingerprint', 'created_at')
    && optionalStrings(v, 'branch', 'target_id', 'decision_note', 'decided_at', 'analysis_run_id')
    && (v.operation === undefined || v.operation === v.category || oneOf(v.category, 'manual_conflict', 'exclusion_conflict') &&
      oneOf(v.operation, 'module_add','module_remove','module_update','hierarchy_change','relation_add','relation_update','relation_remove','uncertain'))
    && (v.target_kind === undefined || oneOf(v.target_kind, 'module', 'relation', 'feature'))
    && oneOf(v.category, 'module_add', 'module_remove', 'module_update', 'hierarchy_change', 'relation_add', 'relation_remove', 'relation_update',
      'exclusion_conflict', 'manual_conflict', 'rename_uncertain', 'dataflow_change', 'uncertain')
    && oneOf(v.status, 'pending', 'accepted', 'rejected', 'deferred') && arrayOf(v.evidence, evidenceShape);
}
function detectionShape(v: unknown) {
  return record(v) && boolean(v.detection_reliable) && optionalStrings(v, 'git_branch', 'git_commit', 'base_branch', 'base_commit', 'detection_error')
    && arrayOf(v.changed_files, f => record(f) && string(f.path) && optional(f.old_path, string) && oneOf(f.status, 'added', 'modified', 'deleted', 'renamed')
      && (f.rename_confidence === undefined || f.status === 'renamed' && oneOf(f.rename_confidence, 'exact', 'uncertain'))
      && oneOf(f.source, 'committed', 'staged', 'unstaged', 'untracked', 'snapshot_diff') && oneOf(f.category, 'code', 'config_or_contract', 'rule'));
}
function impactShape(v: unknown) {
  return record(v) && oneOf(v.mode, 'none', 'reference_only', 'local_module', 'dataflow_only', 'cross_module', 'wide_recheck')
    && string(v.reason) && strings(v.affected_module_ids) && strings(v.affected_feature_ids) && strings(v.reused_module_ids) && strings(v.unmapped_files);
}
function updateRunShape(v: unknown) {
  const outcomes = (value: unknown) => record(value) && Object.values(value).every(o =>
    record(o) && oneOf(o.status, 'succeeded', 'failed', 'needs_review', 'reused') && optional(o.error, string));
  return record(v) && fieldsAreStrings(v, 'id', 'started_at') && optionalStrings(v, 'finished_at', 'stale_reason')
    && integer(v.base_doc_version) && baselineShape(v.read_baseline) && boolean(v.post_check_consistent)
    && detectionShape(v.detection_summary) && impactShape(v.impact_summary) && integer(v.model_calls) && strings(v.review_item_ids)
    && updateStatus(v.overall_status) && outcomes(v.module_outcomes) && optional(v.unit_outcomes, outcomes) && optional(v.remaining_units, strings)
    && arrayOf(v.auto_updates, u => record(u) && fieldsAreStrings(u, 'id', 'target_id', 'target_name', 'description', 'at')
      && oneOf(u.kind, 'code_link_relocated', 'file_moved', 'evidence_refreshed', 'dataflow_refreshed') && optionalStrings(u, 'old_path', 'new_path'));
}

export function validateArchitectureDocument(doc: ArchitectureDocument): string[] {
  const errors: string[] = [];
  if (!record(doc) || !fieldsAreStrings(doc, 'id', 'project_id', 'branch_key', 'title', 'summary', 'created_at', 'updated_at')
    || !integer(doc.version) || !optional(doc.last_confirmed_version, integer) || !optional(doc.source_explanation_id, string)
    || !updateStatus(doc.update_status)) return ['Invalid architecture document identity, version, text or update_status'];
  function checkList(list: unknown, field: string, check: (v: unknown) => boolean) {
    if (!Array.isArray(list)) errors.push(field + ' must be an array');
    else list.forEach((item, index) => {
      if (!check(item)) errors.push('Invalid architecture ' + field + '[' + index + ']');
    });
  }
  checkList(doc.modules, 'modules (kind/layer/origin/status/links/evidence)', moduleShape);
  checkList(doc.relations, 'relations (kind/origin/status/transfers/evidence)', relationShape);
  checkList(doc.review_items, 'review_items', reviewShape);
  checkList(doc.exclusions, 'exclusions', e => record(e) && fieldsAreStrings(e, 'id', 'signature', 'label', 'excluded_at')
    && oneOf(e.target_kind, 'module', 'relation') && optionalStrings(e, 'reason', 'evidence_fingerprint') && strings(e.evidence_paths) && integer(e.excluded_version));
  const layout = doc.layout;
  if (!record(layout) || !record(layout.positions) || !Object.values(layout.positions).every(p => record(p) && Number.isFinite(p.x) && Number.isFinite(p.y))
    || !strings(layout.manual_positions) || !optional(layout.auto_layout_version, integer) || !optional(layout.updated_at, string)) errors.push('Invalid architecture layout');
  if (!optional(doc.baseline, baselineShape)) errors.push('Invalid architecture baseline');
  if (!optional(doc.last_update, updateRunShape)) errors.push('Invalid architecture last_update');
  if (!optional(doc.pending_changes_summary, s => record(s) && detectionShape(s) && string(s.checked_at) && boolean(s.has_changes) && optional(s.checked_read_snapshot_id, string)
    && optional(s.impact_preview, impactShape))) errors.push('Invalid architecture pending_changes_summary');
  if (errors.length) return errors;
  const parents = new Map<string, string | undefined>();
  for (const module of doc.modules) {
    if (!module.id.trim() || parents.has(module.id)) errors.push('Empty or duplicate module ID: ' + module.id);
    parents.set(module.id, module.parent_id);
    if (!module.name.trim()) errors.push('Empty module name: ' + module.id);
    if (module.origin === 'code_analysis' && !module.evidence.length && !module.code_links.length)
      errors.push('Unlinked module cannot claim code_analysis origin: ' + module.id);
  }
  for (const [id, parent] of parents) {
    if (parent !== undefined && !parents.has(parent)) errors.push('Unknown parent ' + parent + ' for module ' + id);
  }
  try { hierarchyRoots(parents); } catch (error) { errors.push((error as Error).message); }
  const relationIds = new Set<string>();
  for (const relation of doc.relations) {
    if (!relation.id.trim() || relationIds.has(relation.id)) errors.push('Empty or duplicate relation ID: ' + relation.id);
    relationIds.add(relation.id);
    if (!parents.has(relation.from) || !parents.has(relation.to)) errors.push('Unknown relation endpoint: ' + relation.id);
  }
  return errors;
}

/** The map and its persisted seed classify roots using the same cross-root connections. */
export function architectureTopology(nodes: AnalysisResult['nodes'], edges: AnalysisResult['edges']) {
  const rootOf = hierarchyRoots(new Map(nodes.map(n => [n.node_id, n.parent_node_id])));
  const kinds = new Map(nodes.map(n => [n.node_id, n.kind]));
  const incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>();
  function append(map: Map<string, string[]>, key: string, value: string) {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(value);
  }
  for (const edge of edges) {
    const source = rootOf.get(edge.source_node_id)!, target = rootOf.get(edge.target_node_id)!;
    if (source !== target) {
      append(incoming, target, source);
      append(outgoing, source, target);
    }
  }
  const roots = new Set(rootOf.values());
  const boundaryEntry = (id: string) => outgoing.has(id) || !incoming.has(id);
  const hasExplicitEntry = [...roots].some(id => kinds.get(id) === 'execution_boundary' && boundaryEntry(id));
  const entries = new Set([...roots].filter(id => {
    const kind = kinds.get(id);
    if (kind === 'execution_boundary') return boundaryEntry(id);
    if (hasExplicitEntry || kind !== 'stage' || incoming.has(id) || !outgoing.size) return false;
    const targets = outgoing.get(id) ?? [];
    return !(targets.some(n => kinds.get(n) === 'stage') && targets.some(n => kinds.get(n) === 'resource'));
  }));
  const layers = new Map<string, LayerKind>();
  for (const id of roots) {
    const kind = kinds.get(id);
    if (entries.has(id)) layers.set(id, 'entry');
    else if (kind === 'resource' || (kind === 'execution_boundary' && (incoming.get(id) ?? []).every(n => !entries.has(n))))
      layers.set(id, 'foundation');
    else layers.set(id, 'core');
  }
  for (const [id, root] of rootOf) layers.set(id, layers.get(root)!);
  return { rootOf, incoming, outgoing, layers };
}

export function seedArchitectureFromExplanation(params: {
  projectId: string; branchKey: string; explanation: Explanation; snapshot?: Snapshot;
  branch?: string; commit?: string; dirty?: boolean; workspaceFingerprint?: string; fileHashes?: Record<string, string>;
}): ArchitectureDocument {
  const { explanation, projectId, snapshot } = params;
  const { result } = explanation;
  const branchKey = normalizeBranchKey(params.branchKey);
  const byId = new Map(result.nodes.map(n => [n.node_id, n]));
  const byEdge = new Map(result.edges.map(e => [e.edge_id, e]));
  const nodeIds = new Set(result.architecture?.node_ids ?? []);
  const nodes = [...nodeIds].map(id => byId.get(id)!);
  const edges = (result.architecture?.edge_ids ?? []).map(id => byEdge.get(id)!);
  const { layers } = architectureTopology(nodes, edges);
  const byEvidence = new Map(result.evidence.map(e => [e.evidence_id, e]));
  const evidenceFor = (ids: readonly string[]) => ids.map(id => byEvidence.get(id)!);
  const updated_at = explanation.created_at;
  const modules = nodes.map((node): ArchitectureModule => {
    const evidence = evidenceFor(node.evidence_ids);
    return {
      id: node.node_id, name: node.label, kind: node.kind, layer: layers.get(node.node_id)!,
      parent_id: node.parent_node_id && nodeIds.has(node.parent_node_id) ? node.parent_node_id : undefined,
      summary: node.description, io: { inputs: [...node.inputs], outputs: [...node.outputs] },
      evidence, code_links: evidence.map(e => ({
        id: e.evidence_id, kind: e.symbol_id ? 'symbol' : 'file', path: e.path, symbol_id: e.symbol_id,
        start_line: e.line_start, end_line: e.line_end, file_sha256: e.content_sha256, source_snapshot_id: e.source_snapshot_id, origin: 'code_analysis',
      })),
      origin: evidence.length ? 'code_analysis' : 'needs_verification',
      implementation_status: evidence.length ? 'implemented' : 'needs_verification', updated_at,
    };
  });
  const relations = edges.map((edge): ArchitectureRelation => ({
    id: edge.edge_id, from: edge.source_node_id, to: edge.target_node_id, kind: edge.kind, label: edge.label,
    transfers: edge.transfers && [...edge.transfers], evidence: evidenceFor(edge.evidence_ids), origin: 'code_analysis',
    status: edge.status === 'source_supported' ? 'confirmed' : edge.status === 'inferred' ? 'inferred' : 'needs_verification',
    updated_at,
  }));
  // A seed is editable independently of the frozen explanation, including nested I/O and transfers.
  return structuredClone({
    id: architectureDocId(projectId, branchKey), project_id: projectId, branch_key: branchKey, version: 1,
    source_explanation_id: explanation.result_id, title: '工程架构', summary: result.summary.text, modules, relations,
    layout: { positions: {}, manual_positions: [] }, exclusions: [], review_items: [], update_status: 'up_to_date',
    baseline: snapshot && {
      snapshot_id: snapshot.source_snapshot_id, fingerprint: snapshot.fingerprint, branch: params.branch,
      commit: params.commit ?? snapshot.commit ?? undefined, dirty: params.dirty ?? !!snapshot.dirty,
      workspace_fingerprint: params.workspaceFingerprint ?? snapshot.fingerprint, captured_at: snapshot.captured_at,
      file_hashes: params.fileHashes ?? Object.fromEntries(snapshot.files.map(f => [f.path, f.content_sha256])),
    },
    created_at: updated_at, updated_at,
  });
}

type EvidenceFingerprint = (evidence: SourceEvidence[], key: string) => string;

function needsExclusion(item: ArchitectureModule | ArchitectureRelation) {
  return item.origin === 'code_analysis' || item.origin === 'manual_override' || item.evidence.length > 0;
}

function exclusion(target: ArchitectureModule | ArchitectureRelation, targetKind: ManualExclusion['target_kind'],
  signature: string, version: number, at: string, fingerprint: EvidenceFingerprint, reason?: string): ManualExclusion {
  return {
    id: JSON.stringify([targetKind, target.id, version]), target_kind: targetKind, signature,
    label: 'name' in target ? target.name : target.label, reason,
    evidence_fingerprint: fingerprint(target.evidence, signature),
    evidence_paths: [...new Set(target.evidence.map(e => e.path))].sort(),
    excluded_at: at, excluded_version: version,
  };
}

export function applyModuleDelete(doc: ArchitectureDocument, moduleId: string, strategy: 'reparent_children' | 'delete_subtree',
  exclusionFingerprint: EvidenceFingerprint = canonicalEvidenceKey) {
  const target = doc.modules.find(m => m.id === moduleId);
  if (!target) throw new Error('Unknown architecture module: ' + moduleId);
  const removed = new Set([moduleId]);
  if (strategy === 'delete_subtree') {
    const children = new Map<string, string[]>();
    for (const module of doc.modules) {
      if (!module.parent_id) continue;
      if (!children.has(module.parent_id)) children.set(module.parent_id, []);
      children.get(module.parent_id)!.push(module.id);
    }
    for (const parent of removed) for (const child of children.get(parent) ?? []) removed.add(child);
  }
  const updated_at = new Date().toISOString();
  const exclusions = [...doc.exclusions];
  const reparented_child_ids: string[] = [];
  const modules = doc.modules.flatMap(module => {
    if (removed.has(module.id)) {
      if (needsExclusion(module)) exclusions.push(exclusion(module, 'module',
        buildModuleExclusionSignature(module.id), doc.version + 1, updated_at, exclusionFingerprint));
      return [];
    }
    if (module.parent_id !== moduleId) return [module];
    reparented_child_ids.push(module.id);
    return [{ ...module, parent_id: target.parent_id, updated_at }];
  });
  const removed_relation_ids: string[] = [];
  const relations = doc.relations.filter(relation => {
    if (!removed.has(relation.from) && !removed.has(relation.to)) return true;
    if (needsExclusion(relation)) exclusions.push(exclusion(relation, 'relation',
      buildRelationExclusionSignature(relation.from, relation.to, relation.kind), doc.version + 1, updated_at, exclusionFingerprint));
    removed_relation_ids.push(relation.id);
    return false;
  });
  const positions = { ...doc.layout.positions };
  for (const id of removed) delete positions[id];
  const layout = { ...doc.layout, positions, manual_positions: doc.layout.manual_positions.filter(id => !removed.has(id)) };
  return { doc: { ...doc, modules, relations, layout, exclusions, updated_at },
    removed_module_ids: [...removed], reparented_child_ids, removed_relation_ids };
}

export function applyRelationDelete(doc: ArchitectureDocument, relationId: string,
  exclusionFingerprint: EvidenceFingerprint = canonicalEvidenceKey, reason?: string): ArchitectureDocument {
  const relation = doc.relations.find(r => r.id === relationId);
  if (!relation) throw new Error('Unknown architecture relation: ' + relationId);
  const updated_at = new Date().toISOString();
  const exclusions = [...doc.exclusions];
  if (needsExclusion(relation)) exclusions.push(exclusion(relation, 'relation',
    buildRelationExclusionSignature(relation.from, relation.to, relation.kind), doc.version + 1, updated_at, exclusionFingerprint, reason));
  return { ...doc, relations: doc.relations.filter(r => r.id !== relationId), exclusions, updated_at };
}

// Local view metadata only; frozen agent results use the original contract.
export type ArchitectureView = AnalysisResult & { module_layers?: Readonly<Record<string, LayerKind>> };

export function architectureDocumentToAnalysisResult(doc: ArchitectureDocument, baseResult?: AnalysisResult,
  options: { includeHidden?: boolean } = {}): ArchitectureView {
  const modules = doc.modules.filter(m => options.includeHidden || !m.hidden);
  const moduleIds = new Set(modules.map(m => m.id));
  const relations = doc.relations.filter(r => (options.includeHidden || !r.hidden) && moduleIds.has(r.from) && moduleIds.has(r.to));
  const baseNodes = new Map(baseResult?.nodes.map(n => [n.node_id, n]));
  const baseEdges = new Map(baseResult?.edges.map(e => [e.edge_id, e]));
  const originalModules = new Set(baseResult?.architecture?.node_ids);
  const originalRelations = new Set(baseResult?.architecture?.edge_ids);
  const allMaintainedIds = new Set(doc.modules.map(m => m.id));
  const allRelations = new Set(doc.relations.map(r => r.id));
  const otherNodes = (baseResult?.nodes ?? []).filter(n => !originalModules.has(n.node_id) && !allMaintainedIds.has(n.node_id));
  const visibleIds = new Set([...moduleIds, ...otherNodes.map(n => n.node_id)]);
  const otherEdges = (baseResult?.edges ?? []).filter(e => !originalRelations.has(e.edge_id) && !allRelations.has(e.edge_id)
    && visibleIds.has(e.source_node_id) && visibleIds.has(e.target_node_id));

  // A legacy assertion describes its original targets. Do not rebind it to manual text or a changed connection.
  const sourceNodes = new Set(otherNodes.map(n => n.node_id)), sourceEdges = new Set(otherEdges.map(e => e.edge_id));
  for (const m of modules) {
    const old = baseNodes.get(m.id);
    if (m.origin === 'code_analysis' && m.implementation_status === 'implemented' && old?.kind === m.kind
      && old.label === m.name && old.description === m.summary) sourceNodes.add(m.id);
  }
  for (const r of relations) {
    const old = baseEdges.get(r.id);
    if (r.origin === 'code_analysis' && old?.kind === r.kind && old.label === r.label
      && old.source_node_id === r.from && old.target_node_id === r.to) sourceEdges.add(r.id);
  }
  const sourceIo = new Set(otherNodes.flatMap(n => [...n.inputs, ...n.outputs]).map(io => io.io_id));
  for (const m of modules) if (sourceNodes.has(m.id))
    for (const io of [...m.io?.inputs ?? [], ...m.io?.outputs ?? []]) sourceIo.add(io.io_id);
  const claims = (baseResult?.claims ?? []).filter(c => c.targets.node_ids.every(id => sourceNodes.has(id))
    && c.targets.edge_ids.every(id => sourceEdges.has(id)) && c.targets.io_ids.every(id => sourceIo.has(id)));
  const claimIds = new Set(claims.map(c => c.claim_id));
  const kept = (ids: readonly string[]) => ids.filter(id => claimIds.has(id));
  const projectIo = (io: NodeIO) => ({ ...io, claim_ids: kept(io.claim_ids) });
  const nodes = modules.map((m): AnalysisResult['nodes'][number] => {
    const original = sourceNodes.has(m.id) ? baseNodes.get(m.id) : undefined;
    return {
      ...original, node_id: m.id, kind: m.kind, label: m.name, description: m.summary,
      parent_node_id: m.parent_id && moduleIds.has(m.parent_id) ? m.parent_id : undefined,
      execution_context: original?.execution_context ?? {
        kind: 'unknown', identity: null, label: '未指定执行上下文', status: 'unknown', claim_ids: [], evidence_ids: [],
      },
      inputs: (m.io?.inputs ?? []).map(projectIo), outputs: (m.io?.outputs ?? []).map(projectIo),
      claim_ids: kept(original?.claim_ids ?? []), evidence_ids: m.evidence.map(e => e.evidence_id),
    };
  });
  const edges = relations.map((r): AnalysisResult['edges'][number] => {
    const original = sourceEdges.has(r.id) ? baseEdges.get(r.id) : undefined;
    const statuses = { confirmed: 'source_supported', inferred: 'inferred', manual: 'user_clue', needs_verification: 'unknown' } as const;
    const manual = r.origin === 'manual' || r.origin === 'manual_override';
    const status = manual ? 'user_clue' : r.origin === 'needs_verification' || (!original && baseEdges.has(r.id)) ? 'unknown' : statuses[r.status];
    return {
      ...original, edge_id: r.id, source_node_id: r.from, target_node_id: r.to, kind: r.kind, label: r.label,
      status, claim_ids: kept(original?.claim_ids ?? []), evidence_ids: r.evidence.map(e => e.evidence_id),
      transfers: r.transfers?.map(t => ({ ...t, status: manual ? 'user_clue' : t.status, claim_ids: manual ? [] : kept(t.claim_ids) })),
    };
  });
  const evidence = new Map(baseResult?.evidence.map(e => [e.evidence_id, e]));
  for (const item of [...modules, ...relations]) for (const e of item.evidence) evidence.set(e.evidence_id, e);
  const localId = doc.id;
  return {
    ...baseResult, schema_version: '1.0', fictional: baseResult?.fictional ?? false,
    result_id: baseResult?.result_id ?? localId,
    binding: baseResult?.binding ?? {
      project_id: doc.project_id, source_snapshot_id: doc.baseline?.snapshot_id ?? '',
      feature_id: localId, scenario_id: localId, question_revision_id: localId, run_id: localId,
    },
    // A standalone document has no agent run. Identify the local presentation adapter explicitly.
    provider: baseResult?.provider ?? { provider_id: 'demo', connection_id: 'architecture-workspace', adapter_version: '1' },
    summary: { text: doc.summary, claim_ids: baseResult?.summary.text === doc.summary ? kept(baseResult.summary.claim_ids) : [] },
    coverage: baseResult?.coverage ?? { covered_scope: [], unresolved_scope: [] },
    nodes: [...nodes, ...otherNodes.map(n => ({ ...n, parent_node_id: n.parent_node_id && visibleIds.has(n.parent_node_id) ? n.parent_node_id : undefined,
      claim_ids: kept(n.claim_ids), inputs: n.inputs.map(projectIo), outputs: n.outputs.map(projectIo) }))]
      .map(n => ({ ...n, execution_context: { ...n.execution_context, claim_ids: kept(n.execution_context.claim_ids) } })),
    edges: [...edges, ...otherEdges.map(e => ({ ...e, claim_ids: kept(e.claim_ids),
      transfers: e.transfers?.map(t => ({ ...t, claim_ids: kept(t.claim_ids) })) }))],
    claims, gaps: (baseResult?.gaps ?? []).filter(g => g.related_node_ids.every(id => sourceNodes.has(id))
      && g.related_edge_ids?.every(id => sourceEdges.has(id)) !== false).map(g => ({ ...g, claim_ids: kept(g.claim_ids) })),
    reading_guide: baseResult?.reading_guide?.steps.every(s => s.node_ids.every(id => sourceNodes.has(id))) ? baseResult.reading_guide : undefined,
    function_walkthroughs: baseResult?.function_walkthroughs?.filter(w => sourceNodes.has(w.entry_node_id)
      && w.steps.every(s => (!s.from_node_id || sourceNodes.has(s.from_node_id)) && sourceNodes.has(s.to_node_id))),
    evidence: [...evidence.values()], module_layers: Object.fromEntries(modules.map(m => [m.id, m.layer])),
    architecture: { node_ids: [...moduleIds], edge_ids: relations.map(r => r.id) },
  };
}
