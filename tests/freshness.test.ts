import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { explanationFreshness } from '../src/freshness';
import { ArcService } from '../src/main/service';
import type { Explanation } from '../src/shared';

function explanation(projectId: string, snapshotId: string, paths: string[]): Explanation {
  const resultId = 'result-' + paths[0];
  return {
    result_id: resultId, scenario_id: 'scenario', created_at: '', source_status: 'current',
    result: {
      schema_version: '1.0', fictional: true, result_id: resultId,
      binding: { project_id: projectId, feature_id: 'feature', scenario_id: 'scenario', question_revision_id: 'question', source_snapshot_id: snapshotId, run_id: 'run' },
      provider: { provider_id: 'codex', connection_id: 'local', adapter_version: 'test' },
      summary: { text: '测试', claim_ids: [] }, coverage: { covered_scope: [], unresolved_scope: [] },
      nodes: [], edges: [], claims: [], gaps: [],
      evidence: paths.map((file, i) => ({
        evidence_id: 'ev-' + i, source_snapshot_id: snapshotId, path: file,
        line_start: 1, line_end: 1, content_sha256: '0'.repeat(64), role: 'definition', note: '',
      })),
    },
  };
}

test('freshness uses unique cited paths, including equivalent Windows separators, and distinguishes historical results', () => {
  const saved = explanation('p', 'snapshot-1', ['src/a.c', 'src\\a.c', 'src/b.c']);
  assert.deepEqual(explanationFreshness(saved, 'snapshot-1', []), { kind: 'current' });
  assert.deepEqual(explanationFreshness(saved, 'snapshot-1', ['docs.md', 'src\\a.c', 'src/b.c']),
    { kind: 'affected', files: ['src/a.c', 'src/b.c'] });
  assert.deepEqual(explanationFreshness(saved, 'snapshot-1', ['docs.md']), { kind: 'other_changed', count: 1 });
  saved.source_status = 'needs_review';
  assert.deepEqual(explanationFreshness(saved, 'snapshot-2', []), { kind: 'other_changed', count: 0 });
  assert.deepEqual(explanationFreshness(saved, 'snapshot-2', ['one.c', 'two.c']), { kind: 'other_changed', count: 2 });
});

test('external checks share one scan, save exact changes, restore reverted explanations and reset on refresh', async t => {
  const temporaryRoot = path.resolve('.test-data');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'freshness-unit-'));
  const root = path.join(directory, 'repo');
  const service = new ArcService(path.join(directory, 'data'), path.resolve('.'));
  t.after(async () => { service.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.c'), 'int a;');
  await fs.writeFile(path.join(root, 'b.c'), 'int b;');
  const project = await service.openProject(root, true);
  const state = () => service.data().project_freshness?.[project.project_id];
  const sourceStatus = (saved: Explanation) => service.store.get<Explanation>('explanation', saved.result_id).source_status;
  assert.equal(state()?.snapshot_id, project.snapshot_id);
  assert.deepEqual(state()?.changed_files, []);
  const affected = explanation(project.project_id, project.snapshot_id, ['a.c']);
  const unaffected = explanation(project.project_id, project.snapshot_id, ['b.c']);
  for (const saved of [affected, unaffected]) service.store.put('explanation', saved.result_id, saved);

  await fs.writeFile(path.join(root, 'a.c'), 'int edited;');
  await fs.writeFile(path.join(root, 'new.c'), 'int added;');
  const pending = service.checkFreshness(project.project_id);
  assert.equal(service.checkFreshness(project.project_id), pending);
  const checked = await pending;
  assert.deepEqual(checked.changed_files, ['a.c', 'new.c']);
  assert.equal(checked.snapshot_id, project.snapshot_id);
  assert.ok(Number.isFinite(Date.parse(checked.checked_at)));
  assert.deepEqual(state(), checked);
  assert.equal(sourceStatus(affected), 'needs_review');
  assert.equal(sourceStatus(unaffected), 'current');

  await fs.writeFile(path.join(root, 'a.c'), 'int a;');
  await service.openProject(root, true);
  assert.deepEqual(state()?.changed_files, ['new.c']);
  assert.equal(sourceStatus(affected), 'current');
  const refreshed = await service.refresh(project.project_id);
  assert.equal(state()?.snapshot_id, refreshed.source_snapshot_id);
  assert.deepEqual(state()?.changed_files, []);
  assert.equal(sourceStatus(affected), 'needs_review');
});
