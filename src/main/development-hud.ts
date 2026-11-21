import path from 'node:path';
import { activeContextEntries, type EngineeringTask } from '../engineering';
import {
  computeStructureDiff, computeWalkthroughDiff, type HudImpactedFeature,
  type TaskHudImpact, type TaskHudSnapshot,
} from '../development-hud';
import {
  hasFunctionGraphs, type AnalysisResult, type Explanation, type Feature,
  type Project, type Scenario, type Snapshot,
} from '../shared';
import { getCodeIndex, type CodeIndex } from './code-index';
import { readSource } from './snapshot';
import type { Store } from './store';

type RefreshState = (taskId: string, scenarioId: string) => { refreshing: boolean; error?: string } | undefined;
const testFile = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$/i;
const normalizePath = (file: string) => file.replaceAll('\\', '/');

function indexImpact(index: CodeIndex, scope: Set<string>) {
  const symbols = new Map(index.symbols.map(symbol => [symbol.id, symbol]));
  const external_callers: TaskHudImpact['external_callers'] = [];
  const callers = new Set<string>();
  const tested = new Set<string>();
  for (const call of index.calls) {
    const fromTest = testFile.test(call.file);
    for (const targetId of call.target_ids) {
      if (fromTest) tested.add(targetId);
      if (external_callers.length === 40 || scope.has(call.file)) continue;
      const target = symbols.get(targetId)!;
      if (!scope.has(target.file)) continue;
      const key = [call.caller_id, call.line, targetId].join('\0');
      if (callers.has(key)) continue;
      callers.add(key);
      external_callers.push({
        caller_symbol: symbols.get(call.caller_id)!.qualified_name,
        caller_file: call.file, caller_line: call.line,
        target_symbol: target.qualified_name, target_file: target.file, target_line: target.start_line,
      });
    }
  }
  const scopeDirs = new Set([...scope].map(file => path.posix.dirname(file)));
  const shared_states = index.shared_states.flatMap(({ name, file, line, access_dirs }) => {
    if (!scope.has(file) && !access_dirs.some(dir => scopeDirs.has(dir))) return [];
    const external_dirs = access_dirs.filter(dir => !scopeDirs.has(dir));
    return external_dirs.length ? [{ name, file, line, access_dirs, external_dirs }] : [];
  }).slice(0, 20);
  const untested_symbols = index.symbols
    .filter(s => scope.has(s.file) && s.public_entry && !testFile.test(s.file) && !tested.has(s.id))
    .slice(0, 20)
    .map(s => ({ symbol: s.qualified_name, file: s.file, line: s.start_line }));
  return { external_callers, shared_states, untested_symbols };
}

function architectureImpact(overview: AnalysisResult | undefined, scope: Set<string>) {
  const architecture_nodes: TaskHudImpact['architecture_nodes'] = [];
  const architecture_edges: TaskHudImpact['architecture_edges'] = [];
  if (overview?.architecture) {
    const nodes = new Map(overview.nodes.map(node => [node.node_id, node]));
    const paths = new Map(overview.evidence.map(e => [e.evidence_id, e.path]));
    const direct = new Set(overview.architecture.node_ids.filter(id => {
      const node = nodes.get(id)!;
      const source = node.source_scope;
      return node.evidence_ids.some(ref => scope.has(paths.get(ref)!)) ||
        (source && (scope.has(source.path) || (source.kind === 'folder' &&
          [...scope].some(file => source.path === '.' || file.startsWith(source.path + '/')))));
    }));
    const involved = new Set(direct);
    const edgeIds = new Set(overview.architecture.edge_ids);
    for (const edge of overview.edges) {
      const { edge_id, source_node_id: from, target_node_id: to, label } = edge;
      if (!edgeIds.has(edge_id) || (!direct.has(from) && !direct.has(to))) continue;
      involved.add(from);
      involved.add(to);
      architecture_edges.push({
        edge_id, from_node_id: from, to_node_id: to,
        from_label: nodes.get(from)!.label, to_label: nodes.get(to)!.label, label,
      });
    }
    for (const id of involved) {
      const { node_id, label, kind } = nodes.get(id)!;
      architecture_nodes.push({ node_id, label, kind, relation: direct.has(id) ? 'direct' : 'neighbor' });
    }
  }
  return { architecture_nodes, architecture_edges, architecture_result_id: overview?.result_id };
}

function projectHistory(store: Store, projectId: string, scenarioId?: string): Explanation[] {
  return store.db.prepare(`SELECT json FROM objects WHERE kind='explanation'
    AND json_extract(json,'$.result.binding.project_id')=?
    AND json_extract(json,'$.result.fictional') IS NOT 1
    AND (? IS NULL OR json_extract(json,'$.scenario_id')=?)
    ORDER BY json_extract(json,'$.created_at') DESC, rowid DESC`)
    .all(projectId, scenarioId ?? null, scenarioId ?? null).map(row => JSON.parse(String(row.json)));
}

function selectPrevious(history: Explanation[], task: EngineeringTask, scenarioId: string) {
  const beforeId = (task.diff_baseline ?? task.baseline).snapshot_id;
  const bound = scenarioId === task.reading?.scenario_id ? task.walkthrough : undefined;
  const end = task.end_state;
  const beforeMatches = history.filter(e => e.result.binding.source_snapshot_id === beforeId);
  const eligible = history.filter(e => !end || e.result.binding.source_snapshot_id === beforeId ||
    (e.result.binding.source_snapshot_id !== end.snapshot_id && e.created_at <= end.captured_at));
  return history.find(e => e.result_id === bound?.previous_result_id) ??
    beforeMatches.find(e => hasFunctionGraphs(e.result)) ??
    eligible.find(e => hasFunctionGraphs(e.result)) ??
    beforeMatches[0] ?? eligible[0];
}

export function previousFeatureResultId(store: Store, task: EngineeringTask, scenarioId: string) {
  return selectPrevious(projectHistory(store, task.project_id, scenarioId), task, scenarioId)?.result_id;
}

function impactedFeatures(
  store: Store, project: Project, task: EngineeringTask, files: Set<string>,
  snapshot: (id: string) => Snapshot, refreshState?: RefreshState,
) {
  const features = store.all<Feature>('feature').filter(f => f.project_id === project.project_id && !f.archived);
  const scenes = store.all<Scenario>('scenario').filter(s => s.project_id === project.project_id && !s.archived);
  const explanations = projectHistory(store, project.project_id);
  const refreshRunIds = new Set(store.db.prepare(`SELECT json_extract(json,'$.binding.run_id') AS run_id
    FROM objects WHERE kind='run' AND json_extract(json,'$.feature_refresh_task_id')=?`)
    .all(task.task_id).map(row => String(row.run_id)));
  const byId = new Map(explanations.map(e => [e.result_id, e]));
  const histories = new Map<string, Explanation[]>();
  const matching = new Set<string>();
  for (const e of explanations) {
    const history = histories.get(e.scenario_id);
    if (history) history.push(e);
    else histories.set(e.scenario_id, [e]);
    if (e.result.evidence.some(ref => files.has(ref.path))) matching.add(e.scenario_id);
  }
  const impacted: HudImpactedFeature[] = [];
  for (const feature of features) {
    const bound = feature.feature_id === task.reading?.feature_id ? task.reading : undefined;
    const candidates = scenes.filter(s => s.feature_id === feature.feature_id &&
      (s.scenario_id !== project.overview_scenario_id || s.scenario_id === bound?.scenario_id));
    // A feature may only have catalog evidence until its first walkthrough is saved.
    const discovery = feature.discovery && byId.get(feature.discovery.result_id)?.result;
    const node = discovery?.nodes.find(n => n.node_id === feature.discovery!.node_id);
    const catalogMatch = node && discovery!.evidence.some(ref => node.evidence_ids.includes(ref.evidence_id) && files.has(ref.path));
    const matched = candidates.filter(s => matching.has(s.scenario_id) || catalogMatch);
    const scene = candidates.find(s => s.scenario_id === bound?.scenario_id) ??
      matched.find(s => s.kind === 'feature_overview') ?? matched[0];
    if (!scene) continue;
    const history = histories.get(scene.scenario_id) ?? [];
    const update = bound?.scenario_id === scene.scenario_id ? task.walkthrough : undefined;
    const previous = selectPrevious(history, task, scene.scenario_id);
    const end = task.end_state;
    const others = history.filter(e => e !== previous);
    let refreshed = others.find(e => e.result_id === update?.result_id) ??
      others.find(e => e.result.binding.run_id && refreshRunIds.has(e.result.binding.run_id));
    if (end && !refreshed) {
      const beforeFingerprint = snapshot((task.diff_baseline ?? task.baseline).snapshot_id).fingerprint;
      const previousIndex = previous ? history.indexOf(previous) : history.length;
      refreshed = others.find(e => hasFunctionGraphs(e.result) &&
        snapshot(e.result.binding.source_snapshot_id).fingerprint === end.fingerprint &&
        (beforeFingerprint !== end.fingerprint || history.indexOf(e) < previousIndex));
    }
    const state = refreshState?.(task.task_id, scene.scenario_id) ?? {
      refreshing: update?.status === 'running' || update?.status === 'pending', error: update?.error,
    };
    impacted.push({
      feature_id: feature.feature_id, scenario_id: scene.scenario_id, label: feature.name,
      previous_result_id: previous?.result_id, refreshed_result_id: refreshed?.result_id,
      has_call_graph: !!previous && hasFunctionGraphs(previous.result), ...state,
    });
  }
  return { impacted, byId };
}

export async function buildTaskHud(
  store: Store, directory: string, taskId: string, featureRefreshState?: RefreshState,
): Promise<TaskHudSnapshot> {
  const task = store.get<EngineeringTask>('engineering_task', taskId);
  const project = store.get<Project>('project', task.project_id);
  const changedFiles = task.changes.map(c => normalizePath(c.path));
  const declaredScope = task.approval?.scope ?? (task.proposed_scope?.length ? task.proposed_scope : task.scope);
  const scopeDeclared = declaredScope.length > 0;
  const impactScope = new Set((scopeDeclared ? declaredScope : changedFiles).map(normalizePath));
  const beforeId = (task.diff_baseline ?? task.baseline).snapshot_id;
  // Historical walkthroughs can bind different snapshots than either task endpoint.
  const snapshots = new Map<string, Snapshot>();
  function snapshot(id: string) {
    if (!snapshots.has(id)) snapshots.set(id, store.get<Snapshot>('snapshot', id));
    return snapshots.get(id)!;
  }
  const indexes = new Map<string, Promise<CodeIndex>>();
  function index(id: string) {
    if (!indexes.has(id)) indexes.set(id, getCodeIndex(directory, snapshot(id)));
    return indexes.get(id)!;
  }
  const beforeIndex = await index(beforeId);
  const { impacted, byId } = impactedFeatures(store, project, task, new Set([...impactScope, ...changedFiles]), snapshot, featureRefreshState);
  const impact: TaskHudImpact = {
    scope_files: [...impactScope], scope_declared: scopeDeclared, ...indexImpact(beforeIndex, impactScope),
    ...architectureImpact(store.latestOverview(project)?.result, impactScope),
    related_constraints: activeContextEntries(store.projectContextEntries(project.project_id))
      .filter(e => ['rule', 'decision', 'issue'].includes(e.category) && e.sources.some(s => impactScope.has(s.path)))
      .slice(0, 12).map(e => ({ entry_id: e.entry_id, category: e.category, key: e.key, excerpt: e.text.slice(0, 180) })),
    impacted_features: impacted,
  };
  const hud: TaskHudSnapshot = {
    task_id: taskId, version: task.version, impact, walkthrough_diffs: [], impacted_features: impacted,
  };
  if (task.end_state && task.changes_status !== 'needs_review') {
    hud.structure_diff = computeStructureDiff(beforeIndex, await index(task.end_state.snapshot_id),
      scopeDeclared ? declaredScope : [], changedFiles);
  }
  for (const feature of impacted) {
    if (!feature.previous_result_id || !feature.refreshed_result_id || !feature.has_call_graph) continue;
    const before = byId.get(feature.previous_result_id)!.result;
    const after = byId.get(feature.refreshed_result_id)!.result;
    if (!hasFunctionGraphs(before) || !hasFunctionGraphs(after)) continue;
    const from = before.binding.source_snapshot_id, to = after.binding.source_snapshot_id;
    const beforeSnap = snapshot(from), afterSnap = snapshot(to);
    const referenced = new Set([...before.evidence, ...after.evidence].map(ref => ref.path));
    const afterHashes = new Map(afterSnap.files.map(file => [file.path, file.content_sha256]));
    const changedSources = beforeSnap.files.filter(file => referenced.has(file.path) &&
      afterHashes.has(file.path) && afterHashes.get(file.path) !== file.content_sha256);
    const sources = async (snap: Snapshot) => new Map(await Promise.all(changedSources.map(async ({path: file}) =>
      [file, (await readSource(directory, snap, file)).text] as const)));
    const [beforeSources, afterSources] = await Promise.all([sources(beforeSnap), sources(afterSnap)]);
    hud.walkthrough_diffs.push(computeWalkthroughDiff({
      feature_id: feature.feature_id, scenario_id: feature.scenario_id, feature_label: feature.label, before, after,
      beforeSnapshot: beforeSnap, afterSnapshot: afterSnap, beforeIndex: await index(from), afterIndex: await index(to),
      beforeSources, afterSources,
    }));
  }
  return hud;
}
