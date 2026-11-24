import type { AnalysisResult, Explanation, ReadingGuide, Snapshot } from '../shared';
import { savedReadingGuide } from '../feature-graph-guide';
import { flowLayout, flowSize } from '../ui/flow-layout';
import { functionCallMap, callLabelWidth } from '../ui/function-call-map';
import { functionSequence } from '../ui/function-sequence-model';
import { readingCollaboration, readingFailureLinks } from '../ui/reading-diagram-model';
import { arrowColors, escapeXml, finishDiagram, svgText, wrapSvgLines } from './svg-common';

export const featureViewNames = {
  business_flow: '业务数据流', collaboration: '协作关系', call_map: '函数调用链',
  call_chain: '调用时间图', graph: '关系流图',
} as const;
export type FeatureDiagramView = keyof typeof featureViewNames;
type ReadingPath = ReadingGuide['paths'][number];
type Edge = AnalysisResult['edges'][number];
type Arrow = keyof typeof arrowColors;

export function featurePaths({ result }: Explanation, view: FeatureDiagramView): { id: string; label: string }[] {
  if (view === 'call_chain' || view === 'call_map') {
    return (result.function_walkthroughs ?? []).filter(p => view === 'call_map' || p.steps.length > 0);
  }
  if (view === 'graph') return [];
  return (savedReadingGuide(result)?.paths ?? []).filter(p => view === 'collaboration' ? p.role_ids.length > 0 :
    p.step_ids.length + p.failure_ids.length > 0 || p.lanes.some(l => l.step_ids.length > 0));
}

export function availableFeatureViews(explanation: Explanation): FeatureDiagramView[] {
  const { nodes } = explanation.result;
  return (Object.keys(featureViewNames) as FeatureDiagramView[]).filter(view => {
    if (view === 'graph') return nodes.length > 0;
    if (view === 'call_map') return nodes.some(n => n.kind === 'function');
    return featurePaths(explanation, view).length > 0;
  });
}

type Paragraph = { text: string; size?: number; color?: string; bold?: boolean; mono?: boolean };

// Measure and paint from the same wrapped lines. The first baseline and all
// following lines are inside the returned height at every supported font size.
function copy(width: number, paragraphs: Paragraph[]) {
  let y = 0;
  const text = paragraphs.filter(p => p.text).map(({ text, size = 14, color = '#334155', bold, mono }) => {
    const lines = wrapSvgLines(text, width, size);
    const lineHeight = Math.ceil(size * 1.48);
    const run = svgText(lines, 0, y + size, size, { lineHeight, color, weight: bold ? 600 : 400, mono });
    y += lines.length * lineHeight + 4;
    return run;
  }).join('');
  return { text, height: Math.max(0, y - 4) };
}

const title = (text: string): Paragraph => ({ text, size: 17, bold: true, color: '#173b3e' });
const eyebrow = (text: string): Paragraph => ({ text, size: 13, bold: true, color: '#0f766e' });
const code = (text: string): Paragraph => ({ text, size: 13, mono: true });
const move = (x: number, y: number, body: string) => `<g transform="translate(${x} ${y})">${body}</g>`;
function rect(x: number, y: number, w: number, h: number, fill = '#ffffff', stroke = '#9db9b5') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}"/>`;
}
function card(width: number, paragraphs: Paragraph[], fill?: string, stroke?: string, pad = 12) {
  const content = copy(width - 2 * pad, paragraphs);
  const height = content.height + 2 * pad;
  return { height, draw: (x: number, y: number, h = height) =>
    rect(x, y, width, h, fill, stroke) + move(x + pad, y + (h - content.height) / 2, content.text) };
}
function arrow(d: string, kind: Arrow = 'default', dashed = kind !== 'default', id?: string) {
  return `<path${id ? ` data-edge-id="${escapeXml(id)}"` : ''} d="${d}" fill="none" stroke="${arrowColors[kind]}" stroke-width="2"${dashed ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#arrow-${kind})"/>`;
}
function edgeStyle(e: Edge): Arrow {
  if (e.flow_role === 'exception') return 'exception';
  if (e.status !== 'source_supported' || e.transfers?.some(t => t.status !== 'source_supported')) return 'uncertain';
  return e.kind === 'return' ? 'return' : 'default';
}
function transferText(e: Edge) {
  return (e.transfers ?? []).map(t => t.label + (t.status === 'source_supported' ? '' : '（待核实）')).join('、');
}
type Drawing = { body: string; width: number; height: number; nodeCount: number; edgeCount: number; legend: string };

function businessFlow(result: AnalysisResult, guide: ReadingGuide, path: ReadingPath): Drawing {
  const steps = new Map(guide.steps.map(s => [s.id, s]));
  const failures = readingFailureLinks(result, guide, path);
  const lanes = [
    ...(path.step_ids.length ? [{ label: path.lanes.length ? '共同起点' : path.label, step_ids: path.step_ids, link_labels: [] }] : []),
    ...path.lanes,
  ];
  const onPath = new Set([...lanes.flatMap(l => l.step_ids), ...path.failure_ids]);
  const pathNodes = new Set(guide.steps.filter(s => onPath.has(s.id)).flatMap(s => s.node_ids));
  const width = 400;
  const texts = (id: string, heading: string): Paragraph[] => {
    const step = steps.get(id)!;
    return [eyebrow(heading + (step.actor ? ' · ' + step.actor : '')), title(step.title),
      { text: step.text }, { text: step.outcome && '结果 · ' + step.outcome }];
  };
  const sources = new Map<string, number>();
  let body = '', y = 0, nodeCount = 0, edgeCount = 0;
  for (const lane of lanes) {
    const top = y;
    const head = copy(width, [title(lane.label)]);
    let items = move(16, y + 12, head.text);
    y += head.height + 28;
    lane.step_ids.forEach((id, i) => {
      const box = card(width, texts(id, '步骤 ' + (i + 1)));
      items += `<g data-step-id="${escapeXml(id)}">${box.draw(16, y)}</g>`;
      sources.set(id, y + box.height / 2);
      y += box.height;
      nodeCount++;
      if (i + 1 < lane.step_ids.length) {
        const label = copy(width - 52, [{ text: lane.link_labels[i] ?? '', size: 13 }]);
        const gap = Math.max(34, label.height + 14);
        const x = 40;
        items += arrow(`M${x} ${y} v${gap - 2}`) + move(x + 14, y + 5, label.text);
        y += gap;
        edgeCount++;
      }
    });
    y += 16;
    body += rect(0, top, width + 32, y - top, '#edf6f4') + items;
    y += 20;
  }
  // Several steps can refer to the same functions. Preserve a transfer's saved
  // endpoints rather than assigning it to an arbitrary pair of reading steps.
  const transfers = result.edges.filter(e => e.transfers?.length && pathNodes.has(e.source_node_id) && pathNodes.has(e.target_node_id));
  if (transfers.length) {
    const names = new Map(result.nodes.map(n => [n.node_id, n.label]));
    const entries = transfers.flatMap(e => [
      eyebrow(`${names.get(e.source_node_id)} → ${names.get(e.target_node_id)}`), { text: transferText(e) },
    ]);
    const panel = card(width + 32, [title('数据传递'), ...entries], '#edf6f4');
    body += panel.draw(0, y);
    y += panel.height;
  }
  const failureX = width + 100 + failures.length * 12;
  let failureY = 0;
  for (const id of path.failure_ids) {
    const links = failures.filter(l => l.to === id);
    const paragraphs = texts(id, '异常分支');
    if (!links.length) paragraphs.push({ text: '触发位置尚未明确', color: '#9a3412' });
    const main = copy(width - 24, paragraphs);
    let innerY = failureY + main.height + 20;
    let content = move(failureX + 12, failureY + 12, main.text);
    for (const link of links) {
      const label = copy(width - 24, [{ text: `${steps.get(link.from)!.title} → ${link.label}`, color: '#9a3412' }]);
      const start = sources.get(link.from)!;
      const end = innerY + label.height / 2;
      const track = width + 56 + failures.indexOf(link) * 12;
      body += arrow(`M${width + 16} ${start} H${track} V${end} H${failureX - 2}`, 'exception', true, link.id);
      content += move(failureX + 12, innerY, label.text);
      innerY += label.height + 8;
      edgeCount++;
    }
    const h = innerY - failureY + 4;
    body += `<g data-step-id="${escapeXml(id)}">${rect(failureX, failureY, width, h, '#fff7ed', '#d07b51')}${content}</g>`;
    failureY += h + 18;
    nodeCount++;
  }
  return { body, width: path.failure_ids.length ? failureX + width : width + 32,
    height: Math.max(y, failureY), nodeCount, edgeCount, legend: '实线箭头表示路径内步骤顺序，红色虚线表示有源码依据的异常去向' };
}

// Each message gets its own row. A shared coordinate system keeps headers,
// lifelines and directed messages together in the standalone drawing.
type Participant = { id: string; lines: Paragraph[] };
type Message = { id: string; from: string | null; to: string; lines: Paragraph[]; kind: Arrow };
function messageDiagram(participants: Participant[], messages: Message[], legend: string): Drawing {
  const pitch = 272, cardWidth = 248;
  const external = messages.some(m => m.from === null);
  const startX = external ? 108 : 0;
  const centers = new Map(participants.map((p, i) => [p.id, startX + i * pitch + cardWidth / 2]));
  const cards = participants.map(p => card(cardWidth, p.lines, '#edf6f4'));
  const headerHeight = Math.max(48, ...cards.map(c => c.height));
  const width = startX + Math.max(1, cards.length) * pitch;
  let rows = '', y = headerHeight + 22;
  for (const m of messages) {
    const sx = m.from === null ? 8 : centers.get(m.from)!, tx = centers.get(m.to)!;
    const self = sx === tx;
    const lw = self ? cardWidth : Math.min(Math.abs(tx - sx) - 12, 520);
    const label = card(lw, m.lines, '#ffffff', '#d7e3e2', 8);
    const x = self ? Math.min(sx + 5, width - lw) : Math.min(sx, tx) + 6;
    rows += label.draw(x, y);
    y += label.height + 8;
    rows += arrow(self ? `M${sx} ${y} h62 v20 h-62` : `M${sx} ${y} H${tx}`, m.kind, m.kind !== 'default', m.id);
    y += self ? 42 : 23;
  }
  const headers = cards.map((c, i) => {
    const cx = centers.get(participants[i].id)!;
    return `<g data-participant="${escapeXml(participants[i].id)}">${c.draw(cx - cardWidth / 2, 0, headerHeight)}
      <line x1="${cx}" y1="${headerHeight}" x2="${cx}" y2="${y}" stroke="#829797" stroke-dasharray="5 5"/></g>`;
  }).join('');
  const trigger = external ? svgText(['外部触发'], 4, headerHeight + 12, 13) : '';
  return { body: headers + trigger + rows, width, height: y, nodeCount: cards.length, edgeCount: messages.length, legend };
}

function collaboration(guide: ReadingGuide, path: ReadingPath) {
  const { roles, handoffs } = readingCollaboration(guide, path);
  return messageDiagram(roles.map(r => ({ id: r.id, lines: [title(r.title), { text: r.duty }] })),
    handoffs.map(h => ({ id: h.id, from: h.from, to: h.to, kind: 'default',
      lines: [eyebrow(h.label), { text: h.send && '发送 · ' + h.send }, { text: h.receive && '接收 · ' + h.receive }] })),
    '箭头由发送方指向接收方，标签记录已保存的交接内容');
}
const messageNames = { entry: '入口', call: '同步调用', callback: '回调', dispatch: '异步派发', return: '返回', work: '处理' };
function callChain(result: AnalysisResult, pathId: string) {
  const { path, participants } = functionSequence(result, pathId)!;
  return messageDiagram(participants.map(n => ({ id: n.node_id,
    lines: [eyebrow(n.node_id === path.entry_node_id ? '入口函数' : '函数'), code(n.function_details?.symbol || n.label)] })),
  path.steps.map((s, i) => ({ id: s.id, from: s.from_node_id, to: s.to_node_id,
    kind: s.kind === 'return' ? 'return' : ['dispatch', 'callback'].includes(s.kind) ? 'external' : 'default',
    lines: [eyebrow(`${i + 1} · ${messageNames[s.kind]}`), { text: s.text }, { text: s.input && '传入 · ' + s.input },
      { text: s.output && '结果 · ' + s.output }, { text: s.condition && '条件 · ' + s.condition }] })),
  '沿生命线向下阅读已记录的静态调用顺序，虚线区分异步交接与返回');
}

function callMap(result: AnalysisResult, pathId: string): Drawing {
  const m = functionCallMap(result, pathId);
  const nodes = m.nodes.map(n => {
    const b = m.boxes.get(n.node_id)!;
    const src = m.nodeSources.get(n.node_id)!;
    const location = src.definition ?? src.declaration;
    const c = card(b.w, [eyebrow(n.node_id === m.entry ? '入口函数' : '函数'), code(n.function_details?.symbol || n.label),
      { text: n.description }, code(location ? `${src.definition ? '定义' : '声明'} · ${location.path}:${location.line_start}` : '定义与声明位置待确认')]);
    return { b, c, id: n.node_id };
  });
  const labels = m.links.map(link => {
    const c = card(callLabelWidth, [eyebrow(link.from === link.to ? '递归调用' : link.kind === 'call' ? '调用' : link.kind === 'callback' ? '回调' : '异步'),
      { text: link.label }, { text: link.input && '传入 · ' + link.input }, { text: link.condition && '条件 · ' + link.condition },
      { text: link.status !== 'source_supported' ? '待核实' : '', color: '#92400e' }], '#ffffff', '#c6d8db', 8);
    return { c, link, route: m.routes.get(link.id)! };
  });
  const groups = m.fileGroups.map(g => ({ b: g.bounds, label: copy(g.bounds.w - 28,
    [code((g.path ?? '定义与声明文件待确认') + ` · ${g.nodes.length} 个函数`)]) }));
  // Keep the model's file groups, channels and recursive curves. Stretch
  // coordinates (not glyphs or arrowheads) to reserve room for the longest copy.
  const sy = Math.max(1, ...nodes.map(n => n.c.height / n.b.h),
    ...labels.map(l => l.c.height / 62), ...groups.map(g => g.label.height / 27));
  const bands = groups.map(({ b, label }) => rect(b.x, b.y * sy, b.w, b.h * sy, '#edf6f4') +
    move(b.x + 14, (b.y + 6) * sy, label.text)).join('');
  const edges = labels.map(({ route, link }) => {
    // functionCallMap emits absolute M/C/S coordinates in x,y pairs.
    const d = route.d.replace(/(-?[\d.]+)[ ,]+(-?[\d.]+)/g, (_, x: string, y: string) => `${x} ${Number(y) * sy}`);
    return arrow(d, link.status !== 'source_supported' ? 'uncertain' : link.kind === 'call' ? 'default' : 'external',
      link.status !== 'source_supported' || link.kind !== 'call', link.id);
  }).join('');
  const pills = labels.map(({ c, route }) => c.draw(route.labelX, route.labelY * sy - c.height / 2)).join('');
  const cards = nodes.map(({ id, b, c }) => `<g data-function-node="${escapeXml(id)}">${c.draw(b.x, b.y * sy, b.h * sy)}</g>`).join('');
  return { body: bands + edges + pills + cards, width: m.width, height: m.height * sy, nodeCount: nodes.length,
    edgeCount: labels.length, legend: '文件框内为已定位函数，箭头表示调用，回环表示递归，虚线表示待核实或异步交接' };
}

function relationGraph(result: AnalysisResult): Drawing {
  const model = flowLayout(result.nodes, result.edges);
  const nodes = result.nodes.map(n => {
    const p = model.positions.get(n.node_id)!;
    const uncertain = result.claims.some(c => n.claim_ids.includes(c.claim_id) && ['unknown', 'inferred'].includes(c.status));
    const c = card(p.width, [eyebrow(n.execution_context.label), title(n.label), { text: uncertain ? '含待核实判断' : '' }]);
    return { p, c, id: n.node_id };
  });
  const labels = model.routes.map(r => {
    const transfer = transferText(r.edge);
    return card(flowSize.labelWidth, [eyebrow(r.edge.label), { text: r.edge.condition ?? '' },
      { text: transfer && '传递 · ' + transfer }, { text: r.caption.uncertain ? '待核实' : '' }], '#ffffff', '#bed4d0', 7);
  });
  const sy = Math.max(1, ...nodes.map(n => n.c.height / n.p.height),
    ...labels.map((l, i) => model.routes[i].label ? l.height / flowSize.labelHeight : 1));
  let wires = '', pills = '', sideY = 10;
  const hasSide = model.routes.some(r => !r.label);
  const width = model.width + (hasSide ? flowSize.labelWidth + 32 : 0);
  model.routes.forEach((r, i) => {
    const [a, b, c, d] = r.points.map(p => `${p.x} ${p.y * sy}`);
    const kind = edgeStyle(r.edge);
    wires += arrow(`M${a} C${b} ${c} ${d}`, kind, kind !== 'default', r.edge.edge_id);
    const label = labels[i];
    if (r.label) {
      const { x, y, height } = r.label;
      pills += label.draw(x, (y + height / 2) * sy - label.height / 2);
    } else {
      // Dense graphs can lack space for a label in the shared route model.
      // Number the wire and place its complete caption in the adjacent column.
      const [p0, p1, p2, p3] = r.points;
      const x = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8;
      const y = sy * (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8;
      pills += svgText([String(i + 1)], x, y, 13, { color: '#92400e', weight: 600 }) +
        svgText(['关系 ' + (i + 1)], model.width + 8, sideY + 14, 13) +
        label.draw(model.width + 8, sideY + 21);
      sideY += label.height + 37;
    }
  });
  const cards = nodes.map(({ id, p, c }) => `<g data-node-id="${escapeXml(id)}">${c.draw(p.x, p.y * sy, p.height * sy)}</g>`).join('');
  return { body: wires + cards + pills, width, height: Math.max(model.height * sy, sideY),
    nodeCount: nodes.length, edgeCount: model.routes.length, legend: '箭头指向关系终点，传递标签记录已保存的输入输出映射，虚线表示返回、异常或待核实关系' };
}

export interface FeatureExportParams {
  explanation: Explanation;
  projectName: string;
  featureName: string;
  scenarioTitle: string;
  snapshot?: Snapshot;
  diagramView?: FeatureDiagramView;
  pathId?: string;
  exportedAt?: string;
}
export function renderFeatureDataflowSvg(params: FeatureExportParams) {
  const { explanation, snapshot } = params;
  const { result } = explanation;
  const available = availableFeatureViews(explanation);
  const view = params.diagramView ?? available[0];
  if (!available.includes(view)) throw new Error('这版走读没有所选视图的数据');
  const paths = featurePaths(explanation, view);
  const path = params.pathId ? paths.find(p => p.id === params.pathId) : paths[0];
  if (params.pathId && !path) throw new Error('所选路径不在这版走读的导出范围内');
  const snapshotId = result.binding.source_snapshot_id;
  if (snapshot && snapshot.source_snapshot_id !== snapshotId) throw new Error('代码快照与所选走读版本不匹配');
  let drawing: Drawing;
  switch (view) {
    case 'business_flow':
    case 'collaboration': {
      const guide = savedReadingGuide(result)!;
      const readingPath = guide.paths.find(p => p.id === path!.id)!;
      drawing = view === 'business_flow' ? businessFlow(result, guide, readingPath) : collaboration(guide, readingPath);
      break;
    }
    case 'call_chain': drawing = callChain(result, path!.id); break;
    case 'call_map': drawing = callMap(result, path?.id ?? ''); break;
    case 'graph': drawing = relationGraph(result); break;
  }
  const { body, width, height, nodeCount, edgeCount, legend } = drawing;
  const scope = [params.featureName, params.scenarioTitle, path?.label, `${nodeCount} 个节点 · ${edgeCount} 条连接`].filter(Boolean).join(' / ');
  return finishDiagram({ diagramTitle: featureViewNames[view], projectName: params.projectName, scopeLabel: scope,
    versionLabel: '走读版本 ' + explanation.result_id, baselineLabel: [snapshotId, snapshot?.commit, snapshot?.fingerprint].filter(Boolean).join(' · '),
    statusLabel: explanation.source_status + (explanation.source_status === 'needs_review' ? ' · 待复核' : ''),
    exportedAt: params.exportedAt ?? explanation.created_at }, body,
  { x: 0, y: 0, width, height }, { nodeCount, edgeCount, externalBoundaryCount: 0 }, legend);
}
