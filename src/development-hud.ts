import type { AnalysisResult, FunctionWalkthrough, SourceEvidence } from '../contracts/agent-adapter';
import type { CodeIndex, CodeSymbol } from './main/code-index';
import type { Snapshot } from './shared';

export interface HudExternalCaller {
  caller_symbol: string;
  caller_file: string;
  caller_line: number;
  target_symbol: string;
  target_file: string;
  target_line: number;
}

export interface HudSharedState {
  name: string;
  file: string;
  line: number;
  access_dirs: string[];
  external_dirs: string[];
}

export interface HudArchitectureNode {
  node_id: string;
  label: string;
  kind: string;
  relation: 'direct' | 'neighbor';
}

export interface HudArchitectureEdge {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  from_label: string;
  to_label: string;
  label: string;
}

export interface HudImpactedFeature {
  feature_id: string;
  scenario_id: string;
  label: string;
  previous_result_id?: string;
  refreshed_result_id?: string;
  has_call_graph: boolean;
  refreshing: boolean;
  error?: string;
}

export interface HudUntestedSymbol {
  symbol: string;
  file: string;
  line: number;
}

export interface HudConstraintRef {
  entry_id: string;
  category: string;
  key: string;
  excerpt: string;
}

export interface TaskHudImpact {
  scope_files: string[];
  scope_declared: boolean;
  architecture_result_id?: string;
  external_callers: HudExternalCaller[];
  shared_states: HudSharedState[];
  architecture_nodes: HudArchitectureNode[];
  architecture_edges: HudArchitectureEdge[];
  impacted_features: HudImpactedFeature[];
  untested_symbols: HudUntestedSymbol[];
  related_constraints: HudConstraintRef[];
}

export interface HudSymbolChange {
  symbol: string;
  kind: string;
  file: string;
  line: number;
  public_entry: boolean;
  before_signature?: string;
  after_signature?: string;
  unupdated_external_callers?: HudExternalCaller[];
}

export interface HudCallChange {
  caller_symbol: string;
  caller_file: string;
  caller_line: number;
  callee_symbol: string;
  callee_file: string;
}

export interface HudModuleEdgeChange {
  from: string;
  to: string;
  before_count: number;
  after_count: number;
}

export interface HudSharedStateChange {
  name: string;
  file: string;
  added_dirs: string[];
  removed_dirs: string[];
}

export interface TaskHudStructureDiff {
  changed_files: string[];
  scope_declared: boolean;
  out_of_scope_files: string[];
  added_symbols: HudSymbolChange[];
  removed_symbols: HudSymbolChange[];
  signature_changed_symbols: HudSymbolChange[];
  added_calls: HudCallChange[];
  removed_calls: HudCallChange[];
  added_module_edges: HudModuleEdgeChange[];
  removed_module_edges: HudModuleEdgeChange[];
  new_cycles: string[][];
  shared_state_changes: HudSharedStateChange[];
}

type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged' | 'noise';

export interface WalkthroughDiffNode {
  key: string;
  status: DiffStatus;
  symbol: string;
  label: string;
  description: string;
  file: string | null;
  before_node_id?: string;
  after_node_id?: string;
  before_line?: number;
  after_line?: number;
  before_editor_line?: number;
  after_editor_line?: number;
  before_signature?: string | null;
  after_signature?: string | null;
  code_changed: boolean;
}

export interface WalkthroughDiffEdge {
  key: string;
  status: Exclude<DiffStatus, 'modified'>;
  from_key: string;
  to_key: string;
  kind: 'sync_call' | 'execution_boundary' | 'reference';
  before_label?: string;
  after_label?: string;
  ast_confirmed: boolean;
}

type EvidenceLocation = Pick<SourceEvidence, 'path' | 'line_start' | 'line_end'>;

export interface WalkthroughDiffStep {
  id: string;
  status: DiffStatus;
  kind: FunctionWalkthrough['steps'][number]['kind'];
  from_key: string | null;
  to_key: string;
  from_symbol: string;
  to_symbol: string;
  before_step_id?: string;
  after_step_id?: string;
  before_index?: number;
  after_index?: number;
  before_text?: string;
  after_text?: string;
  before_condition?: string;
  after_condition?: string;
  before_input?: string;
  after_input?: string;
  before_output?: string;
  after_output?: string;
  before_evidence?: EvidenceLocation;
  after_evidence?: EvidenceLocation;
  diff_reasons: ('condition' | 'kind' | 'io' | 'text')[];
  code_changed: boolean;
}

export interface WalkthroughPathDiff {
  path_key: string;
  label: string;
  entry_symbol: string;
  status: Exclude<DiffStatus, 'noise'>;
  before_path_id?: string;
  after_path_id?: string;
  participants: WalkthroughDiffNode[];
  edges: WalkthroughDiffEdge[];
  steps: WalkthroughDiffStep[];
  counts: {
    added_nodes: number;
    removed_nodes: number;
    modified_nodes: number;
    added_edges: number;
    removed_edges: number;
    added_steps: number;
    removed_steps: number;
    modified_steps: number;
    noise_count: number;
  };
}

export interface WalkthroughDiff {
  feature_id: string;
  scenario_id: string;
  feature_label: string;
  before_result_id: string;
  after_result_id: string;
  before_snapshot_id: string;
  after_snapshot_id: string;
  paths: WalkthroughPathDiff[];
}

export interface AstCallGraphDiff {
  before_snapshot_id: string;
  after_snapshot_id: string;
  path: WalkthroughPathDiff;
  omitted_changes: number;
  omitted_neighbors: number;
}

export interface TaskHudSnapshot {
  task_id: string;
  version: number;
  impact: TaskHudImpact;
  structure_diff?: TaskHudStructureDiff;
  ast_call_graph?: AstCallGraphDiff;
  walkthrough_diffs: WalkthroughDiff[];
  impacted_features: HudImpactedFeature[];
}

const structureSymbolKey = (s: CodeSymbol) => [s.file, s.kind, s.qualified_name].join('\0');
const normalizeSignature = (s: CodeSymbol) => s.signature.replace(/;+\s*$/, '').replace(/\s+/g, ' ').trim();
const implementationDeclaration = (s: CodeSymbol) =>
  !s.has_body && s.kind === 'function' && /\.(?:c|cc|cpp|cxx)$/i.test(s.file);

function fileDir(file: string) {
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '.' : file.slice(0, slash) || '/';
}

function symbolsByKey(index: CodeIndex, changed: Set<string>) {
  const groups = new Map<string, CodeSymbol[]>();
  for (const symbol of index.symbols) {
    if (!changed.has(symbol.file) || implementationDeclaration(symbol)) continue;
    const key = structureSymbolKey(symbol);
    const group = groups.get(key);
    if (group) group.push(symbol);
    else groups.set(key, [symbol]);
  }
  return groups;
}

function callFacts(index: CodeIndex, changed: Set<string>) {
  const symbols = new Map(index.symbols.map(symbol => [symbol.id, symbol]));
  const incoming = new Map<string, HudExternalCaller[]>();
  const edges = new Map<string, HudCallChange>();
  for (const call of index.calls) {
    const caller = symbols.get(call.caller_id)!;
    for (const targetId of call.target_ids) {
      const target = symbols.get(targetId)!;
      if (caller.file === target.file) continue;
      if (!changed.has(call.file) && changed.has(target.file)) {
        const sites = incoming.get(targetId) ?? [];
        if (sites.length < 15 && !sites.some(s => s.caller_symbol === caller.qualified_name &&
            s.caller_file === call.file && s.caller_line === call.line)) {
          sites.push({
            caller_symbol: caller.qualified_name, caller_file: call.file, caller_line: call.line,
            target_symbol: target.qualified_name, target_file: target.file, target_line: target.start_line,
          });
          incoming.set(targetId, sites);
        }
      }
      // Overload candidates are useful for contract review, but do not establish a definite edge.
      if (call.target_ids.length !== 1 || (!changed.has(caller.file) && !changed.has(target.file))) continue;
      const key = structureSymbolKey(caller) + '\0' + structureSymbolKey(target);
      if (!edges.has(key)) edges.set(key, {
        caller_symbol: caller.qualified_name, caller_file: call.file, caller_line: call.line,
        callee_symbol: target.qualified_name, callee_file: target.file,
      });
    }
  }
  return {incoming, edges};
}

function symbolChange(before?: CodeSymbol, after?: CodeSymbol, sites?: HudExternalCaller[]): HudSymbolChange {
  const symbol = (after ?? before)!;
  return {
    symbol: symbol.qualified_name, kind: symbol.kind, file: symbol.file, line: symbol.start_line,
    public_entry: symbol.public_entry,
    ...(before && {before_signature: before.signature}),
    ...(after && {after_signature: after.signature}),
    ...(before && (symbol.public_entry || sites) && {unupdated_external_callers: sites ?? []}),
  };
}

function compareSymbols(before: CodeIndex, after: CodeIndex, changed: Set<string>,
    oldCalls: ReturnType<typeof callFacts>, newCalls: ReturnType<typeof callFacts>) {
  const oldGroups = symbolsByKey(before, changed);
  const newGroups = symbolsByKey(after, changed);
  const added_symbols: HudSymbolChange[] = [];
  const removed_symbols: HudSymbolChange[] = [];
  const signature_changed_symbols: HudSymbolChange[] = [];
  for (const key of new Set([...oldGroups.keys(), ...newGroups.keys()])) {
    // An overload group may contain several declarations with the same qualified name.
    // Match identical signatures first so reordering them or shifting lines is harmless.
    const added = [...(newGroups.get(key) ?? [])];
    const removed = (oldGroups.get(key) ?? []).filter(old => {
      const match = added.findIndex(next => normalizeSignature(old) === normalizeSignature(next));
      if (match === -1) return true;
      added.splice(match, 1);
      return false;
    });
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const old = removed[i], next = added[i];
      if (old && next) {
        signature_changed_symbols.push(symbolChange(old, next, newCalls.incoming.get(next.id)));
      } else if (old) {
        removed_symbols.push(symbolChange(old, undefined, oldCalls.incoming.get(old.id)));
      } else {
        added_symbols.push(symbolChange(undefined, next));
      }
    }
  }
  return {added_symbols, removed_symbols, signature_changed_symbols};
}

function shortestPath(graph: Map<string, string[]>, start: string, end: string): string[] | undefined {
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (node === end) {
      const path = [];
      for (let at: string | null = end; at !== null; at = parent.get(at)!) path.push(at);
      return path.reverse();
    }
    for (const next of graph.get(node) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, node);
      queue.push(next);
    }
  }
}

function moduleChanges(before: CodeIndex, after: CodeIndex, changedDirs: Set<string>) {
  const edgeKey = (edge: {from: string; to: string}) => edge.from + '\0' + edge.to;
  const old = new Map(before.module_edges.map(e => [edgeKey(e), e]));
  const next = new Map(after.module_edges.map(e => [edgeKey(e), e]));
  const graph = new Map<string, string[]>();
  for (const {from, to} of after.module_edges) {
    const links = graph.get(from);
    if (links) links.push(to);
    else graph.set(from, [to]);
  }
  const added_module_edges: HudModuleEdgeChange[] = [];
  const removed_module_edges: HudModuleEdgeChange[] = [];
  const new_cycles: string[][] = [];
  const seen = new Set<string>();
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const previous = old.get(key), current = next.get(key);
    const {from, to} = (current ?? previous)!;
    if (!changedDirs.has(from) && !changedDirs.has(to)) continue;
    const before_count = previous?.count ?? 0, after_count = current?.count ?? 0;
    if (after_count === before_count) continue;
    const changes = after_count > before_count ? added_module_edges : removed_module_edges;
    changes.push({from, to, before_count, after_count});
    // Every cycle containing an absent-before edge is new. A count increase alone cannot add a cycle.
    if (previous || !current || new_cycles.length === 8) continue;
    const path = shortestPath(graph, to, from);
    if (!path) continue;
    const first = path.reduce((min, node, i) => node < path[min] ? i : min, 0);
    const cycleKey = [...path.slice(first), ...path.slice(0, first)].join('\0');
    if (!seen.has(cycleKey)) {
      seen.add(cycleKey);
      new_cycles.push([from, ...path]);
    }
  }
  return {added_module_edges, removed_module_edges, new_cycles};
}

function sharedStateChanges(before: CodeIndex, after: CodeIndex, changed: Set<string>, changedDirs: Set<string>): HudSharedStateChange[] {
  const byKey = (index: CodeIndex) => new Map(index.shared_states.map(s => [s.file + '\0' + s.name, s]));
  const old = byKey(before), next = byKey(after);
  const changes: HudSharedStateChange[] = [];
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const previous = old.get(key), current = next.get(key);
    const {name, file} = (current ?? previous)!;
    const relevant = (dir: string) => changed.has(file) || changedDirs.has(dir);
    const added_dirs = (current?.access_dirs ?? []).filter(dir => relevant(dir) && !previous?.access_dirs.includes(dir));
    const removed_dirs = (previous?.access_dirs ?? []).filter(dir => relevant(dir) && !current?.access_dirs.includes(dir));
    if (!added_dirs.length && !removed_dirs.length) continue;
    changes.push({name, file, added_dirs, removed_dirs});
  }
  return changes;
}

export function computeStructureDiff(beforeIndex: CodeIndex, afterIndex: CodeIndex,
    scopeFiles: readonly string[], changedFiles: readonly string[]): TaskHudStructureDiff {
  const normalize = (path: string) => path.replaceAll('\\', '/');
  const changed = new Set(changedFiles.map(normalize)), scope = new Set(scopeFiles.map(normalize));
  const changedDirs = new Set([...changed].map(fileDir));
  const oldCalls = callFacts(beforeIndex, changed), newCalls = callFacts(afterIndex, changed);
  const edgeDifference = (a: Map<string, HudCallChange>, b: Map<string, HudCallChange>) =>
    [...a].filter(([key]) => !b.has(key)).slice(0, 40).map(([, call]) => call);
  return {
    changed_files: [...changed],
    scope_declared: scope.size > 0,
    out_of_scope_files: scope.size > 0 ? [...changed].filter(file => !scope.has(file)) : [],
    ...compareSymbols(beforeIndex, afterIndex, changed, oldCalls, newCalls),
    added_calls: edgeDifference(newCalls.edges, oldCalls.edges),
    removed_calls: edgeDifference(oldCalls.edges, newCalls.edges),
    ...moduleChanges(beforeIndex, afterIndex, changedDirs),
    shared_state_changes: sharedStateChanges(beforeIndex, afterIndex, changed, changedDirs),
  };
}

function symbolKey(file: string | null, symbol: string) {
  return file ? file + '::' + symbol : symbol;
}

function stripComments(code: string, file: string) {
  if (file.endsWith('.py')) {
    // Keep indentation and line breaks outside comments, and leave string contents intact.
    const parts = /("""(?:\\[\s\S]|(?!""")[^\\])*"""|'''(?:\\[\s\S]|(?!''')[^\\])*'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|^[ \t\f]*(?:#[^\n]*)?(?:\n|$)|[ \t\f]+(?=#|$)|#[^\n]*/gm;
    return code.replace(parts, (_, literal?: string) => literal ?? '').trimEnd();
  }
  // Collapse comments and whitespace together while preserving quoted text.
  const parts = /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|(?:\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\s)+/g;
  return code.replace(parts, (_, literal?: string) => literal ?? ' ').trim();
}

function symbolBody(symbol: CodeSymbol, lines: readonly string[] | undefined) {
  if (lines) return stripComments(lines.slice(symbol.start_line - 1, symbol.end_line).join('\n'), symbol.file);
}

function callableGroups(index: CodeIndex) {
  const groups = new Map<string, CodeSymbol[]>();
  for (const symbol of index.symbols) {
    if (symbol.kind === 'class' || symbol.kind === 'struct' || symbol.kind === 'interface' || implementationDeclaration(symbol)) continue;
    const key = symbolKey(symbol.file, symbol.qualified_name);
    const group = groups.get(key);
    if (group) group.push(symbol);
    else groups.set(key, [symbol]);
  }
  return groups;
}

function callableSymbols(groups: ReturnType<typeof callableGroups>, other: ReturnType<typeof callableGroups>) {
  const symbols = new Map<string, CodeSymbol>();
  const keys = new Map<string, string>();
  for (const [name, group] of groups) {
    const overloaded = group.length > 1 || (other.get(name)?.length ?? 0) > 1;
    for (const symbol of group) {
      const key = overloaded && symbol.language !== 'c' ? name + '::' + normalizeSignature(symbol) : name;
      keys.set(symbol.id, key);
      const current = symbols.get(key);
      if (!current || (!current.has_body && symbol.has_body)) symbols.set(key, symbol);
    }
  }
  return { symbols, keys };
}

function callGraphEdges(index: CodeIndex, keys: ReadonlyMap<string, string>, contractChanges: ReadonlySet<string>) {
  type Edge = Pick<WalkthroughDiffEdge, 'from_key' | 'to_key' | 'kind' | 'ast_confirmed'>;
  const pairs = new Map<string, Edge>();
  for (const call of index.calls) {
    const from = keys.get(call.caller_id);
    if (!from) continue;
    for (const id of call.target_ids) {
      const to = keys.get(id);
      if (!to || from === to || (call.target_ids.length !== 1 && !contractChanges.has(to))) continue;
      const key = from + '->' + to;
      const edge = pairs.get(key);
      const kind = call.syntax === 'reference' ? 'reference' : 'sync_call';
      const ast_confirmed = call.target_ids.length === 1;
      if (!edge || (edge.kind === 'reference' && kind === 'sync_call') ||
          (edge.kind === kind && ast_confirmed && !edge.ast_confirmed)) {
        pairs.set(key, { from_key: from, to_key: to, kind, ast_confirmed });
      }
    }
  }
  return new Map([...pairs].map(([key, edge]) => [edge.kind === 'reference' ? key + ':reference' : key, edge]));
}

export function computeAstCallGraphDiff(options: {
  beforeIndex: CodeIndex;
  afterIndex: CodeIndex;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  changedFiles: readonly string[];
  focusFiles?: readonly string[];
  beforeSources?: ReadonlyMap<string, string>;
  afterSources?: ReadonlyMap<string, string>;
}): AstCallGraphDiff | undefined {
  const changed = new Set(options.changedFiles.map(file => file.replaceAll('\\', '/')));
  if (!changed.size) return;
  const focusSet = options.focusFiles?.length ? new Set(options.focusFiles.map(file => file.replaceAll('\\', '/'))) : changed;

  const beforeGroups = callableGroups(options.beforeIndex), afterGroups = callableGroups(options.afterIndex);
  const before = callableSymbols(beforeGroups, afterGroups), after = callableSymbols(afterGroups, beforeGroups);
  const symbols = new Map([...before.symbols, ...after.symbols]);
  const sourceLines = (sources?: ReadonlyMap<string, string>) => new Map([...sources ?? []]
    .filter(([file]) => changed.has(file)).map(([file, source]) => [file, source.split(/\r\n|\n|\r/)]));
  const beforeLines = sourceLines(options.beforeSources), afterLines = sourceLines(options.afterSources);
  const statuses = new Map<string, DiffStatus>();
  const contractChanges = new Set<string>();
  const prioritySeeds: string[] = [], bodySeeds: string[] = [];
  for (const [key, symbol] of symbols) {
    if (!changed.has(symbol.file)) continue;
    const old = before.symbols.get(key), next = after.symbols.get(key);
    const signatureChanged = !!old && !!next && normalizeSignature(old) !== normalizeSignature(next);
    if (!next || signatureChanged) contractChanges.add(key);
    if (!old || !next || signatureChanged) {
      statuses.set(key, !old ? 'added' : !next ? 'removed' : 'modified');
      if (focusSet.has(symbol.file)) prioritySeeds.push(key);
      continue;
    }
    const oldBody = symbolBody(old, beforeLines.get(symbol.file));
    if (oldBody !== undefined && oldBody === symbolBody(next, afterLines.get(symbol.file))) {
      statuses.set(key, 'unchanged');
    } else {
      statuses.set(key, 'modified');
      if (focusSet.has(symbol.file)) bodySeeds.push(key);
    }
  }
  const seedCandidates = [...prioritySeeds, ...bodySeeds];
  const seeds = seedCandidates.slice(0, 14);
  if (!seeds.length) return;
  const selectedSeeds = new Set(seeds);
  const omittedSeeds = new Set(seedCandidates.slice(seeds.length));

  const beforeEdges = callGraphEdges(options.beforeIndex, before.keys, contractChanges);
  const afterEdges = callGraphEdges(options.afterIndex, after.keys, contractChanges);
  const allEdges = new Map([...beforeEdges, ...afterEdges]);
  const internal = new Set<string>();
  const external = new Map<string, number>();
  for (const [key, { from_key: from, to_key: to }] of allEdges) {
    const fromSeed = selectedSeeds.has(from), toSeed = selectedSeeds.has(to);
    if (fromSeed === toSeed) continue;
    const neighbor = fromSeed ? to : from;
    if (changed.has(symbols.get(neighbor)!.file)) {
      if (internal.size < 6 && !omittedSeeds.has(neighbor)) internal.add(neighbor);
    } else {
      const edgeChanged = beforeEdges.has(key) !== afterEdges.has(key);
      const priority = !fromSeed && contractChanges.has(to) ? 0 : edgeChanged ? 1 : 2;
      external.set(neighbor, Math.min(external.get(neighbor) ?? priority, priority));
    }
  }
  const maxNeighbors = 8;
  const neighbors = [...external.keys()].sort((a, b) => external.get(a)! - external.get(b)!).slice(0, maxNeighbors);
  const included = new Set([...seeds, ...internal, ...neighbors]);
  const participants = [...included].map((key): WalkthroughDiffNode => {
    const symbol = symbols.get(key)!;
    const old = before.symbols.get(key), next = after.symbols.get(key);
    const status = statuses.get(key) ?? 'unchanged';
    const signature = normalizeSignature(symbol);
    const description = signature.length > 64 ? signature.slice(0, 63).trimEnd() + '…'
      : signature || (symbol.public_entry ? '公开入口' : '内部函数');
    return {
      key, status, symbol: symbol.qualified_name, label: symbol.name, description, file: symbol.file,
      before_node_id: undefined, after_node_id: undefined, before_line: old?.start_line, after_line: next?.start_line,
      before_editor_line: old?.start_line, after_editor_line: next?.start_line,
      before_signature: old?.signature, after_signature: next?.signature, code_changed: status !== 'unchanged',
    };
  });

  const edges: WalkthroughDiffEdge[] = [];
  const incoming = new Set<string>();
  for (const [key, { from_key, to_key, kind, ast_confirmed }] of allEdges) {
    if (!included.has(from_key) || !included.has(to_key)) continue;
    const fromFile = symbols.get(from_key)!.file;
    const crossFile = fromFile !== symbols.get(to_key)!.file;
    const status = !beforeEdges.has(key) ? 'added' : !afterEdges.has(key) ? 'removed' : 'unchanged';
    const edge: WalkthroughDiffEdge = { key, status, from_key, to_key, kind, ast_confirmed };
    const reference = kind === 'reference';
    const action = reference ? '回调引用' : '调用';
    if (!ast_confirmed) {
      const label = '候选未同步' + action;
      if (status === 'removed') edge.before_label = label;
      else edge.after_label = label;
    } else if (status === 'added') edge.after_label = crossFile && !reference ? '跨文件新增' : '新增' + action;
    else if (status === 'removed') edge.before_label = crossFile && !reference ? '跨文件移除' : '移除' + action;
    else if (!changed.has(fromFile) && contractChanges.has(to_key)) edge.after_label = '未同步' + action;
    else edge.after_label = crossFile ? '跨文件' + action : action;
    edges.push(edge);
    incoming.add(to_key);
  }
  const entry = neighbors.find(key => !incoming.has(key)) ?? participants.find(node => !incoming.has(node.key))?.key ?? seeds[0];
  const count = (rows: { status: DiffStatus }[], status: DiffStatus) => rows.filter(row => row.status === status).length;
  return {
    before_snapshot_id: options.beforeSnapshotId,
    after_snapshot_id: options.afterSnapshotId,
    omitted_changes: omittedSeeds.size,
    omitted_neighbors: external.size - neighbors.length,
    path: {
      path_key: entry, label: '本地 AST 调用图', entry_symbol: symbols.get(entry)!.qualified_name,
      status: 'modified', participants, edges, steps: [],
      counts: {
        added_nodes: count(participants, 'added'), removed_nodes: count(participants, 'removed'),
        modified_nodes: count(participants, 'modified'), added_edges: count(edges, 'added'), removed_edges: count(edges, 'removed'),
        added_steps: 0, removed_steps: 0, modified_steps: 0, noise_count: 0,
      },
    },
  };
}

function sourceFacts(snapshot?: Snapshot, index?: CodeIndex, sources?: ReadonlyMap<string, string>) {
  const hashes = snapshot && new Map(snapshot.files.map(file => [file.path, file.content_sha256]));
  if (!index) return { hashes };

  const symbols = new Map<string, CodeSymbol | null>();
  const ids = new Map(index.symbols.map(symbol => [symbol.id, symbol]));
  const calls = new Set<string>();
  const names = new Map<string, Set<string>>();
  for (const symbol of index.symbols) {
    const qualified = symbolKey(symbol.file, symbol.qualified_name);
    symbols.set(qualified, symbols.has(qualified) ? null : symbol);
    const key = symbolKey(symbol.file, symbol.name);
    if (!names.has(key)) names.set(key, new Set());
    names.get(key)!.add(qualified);
  }
  // Resolve a short walkthrough spelling only when it identifies one qualified symbol in its file.
  const aliases = new Map<string, string>();
  for (const [short, qualified] of names) {
    if (qualified.size === 1 && !symbols.has(short)) aliases.set(short, [...qualified][0]);
  }
  for (const call of index.calls) {
    const caller = ids.get(call.caller_id)!;
    const from = symbolKey(caller.file, caller.qualified_name);
    for (const targetId of call.target_ids) {
      const target = ids.get(targetId)!;
      calls.add(from + '\0' + symbolKey(target.file, target.qualified_name));
    }
  }
  const resolve = (key: string) => aliases.get(key) ?? key;
  return {
    hashes,
    resolve,
    hasSymbol: (key: string) => symbols.has(resolve(key)),
    hasCall: (from: string, to: string) => calls.has(resolve(from) + '\0' + resolve(to)),
    body(key: string) {
      const symbol = symbols.get(resolve(key));
      if (!symbol) return;
      const source = sources?.get(symbol.file);
      if (source === undefined) return;
      return symbolBody(symbol, source.split(/\r\n|\n|\r/));
    },
  };
}

function codeChanges(before: ReturnType<typeof sourceFacts>, after: ReturnType<typeof sourceFacts>) {
  function fileChanged(file: string | null) {
    if (!file || !before.hashes || !after.hashes) return true;
    const oldHash = before.hashes.get(file);
    return oldHash === undefined || oldHash !== after.hashes.get(file);
  }
  return {
    fileChanged,
    bodyUnchanged(key: string) {
      if (before.resolve?.(key) !== after.resolve?.(key)) return false;
      const old = before.body?.(key);
      return old !== undefined && old === after.body?.(key);
    },
    symbolChanged: (key: string) => !!before.hasSymbol && !!after.hasSymbol && before.hasSymbol(key) !== after.hasSymbol(key),
    callChanged(from: string | null, to: string | null, added: boolean) {
      if (!from || !to || !before.hasCall || !after.hasCall) return false;
      const was = before.hasCall(from, to);
      const now = after.hasCall(from, to);
      return added ? now && !was : was && !now;
    },
  };
}

function evidenceLocation(evidence?: SourceEvidence): EvidenceLocation | undefined {
  if (!evidence) return;
  const { path, line_start, line_end } = evidence;
  return { path, line_start, line_end };
}

function walkthroughPaths(result: AnalysisResult) {
  const evidence = new Map(result.evidence.map(item => [item.evidence_id, item]));
  const nodes = new Map(result.nodes.filter(node => node.kind === 'function').map(node => {
    const details = node.function_details;
    const reference = details && evidence.get(details.definition_evidence_id);
    const definition = reference ?? evidence.get(node.evidence_ids[0]);
    const file = definition?.path ?? null;
    const symbol = details?.symbol || node.label;
    return [node.node_id, {
      key: symbolKey(file, symbol), file, symbol, label: node.label, description: node.description,
      id: node.node_id, line: definition?.line_start, signature: details?.signature,
      editorLine: reference?.role === 'definition' || reference?.role === 'declaration' ? reference.line_start : undefined,
    }];
  }));
  return (result.function_walkthroughs ?? []).map(path => {
    const entry = nodes.get(path.entry_node_id)!;
    const participants = new Map([[entry.key, entry]]);
    const steps = path.steps.map((step, index) => {
      const from = step.from_node_id === null ? null : nodes.get(step.from_node_id)!;
      const to = nodes.get(step.to_node_id)!;
      if (from) participants.set(from.key, from);
      participants.set(to.key, to);
      const anchors = step.evidence_ids.map(id => evidence.get(id)!);
      const files = [...(from ? [from.file] : []), to.file, ...anchors.map(anchor => anchor.path)];
      return {
        ...step, index, from, to, key: (from?.key ?? '') + '->' + to.key + ':' + step.kind,
        evidence: evidenceLocation(anchors[0]), files,
      };
    });
    const edges = new Map<string, Pick<WalkthroughDiffEdge, 'key' | 'from_key' | 'to_key' | 'kind'> & { label: string }>();
    for (const edge of result.edges) {
      if (edge.kind !== 'sync_call' && edge.kind !== 'execution_boundary') continue;
      const from = nodes.get(edge.source_node_id);
      const to = nodes.get(edge.target_node_id);
      if (!from || !to || !participants.has(from.key) || !participants.has(to.key)) continue;
      const key = from.key + '->' + to.key + ':' + edge.kind;
      edges.set(key, { key, from_key: from.key, to_key: to.key, kind: edge.kind, label: edge.label });
    }
    return { id: path.id, label: path.label, entry, participants, edges, steps };
  });
}

type Path = ReturnType<typeof walkthroughPaths>[number];
type Step = Path['steps'][number];
type Changes = ReturnType<typeof codeChanges>;
const pathLabel = (path: { label: string }) => path.label.trim().replace(/\s+/g, ' ').toLowerCase();

function diffNodes(before: Path | undefined, after: Path | undefined, changes: Changes) {
  const rows: WalkthroughDiffNode[] = [];
  const nodes = new Map([...before?.participants ?? [], ...after?.participants ?? []]);
  for (const [key, node] of nodes) {
    const old = before?.participants.get(key);
    const next = after?.participants.get(key);
    const fileChanged = changes.fileChanged(node.file);
    const changed = old && next
      ? old.signature !== next.signature || (fileChanged && !changes.bodyUnchanged(key))
      : fileChanged || changes.symbolChanged(key);
    const status = old && next ? (changed ? 'modified' : 'unchanged') : !changed ? 'noise' : next ? 'added' : 'removed';
    rows.push({
      key, status, symbol: node.symbol, file: node.file, label: node.label, description: node.description,
      before_node_id: old?.id, after_node_id: next?.id, before_line: old?.line, after_line: next?.line,
      before_editor_line: old?.editorLine, after_editor_line: next?.editorLine,
      before_signature: old?.signature, after_signature: next?.signature, code_changed: changed,
    });
  }
  return rows;
}

function diffEdges(before: Path | undefined, after: Path | undefined, changes: Changes) {
  const rows: WalkthroughDiffEdge[] = [];
  const edges = new Map([...before?.edges ?? [], ...after?.edges ?? []]);
  for (const [key, edge] of edges) {
    const old = before?.edges.get(key);
    const next = after?.edges.get(key);
    const path = next ? after! : before!;
    const ast = !(old && next) && changes.callChanged(edge.from_key, edge.to_key, !!next);
    const changed = ast || changes.fileChanged(path.participants.get(edge.from_key)!.file) ||
      changes.fileChanged(path.participants.get(edge.to_key)!.file);
    rows.push({
      key, status: old && next ? 'unchanged' : !changed ? 'noise' : next ? 'added' : 'removed',
      from_key: edge.from_key, to_key: edge.to_key, kind: edge.kind,
      before_label: old?.label, after_label: next?.label, ast_confirmed: ast,
    });
  }
  return rows;
}

// The suffix LCS table keeps repeated calls distinct and preserves the order of both paths.
function alignSteps(before: Step[], after: Step[]) {
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i][j] = before[i].key === after[j].key ? 1 + lengths[i + 1][j + 1] :
        Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const pairs: { old?: Step; next?: Step }[] = [];
  let oldStart = 0;
  let newStart = 0;
  function appendGap(oldEnd: number, newEnd: number) {
    // Between LCS anchors a single replacement at identical endpoints can change the call kind.
    if (oldEnd - oldStart === 1 && newEnd - newStart === 1) {
      const old = before[oldStart], next = after[newStart];
      if (old.from?.key === next.from?.key && old.to.key === next.to.key && old.kind !== next.kind) {
        pairs.push({old, next});
        return;
      }
    }
    for (let pos = oldStart; pos < oldEnd; pos++) pairs.push({old: before[pos]});
    for (let pos = newStart; pos < newEnd; pos++) pairs.push({next: after[pos]});
  }
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i].key === after[j].key) {
      appendGap(i, j);
      pairs.push({ old: before[i++], next: after[j++] });
      oldStart = i;
      newStart = j;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  appendGap(before.length, after.length);
  return pairs;
}

function diffSteps(before: Path | undefined, after: Path | undefined, changes: Changes) {
  return alignSteps(before?.steps ?? [], after?.steps ?? []).map(({ old, next }, index): WalkthroughDiffStep => {
    const step = next ?? old!;
    const from = step.from?.key ?? null;
    const to = step.to.key;
    const reasons: WalkthroughDiffStep['diff_reasons'] = [];
    const changedFiles = (old?.files ?? []).concat(next?.files ?? []).filter(changes.fileChanged);
    let changed = changedFiles.length > 0;
    let status: DiffStatus;
    if (old && next) {
      if (changed) {
        const endpoints = [old.from, old.to, next.from, next.to].filter(node => node !== null);
        changed = changedFiles.some(file => !endpoints.some(node => node.file === file)) ||
          endpoints.some(node => changes.fileChanged(node.file) && !changes.bodyUnchanged(node.key));
      }
      if (old.condition.trim() !== next.condition.trim()) reasons.push('condition');
      if (old.kind !== next.kind) reasons.push('kind');
      if (old.input.trim() !== next.input.trim() || old.output.trim() !== next.output.trim()) reasons.push('io');
      if (old.text.trim() !== next.text.trim()) reasons.push('text');
      if (!reasons.length) status = 'unchanged';
      else status = changed || reasons.includes('condition') || reasons.includes('kind') ? 'modified' : 'noise';
    } else {
      if (step.kind === 'return') changed ||= changes.callChanged(to, from, !!next);
      else if (step.kind !== 'entry' && step.kind !== 'work') changed ||= changes.callChanged(from, to, !!next);
      status = !changed ? 'noise' : next ? 'added' : 'removed';
    }
    return {
      id: step.key + '#' + index, status, kind: step.kind, from_key: from, to_key: to,
      from_symbol: step.from?.symbol ?? '', to_symbol: step.to.symbol,
      before_step_id: old?.id, after_step_id: next?.id,
      before_index: old?.index, after_index: next?.index, before_text: old?.text, after_text: next?.text,
      before_condition: old?.condition, after_condition: next?.condition,
      before_input: old?.input, after_input: next?.input, before_output: old?.output, after_output: next?.output,
      before_evidence: old?.evidence, after_evidence: next?.evidence, diff_reasons: reasons, code_changed: changed,
    };
  });
}

function pathDiff(before: Path | undefined, after: Path | undefined, changes: Changes): WalkthroughPathDiff {
  const path = after ?? before!;
  const participants = diffNodes(before, after, changes);
  const edges = diffEdges(before, after, changes);
  const steps = diffSteps(before, after, changes);
  const count = (rows: { status: DiffStatus }[], status: DiffStatus) => rows.filter(row => row.status === status).length;
  const counts = {
    added_nodes: count(participants, 'added'), removed_nodes: count(participants, 'removed'), modified_nodes: count(participants, 'modified'),
    added_edges: count(edges, 'added'), removed_edges: count(edges, 'removed'),
    added_steps: count(steps, 'added'), removed_steps: count(steps, 'removed'), modified_steps: count(steps, 'modified'),
    noise_count: count(participants, 'noise') + count(edges, 'noise') + count(steps, 'noise'),
  };
  const modified = [...participants, ...edges, ...steps].some(row => row.status !== 'noise' && row.status !== 'unchanged');
  return {
    path_key: path.entry.key, label: path.label, entry_symbol: path.entry.symbol,
    status: !before ? 'added' : !after ? 'removed' : modified ? 'modified' : 'unchanged',
    before_path_id: before?.id, after_path_id: after?.id, participants, edges, steps, counts,
  };
}

export function computeWalkthroughDiff(options: {
  feature_id: string;
  scenario_id: string;
  feature_label: string;
  before: AnalysisResult;
  after: AnalysisResult;
  beforeSnapshot?: Snapshot;
  afterSnapshot?: Snapshot;
  beforeIndex?: CodeIndex;
  afterIndex?: CodeIndex;
  beforeSources?: ReadonlyMap<string, string>;
  afterSources?: ReadonlyMap<string, string>;
}): WalkthroughDiff {
  const { feature_id, scenario_id, feature_label, before, after } = options;
  const oldPaths = walkthroughPaths(before);
  const newPaths = walkthroughPaths(after);
  const changes = codeChanges(
    sourceFacts(options.beforeSnapshot, options.beforeIndex, options.beforeSources),
    sourceFacts(options.afterSnapshot, options.afterIndex, options.afterSources),
  );
  const remaining = new Set(oldPaths);
  const pairs = new Map<Path, Path>();

  // Allocate all entry matches before using labels, so an early fallback cannot steal a later exact match.
  for (const match of [
    (a: Path, b: Path) => a.entry.key === b.entry.key && pathLabel(a) === pathLabel(b),
    (a: Path, b: Path) => a.entry.key === b.entry.key,
    (a: Path, b: Path) => pathLabel(a) === pathLabel(b),
  ]) {
    for (const path of newPaths) {
      if (pairs.has(path)) continue;
      const old = [...remaining].find(candidate => match(candidate, path));
      if (old) {
        pairs.set(path, old);
        remaining.delete(old);
      }
    }
  }
  const paths = [
    ...newPaths.map(path => pathDiff(pairs.get(path), path, changes)),
    ...[...remaining].map(path => pathDiff(path, undefined, changes)),
  ];
  const entryCounts = new Map<string, number>();
  for (const path of paths) entryCounts.set(path.path_key, (entryCounts.get(path.path_key) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  for (const path of paths) {
    if (entryCounts.get(path.path_key)! > 1) path.path_key += '#' + pathLabel(path);
    const occurrence = occurrences.get(path.path_key) ?? 0;
    occurrences.set(path.path_key, occurrence + 1);
    if (occurrence) path.path_key += '#' + occurrence;
  }
  return {
    feature_id, scenario_id, feature_label, before_result_id: before.result_id, after_result_id: after.result_id,
    before_snapshot_id: before.binding.source_snapshot_id, after_snapshot_id: after.binding.source_snapshot_id, paths,
  };
}
