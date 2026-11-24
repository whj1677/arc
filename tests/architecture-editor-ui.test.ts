import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { build } from 'esbuild';
import { _electron } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { architectureDocumentToAnalysisResult, type ArchitectureDocument, type ArchitectureModule, type CodeBaseline } from '../src/architecture-workspace';
import { architectureIpc } from '../src/main/architecture-ipc';
import { ArcService } from '../src/main/service';
import type { Snapshot } from '../src/shared';
import { ArchitectureEditorStore, type ArchitectureInvoke } from '../src/ui/useArchitectureDocument';
import { Architecture } from '../src/ui/Architecture';
import { moveArchitectureModule } from '../src/ui/architecture-map';

const at = '2026-01-01T00:00:00Z';
function module(id: string, name: string, parent_id?: string): ArchitectureModule {
  return { id, name, ...(parent_id ? { parent_id } : {}), kind: 'stage', layer: 'core', summary: '', code_links: [], evidence: [],
    origin: 'manual', implementation_status: 'planned', updated_at: at };
}

async function fixture(t: TestContext) {
  const scratch = path.resolve('.test-data');
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, 'architecture-editor-'));
  const service = new ArcService(dir, process.cwd());
  t.after(async () => {
    await service.shutdown();
    service.store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  service.store.put('project', 'p', { project_id: 'p', name: '控制器', root_path: dir, snapshot_id: 's',
    fictional: false, build_config: '', created_at: at });
  // The fixture owns one named branch. Keep Git discovery independent of the parent checkout.
  t.mock.method(service, 'getActiveArchitectureBranch', async () => 'fixture');
  const saves: Array<{ expected_version: unknown; document: ArchitectureDocument }> = [];
  const invoke: ArchitectureInvoke = async <T>(op: string, payload?: unknown) => {
    const args = payload as Record<string, unknown>;
    if (op === 'source') return await service.source(String(args.source_snapshot_id), String(args.path)) as T;
    if (op === 'architecture_save') saves.push({ expected_version: args.expected_version, document: args.document as ArchitectureDocument });
    return await architectureIpc(service, op as Parameters<typeof architectureIpc>[1], args) as T;
  };
  const store = new ArchitectureEditorStore('p', invoke);
  await store.load();
  assert.equal(store.getSnapshot().loadError, undefined);
  return { dir, service, store, invoke, saves };
}

test('editor state saves a small IPC payload, reopens the exact draft, cancels edits and restores an older version', async t => {
  const { store, service, invoke, saves } = await fixture(t);
  const blank = store.getSnapshot().savedDoc!;
  assert.equal(blank.version, 0);
  // Both hash maps originate in a persisted document and must outlive a save and a version restore.
  const hashes = { 'src/control.ts': 'frozen-digest' };
  const baseline: CodeBaseline = { snapshot_id: 's', fingerprint: 'f', workspace_fingerprint: 'w',
    file_hashes: hashes, dirty: false, captured_at: at };
  const first = service.store.saveArchitectureDoc({ ...blank, modules: [module('group', '控制组')], baseline,
    last_update: { id: 'u', started_at: at, base_doc_version: 0, read_baseline: baseline, post_check_consistent: true,
      detection_summary: { changed_files: [], detection_reliable: true },
      impact_summary: { mode: 'none', reason: '', affected_module_ids: [], affected_feature_ids: [], reused_module_ids: [], unmapped_files: [] },
      model_calls: 0, auto_updates: [], review_item_ids: [], module_outcomes: {}, overall_status: 'up_to_date' } }, 0);
  await store.load();
  store.enterEditMode();
  store.updateDraft(doc => ({ ...doc, modules: [...doc.modules, module('child', '规划中组件', 'group')] }));
  store.updateDraft(doc => moveArchitectureModule(doc, 'child', { x: 900, y: 600 }));
  store.applyAutoLayout(800);
  const automatic = store.getSnapshot().draftDoc!.layout;
  assert.deepEqual(automatic.manual_positions, []);
  assert.ok(automatic.positions.group);
  assert.notDeepEqual(automatic.positions.child, { x: 900, y: 600 });
  store.updateDraft(doc => moveArchitectureModule(doc, 'child', { x: 900, y: 600 }));
  const draft = store.getSnapshot().draftDoc!;
  assert.equal(store.getSnapshot().dirty, true);
  const saving = store.saveDraft();
  assert.equal(store.getSnapshot().saveState, 'saving');
  await saving;
  assert.equal(store.getSnapshot().saveState, 'saved');
  assert.equal(store.getSnapshot().dirty, false);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].expected_version, first.version);
  assert.ok(!Object.hasOwn(saves[0].document.baseline!, 'file_hashes'));
  assert.ok(!Object.hasOwn(saves[0].document.last_update!.read_baseline, 'file_hashes'));
  assert.deepEqual(store.getSnapshot().savedDoc!.baseline!.file_hashes, hashes);
  assert.deepEqual(store.getSnapshot().savedDoc!.last_update!.read_baseline.file_hashes, hashes);
  assert.deepEqual(store.getSnapshot().versions.map(v => v.version), [2, 1]);

  const reopened = new ArchitectureEditorStore('p', invoke);
  await reopened.load();
  assert.deepEqual(reopened.getSnapshot().doc!.modules, draft.modules);
  assert.deepEqual(reopened.getSnapshot().doc!.layout, draft.layout);
  reopened.enterEditMode();
  reopened.updateDraft(doc => ({ ...doc, title: '未保存修改' }));
  reopened.cancelEdit();
  assert.equal(reopened.getSnapshot().draftDoc, null);
  assert.equal(reopened.getSnapshot().doc!.title, blank.title);
  await reopened.restoreVersion(1);
  assert.equal(reopened.getSnapshot().draftDoc, null);
  assert.deepEqual(reopened.getSnapshot().versions.map(v => v.version), [3, 2, 1]);
  assert.deepEqual(reopened.getSnapshot().doc!.modules, first.modules);
});

test('editor state blocks cyclic parents before IPC and preserves a losing writer’s draft with the real conflict message', async t => {
  const { store, service, saves } = await fixture(t);
  store.enterEditMode();
  for (const parent of ['group', 'child']) {
    store.updateDraft(doc => ({ ...doc, modules: [module('group', '控制组', parent), module('child', '采样', 'group')] }));
    await store.saveDraft();
    assert.equal(store.getSnapshot().saveState, 'error');
    assert.match(store.getSnapshot().saveError!, /cycl|循环|环/i);
    assert.equal(saves.length, 0);
  }
  store.updateDraft(doc => ({ ...doc, modules: [module('group', '控制组')], title: '本地修改' }));
  const winner = service.saveArchitectureDocument('p', { ...store.getSnapshot().savedDoc!, title: '其他窗口修改' }, 0);
  await store.saveDraft();
  const failed = store.getSnapshot();
  assert.equal(failed.saveState, 'error');
  assert.match(failed.saveError!, /Architecture document version conflict/);
  assert.equal(failed.dirty, true);
  assert.equal(failed.editMode, true);
  assert.equal(failed.draftDoc!.title, '本地修改');
  assert.equal(failed.savedDoc!.version, 0);
  assert.equal(saves.length, 1);
  assert.equal(service.store.getArchitectureDocById(winner.id)!.title, '其他窗口修改');
  const noop = () => {};
  const markup = renderToStaticMarkup(createElement(Architecture, {
    editor: { ...store, ...failed }, result: architectureDocumentToAnalysisResult(failed.doc!),
    select: noop, inspect: noop, modules: noop, search: '', zoom: 1, selected: 'group',
  }));
  assert.match(markup, /role="alert"[^>]*>[^<]*Architecture document version conflict/);
  assert.match(markup, /保存失败/);
  assert.doesNotMatch(markup, /保存成功|已实现/);
  assert.match(markup, /class="[^"]*is-planned/);
  assert.match(markup, /规划中/);
  assert.match(markup, /人工补充/);
  await store.load();
  assert.equal(store.getSnapshot().savedDoc!.version, winner.version);
  assert.equal(store.getSnapshot().draftDoc!.title, '本地修改');
  await store.saveDraft();
  assert.equal(saves.length, 1, 'refresh must not let an older draft overwrite the newer version');
  store.cancelEdit();
  assert.equal(store.getSnapshot().doc!.title, winner.title);
});

test('deletion preview resolves saved and draft-only bindings against the current project walkthroughs', async t => {
  const { service, store, invoke } = await fixture(t);
  const group = module('group', '控制组');
  group.code_links.push({ id: 'source', kind: 'file', path: 'control.ts', origin: 'manual' });
  service.saveArchitectureDocument('p', { ...store.getSnapshot().savedDoc!, modules: [group] }, 0);
  service.store.put('feature', 'f', { project_id: 'p', feature_id: 'f', name: '采样走读' });
  service.store.put('explanation', 'reading', { scenario_id: 'scenario', created_at: at, result: {
    binding: { feature_id: 'f', project_id: 'p' }, nodes: [], evidence: [{ path: 'control.ts' }] } });
  const impact = (module_id: string, draft_paths?: { files: string[]; directories: string[] }) =>
    invoke('architecture_delete_impact', { project_id: 'p', branch_key: 'fixture', module_id, draft_paths });
  const linked = [{ id: 'f', title: '采样走读' }];
  assert.deepEqual((await impact('group')).referenced_features, linked);
  assert.deepEqual((await impact('group', { files: [], directories: [] })).referenced_features, []);
  assert.deepEqual((await impact('unsaved', { files: ['control.ts'], directories: [] })).referenced_features, linked);
  await assert.rejects(invoke('architecture_delete_impact', {
    project_id: 'p', branch_key: 'fixture', module_id: 'group', draft_paths: { files: 'invalid', directories: [] },
  }), /路径无效/);
});

test('Electron editor maintains modules, relations, positions and deletion impact through the real workspace service', async t => {
  const { dir, service, store, invoke } = await fixture(t);
  const bytes = 'export const frozenController = 1;\n';
  const digest = createHash('sha256').update(bytes).digest('hex');
  const snapshot: Snapshot = { source_snapshot_id: 's', project_id: 'p', root_path: dir, captured_at: at,
    files: [{ path: 'control.ts', bytes: Buffer.byteLength(bytes), line_count: 1, encoding: 'utf8', content_sha256: digest }],
    excluded: [], fingerprint: digest, commit: null, dirty: null, build_config: '', consistency: 'verified' };
  service.store.put('snapshot', 's', snapshot);
  const frozen = path.join(dir, 'snapshots', 's');
  await fs.mkdir(frozen, { recursive: true });
  await fs.writeFile(path.join(frozen, 'control.ts'), bytes);
  await fs.writeFile(path.join(dir, 'control.ts'), 'export const liveController = 2;\n');
  const group = { ...module('group', '控制组'), origin: 'code_analysis' as const,
    implementation_status: 'implemented' as const, code_links: [{ id: 'f', kind: 'file' as const, path: 'control.ts', origin: 'code_analysis' as const }] };
  service.saveArchitectureDocument('p', { ...store.getSnapshot().savedDoc!,
    modules: [group, module('child', '采样', 'group'), module('sink', '缓存')],
    relations: [{ id: 'publish', from: 'group', to: 'sink', kind: 'data_publish', label: '发布状态',
      origin: 'code_analysis', status: 'confirmed', evidence: [], updated_at: at }] }, 0);
  service.store.put('feature', 'f', { project_id: 'p', feature_id: 'f', name: '采样走读' });
  service.store.put('explanation', 'reading', { scenario_id: 'scenario', created_at: at, result: {
    binding: { feature_id: 'f', project_id: 'p' }, nodes: [], evidence: [{ path: 'control.ts' }] } });

  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Architecture } from './src/ui/Architecture';
    import { SystemDetail } from './src/ui/SystemDetail';
    import { useArchitectureDocument } from './src/ui/useArchitectureDocument';
    import { architectureDocumentToAnalysisResult } from './src/architecture-workspace';
    import './src/ui/architecture-map.css';
    import './src/ui/architecture.css';
    window.arc = { invoke: window.editorInvoke };
    const noop = () => {};
    function Fixture() {
      const [selected, select] = useState('group');
      const editor = useArchitectureDocument('p', '', window.arc.invoke);
      if (!editor.doc) return editor.loadError;
      const result = architectureDocumentToAnalysisResult(editor.doc);
      return <><section style={{width:680}}><Architecture {...{ editor, result, selected, select }}
        inspect={noop} modules={noop} zoom={0.75} search=""/></section>
        <aside><SystemDetail {...{ editor, result, selected, select }} snapshot={${JSON.stringify(snapshot)}} inspect={noop} openFeature={noop} openEvidence={noop}/></aside>
        <output hidden id="test-document">{JSON.stringify(editor.doc)}</output></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` }, bundle: true, outfile: path.join(dir, 'fixture.js') });
  const html = path.join(dir, 'index.html');
  await fs.writeFile(html, '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><main id="root"></main>');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>;
  const app = await _electron.launch({ args: [`--user-data-dir=${path.join(dir, 'profile')}`, html], env });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    await page.exposeFunction('editorInvoke', invoke);
    await page.addScriptTag({ path: path.join(dir, 'fixture.js') });
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const detail = page.locator('aside');
    const card = (id: string) => page.locator(`[data-component-id="${id}"] button`);
    const doc = async (): Promise<ArchitectureDocument> => JSON.parse((await page.locator('#test-document').textContent())!);
    await detail.getByRole('button', { name: 'control.ts', exact: true }).click();
    const excerpt = detail.getByRole('region', { name: '冻结源码依据' }).locator('pre');
    assert.match(await excerpt.innerText(), /frozenController/);
    assert.doesNotMatch(await excerpt.innerText(), /liveController/);
    await button('编辑架构').click();
    await card('group').click();
    const parentField = detail.getByLabel('父模块', { exact: true });
    const parentOptions = await parentField.evaluate((select: HTMLSelectElement) =>
      Array.from(select.options).filter(option => !option.disabled).map(option => option.value));
    assert.ok(parentOptions.includes('sink'));
    assert.ok(!parentOptions.includes('group') && !parentOptions.includes('child'));

    await button('新增模块').click();
    const add = page.getByRole('form', { name: '新增模块' });
    await add.getByLabel('名称').fill('计划调度');
    await add.getByLabel('父模块').selectOption('group');
    await add.getByRole('button', { name: '添加模块' }).click();
    const planned = (await doc()).modules.find(m => m.name === '计划调度')!;
    assert.equal(planned.code_links.length, 0);
    assert.match(await card(planned.id).innerText(), /规划中/);
    assert.match(await card(planned.id).innerText(), /人工补充/);
    assert.doesNotMatch(await card(planned.id).innerText(), /已实现/);

    await card('child').click();
    await detail.getByLabel('名称', { exact: true }).fill('采样刷新');
    await detail.getByLabel('职责', { exact: true }).fill('读取输入');
    await detail.getByLabel('所属分层', { exact: true }).selectOption('entry');
    await parentField.selectOption('sink');
    await detail.getByRole('button', { name: '添加代码关联' }).click();
    const binding = detail.getByRole('group', { name: '关联 1', exact: true });
    await binding.getByLabel('类型').selectOption('symbol');
    await binding.getByLabel('路径').fill('src/input.ts');
    await binding.getByLabel('符号名').fill('readInputs');
    await binding.getByLabel('起始行').fill('5');
    await binding.getByLabel('结束行').fill('9');
    await detail.getByRole('button', { name: '添加代码关联' }).click();
    const extra = detail.getByRole('group', { name: '关联 2', exact: true });
    await extra.getByLabel('路径').fill('input-old.ts');
    await extra.getByRole('button', { name: '移除关联' }).click();
    await card('child').scrollIntoViewIfNeeded();
    const before = await doc();
    const child = before.modules.find(m => m.id === 'child')!;
    assert.deepEqual([child.name, child.summary, child.layer, child.parent_id], ['采样刷新', '读取输入', 'entry', 'sink']);
    assert.equal(child.code_links.length, 1);
    assert.deepEqual([child.code_links[0].path, child.code_links[0].symbol_name, child.code_links[0].start_line, child.code_links[0].end_line],
      ['src/input.ts', 'readInputs', 5, 9]);
    const rect = (await card('child').boundingBox())!;
    const origin = await card('child').evaluate(button => {
      const box = button.closest('foreignObject')!;
      return { x: box.x.baseVal.value, y: box.y.baseVal.value, scale: box.getScreenCTM()!.a };
    });
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 45, y + 24, { steps: 6 });
    await page.mouse.up();
    const after = await doc();
    assert.deepEqual(after.modules, before.modules);
    assert.deepEqual(after.relations, before.relations);
    assert.deepEqual(after.layout.manual_positions, ['child']);
    assert.deepEqual(after.layout.positions.child,
      { x: Math.round(origin.x + 45 / origin.scale), y: Math.round(origin.y + 24 / origin.scale) });
    await button('隐藏模块').click();
    assert.equal(await card('child').count(), 0);
    assert.ok((await doc()).modules.find(m => m.id === 'child')!.hidden);
    await button('已隐藏 1').click();
    await button('恢复显示').click();
    await card('child').waitFor();

    await button('新增关系').click();
    const relation = page.getByRole('form', { name: '新增关系' });
    await relation.getByLabel('起点').selectOption('group');
    await relation.getByLabel('终点').selectOption('sink');
    await relation.getByRole('button', { name: '反转方向' }).click();
    await relation.getByLabel('说明/标签').fill('确认发布');
    await relation.getByRole('button', { name: '添加关系' }).click();
    const feedback = (await doc()).relations.find(r => r.label === '确认发布')!;
    assert.deepEqual([feedback.from, feedback.to], ['sink', 'group']);
    await detail.getByRole('button', { name: '反转方向' }).click();
    await detail.getByLabel('说明/标签').fill('重复发布');
    await detail.getByLabel('关系类型').selectOption('data_read');
    const changed = (await doc()).relations.find(r => r.id === feedback.id)!;
    assert.deepEqual([changed.from, changed.to, changed.label, changed.kind], ['group', 'sink', '重复发布', 'data_read']);
    await button('删除关系').click();
    assert.ok(!(await doc()).relations.some(r => r.id === feedback.id));

    await card('group').click();
    await button('删除模块').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('采样走读', { exact: false }).first().waitFor();
    const impact = await dialog.innerText();
    for (const label of ['计划调度', '发布状态', '采样走读']) assert.ok(impact.includes(label), label);
    assert.ok(!impact.includes('采样刷新'), 'child already moved out of group in draft');
    const confirm = dialog.getByRole('button', { name: '确认删除' });
    assert.ok(await confirm.isDisabled());
    await dialog.getByLabel('仅删除此分组，子模块移至上层').check();
    await confirm.click();
    let remaining = await doc();
    assert.equal(remaining.modules.find(m => m.id === planned.id)!.parent_id, undefined);
    assert.ok(remaining.exclusions.some(e => e.target_kind === 'module'));
    assert.equal(remaining.relations.length, 0);
    await button('取消').click();
    await button('编辑架构').click();
    await card('group').click();
    await button('删除模块').click();
    await dialog.getByLabel('一并移除此分组及其子模块').check();
    await confirm.click();
    await button('保存').click();
    await page.getByText('保存成功', { exact: true }).waitFor();
    remaining = await service.getArchitectureDocument('p', { branchKey: 'fixture' });
    assert.deepEqual(remaining.modules.map(m => m.id), ['sink']);
    assert.equal(remaining.relations.length, 0);
    assert.ok(service.store.maybe('explanation', 'reading'));
    await page.getByLabel('版本', { exact: true }).selectOption('1');
    await button('恢复').click();
    await card('group').waitFor();
    assert.equal((await doc()).version, 3);
  } finally {
    await app.close();
  }
});
