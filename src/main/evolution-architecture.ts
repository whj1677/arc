import path from 'node:path';
import type { TaskHudStructureDiff, WalkthroughDiffNode } from '../development-hud';
import type { EvolutionArchEdge, EvolutionArchModule, EvolutionArchSummary } from '../evolution-view';
import type { AnalysisResult } from '../shared';
import type { CodeIndex } from './code-index';

type Node = AnalysisResult['nodes'][number];
type Link = { from: string; to: string };
const layerNames = ['入口与交互层', '核心业务与控制层', '存储、队列与底层支撑'];

// The overview map assigns children their root's layer and classifies legacy entry stages by topology.
function overviewLayers(nodes: Map<string, Node>, links: Link[]) {
  const roots = new Map<string, string>();
  for (const node of nodes.values()) {
    let root = node;
    while (root.parent_node_id && nodes.has(root.parent_node_id)) root = nodes.get(root.parent_node_id)!;
    roots.set(node.node_id, root.node_id);
  }
  const incoming = new Map<string, Set<string>>(), outgoing = new Map<string, Set<string>>();
  for (const link of links) {
    const from = roots.get(link.from)!, to = roots.get(link.to)!;
    if (from === to) continue;
    if (!incoming.has(to)) incoming.set(to, new Set());
    if (!outgoing.has(from)) outgoing.set(from, new Set());
    incoming.get(to)!.add(from);
    outgoing.get(from)!.add(to);
  }
  const isBoundaryEntry = (id: string) => outgoing.has(id) || !incoming.has(id);
  const rootIds = new Set(roots.values());
  const explicitEntry = [...rootIds].some(id => nodes.get(id)!.kind === 'execution_boundary' && isBoundaryEntry(id));
  function isEntry(id: string) {
    const kind = nodes.get(id)!.kind;
    if (kind === 'execution_boundary') return isBoundaryEntry(id);
    if (kind !== 'stage' || explicitEntry || incoming.has(id) || !outgoing.size) return false;
    const targets = [...outgoing.get(id) ?? []].map(to => nodes.get(to)!.kind);
    return !(targets.includes('stage') && targets.includes('resource'));
  }
  return new Map([...roots].map(([id, root]) => {
    const kind = nodes.get(root)!.kind;
    const infrastructure = kind === 'resource' || (kind === 'execution_boundary' &&
      [...incoming.get(root) ?? []].every(from => !isEntry(from)));
    return [id, isEntry(root) ? 0 : infrastructure ? 2 : 1];
  }));
}

function moduleCard(id: string, label: string, layer: string, layer_order: number,
    source_kind: EvolutionArchModule['source_kind']): EvolutionArchModule {
  return { id, label, layer, layer_order, source_kind, relation: 'unchanged', files: [], changed_files: [],
    added_symbols: 0, removed_symbols: 0, modified_symbols: 0 };
}

function moduleCatalog(overview: AnalysisResult | undefined, indexedFiles: Set<string>, touched: Set<string>) {
  const modules = new Map<string, EvolutionArchModule>(), moduleByFile = new Map<string, string>();
  const links: Link[] = [];
  function attach(card: EvolutionArchModule, file: string) {
    card.files.push(file);
    if (touched.has(file)) {
      card.changed_files.push(file);
      card.relation = 'direct';
    }
  }
  if (overview?.architecture) {
    const byId = new Map(overview.nodes.map(node => [node.node_id, node]));
    const nodes = new Map(overview.architecture.node_ids.map(id => [id, byId.get(id)!]));
    const edgeIds = new Set(overview.architecture.edge_ids);
    for (const e of overview.edges) {
      if (edgeIds.has(e.edge_id) && nodes.has(e.source_node_id) && nodes.has(e.target_node_id))
        links.push({ from: e.source_node_id, to: e.target_node_id });
    }
    const layers = overviewLayers(nodes, links);
    const paths = new Map(overview.evidence.map(e => [e.evidence_id, e.path]));
    const exact = new Map<string, Set<string>>(), folders = new Map<string, Set<string>>();
    for (const node of nodes.values()) {
      const id = node.node_id, layer = layers.get(id)!;
      modules.set(id, { ...moduleCard(id, node.label, layerNames[layer], layer, 'overview_node'), summary: node.description });
      const files = new Set(node.evidence_ids.map(ref => paths.get(ref)!));
      const scope = node.source_scope;
      if (scope?.kind === 'file') files.add(scope.path);
      if (scope?.kind === 'folder') {
        if (!folders.has(scope.path)) folders.set(scope.path, new Set());
        folders.get(scope.path)!.add(id);
      }
      for (const file of files) {
        indexedFiles.add(file);
        if (!exact.has(file)) exact.set(file, new Set());
        exact.get(file)!.add(id);
      }
    }
    for (const file of indexedFiles) {
      // Keep all explicitly impacted modules, but only attribute a call to a unique owner.
      // A precise file reference takes precedence over the enclosing folder.
      const covered = new Set(exact.get(file));
      let owners = exact.get(file);
      let dir = path.posix.dirname(file);
      for (;;) {
        const scope = folders.get(dir);
        if (!owners && scope) owners = scope;
        if (scope) for (const id of scope) covered.add(id);
        if (dir === '.') break;
        dir = path.posix.dirname(dir);
      }
      for (const id of covered) attach(modules.get(id)!, file);
      if (owners?.size === 1) moduleByFile.set(file, [...owners][0]);
    }
  } else {
    for (const file of indexedFiles) {
      const id = path.posix.dirname(file);
      if (!modules.has(id)) modules.set(id, moduleCard(id, id, '目录', 0, 'directory_fallback'));
      moduleByFile.set(file, id);
      attach(modules.get(id)!, file);
    }
  }
  return { modules, moduleByFile, links };
}

type Count = Link & { count: number; sample?: EvolutionArchEdge['sample_call'] };
function edgeCounts(index: CodeIndex | undefined, moduleByFile: Map<string, string>, directoryMode: boolean) {
  const counts = new Map<string, Count>();
  if (!index) return counts;
  function add(from: string, to: string, count: number, sample?: Count['sample']) {
    if (from === to) return;
    const id = from + '\0' + to;
    const previous = counts.get(id);
    if (previous) {
      previous.count += count;
      previous.sample ??= sample;
    } else counts.set(id, { from, to, count, sample });
  }
  const symbols = new Map(index.symbols.map(s => [s.id, s]));
  for (const call of index.calls) {
    const from = moduleByFile.get(call.file);
    if (from === undefined || !call.target_ids.length) continue;
    const targets = call.target_ids.map(id => symbols.get(id)!);
    const to = moduleByFile.get(targets[0].file);
    if (to === undefined || !targets.every(s => moduleByFile.get(s.file) === to)) continue;
    const name = targets[0].qualified_name;
    add(from, to, 1, {
      file: call.file, line: call.line, caller_symbol: symbols.get(call.caller_id)!.qualified_name,
      callee_symbol: targets.every(s => s.qualified_name === name) ? name : call.callee_name,
    });
  }
  if (directoryMode && index.module_edges.length) {
    // These are already counted in directory space, including multi-target calls.
    return new Map(index.module_edges.map(({ from, to, count }) => {
      const id = from + '\0' + to;
      return [id, { from, to, count, sample: counts.get(id)?.sample }];
    }));
  }
  if (!index.calls.length && index.module_edges.length) {
    // A directory aggregate can represent an overview edge only if all its files have the same owner.
    const dirs = new Map<string, Set<string | undefined>>();
    for (const file of index.files) {
      const dir = path.posix.dirname(file);
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir)!.add(moduleByFile.get(file));
    }
    for (const edge of index.module_edges) {
      const from = dirs.get(edge.from), to = dirs.get(edge.to);
      if (from?.size !== 1 || to?.size !== 1) continue;
      const [a] = from, [b] = to;
      if (a !== undefined && b !== undefined) add(a, b, edge.count);
    }
  }
  return counts;
}

export function projectEvolutionArchitecture(input: {
  overview?: AnalysisResult; beforeIndex?: CodeIndex; afterIndex?: CodeIndex; files: readonly string[];
  structure?: TaskHudStructureDiff; changedSymbols?: readonly WalkthroughDiffNode[];
}) {
  const { overview, beforeIndex, afterIndex, structure, changedSymbols } = input;
  const files = new Set([...beforeIndex?.files ?? [], ...afterIndex?.files ?? [], ...input.files]);
  const { modules, moduleByFile, links } = moduleCatalog(overview, files, new Set(input.files));
  function increment(file: string, field: 'added_symbols' | 'removed_symbols' | 'modified_symbols') {
    const owner = moduleByFile.get(file);
    if (owner !== undefined) modules.get(owner)![field]++;
  }
  for (const s of structure?.added_symbols ?? []) increment(s.file, 'added_symbols');
  for (const s of structure?.removed_symbols ?? []) increment(s.file, 'removed_symbols');
  const modified = new Set<string>();
  for (const s of structure?.signature_changed_symbols ?? []) {
    increment(s.file, 'modified_symbols');
    modified.add([s.file, s.symbol, s.line].join('\0'));
  }
  for (const s of changedSymbols ?? []) {
    if (s.status === 'modified' && s.file && !modified.has([s.file, s.symbol, s.after_line].join('\0')))
      increment(s.file, 'modified_symbols');
  }

  const directoryMode = !overview?.architecture;
  const before = edgeCounts(beforeIndex ?? afterIndex, moduleByFile, directoryMode);
  const after = beforeIndex && afterIndex ? edgeCounts(afterIndex, moduleByFile, directoryMode) : before;
  const edges: EvolutionArchEdge[] = [];
  const changedEnds = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id), next = after.get(id), { from, to } = (next ?? old)!;
    const a = modules.get(from)!, b = modules.get(to)!;
    const before_count = old?.count ?? 0, after_count = next?.count ?? 0;
    const cross_layer = a.layer_order !== b.layer_order;
    const kind = before_count === 0 ? (cross_layer ? 'new_cross_layer' : 'new_same_layer') :
      after_count === 0 ? 'removed' : after_count > before_count ? 'strengthened' : 'existing';
    edges.push({ id: JSON.stringify([from, to]), from_id: from, to_id: to, from_label: a.label, to_label: b.label,
      cross_layer, kind, before_count, after_count, sample_call: (next ?? old)!.sample });
    if (before_count !== after_count) { changedEnds.add(from); changedEnds.add(to); }
    links.push({ from, to });
  }
  const all = [...modules.values()];
  const priority = [...all.filter(m => m.relation === 'direct'), ...all.filter(m => m.relation !== 'direct' && changedEnds.has(m.id))];
  const focus = all.length <= 8 ? priority : priority.slice(0, 6);
  const focusIds = new Set(focus.map(m => m.id));
  const neighbors = new Set<string>();
  for (const { from, to } of links) {
    if (focusIds.has(from)) neighbors.add(to);
    if (focusIds.has(to)) neighbors.add(from);
  }
  for (const m of all) if (m.relation !== 'direct' && (neighbors.has(m.id) || changedEnds.has(m.id))) m.relation = 'neighbor';
  const otherNeighbors = all.filter(m => m.relation === 'neighbor' && !focusIds.has(m.id) && neighbors.has(m.id))
    .sort((a, b) => Number(changedEnds.has(b.id)) - Number(changedEnds.has(a.id)));
  const visible = all.length <= 8 ? all : [...focus, ...otherNeighbors.slice(0, 2)];
  if (directoryMode && all.length > 8 && visible.length < 8) {
    const chosen = new Set(visible);
    visible.push(...all.filter(m => !chosen.has(m)).slice(0, 8 - visible.length));
  }
  const visibleIds = new Set(visible.map(m => m.id));
  const architecture: EvolutionArchSummary = {
    mode: overview?.architecture ? 'overview' : all.length ? 'directory_fallback' : 'empty',
    architecture_result_id: overview?.architecture ? overview.result_id : undefined,
    modules: visible.sort((a, b) => a.layer_order - b.layer_order), all_modules_count: all.length,
    omitted_modules: all.length - visible.length, edges: edges.filter(e => visibleIds.has(e.from_id) && visibleIds.has(e.to_id)),
    new_cycles: structure?.new_cycles ?? [],
  };
  return { architecture, moduleByFile, newCrossLayerEdges: edges.filter(e => e.kind === 'new_cross_layer') };
}
