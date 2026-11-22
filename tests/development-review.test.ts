import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import type {EngineeringContext, EngineeringTask} from '../src/engineering';
import type {ProviderProfile} from '../src/shared';
import {reviewDevelopmentDiff} from '../src/main/development-review';

test('review uses scoped Git data, validates the reviewer verdict and bounds the UTF-8 diff', async t => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, {recursive: true});
  const workspace = await fs.mkdtemp(path.join(base, 'diff-review-'));
  t.after(() => fs.rm(workspace, {recursive: true, force: true}));
  const git = (...args: string[]) => execFileSync('git', args, {cwd: workspace, encoding: 'utf8', windowsHide: true});
  git('init', '--quiet');
  await fs.writeFile(path.join(workspace, 'code.ts'), 'old\n');
  await fs.writeFile(path.join(workspace, 'other.ts'), 'unrelated\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=arc@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const options = {
    workspace, writeScope: ['code.ts'], verificationSummary: '跳过本机 CMake', preferences: {model: 'selected', reasoning_effort: 'high'} as const,
    profile: {path: 'chosen-codex'} as ProviderProfile, task: {goal: '解析空输入', boundaries: {non_goals: ['保留接口'], revoked: []}} as unknown as EngineeringTask,
    context: {code_state: {head: git('rev-parse', 'HEAD').trim(), dirty: []}} as unknown as EngineeringContext,
  };
  await fs.writeFile(path.join(workspace, 'other.ts'), 'OUT_OF_SCOPE\n');
  const approved = {verdict: 'approved', summary: '复核通过', blocking_issues: [], notes: []};
  const empty = await reviewDevelopmentDiff(options, () => assert.fail('empty scoped diff should not start Codex'));
  assert.deepEqual(empty, {verdict:'no_diff', summary:'批准范围内无代码差异，无需审查。', blocking_issues:[], notes:[]});
  await fs.writeFile(path.join(workspace, 'code.ts'), '新增逻辑。'.repeat(40000) + '\n');
  git('add', 'code.ts');
  Object.assign(options.task, {
    approval: {reviewed_version: 1, scope: options.writeScope}, requirement_package: {behaviors: []},
    requests: [{text: 'SUPERSEDED_REQUEST'}],
    steps: [{title: 'SUPERSEDED_STEP', status: 'superseded'}, {title: '保留当前验收', criteria: []}],
  });
  const review = await reviewDevelopmentDiff(options, async (prompt, schema, cli, preferences) => {
    assert.equal(cli, options.profile.path);
    assert.deepEqual(preferences, {model: 'selected', reasoning_effort: 'low'});
    assert.equal((schema as {additionalProperties: boolean}).additionalProperties, false);
    assert.match(prompt, /解析空输入/);
    assert.match(prompt, /保留接口/);
    assert.match(prompt, /保留当前验收/);
    assert.doesNotMatch(prompt, /SUPERSEDED/);
    assert.match(prompt, /跳过本机 CMake/);
    assert.doesNotMatch(prompt, /OUT_OF_SCOPE/);
    const diff = prompt.split('代码差异：\n').at(-1)!;
    assert.ok(Buffer.byteLength(diff) <= 32 * 1024);
    assert.match(diff, /新增逻辑/);
    assert.doesNotMatch(diff, /�/);
    return JSON.stringify(approved);
  });
  assert.match(review.notes.join(' '), /32 KiB/);
  for (const invalid of [{...approved, verdict: 'needs_fix'}, {...approved, verdict: 'no_diff'}, {...approved, extra: 1}, {summary: 'ok'}]) {
    await assert.rejects(reviewDevelopmentDiff(options, async () => JSON.stringify(invalid)), /合同校验/);
  }

  const baselineRoot = path.join(workspace, 'frozen');
  await fs.mkdir(baselineRoot);
  await fs.writeFile(path.join(baselineRoot, 'local.ts'), 'preexisting\n');
  const nested = path.join(workspace, 'ignored-project');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored-project/\n');
  await fs.writeFile(path.join(nested, 'local.ts'), 'nested change\n');
  assert.equal(git('-C', nested, 'ls-files', '--', 'local.ts'), '');
  assert.equal(git('-C', nested, 'rev-parse', 'HEAD').trim(), options.context.code_state.head);
  const nestedReview = await reviewDevelopmentDiff({...options, workspace: nested, baselineRoot, writeScope: ['local.ts']}, async prompt => {
    assert.match(prompt, /-preexisting\r?\n\+nested change/);
    return JSON.stringify(approved);
  });
  assert.deepEqual(nestedReview, approved);

  await fs.writeFile(path.join(workspace, 'local.ts'), 'changed in task\n');
  options.context.code_state.dirty = ['local.ts'];
  for (const head of [options.context.code_state.head, null]) {
    options.context.code_state.head = head;
    if (!head) await fs.rename(path.join(workspace, '.git'), path.join(workspace, 'git-fixture'));
    const local = await reviewDevelopmentDiff({...options, baselineRoot, writeScope: ['local.ts']}, async prompt => {
      assert.match(prompt, /-preexisting\r?\n\+changed in task/);
      assert.doesNotMatch(prompt, /OUT_OF_SCOPE/);
      return JSON.stringify(approved);
    });
    assert.deepEqual(local, approved);
  }
  await fs.rm(path.join(workspace, 'local.ts'));
  const deletion = await reviewDevelopmentDiff({...options, baselineRoot, writeScope: ['local.ts']}, async prompt => {
    assert.match(prompt, /-preexisting/);
    assert.match(prompt, /deleted file mode/);
    return JSON.stringify(approved);
  });
  assert.deepEqual(deletion, approved);
});
