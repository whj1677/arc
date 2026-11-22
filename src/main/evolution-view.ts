import { auditVerification, sameVerificationState } from '../delivery-audit';
import { computeAstCallGraphDiff, type HudConstraintRef, type TaskHudSnapshot,
  type TaskHudStructureDiff, type WalkthroughDiffNode } from '../development-hud';
import type { EngineeringTask } from '../engineering';
import type {
  EvolutionArchEdge, EvolutionAssumption, EvolutionChangedFile, EvolutionSideEffect,
  EvolutionVerificationBadge, EvolutionView,
} from '../evolution-view';
import type { LiveWorkspaceRadar } from '../live-radar';
import type { AnalysisResult, Explanation } from '../shared';
import { supportsSourceFile } from './code-index';
import { projectEvolutionArchitecture } from './evolution-architecture';
import { buildEvolutionFlows, type EvolutionFlowIndexes } from './evolution-flows';

interface ProjectionContext extends EvolutionFlowIndexes {
  changedSymbols?: readonly WalkthroughDiffNode[];
  overview?: AnalysisResult;
  explanations?: ReadonlyMap<string, Explanation>;
  walkthroughIndexes?: ReadonlyMap<string, EvolutionFlowIndexes>;
}

export function taskEvolutionScope(task: EngineeringTask) {
  return (task.approval?.scope ?? (task.proposed_scope?.length ? task.proposed_scope : task.scope))
    .map(file => file.replaceAll('\\', '/'));
}

export function taskEvolutionMode(task: EngineeringTask) {
  return task.changes_status === 'needs_review' || !task.end_state ||
    (!task.changes.length && (task.workflow === 'analysis' || task.workflow === 'ready'))
    ? 'task_blueprint' : 'task_actual';
}

function taskAssumptions(task: EngineeringTask) {
  const items: EvolutionAssumption[] = [];
  function add(item: Omit<EvolutionAssumption, 'id'>) {
    if (!items.some(prior => prior.source === item.source && prior.text === item.text &&
        prior.file === item.file && prior.fix === item.fix)) items.push({id: 'assumption-' + items.length, ...item});
  }
  for (const text of task.requirement_package?.assumptions ?? []) add({source: 'requirement_package', text});
  for (const {file, issue, fix} of task.diff_review?.blocking_issues ?? []) add({source: 'review_blocker', file, text: issue, fix});
  for (const text of task.unresolved) {
    const blocker = /^([^：\n]+)：(.+?)；修复要求：(.+)$/.exec(text);
    if (blocker) add({source: 'review_blocker', file: blocker[1], text: blocker[2], fix: blocker[3]});
    else add({source: 'unresolved', text});
  }
  return items;
}

function verificationBadge(task: EngineeringTask): EvolutionVerificationBadge {
  if (task.verification_status === 'failed') return {tone: 'danger', label: '验证失败', detail: ''};
  const audit = auditVerification(task);
  const state = task.end_state ?? task.baseline;
  const current = task.verification.filter(item => sameVerificationState(item.code_state, state) || item.code_state.snapshot_id === state.snapshot_id);
  const pending = current.find(item => /待执行|未执行|待核/.test(item.note ?? ''));
  if (pending && (task.verification_status === 'passed' || task.verification_status === 'partial') &&
      (audit.status === 'partial' || audit.status === 'passed' || audit.status === 'self_reported') &&
      current.some(item => item.outcome === 'passed')) {
    return {tone: 'warn', label: '部分已验 · 含待执行项', detail: audit.label + '。' + pending.note};
  }
  const tone = audit.status === 'passed' ? 'ok' : audit.status === 'failed' ? 'danger'
    : audit.status === 'not_run' ? 'muted' : 'warn';
  return {tone, label: audit.label, detail: ''};
}

function sideEffects(structure: TaskHudStructureDiff | undefined, newEdges: EvolutionArchEdge[],
    assumptions: EvolutionAssumption[], constraints: HudConstraintRef[]) {
  const effects: EvolutionSideEffect[] = [];
  function add(effect: Omit<EvolutionSideEffect, 'id'>) { effects.push({id: 'effect-' + effects.length, ...effect}); }
  if (structure) {
    for (const symbol of [...structure.signature_changed_symbols, ...structure.removed_symbols]) {
      for (const site of symbol.unupdated_external_callers ?? []) {
        if (site.ambiguous) continue;
        add({category: 'contract_break', evidence_kind: 'ast_proved', severity: 'warn',
          title: '外部调用方未同步修改', detail: site.caller_symbol + ' → ' + site.target_symbol,
          file: site.caller_file, line: site.caller_line, target_file: site.target_file, target_line: site.target_line});
      }
    }
    for (const cycle of structure.new_cycles) add({category: 'new_cycle', evidence_kind: 'ast_proved',
      severity: 'warn', title: '新增目录调用环', detail: cycle.join(' → ')});
    for (const state of structure.shared_state_changes) add({category: 'shared_state', evidence_kind: 'ast_proved',
      severity: 'info', title: '共享状态访问变化 · ' + state.name, file: state.file,
      detail: [...state.added_dirs.map(dir => '+ ' + dir), ...state.removed_dirs.map(dir => '− ' + dir)].join('，')});
  }
  for (const edge of newEdges) {
    const call = edge.sample_call;
    if (call) add({category: 'new_cross_layer_edge', evidence_kind: 'ast_proved', severity: 'info',
      title: '新增跨层调用 · ' + edge.from_label + ' → ' + edge.to_label,
      detail: call.caller_symbol + ' → ' + call.callee_symbol, file: call.file, line: call.line,
      module_ids: [edge.from_id, edge.to_id]});
  }
  for (const item of assumptions.filter(a => a.source === 'review_blocker')) add({category: 'review_blocker',
    evidence_kind: 'ai_inferred', severity: 'high', title: '审查阻断项', detail: item.text, file: item.file, fix: item.fix});
  for (const item of constraints) add({category: 'constraint', evidence_kind: 'ai_inferred',
    severity: 'info', title: item.key, detail: item.excerpt});
  return effects;
}

type ProjectionData = Pick<TaskHudSnapshot, 'structure_diff' | 'impact'> &
  Partial<Pick<TaskHudSnapshot, 'walkthrough_diffs'>>;

function project(context: ProjectionContext, data: ProjectionData, mode: EvolutionView['mode'],
    changed: EvolutionChangedFile[], files: string[], assumptions: EvolutionAssumption[], boundFeatureId?: string) {
  const blueprint = mode === 'task_blueprint';
  const structure = blueprint ? undefined : data.structure_diff;
  const {beforeIndex, afterIndex, beforeSources, afterSources} = context;
  const collected: WalkthroughDiffNode[] = [];
  if (!blueprint && !context.changedSymbols && beforeIndex && afterIndex) {
    computeAstCallGraphDiff({beforeIndex, afterIndex, beforeSources, afterSources, changedFiles: files,
      beforeSnapshotId: beforeIndex.snapshot_id, afterSnapshotId: afterIndex.snapshot_id, changedSymbols: collected});
  }
  const changedSymbols = blueprint ? [] : context.changedSymbols ?? collected;
  const {architecture, moduleByFile, newCrossLayerEdges} = projectEvolutionArchitecture({
    overview: context.overview, beforeIndex, afterIndex: blueprint ? undefined : afterIndex, files, structure, changedSymbols,
  });
  return {
    mode, architecture, assumptions,
    changed_files: changed.map(file => ({...file, module_id: moduleByFile.get(file.path)})),
    ...buildEvolutionFlows({...context, mode, changedFiles: changed.map(file => file.path), projectedFiles: files,
      boundFeatureId, impactedFeatures: data.impact.impacted_features, walkthroughDiffs: data.walkthrough_diffs,
      changedSymbols, structureDiff: structure}),
    side_effects: sideEffects(structure, newCrossLayerEdges, assumptions, data.impact.related_constraints),
  };
}

export function buildTaskEvolutionView(task: EngineeringTask, hud: TaskHudSnapshot, context: ProjectionContext): EvolutionView {
  const mode = taskEvolutionMode(task);
  const attributionPending = task.changes_status === 'needs_review';
  const scope = new Set(taskEvolutionScope(task));
  const changed: EvolutionChangedFile[] = mode === 'task_blueprint' ? [] : task.changes.map(change => ({
    path: change.path.replaceAll('\\', '/'), ownership: change.ownership, is_source: supportsSourceFile(change.path),
    status: change.before_sha256 === null ? 'added' : change.after_sha256 === null ? 'removed' : 'modified',
  }));
  const actual = new Set(changed.map(file => file.path));
  const files = mode === 'task_blueprint' ? [...scope] : [...actual];
  const behaviors = task.requirement_package?.behaviors;
  return {
    ...project(attributionPending ? {...context, afterIndex: undefined, afterSources: undefined} : context,
      attributionPending ? {impact: hud.impact} : hud, mode, changed, files, taskAssumptions(task), task.reading?.feature_id),
    base_label: '任务基线', target_label: mode === 'task_blueprint' ? '计划范围' : '任务结束快照',
    base_snapshot_id: (task.diff_baseline ?? task.baseline).snapshot_id,
    target_snapshot_id: attributionPending ? undefined : task.end_state?.snapshot_id,
    approach: behaviors?.length ? behaviors.map(b => ({id: b.id, title: b.behavior, detail: b.design, files: b.files}))
      : (task.steps ?? []).filter(s => s.status !== 'superseded').map(s => ({id: s.step_id, title: s.title, detail: s.change, files: []})),
    ...((attributionPending || (mode === 'task_actual' && (scope.size > 0 || task.approval))) && {drift: {
      planned_count: scope.size, actual_count: actual.size, matched_files: [...actual].filter(file => scope.has(file)),
      untouched_planned_files: [...scope].filter(file => !actual.has(file)), out_of_scope_files: [...actual].filter(file => !scope.has(file)),
      overlap_files: changed.filter(file => file.ownership === 'preexisting_overlap').map(file => file.path),
      attribution_pending: attributionPending,
    }}),
    verification_badge: verificationBadge(task),
  };
}

export function buildRadarEvolutionView(radar: LiveWorkspaceRadar, context: ProjectionContext): EvolutionView {
  const changed = radar.changed_files.map(({path, status}) => ({path, status, is_source: supportsSourceFile(path)}));
  return {...project(context, radar, 'workspace_radar', changed, changed.map(file => file.path), []),
    base_label: radar.base_ref, target_label: radar.target_ref, approach: []};
}
