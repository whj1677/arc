import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArchitectureDocument, ArchitectureModule, ArchitectureRelation } from '../src/architecture-workspace';
import { architectureExportStatus, computeArchitectureScope, computeModuleSubgraph, escapeXml, renderArchitectureSubgraphSvg,
  renderArchitectureSvg, svgText, svgTextWidth, wrapSvgLines } from '../src/export/diagram-svg';
import { overlaps } from '../src/ui/flow-layout';

const at = '2026-04-10T10:00:00Z';
const longTitle = '人工维护的模块<调度与统计>采集通道＆结果校核'.repeat(3);
function module(id: string, name: string, options: Partial<ArchitectureModule> = {}): ArchitectureModule {
  return { id, name, kind: 'stage', layer: 'core', summary: '汇总并传递电池温度', code_links: [], evidence: [],
    origin: 'code_analysis', implementation_status: 'implemented', updated_at: at, ...options };
}
function edge(id: string, from: string, to: string, label: string, options: Partial<ArchitectureRelation> = {}): ArchitectureRelation {
  return { id, from, to, label, kind: 'dependency', origin: 'code_analysis', status: 'confirmed', evidence: [], updated_at: at, ...options };
}
function fixture(): ArchitectureDocument {
  return {
    id: 'arc', project_id: 'project', branch_key: 'main', version: 3, title: '采样系统架构', summary: '',
    modules: [module('entry', '采样端', { layer: 'entry' }), module('core', longTitle, { implementation_status: 'planned', origin: 'manual' }),
      module('child', '核心计算', { parent_id: 'core', analysis_status: 'failed', origin: 'needs_verification' }),
      module('queue', '队列', { layer: 'foundation', analysis_status: 'needs_review' }),
      module('sink', '落盘存储', { layer: 'foundation' }), module('secret', '隐藏名字', { hidden: true })],
    relations: [edge('begin', 'entry', 'core', '读取输入'), edge('down', 'core', 'child', '下达指令'),
      edge('up', 'child', 'core', '返回结果', { kind: 'return' }),
      edge('publish', 'child', 'queue', '投递结果', { status: 'needs_verification' }),
      edge('save', 'queue', 'sink', '持久化'), edge('hid', 'core', 'secret', '不可见边'), edge('removed', 'child', 'queue', '手工隐藏边', { hidden: true })],
    layout: { positions: { sink: { x: 2700, y: -180 } }, manual_positions: ['sink'] },
    exclusions: [], update_status: 'partial', baseline: { snapshot_id: 'frozen-snap', branch: 'main', commit: 'abc123',
      fingerprint: 'fingerprint', dirty: false, captured_at: at, file_hashes: {}, workspace_fingerprint: 'fp' },
    review_items: [{ id: 'suggest', category: 'relation_add', status: 'pending', title: '未采纳候选关系',
      proposed: { id: 'PROPOSAL_ONLY', from: 'core', to: 'queue', label: '待决关系文本' }, scope_summary: '',
      dedupe_key: '', evidence_fingerprint: '', code_baseline_fingerprint: '', evidence: [], created_at: at }],
    last_confirmed_version: 1, created_at: at, updated_at: at,
  };
}

function svgRects(svg: string, tag: string) {
  const pattern = new RegExp(`<g ${tag}="([^"]+)"[^>]*><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, 'g');
  return new Map([...svg.matchAll(pattern)].map(([, id, x, y, width, height]) =>
    [id, { x: +x, y: +y, width: +width, height: +height }]));
}

test('CJK, ASCII and XML-special characters survive multiline SVG text', () => {
  const content = '控制ＡＢ<工程> & QueueBuffer_LONG1234';
  const lines = wrapSvgLines(content, 76, 14);
  assert.equal(lines.join(''), content);
  assert.ok(lines.length > 1 && lines.every(l => svgTextWidth(l, 14) <= 76));
  assert.deepEqual(wrapSvgLines('电池温度', 28, 14), ['电池', '温度']);
  assert.deepEqual(wrapSvgLines('1234', 34, 14), ['1234']);
  assert.equal(escapeXml('<&>"\''), '&lt;&amp;&gt;&quot;&apos;');
  const wide = wrapSvgLines('wmwmwmmwwm模块', 42, 14);
  for (const mono of [false, true]) {
    const text = svgText(wide, 0, 14, 14, { mono });
    const widths = [...text.matchAll(/textLength="([\d.]+)" lengthAdjust="spacingAndGlyphs"/g)].map(m => Number(m[1]));
    assert.equal(widths.length, wide.length);
    assert.ok(widths.every(w => w > 0 && w <= 42));
  }
});

test('A16 whole SVG is deterministic, offscreen-inclusive, standalone and faithful to saved status', () => {
  const doc = fixture(), before = structuredClone(doc);
  const out = renderArchitectureSvg({ doc, projectName: '储能 & 测试', includeHidden: false, exportedAt: at });
  assert.deepEqual(doc, before);
  assert.deepEqual(renderArchitectureSvg({ doc, projectName: '储能 & 测试', exportedAt: at }), out);
  assert.deepEqual([out.nodeCount, out.edgeCount, out.externalBoundaryCount], [5, 5, 0]);
  assert.ok(out.width > 2900);
  assert.match(out.svg, /data-component-id="sink"><rect x="2700" y="-180"/);
  assert.match(out.svg, /data-parent-id="core"/);
  assert.match(out.svg, /data-edge-id="up"[^>]+data-from="child" data-to="core"[^>]+ C[^>]+url\(#arrow-return\)/);
  for (const kind of ['default', 'external', 'uncertain', 'exception', 'return'])
    assert.match(out.svg, new RegExp('<marker id="arrow-' + kind + '"[^>]*><path[^>]*fill="#[0-9a-f]{6}"'));
  for (const badge of ['规划中', '人工补充', '待核实', '待复核', '部分完成', '更新失败', '需人工复核（1项）'])
    assert.ok(out.svg.includes(badge), badge);
  for (const text of ['图例', 'frozen-snap', 'abc123', 'v3', '储能 &amp; 测试', 'Microsoft YaHei UI', '入口与交互层', '核心业务与控制层', '存储、队列与底层支撑'])
    assert.ok(out.svg.includes(text), text);
  assert.ok(out.svg.replace(/<[^>]+>/g, '').includes(escapeXml(longTitle)));
  const occupied = [...svgRects(out.svg, 'data-component-id').values()];
  const captions = svgRects(out.svg, 'data-edge-label');
  assert.equal(captions.size, out.edgeCount);
  for (const b of captions.values()) {
    assert.ok(occupied.every(other => !overlaps(b, other)));
    occupied.push(b);
  }
  assert.doesNotMatch(out.svg, /<foreignObject|class=|var\(--|context-stroke|隐藏名字|不可见边|手工隐藏边|PROPOSAL_ONLY|未采纳候选关系|待决关系文本/);
  assert.equal(computeArchitectureScope(doc).hiddenExcludedCount, 3);
  assert.equal(computeArchitectureScope(doc, '持久化').includedModules.length, 2);
  assert.equal(renderArchitectureSvg({ doc, search: '持久化', projectName: '工程' }).edgeCount, 1);
  assert.match(architectureExportStatus({ ...doc, update_status: 'changes_pending' }), /有变化待分析/);
});

test('module subgraph preview and export retain directional external endpoints at each selected radius', () => {
  const doc = fixture();
  const scope = computeModuleSubgraph(doc, 'core');
  assert.deepEqual(scope.includedModules.map(m => m.id), ['core', 'child']);
  assert.deepEqual(scope.internalRelations.map(r => r.id), ['down', 'up']);
  assert.deepEqual(scope.externalInbound.map(r => r.id), ['begin']);
  assert.deepEqual(scope.externalOutbound.map(r => r.id), ['publish']);
  assert.equal(scope.hiddenExcludedCount, 3);
  const { svg, nodeCount, edgeCount, externalBoundaryCount } = renderArchitectureSubgraphSvg({ doc, rootModuleId: 'core', projectName: '项目' });
  assert.deepEqual([nodeCount, edgeCount, externalBoundaryCount], [2, 4, 2]);
  for (const r of [...scope.externalInbound, ...scope.externalOutbound]) {
    const outside = r.id === 'begin' ? r.from : r.to;
    assert.ok(svg.includes(`data-boundary-relation="${r.id}" data-external-module="${outside}"`));
    assert.match(svg, new RegExp(`data-edge-id="${r.id}" data-from="${r.from}" data-to="${r.to}"[^>]+marker-end="url\\(#arrow-external\\)"`));
    const b = svgRects(svg, 'data-boundary-relation').get(r.id)!;
    const inside = svgRects(svg, 'data-component-id').get(outside === r.from ? r.to : r.from)!;
    const d = svg.match(new RegExp(`data-edge-id="${r.id}"[^>]* d="([^"]+)"`))![1];
    const numbers = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const ports = [...numbers.slice(0, 2), ...numbers.slice(-2)];
    assert.deepEqual(ports, outside === r.from
      ? [b.x + b.width, b.y + b.height / 2, inside.x, inside.y + inside.height / 2]
      : [inside.x + inside.width, inside.y + inside.height / 2, b.x, b.y + b.height / 2]);
  }
  assert.ok(svg.includes('[外部] 采样端') && svg.includes('[外部] 队列'));
  assert.doesNotMatch(svg, /data-component-id="entry"|data-component-id="queue"|落盘存储|隐藏名字/);
  assert.deepEqual(computeModuleSubgraph(doc, 'core', { includeChildren: false }).includedModules.map(m => m.id), ['core']);
  const neighbors = renderArchitectureSvg({ doc, selectedModuleId: 'core', subgraphOptions: { includeNeighbors: true }, projectName: '项目' });
  assert.deepEqual([neighbors.nodeCount, neighbors.edgeCount, neighbors.externalBoundaryCount], [4, 5, 1]);
  assert.ok(neighbors.svg.includes('[外部] 落盘存储'));
  assert.throws(() => computeModuleSubgraph(doc, 'secret'), /可见范围/);
});
