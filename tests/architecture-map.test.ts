import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '../src/shared';
import { Architecture } from '../src/ui/Architecture';
import { cubicPoint, overlaps } from '../src/ui/flow-layout';
import { architectureMap } from '../src/ui/architecture-map';

type Node = AnalysisResult['nodes'][number];
const node = (id: string, parent?: string, kind: Node['kind'] = 'stage') =>
  ({ node_id: id, kind, label: id, description: id, parent_node_id: parent, inputs: [], outputs: [], claim_ids: [], evidence_ids: [] });
const edge = (id: string, a: string, b: string) =>
  ({ edge_id: id, source_node_id: a, target_node_id: b, label: id, kind: 'sync_call', status: 'source_supported', evidence_ids: [], claim_ids: [] });
const fixture = (nodes: object[], edges: object[]) => ({
  nodes, edges, architecture: { node_ids: nodes.map(n => (n as Node).node_id), edge_ids: edges.map(e => (e as { edge_id: string }).edge_id) },
  coverage: { covered_scope: ['控制命令入口'], unresolved_scope: ['设备运行状态'] }, summary: {text: '已分析控制链路'},
  binding: { source_snapshot_id: 'snapshot' }, evidence: [],
} as unknown as AnalysisResult);

test('explicit containment and all original relationship directions survive layered layout', () => {
  const r = fixture([node('front'), node('back'), node('retrieval', 'back'), node('parser', 'retrieval'), node('model'), node('db')],
    [edge('request', 'front', 'back'), edge('call', 'back', 'retrieval'), edge('return', 'retrieval', 'back'), edge('model', 'back', 'model'), edge('sql', 'back', 'db')]);
  const original = JSON.stringify(r), m = architectureMap(r);
  assert.equal(JSON.stringify(r), original);
  assert.deepEqual(m.links.map(link => link.edge), r.edges);
  for (const [parent, child] of [['back', 'retrieval'], ['back', 'parser'], ['retrieval', 'parser']]) {
    const b = m.boxes.get(child)!, group = m.boundaries.find(g => g.id === parent)!;
    assert.ok(b.x >= group.x && b.y >= group.y && b.x + b.width <= group.x + group.width && b.y + b.height <= group.y + group.height);
  }
  for (const b of m.boxes.values()) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= m.width && b.y + b.height <= m.height);
});

test('search retains matching relationships, actual parents and the original layer of a filtered root', () => {
  const r = fixture([node('front'), node('back'), node('retrieval', 'back'), node('db')],
    [edge('request', 'front', 'back'), edge('call', 'back', 'retrieval'), edge('save', 'back', 'db')]);
  const m = architectureMap(r, 'retrieval');
  assert.deepEqual(m.nodes.map(n => n.node_id), ['back', 'retrieval']);
  assert.equal(m.boundaries[0].id, 'back');
  assert.deepEqual(m.edges.map(e => e.edge_id), ['call']);
  assert.deepEqual(m.layers.map(t => t.id), ['core']);
  assert.deepEqual(architectureMap(r, 'request').nodes.map(n => n.node_id), ['front', 'back']);
  assert.equal(architectureMap(r, 'missing').nodes.length, 0);
});

test('isolated components and reciprocal calls gain no invented relationships', () => {
  const r = fixture([node('a'), node('b'), node('alone')], [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')]);
  const m = architectureMap(r);
  assert.equal(m.boxes.size, 3);
  assert.deepEqual(m.edges, r.edges);
  assert.deepEqual(m.layers.map(t => [t.id, t.roots]), [['boundary', ['alone']], ['core', ['a', 'b']]]);
});

test('without root-level edges, kinds provide a useful layer fallback', () => {
  const m = architectureMap(fixture([node('entry', undefined, 'execution_boundary'), node('core'), node('queue', undefined, 'resource')], []));
  assert.deepEqual(m.layers.map(t => [t.id, t.roots]), [['boundary', ['entry']], ['core', ['core']], ['infrastructure', ['queue']]]);
});

function checkGeometry(m: ReturnType<typeof architectureMap>) {
  for (const [id, box] of m.boxes) {
    for (const [other, b] of m.boxes) {
      if (id !== other) assert.ok(!overlaps(box, b), 'Card collision: ' + id + ' / ' + other);
    }
  }
  for (const [index, link] of m.links.entries()) {
    const { edge, labelPos, labelWidth } = link;
    const rect = { x: labelPos.x - labelWidth / 2, y: labelPos.y - 10, width: labelWidth, height: 20 };
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= m.width && rect.y + rect.height <= m.height);
    for (const [id, box] of m.boxes) assert.ok(!overlaps(rect, box), 'Caption covers ' + id);
    for (const sibling of m.links.slice(0, index)) {
      if (link.singleEdgeLabel || sibling.singleEdgeLabel) continue;
      if (![sibling.edge.source_node_id, sibling.edge.target_node_id].some(id => id === edge.source_node_id || id === edge.target_node_id)) continue;
      assert.ok(!overlaps(rect, { x: sibling.labelPos.x - sibling.labelWidth / 2, y: sibling.labelPos.y - 10,
        width: sibling.labelWidth, height: 20 }), 'Focused captions overlap: ' + edge.edge_id + '/' + sibling.edge.edge_id);
    }
    // Exercise the actual SVG path, including multi-row detours and return arcs.
    assert.match(link.path, /^M[-.\d ]+( C[-.\d ,]+)+$/);
    const coords = link.path.match(/-?[\d.]+/g)!.map(Number);
    const points = Array.from({ length: coords.length / 2 }, (_, i) => ({ x: coords[i * 2], y: coords[i * 2 + 1] }));
    const a = m.boxes.get(edge.source_node_id)!, b = m.boxes.get(edge.target_node_id)!;
    if (a.y !== b.y) {
      assert.equal(points[0].y, a.y < b.y ? a.y + a.height : a.y);
      assert.equal(points.at(-1)!.y, a.y < b.y ? b.y : b.y + b.height);
    }
    for (let i = 0; i + 3 < points.length; i += 3) {
      for (let sample = 1; sample < 100; sample++) {
        const point = cubicPoint(points.slice(i, i + 4), sample / 100);
        for (const [id, r] of m.boxes) assert.ok(point.x <= r.x + 0.01 || point.x >= r.x + r.width - 0.01 ||
          point.y <= r.y + 0.01 || point.y >= r.y + r.height - 0.01, edge.edge_id + ' crosses ' + id);
      }
    }
  }
}

test('queue-fed workers stay in infrastructure while other downstream execution boundaries stay in core', () => {
  const nodes = [node('isolated'), node('entry'), node('core'), node('queue', undefined, 'resource'),
    node('worker', undefined, 'execution_boundary'), node('sink', undefined, 'resource'), node('internal', 'core'),
    node('receiver', undefined, 'execution_boundary')];
  const edges = [edge('start', 'entry', 'core'), edge('write', 'core', 'queue'), edge('read', 'queue', 'worker'),
    edge('persist', 'worker', 'sink'), edge('ack', 'sink', 'queue'), edge('self', 'core', 'core'), edge('inner', 'internal', 'core'),
    edge('deliver', 'entry', 'receiver')];
  for (const columns of [1, 2, 3]) {
    const m = architectureMap(fixture(nodes, edges), '', columns);
    assert.deepEqual(m.layers.map(t => t.id), ['boundary', 'core', 'infrastructure']);
    assert.deepEqual(new Set(m.layers[2].roots), new Set(['queue', 'worker', 'sink']));
    assert.deepEqual(new Set(m.layers[1].roots), new Set(['core', 'receiver']));
    assert.ok(m.layers[0].y + m.layers[0].height < m.layers[1].y);
    assert.ok(m.layers[1].y + m.layers[1].height < m.layers[2].y);
    checkGeometry(m);
  }
});

test('the 21-component bams topology fits in five or six rows with separated parallel transfers', () => {
  const resources = ['config', 'threshold-store', 'ring', 'persist-q', 'csv', 'event-lib', 'hal', 'logs'];
  const ids = ['app', 'config', 'battery', 'fault', 'power', 'pcs', 'peers', 'aux', 'display', 'thresholds', 'threshold-store',
    'ems', 'wave', 'ring', 'persist-q', 'writer', 'csv', 'events', 'event-lib', 'hal', 'logs'];
  const nodes = ids.map(id => node(id, undefined, resources.includes(id) ? 'resource' : ['app', 'writer'].includes(id) ? 'execution_boundary' : 'stage'));
  const links = [['app', 'config'], ['app', 'logs'], ['display', 'battery'], ['display', 'battery'], ['thresholds', 'fault'],
    ['display', 'aux'], ['battery', 'fault'], ['battery', 'hal'], ['peers', 'battery'], ['power', 'battery'], ['power', 'pcs'],
    ['pcs', 'hal'], ['aux', 'hal'], ['ems', 'hal'], ['wave', 'fault'], ['wave', 'ring'], ['persist-q', 'writer'],
    ['writer', 'csv'], ['events', 'battery'], ['events', 'event-lib']];
  const r = fixture(nodes, links.map(([a, b], i) => edge('transfer-' + i, a, b)));
  for (const columns of [4, 5, 6]) {
    const m = architectureMap(r, '', columns);
    assert.deepEqual(m.layers.map(l => l.roots.length), [6, 6, 9]);
    assert.ok(m.layers[2].roots.includes('writer'));
    assert.equal(new Set([...m.boxes.values()].map(b => b.y)).size, columns === 6 ? 4 : columns === 5 ? 6 : 7);
    assert.ok(m.height <= 1100 && m.width <= columns * 224 + 32);
    for (const b of m.boxes.values()) assert.deepEqual([b.width, b.height], [204, 82]);
    assert.equal(m.degrees.get('battery'), 7);
    assert.ok(m.hubs.has('battery'));
    assert.ok(m.layers[1].roots.includes('wave'));
    assert.ok(m.layers[1].roots.includes('events'));
    if (columns === 6) {
      for (const layer of m.layers.slice(0, 2)) assert.equal(new Set(layer.roots.map(id => m.boxes.get(id)!.y)).size, 1);
      const rows = new Map<number, number>();
      for (const id of m.layers[2].roots) { const y = m.boxes.get(id)!.y; rows.set(y, (rows.get(y) ?? 0) + 1); }
      assert.deepEqual([...rows.values()], [5, 4]);
    }
    assert.notEqual(m.links[2].path, m.links[3].path);
    checkGeometry(m);
  }
});

test('crowded parallel captions remain readable when their individual relationship is focused', () => {
  const m = architectureMap(fixture([node('entry'), node('core')],
    Array.from({ length: 30 }, (_, i) => edge('parallel-transfer-' + i, 'entry', 'core'))));
  assert.ok(m.links.some(link => link.singleEdgeLabel));
  checkGeometry(m);
});

test('affinity ordering aligns crossed pairs across adjacent tiers', () => {
  const m = architectureMap(fixture([node('left'), node('right'), node('b'), node('a')],
    [edge('one', 'left', 'a'), edge('two', 'right', 'b')]));
  assert.equal(m.boxes.get('left')!.x, m.boxes.get('a')!.x);
  assert.equal(m.boxes.get('right')!.x, m.boxes.get('b')!.x);
});

test('layered cards show responsibility and feature counts while detailed evidence stays off the canvas', () => {
  const component = { ...node('控制器'), description: '汇总并执行控制命令', evidence_ids: ['e'], inputs: [{ name: '采样结果' }], outputs: [{ name: '设定值' }] };
  const initial = fixture([component, node('设备', undefined, 'resource')], [{ ...edge('下发', '控制器', '设备'), transfers: [{ label: '功率指令' }] }]);
  const result = { ...initial, nodes: [...initial.nodes, { ...node('功率调节'), evidence_ids: ['e'] }],
    evidence: [{ evidence_id: 'e', source_snapshot_id: 'snapshot', path: 'app/control.cpp' }],
    feature_catalog: { groups: [{ label: '控制', node_ids: ['功率调节'] }] },
  } as unknown as AnalysisResult;
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(Architecture, { result, selected: '控制器', select: noop, inspect: noop, modules: noop, zoom: 1, search: '' }));
  for (const label of ['系统架构图', '分层架构图', '协作关系表', '代码模块依赖（静态索引）', '汇总并执行控制命令', '功能', '关系',
    '已分析控制链路', '控制命令入口', '设备运行状态', 'data-component-id="控制器"', 'data-edge-id="下发"', 'aria-pressed="true"']) {
    assert.ok(html.includes(label), label);
  }
  for (const detail of ['app/control.cpp', '采样结果', '设定值', '<table']) assert.ok(!html.includes(detail), detail);
});
