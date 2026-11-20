import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ArcService } from '../src/main/service';
import { featureGraphSchema } from '../src/main/feature-graph-result';
import { parseScenarioProposals, scenarioBreakdownSchema } from '../src/main/scenario-breakdown';
import type { runCodex } from '../src/main/providers';
import type { runDshWeb } from '../src/main/dsh-web';
import type { Scenario, Run } from '../src/shared';

const proposals = ['enqueue', 'dequeue', 'resetQueue'].map(symbol => ({
  title: symbol, question: `调用 ${symbol} 时，队列如何变化？`, rationale: '追踪队列的状态变化', entry_hint: `queue.c: ${symbol}`,
}));

test('breakdown validates the model contract before filtering existing and repeated titles', () => {
  const reply = { proposals };
  assert.deepEqual(parseScenarioProposals(reply, []), proposals);
  assert.deepEqual(parseScenarioProposals({ proposals: [...proposals, proposals[1]] }, [' EnQueue ']), proposals.slice(1));
  for (const invalid of [
    { proposals: proposals.slice(0, 2) }, { proposals: [...proposals, ...proposals, proposals[0]] },
    { proposals, extra: true }, { proposals: [{ ...proposals[0], extra: 5 }, ...proposals.slice(1)] },
    ...Object.entries({ title: 40, question: 300, rationale: 120, entry_hint: 120 }).flatMap(([key, max]) =>
      ['   ', 'x'.repeat(max + 1)].map(value => ({ proposals: [{ ...proposals[0], [key]: value }, ...proposals.slice(1)] }))),
  ]) assert.throws(() => parseScenarioProposals(invalid, []), /返回格式无效/);
});

for (const engine of ['codex', 'dsh'] as const) {
  test(`breakdown uses the bound snapshot via ${engine} and additions retain titles, revisions and dual-graph routing`, async t => {
    const testData = path.resolve('.test-data');
    await fs.mkdir(testData, { recursive: true });
    const root = await fs.mkdtemp(path.join(testData, 'scenario-breakdown-'));
    const projectPath = path.join(root, 'project');
    await fs.mkdir(projectPath);
    await fs.writeFile(path.join(projectPath, 'queue.c'), proposals.map(p => `void ${p.title}(void) {}`).join('\n'));
    const turns: Array<Parameters<typeof runCodex>[0] | Parameters<typeof runDshWeb>[0]> = [];
    let response = JSON.stringify({ proposals });
    const run = async (options: (typeof turns)[number]) => {
      turns.push(options);
      if (options.outputSchema === featureGraphSchema) throw Error('stop after observing graph request');
      return { code: 0, raw: response, stderr: '' };
    };
    const service = new ArcService(path.join(root, 'data'), path.resolve('.'), undefined, run, run);
    t.after(async () => { await service.shutdown(); service.store.close(); await fs.rm(root, { recursive: true, force: true }); });
    const project = await service.openProject(projectPath);
    const { feature } = service.addFeature(project.project_id, '队列');
    service.addScenario(feature.feature_id, proposals[0].question, proposals[0].title);
    service.store.put('settings', 'default_engine', engine);
    service.store.put('settings', 'codex_preferences', { model: 'selected-model', reasoning_effort: 'high' });
    service.store.put('provider', engine, { status: 'available', checked_at: new Date().toISOString(), transport: 'dsh web' });
    // Live edits after capture must neither supply nor invalidate the proposed source anchors.
    await fs.writeFile(path.join(projectPath, 'queue.c'), 'void onlyInWorkspace(void) {}');
    const result = await service.breakdownFeature(feature.feature_id);
    assert.equal(result.engine, engine);
    assert.ok(result.duration_ms >= 0);
    assert.deepEqual(result.proposals, proposals.slice(1));
    const call = turns[0];
    assert.ok('binding' in call.run);
    assert.equal(call.run.binding.source_snapshot_id, project.snapshot_id);
    assert.equal(call.outputSchema, scenarioBreakdownSchema);
    assert.ok(call.timeoutMs! <= 120000 && call.timeoutMs! > 0);
    assert.match(call.prompt, /source_directories/);
    assert.match(call.prompt, /enqueue/);
    if (engine === 'codex') {
      assert.ok('preferences' in call);
      assert.equal(call.preferences.model, 'selected-model');
      assert.equal(call.reasoningEffort, 'low');
    }
    const discovery = { result_id: 'overview', source_snapshot_id: project.snapshot_id, node_id: 'queue' };
    service.store.put('feature', feature.feature_id, { ...feature, discovery });
    service.store.put('explanation', discovery.result_id, { scenario_id: 'project-overview', result: {
      binding: { feature_id: 'overview-feature', source_snapshot_id: project.snapshot_id },
      nodes: [{ node_id: 'queue', evidence_ids: ['entry'] }],
      feature_catalog: { readings: [{ node_id: 'queue', steps: [{ evidence_ids: ['step'] }] }] },
      evidence: ['entry', 'step', 'other-feature'].map(ref => ({ evidence_id: ref, path: 'queue.c', line_start: 1, line_end: 2, note: ref + '-anchor' })),
    } });
    response = JSON.stringify({ proposals: [...proposals.slice(0, 2), { ...proposals[2], entry_hint: 'queue.c: onlyInWorkspace' }] });
    await assert.rejects(service.breakdownFeature(feature.feature_id), /入口与冻结源码不匹配/);
    assert.match(turns[1].prompt, /entry-anchor/);
    assert.match(turns[1].prompt, /step-anchor/);
    assert.doesNotMatch(turns[1].prompt, /other-feature-anchor/);
    const p = result.proposals[0];
    const scene = service.addScenario(feature.feature_id, p.question, p.title, 'breakdown');
    assert.equal(service.store.get<Scenario>('scenario', scene.scenario_id).title, p.title);
    assert.equal(service.store.get('revision', scene.question_revision_id).question, p.question);
    assert.throws(() => service.addScenario(feature.feature_id, p.question, p.title, 'breakdown'), /同名子场景/);
    const legacy = service.addScenario(feature.feature_id, '手动提问');
    assert.equal(legacy.title, '手动提问');
    assert.equal(legacy.kind, undefined);
    // Deliberately stop at the runner boundary. The existing graph suite covers graph parsing and persistence.
    const request = await service.startRun(scene.scenario_id, engine, 'breakdown-graph-contract');
    await service.executing.get(request.binding.run_id);
    assert.equal(turns.at(-1)?.outputSchema, featureGraphSchema);
    assert.equal(service.store.get<Run>('run', request.binding.run_id).feature_graph_format, 'feature-graph-1');
  });
}
