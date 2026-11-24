import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { architectureDocId, type ArchitectureDocument } from '../src/architecture-workspace';
import { architectureIpc } from '../src/main/architecture-ipc';
import { diagramSaveDirectory, exportDiagramFile } from '../src/main/diagram-file';
import { ArcService } from '../src/main/service';
import type { ArcApi } from '../src/shared';
import { exportSavedDiagram, pngDimensions, readExportVersion } from '../src/ui/diagram-export';

test('PNG sizing applies the requested scale within both canvas limits', () => {
  assert.deepEqual(pngDimensions(700, 550, 'standard'), { scale: 2, pixelWidth: 1400, pixelHeight: 1100 });
  assert.equal(pngDimensions(1700, 1200, 'hd').scale, 3);
  assert.equal(pngDimensions(2500, 800, 'auto_large').scale, 3);
  assert.equal(pngDimensions(6000, 800, 'auto_large').scale, 2);
  for (const [w, h] of [[14000, 360], [30000, 42000], [5000, 5000]]) {
    for (const mode of ['standard', 'hd', 'auto_large'] as const) {
      const { pixelWidth, pixelHeight } = pngDimensions(w, h, mode);
      assert.ok(pixelWidth > 0 && pixelHeight > 0 && Math.max(pixelWidth, pixelHeight) <= 16384);
      assert.ok(pixelWidth * pixelHeight <= 64000000);
    }
  }
  assert.throws(() => pngDimensions(0, 123, 'standard'), /尺寸/);
});

test('the writer validates output paths and bytes, respects cancellation, and atomically replaces a file', async t => {
  const base = path.resolve('.test-data');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'export-io-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content_utf8 = '<svg xmlns="http://www.w3.org/2000/svg"><text>储能</text></svg>';
  const svg = { format: 'svg', content_utf8, suggested_name: '测试/图:表.svg' };
  const output_path = path.join(dir, '工程 走读.svg');
  assert.equal(diagramSaveDirectory(dir, path.join(dir, '工程')), dir);
  assert.equal(diagramSaveDirectory(path.join(dir, 'Downloads'), dir), path.dirname(dir));
  const canceled = await exportDiagramFile(svg, async name => { assert.equal(name, '测试_图_表.svg'); return undefined; });
  assert.deepEqual(canceled, { canceled: true, file_path: null, bytes: 0 });
  const noDialog = async (): Promise<never> => { throw new Error('unexpected save dialog'); };
  for (const file of ['relative.svg', path.join(dir, 'wrong.png'), dir + path.sep + '..' + path.sep + 'wrong.svg']) {
    await assert.rejects(exportDiagramFile({ ...svg, output_path: file }, noDialog), /绝对文件路径/);
  }
  await assert.rejects(exportDiagramFile({ ...svg, content_utf8: '<html></html>' }, noDialog), /根元素/);
  await assert.rejects(exportDiagramFile({ ...svg, format: 'png', content_base64: 'bm90IHBuZw==' }, noDialog), /签名/);
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual(await exportDiagramFile({ ...svg, output_path }, noDialog), {
    canceled: false, file_path: output_path, bytes: Buffer.byteLength(content_utf8),
  });
  const changed = content_utf8.replace('储能', '采样');
  await exportDiagramFile({ ...svg, content_utf8: changed, output_path }, noDialog);
  assert.equal(await readFile(output_path, 'utf8'), changed);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTl8AAAAASUVORK5CYII=';
  const pngPath = path.join(dir, '图.png');
  await exportDiagramFile({ format: 'png', suggested_name: '图.png', content_base64: png, output_path: pngPath }, noDialog);
  assert.deepEqual(await readFile(pngPath), Buffer.from(png, 'base64'));
  assert.deepEqual((await readdir(dir)).sort(), [path.basename(output_path), path.basename(pngPath)].sort());
});

test('explicit and picked exports reject the project root and directories reached through junctions', async t => {
  const base = path.resolve('.test-data');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'export-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'), nested = path.join(project, 'sub');
  const alias = path.join(dir, 'project-alias'), sibling = path.join(dir, 'project-other');
  await mkdir(nested, { recursive: true });
  await mkdir(sibling);
  await symlink(project, alias, 'junction');
  const svg = { format: 'svg', suggested_name: 'test.svg', content_utf8: '<svg></svg>' };
  for (const parent of [project, nested, path.join(alias, 'sub')]) {
    const target = path.join(parent, 'test.svg');
    await assert.rejects(exportDiagramFile(svg, async () => target, project), /工程外/);
    await assert.rejects(exportDiagramFile({ ...svg, output_path: target }, async () => undefined, alias), /工程外/);
  }
  assert.deepEqual(await readdir(project), ['sub']);
  assert.deepEqual(await readdir(nested), []);
  const allowed = path.join(sibling, 'test.svg');
  await exportDiagramFile(svg, async () => allowed, project);
  assert.equal(await readFile(allowed, 'utf8'), svg.content_utf8);
});

test('the coordinator binds project, branch and version before rendering and writing', async () => {
  const doc: ArchitectureDocument = { id: 'a', project_id: 'p', branch_key: 'main', version: 4, title: '旧版架构', summary: '',
    modules: [], relations: [], review_items: [], exclusions: [], layout: { positions: {}, manual_positions: [] },
    update_status: 'partial', created_at: '2026-01-01', updated_at: '2026-01-02' };
  const key = { project_id: 'p', branch_key: 'main', version: 4 };
  const operations: string[] = [];
  let head = doc;
  const invoke: ArcApi['invoke'] = async <T>(op: string, args?: unknown) => {
    operations.push(op);
    if (op === 'architecture_get') {
      assert.deepEqual(args, { ...key, document_only: true });
      const frozen = structuredClone(head);
      head = { ...head, title: '较新架构', update_status: 'changes_pending' as const };
      return { document: frozen } as T;
    }
    assert.equal(op, 'export_diagram_file');
    const output = (args as { content_utf8: string }).content_utf8;
    assert.match(output, /旧版架构/);
    assert.match(output, /部分完成/);
    assert.doesNotMatch(output, /较新架构/);
    return { canceled: false, file_path: 'file.svg', bytes: 1024 } as T;
  };
  const previewed = await readExportVersion(invoke, key);
  const source = { mode: 'architecture' as const, document: previewed, options: { projectName: '工程' } };
  await exportSavedDiagram(invoke, source, 'svg', 'standard');
  head = { ...head, version: 5 };
  await assert.rejects(readExportVersion(invoke, key), /保存版本不一致/);
  assert.deepEqual(operations, ['architecture_get', 'export_diagram_file', 'architecture_get']);
});

test('a pinned SQLite read preserves check-only freshness and can open history with the checkout offline', async t => {
  const base = path.resolve('.test-data');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'export-version-'));
  const service = new ArcService(dir, process.cwd());
  t.after(async () => {
    await service.shutdown();
    service.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  service.store.put('project', 'p', { project_id: 'p', root_path: path.join(dir, 'unmounted') });
  const blank = await service.getArchitectureDocument('p', { branchKey: 'offline' });
  const original = service.store.saveArchitectureDoc(blank, 0);
  service.store.patchArchitectureCheckState(architectureDocId('p', 'offline'), 1, undefined, 'changes_pending');
  const args = { project_id: 'p', branch_key: 'offline', version: 1, document_only: true };
  const getVersion = async () => {
    const response = await architectureIpc(service, 'architecture_get', args);
    assert.ok('document' in response && response.document);
    return response.document;
  };
  assert.equal((await getVersion()).update_status, 'changes_pending');
  service.store.saveArchitectureDoc({ ...original, title: '另一版' }, 1);
  assert.deepEqual(await getVersion(), original);
});
