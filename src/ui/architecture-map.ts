import type { AnalysisResult } from '../shared';

type Node = AnalysisResult['nodes'][number];
type Box = { x: number; y: number; width: number; height: number };
type Tier = 'boundary' | 'core' | 'infrastructure';

const tierNames: Record<Tier, string> = {
  boundary: '入口与外部边界',
  core: '核心业务与控制层',
  infrastructure: '基础资源与下游组件',
};
const cardWidth = 284;
const inset = 16;

function cardHeight(node: Node) {
  // Two lines each for the title and responsibility, then only reserve rows with source or I/O.
  return 148 + 24 * [node.evidence_ids?.length, node.inputs?.length, node.outputs?.length].filter(Boolean).length;
}

export function architectureMap(result: AnalysisResult, search = '', maxColumns = 3) {
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

  const rootOf = new Map<string, string>();
  for (const node of all) {
    let root = node;
    while (root.parent_node_id && allIds.has(root.parent_node_id)) {
      root = byId.get(root.parent_node_id)!;
      if (matches.has(node.node_id)) matches.add(root.node_id);
    }
    rootOf.set(node.node_id, root.node_id);
  }
  const nodes = all.filter(node => matches.has(node.node_id));
  const edges = relations.filter(edge => matches.has(edge.source_node_id) && matches.has(edge.target_node_id));
  const children = new Map<string, Node[]>();
  const tiers: Record<Tier, Node[]> = { boundary: [], core: [], infrastructure: [] };
  const degrees = new Map<string, number>();
  const upstream = new Set<string>(), downstream = new Set<string>(), connected = new Set<string>();
  for (const edge of relations) {
    const from = rootOf.get(edge.source_node_id)!, to = rootOf.get(edge.target_node_id)!;
    for (const id of new Set([edge.source_node_id, edge.target_node_id])) degrees.set(id, (degrees.get(id) ?? 0) + 1);
    connected.add(from);
    connected.add(to);
    if (from !== to) {
      upstream.add(from);
      downstream.add(to);
    }
  }
  for (const node of nodes) {
    if (node.parent_node_id && allIds.has(node.parent_node_id)) {
      const siblings = children.get(node.parent_node_id) ?? [];
      siblings.push(node);
      children.set(node.parent_node_id, siblings);
      continue;
    }
    const sends = upstream.has(node.node_id), receives = downstream.has(node.node_id);
    const tier = node.kind === 'execution_boundary' ? 'boundary' : node.kind === 'resource' ? 'infrastructure'
      : sends && !receives ? 'boundary' : receives && !sends ? 'infrastructure' : 'core';
    tiers[tier].push(node);
  }

  const largestTier = Math.max(...Object.values(tiers).map(roots => roots.length));
  const columns = Math.max(1, Math.min(maxColumns, largestTier));
  const boxes = new Map<string, Box>();
  const boundaries: (Box & { id: string })[] = [];
  const layers: (Box & { id: Tier; title: string; roots: string[] })[] = [];
  const positions = new Map<string, { col: number; row: number }>();
  const rows: { tier: Tier; groups: Node[] }[] = [];
  function mark(node: Node, col: number, row: number) {
    positions.set(node.node_id, { col, row });
    for (const child of children.get(node.node_id) ?? []) mark(child, col, row);
  }
  for (const tier of Object.keys(tiers) as Tier[]) {
    const roots = tiers[tier].sort((a, b) => Number(connected.has(b.node_id)) - Number(connected.has(a.node_id)));
    for (let start = 0; start < roots.length; start += columns) {
      const groups = roots.slice(start, start + columns);
      groups.forEach((root, col) => mark(root, col, rows.length));
      rows.push({ tier, groups });
    }
  }

  // Each column has a routing gutter. Cross-column links change columns only
  // in the aisle below their source row, so paths never run across other cards.
  const gutterTracks = Array<number>(columns).fill(0);
  const aisleTracks = Array<number>(rows.length).fill(0);
  const ports = new Map<string, number>();
  function takePort(id: string) {
    const next = (ports.get(id) ?? 0) + 1;
    ports.set(id, next);
    return next;
  }
  const tracks = edges.map(edge => {
    const from = positions.get(edge.source_node_id)!, to = positions.get(edge.target_node_id)!;
    const sourceTrack = ++gutterTracks[from.col];
    return {
      edge, from, to, sourceTrack,
      targetTrack: from.col === to.col ? sourceTrack : ++gutterTracks[to.col],
      aisle: from.col === to.col ? 0 : ++aisleTracks[from.row],
      sourcePort: takePort(edge.source_node_id), targetPort: takePort(edge.target_node_id),
    };
  });

  let width = inset + 4;
  const xs = gutterTracks.map(count => {
    const left = width;
    width += cardWidth + 28 + count * 5;
    return left;
  });
  const floors: number[] = [];
  function place(node: Node, x: number, y: number, depth: number): number {
    const indent = Math.min(depth, 4) * 8;
    const box = { x: x + indent, y, width: cardWidth - indent * 2, height: cardHeight(node) };
    boxes.set(node.node_id, box);
    let bottom = y + box.height;
    const nested = children.get(node.node_id) ?? [];
    for (const child of nested) bottom = place(child, x, bottom + 18, depth + 1);
    if (nested.length) {
      boundaries.push({ id: node.node_id, x: box.x - 6, y: y - 6, width: box.width + 12, height: bottom - y + 12 });
      bottom += 8;
    }
    return bottom;
  }

  let height = 8;
  for (const [index, row] of rows.entries()) {
    if (layers.at(-1)?.id !== row.tier) {
      layers.push({ id: row.tier, title: tierNames[row.tier], roots: tiers[row.tier].map(node => node.node_id),
        x: 4, y: height, width: width - 8, height: 0 });
      height += 48;
    }
    const floor = Math.max(...row.groups.map((root, col) => place(root, xs[col], height, 0)));
    floors.push(floor);
    height = floor + 24 + aisleTracks[index] * 5;
    const layer = layers.at(-1)!;
    layer.height = height - layer.y - 6;
  }

  function portY(box: Box, id: string, slot: number) {
    return Math.round(box.y + box.height * slot / ((ports.get(id) ?? 0) + 1));
  }
  const links = tracks.map(({ edge, from, to, sourceTrack, targetTrack, aisle, sourcePort, targetPort }) => {
    const a = boxes.get(edge.source_node_id)!, b = boxes.get(edge.target_node_id)!;
    const sy = portY(a, edge.source_node_id, sourcePort), ty = portY(b, edge.target_node_id, targetPort);
    const sx = xs[from.col] + cardWidth + 8 + sourceTrack * 5;
    const tx = xs[to.col] + cardWidth + 8 + targetTrack * 5;
    const points = [[a.x + a.width, sy], [sx, sy]];
    if (from.col !== to.col) {
      const trackY = floors[from.row] + 8 + aisle * 5;
      points.push([sx, trackY], [tx, trackY]);
    }
    points.push([tx, ty], [b.x + b.width, ty]);
    return { edge, points };
  });
  return { nodes, edges, degrees, boxes, boundaries, layers, links, width, height };
}
