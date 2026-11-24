import { architectureDocumentToAnalysisResult, type ArchitectureDocument, type ArchitectureModule, type ArchitectureRelation } from '../architecture-workspace';
import { architectureMap, architectureMapScope } from '../ui/architecture-map';
import { cubicPoint, overlaps, type Point, type Rect } from '../ui/flow-layout';
import { arrowColors, escapeXml, finishDiagram, svgText, svgTextWidth, wrapSvgLines } from './svg-common';

export * from './svg-common';
export * from './feature-svg';

export interface SubgraphOptions { includeChildren?: boolean; includeNeighbors?: boolean }
interface ArchitectureScope {
  includedModules: ArchitectureModule[];
  internalRelations: ArchitectureRelation[];
  hiddenExcludedCount: number;
}
export interface SubgraphPreview extends ArchitectureScope {
  externalInbound: ArchitectureRelation[];
  externalOutbound: ArchitectureRelation[];
}

function limitDocument(doc: ArchitectureDocument, moduleIds: readonly string[] | undefined) {
  if (!moduleIds) return doc;
  const ids = new Set(moduleIds);
  return { ...doc, modules: doc.modules.filter(m => ids.has(m.id)), relations: doc.relations.filter(r => ids.has(r.from) && ids.has(r.to)) };
}

export function computeArchitectureScope(doc: ArchitectureDocument, search = '', scopeModuleIds?: readonly string[]): ArchitectureScope {
  const scoped = limitDocument(doc, scopeModuleIds);
  const { nodes, edges } = architectureMapScope(architectureDocumentToAnalysisResult(scoped), search);
  const ids = new Set(nodes.map(n => n.node_id)), edgeIds = new Set(edges.map(e => e.edge_id));
  let hiddenExcludedCount = 0;
  if (scoped.modules.some(m => m.hidden) || scoped.relations.some(r => r.hidden)) {
    const all = architectureMapScope(architectureDocumentToAnalysisResult(scoped, undefined, { includeHidden: true }), search);
    const hidden = new Set(scoped.modules.filter(m => m.hidden).map(m => m.id));
    const hiddenEdges = new Set(scoped.relations.filter(r => r.hidden || hidden.has(r.from) || hidden.has(r.to)).map(r => r.id));
    hiddenExcludedCount = all.nodes.filter(n => hidden.has(n.node_id)).length + all.edges.filter(e => hiddenEdges.has(e.edge_id)).length;
  }
  return { includedModules: scoped.modules.filter(m => ids.has(m.id)), internalRelations: scoped.relations.filter(r => edgeIds.has(r.id)), hiddenExcludedCount };
}

function collectSubgraph(root: string, modules: ArchitectureModule[], relations: ArchitectureRelation[], opts: SubgraphOptions) {
  const available = new Set(modules.map(m => m.id));
  const ids = new Set([root]);
  if (opts.includeChildren !== false) {
    const children = new Map<string, string[]>();
    for (const m of modules) if (m.parent_id) {
      const siblings = children.get(m.parent_id) ?? [];
      siblings.push(m.id);
      children.set(m.parent_id, siblings);
    }
    for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child);
  }
  const edges = relations.filter(r => available.has(r.from) && available.has(r.to));
  if (opts.includeNeighbors) {
    const core = new Set(ids);
    for (const r of edges) {
      if (core.has(r.from)) ids.add(r.to);
      if (core.has(r.to)) ids.add(r.from);
    }
  }
  const includedModules = modules.filter(m => ids.has(m.id));
  const internalRelations = edges.filter(r => ids.has(r.from) && ids.has(r.to));
  const externalInbound = edges.filter(r => !ids.has(r.from) && ids.has(r.to));
  const externalOutbound = edges.filter(r => ids.has(r.from) && !ids.has(r.to));
  return { includedModules, internalRelations, externalInbound, externalOutbound };
}

export function computeModuleSubgraph(doc: ArchitectureDocument, rootModuleId: string, opts: SubgraphOptions = {}): SubgraphPreview {
  const visible = doc.modules.filter(m => !m.hidden);
  if (!visible.some(m => m.id === rootModuleId)) throw new Error('所选模块不在此版本的可见范围内');
  const scope = collectSubgraph(rootModuleId, visible, doc.relations.filter(r => !r.hidden), opts);
  const hidden = new Set(doc.modules.filter(m => m.hidden).map(m => m.id));
  let hiddenExcludedCount = 0;
  if (hidden.size || doc.relations.some(r => r.hidden)) {
    const all = collectSubgraph(rootModuleId, doc.modules, doc.relations, opts);
    const candidates = new Set(all.includedModules.map(m => m.id));
    for (const r of [...all.internalRelations, ...all.externalInbound, ...all.externalOutbound]) {
      candidates.add(r.from);
      candidates.add(r.to);
      if (r.hidden || hidden.has(r.from) || hidden.has(r.to)) hiddenExcludedCount++;
    }
    for (const id of candidates) if (hidden.has(id)) hiddenExcludedCount++;
  }
  return { ...scope, hiddenExcludedCount };
}

const statusNames = { up_to_date: '已分析至指定版本', changes_pending: '有变化待分析', updating: '更新中',
  needs_review: '需人工复核', update_failed: '更新失败', partial: '部分完成' };
export function architectureExportStatus(doc: ArchitectureDocument) {
  const pending = doc.review_items.filter(r => r.status === 'pending' || r.status === 'deferred').length;
  const stale = doc.last_update?.post_check_consistent === false || doc.pending_changes_summary?.detection_reliable === false;
  const state = doc.update_status === 'up_to_date' && stale ? 'changes_pending' : doc.update_status;
  const parts = [state === 'up_to_date' && !doc.baseline && !doc.last_update ? '尚无分析基线' : statusNames[state]];
  if (pending) {
    if (state === 'needs_review') parts[0] += `（${pending}项）`;
    else parts.push(`需人工复核（${pending}项）`);
  }
  return parts.join(' · ');
}

const roleNames = { stage: '模块', function: '函数', resource: '资源', decision: '决策', execution_boundary: '执行边界' };
const tierNames = { entry: '入口交互', core: '核心控制', foundation: '存储底层' };
const tierColor = { entry: '#286685', core: '#2e6d58', foundation: '#82612a' };
function cardContent(m: ArchitectureModule, width: number, degree: number, children: number) {
  let y = 24;
  const content: string[] = [];
  function block(value: string, size: number, step: number, color: string, weight = 400) {
    const lines = wrapSvgLines(value, width - 26, size);
    content.push(svgText(lines, 12, y, size, { lineHeight: step, color, weight }));
    y += lines.length * step;
  }
  block(tierNames[m.layer] + ' · ' + roleNames[m.kind], 12, 21, tierColor[m.layer], 600);
  block(m.name, 16, 23, '#182f3e', 700);
  if (m.summary) block(m.summary, 13, 19, '#425767');
  const tags: string[] = [];
  if (m.implementation_status === 'planned') tags.push('规划中');
  if (m.origin === 'manual' || m.origin === 'manual_override') tags.push('人工补充');
  if (m.origin === 'needs_verification' || m.implementation_status === 'needs_verification') tags.push('待核实');
  if (m.analysis_status === 'needs_review') tags.push('待复核');
  if (m.analysis_status === 'failed') tags.push('更新失败');
  if (m.analysis_status === 'updated') tags.push('已更新');
  let x = 12;
  for (const tag of tags) {
    const w = svgTextWidth(tag, 12) + 14;
    if (x + w > width - 10) { y += 23; x = 12; }
    content.push(`<rect x="${x}" y="${y - 14}" width="${w}" height="19" rx="5" fill="#fbefda"/>`, svgText([tag], x + 7, y, 12, { color: '#734917' }));
    x += w + 4;
  }
  if (tags.length) y += 23;
  block(`${degree} 关系 · ${children} 子模块`, 12, 17, '#4d6475');
  return { markup: content.join(''), height: y - 4 };
}

function rectMarkup(b: Rect, attrs: string) {
  return `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" ${attrs}/>`;
}
function boundsOf(rects: Rect[]): Rect {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const b of rects) {
    x = Math.min(x, b.x); y = Math.min(y, b.y);
    right = Math.max(right, b.x + b.width); bottom = Math.max(bottom, b.y + b.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

// All captions are visible on export. Find the nearest free vertical interval beside
// the route, accounting for multiline labels and every previously placed caption.
function placeCaption(center: Point, width: number, height: number, occupied: Rect[]) {
  let best: Rect | undefined, cost = Infinity;
  for (const dx of [0, -width / 2, width / 2]) {
    const x = center.x - width / 2 + dx;
    const blockers = occupied.filter(b => x < b.x + b.width + 6 && x + width + 6 > b.x);
    for (const y of [center.y - height / 2, ...blockers.flatMap(b => [b.y - 7 - height, b.y + b.height + 7])]) {
      const score = dx ** 2 + (y + height / 2 - center.y) ** 2;
      if (score >= cost) continue;
      const b = { x, y, width, height };
      if (blockers.some(o => overlaps(b, o, 5))) continue;
      best = b;
      cost = score;
    }
  }
  return best!; // The interval above the topmost obstacle is always available.
}

interface ArchitectureExportParams {
  doc: ArchitectureDocument; projectName: string; exportedAt?: string; columns?: number; includeHidden?: false;
}
interface ExportLink {
  relation: ArchitectureRelation; path: string; anchor: Point; preferred: Point; external?: boolean;
}

function renderScope(params: ArchitectureExportParams, scope: SubgraphPreview, scopeName: string) {
  const { doc } = params, { includedModules, internalRelations, externalInbound, externalOutbound } = scope;
  const visibleRelations = [...internalRelations, ...externalInbound, ...externalOutbound];
  const modules = new Map(doc.modules.map(m => [m.id, m]));
  const relationById = new Map(internalRelations.map(r => [r.id, r]));
  const degrees = new Map<string, number>(), children = new Map<string, number>();
  for (const r of visibleRelations) for (const id of new Set([r.from, r.to])) degrees.set(id, (degrees.get(id) ?? 0) + 1);
  for (const m of includedModules) if (m.parent_id) children.set(m.parent_id, (children.get(m.parent_id) ?? 0) + 1);
  const cards = new Map<string, ReturnType<typeof cardContent>>();
  const layout = architectureMap({ ...doc, modules: includedModules, relations: internalRelations }, '', params.columns, doc.layout.positions,
    (id, width) => {
      const card = cardContent(modules.get(id)!, width, degrees.get(id) ?? 0, children.get(id) ?? 0);
      cards.set(id, card);
      return card.height;
    });
  const regions: string[] = [], nodes: string[] = [], paths: string[] = [], captions: string[] = [];
  const occupied = [...layout.boxes.values()];
  const extents: Rect[] = [{ x: layout.minX, y: layout.minY, width: layout.width, height: layout.height }, ...occupied, ...layout.boundaries];
  const layerFills = { boundary: '#eaf2f7', core: '#eaf3ef', infrastructure: '#f6f2e9' };
  for (const l of layout.layers) {
    regions.push(rectMarkup(l, `rx="9" fill="${layerFills[l.id]}" stroke="#c8d5da"`));
    regions.push(svgText([l.title], l.x + 14, l.y + 25, 15, { weight: 700 }));
    occupied.push({ x: l.x + 8, y: l.y + 2, width: svgTextWidth(l.title, 15) + 16, height: 29 });
  }
  for (const b of layout.boundaries) regions.push(rectMarkup(b, `rx="8" fill="none" stroke="#86a39c" stroke-dasharray="4 3" data-parent-id="${escapeXml(b.id)}"`));
  for (const m of includedModules) {
    const box = layout.boxes.get(m.id)!;
    nodes.push(`<g data-component-id="${escapeXml(m.id)}">` + rectMarkup(box, `rx="8" fill="#ffffff" stroke="${tierColor[m.layer]}" stroke-width="1.5"${m.implementation_status === 'planned' ? ' stroke-dasharray="6 4"' : ''}`) +
      `<g transform="translate(${box.x} ${box.y})">${cards.get(m.id)!.markup}</g></g>`);
  }
  const links: ExportLink[] = layout.links.map(link => {
    for (const curve of link.curves) for (const p of curve) extents.push({ ...p, width: 0, height: 0 });
    return { relation: relationById.get(link.edge.edge_id)!, path: link.path, anchor: link.labelAnchor, preferred: link.labelPos };
  });
  const extent = boundsOf(extents);
  for (const [inbound, relations] of [[true, externalInbound], [false, externalOutbound]] as const) {
    let nextY = extent.y + 38;
    const ordered = [...relations].sort((a, b) => layout.boxes.get(inbound ? a.to : a.from)!.y - layout.boxes.get(inbound ? b.to : b.from)!.y);
    for (const r of ordered) {
      const inside = layout.boxes.get(inbound ? r.to : r.from)!, outside = modules.get(inbound ? r.from : r.to)!;
      const width = 176, lines = wrapSvgLines('[外部] ' + outside.name, width - 24, 14), height = lines.length * 21 + 16;
      const b = { x: inbound ? extent.x - width - 172 : extent.x + extent.width + 172, y: Math.max(nextY, inside.y + (inside.height - height) / 2), width, height };
      nextY = b.y + height + 20;
      occupied.push(b); extents.push(b);
      nodes.push(`<g data-boundary-relation="${escapeXml(r.id)}" data-external-module="${escapeXml(outside.id)}">` + rectMarkup(b, `rx="16" fill="#f6f2fa" stroke="${arrowColors.external}" stroke-dasharray="5 3"`) +
        svgText(lines, b.x + 12, b.y + 22, 14, { color: arrowColors.external, lineHeight: 21 }) + '</g>');
      const external = { x: inbound ? b.x + width : b.x, y: b.y + height / 2 };
      const internal = { x: inbound ? inside.x : inside.x + inside.width, y: inside.y + inside.height / 2 };
      const start = inbound ? external : internal, end = inbound ? internal : external, middle = (start.x + end.x) / 2;
      const points = [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end], anchor = cubicPoint(points, 0.5);
      links.push({ relation: r, path: `M${start.x} ${start.y} C${middle} ${start.y}, ${middle} ${end.y}, ${end.x} ${end.y}`, anchor, preferred: anchor, external: true });
    }
  }
  for (const { relation: r, path, anchor, preferred, external } of links) {
    const uncertain = r.status === 'inferred' || r.status === 'needs_verification' || r.origin === 'needs_verification';
    const kind = external ? 'external' : uncertain ? 'uncertain' : r.kind === 'return' ? 'return' : 'default';
    const color = arrowColors[kind];
    const hint = r.transfers?.map(t => t.label).filter(t => t !== r.label).join('、');
    const label = [r.label, hint, uncertain ? '待核实' : r.origin.startsWith('manual') ? '人工补充' : ''].filter(Boolean).join(' · ');
    const lines = wrapSvgLines(label, 174, 12), width = Math.max(44, ...lines.map(s => svgTextWidth(s, 12) + 18));
    const b = placeCaption(preferred, width, lines.length * 18 + 6, occupied);
    occupied.push(b); extents.push(b);
    paths.push(`<path data-edge-id="${escapeXml(r.id)}" data-from="${escapeXml(r.from)}" data-to="${escapeXml(r.to)}" d="${path}" fill="none" stroke="${color}" stroke-width="1.8"${kind === 'default' ? '' : ' stroke-dasharray="6 3"'} marker-end="url(#arrow-${kind})"/>`);
    if (!overlaps(b, { ...anchor, width: 0, height: 0 })) paths.push(`<line x1="${anchor.x}" y1="${anchor.y}" x2="${b.x + b.width / 2}" y2="${b.y + b.height / 2}" stroke="${color}" opacity="0.55"/>`);
    captions.push(`<g data-edge-label="${escapeXml(r.id)}">` + rectMarkup(b, `rx="9" fill="#ffffff" stroke="${color}"`) +
      svgText(lines, b.x + 9, b.y + 16, 12, { lineHeight: 18, color }) + '</g>');
  }
  const baseline = doc.last_update?.read_baseline ?? doc.baseline;
  const externalBoundaryCount = externalInbound.length + externalOutbound.length;
  const scopeLabel = `${scopeName} · ${includedModules.length} 个模块 · ${internalRelations.length} 条内部关系 · ${externalBoundaryCount} 条外部连接 · 已排除隐藏项 ${scope.hiddenExcludedCount}`;
  return finishDiagram({
    diagramTitle: doc.title, projectName: params.projectName, scopeLabel, versionLabel: 'v' + doc.version,
    baselineLabel: baseline ? [baseline.snapshot_id, baseline.branch ?? doc.branch_key, baseline.commit, baseline.fingerprint, baseline.dirty ? '含未提交变更' : ''].filter(Boolean).join(' · ') : undefined,
    statusLabel: architectureExportStatus(doc), exportedAt: params.exportedAt ?? doc.updated_at,
  }, [...regions, ...paths, ...nodes, ...captions].join(''), boundsOf(extents),
  { nodeCount: includedModules.length, edgeCount: visibleRelations.length, externalBoundaryCount },
  '分层色块：入口交互 / 核心控制 / 存储底层　·　箭头：关系方向　·　虚线卡片：规划中　·　紫色虚线：[外部] 边界　·　琥珀色虚线：待核实');
}

export function renderArchitectureSubgraphSvg(params: ArchitectureExportParams & SubgraphOptions & { rootModuleId: string }) {
  const scope = computeModuleSubgraph(params.doc, params.rootModuleId, params);
  return renderScope(params, scope, '模块子图 · ' + scope.includedModules.find(m => m.id === params.rootModuleId)!.name);
}

export function renderArchitectureSvg(params: ArchitectureExportParams & {
  search?: string; scopeModuleIds?: readonly string[]; selectedModuleId?: string; subgraphOptions?: SubgraphOptions;
}) {
  if (params.selectedModuleId) return renderArchitectureSubgraphSvg({ ...params, ...params.subgraphOptions, rootModuleId: params.selectedModuleId });
  const scope = computeArchitectureScope(params.doc, params.search, params.scopeModuleIds);
  return renderScope(params, { ...scope, externalInbound: [], externalOutbound: [] }, '当前图完整范围' + (params.search?.trim() ? ' · 筛选：' + params.search : ''));
}
