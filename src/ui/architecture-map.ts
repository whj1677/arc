import type { AnalysisResult } from '../shared';
import { architectureDocumentToAnalysisResult, architectureTopology, type ArchitectureDocument, type ArchitectureLayout, type ArchitectureView } from '../architecture-workspace';
import { cubicPoint, overlaps, type Point, type Rect } from './flow-layout';

type Node = AnalysisResult['nodes'][number];
type Tier = 'boundary' | 'core' | 'infrastructure';
const tierNames: Record<Tier, string> = {
  boundary: '入口与交互层',
  core: '核心业务与控制层',
  infrastructure: '存储、队列与底层支撑',
};
const tierOrder = Object.keys(tierNames) as Tier[];
const cardWidth = 204, cardHeight = 82, pitch = 224, inset = 16;

export function architectureColumns(width: number) {
  return width >= 1200 ? 6 : Math.max(2, Math.min(5, Math.floor((width - inset * 2) / pitch)));
}

function append<T>(map: Map<string, T[]>, key: string, value: T) {
  if (!map.has(key)) map.set(key, []);
  map.get(key)!.push(value);
}

function verticalCurve(from: Point, to: Point, middle = (from.y + to.y) / 2) {
  return [from, { x: from.x, y: middle }, { x: to.x, y: middle }, to];
}

export function computeAutoLayoutPositions(doc: ArchitectureDocument, width: number): ArchitectureLayout['positions'] {
  const view = architectureDocumentToAnalysisResult(doc, undefined, { includeHidden: true });
  const { boxes } = architectureMap(view, '', architectureColumns(width));
  return Object.fromEntries([...boxes].map(([id, { x, y }]) => [id, { x, y }]));
}

export function moveArchitectureModule(doc: ArchitectureDocument, id: string, point: Point): ArchitectureDocument {
  const { positions, manual_positions } = doc.layout;
  return { ...doc, layout: { ...doc.layout, positions: { ...positions, [id]: point },
    manual_positions: manual_positions.includes(id) ? manual_positions : [...manual_positions, id] } };
}

export function architectureMapScope(result: ArchitectureView, search = '') {
  const byId = new Map(result.nodes.map(node => [node.node_id, node]));
  const byEdge = new Map(result.edges.map(edge => [edge.edge_id, edge]));
  const all = (result.architecture?.node_ids ?? []).map(id => byId.get(id)).filter(node => !!node);
  const allIds = new Set(all.map(node => node.node_id));
  const relations = (result.architecture?.edge_ids ?? []).map(id => byEdge.get(id))
    .filter((edge): edge is AnalysisResult['edges'][number] => !!edge && allIds.has(edge.source_node_id) && allIds.has(edge.target_node_id));

  const query = search.trim().toLowerCase();
  const matches = new Set(all.filter(node => (node.label + ' ' + node.description).toLowerCase().includes(query)).map(node => node.node_id));
  if (query) {
    for (const edge of relations) {
      if (edge.label.toLowerCase().includes(query)) {
        matches.add(edge.source_node_id);
        matches.add(edge.target_node_id);
      }
    }
  }

  if (query) for (const id of matches) {
    const parent = byId.get(id)!.parent_node_id;
    if (parent && allIds.has(parent)) matches.add(parent);
  }
  const nodes = all.filter(node => matches.has(node.node_id));
  const edges = relations.filter(edge => matches.has(edge.source_node_id) && matches.has(edge.target_node_id));
  return { all, relations, nodes, edges };
}

export function architectureMap(input: ArchitectureView | ArchitectureDocument, search = '', maxColumns = 6,
  positions: ArchitectureLayout['positions'] = 'modules' in input ? input.layout.positions : {},
  measureHeight?: (id: string, width: number) => number) {
  const result = 'modules' in input ? architectureDocumentToAnalysisResult(input) : input;
  const { all, relations, nodes, edges } = architectureMapScope(result, search);
  const { rootOf, incoming, outgoing, layers: defaultLayers } = architectureTopology(all, relations);
  const degrees = new Map<string, number>();
  for (const edge of relations) {
    for (const id of new Set([edge.source_node_id, edge.target_node_id])) degrees.set(id, (degrees.get(id) ?? 0) + 1);
  }

  const tiers: Record<Tier, Node[]> = { boundary: [], core: [], infrastructure: [] };
  const children = new Map<string, Node[]>();
  for (const node of nodes) {
    if (rootOf.get(node.node_id) !== node.node_id && result.module_layers?.[node.parent_node_id!] === result.module_layers?.[node.node_id]) {
      append(children, node.parent_node_id!, node);
      continue;
    }
    const layer = result.module_layers?.[node.node_id] ?? defaultLayers.get(node.node_id)!;
    const tier: Tier = layer === 'entry' ? 'boundary' : layer === 'foundation' ? 'infrastructure' : 'core';
    tiers[tier].push(node);
  }

  // Rank the system's most connected core roots without inventing graph edges.
  const hubs = new Set(tiers.core
    .map(node => ({ id: node.node_id, degree: (incoming.get(node.node_id)?.length ?? 0) + (outgoing.get(node.node_id)?.length ?? 0) }))
    .filter(node => node.degree >= 3)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, 3).map(node => node.id));

  const largestTier = Math.max(...tierOrder.map(tier => tiers[tier].length));
  const columns = Math.max(1, Math.min(maxColumns, largestTier));
  // Balance partially filled rows (e.g. 4+4 for eight roots). Sweep using actual
  // column coordinates so neighbors still align when a layer wraps.
  type Slot = { col: number; row: number; systemRow: number };
  const slots = new Map<string, Slot>();
  let firstRow = 0;
  for (const tier of tierOrder) {
    const group = tiers[tier], rowCount = Math.ceil(group.length / columns);
    let index = 0;
    for (let row = 0; row < rowCount; row++) {
      const count = Math.floor(group.length / rowCount) + Number(row < group.length % rowCount);
      for (let col = 0; col < count; col++) slots.set(group[index++].node_id, { col, row, systemRow: firstRow + row });
    }
    firstRow += rowCount;
  }
  const neighbors = new Map([...slots.keys()].map(id => [id, [...(incoming.get(id) ?? []), ...(outgoing.get(id) ?? [])].filter(n => slots.has(n))]));
  function affinity(id: string, slot: Slot, other: string) {
    return neighbors.get(id)!.reduce((sum, n) => {
      if (n === other) return sum; // A shared edge has the same length after swapping its ends.
      const target = slots.get(n)!;
      // A column pitch is roughly twice a row pitch.
      return sum + 4 * (slot.col - target.col) ** 2 + (slot.systemRow - target.systemRow) ** 2;
    }, 0);
  }
  for (const tier of [...tierOrder, ...[...tierOrder].reverse()]) {
    const ids = tiers[tier].map(n => n.node_id);
    for (const [index, a] of ids.entries()) {
      for (const b of ids.slice(index + 1)) {
        const p = slots.get(a)!, q = slots.get(b)!;
        const current = affinity(a, p, b) + affinity(b, q, a);
        if (affinity(a, q, b) + affinity(b, p, a) < current) {
          slots.set(a, q);
          slots.set(b, p);
        }
      }
    }
  }

  const layoutWidth = inset * 2 + (columns - 1) * pitch + cardWidth;
  const boxes = new Map<string, Rect>();
  const boundaries: (Rect & { id: string })[] = [];
  const layers: (Rect & { id: Tier; title: string; roots: string[] })[] = [];
  function place(node: Node, x: number, y: number, depth: number): number {
    const indent = Math.min(depth, 4) * 8;
    const width = cardWidth - indent * 2;
    const box = { x: x + indent, y, width, height: measureHeight?.(node.node_id, width) ?? cardHeight };
    boxes.set(node.node_id, box);
    let bottom = y + box.height;
    const nested = children.get(node.node_id) ?? [];
    for (const child of nested) bottom = place(child, x, bottom + 24, depth + 1);
    if (nested.length) {
      boundaries.push({ id: node.node_id, x: box.x - 6, y: y - 6, width: box.width + 12, height: bottom - y + 12 });
      bottom += 8;
    }
    return bottom;
  }

  let height = 8;
  const aisleYs: number[] = [];
  for (const tier of tierOrder) {
    const roots = tiers[tier].sort((a, b) => {
      const p = slots.get(a.node_id)!, q = slots.get(b.node_id)!;
      return p.row - q.row || p.col - q.col;
    });
    if (!roots.length) continue;
    const top = height;
    height += 42;
    const rowCount = Math.ceil(roots.length / columns);
    for (let row = 0; row < rowCount; row++) {
      const floor = Math.max(...roots.filter(n => slots.get(n.node_id)!.row === row)
        .map(n => place(n, inset + slots.get(n.node_id)!.col * pitch, height, 0)));
      aisleYs.push(height - 14, floor + 14);
      height = floor + (row + 1 === rowCount ? 18 : 32);
    }
    layers.push({ id: tier, title: tierNames[tier], roots: roots.map(n => n.node_id), x: 4, y: top, width: layoutWidth - 8, height: height - top });
    height += 60;
  }

  if (layers.length) height -= 52; // Keep the generous corridors between bands, not below the last one.

  let minX = 0, minY = 0, right = layoutWidth;
  const placed = new Map<string, Rect>();
  const manual = measureHeight && 'modules' in input ? new Set(input.layout.manual_positions) : undefined;
  for (const [id, box] of boxes) {
    if (Object.hasOwn(positions, id)) {
      Object.assign(box, positions[id]);
      if (!manual || manual.has(id)) placed.set(id, box);
    }
  }
  if (placed.size || (manual && Object.keys(positions).length)) {
    // The interactive map anchors every saved position. Expanded export cards keep
    // dragged coordinates and move automatically positioned neighbors only on collision.
    for (const [id, box] of boxes) {
      if (!placed.has(id)) {
        while ([...placed.values()].some(other => overlaps(box, other, 4))) box.x += pitch;
        placed.set(id, box);
      }
      right = Math.max(right, box.x + box.width + inset);
      height = Math.max(height, box.y + box.height + 32);
      minX = Math.min(minX, box.x - inset);
      minY = Math.min(minY, box.y - 32);
      aisleYs.push(box.y - 14, box.y + box.height + 14);
    }
    // Rebuild group outlines bottom-up, including descendants moved by hand.
    const outlines = new Map<string, Rect>();
    for (const group of boundaries) {
      const members = [boxes.get(group.id)!, ...children.get(group.id)!.map(n => outlines.get(n.node_id) ?? boxes.get(n.node_id)!)];
      group.x = Math.min(...members.map(b => b.x)) - 6;
      group.y = Math.min(...members.map(b => b.y)) - 6;
      group.width = Math.max(...members.map(b => b.x + b.width)) - group.x + 6;
      group.height = Math.max(...members.map(b => b.y + b.height)) - group.y + 6;
      outlines.set(group.id, group);
    }
  }
  const width = right - minX;

  type Side = 'top' | 'bottom' | 'left' | 'right';
  const portGroups = new Map<string, { point: Point; rank: number }[]>();
  function port(id: string, side: Side, other: Rect) {
    const box = boxes.get(id)!;
    const point = { x: box.x, y: box.y };
    const horizontal = side === 'top' || side === 'bottom';
    if (side === 'bottom') point.y += box.height;
    if (side === 'right') point.x += box.width;
    append(portGroups, id + ':' + side, { point, rank: horizontal ? other.x : other.y });
    return point;
  }
  const directions = new Set(edges.map(e => JSON.stringify([e.source_node_id, e.target_node_id])));
  const endpoints = edges.map(edge => {
    const a = boxes.get(edge.source_node_id)!, b = boxes.get(edge.target_node_id)!;
    const adjacent = a.y === b.y && Math.abs(a.x - b.x) === pitch;
    const beneath = a.y < b.y;
    const sourceSide = adjacent ? (a.x < b.x ? 'right' : 'left') : beneath || (a.y === b.y && a.x > b.x) ? 'bottom' : 'top';
    const targetSide = adjacent ? (a.x < b.x ? 'left' : 'right') : a.y === b.y ? sourceSide : beneath ? 'top' : 'bottom';
    return { edge, a, b, adjacent, start: port(edge.source_node_id, sourceSide, b), end: port(edge.target_node_id, targetSide, a) };
  });
  for (const [key, group] of portGroups) {
    const split = key.lastIndexOf(':'), box = boxes.get(key.slice(0, split))!, side = key.slice(split + 1);
    group.sort((a, b) => a.rank - b.rank).forEach(({ point }, i) => {
      const fraction = (i + 1) / (group.length + 1);
      if (side === 'top' || side === 'bottom') point.x += Math.round(12 + (box.width - 24) * fraction);
      else point.y += box.height - Math.round(5 + 14 * fraction);
    });
  }

  const obstacles = [...boxes.values()];
  const fixedLabels: Rect[] = [...obstacles, ...layers.map(l => ({ x: l.x + 8, y: l.y + 5, width: l.title.length * 16 + 50, height: 27 }))];
  const captions = new Map<string, Rect[]>();
  const links = endpoints.map(({ edge, a, b, adjacent, start, end }) => {
    let curves: Point[][];
    if (adjacent) {
      const middle = (start.x + end.x) / 2;
      const reciprocal = directions.has(JSON.stringify([edge.target_node_id, edge.source_node_id]));
      const bend = reciprocal ? Math.sign(end.x - start.x) * 14 : 0;
      curves = [[start, { x: middle, y: start.y + bend }, { x: middle, y: end.y + bend }, end]];
    } else if (a.y === b.y) {
      const aisle = start.y + (a.x <= b.x ? -21 : 21);
      curves = [verticalCurve(start, end, aisle)];
    } else {
      curves = [verticalCurve(start, end)];
      // When a link skips occupied rows, keep its bottom/top ports and curve
      // through the nearest open column gap only for the obstructed span.
      const hitsCard = (curve: Point[]) => {
        const steps = Math.ceil((Math.abs(curve[3].y - curve[0].y) + Math.abs(curve[3].x - curve[0].x)) / 8);
        for (let i = 1; i < steps; i++) {
          const p = cubicPoint(curve, i / steps);
          if (obstacles.some(r => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height)) return true;
        }
        return false;
      };
      if (hitsCard(curves[0])) {
        const bend = Math.sign(end.y - start.y) * 10, middle = (start.x + end.x) / 2;
        const gaps = Array.from({ length: columns + 1 }, (_, i) => inset - 10 + i * pitch)
          .sort((p, q) => Math.abs(p - middle) - Math.abs(q - middle));
        for (const x of gaps) {
          const p = { x, y: start.y + bend * 2 }, q = { x, y: end.y - bend * 2 };
          const detour = [verticalCurve(start, p), verticalCurve(p, q), verticalCurve(q, end)];
          if (!detour.some(hitsCard)) { curves = detour; break; }
        }
      }
    }
    const path = 'M' + start.x + ' ' + start.y + curves.map(curve => ' C' + curve.slice(1).map(p => p.x + ' ' + p.y).join(', ')).join('');
    const labelWidth = Math.min(150, Math.max(44, [...edge.label].reduce((w, ch) => w + (ch.charCodeAt(0) < 128 ? 7 : 12), 16)));
    const anchors = curves.flatMap(curve => [0.5, 0.32, 0.68, 0.16, 0.84].map(t => cubicPoint(curve, t)));
    // Only captions incident on the same focused component appear together.
    const occupied = [...fixedLabels, ...(captions.get(edge.source_node_id) ?? []), ...(captions.get(edge.target_node_id) ?? [])];
    let labelPos = anchors[0], labelAnchor = anchors[0], best = Infinity;
    searchLabel: for (const p of anchors) {
      const nearAisles = [...aisleYs].sort((a, b) => Math.abs(a - p.y) - Math.abs(b - p.y)).slice(0, 4);
      for (const y of [p.y, ...nearAisles]) {
        for (const offset of [0, -labelWidth / 2, labelWidth / 2, -(labelWidth / 2 + 6), labelWidth / 2 + 6, -labelWidth, labelWidth]) {
          const x = Math.max(minX + labelWidth / 2 + 4, Math.min(right - labelWidth / 2 - 4, p.x + offset));
          const dx = Math.abs(x - p.x), dy = Math.abs(y - p.y);
          const score = Math.max(0, dx - labelWidth / 2) ** 2 + Math.max(0, dy - 10) ** 2 + 0.025 * (dx * dx + dy * dy);
          if (score >= best) continue;
          const rect = { x: x - labelWidth / 2, y: y - 10, width: labelWidth, height: 20 };
          if (rect.y < minY + 2 || rect.y + 20 > height - 2 || occupied.some(r => overlaps(rect, r, 2))) continue;
          best = score;
          labelPos = { x, y };
          labelAnchor = p;
          if (!score) break searchLabel;
        }
      }
    }
    const singleEdgeLabel = best === Infinity;
    if (singleEdgeLabel) {
      // A dense hub can fill its local aisles. Reserve a card-free caption
      // for this edge alone, instead of overlaying its neighbors' captions.
      const x = Math.max(minX + labelWidth / 2 + 4, Math.min(right - labelWidth / 2 - 4, labelAnchor.x));
      const y = [...aisleYs].sort((a, b) => Math.abs(a - labelAnchor.y) - Math.abs(b - labelAnchor.y))
        .find(y => !fixedLabels.some(r => overlaps({ x: x - labelWidth / 2, y: y - 10, width: labelWidth, height: 20 }, r, 2))) ?? height - 12;
      labelPos = { x, y };
    } else {
      const rect = { x: labelPos.x - labelWidth / 2, y: labelPos.y - 10, width: labelWidth, height: 20 };
      for (const id of new Set([edge.source_node_id, edge.target_node_id])) append(captions, id, rect);
    }
    return { edge, path, curves, labelPos, labelWidth, labelAnchor, singleEdgeLabel };
  });
  return { nodes, edges, degrees, hubs, boxes, boundaries, layers, links, width, height: height - minY, minX, minY, layoutWidth };
}
