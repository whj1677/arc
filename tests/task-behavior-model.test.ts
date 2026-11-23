import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { CodeState, DevelopmentStep, EngineeringTask, VerificationEvidence } from '../src/engineering';
import { buildTaskHud } from '../src/main/development-hud';
import { capture } from '../src/main/snapshot';
import { Store } from '../src/main/store';
import { projectTaskBehavior } from '../src/ui/task-behavior-model';

const time = '2026-11-23T00:00:00Z';
const state: CodeState = {
  snapshot_id: 'before', fingerprint: 'source', workspace_fingerprint: 'workspace',
  head: null, branch: null, git_common_dir: null, dirty: [], captured_at: time,
};
const step: DevelopmentStep = {
  step_id: 'search', title: '按名称筛选记录', change: '为列表接入筛选条件', status: 'completed', progress: '已接入列表',
  criteria: [
    {criterion_id: 'match', text: '有匹配时只显示匹配记录', evidence_ids: []},
    {criterion_id: 'empty', text: '无匹配时展示空列表', evidence_ids: []},
  ],
  evidence_ids: [], unresolved: [], created_at: time, updated_at: time,
};
const behavior = {
  id: 'filter', behavior: '筛选记录', design: '复用列表查询', files: ['main.ts'], step_ids: ['search'],
  verification: '覆盖有匹配和无匹配两种情况',
};
const change = {path: 'main.ts', before_sha256: 'old', after_sha256: 'new', ownership: 'task_change' as const};

function task(overrides: Partial<EngineeringTask> = {}): EngineeringTask {
  return {
    task_id: 'task', project_id: 'project', workspace_id: 'workspace', workspace_path: '.',
    version: 2, submission_key: 'submit', goal: '按名称筛选记录', scope: ['main.ts'],
    status: 'completed', baseline: state, end_state: state, context_version: 1,
    summary: '已修改列表', decisions: [], unresolved: [], changes: [],
    verification: [], verification_status: 'not_run', attempt_ids: [], created_at: time, updated_at: time,
    saved: 'saved', ...overrides,
  };
}

function receipt(id: string, overrides: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    evidence_id: id, command: 'npm test', cwd: '.', outcome: 'passed', exit_code: 0, origin: 'observed',
    code_state: state, created_at: time, log_path: id + '.log', step_id: 'search', ...overrides,
  };
}

test('the requirement package groups only linked active steps and preserves actual reading and decision records', () => {
  const reading: EngineeringTask['reading'] = {
    feature_id: 'list', scenario_id: 'filtering', result_id: 'reading', source_snapshot_id: 'before',
    target: {kind: 'step', id: 'step'}, evidence: {evidence_id: 'source', path: 'main.ts', line_start: 2, line_end: 3},
  };
  const model = projectTaskBehavior(task({
    workflow: 'ready', status: 'pending', reading, decisions: ['复用列表接口'],
    steps: [{...step, status: 'pending'}, {...step, step_id: 'old', status: 'superseded'}],
    requirement_package: {
      behaviors: [{...behavior, step_ids: ['search', 'old']}], non_goals: ['保持排序不变'],
      open_questions: ['筛选是否区分大小写？'], risks: ['大列表响应时间待核对'],
    },
    unresolved: ['确认列表数据'], changes_status: 'needs_review',
    changes: [{...change, ownership: 'preexisting_overlap'}],
  }));
  assert.equal(model.phase, 'plan');
  assert.deepEqual(model.behaviors.map(item => [item.id, item.implementation]), [['filter', 'planned']]);
  assert.deepEqual(model.behaviors[0].acceptance.map(item => item.criterionId), ['match', 'empty']);
  assert.deepEqual(model.behaviors[0].before, reading.evidence);
  assert.deepEqual(model.constraints.non_goals, ['保持排序不变']);
  assert.deepEqual(model.decisions, ['复用列表接口']);
  assert.equal(model.attention.decisions.length, 3);
  assert.equal(model.attention.ownership.length, 2);
  assert.equal(model.tone, 'warning');
});

test('implementation, build receipts, observed results and Agent claims stay independent', () => {
  const second = {...step, step_id: 'secondary', title: '另一份列表', criteria: [step.criteria[0]]};
  const model = projectTaskBehavior(task({
    steps: [{...step, criteria: [{...step.criteria[0], evidence_ids: ['build']}, step.criteria[1]]}, second],
    changes: [change], verification_status: 'passed',
    verification: [
      receipt('build', {command: 'cmake -S . -B build && cmake --build build', step_id: undefined}),
      receipt('claim', {criterion_id: 'empty', origin: 'self_reported', code_state_verified: false}),
      receipt('step-only'),
    ],
  }));
  assert.equal(model.behaviors[0].implementation, 'implemented');
  assert.deepEqual(model.behaviors[0].acceptance.map(row => row.verification), ['partial', 'agent_claimed']);
  assert.equal(model.behaviors[1].acceptance[0].verification, 'unverified');
  assert.equal(model.tone, 'warning');
});

test('known stale and failed evidence stays on its own criteria and an active task remains in development', () => {
  const model = projectTaskBehavior(task({
    status: 'running', workflow: 'execution', steps: [step],
    verification: [
      receipt('older', {criterion_id: 'match', code_state: {...state, workspace_fingerprint: 'old'}}),
      receipt('failed', {criterion_id: 'empty', outcome: 'failed', exit_code: 1}),
    ],
  }));
  assert.equal(model.phase, 'developing');
  assert.deepEqual(model.behaviors[0].acceptance.map(row => row.verification), ['stale', 'failed']);
  assert.equal(model.tone, 'danger');
});

test('simple and historical tasks fall back to the recorded goal, never to global pass status', () => {
  const current = projectTaskBehavior(task({steps: [{...step, status: 'superseded'}], changes: [change], verification_status: 'passed'}));
  assert.equal(current.behaviors.length, 1);
  assert.equal(current.behaviors[0].title, '按名称筛选记录');
  assert.equal(current.behaviors[0].implementation, 'implemented');
  assert.equal(current.behaviors[0].verification, 'unverified');
  const historical = projectTaskBehavior(task({
    origin: 'legacy_import', verification: [receipt('import', {origin: 'self_reported', step_id: undefined})],
  }));
  assert.equal(historical.behaviors[0].verification, 'agent_claimed');
  assert.equal(historical.behaviors[0].before, undefined);
});

test('an accepted task with no outstanding items collapses attention only after observed verification', () => {
  const model = projectTaskBehavior(task({
    requirement_package: {behaviors: [behavior]}, steps: [step],
    verification: [receipt('match', {criterion_id: 'match'}), receipt('empty', {criterion_id: 'empty'})],
  }));
  assert.equal(model.phase, 'acceptance');
  assert.equal(model.behaviors[0].verification, 'verified');
  assert.equal(model.hasAttention, false);
  assert.equal(model.tone, 'success');
});

test('delivery HUD provides separate frozen blueprint and actual evolution only when a plan exists', async t => {
  const scratch = path.resolve('.test-data');
  await fs.mkdir(scratch, {recursive: true});
  const dir = await fs.mkdtemp(path.join(scratch, 'behavior-blueprint-'));
  const storage = path.join(dir, 'data'), root = path.join(dir, 'workspace');
  const store = new Store(storage);
  t.after(async () => {
    store.db.close();
    await fs.rm(dir, {recursive: true, force: true});
  });
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.ts'), 'export function list() { return []; }\n');
  const before = await capture(root, 'project', storage, '');
  await fs.writeFile(path.join(root, 'main.ts'), 'export function list() { return ["alpha"]; }\n');
  const after = await capture(root, 'project', storage, '');
  for (const snapshot of [before, after]) store.put('snapshot', snapshot.source_snapshot_id, snapshot);
  store.put('project', 'project', {project_id: 'project', snapshot_id: after.source_snapshot_id, root_path: root});
  const saved = task({
    baseline: {...state, snapshot_id: before.source_snapshot_id},
    end_state: {...state, snapshot_id: after.source_snapshot_id},
    requirement_package: {behaviors: [behavior]},
    changes: [{...change, before_sha256: before.files[0].content_sha256, after_sha256: after.files[0].content_sha256}],
  });
  store.put('engineering_task', saved.task_id, saved);
  const hud = await buildTaskHud(store, storage, saved.task_id);
  assert.equal(hud.evolution?.mode, 'task_actual');
  assert.equal(hud.evolution?.target_snapshot_id, after.source_snapshot_id);
  assert.deepEqual(hud.evolution?.changed_files.map(file => file.path), ['main.ts']);
  assert.equal(hud.blueprintEvolution?.mode, 'task_blueprint');
  assert.equal(hud.blueprintEvolution.base_snapshot_id, before.source_snapshot_id);
  assert.equal(hud.blueprintEvolution.target_snapshot_id, undefined);
  assert.equal(hud.blueprintEvolution.verification_badge, undefined);
  assert.deepEqual(hud.blueprintEvolution.changed_files, []);
  assert.deepEqual(hud.blueprintEvolution.approach.map(item => [item.id, item.status]), [['filter', 'planned']]);
  store.put('engineering_task', saved.task_id, {...saved, scope: [], requirement_package: undefined});
  assert.equal((await buildTaskHud(store, storage, saved.task_id)).blueprintEvolution, undefined);
});
