import type { HudImpactedFeature, TaskHudStructureDiff, WalkthroughDiff, WalkthroughDiffNode } from '../development-hud';
import type { EvolutionCallSite, EvolutionFeatureFlow, EvolutionFlowStep, EvolutionSourceMode, EvolutionView } from '../evolution-view';
import type { AnalysisResult, Explanation } from '../shared';
import { supportsSourceFile, type CodeCall, type CodeIndex, type CodeSymbol } from './code-index';

export interface EvolutionFlowIndexes {
  beforeIndex?: CodeIndex;
  afterIndex?: CodeIndex;
  beforeSources?: ReadonlyMap<string, string>;
  afterSources?: ReadonlyMap<string, string>;
}

interface FlowInput extends EvolutionFlowIndexes {
  mode: EvolutionSourceMode;
  changedFiles: readonly string[];
  projectedFiles: readonly string[];
  boundFeatureId?: string;
  impactedFeatures?: readonly HudImpactedFeature[];
  walkthroughDiffs?: readonly WalkthroughDiff[];
  explanations?: ReadonlyMap<string, Explanation>;
  walkthroughIndexes?: ReadonlyMap<string, EvolutionFlowIndexes>;
  changedSymbols: readonly WalkthroughDiffNode[];
  structureDiff?: TaskHudStructureDiff;
}

const stepLimit = 10;
const keyFor = (file: string, name: string) => file + '\0' + name;

function callIndex(index: CodeIndex, sources?: ReadonlyMap<string, string>) {
  const ids = new Map(index.symbols.map(symbol => [symbol.id, symbol]));
  const names = new Map<string, CodeSymbol[]>();
  const outgoing = new Map<string, CodeCall[]>();
  for (const symbol of index.symbols) {
    for (const name of new Set([symbol.qualified_name, symbol.name])) {
      const key = keyFor(symbol.file, name);
      const group = names.get(key);
      if (group) group.push(symbol);
      else names.set(key, [symbol]);
    }
  }
  for (const call of index.calls) {
    // Reference expressions register callbacks, but do not invoke the target at this line.
    if (!call.target_ids.length || call.syntax === 'reference') continue;
    const group = outgoing.get(call.caller_id);
    if (group) group.push(call);
    else outgoing.set(call.caller_id, [call]);
  }
  const lines = new Map<string, string[]>();
  function resolve(node: WalkthroughDiffNode, side: 'before' | 'after') {
    if (!node.file) return;
    const symbols = names.get(keyFor(node.file, node.symbol));
    if (!symbols || symbols.length === 1) return symbols?.[0];
    const line = side === 'before' ? node.before_line : node.after_line;
    const signature = side === 'before' ? node.before_signature : node.after_signature;
    const atLine = symbols.filter(s => s.start_line === line);
    if (atLine.length === 1) return atLine[0];
    const exact = symbols.filter(s => s.signature === signature);
    if (exact.length === 1) return exact[0];
  }
  function sites(caller: CodeSymbol | undefined, target?: CodeSymbol) {
    if (!caller) return [];
    if (!lines.has(caller.file) && sources?.has(caller.file)) {
      lines.set(caller.file, sources.get(caller.file)!.split(/\r\n|\n|\r/).map(s => s.trim()));
    }
    const text = lines.get(caller.file);
    return (outgoing.get(caller.id) ?? []).flatMap(call => call.target_ids
      .filter(id => !target || id === target.id).map(id => {
        const to = ids.get(id)!;
        return {
          to, caller, call, text: text?.[call.line - 1], prev: text?.[call.line - 2], next: text?.[call.line],
        };
      }));
  }
  return {names, resolve, sites};
}

type Occurrence = ReturnType<ReturnType<typeof callIndex>['sites']>[number];

// Match repeated calls inside one caller/target pair. Source anchors survive inserted
// lines. Matching by occurrence order fills the remaining pairs when arguments changed.
function compareSites(old: Occurrence[], next: Occurrence[]): EvolutionCallSite[] {
  const remaining = new Set(old), additions = new Set(next);
  type Anchor = (site: Occurrence) => string | number | undefined;
  function unique(sites: Set<Occurrence>, anchor: Anchor) {
    const found = new Map<string | number, Occurrence | null>();
    for (const site of sites) {
      const key = anchor(site);
      if (key !== undefined) found.set(key, found.has(key) ? null : site);
    }
    return found;
  }
  const anchors: Anchor[] = [
    s => s.text && JSON.stringify([s.prev, s.text, s.next]),
    s => s.text && JSON.stringify([s.text, s.next]),
    s => s.text && JSON.stringify([s.prev, s.text]),
    s => s.text,
    s => s.caller.end_line - s.call.line,
    s => s.call.line - s.caller.start_line,
  ];
  for (const anchor of anchors) {
    if (!remaining.size || !additions.size) break;
    const oldSites = unique(remaining, anchor);
    for (const [key, site] of unique(additions, anchor)) {
      const prior = oldSites.get(key);
      if (site && prior) { remaining.delete(prior); additions.delete(site); }
    }
  }
  // Repeated identical anchors can still be indistinguishable. Pair the rest in source order.
  const priorSites = [...remaining];
  const uncertain = remaining.size && additions.size && remaining.size !== additions.size
    ? new Set([...remaining, ...additions]) : undefined;
  [...additions].slice(0, priorSites.length).forEach((site, i) => {
    remaining.delete(priorSites[i]);
    additions.delete(site);
  });
  function location(site: Occurrence, status: EvolutionCallSite['status']): EvolutionCallSite {
    const {call, caller, to} = site;
    return {file: call.file, line: call.line, caller_symbol: caller.qualified_name, target_symbol: to.qualified_name,
      target_file: to.file, status, ...((call.target_ids.length > 1 || uncertain?.has(site)) && {ambiguous: true})};
  }
  return [...next.map(s => location(s, additions.has(s) ? 'added' : 'unchanged')), ...[...remaining].map(s => location(s, 'removed'))];
}

function callsFor(indexes: EvolutionFlowIndexes) {
  const before = indexes.beforeIndex && callIndex(indexes.beforeIndex, indexes.beforeSources);
  const after = indexes.afterIndex && callIndex(indexes.afterIndex, indexes.afterSources);
  return (from: WalkthroughDiffNode, to?: WalkthroughDiffNode) => {
    if (!before || !after) return [];
    function occurrences(index: ReturnType<typeof callIndex>, side: 'before' | 'after') {
      // A node added to a walkthrough can already exist in both code snapshots.
      // Only AST symbol steps (no target filter) establish a missing caller.
      if (!to && from.status === (side === 'before' ? 'added' : 'removed')) return [];
      const target = to && index.resolve(to, side);
      return to && !target ? [] : index.sites(index.resolve(from, side), target);
    }
    const groups = new Map<string, {before: Occurrence[]; after: Occurrence[]}>();
    for (const side of ['before', 'after'] as const) {
      for (const site of occurrences(side === 'before' ? before : after, side)) {
        let key = keyFor(site.to.file, site.to.qualified_name);
        if ((before.names.get(key)?.length ?? 0) > 1 || (after.names.get(key)?.length ?? 0) > 1) key += '\0' + site.to.signature;
        const group = groups.get(key) ?? {before: [], after: []};
        group[side].push(site);
        groups.set(key, group);
      }
    }
    return [...groups.values()].flatMap(g => compareSites(g.before, g.after)).sort((a, b) => a.line - b.line);
  };
}

function diffFlow(diff: WalkthroughDiff, indexes: EvolutionFlowIndexes): EvolutionFeatureFlow[] {
  const sites = callsFor(indexes);
  return diff.paths.map(path => {
    const nodes = new Map(path.participants.map(n => [n.key, n]));
    const steps = path.steps.map((step, i): EvolutionFlowStep => {
      const evidence = step.after_evidence ?? step.before_evidence;
      const from = step.from_key && nodes.get(step.from_key), to = nodes.get(step.to_key);
      const status = step.status === 'noise' || (step.status === 'modified' && !step.code_changed) ? 'description_only' : step.status;
      return {id: step.id, order: i + 1, status, title: step.after_text ?? step.before_text ?? step.to_symbol,
        symbol: step.to_symbol, file: evidence?.path, line: evidence?.line_start, before_line: step.before_evidence?.line_start,
        after_line: step.after_evidence?.line_start, before_text: step.before_text, after_text: step.after_text,
        call_sites: from && to && step.kind !== 'entry' && step.kind !== 'work'
          ? step.kind === 'return' ? sites(to, from) : sites(from, to) : []};
    });
    return {id: 'diff:' + diff.scenario_id + ':' + path.path_key, mode: 'walkthrough_diff',
      feature_id: diff.feature_id, scenario_id: diff.scenario_id,
      feature_label: diff.paths.length > 1 ? `${diff.feature_label} · ${path.label}` : diff.feature_label,
      before_result_id: diff.before_result_id, after_result_id: diff.after_result_id,
      before_snapshot_id: diff.before_snapshot_id, after_snapshot_id: diff.after_snapshot_id, steps, omitted_steps: 0};
  });
}

function staleFlow(feature: HudImpactedFeature, result: AnalysisResult, files: Set<string>, blueprint: boolean): EvolutionFeatureFlow {
  const evidence = new Map(result.evidence.map(e => [e.evidence_id, e]));
  const nodes = new Map(result.nodes.map(n => [n.node_id, n]));
  function step(id: string, title: string, text: string, nodeIds: readonly string[], refs: readonly string[], order: number): EvolutionFlowStep {
    const participants = nodeIds.map(id => nodes.get(id)!);
    const anchors = [...refs, ...participants.flatMap(n => n.evidence_ids)].map(id => evidence.get(id)!);
    const hit = anchors.find(e => files.has(e.path)), anchor = hit ?? anchors[0];
    return {id, order, title, subtitle: text, before_text: text, status: hit ? (blueprint ? 'planned' : 'modified') : 'unchanged',
      file: anchor?.path, line: anchor?.line_start, before_line: anchor?.line_start, symbol: participants.at(-1)?.function_details?.symbol};
  }
  const path = result.function_walkthroughs?.[0];
  const guide = result.reading_guide;
  let steps: EvolutionFlowStep[];
  let total: number;
  if (path?.steps.length) {
    total = path.steps.length;
    steps = path.steps.slice(0, stepLimit).map((s, i) => step(s.id, nodes.get(s.to_node_id)!.label, s.text,
      s.from_node_id ? [s.from_node_id, s.to_node_id] : [s.to_node_id], s.evidence_ids, i + 1));
  } else if (guide?.steps.length) {
    const byId = new Map(guide.steps.map(s => [s.id, s]));
    const rows = guide.paths[0]?.step_ids.map(id => byId.get(id)!) ?? guide.steps;
    total = rows.length;
    steps = rows.slice(0, stepLimit).map((s, i) => step(s.id, s.title, s.text, s.node_ids, s.evidence_ids, i + 1));
  } else {
    const main = new Set(result.edges.filter(e => e.flow_role === 'main').flatMap(e => [e.source_node_id, e.target_node_id]));
    const rows = main.size ? result.nodes.filter(n => main.has(n.node_id)) : result.nodes;
    total = rows.length;
    steps = rows.slice(0, stepLimit).map((n, i) => step(n.node_id, n.label, n.description, [n.node_id], [], i + 1));
  }
  return {id: 'stale:' + feature.scenario_id, mode: 'walkthrough_stale', feature_id: feature.feature_id, scenario_id: feature.scenario_id,
    feature_label: feature.label, before_result_id: result.result_id, stale_notice: '改后走读待刷新（当前基于改前走读投影）',
    before_snapshot_id: result.binding.source_snapshot_id, steps, omitted_steps: total - steps.length};
}

function astFlow(input: FlowInput): EvolutionFeatureFlow | undefined {
  if (input.mode === 'task_blueprint' || !input.beforeIndex || !input.afterIndex) return;
  const {structureDiff} = input;
  const nodes = [...input.changedSymbols];
  // The call graph intentionally excludes type declarations. Their signatures still affect contracts.
  if (structureDiff) {
    for (const [status, changes] of [['added', structureDiff.added_symbols], ['removed', structureDiff.removed_symbols],
      ['modified', structureDiff.signature_changed_symbols]] as const) {
      for (const s of changes.filter(s => ['class', 'struct', 'interface'].includes(s.kind))) {
        nodes.push({key: keyFor(s.file, s.symbol), status, label: s.symbol, symbol: s.symbol, file: s.file, description: s.kind,
          before_line: status === 'removed' ? s.line : undefined, after_line: status !== 'removed' ? s.line : undefined,
          before_signature: s.before_signature, after_signature: s.after_signature, code_changed: true});
      }
    }
  }
  if (!nodes.length) return;
  const rank = (node: WalkthroughDiffNode) => node.status === 'modified' && node.before_signature === node.after_signature ? 1 : 0;
  nodes.sort((a, b) => rank(a) - rank(b));
  const sites = callsFor(input);
  const steps = nodes.slice(0, stepLimit).map((n, i): EvolutionFlowStep => ({
    id: n.key, order: i + 1, status: n.status === 'added' || n.status === 'removed' ? n.status : 'modified',
    title: n.label, subtitle: n.description, symbol: n.symbol, file: n.file, line: n.after_line ?? n.before_line,
    before_line: n.before_line, after_line: n.after_line, before_signature: n.before_signature ?? undefined,
    after_signature: n.after_signature ?? undefined, call_sites: sites(n),
  }));
  return {id: 'ast', mode: 'ast_symbol_flow', feature_label: '变更符号', steps,
    before_snapshot_id: input.beforeIndex.snapshot_id, after_snapshot_id: input.afterIndex.snapshot_id,
    omitted_steps: nodes.length - steps.length};
}

export function buildEvolutionFlows(input: FlowInput): Pick<EvolutionView, 'features' | 'active_feature_index' | 'document_only'> {
  const document_only = input.changedFiles.length > 0 && !input.changedFiles.some(supportsSourceFile);
  if (document_only) return {document_only, active_feature_index: 0, features: [
    {id: 'documents', mode: 'document_only', feature_label: '变更仅涉及非 AST 源文件', steps: [], omitted_steps: 0},
  ]};
  const hasChanges = (flow: EvolutionFeatureFlow) =>
    flow.steps.some(step => step.status !== 'unchanged' && step.status !== 'description_only');
  const features = (input.walkthroughDiffs ?? [])
    .flatMap(diff => diffFlow(diff, input.walkthroughIndexes?.get(diff.scenario_id) ?? input))
    .sort((a, b) => Number(hasChanges(b)) - Number(hasChanges(a)));
  const paired = new Set(features.map(f => f.scenario_id));
  const files = new Set(input.projectedFiles);
  for (const feature of input.impactedFeatures ?? []) {
    if (!feature.previous_result_id || paired.has(feature.scenario_id)) continue;
    const result = input.explanations?.get(feature.previous_result_id)?.result;
    if (result) features.push(staleFlow(feature, result, files, input.mode === 'task_blueprint'));
  }
  const ast = astFlow(input);
  if (ast) features.push(ast);
  if (!features.length) features.push({id: 'empty', mode: 'empty', feature_label: '暂无可投影的功能流程', steps: [], omitted_steps: 0});
  const active = features.find(f => input.boundFeatureId && f.feature_id === input.boundFeatureId)
    ?? features.find(f => f.mode === 'walkthrough_diff')
    ?? features.find(f => f.mode === 'walkthrough_stale' && f.steps.some(s => s.status !== 'unchanged'))
    ?? ast ?? features[0];
  return {document_only, features, active_feature_index: features.indexOf(active)};
}
