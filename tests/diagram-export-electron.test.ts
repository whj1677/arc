import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { _electron, type Page } from 'playwright';
import { architectureDocId, architectureDocumentToAnalysisResult, type ArchitectureModule } from '../src/architecture-workspace';
import { frozenManifest } from '../src/main/architecture-change-detector';
import { capture } from '../src/main/snapshot';
import { Store } from '../src/main/store';
import type { Explanation, ReadingGuide } from '../src/shared';

const at = '2026-01-01T00:00:00.000Z';
const project = 'diagram-controller';
const branch = 'main';
const proposedName = '未接受的提案模块';

async function seed(root: string, data: string) {
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'sample.c'), 'int sample(void) { return 1; }\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=ARC',
    '-c', 'user.email=test@example.invalid', ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-b', branch);
  git('add', '.');
  git('commit', '-m', 'snapshot');
  const db = new Store(data);
  try {
    const snapshot = await capture(root, project, data, '');
    db.put('project', project, { project_id: project, name: '温度控制器', root_path: root,
      snapshot_id: snapshot.source_snapshot_id, fictional: true, build_config: '', created_at: at });
    db.put('snapshot', snapshot.source_snapshot_id, snapshot);
    const module = (id: string, name: string, parent_id?: string): ArchitectureModule => ({
      id, name, parent_id, kind: 'stage', layer: 'core', summary: '处理温度与压力',
      code_links: [], evidence: [], origin: 'manual', implementation_status: 'planned', updated_at: at,
    });
    const doc = db.saveArchitectureDoc({
      id: architectureDocId(project, branch), project_id: project, branch_key: branch, version: 0,
      title: '装置架构', summary: '', last_confirmed_version: 1, update_status: 'up_to_date',
      modules: [module('sensor', '一版采样'), module('child', '温度转换', 'sensor'), module('cache', '远端缓存'),
        { ...module('hidden', '隐藏草案'), hidden: true }],
      relations: [
        { id: 'inside', from: 'sensor', to: 'child', kind: 'control_flow', label: '执行转换' },
        { id: 'outside', from: 'child', to: 'cache', kind: 'data_publish', label: '缓存温度' },
      ].map(r => ({ ...r, kind: r.kind as 'control_flow' | 'data_publish', origin: 'manual',
        status: 'manual', evidence: [], updated_at: at })),
      layout: { positions: { cache: { x: 1950, y: 240 } }, manual_positions: ['cache'] },
      baseline: { ...frozenManifest(snapshot), captured_at: at, branch, commit: snapshot.commit!,
        snapshot_id: snapshot.source_snapshot_id, fingerprint: snapshot.fingerprint, dirty: false },
      exclusions: [], review_items: [], created_at: at, updated_at: at,
    }, 0);
    db.saveArchitectureDoc({ ...doc, update_status: 'needs_review',
      modules: doc.modules.map(m => m.id === 'sensor' ? { ...m, name: '二版采样' } : m),
      review_items: [{ id: 'proposal', dedupe_key: 'candidate', category: 'module_add', status: 'pending',
        title: proposedName, proposed: module('unaccepted', proposedName), scope_summary: '', evidence: [],
        evidence_fingerprint: 'ev', code_baseline_fingerprint: 'base', created_at: at }],
    }, 1);
    const guide: ReadingGuide = {
      steps: ['旧入口', '测量温度', '传递结果'].map((title, i) => ({ id: 's' + i, title, actor: '温度探头',
        text: '读取实时温度', outcome: '已采样', detail: '', node_ids: ['sensor'], evidence_ids: [] })),
      roles: [{ id: 'probe', title: '温度探头', duty: '采集温度', files: [], evidence_ids: [] }],
      paths: [['旧路径', 's0'], ['采集路径', 's1', 's2']].map(([label, ...ids], i) => ({
        id: 'path' + i, label, entry: label, intro: '', boundary: '', step_ids: ids,
        lanes: [{ label: '温度探头', step_ids: ids, link_labels: i ? ['温度值'] : [] }],
        role_ids: ['probe'], handoff_ids: [], failure_ids: [], files: [],
      })),
      handoffs: [], files: [],
    };
    const result = architectureDocumentToAnalysisResult(doc);
    const walk: Explanation = { result_id: 'walk-frozen-1', scenario_id: 'measure-scene', source_status: 'current',
      created_at: at, result: { ...result, result_id: 'walk-frozen-1', reading_guide: guide,
        binding: { ...result.binding, feature_id: 'measure', scenario_id: 'measure-scene' } } };
    db.put('feature', 'measure', { project_id: project, feature_id: 'measure', name: '温度采集', sort_order: 1, archived: false });
    db.put('scenario', walk.scenario_id, { project_id: project, feature_id: 'measure', scenario_id: walk.scenario_id,
      title: '采集走读', question: '怎样采集温度', question_revision_id: 'r', sort_order: 1, archived: false });
    db.put('explanation', walk.result_id, walk);
    db.put('explanation', 'other-branch-walk', { ...walk, result_id: 'other-branch-walk', branch_key: 'other-branch',
      result: { ...walk.result, result_id: 'other-branch-walk' } });
    return snapshot.source_snapshot_id;
  } finally { db.close(); }
}

// A separate SQLite connection owns the concurrent writer, never exposing its document to the renderer.
function anotherWriter(data: string, version: number, name: string) {
  const db = new Store(data);
  try {
    const doc = db.getArchitectureDoc(project, branch)!;
    const next = db.saveArchitectureDoc({ ...doc, modules: doc.modules.map(m => m.id === 'sensor' ? { ...m, name } : m),
      layout: { ...doc.layout, positions: { ...doc.layout.positions, cache: { x: 3200, y: 120 } } } }, version);
    assert.equal(next.version, version + 1);
  } finally { db.close(); }
}

async function inspectSvg(page: Page, filename: string) {
  const errors: string[] = [];
  const consoleError = (message: import('playwright').ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  };
  const pageError = (error: Error) => errors.push(error.message);
  page.on('console', consoleError);
  page.on('pageerror', pageError);
  try {
    await page.goto(pathToFileURL(filename).href);
    const info = await page.evaluate(() => {
      const svg = document.documentElement as unknown as SVGSVGElement;
      if (svg.localName !== 'svg' || document.querySelector('parsererror')) throw Error('Invalid standalone SVG');
      const view = svg.viewBox.baseVal;
      const cardSelector = '[data-component-id],[data-boundary-relation],[data-step-id]';
      const bounds = [...svg.querySelectorAll<SVGGraphicsElement>(`text,${cardSelector}`)]
        .map(el => {
          const b = el.getBBox(), matrix = svg.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!);
          const a = new DOMPoint(b.x, b.y).matrixTransform(matrix);
          const z = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(matrix);
          return { el, rect: { x: a.x, y: a.y, right: z.x, bottom: z.y } };
        });
      const clipped = bounds.filter(({ el, rect: b }) => {
          return el.matches('text,[data-component-id],[data-boundary-relation]') &&
            (b.x < -1 || b.y < -1 || b.right > view.width + 1 || b.bottom > view.height + 1);
        }).map(({ el }) => el.textContent);
      const nodes = bounds.filter(({ el }) => el.hasAttribute('data-component-id')).map(({ el, rect }) => ({
        id: el.getAttribute('data-component-id'), x: rect.x,
      }));
      const cards = bounds.filter(({ el }) => el.matches(cardSelector)).map(({ rect }) => rect);
      const chinese = [...svg.querySelectorAll('text')].some(el => /[\u3400-\u9fff]/.test(el.textContent ?? '') && el.getBBox().width > 0);
      return { width: view.width, height: view.height, text: svg.textContent ?? '', chinese, clipped, nodes, cards,
        edges: svg.querySelectorAll('[data-edge-id]').length, external: svg.querySelectorAll('[data-boundary-relation]').length };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(info.clipped, [], 'saved diagram must fit the exported viewBox');
    assert.ok(info.chinese);
    return { ...info, filename };
  } finally {
    page.off('console', consoleError);
    page.off('pageerror', pageError);
  }
}

async function inspectPng(page: Page, file: string, svg: Awaited<ReturnType<typeof inspectSvg>>, scale?: number) {
  const bytes = await fs.readFile(file);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  await page.goto('about:blank');
  const { width, height, variance, differences } = await page.evaluate(async ({ png, vector, cards }) => {
    const image = new Image(), reference = new Image();
    image.src = png;
    reference.src = vector;
    await Promise.all([image.decode(), reference.decode()]);
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0, squares = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += luminance;
      squares += luminance * luminance;
    }
    const n = data.length / 4;
    // Compare the actual card interiors (including offscreen and boundary nodes)
    // against an independent decode of the peer .svg. Timestamps outside them can differ.
    const factor = image.naturalWidth / reference.naturalWidth;
    const differences = cards.map(b => {
      const x = Math.floor(b.x * factor), y = Math.floor(b.y * factor);
      canvas.width = Math.min(600, Math.ceil((b.right - b.x) * factor));
      canvas.height = Math.min(420, Math.ceil((b.bottom - b.y) * factor));
      const [actual, expected] = [image, reference].map(source => {
        ctx.drawImage(source, -x, -y, image.naturalWidth, image.naturalHeight);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      });
      let diff = 0;
      for (let i = 0; i < actual.length; i++) diff += Math.abs(actual[i] - expected[i]);
      return diff / actual.length;
    });
    return { width: image.naturalWidth, height: image.naturalHeight, variance: squares / n - (sum / n) ** 2, differences };
  }, { png: 'data:image/png;base64,' + bytes.toString('base64'), cards: svg.cards,
    vector: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(await fs.readFile(svg.filename, 'utf8')) });
  assert.deepEqual([width, height], [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]);
  assert.ok(variance > 15, 'PNG must have appreciable pixel variance');
  assert.ok(differences.length && differences.every(d => d < 3), 'PNG card pixels differ from the selected standalone SVG: ' + differences);
  const actualScale = width / svg.width;
  if (scale) assert.ok(Math.abs(width - scale * svg.width) <= 1);
  else assert.ok(actualScale >= 1.99 && actualScale <= 3.01, 'auto resolution should be crisp for this small fixture');
  assert.ok(Math.abs(height - svg.height * actualScale) <= 2);
}

test('Electron exports frozen whole, subgraph and reading diagrams to standalone SVG and high-DPI PNG', { timeout: 180_000 }, async t => {
  if (!['dist/main.cjs', 'dist/preload.cjs', 'dist/ui/index.html'].every(existsSync))
    execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'diagram-export-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(dir, '测试 工程'), data = path.join(dir, 'arc-data'), output = path.join(dir, '导出 图表');
  const snapshot = await seed(root, data);
  await fs.mkdir(output);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>;
  env.ARC_DATA_DIR = data;
  const electron = await _electron.launch({ args: [`--user-data-dir=${data}`, path.resolve('tests/fixtures/diagram-export-main.cjs')], env });
  try {
    const page = await electron.firstWindow();
    page.setDefaultTimeout(12_000);
    const remoteRequests: string[] = [];
    page.on('request', request => {
      if (/^https?:/.test(request.url())) remoteRequests.push(new URL(request.url()).origin);
    });
    const [viewer] = await Promise.all([
      electron.waitForEvent('window'),
      electron.evaluate(({ BrowserWindow }) => {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
        return win.loadURL('about:blank');
      }),
    ]);
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const modal = page.getByRole('dialog', { name: '导出图表' });
    const field = (name: string) => modal.getByLabel(name, { exact: true });
    const modalButton = (name: string | RegExp) => modal.getByRole('button', { name, exact: typeof name === 'string' });
    const nav = (name: string) => page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name, exact: true });
    const closeInspector = async () => {
      const back = button('← 返回图与原位置');
      if (await back.isVisible()) await back.click();
    };
    const write = async (filename: string, concurrent?: () => void) => {
      const dest = path.join(output, filename);
      await electron.evaluate(({ app }, file) => { app.emit('export-test-path', file); }, dest);
      if (concurrent) {
        await modal.getByLabel('范围预览').waitFor();
        concurrent();
      }
      await modalButton('确认导出').click();
      await modal.waitFor({ state: 'hidden' });
      assert.ok((await fs.stat(dest)).size > 100);
      return dest;
    };
    const newDraft = async (name: string) => {
      await button('编辑架构').click();
      await button('新增模块').click();
      const form = page.getByRole('form', { name: '新增模块' });
      await form.getByLabel('名称').fill(name);
      await form.getByRole('button', { name: '添加模块' }).click();
      await closeInspector();
      await button('导出').click();
    };
    const goArchitecture = async () => {
      await page.getByLabel('当前工程').locator('option:checked').filter({ hasText: '温度控制器' }).waitFor({ state: 'attached' });
      await nav('工程全貌').click();
      await button('编辑架构').waitFor();
    };
    await goArchitecture();
    await newDraft('未保存模块');
    await modalButton('保存并导出').waitFor();
    await modalButton(/导出已保存版本.*v2/).waitFor();
    await modalButton('取消').click();
    assert.deepEqual(await fs.readdir(output), []);
    await button('导出').click();
    await modalButton(/导出已保存版本.*v2/).click();
    await field('文件格式').selectOption('svg');
    const whole = await inspectSvg(viewer, await write('完整.svg'));
    assert.deepEqual(whole.nodes.map(n => n.id).sort(), ['cache', 'child', 'sensor']);
    assert.equal(whole.edges, 2);
    assert.ok(whole.nodes.find(n => n.id === 'cache')!.x - whole.nodes.find(n => n.id === 'sensor')!.x > 1440,
      'manually positioned cache must remain beyond the original viewport');
    for (const text of ['需人工复核', '二版采样', 'v2', snapshot]) assert.ok(whole.text.includes(text), text);
    for (const text of [proposedName, '未保存模块', '隐藏草案']) assert.ok(!whole.text.includes(text), text);
    await button('取消').click(); // discard the editor draft

    await button('导出').click();
    await field('保存版本').getByRole('option', { name: /最近已确认版本.*v1/ }).waitFor({ state: 'attached' });
    await field('保存版本').selectOption('1');
    const confirmed = await inspectSvg(viewer, await write('已确认.svg'));
    assert.match(confirmed.text, /一版采样/);
    assert.doesNotMatch(confirmed.text, /二版采样/);
    assert.match(confirmed.text, /v1/);

    await button('导出').click();
    await field('文件格式').selectOption('png');
    await field('分辨率').selectOption('standard');
    const wholePng = await write('完整.png', () => anotherWriter(data, 2, '三版采样'));
    // v3 moves the faraway cache by 1250px. A mixed render would have different PNG dimensions.
    await inspectPng(viewer, wholePng, whole, 2);

    await page.reload();
    await goArchitecture();
    await page.locator('[data-component-id="sensor"] button').click();
    await closeInspector();
    const openSubgraph = async () => {
      await button('导出').click();
      await field('保存版本').selectOption('3');
      await field('导出范围').selectOption('subgraph');
      assert.equal(await field('根模块').inputValue(), 'sensor');
      assert.ok(await field('包含内部子模块').isChecked());
      assert.equal(await field('包含直接邻居').isChecked(), false);
      await modal.getByText(/\[外部\].*远端缓存/).first().waitFor();
    };
    await openSubgraph();
    const sub = await inspectSvg(viewer, await write('子图.svg', () => anotherWriter(data, 3, '四版替换')));
    assert.deepEqual(sub.nodes.map(n => n.id).sort(), ['child', 'sensor']);
    assert.equal(sub.external, 1);
    assert.equal(sub.edges, 2);
    assert.match(sub.text, /\[外部\].*远端缓存/s);
    assert.match(sub.text, /三版采样/);
    assert.doesNotMatch(sub.text, /四版替换/);
    await openSubgraph();
    await field('文件格式').selectOption('png');
    await field('分辨率').selectOption('hd');
    await inspectPng(viewer, await write('子图.png'), sub, 3);

    await nav('功能走读').click();
    if (!await button('温度采集').isVisible()) await button('显示目录').first().click();
    await button('温度采集').click();
    await button('采集走读').click();
    const openReading = async () => {
      await button('导出图表').click();
      await field('图表视图').selectOption('business_flow');
      assert.equal(await field('图表视图').locator('option[value="call_chain"]').count(), 0);
      await field('路径').selectOption('path1');
      for (const text of ['walk-frozen-1', snapshot, 'current']) assert.ok((await modal.innerText()).includes(text), text);
    };
    await openReading();
    const reading = await inspectSvg(viewer, await write('采集走读.svg'));
    for (const text of ['walk-frozen-1', snapshot, 'current', '测量温度', '传递结果', '温度值'])
      assert.ok(reading.text.includes(text), text);
    assert.doesNotMatch(reading.text, /旧入口/);
    await openReading();
    await field('文件格式').selectOption('png');
    await field('分辨率').selectOption('auto_large');
    await inspectPng(viewer, await write('采集走读.png'), reading);

    await page.reload();
    await goArchitecture();
    await newDraft('冲突草稿');
    const beforeConflict = await fs.readdir(output);
    anotherWriter(data, 4, '五版采样');
    await modalButton('保存并导出').click();
    await modal.getByText(/Architecture document version conflict|架构版本已变化/).first().waitFor();
    assert.deepEqual(await fs.readdir(output), beforeConflict);
    await modalButton('取消').click();
    await page.reload();
    await goArchitecture();
    await newDraft('有效新增模块');
    await modalButton('保存并导出').click();
    const savedDraft = await inspectSvg(viewer, await write('保存后.svg'));
    assert.match(savedDraft.text, /有效新增模块/);
    assert.match(savedDraft.text, /v6/);

    type Records = { operations: { operation: string; version?: number }[]; transportCalls: string[];
      choices: { defaultPath: string; filters: { extensions: string[] }[] }[]; downloads: string };
    const records = await electron.evaluate(({ app }) => new Promise<Records>(resolve => { app.emit('export-test-records', resolve); }));
    assert.equal(records.choices.length, 8);
    assert.equal(records.operations.filter(op => op.operation === 'export_diagram_file').length, 8);
    for (const choice of records.choices) {
      assert.equal(path.dirname(choice.defaultPath), records.downloads);
      assert.ok(choice.filters.some(filter => filter.extensions.includes(path.extname(choice.defaultPath).slice(1))));
    }
    const modelOperations = /^(?:run_start|analysis_prepare|reading_ask|reading_retry|architecture_update_affected|overview_research|feature_breakdown|development_start|development_refine_goal|walkthrough_retry|walkthrough_feature_refresh)$/;
    assert.deepEqual(records.operations.filter(({ operation }) => modelOperations.test(operation)), []);
    assert.deepEqual(records.transportCalls, [], 'export IPC must not start a provider CLI or make a network request');
    assert.deepEqual(remoteRequests, [], 'the renderer must export saved diagrams locally');
    const db = new Store(data);
    try { assert.deepEqual(db.all('run'), []); }
    finally { db.close(); }
    assert.deepEqual((await fs.readdir(root)).sort(), ['.git', 'sample.c']);
  } finally { await electron.close(); }
});
