import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditDelivery, inspectVerificationOutput} from '../src/delivery-audit';
import type {CodeState, EngineeringTask, VerificationEvidence} from '../src/engineering';

test('reads individual test counts from TAP, Vitest, Jest, pytest, Go, Gradle and Surefire', () => {
  const summaries = [
    ['node --test', '# tests 3\n# pass 2\n# fail 0\n# skipped 1'],
    ['vitest run', 'Test Files  1 passed (1)\n      Tests  2 passed | 1 skipped (3)'],
    ['jest', 'Test Suites: 1 passed, 1 total\nTests:       1 skipped, 2 passed, 3 total'],
    ['pytest', '====== 2 passed, 1 skipped in 0.18s ======'],
    ['go test -v', '--- PASS: TestA (0.00s)\n    --- PASS: TestA/sub (0.00s)\n--- PASS: TestB (0.00s)\n--- SKIP: TestC (0.00s)'],
    ['gradlew test', '3 tests completed, 1 skipped'],
    ['mvn test', '[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 1, Time elapsed: 0.1 s -- in demo.Test\n[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 1'],
  ];
  for (const [command, output] of summaries) {
    const result = inspectVerificationOutput(command, 0, output);
    assert.equal(result.passed, 2, command); assert.equal(result.total, 3, command); assert.equal(result.skipped, 1, command);
    assert.ok(!result.suspicious_empty, command);
  }
  assert.equal(inspectVerificationOutput('pytest', 1, '2 failed, 1 passed in 0.16s').failed, 2);
  assert.equal(inspectVerificationOutput('npm run build', 0, 'compiled').total, undefined);
});

test('recognizes zero tests, all-skipped runs and explicit skip flags without flagging a tested Go package', () => {
  for (const [command, output] of [
    ['node --test', '# tests 0\n# pass 0\n# skipped 0'], ['npm test', ''], ['pytest', 'no tests ran in 0.02s'],
    ['pytest', '===== 4 deselected in 0.02s ====='], ['pytest', '5 skipped in 0.22s'],
    ['vitest', 'No test files found, exiting with code 0'], ['go test ./...', '? module/foo [no test files]'],
    ['gradlew test', '> Task :test NO-SOURCE\nBUILD SUCCESSFUL'], ['go test ./...', 'ok  example/logic  (cached)'],
  ]) assert.equal(inspectVerificationOutput(command, 0, output).suspicious_empty, true, command);
  for (const command of ['mvn package -DskipTests', 'mvnw test -Dmaven.test.skip=true', 'gradlew build -x test']) {
    const result = inspectVerificationOutput(command, 0, 'BUILD SUCCESS');
    assert.equal(result.suspicious_empty, true); assert.equal(result.skipped_flag, true);
  }
  assert.ok(!inspectVerificationOutput('mvn test -DskipTests=false', 0, '').skipped_flag);
  assert.ok(!inspectVerificationOutput('go test ./...', 0, '? module/foo [no test files]\nok module/bar 0.002s').suspicious_empty);
  const partialCache = inspectVerificationOutput('go test -v ./...', 0, '--- PASS: TestCached (0.00s)\nok  demo/old (cached)\n--- PASS: TestFresh (0.00s)\nok  demo/new 0.024s');
  assert.equal(partialCache.passed, 1);
});

const state: CodeState = {snapshot_id:'s', fingerprint:'source', workspace_fingerprint:'workspace', head:null, branch:null, git_common_dir:null, dirty:[], captured_at:'now'};
const task: EngineeringTask = {
  task_id:'t', project_id:'p', workspace_id:'w', workspace_path:'/project', version:3, submission_key:'test', goal:'Update views', scope:[],
  baseline:state, end_state:state, status:'completed', context_version:1, summary:'', decisions:[], unresolved:[], changes:[],
  verification:[], verification_status:'not_run', attempt_ids:[], created_at:'now', updated_at:'now', saved:'saved',
};
const evidence: VerificationEvidence = {evidence_id:'e', command:'npm test', cwd:'/project', outcome:'passed', exit_code:0, origin:'observed',
  code_state:state, created_at:'now', log_path:'development/t/command.log'};

test('audits approved files and effective redlines and matches current materials by exact source path', () => {
  const step = {step_id:'s', title:'Keep view', change:'', status:'completed' as const, progress:'', criteria:[], evidence_ids:[], unresolved:[], created_at:'', updated_at:''};
  const changes = [{path:'ui/view.ts', ownership:'preexisting_overlap' as const, before_sha256:'a', after_sha256:'b'},
    {path:'legacy/export.ts', ownership:'task_change' as const, before_sha256:null, after_sha256:'c'}];
  const entry = {entry_id:'doc', key:'view design', category:'design' as const, sources:[{path:'ui/view.ts'}]};
  const audit = auditDelivery({...task, approval:{reviewed_version:2, scope:['ui/view.ts']}, proposed_scope:changes.map(c=>c.path), changes,
    requirement_package:{behaviors:[], revoked:['removed term']}, boundaries:{non_goals:[], revoked:['`legacy/export`；','legacy/export','old plan','sync','rollout','removed term 2']},
    summary:'SYNC done', steps:[{...step, change:'rollout'}, {...step, step_id:'old', title:'old plan', status:'superseded'}]},
    [entry, {...entry, entry_id:'obsolete', status:'superseded'}, {...entry, entry_id:'other', sources:[{path:'ui/view.tsx'}]}]);
  assert.deepEqual(audit.scope, {status:'warning', out_of_scope:['legacy/export.ts'], overlap:['ui/view.ts']});
  assert.deepEqual(audit.redlines.hits, ['`legacy/export`；','sync','rollout']);
  assert.deepEqual(audit.impacted_materials, [{entry_id:'doc', key:'view design', category:'design'}]);
});

test('uses latest observed evidence on matching code and preserves self-reported, empty, failed and stale statuses', () => {
  const verified = {...task, verification_status:'passed' as const, verification:[
    {...evidence, evidence_id:'old', code_state:{...state, workspace_fingerprint:'other'}, outcome:'failed' as const},
    {...evidence, metrics:{total:3,passed:3}}, {...evidence, evidence_id:'retry', metrics:{total:4,passed:4}},
  ]};
  assert.equal(auditDelivery(verified, []).verification.label, '通过 4 项');
  assert.equal(auditDelivery({...verified, verification_status:'stale'}, []).verification.status, 'stale');
  assert.equal(auditDelivery({...verified, verification:[{...evidence, origin:'self_reported', metrics:{passed:100}}]}, []).verification.status, 'self_reported');
  assert.equal(auditDelivery({...verified, verification:[evidence]}, [], {e:'# tests 0\n# pass 0'}).verification.status, 'suspicious_empty');
  assert.equal(auditDelivery({...verified, verification:[{...evidence, command:'mvn test -DskipTests'}]}, []).verification.status, 'suspicious_empty');
  assert.equal(auditDelivery({...verified, verification:[{...evidence, metrics:{failed:1}}]}, []).verification.status, 'failed');
  assert.equal(auditDelivery({...verified, verification:[{...evidence, code_state_verified:false}]}, []).verification.status, 'partial');
});
