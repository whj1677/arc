import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '../src/shared';
import { Architecture } from '../src/ui/Architecture';
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
  assert.deepEqual(m.layers.map(t => t.id), ['core']);
  assert.deepEqual(m.layers[0].roots, ['a', 'b', 'alone']);
});

test('a high-degree queue stays in infrastructure and every routing segment avoids card interiors', () => {
  const nodes = [node('isolated'), node('entry'), node('core'), node('queue', undefined, 'resource'), node('worker'), node('sink', undefined, 'resource'), node('internal', 'core')];
  const edges = [edge('start', 'entry', 'core'), edge('write', 'core', 'queue'), edge('read', 'queue', 'worker'), edge('persist', 'queue', 'sink'),
    edge('ack', 'sink', 'queue'), edge('self', 'core', 'core'), edge('inner', 'internal', 'core')];
  for (const columns of [1, 2, 3]) {
    const m = architectureMap(fixture(nodes, edges), '', columns);
    assert.deepEqual(m.layers.map(t => t.id), ['boundary', 'core', 'infrastructure']);
    assert.ok(m.layers[2].roots.includes('queue'));
    assert.deepEqual(m.layers[1].roots, ['core', 'isolated']);
    assert.ok(m.layers[0].y + m.layers[0].height < m.layers[1].y);
    assert.ok(m.layers[1].y + m.layers[1].height < m.layers[2].y);
    for (const [id, a] of m.boxes) {
      for (const [other, b] of m.boxes) {
        if (id !== other) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
      }
      for (const { points } of m.links) {
        for (let i = 1; i < points.length; i++) {
          const [x1, y1] = points[i - 1], [x2, y2] = points[i];
          assert.ok(x1 === x2 || y1 === y2);
          assert.ok(Math.max(x1, x2) <= a.x || Math.min(x1, x2) >= a.x + a.width ||
            Math.max(y1, y2) <= a.y || Math.min(y1, y2) >= a.y + a.height, 'Connector enters ' + id);
        }
      }
    }
  }
});

test('layered view renders evidence paths, responsibility, I/O, matched features and a selectable relation table', () => {
  const component = { ...node('控制器'), description: '汇总并执行控制命令', evidence_ids: ['e'], inputs: [{ name: '采样结果' }], outputs: [{ name: '设定值' }] };
  const initial = fixture([component, node('设备', undefined, 'resource')], [{ ...edge('下发', '控制器', '设备'), transfers: [{ label: '功率指令' }] }]);
  const result = { ...initial, nodes: [...initial.nodes, { ...node('功率调节'), evidence_ids: ['e'] }],
    evidence: [{ evidence_id: 'e', source_snapshot_id: 'snapshot', path: 'app/control.cpp' }],
    feature_catalog: { groups: [{ label: '控制', node_ids: ['功率调节'] }] },
  } as unknown as AnalysisResult;
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(Architecture, { result, selected: '控制器', select: noop, inspect: noop, modules: noop, zoom: 1, search: '' }));
  for (const label of ['系统架构图', '代码模块依赖（静态索引）', '控制/业务', '汇总并执行控制命令', 'app/control.cpp', '项功能', '采样结果',
    '设定值', '组件协作关系表', '同步调用', '功率指令', '已分析控制链路', '控制命令入口', '设备运行状态',
    'data-component-id="控制器"', 'data-edge-id="下发"', 'aria-pressed="true"']) assert.ok(html.includes(label), label);
});
