import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '../src/shared';
import { componentContext } from '../src/ui/architecture-context';
import { Architecture } from '../src/ui/Architecture';
import { architectureDocumentToAnalysisResult, applyModuleDelete, type ArchitectureModule, type ArchitectureRelation, type ArchitectureDocument } from '../src/architecture-workspace';
import type { ArchitectureEditor } from '../src/ui/useArchitectureDocument';
import { DeleteImpactDetails, draftDeleteImpact } from '../src/ui/ArchitectureDeleteDialog';
import { reviseRelation } from '../src/ui/ArchitectureDetailFields';
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
  summary: { text: '电池控制架构' }, coverage: { covered_scope: [], unresolved_scope: [] },
  architecture: { node_ids: ['entry', 'core', 'cache', 'child', 'store'], edge_ids: ['samples', 'publish', 'archive'] },
  nodes: [node('entry', '采样入口', []),
    {...node('core', '电池控制', ['core', 'root']), inputs: [{io_id: 'sample', name: '采样值', description: '电压'}], outputs: [{io_id: 'state', name: '状态字', description: '状态字'}]},
    {...node('child', '阈值检查', []), parent_node_id: 'core'},
    {...node('cache', '缓存', []), inputs: [{io_id: 'receive', name: '状态快照', description: '状态快照'}]},
    node('store', '历史库', []), node('feature', '单体均衡', ['near']), node('reading', '温差报警', []),
    node('other', '其他目录', ['prefix']), node('legacy', '历史记录', ['old']), node('root-feature', '根目录其他文件', ['other-root'])],
  edges: [edge('samples', 'entry', 'core'), {...edge('publish', 'core', 'cache'), transfers: [{label: '最新状态', source_output_id: 'state', target_input_id: 'receive'}]}, edge('archive', 'child', 'store')],
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

test('a saved component selection highlights direct neighbors and directional labels without hovering', () => {
  const noop = () => {};
  const markup = (selected: string) => renderToStaticMarkup(createElement(Architecture, {
    result, selected, select: noop, inspect: noop, modules: noop, zoom: 1, search: '',
  }));
  const html = markup('core');
  assert.match(html, /自动连线/);
  assert.match(html, /仅聚焦显线/);
  assert.match(html, /点击右下角缩放比例恢复 100%/);
  assert.match(html, /已聚焦：电池控制（2 条关联）/);
  assert.match(html, /显示全部/);
  for (const [edgeId, state] of [['samples', 'incoming'], ['publish', 'outgoing'], ['archive', 'dimmed']]) {
    const link = html.match(new RegExp('<g [^>]*data-edge-id="' + edgeId + '"[^>]*>'))?.[0] ?? '';
    assert.match(link, new RegExp('\\b' + state + '\\b'));
  }
  const dimmed = [...html.matchAll(/<foreignObject [^>]*data-component-id="([^"]+)"[^>]*class="architecture-node-dimmed"/g)];
  assert.deepEqual(dimmed.map(match => match[1]).sort(), ['child', 'store']);
  assert.equal((html.match(/class="architecture-edge-caption/g) ?? []).length, 2);
  assert.doesNotMatch(markup('feature'), /显示全部|architecture-node-dimmed|architecture-edge-caption/);
});

test('architecture selection survives leaving the card and the three views remain independently navigable', async t => {
  const scratch = path.resolve('.test-data');
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'architecture-ui-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Architecture } from './src/ui/Architecture';
      import './src/ui/architecture-map.css';
      window.arc = { invoke: async () => ({ modules: [], module_edges: [], total_files: 0, total_symbols: 0, total_calls: 0 }) };
      function Fixture() {
        const [selected, select] = useState(''), [search, setSearch] = useState('');
        return <><input aria-label="搜索" value={search} onChange={e => setSearch(e.target.value)} />
          <Architecture result={${JSON.stringify(result)}} selected={selected} select={select} search={search}
            inspect={() => {}} modules={() => {}} zoom={1} /></>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    ` },
    bundle: true, outfile: path.join(directory, 'fixture.js'),
  });
  const html = path.join(directory, 'index.html');
  await fs.writeFile(html, '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><main id="root"></main><script src="fixture.js"></script>');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  const app = await _electron.launch({ args: [`--user-data-dir=${path.join(directory, 'profile')}`, html], env });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    const views = page.getByRole('group', { name: '架构视图' });
    const layers = views.getByRole('button', { name: '分层架构图' });
    const canvas = page.getByRole('group', { name: '系统架构图', exact: true });
    const core = canvas.locator('[data-component-id="core"] button');
    const reset = page.getByRole('button', { name: '显示全部', exact: true });
    const search = page.getByRole('textbox', { name: '搜索' });
    assert.equal(await layers.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('table').count(), 0);
    const focusOnly = page.getByRole('button', { name: '仅聚焦显线' });
    await focusOnly.click();
    assert.equal(await canvas.locator('.architecture-link.hidden-resting').count(), 3);
    await core.click();
    assert.equal(await canvas.locator('.architecture-link.incoming').count(), 1);
    assert.equal(await canvas.locator('.architecture-link.outgoing').count(), 1);
    await search.click(); // Move both pointer and keyboard focus away from the chosen card.
    assert.equal(await core.getAttribute('aria-pressed'), 'true');
    assert.equal(await canvas.locator('.architecture-node-dimmed').count(), 2);
    assert.deepEqual((await canvas.locator('.architecture-edge-caption').allTextContents()).sort(), ['publish', 'samples']);
    await reset.click();
    assert.equal(await canvas.locator('.architecture-node-dimmed').count(), 0);
    assert.equal(await core.getAttribute('aria-pressed'), 'false');
    await views.getByRole('button', { name: /协作关系表.*3/ }).click();
    const table = page.getByRole('table');
    assert.equal(await canvas.count(), 0);
    assert.equal(await table.locator('tbody tr').count(), 3);
    await search.fill('最新状态');
    const rows = table.locator('tbody tr');
    assert.equal(await rows.count(), 1);
    assert.match(await rows.innerText(), /最新状态/);
    await rows.getByRole('button').click();
    await search.fill('');
    await views.getByRole('button', { name: '代码模块依赖（静态索引）' }).click();
    await page.getByRole('region', { name: '代码模块依赖（静态索引）' }).waitFor();
    assert.equal(await table.count(), 0);
    await layers.click();
    assert.equal(await canvas.locator('[data-edge-id="publish"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await canvas.locator('.architecture-edge-caption').allTextContents(), ['publish']);
    await canvas.click({ position: { x: 1, y: 1 } });
    assert.equal(await reset.count(), 0);
    assert.equal(await canvas.locator('[aria-pressed="true"]').count(), 0);
  } finally {
    await app.close();
  }
});

test('maintained detail separates manual descriptions, linked code and frozen evidence', () => {
  const module: ArchitectureModule = { id: 'planned', name: '规划调度', kind: 'stage', layer: 'entry', summary: '计划下发指令',
    notes: '待实施接口', code_links: [], evidence: [], origin: 'manual', implementation_status: 'planned', updated_at: 'now' };
  const doc = makeDocument([module], []);
  const editor = { doc, savedDoc: doc, editMode: false } as ArchitectureEditor;
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(SystemDetail, {
    editor, selected: module.id, result: architectureDocumentToAnalysisResult(doc),
    select: noop, inspect: noop, openFeature: noop, openEvidence: noop,
  }));
  for (const label of ['人工补充', '规划中', '入口层', '父模块', '计划下发指令', '人工说明', '待实施接口', '代码关联', '代码依据'])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /已实现/);
});

function makeDocument(modules: ArchitectureModule[], relations: ArchitectureRelation[]): ArchitectureDocument {
  return { id: 'doc', project_id: 'p', branch_key: 'main', version: 1, title: '架构', summary: '',
    modules, relations, layout: { positions: {}, manual_positions: [] }, exclusions: [], review_items: [],
    update_status: 'up_to_date', created_at: 'now', updated_at: 'now' };
}

test('delete review counts draft descendants and lists the relations removed by the selected strategy', () => {
  const template: ArchitectureModule = { id: '', name: '', kind: 'stage', layer: 'core', summary: '', code_links: [],
    evidence: [], origin: 'manual', implementation_status: 'planned', updated_at: 'now' };
  const modules = [['root'], ['draft', 'root'], ['leaf', 'draft'], ['other']].map(([id, parent_id]) => ({ ...template, id, name: id, parent_id }));
  const relation: ArchitectureRelation = { id: 'external', from: 'root', to: 'other', label: '分组协作', status: 'manual',
    kind: 'dependency', origin: 'manual', evidence: [], updated_at: 'now' };
  const doc = makeDocument(modules, [relation, { ...relation, id: 'nested', from: 'leaf', label: '新增关系' }]);
  for (const strategy of ['reparent_children', 'delete_subtree'] as const) {
    const details = draftDeleteImpact(doc, 'root', strategy);
    assert.equal(details.descendantCount, 2);
    assert.deepEqual(details.children.map(m => m.id), ['draft']);
    assert.deepEqual(details.relations.map(r => r.id), applyModuleDelete(doc, 'root', strategy).removed_relation_ids);
    const html = renderToStaticMarkup(createElement(DeleteImpactDetails, { doc, moduleId: 'root', strategy, choose: () => {},
      features: [{ id: 'f', title: '历史走读' }] }));
    for (const label of ['draft', '历史走读', '源码和功能走读数据不会被删除', '子模块移至上层', '及其子模块']) assert.ok(html.includes(label));
    assert.equal(html.includes('新增关系'), strategy === 'delete_subtree');
  }
});

test('editing endpoints releases transfer mappings bound to the previous endpoints', () => {
  const old: ArchitectureRelation = { id: 'r', from: 'a', to: 'b', label: '', kind: 'dependency', origin: 'code_analysis',
    status: 'confirmed', evidence: [], updated_at: '', transfers: [{ label: 'old pair', source_output_id: 'a-out',
      target_input_id: 'b-in', status: 'source_supported', claim_ids: [], evidence_ids: [] }] };
  assert.equal(reviseRelation(old, { notes: '说明' }).transfers, old.transfers);
  const reversed = reviseRelation(old, { from: 'b', to: 'a' });
  assert.equal(reversed.transfers, undefined);
  assert.equal(reversed.origin, 'manual_override');
  assert.equal(reversed.status, 'manual');
});
