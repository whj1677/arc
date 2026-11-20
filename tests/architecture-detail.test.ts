import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '../src/shared';
import { componentContext } from '../src/ui/architecture-context';
import { SystemDetail } from '../src/ui/SystemDetail';

const node = (node_id: string, label: string, evidence_ids: string[]) => ({
  node_id, label, description: '根据采样值更新电池状态', evidence_ids, kind: 'stage', inputs: [], outputs: [], claim_ids: [],
});
const edge = (edge_id: string, source_node_id: string, target_node_id: string) => ({
  edge_id, source_node_id, target_node_id, kind: 'data_publish', label: edge_id, status: 'source_supported', claim_ids: ['claim'], evidence_ids: ['core'],
});
const file = (evidence_id: string, path: string, source_snapshot_id = 's') => ({
  evidence_id, path, source_snapshot_id, line_start: 11, line_end: 13, note: '更新电池状态',
});
const result = {
  binding: { source_snapshot_id: 's' },
  architecture: { node_ids: ['entry', 'core', 'cache', 'child'], edge_ids: ['samples', 'publish'] },
  nodes: [node('entry', '采样入口', []),
    {...node('core', '电池控制', ['core', 'root']), inputs: [{io_id: 'sample', name: '采样值', description: '电压'}], outputs: [{io_id: 'state', name: '状态字', description: '状态字'}]},
    {...node('child', '阈值检查', []), parent_node_id: 'core'},
    {...node('cache', '缓存', []), inputs: [{io_id: 'receive', name: '状态快照', description: '状态快照'}]},
    node('feature', '单体均衡', ['near']), node('reading', '温差报警', []),
    node('other', '其他目录', ['prefix']), node('legacy', '历史记录', ['old']), node('root-feature', '根目录其他文件', ['other-root'])],
  edges: [edge('samples', 'entry', 'core'), {...edge('publish', 'core', 'cache'), transfers: [{label: '最新状态', source_output_id: 'state', target_input_id: 'receive'}]}],
  feature_catalog: {groups: [{node_ids: ['feature', 'reading', 'other', 'legacy', 'root-feature']}],
    readings: [{node_id: 'reading', steps: [{evidence_ids: ['core']}]}]},
  claims: [{claim_id: 'claim', statement: '静态发布点可定位', limitations: ['未测运行频率']}],
  evidence: [file('core','app/battery/state.cpp'),file('near','app/battery/balance.cpp'),file('prefix','app/battery2/state.cpp'),
    file('old','app/battery/legacy.cpp','old-snapshot'),file('root','CMakeLists.txt'),file('other-root','main.cpp')],
} as unknown as AnalysisResult;

function detail(selected: string) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(SystemDetail, {result, selected, select: noop, inspect: noop, openFeature: noop, openEvidence: noop}));
}

test('component detail links only source-related features in its snapshot and shows both directions', () => {
  const core = result.nodes[1];
  assert.deepEqual(componentContext(core, result).features.map(n => n.node_id), ['feature', 'reading']);
  const html = detail('core');
  for (const text of ['根据采样值更新电池状态', 'app/battery/state.cpp', '阈值检查', '单体均衡', '温差报警', '采样值', '状态字'])
    assert.ok(html.includes(text), text);
  assert.match(html, /指向 \/ 调用 · 1[\s\S]*?data-edge-id="publish"[\s\S]*?缓存/);
  assert.match(html, /来自 \/ 被调用 · 1[\s\S]*?data-edge-id="samples"[\s\S]*?采样入口/);
});
test('edge detail exposes both endpoints, transfer, evidence and claim limits', () => {
  const html = detail('edge/publish');
  for (const text of ['数据发布', '电池控制', '缓存', '最新状态', '状态字', '状态快照', '1 个文件 · 1 处依据', 'app/battery/state.cpp', '未测运行频率'])
    assert.ok(html.includes(text), text);
});
