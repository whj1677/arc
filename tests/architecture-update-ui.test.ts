import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { _electron } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  architectureDocId, architectureDocumentToAnalysisResult, type ArchitectureDocument, type ArchitectureModule,
  type ArchitectureUpdateStatus, type UpdateRunRecord,
} from '../src/architecture-workspace';
import { frozenManifest } from '../src/main/architecture-change-detector';
import { architectureIpc } from '../src/main/architecture-ipc';
import { ArcService } from '../src/main/service';
import { capture, sha } from '../src/main/snapshot';
import { Store } from '../src/main/store';
import type { Explanation, ReadingGuide, SourceEvidence } from '../src/shared';
import { Architecture } from '../src/ui/Architecture';
import { ArchitectureUpdatePanel } from '../src/ui/ArchitectureUpdatePanel';
import { ArchitectureEditorStore, type ArchitectureInvoke } from '../src/ui/useArchitectureDocument';

const at = '2026-01-01T00:00:00.000Z';
const project = 'controller';
const branch = 'main';
const blank: ArchitectureDocument = {
  id: architectureDocId(project, branch), project_id: project, branch_key: branch, version: 1, title: '控制器', summary: '',
  modules: [], relations: [], exclusions: [], review_items: [], layout: { positions: {}, manual_positions: [] },
  update_status: 'up_to_date', created_at: at, updated_at: at,
};
const detection = { detection_reliable: true, changed_files: [], checked_at: at, has_changes: true };
const loaded = (document: ArchitectureDocument) => ({ document, versions: [], branches: [branch], active_branch: branch });
const baseline = { snapshot_id: 's1', branch, commit: 'a123456789', dirty: true, fingerprint: 'f',
  file_hashes: {}, workspace_fingerprint: 'w', captured_at: at };
const run: UpdateRunRecord = { id: 'u', base_doc_version: 1, started_at: at, read_baseline: baseline,
  post_check_consistent: true, impact_summary: { mode: 'none', reason: '', affected_module_ids: [], reused_module_ids: [],
    affected_feature_ids: [], unmapped_files: [] }, detection_summary: detection, model_calls: 0, auto_updates: [],
  review_item_ids: [], module_outcomes: {}, overall_status: 'up_to_date' };

test('opening checks each loaded branch once and waits for the manual edit to finish', async () => {
  let current = blank;
  const checked: string[] = [];
  const store = new ArchitectureEditorStore(project, async <T>(op: string) => {
    if (op === 'architecture_check_updates') {
      checked.push(current.branch_key);
      current = { ...current, pending_changes_summary: detection };
    }
    return loaded(current) as T;
  });
  await store.load();
  store.enterEditMode();
  await store.checkOnOpen();
  assert.deepEqual(checked, []);
  store.cancelEdit();
  await store.checkOnOpen();
  await store.load();
  await store.checkOnOpen();
  current = { ...blank, branch_key: 'release', id: architectureDocId(project, 'release') };
  await store.load();
  await store.checkOnOpen();
  assert.deepEqual(checked, ['main', 'release']);
});

test('dirty draft survives a check, blocks analysis, and saves against the original version', async () => {
  const calls: string[] = [];
  let saved: ArchitectureDocument | undefined;
  const invoke: ArchitectureInvoke = async <T>(op: string, payload?: unknown) => {
    calls.push(op);
    if (op === 'architecture_get') return loaded(blank) as T;
    if (op === 'architecture_check_updates')
      return { document: { ...blank, update_status: 'changes_pending', pending_changes_summary: detection } } as T;
    assert.equal(op, 'architecture_save');
    const args = payload as { expected_version: number; document: ArchitectureDocument };
    assert.equal(args.expected_version, 1);
    saved = args.document;
    return loaded({ ...args.document, version: 2 }) as T;
  };
  const store = new ArchitectureEditorStore(project, invoke);
  await store.load();
  store.enterEditMode();
  store.updateDraft(d => ({ ...d, title: '草稿标题' }));
  const draft = store.getSnapshot().draftDoc;
  await store.updateAffected();
  assert.match(store.getSnapshot().updateError!, /保存.*取消/);
  const checking = store.checkUpdates();
  assert.equal(store.getSnapshot().updateBusy, 'checking');
  await checking;
  assert.equal(store.getSnapshot().updateBusy, 'idle');
  assert.equal(store.getSnapshot().updateError, undefined);
  assert.equal(store.getSnapshot().savedDoc?.version, 1);
  assert.deepEqual(store.getSnapshot().savedDoc?.pending_changes_summary, detection);
  assert.equal(store.getSnapshot().savedDoc?.update_status, 'changes_pending');
  assert.equal(store.getSnapshot().draftDoc, draft);
  assert.deepEqual(store.getSnapshot().versions, []);
  store.updateDraft(d => ({ ...d, title: blank.title }));
  assert.equal(store.getSnapshot().dirty, false);
  store.updateDraft(d => ({ ...d, title: '草稿标题' }));
  await store.saveDraft();
  assert.equal(saved?.title, '草稿标题');
  assert.deepEqual(saved?.pending_changes_summary, detection);
  assert.equal(saved?.update_status, 'changes_pending');
  assert.deepEqual(calls, ['architecture_get', 'architecture_check_updates', 'architecture_save']);
});

test('update and review actions send scoped IPC, expose busy states, and return review errors', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const invoke: ArchitectureInvoke = async <T>(op: string, payload?: unknown) => {
    const args = payload as Record<string, unknown>;
    calls.push([op, args]);
    if (args.review_id === 'obsolete') throw Error('此项已处理');
    return loaded({ ...blank, version: calls.length }) as T;
  };
  const store = new ArchitectureEditorStore(project, invoke);
  await store.load();
  store.enterEditMode();
  const updating = store.updateAffected({ moduleIds: ['sensor'] });
  assert.equal(store.getSnapshot().updateBusy, 'updating');
  await updating;
  assert.equal(store.getSnapshot().draftDoc?.version, 2);
  await store.updateAffected({ retryFailedOnly: true });
  const resolving = store.resolveReview('item', 'defer', '稍后讨论');
  assert.equal(store.getSnapshot().updateBusy, 'resolving');
  assert.equal(await resolving, true);
  assert.equal(store.getSnapshot().savedDoc?.version, 4);
  assert.equal(await store.resolveReview('obsolete', 'accept'), false);
  assert.equal(store.getSnapshot().updateError, '此项已处理');
  assert.equal(store.getSnapshot().updateBusy, 'idle');
  assert.deepEqual(calls.slice(1).map(([op,args]) => [op, args.branch_key, args.project_id]),
    ['architecture_update_affected', 'architecture_update_affected', 'architecture_review_resolve', 'architecture_review_resolve']
      .map(op => [op, branch, project]));
  assert.deepEqual(calls[1][1].module_ids, ['sensor']);
  assert.equal(calls[2][1].retry_failed_only, true);
  assert.deepEqual([calls[3][1].review_id, calls[3][1].decision, calls[3][1].note], ['item', 'defer', '稍后讨论']);
});

test('execution labels reflect persisted status, stale snapshots and unreliable checks', async () => {
  async function render(patch: Partial<ArchitectureDocument>) {
    const document = { ...blank, baseline, last_update: run, ...patch };
    const store = new ArchitectureEditorStore(project, async <T>() => loaded(document) as T);
    await store.load();
    const noop = () => {};
    return renderToStaticMarkup(createElement(Architecture, { editor: { ...store, ...store.getSnapshot() },
      result: architectureDocumentToAnalysisResult(document), selected: '', select: noop, inspect: noop, modules: noop,
      zoom: 1, search: '' }));
  }
  const statuses: Record<ArchitectureUpdateStatus, string> = { changes_pending: '有变化待分析', up_to_date: '已分析至指定版本',
    needs_review: '需人工复核', partial: '部分完成', update_failed: '更新失败', updating: '更新中' };
  for (const [status, label] of Object.entries(statuses)) {
    assert.ok((await render({ update_status: status as ArchitectureUpdateStatus })).includes(label), label);
  }
  const stale = await render({ last_update: { ...run, post_check_consistent: false, stale_reason: 'S1 后源码发生变化' } });
  assert.match(stale, /role="alert"/);
  assert.match(stale, /S1 后源码发生变化/);
  assert.doesNotMatch(stale, /已分析至指定版本/);
  const unreliable = await render({ pending_changes_summary: { ...detection, detection_reliable: false, detection_error: '无法读取工程目录' } });
  assert.match(unreliable, /role="alert"/);
  assert.match(unreliable, /无法读取工程目录/);
});

test('panel shows the saved queue and only an accepted suggestion changes the SQLite document', async t => {
  const digest = sha('void save(void) {\n  write();\n  verify();\n}');
  const module: ArchitectureModule = { id: 'writer', name: '存储模块', kind: 'resource', layer: 'core', summary: '写入数据',
    origin: 'code_analysis', implementation_status: 'implemented', evidence: [],
    code_links: [{ id: 'write-file', kind: 'file', path: 'new.c', origin: 'code_analysis' }], updated_at: at };
  const doc: ArchitectureDocument = { ...blank, modules: [module, { ...module, id: 'reader', name: '采集模块',
    code_links: [{ id: 'read-file', kind: 'file', path: 'read.c', origin: 'code_analysis' }] }],
    last_update: { ...run, model_calls: 1, overall_status: 'partial',
      detection_summary: { detection_reliable: true, changed_files: [
        { path: 'new.c', old_path: 'old.c', status: 'renamed', source: 'staged', category: 'code' }] },
      impact_summary: { mode: 'local_module', reason: '写入逻辑变化', affected_module_ids: ['writer'],
        reused_module_ids: ['reader'], affected_feature_ids: ['持久化流程'], unmapped_files: ['service.c'] },
      auto_updates: [{ kind: 'file_moved', id: 'm', target_id: 'reader', target_name: '采集模块',
        old_path: 'old.c', new_path: 'new.c', description: '已迁移引用', at }],
      module_outcomes: { writer: { status: 'failed', error: '分析中断 E201' } } },
    review_items: [{ id: 'r', dedupe_key: 'r', category: 'module_update', target_kind: 'module', target_id: 'writer', status: 'pending', branch, title: '调整写入模块',
      scope_summary: '磁盘写入路径', before: { summary: '写入数据' }, proposed: { summary: '写入并校验数据' },
      evidence_fingerprint: 'f', code_baseline_fingerprint: 'f', created_at: at, evidence: [
        { evidence_id: 'ev', path: 'new.c', source_snapshot_id: 's1', content_sha256: digest, line_start: 2,
          line_end: 4, role: 'write', note: '校验分支' }] }] };
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'review-queue-'));
  const service = new ArcService(dir, process.cwd());
  t.after(async () => {
    await service.shutdown();
    service.store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  t.mock.method(service, 'getActiveArchitectureBranch', async () => branch);
  service.store.put('project', project, { project_id: project, root_path: dir });
  service.store.put('snapshot', 's1', { project_id: project, source_snapshot_id: 's1', fingerprint: 'f',
    files: [{ path: 'new.c', line_count: 4, content_sha256: digest }] });
  doc.review_items.push({ ...doc.review_items[0], id: 'r2', dedupe_key: 'r2', title: '修改模块名', proposed: { name: '另一个名称' } });
  service.store.saveArchitectureDoc(doc, 0);
  const store = new ArchitectureEditorStore(project, async <T>(op: string, args?: unknown) =>
    await architectureIpc(service, op as Parameters<typeof architectureIpc>[1], args as Record<string, unknown>) as T);
  await store.load();
  const html = renderToStaticMarkup(createElement(ArchitectureUpdatePanel, { editor: { ...store, ...store.getSnapshot() },
    doc: store.getSnapshot().savedDoc!, warnings: null, openEvidence: () => {} }));
  for (const text of ['重命名', '已暂存', '代码', '写入逻辑变化', '存储模块', '已复用 1 个未受影响模块', '采集模块',
    '持久化流程', 'service.c', '文件移动', 'old.c → new.c', '分析中断 E201', '重试失败项', '>重试</button>',
    '待处理 (2)', '原内容', '写入数据', '新建议', '写入并校验数据', '影响范围', '磁盘写入路径', 'aria-label="复核备注"'])
    assert.ok(html.includes(text), text);
  assert.match(html, /<button\b[^>]*>new\.c:L2-L4<\/button>/);
  assert.equal(await store.resolveReview('r', 'defer', '等待确认'), true, store.getSnapshot().updateError);
  assert.equal(await store.resolveReview('r2', 'reject'), true, store.getSnapshot().updateError);
  const deferred = service.store.getArchitectureDocById(doc.id)!;
  assert.equal(deferred.modules[0].summary, '写入数据');
  assert.deepEqual(deferred.review_items.map(item => item.status), ['deferred', 'rejected']);
  assert.equal(await store.resolveReview('r', 'accept'), true, store.getSnapshot().updateError);
  const confirmed = service.store.getArchitectureDocById(doc.id)!;
  assert.equal(confirmed.modules[0].summary, '写入并校验数据');
  assert.equal(confirmed.modules[0].name, '存储模块');
  assert.deepEqual(store.getSnapshot().savedDoc, confirmed);
});

// Use the production Electron main, preload and renderer. Bind the existing analyzer
// constructor argument so the two affected modules have reproducible outcomes.
async function electronEntry(directory: string) {
  const { build: buildRenderer } = await import('vite');
  await buildRenderer({ base: './', logLevel: 'warn', build: { outDir: path.join(directory, 'ui') },
    esbuild: { jsx: 'automatic' } });
  const entry = path.join(directory, 'main.cjs');
  await build({ entryPoints: ['src/main/main.ts', 'src/main/preload.ts'], outdir: directory, bundle: true, platform: 'node',
    format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['electron', 'node:sqlite'],
    plugins: [{ name: 'fixture-analyzer', setup(builder) {
      builder.onResolve({ filter: /^\.\/service$/ }, args => args.importer === path.resolve('src/main/main.ts')
        ? { path: 'fixture-service', namespace: 'fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: process.cwd(), contents: `
        import { ArcService as Service } from './src/main/service';
        import { app } from 'electron';
        import { appendFile } from 'node:fs/promises';
        import path from 'node:path';
        let failWriter = true, changeDuringAnalysis = false;
        app.on('test-fail-writer', () => { failWriter = true; });
        app.on('test-stale-writer', () => { changeDuringAnalysis = true; });
        export class ArcService extends Service {
          constructor(dir, resources, emit) {
            super(dir, resources, emit, undefined, undefined, { async analyze({ unit, snapshot }) {
              if (unit.id === 'writer') {
                if (failWriter) { failWriter = false; throw Error('写入模块分析超时'); }
                if (changeDuringAnalysis) await appendFile(path.join(snapshot.root_path, 'writer.c'), '// changed after capture');
                return [];
              }
              const file = snapshot.files.find(f => f.path === 'sensor.c');
              const evidence = [{ evidence_id: 'ev-sensor', source_snapshot_id: snapshot.source_snapshot_id,
                path: file.path, content_sha256: file.content_sha256, line_start: 1, line_end: 1,
                role: 'definition', note: '采样函数' }];
              if (unit.kind === 'feature') {
                const reading_guide = structuredClone(unit.explanation.result.reading_guide);
                reading_guide.steps[0].text = '按新阈值采样';
                return [{ category: 'dataflow_change', target_kind: 'feature', target_id: unit.id,
                  title: '修订采样走读', proposed: { explanation_id: unit.explanation.result_id, reading_guide }, evidence }];
              }
              return [{ title: '调整采样职责', proposed: { summary: '新采样职责' } },
                { title: '调整采样名称', proposed: { name: '新采样名称' } }].map(change => ({
                ...change, category: 'module_update', target_kind: 'module', target_id: unit.id, evidence }));
            } });
          }
        }` }));
    } }] });
  return entry;
}

async function waitForInitialCheck(saved: () => Promise<ArchitectureDocument>) {
  const deadline = performance.now() + 12_000;
  do {
    const document = await saved();
    if (document.pending_changes_summary?.checked_at) return document;
    await delay(50);
  } while (performance.now() < deadline);
  throw Error('Timed out waiting for the initial architecture check to persist');
}

test('Electron checks changes, opens frozen review evidence, retries failed work and persists review decisions', async t => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'architecture-update-ui-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(dir, '控制 工程'), data = path.join(dir, 'arc-data');
  await fs.mkdir(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=ARC', '-c',
    'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { windowsHide: true, stdio: 'pipe' });
  const source = (id: string, value: number) => `int ${id}(void) { return ${value}; }\n`;
  const names = { sensor: '采样', writer: '写入', timer: '计时' };
  for (const id of Object.keys(names)) await fs.writeFile(path.join(root, id + '.c'), source(id, 1));
  git('init', '-b', branch);
  git('add', '.');
  git('commit', '-m', 'initial');
  const store = new Store(data);
  const snapshot = await capture(root, project, data, '');
  try {
    store.put('project', project, { project_id: project, name: '控制器', root_path: root,
      snapshot_id: snapshot.source_snapshot_id, fictional: true, build_config: '', created_at: at });
    store.put('snapshot', snapshot.source_snapshot_id, snapshot);
    const modules = Object.entries(names).map(([id, name]): ArchitectureModule => ({
      id, name, kind: 'stage', layer: 'core', origin: 'code_analysis', implementation_status: 'implemented',
      summary: '原有' + name + '职责', evidence: [], updated_at: at,
      code_links: [{ id: 'file-' + id, kind: 'file', path: id + '.c', origin: 'code_analysis' }],
    }));
    const doc = store.saveArchitectureDoc({ ...blank, version: 0, modules,
      baseline: { ...frozenManifest(snapshot), snapshot_id: snapshot.source_snapshot_id, fingerprint: snapshot.fingerprint,
        captured_at: at, branch, commit: snapshot.commit!, dirty: false } }, 0);
    const file = snapshot.files.find(f => f.path === 'sensor.c')!;
    const ev: SourceEvidence = { evidence_id: 'ev-sensor', path: file.path, source_snapshot_id: snapshot.source_snapshot_id,
      line_start: 1, line_end: 1, content_sha256: file.content_sha256, role: 'definition', note: '采样函数' };
    const guide: ReadingGuide = { steps: [{ id: 'step', title: '读取采样', actor: '传感器', text: '按原阈值采样',
      outcome: '采样值', detail: '', node_ids: ['sensor'], evidence_ids: [ev.evidence_id] }],
      roles: [{ id: 'reader', title: '传感器', duty: '采样', files: [file.path], evidence_ids: [ev.evidence_id] }],
      files: [{ path: file.path, title: '采样', description: '读取采样值', detail: '', step_ids: ['step'], evidence_ids: [ev.evidence_id] }],
      paths: [{ id: 'flow', label: '采样路径', entry: '读取', intro: '采样', boundary: '', step_ids: ['step'],
        lanes: [], failure_ids: [], role_ids: ['reader'], handoff_ids: [], files: [file.path] }], handoffs: [] };
    const result = architectureDocumentToAnalysisResult({ ...doc, modules: [{ ...modules[0], evidence: [ev] }] });
    const walk: Explanation = { result_id: 'walk-v1', scenario_id: 'sample-scene', created_at: at, source_status: 'current',
      result: { ...result, result_id: 'walk-v1', binding: { ...result.binding, feature_id: 'sample', scenario_id: 'sample-scene' },
        reading_guide: guide } };
    store.put('feature', 'sample', { feature_id: 'sample', project_id: project, name: '采样功能', sort_order: 1, archived: false });
    store.put('scenario', walk.scenario_id, { scenario_id: walk.scenario_id, feature_id: 'sample', project_id: project,
      title: '采样走读', question: '怎样采样', question_revision_id: 'revision', sort_order: 1, archived: false });
    store.put('explanation', walk.result_id, walk);
  } finally { store.close(); }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && key !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>;
  env.ARC_DATA_DIR = data;
  const app = await _electron.launch({ args: [`--user-data-dir=${data}`, await electronEntry(dir)], env });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    const button = (name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
    const saved = () => page.evaluate(async id => (await window.arc.invoke<{ document: ArchitectureDocument }>(
      'architecture_get', { project_id: id })).document, project);
    await page.getByRole('combobox', { name: '当前工程' }).locator('option:checked').filter({ hasText: '控制器' }).waitFor({ state: 'attached' });
    await page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: '工程全貌' }).click();
    const initial = await waitForInitialCheck(saved);
    assert.equal(initial.version, 1);
    await button('已分析至指定版本').waitFor();
    const panel = page.getByRole('region', { name: '更新与复核' });
    await button(/待复核.*0/).click();
    await panel.waitFor({ state: 'visible' });
    await button(/待复核.*0/).click();
    await panel.waitFor({ state: 'hidden' });
    await page.getByText('正在检查变化…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await saved()).pending_changes_summary?.checked_at, initial.pending_changes_summary!.checked_at,
      'opening and closing the panel must not repeat the initial check');
    await fs.writeFile(path.join(root, 'sensor.c'), source('sensor', 2));
    await fs.writeFile(path.join(root, 'writer.c'), source('writer', 3));
    git('mv', 'timer.c', 'clock.c');
    await button('检查更新').click();
    await button('有变化待分析').waitFor();
    const checked = await saved();
    assert.equal(checked.version, 1);
    const impact = checked.pending_changes_summary!.impact_preview!;
    await page.getByText(impact.reason, { exact: false }).first().waitFor();
    await page.getByText(/模型调用[：:]\s*0\s*次/).first().waitFor();
    assert.deepEqual(impact.affected_module_ids.sort(), ['sensor', 'writer']);
    assert.deepEqual(impact.reused_module_ids, ['timer']);
    assert.deepEqual(impact.affected_feature_ids, ['sample']);
    for (const file of ['sensor.c', 'writer.c', 'clock.c']) await page.getByText(file, { exact: false }).first().waitFor();

    await button('更新受影响部分').click();
    await button('部分完成').waitFor();
    await button('重试失败项').waitFor();
    await page.getByText('Error: 写入模块分析超时', { exact: false }).first().waitFor();
    await page.getByText('文件移动', { exact: false }).first().waitFor();
    await button(/待复核.*3/).waitFor();
    const partial = await saved();
    assert.equal(partial.modules.find(m => m.id === 'timer')!.code_links[0].path, 'clock.c');
    assert.equal(partial.modules.find(m => m.id === 'sensor')!.summary, '原有采样职责');
    const review = (title: string) => page.getByRole('article', { name: title, exact: true });
    const scope = review('调整采样职责');
    await scope.getByRole('heading', { name: '代码依据', exact: true }).waitFor();
    for (const label of ['原内容', '新建议', '影响范围', '新采样职责'])
      await scope.getByText(label, { exact: false }).first().waitFor();
    await scope.getByRole('button', { name: /sensor\.c:L1[–-]L1/ }).click();
    const excerpt = page.getByRole('region', { name: '冻结源码依据' });
    await excerpt.locator('pre .highlight').waitFor();
    assert.match(await excerpt.innerText(), /return 2/);
    assert.ok((await excerpt.innerText()).includes(partial.last_update!.read_baseline.snapshot_id));
    if (await page.locator('.drawer').isVisible()) await button('← 返回图与原位置').click();
    await button('重试失败项').click();
    await button('需人工复核').waitFor();
    const retried = await saved();
    assert.equal(retried.last_update!.model_calls, 1);
    assert.equal(retried.last_update!.module_outcomes.writer.status, 'succeeded');
    assert.equal(retried.last_update!.module_outcomes.sensor.status, 'needs_review');
    assert.deepEqual(retried.review_items.map(i => i.id), partial.review_items.map(i => i.id));
    await scope.getByLabel('复核备注').fill('与维护者核对');
    await scope.getByRole('button', { name: '暂缓', exact: true }).click();
    await button(/已暂缓.*1/).waitFor();
    await review('调整采样名称').getByRole('button', { name: '拒绝' }).click();
    await button(/已处理.*1/).waitFor();
    await review('修订采样走读').getByRole('button', { name: '接受' }).click();
    await button(/已处理.*2/).waitFor();
    await button(/已暂缓.*1/).click();
    assert.equal((await saved()).review_items.find(i => i.title === '调整采样职责')!.decision_note, '与维护者核对');
    await scope.getByRole('button', { name: '接受', exact: true }).click();
    await button('已分析至指定版本').waitFor();
    await button(/待复核.*0/).waitFor();
    await button(/已处理.*3/).click();
    await scope.waitFor();
    const final = await saved();
    const sensor = final.modules.find(m => m.id === 'sensor')!;
    assert.deepEqual([sensor.name, sensor.summary], ['采样', '新采样职责']);
    assert.deepEqual(Object.fromEntries(final.review_items.map(i => [i.title, i.status])),
      { '调整采样名称': 'rejected', '调整采样职责': 'accepted', '修订采样走读': 'accepted' });
    const explanations = await page.evaluate(async () => (await window.arc.invoke('data')).explanations as Explanation[]);
    assert.ok(explanations.some(e => e.scenario_id === 'sample-scene' && e.result.reading_guide?.steps[0].text === '按新阈值采样'));
    await page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: '功能走读' }).click();
    await button('显示目录').first().click();
    await button('采样功能').click();
    await button('采样走读').click();
    const reading = page.getByRole('region', { name: '业务流程' });
    await reading.getByText('按新阈值采样', { exact: true }).waitFor();

    await fs.writeFile(path.join(root, 'writer.c'), source('writer', 4));
    await app.evaluate(({ app }) => app.emit('test-fail-writer'));
    await page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: '工程全貌' }).click();
    await button('更新受影响部分').click();
    await button('更新失败').waitFor();
    await page.locator('[data-component-id="writer"] button').click();
    await app.evaluate(({ app }) => app.emit('test-stale-writer'));
    await button('重试此模块').click();
    if (await page.locator('.drawer').isVisible()) await button('← 返回图与原位置').click();
    await button('有变化待分析').waitFor();
    const stale = (await saved()).last_update!;
    assert.equal(stale.post_check_consistent, false);
    await page.getByRole('alert').filter({ hasText: stale.stale_reason! }).waitFor();
    assert.equal(await button('已分析至指定版本').count(), 0);
  } finally { await app.close(); }
});
