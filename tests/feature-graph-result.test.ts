import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { featureGraphSchema, prepareFeatureGraph } from '../src/main/feature-graph-result';
import type { runCodex } from '../src/main/providers';
import { ArcService } from '../src/main/service';
import { capture } from '../src/main/snapshot';
import { validateResult } from '../src/main/validation';
import { hasFunctionGraphs, type Run } from '../src/shared';

const lines = [
  'static int last;',
  'int record(int value) {',
  '  last = value;',
  '  return value;',
  '}',
  'int submit(int value) {',
  '  return record(value);',
  '}',
];
function graphDraft() {
  const entry = { id: 'start', kind: 'entry', from_function_id: null, to_function_id: 'submit', text: '进入提交函数',
    input: 'value', output: '进入函数体', condition: null, evidence_ids: ['submit-def'] };
  return {
    schema_version: 'feature-graph-1', summary: { text: '提交时保存传入值并返回。', evidence_ids: ['site', 'record-def'] },
    scope: 'main.c 的提交路径', unresolved: ['外部调用者未查明'],
    functions: ['submit', 'record'].map(symbol => ({ id: symbol, label: symbol, symbol, signature: `int ${symbol}(int value)`,
      description: symbol === 'record' ? '保存并返回传入值。' : '调用记录函数。',
      definition_evidence_id: symbol + '-def', evidence_ids: [symbol + '-def'], params: [{ name: 'value', type: 'int', description: '待记录的值' }],
      returns: '传入的整数', side_effects: symbol === 'record' ? ['写入 last'] : [] })),
    calls: [{ id: 'invoke', from: 'submit', to: 'record', kind: 'sync_call', label: '保存传入值', condition: null, evidence_ids: ['site'] }],
    walkthroughs: [{ id: 'path', label: '提交', trigger: '调用 submit', entry_function_id: 'submit', outcome: '返回保存值', boundary: '未执行代码',
      steps: [entry, { ...entry, id: 'call', kind: 'call', from_function_id: 'submit', to_function_id: 'record', text: '调用记录函数', evidence_ids: ['site'] }] }],
    evidence: [{ id: 'submit-def', path: 'main.c', start: 6, end: 8, quote: lines[5] },
      { id: 'record-def', path: 'main.c', start: 2, end: 5, quote: lines[1] },
      { id: 'site', path: 'main.c', start: 7, end: 7, quote: lines[6] }],
  };
}
async function workspace(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-feature-graph-'));
  const root = path.join(dir, 'src'), storage = path.join(dir, 'data');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.c'), [...lines, ...Array(40).fill('')].join('\r\n'));
  return { root, storage, clean: () => fs.rm(dir, { recursive: true }) };
}
async function fixture(t: TestContext) {
  const { root, storage, clean } = await workspace(t);
  t.after(clean);
  const snapshot = await capture(root, 'project', storage, '');
  const run: Run = { binding: { project_id: 'project', source_snapshot_id: snapshot.source_snapshot_id, run_id: 'run',
    scenario_id: 'scenario', question_revision_id: 'revision', feature_id: 'feature' },
    title: '提交功能', question: '如何保存？', provider_id: 'codex', status: 'running', created_at: '2026-01-01',
    submission_key: 'test', output_path: '' };
  return { prepare: (draft: ReturnType<typeof graphDraft>) => prepareFeatureGraph(draft, run, snapshot, storage), run, snapshot, storage };
}

test('compact feature graph expands verified frozen evidence into both graphs and the reading guide', async t => {
  const { prepare, run, snapshot, storage } = await fixture(t);
  const draft = graphDraft(), original = structuredClone(draft);
  const result = await prepare(draft);
  assert.deepEqual((await validateResult(result, run, snapshot, storage)).errors, []);
  assert.ok(hasFunctionGraphs(result));
  assert.deepEqual(draft, original);
  assert.deepEqual(await prepare(draft), result);
  assert.deepEqual(result.evidence.map(e => e.content_sha256), draft.evidence.map(() => snapshot.files[0].content_sha256));
  assert.deepEqual(result.evidence.map(e => [e.role, e.symbol_id]), [['definition', 'submit'], ['definition', 'record'], ['callsite', undefined]]);
  const record = result.nodes[1];
  assert.deepEqual(record.function_details?.parameter_io_ids, [record.inputs[0].io_id]);
  assert.deepEqual(record.function_details?.return_io_ids, [record.outputs[0].io_id]);
  assert.equal(record.outputs[1].description, '写入 last');
  assert.deepEqual(result.gaps.map(gap => gap.question), draft.unresolved);
  const guide = result.reading_guide!;
  assert.deepEqual(guide.paths[0].step_ids, guide.steps.map(s => s.id));
  assert.deepEqual(guide.files.map(f => f.path), ['main.c']);
  assert.deepEqual(guide.files[0].step_ids, guide.paths[0].step_ids);
});

test('feature graph rejects a wrong verbatim quote and an overlong frozen range', async t => {
  const { prepare } = await fixture(t);
  const draft = graphDraft();
  draft.evidence[0].quote = 'int save(int value)';
  draft.evidence[1].end = 42;
  await assert.rejects(prepare(draft), error => {
    assert.match((error as Error).message, /submit-def.*引用原文不在/);
    assert.match((error as Error).message, /record-def.*不超过 40 行/);
    return true;
  });
});

test('functions, calls and evidence may share an ID while duplicates in one collection fail', async t => {
  const { run, snapshot, storage } = await fixture(t), draft = graphDraft();
  const walk = draft.walkthroughs[0], fn = draft.functions[0], call = draft.calls[0];
  fn.id = fn.definition_evidence_id = draft.evidence[0].id = call.id = 'publish';
  fn.evidence_ids = walk.steps[0].evidence_ids = ['publish'];
  walk.entry_function_id = walk.steps[0].to_function_id = walk.steps[1].from_function_id = call.from = 'publish';
  const { quote, ...range } = draft.evidence[0];
  const result = await prepareFeatureGraph({ ...draft, evidence: [range, ...draft.evidence.slice(1)] }, run, snapshot, storage);
  assert.equal(result.nodes[0].node_id, 'publish');
  assert.equal(result.edges[0].edge_id, 'publish');
  assert.equal(result.evidence[0].evidence_id, 'publish');
  assert.equal(result.evidence[0].note, lines.slice(5, 8).join('\n'));
  draft.functions.push({ ...fn, definition_evidence_id: 'site' });
  await assert.rejects(prepareFeatureGraph(draft, run, snapshot, storage), /node_id 重复 ID：publish/);
});

test('feature graph rejects broken cross-references and mismatched call/dispatch steps', async t => {
  const { prepare } = await fixture(t);
  const draft = graphDraft();
  draft.calls[0].from = 'missing';
  await assert.rejects(prepare(draft), /invoke.*未知函数：missing/);
  draft.calls[0].from = 'submit';
  draft.walkthroughs[0].steps[1].kind = 'dispatch';
  await assert.rejects(prepare(draft), /path\/call.*submit → record.*execution_boundary/);
  draft.walkthroughs[0].steps[1].kind = 'call';
  draft.functions[0].definition_evidence_id = 'unknown';
  await assert.rejects(prepare(draft), /定义依据不存在：unknown/);
  draft.functions[0].definition_evidence_id = 'submit-def';
  draft.summary.evidence_ids = ['uncited'];
  await assert.rejects(prepare(draft), /缺失引用 evidence_ids: uncited/);
});

test('Codex uses feature-graph-1 for generation and one low-effort canonical-validation repair', async t => {
  const { root, storage, clean } = await workspace(t);
  const calls: Parameters<typeof runCodex>[0][] = [];
  const runner: typeof runCodex = async options => {
    calls.push(options);
    options.started({ child: { pid: 123 } as any, cancel: async () => {} });
    const draft = graphDraft();
    if (calls.length === 1) draft.calls = [];
    return { code: 0, stderr: '', raw: JSON.stringify(draft) };
  };
  const service = new ArcService(storage, path.resolve('.'), undefined, runner);
  t.after(async () => { await service.shutdown(); service.store.close(); await clean(); });
  const project = await service.openProject(root);
  const { scenario } = service.addFeature(project.project_id, '提交');
  service.store.put('provider', 'codex', { status: 'available', checked_at: new Date().toISOString(), version: 'injected-runner' });
  const run = await service.startRun(scenario.scenario_id, 'codex', 'feature-graph-repair');
  await service.executing.get(run.binding.run_id);
  const saved = service.store.get<Run>('run', run.binding.run_id);
  assert.equal(saved.status, 'completed', saved.error);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(options => options.outputSchema === featureGraphSchema));
  assert.equal(calls[1].reasoningEffort, 'low');
  assert.match(calls[1].prompt, /submit → record.*sync_call/);
  assert.equal(service.data().explanations.length, 1);
  assert.ok(hasFunctionGraphs(service.data().explanations[0].result));
  assert.equal(service.data().explanations[0].result.provider.runtime_version, 'injected-runner');
});

test('DSH feature graphs use the compact schema and can revalidate a saved reply without another dispatch', async t => {
  const { root, storage, clean } = await workspace(t);
  let requests = 0;
  const service = new ArcService(storage, path.resolve('.'), undefined, undefined, async options => {
    requests++;
    assert.equal(options.outputSchema, featureGraphSchema);
    assert.match(options.prompt, /feature-graph-1/);
    const raw = JSON.stringify(graphDraft());
    await fs.mkdir(path.dirname(options.run.output_path), { recursive: true });
    await fs.writeFile(options.run.output_path, raw);
    return { code: 1, stderr: 'test transport stopped after writing the reply', raw };
  });
  t.after(async () => { await service.shutdown(); service.store.close(); await clean(); });
  const project = await service.openProject(root);
  const { scenario } = service.addFeature(project.project_id, '提交');
  service.store.put('provider', 'dsh', { status: 'available', transport: 'dsh web', checked_at: new Date().toISOString() });
  const run = await service.startRun(scenario.scenario_id, 'dsh', 'feature-graph-dsh-replay');
  await service.executing.get(run.binding.run_id);
  assert.equal(service.store.get<Run>('run', run.binding.run_id).status, 'failed');
  assert.equal((await service.revalidate(run.binding.run_id)).status, 'completed');
  assert.equal(requests, 1);
  const result = service.data().explanations[0].result;
  assert.deepEqual(result.binding, run.binding);
  assert.equal(result.provider.provider_id, 'dsh');
  assert.ok(hasFunctionGraphs(result));
});
