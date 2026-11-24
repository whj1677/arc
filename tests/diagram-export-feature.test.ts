import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AnalysisResult, Explanation, ReadingGuide, Snapshot } from '../src/shared';
import { availableFeatureViews, featurePaths, featureViewNames, renderFeatureDataflowSvg } from '../src/export/feature-svg';

const base: AnalysisResult = JSON.parse(readFileSync('examples/analysis-result.json', 'utf8'));
const longAction = '读取并校验等待保存的配置参数'.repeat(20) + '<完成>&';
const step = (id: string, title: string, actor: string, node: string) => ({
  id, title, actor, text: '执行' + title, detail: '', outcome: '已处理', node_ids: [node], evidence_ids: [],
});
const role = (id: string, title: string) => ({ id, title, duty: title + '职责', files: [], evidence_ids: [] });
const path: ReadingGuide['paths'][number] = {
  id: 'main', label: '配置写入', entry: '', intro: '', boundary: '', step_ids: [],
  lanes: [{ label: '设备接收通道', step_ids: ['start', 'save'], link_labels: ['校验通过后'] }],
  failure_ids: ['fail'], role_ids: ['client', 'server'], handoff_ids: ['handoff'], files: [],
};
const guide: ReadingGuide = {
  steps: [{ ...step('start', '读取配置', '调度员', 'node-handler'), text: longAction }, step('save', '保存配置', '控制器', 'node-apply'),
    step('fail', '处理失败', '控制器', 'node-ack-decision'), step('other', '另一条专有路径', '归档员', 'node-storage')],
  roles: [role('client', '请求端'), role('server', '执行端'), role('other-role', '归档端')],
  handoffs: [{ id: 'handoff', from: 'client', to: 'server', label: '交付配置', send: '配置载荷', receive: '写入请求', kind: '传递', detail: '', evidence_ids: [] }],
  files: [], paths: [path, { ...path, id: 'archive', label: '历史归档', lanes: [], step_ids: ['other'],
    role_ids: [], handoff_ids: [], failure_ids: [] }],
};
const fnStep = (id: string, kind: 'call' | 'return' | 'dispatch', from: string, to: string) => ({
  id, kind, from_node_id: from, to_node_id: to, text: id, input: '调用参数', output: '处理结果', condition: '', evidence_ids: [],
});
const [handler, apply] = base.nodes;
const explanation: Explanation = {
  result_id: 'saved-result-3', source_status: 'needs_review', scenario_id: base.binding.scenario_id, created_at: '2026-10-02T08:00:00Z',
  result: { ...base, result_id: 'saved-result-3', reading_guide: guide,
    nodes: base.nodes.map(n => n === apply ? { ...n, function_details: { symbol: 'config_apply', signature: null,
      definition_evidence_id: 'ev-apply', parameter_io_ids: [], return_io_ids: [] } } : n),
    edges: [...base.edges.map(e => e.edge_id === 'edge-call-apply' ? { ...e,
      transfers: [{ label: '配置数据包', source_output_id: 'out', target_input_id: 'in', status: 'source_supported' as const, claim_ids: [], evidence_ids: [] }] } : e),
    { ...base.edges[0], edge_id: 'on-error', target_node_id: 'node-ack-decision', kind: 'control_flow', flow_role: 'exception', condition: '提交冲突' }],
    function_walkthroughs: [{ id: 'entry', label: '代码入口', trigger: '', entry_node_id: handler.node_id, boundary: '', evidence_ids: [],
      steps: [fnStep('invoke', 'call', handler.node_id, apply.node_id), fnStep('recurse', 'call', apply.node_id, apply.node_id),
        fnStep('dispatch', 'dispatch', apply.node_id, handler.node_id), fnStep('done', 'return', apply.node_id, handler.node_id)] }],
  },
};
const params = { explanation, projectName: '测试工程', featureName: '配置同步', scenarioTitle: '提交' };
const plain = (svg: string) => svg.replace(/<[^>]*>/g, '');

test('every available saved feature view produces deterministic standalone XML and the same version metadata', () => {
  const views = availableFeatureViews(explanation);
  assert.deepEqual(views, Object.keys(featureViewNames));
  const before = JSON.stringify(explanation);
  for (const diagramView of views) {
    const drawing = renderFeatureDataflowSvg({ ...params, diagramView });
    assert.deepEqual(drawing, renderFeatureDataflowSvg({ ...params, diagramView }));
    assert.match(drawing.svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.doesNotMatch(drawing.svg, /foreignObject|var\(--|context-stroke|class=|NaN|undefined|Infinity/);
    assert.equal((drawing.svg.match(/<svg\b/g) || []).length, 1);
    const text = plain(drawing.svg);
    for (const phrase of ['测试工程', '配置同步', '提交', featureViewNames[diagramView], '图例', 'saved-result-3', 'snapshot-demo-a', 'needs_review', '待复核']) assert.ok(text.includes(phrase), phrase);
    assert.ok(drawing.width > 0 && drawing.height > 0);
  }
  assert.equal(JSON.stringify(explanation), before);
});

test('business export preserves the selected ordered lane, actor, payload and only supported failure links', () => {
  const drawing = renderFeatureDataflowSvg(params);
  const text = plain(drawing.svg);
  for (const phrase of ['设备接收通道', '步骤 1', '调度员', '校验通过后', '配置数据包', '已处理', '提交冲突', '处理失败']) assert.ok(text.includes(phrase), phrase);
  assert.ok(!text.includes('另一条专有路径'));
  assert.match(drawing.svg, /data-edge-id="on-error"[^>]+stroke-dasharray="6 4"[^>]+url\(#arrow-exception\)/);
  assert.deepEqual([drawing.nodeCount, drawing.edgeCount], [3, 2]);
  const firstCard = drawing.svg.match(/<g data-step-id="start">(<rect[^>]+>)([\s\S]*?)<\/g>/)!;
  const height = Number(firstCard[1].match(/height="([\d.]+)"/)![1]);
  const baselines = [...firstCard[2].matchAll(/<tspan x="0" y="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.ok(height > 250 && baselines.length > 10 && Math.max(...baselines) < height - 12);
  assert.ok(text.includes(longAction.replace('<完成>&', '&lt;完成&gt;&amp;')));
  const other = renderFeatureDataflowSvg({ ...params, pathId: 'archive' });
  assert.deepEqual([other.nodeCount, other.edgeCount], [1, 0]);
  assert.doesNotMatch(plain(other.svg), /设备接收通道|提交冲突|配置数据包/);
});

test('collaboration, function call map, sequence and graph retain their own saved topology and labels', () => {
  const collaboration = renderFeatureDataflowSvg({ ...params, diagramView: 'collaboration' });
  assert.deepEqual([collaboration.nodeCount, collaboration.edgeCount], [2, 1]);
  for (const phrase of ['请求端职责', '执行端职责', '发送 · 配置载荷', '接收 · 写入请求']) assert.ok(plain(collaboration.svg).includes(phrase));
  assert.doesNotMatch(collaboration.svg, /归档端/);
  const calls = renderFeatureDataflowSvg({ ...params, diagramView: 'call_map' });
  assert.deepEqual([calls.nodeCount, calls.edgeCount], [2, 3]);
  assert.match(calls.svg, /data-edge-id="call-step:entry:recurse" d="M[^"]+ C/);
  for (const phrase of ['递归调用', '调用参数', 'src/config_apply.c']) assert.ok(plain(calls.svg).includes(phrase));
  const sequence = renderFeatureDataflowSvg({ ...params, diagramView: 'call_chain' });
  assert.deepEqual([sequence.nodeCount, sequence.edgeCount], [2, 4]);
  assert.match(sequence.svg, /data-edge-id="dispatch"[^>]+url\(#arrow-external\)/);
  assert.match(sequence.svg, /data-edge-id="done"[^>]+url\(#arrow-return\)/);
  assert.ok(sequence.svg.indexOf('data-participant=') < sequence.svg.indexOf('data-edge-id="invoke"'));
  const graph = renderFeatureDataflowSvg({ ...params, diagramView: 'graph' });
  assert.deepEqual([graph.nodeCount, graph.edgeCount], [base.nodes.length, explanation.result.edges.length]);
  assert.ok(plain(graph.svg).includes('传递 · 配置数据包'));
});

test('export offers only data-backed views and rejects stale paths or a mismatched source snapshot', () => {
  assert.deepEqual(featurePaths(explanation, 'collaboration').map(p => p.id), ['main']);
  assert.deepEqual(featurePaths(explanation, 'call_chain').map(p => p.id), ['entry']);
  assert.deepEqual(availableFeatureViews({ ...explanation, result: { ...base, function_walkthroughs: [], reading_guide: undefined } }), ['call_map', 'graph']);
  for (const view of ['business_flow', 'collaboration', 'call_map', 'call_chain'] as const) {
    assert.throws(() => renderFeatureDataflowSvg({ ...params, diagramView: view, pathId: 'stale' }), /路径/);
  }
  assert.throws(() => renderFeatureDataflowSvg({ ...params, snapshot: { source_snapshot_id: 'different' } as Snapshot }), /快照/);
});

test('older compact graphs export the same evidence-bound collaboration view as the reading workspace', () => {
  const result_id = 'feature-graph-' + 'a'.repeat(32);
  const legacy = { ...explanation, result_id, result: { ...explanation.result, result_id,
    evidence: [...base.evidence, { ...base.evidence[1], evidence_id: 'test-handler-definition', role: 'definition' as const }],
    nodes: [handler, apply].map((n, i) => ({ ...n, function_details: { symbol: n.label,
      signature: null, definition_evidence_id: i ? 'ev-apply' : 'test-handler-definition', parameter_io_ids: [], return_io_ids: [] } })),
    reading_guide: { ...guide, roles: [], handoffs: [], paths: [{ ...path, intro: '配置已写入' }] },
  } };
  assert.ok(availableFeatureViews(legacy).includes('collaboration'));
  const output = renderFeatureDataflowSvg({ ...params, explanation: legacy, diagramView: 'collaboration' });
  assert.equal(output.nodeCount, 2);
  assert.equal(output.edgeCount, 1);
  assert.match(plain(output.svg), /config_apply.c/);
});
