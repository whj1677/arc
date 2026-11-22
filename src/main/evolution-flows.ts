import type { HudImpactedFeature, TaskHudStructureDiff, WalkthroughDiff, WalkthroughDiffNode } from '../development-hud';
import type { EvolutionCallSite, EvolutionFeatureFlow, EvolutionFlowStep, EvolutionSourceMode, EvolutionView } from '../evolution-view';
import type { AnalysisResult, Explanation, SourceEvidence } from '../shared';
import type { CodeCall, CodeIndex, CodeSymbol } from './code-index';

export interface EvolutionFlowIndexes {
  beforeIndex?: CodeIndex;
  afterIndex?: CodeIndex;
  beforeSources?: ReadonlyMap<string, string>;
  afterSources?: ReadonlyMap<string, string>;
}

interface FlowInput extends EvolutionFlowIndexes {
  mode: EvolutionSourceMode;
  documentOnly: boolean;
  moduleByFile: ReadonlyMap<string, string>;
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
const staleStepLimit = 40;
const keyFor = (file: string, name: string) => file + '\0' + name;

export function symbolDoc(text: string | undefined, line: number | undefined) {
  if (text === undefined || line === undefined) return;
  const lines = text.split(/\r\n|\n|\r/);
  let nearest: string | undefined;
  for (let i = line - 2, seen = 0; i >= 0 && seen < 4; i--) {
    const comment = lines[i].trim();
    if (!comment) continue;
    if (!/^(?:\/\/|\/\*\*|\*|@brief\b)/.test(comment)) break;
    seen++;
    const content = comment.replace(/^\s*(?:\/\/[/!]?|\/\*\*|\*)?\s*/, '').replace(/\s*\*\/$/, '').trim();
    const brief = content.match(/^@brief\s+(.+)/)?.[1];
    if (brief) return brief.slice(0, 48);
    if (/^(?:\/\/|\/\*\*)/.test(comment) && content) nearest ??= content.slice(0, 48);
  }
  return nearest;
}

// Equal lines anchor both coordinate systems. An inserted block belongs after
// the last matched before-line; replacement lines advance within the old span.
export function diffLines(beforeText: string, afterText: string) {
  const old = beforeText.split(/\r\n|\n|\r/), next = afterText.split(/\r\n|\n|\r/);
  const positions = new Int32Array(next.length);
  const changedBeforeLines = new Set<number>(), insertions = new Set<number>();
  let b = 0, a = 0;
  function match(i: number, j: number) {
    for (let k = b; k < i; k++) changedBeforeLines.add(k + 1);
    if (a < j && b === i) insertions.add(Math.max(1, b));
    for (let k = a; k < j; k++) positions[k] = Math.max(1, Math.min(i, b + k - a + 1));
    if (j < next.length) positions[j] = i + 1;
    b = i + 1;
    a = j + 1;
  }
  while (b < old.length && a < next.length && old[b] === next[a]) match(b, a);
  let endB = old.length, endA = next.length;
  while (endB > b && endA > a && old[endB - 1] === next[endA - 1]) { endA--; endB--; }
  const height = endB - b, width = endA - a;
  if (height && width && height <= 1500 && width <= 1500) {
    const stride = width + 1, lcs = new Uint16Array((height + 1) * stride);
    const startB = b, startA = a;
    for (let i = height - 1; i >= 0; i--) for (let j = width - 1; j >= 0; j--) {
      const k = i * stride + j;
      lcs[k] = old[startB + i] === next[startA + j] ? 1 + lcs[k + stride + 1] : Math.max(lcs[k + 1], lcs[k + stride]);
    }
    for (let i = 0, j = 0; i < height && j < width;) {
      if (old[startB + i] === next[startA + j]) match(startB + i++, startA + j++);
      else if (lcs[i * stride + j + 1] >= lcs[(i + 1) * stride + j]) j++;
      else i++;
    }
  } else if (height && width) {
    // Anchor at unique lines first so braces in newly inserted functions cannot
    // consume the boundaries of later unchanged functions.
    const unique = (lines: string[], start: number, end: number) => {
      const indices = new Map<string, number>();
      for (let i = start; i < end; i++) indices.set(lines[i], indices.has(lines[i]) ? -1 : i);
      return indices;
    };
    const prior = unique(old, b, endB), current = unique(next, a, endA);
    function alignGap(i: number, j: number) {
      while (b < i && a < j && old[b] === next[a]) match(b, a);
      let x = i, y = j;
      while (x > b && y > a && old[x - 1] === next[y - 1]) { x--; y--; }
      while (x < i) match(x++, y++);
    }
    // Keep the longest increasing sequence of old positions in new-file order.
    type Anchor = {i: number; j: number; previous?: Anchor};
    const tails: Anchor[] = [];
    for (let j = a; j < endA; j++) {
      const i = prior.get(next[j]);
      if (i === undefined || i < 0 || current.get(next[j]) !== j) continue;
      let lo = 0, hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (tails[mid].i < i) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = {i, j, previous: tails[lo - 1]};
    }
    const sequence: Anchor[] = [];
    for (let anchor = tails.at(-1); anchor; anchor = anchor.previous) sequence.push(anchor);
    for (const {i, j} of sequence.reverse()) {
      alignGap(i, j);
      match(i, j);
    }
    alignGap(endB, endA);
  }
  for (let i = endB, j = endA; i <= old.length; i++, j++) match(i, j);
  return {changedBeforeLines, insertions, mapAfterToBefore: (line: number) => positions[line - 1]};
}

function callIndex(index: CodeIndex, sources?: ReadonlyMap<string, string>, addedRefs: readonly WalkthroughDiffNode[] = []) {
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
  const addedTargetIds = new Set(addedRefs.filter(node => node.status === 'added').map(node => resolve(node, 'after')?.id));
  for (const call of index.calls) {
    // Callback references are only indexed for stale walkthrough insertion discovery.
    if (!call.target_ids.length || (call.syntax === 'reference' && !call.target_ids.some(id => addedTargetIds.has(id)))) continue;
    const group = outgoing.get(call.caller_id);
    if (group) group.push(call);
    else outgoing.set(call.caller_id, [call]);
  }
  const lines = new Map<string, string[]>();
  function find(file: string, name: string, line?: number, signature?: string | null) {
    const symbols = names.get(keyFor(file, name));
    if (!symbols || symbols.length === 1) return symbols?.[0];
    const atLine = symbols.filter(s => s.start_line === line);
    if (atLine.length === 1) return atLine[0];
    const exact = symbols.filter(s => s.signature === signature);
    if (exact.length === 1) return exact[0];
  }
  function resolve(node: WalkthroughDiffNode, side: 'before' | 'after') {
    if (node.file) return find(node.file, node.symbol, side === 'before' ? node.before_line : node.after_line,
      side === 'before' ? node.before_signature : node.after_signature);
  }
  function sites(caller: CodeSymbol | undefined, target?: CodeSymbol, includeAddedRefs = false) {
    if (!caller) return [];
    if (!lines.has(caller.file) && sources?.has(caller.file)) {
      lines.set(caller.file, sources.get(caller.file)!.split(/\r\n|\n|\r/).map(s => s.trim()));
    }
    const text = lines.get(caller.file);
    return (outgoing.get(caller.id) ?? []).flatMap(call => call.target_ids
      .filter(id => (!target || id === target.id) &&
        (call.syntax !== 'reference' || (includeAddedRefs && addedTargetIds.has(id)))).map(id => {
        const to = ids.get(id)!;
        return {
          to, caller, call, text: text?.[call.line - 1], prev: text?.[call.line - 2], next: text?.[call.line],
        };
      }));
  }
  return {names, find, resolve, sites};
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

function callComparison(indexes: EvolutionFlowIndexes, addedRefs?: readonly WalkthroughDiffNode[]) {
  const before = indexes.beforeIndex && callIndex(indexes.beforeIndex, indexes.beforeSources);
  const after = indexes.afterIndex && callIndex(indexes.afterIndex, indexes.afterSources, addedRefs);
  function callsFor(from: WalkthroughDiffNode, to?: WalkthroughDiffNode) {
    if (!before || !after) return [];
    function occurrences(index: ReturnType<typeof callIndex>, side: 'before' | 'after') {
      // A node added to a walkthrough can already exist in both code snapshots.
      // Only AST symbol steps (no target filter) establish a missing caller.
      if (!to && from.status === (side === 'before' ? 'added' : 'removed')) return [];
      const target = to && index.resolve(to, side);
      return to && !target ? [] : index.sites(index.resolve(from, side), target, side === 'after' && !!addedRefs);
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
  }
  return {before, after, callsFor};
}

function diffFlow(diff: WalkthroughDiff, indexes: EvolutionFlowIndexes): EvolutionFeatureFlow[] {
  const {callsFor: sites} = callComparison(indexes);
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

function staleFlow(feature: HudImpactedFeature, result: AnalysisResult, input: FlowInput, files: Set<string>): EvolutionFeatureFlow {
  const blueprint = input.mode === 'task_blueprint';
  const {before, after, callsFor} = callComparison(blueprint ? {} : input, input.changedSymbols);
  const evidence = new Map(result.evidence.map(e => [e.evidence_id, e]));
  const changedSymbolKeys = new Map<string, WalkthroughDiffNode>();
  const changedById = new Map<string, WalkthroughDiffNode>();
  for (const change of input.changedSymbols) {
    if (!change.file) continue;
    changedSymbolKeys.set(keyFor(change.file, change.symbol), change);
    changedSymbolKeys.set(keyFor(change.file, change.label), change); // AST short name
    const symbol = before?.resolve(change, 'before');
    if (symbol && change.status !== 'added') changedById.set(symbol.id, change);
  }
  const nodes = new Map(result.nodes.map(node => {
    const details = node.function_details;
    const definition = details && evidence.get(details.definition_evidence_id);
    const file = definition?.path ?? evidence.get(node.evidence_ids[0])?.path ?? node.source_scope?.path;
    const symbol = file && details ? before?.find(file, details.symbol, definition?.line_start, details.signature) : undefined;
    const name = symbol?.qualified_name ?? details?.symbol;
    const key = file && name ? keyFor(file, name) : undefined;
    const change = symbol ? changedById.get(symbol.id) : key ? changedSymbolKeys.get(key) : undefined;
    return [node.node_id, {node, file, symbol, key, change}];
  }));
  const fileDiffs = new Map<string, ReturnType<typeof diffLines>>();
  function fileDiff(file: string) {
    if (!fileDiffs.has(file)) {
      const old = input.beforeSources?.get(file), next = input.afterSources?.get(file);
      if (old === undefined || next === undefined) return;
      fileDiffs.set(file, diffLines(old, next));
    }
    return fileDiffs.get(file);
  }

  function row(id: string, title: string, text: string, nodeIds: readonly string[], refs: readonly string[]) {
    const from = nodeIds.length > 1 ? nodes.get(nodeIds[0]) : undefined;
    const to = nodes.get(nodeIds.at(-1)!);
    const own = refs.map(id => evidence.get(id)!);
    const local = own.filter(e => e.role !== 'definition' && e.role !== 'declaration');
    // A call step often cites both the callsite and the callee's entire definition.
    const anchors = local.length ? local : own.length ? own : (to?.node.evidence_ids ?? []).map(id => evidence.get(id)!);
    function changed(e: SourceEvidence) {
      const diff = fileDiff(e.path);
      if (!diff) return before ? !!to?.change : files.has(e.path);
      const callerOnly = to?.symbol && !to.change;
      if (callerOnly && (!own.length || e.path !== from?.file || (from.symbol &&
          (e.line_start < from.symbol.start_line || e.line_end > from.symbol.end_line)))) return false;
      for (let line = e.line_start; line <= e.line_end; line++) {
        if (diff.changedBeforeLines.has(line)) return true;
      }
      if (!callerOnly) {
        for (const line of diff.insertions) if (line >= e.line_start - 2 && line <= e.line_end + 2) return true;
      }
      return false;
    }
    const hit = blueprint
      ? [...own, ...nodeIds.flatMap(id => nodes.get(id)!.node.evidence_ids.map(ref => evidence.get(ref)!))].find(e => files.has(e.path))
      : anchors.find(changed);
    const anchor = hit ?? anchors[0];
    const step: EvolutionFlowStep = {id, order: 0, title, subtitle: text, before_text: text,
      status: hit ? (blueprint ? 'planned' : 'modified') : 'unchanged', file: anchor?.path,
      line: anchor?.line_start, before_line: anchor?.line_start, symbol: to?.node.function_details?.symbol};
    return {from, to, anchors, step};
  }
  const path = result.function_walkthroughs?.[0];
  const guide = result.reading_guide;
  let rows: ReturnType<typeof row>[];
  let total: number;
  if (path?.steps.length) {
    total = path.steps.length;
    rows = path.steps.slice(0, staleStepLimit).map(s => row(s.id, nodes.get(s.to_node_id)!.node.label, s.text,
      s.from_node_id ? [s.from_node_id, s.to_node_id] : [s.to_node_id], s.evidence_ids));
  } else if (guide?.steps.length) {
    const byId = new Map(guide.steps.map(s => [s.id, s]));
    const ordered = guide.paths[0]?.step_ids.map(id => byId.get(id)!) ?? guide.steps;
    total = ordered.length;
    rows = ordered.slice(0, staleStepLimit).map(s => row(s.id, s.title, s.text, s.node_ids, s.evidence_ids));
  } else {
    const main = new Set(result.edges.filter(e => e.flow_role === 'main').flatMap(e => [e.source_node_id, e.target_node_id]));
    const ordered = main.size ? result.nodes.filter(n => main.has(n.node_id)) : result.nodes;
    total = ordered.length;
    rows = ordered.slice(0, staleStepLimit).map(n => row(n.node_id, n.label, n.description, [n.node_id], []));
  }
  const participants = rows.flatMap(r => [r.from, r.to]);
  const participantKeys = new Set(participants.map(n => n?.key));
  const changes = new Set(participants.map(n => n?.change));
  const added = new Map<typeof rows[number], EvolutionFlowStep[]>();
  for (const change of changes) {
    if (change?.status !== 'modified' || !before || !after) continue;
    const caller = before.resolve(change, 'before'), next = after.resolve(change, 'after');
    if (!caller || !next) continue;
    const callerRows = rows.filter(r => r.from?.symbol?.id === caller.id || r.to?.symbol?.id === caller.id);
    if (!callerRows.length) continue;
    const connectedFiles = new Set(before.sites(caller).map(s => s.to.file));
    for (const r of callerRows) if (r.from?.symbol?.id === caller.id && r.to?.file) connectedFiles.add(r.to.file);
    const targets = after.sites(next, undefined, true);
    const seen = new Set<string>();
    for (const call of callsFor(change)) {
      const key = keyFor(call.target_file, call.target_symbol);
      if (call.status !== 'added' || seen.has(key)) continue;
      seen.add(key); // callsFor returns sites in source order.
      if (participantKeys.has(key) && (call.target_file === caller.file || connectedFiles.has(call.target_file))) continue;
      const target = targets.find(s => s.call.line === call.line && s.to.file === call.target_file && s.to.qualified_name === call.target_symbol)!.to;
      const anchor = fileDiff(call.file)?.mapAfterToBefore(call.line);
      const position = callerRows.findLast(r => r.anchors.some(e => e.path === caller.file && anchor !== undefined &&
        e.line_start >= caller.start_line && e.line_end <= caller.end_line && e.line_start <= anchor)) ?? callerRows[0];
      const group = added.get(position) ?? [];
      group.push({id: 'ast-ins:' + call.file + ':' + call.line + ':' + call.target_symbol, order: 0, status: 'added',
        inserted: true, parent_symbol: caller.qualified_name, title: symbolDoc(input.afterSources?.get(target.file), target.start_line) ?? call.target_symbol,
        subtitle: '在 ' + caller.qualified_name + ' 中新增调用', symbol: call.target_symbol, file: call.file, line: call.line,
        after_line: call.line, call_sites: [call], sub_calls: [...new Set(after.sites(target).map(s => s.to.qualified_name))].slice(0, 4)});
      added.set(position, group);
    }
  }
  const steps = rows.flatMap(r => [r.step, ...(added.get(r) ?? [])]);
  steps.forEach((s, i) => { s.order = i + 1; });
  return {id: 'stale:' + feature.scenario_id, mode: 'walkthrough_stale', feature_id: feature.feature_id, scenario_id: feature.scenario_id,
    feature_label: feature.label, before_result_id: result.result_id, stale_notice: '改后走读待刷新（当前基于改前走读投影）',
    before_snapshot_id: result.binding.source_snapshot_id, after_snapshot_id: blueprint ? undefined : input.afterIndex?.snapshot_id,
    steps, omitted_steps: total - rows.length};
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
  const {callsFor: sites} = callComparison(input);
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
  const document_only = input.documentOnly;
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
    if (result) features.push(staleFlow(feature, result, input, files));
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
