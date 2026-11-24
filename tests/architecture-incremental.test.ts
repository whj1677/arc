import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Explanation, Project, ReadingGuide, Snapshot, SourceEvidence } from '../src/shared';
import {
  applyRelationDelete, architectureDocId, buildRelationExclusionSignature,
  type ArchitectureDocument, type ArchitectureModule, type ArchitectureRelation,
} from '../src/architecture-workspace';
import { detectArchitectureChanges } from '../src/main/architecture-change-detector';
import { architectureIpc } from '../src/main/architecture-ipc';
import { ArcService } from '../src/main/service';
import {
  ArchitectureWorkspaceService, collectInScopeFileHashes, computeEvidenceFingerprint,
} from '../src/main/architecture-workspace-service';
import type { IncrementalSemanticAnalyzer, SemanticProposal } from '../src/main/architecture-semantic';
import { getCodeIndex } from '../src/main/code-index';
import { capture, readSource, sha } from '../src/main/snapshot';
import { now, Store } from '../src/main/store';

const projectId = 'controls';
const sources: Record<string, string> = {
  'sensor/read.c': 'int read_sensor(int value) {\n  return value + 1;\n}\n',
  'persist/save.c': 'int save_value(int value) {\n  return value * 2;\n}\n',
  'api/sample.h': 'struct Sample { int voltage; };\n',
  'app/display.c': '#include "../api/sample.h"\nextern int read_sensor(int);\nint show(struct Sample sample) { return read_sensor(sample.voltage); }\n',
  'timers/tick.c': 'int tick(void) { return 7; }\n',
  'legacy/normalize.c': 'int normalize(int value) { return value; }\n',
};
const owned: Record<string, string> = {
  sensor: 'sensor/read.c', persist: 'persist/save.c', api: 'api/sample.h', display: 'app/display.c', timer: 'timers/tick.c',
};
const at = '2025-01-01T00:00:00.000Z';
type Input = Parameters<IncrementalSemanticAnalyzer['analyze']>[0];

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['--no-optional-locks', '-C', root, '-c', 'user.name=ARC',
    '-c', 'user.email=arc@example.invalid', '-c', 'core.autocrlf=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

async function write(root: string, file: string, contents: string) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, contents);
}

function cite(snapshot: Snapshot, file: string, start = 1, end = start): SourceEvidence {
  const entry = snapshot.files.find(f => f.path === file);
  assert.ok(entry, 'citation exists in frozen source: ' + file);
  return { evidence_id: 'ev-' + file.replaceAll('/', '-'), source_snapshot_id: snapshot.source_snapshot_id, path: file,
    content_sha256: entry.content_sha256, line_start: start, line_end: end, role: 'definition', note: file };
}

function proposedUpdate(input: Input, summary: string): SemanticProposal {
  return { category: 'module_update', target_kind: 'module', target_id: input.unit.id, title: summary,
    proposed: {summary}, evidence: [cite(input.snapshot, owned[input.unit.id])] };
}

async function fixture(t: TestContext, extraSources: Record<string,string> = {}) {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, {recursive: true});
  const dir = await fs.mkdtemp(path.join(base, 'incremental-'));
  const root = path.join(dir, '目标 工程');
  const store = new Store(path.join(dir, 'arc-data'));
  t.after(async () => { store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  for (const [file, contents] of Object.entries({...sources, ...extraSources})) await write(root, file, contents);
  git(root, 'init', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial source');
  const snapshot = await capture(root, projectId, store.directory, '');
  const project: Project = {project_id: projectId, name: 'Controls', root_path: root,
    snapshot_id: snapshot.source_snapshot_id, fictional: false, build_config: '', created_at: at};
  store.put('snapshot', snapshot.source_snapshot_id, snapshot);
  store.put('project', projectId, project);
  const index = await getCodeIndex(store.directory, snapshot);
  assert.deepEqual(index.parse_errors, []);
  const modules = Object.entries(owned).map(([id, file]): ArchitectureModule => {
    const symbol = index.symbols.find(s => s.file === file);
    const ev = {...cite(snapshot, file, symbol?.start_line ?? 1, symbol?.end_line ?? 1), symbol_id: symbol?.id};
    return {id, name: id, kind: 'stage', layer: 'core', summary: 'Original ' + id, notes: 'Owner note for ' + id,
      code_links: [{id: 'binding-' + id, kind: symbol ? 'symbol' : 'file', path: file, origin: 'code_analysis',
        symbol_name: symbol?.name, symbol_id: symbol?.id, start_line: ev.line_start, end_line: ev.line_end, file_sha256: ev.content_sha256}],
      evidence: [ev], origin: 'code_analysis', implementation_status: 'implemented', updated_at: at};
  });
  const relation: ArchitectureRelation = {id: 'sample-read', from: 'sensor', to: 'persist', kind: 'sync_call',
    label: 'Capture measurement', origin: 'code_analysis', status: 'inferred', updated_at: at,
    evidence: [cite(snapshot, owned.sensor)]};
  const calls: Input['unit'][] = [];
  const analyzer: IncrementalSemanticAnalyzer = {analyze: async () => []};
  const service = new ArchitectureWorkspaceService(store, () => {}, {
    analyze(input) { calls.push(input.unit); return analyzer.analyze(input); },
  });
  const doc: ArchitectureDocument = {id: architectureDocId(projectId, 'main'), project_id: projectId, branch_key: 'main',
    version: 0, title: 'Controls', summary: 'Control flow', modules, relations: [relation],
    exclusions: [], review_items: [], update_status: 'up_to_date', updated_at: at, created_at: at,
    layout: {positions: {sensor: {x: 135, y: 79}, persist: {x: 326, y: 190}}, manual_positions: ['sensor', 'persist']},
    baseline: {snapshot_id: snapshot.source_snapshot_id, fingerprint: snapshot.fingerprint,
      ...await collectInScopeFileHashes(root, snapshot), branch: 'main', commit: snapshot.commit!, dirty: false, captured_at: snapshot.captured_at},
  };
  return {store, root, service, analyzer, calls, snapshot, doc: service.saveArchitectureDocument(projectId, doc, 0)};
}

function guide(text: string, ev: SourceEvidence): ReadingGuide {
  return { steps: [{id:'step', title:'Read sensor', actor:'Sensor', text, outcome:'value', detail:text,
    node_ids:['read-node'], evidence_ids:[ev.evidence_id]}],
    roles:[{id:'sensor-role',title:'Sensor',duty:'Read sample',files:[ev.path],evidence_ids:[ev.evidence_id]}],
    files:[{path:ev.path,title:'Read sensor',description:'Read sample',detail:'',step_ids:['step'],evidence_ids:[ev.evidence_id]}],
    paths:[{id:'sample-path', label:'Sample path',entry:'read',intro:'Read a sample',boundary:'',
      step_ids:['step'],lanes:[],failure_ids:[],role_ids:['sensor-role'],handoff_ids:[],files:[ev.path]}], handoffs:[] };
}

function saveWalkthrough(store: Store, snapshot: Snapshot, featureId: string, file: string, scenarioName = featureId) {
  const ev = cite(snapshot, file);
  const scenario = 'walk-' + scenarioName, resultId = 'explanation-' + scenarioName;
  store.put('feature', featureId, {feature_id:featureId, project_id:projectId, name:featureId, archived:false, sort_order:1});
  store.put('scenario', scenario, {scenario_id:scenario, feature_id:featureId, project_id:projectId, title:featureId,
    question:'Describe flow', question_revision_id:'rev', archived:false, sort_order:1});
  const explanation: Explanation = {result_id:resultId, scenario_id:scenario, created_at:at, source_status:'current',
    result:{schema_version:'1.0', fictional:false, result_id:resultId,
      binding:{project_id:projectId, feature_id:featureId, scenario_id:scenario, question_revision_id:'rev',run_id:'walk', source_snapshot_id:snapshot.source_snapshot_id},
      provider:{provider_id:'codex', connection_id:'fixture', adapter_version:'1'}, summary:{text:'Read',claim_ids:[]},
      nodes:[{node_id:'read-node', kind:'function', label:'Read', description:'Read value', source_scope:{kind:'file',path:file},
        execution_context:{kind:'unknown', identity:null, label:'Unknown', status:'unknown', claim_ids:[],evidence_ids:[]},
        inputs:[], outputs:[], claim_ids:[], evidence_ids:[ev.evidence_id]}],
      coverage:{covered_scope:[file], unresolved_scope:[]}, edges:[], claims:[], gaps:[], evidence:[ev], reading_guide:guide('Old transform', ev)}};
  store.put('explanation', resultId, explanation);
  return explanation;
}

test('A06 and A08: clean state, comment offsets and exact moves retain identity and never call the analyzer', async t => {
  const {root, service, doc, calls, store} = await fixture(t);
  const clean = await service.updateAffectedArchitecture(projectId);
  assert.equal(clean.update_run.model_calls, 0);
  assert.equal(clean.update_run.impact_summary.mode, 'none');
  assert.equal(clean.update_run.overall_status, 'up_to_date');
  assert.deepEqual(clean.document.layout, doc.layout);
  assert.deepEqual(store.getArchitectureDoc(projectId, 'main')!.last_update, clean.update_run);
  await write(root, owned.sensor, '// Calibration note\n\n' + sources[owned.sensor]);
  const shift = await service.updateAffectedArchitecture(projectId);
  assert.equal(shift.update_run.impact_summary.mode, 'reference_only');
  assert.equal(shift.update_run.model_calls, 0);
  assert.ok(shift.update_run.auto_updates.some(update => update.target_id === 'sensor'));
  const shifted = shift.document.modules.find(m => m.id === 'sensor')!;
  assert.equal(shifted.code_links[0].start_line, 3);
  assert.equal(shifted.code_links[0].end_line, 5);
  assert.equal(shifted.evidence[0].line_start, 3);
  assert.equal(shifted.evidence[0].content_sha256, shift.update_run.read_baseline.file_hashes[owned.sensor]);

  const newPath = 'device/read.c';
  await fs.mkdir(path.join(root, 'device'));
  git(root, 'mv', owned.sensor, newPath);
  const move = await service.updateAffectedArchitecture(projectId);
  assert.equal(move.update_run.model_calls, 0);
  assert.equal(move.update_run.impact_summary.mode, 'reference_only');
  assert.deepEqual(move.update_run.impact_summary.affected_module_ids, []);
  const moved = move.document.modules.find(m => m.id === 'sensor')!;
  assert.equal(moved.code_links[0].path, newPath);
  assert.equal(moved.evidence[0].path, newPath);
  assert.equal(moved.notes, doc.modules[0].notes);
  assert.deepEqual(move.document.layout, doc.layout);
  assert.deepEqual(move.document.relations.map(r => r.id), ['sample-read']);
  assert.equal(move.document.relations[0].evidence[0].path, newPath);
  assert.ok(move.document.baseline!.file_hashes[newPath]);
  assert.ok(!move.document.baseline!.file_hashes[owned.sensor]);
  assert.equal(calls.length, 0);
});

test('A07: staged, unstaged and untracked changes are found at the same HEAD and unknown ownership is analyzed', async t => {
  const {root, service, calls, doc, store} = await fixture(t);
  await write(root, owned.sensor, sources[owned.sensor].replace('+ 1','+ 3'));
  git(root, 'add', owned.sensor);
  await write(root, owned.persist, sources[owned.persist].replace('* 2','* 4'));
  await write(root, 'new/owner.ts', 'export const interval = 3;');
  for (const file of ['runtime.log','cache/debug.js','.test-data/irrelevant.ts','dist/out.js','node_modules/lib/index.js']) {
    await write(root, file, 'ignored');
  }
  const treeState = async () => {
    const files = (await fs.readdir(root, {recursive:true,withFileTypes:true})).filter(entry => entry.isFile());
    return Object.fromEntries(await Promise.all(files.map(async entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), [sha(await fs.readFile(file)), (await fs.stat(file)).mtimeMs]];
    })));
  };
  const beforeCheck = await treeState();
  const checked = await service.checkArchitectureUpdates(projectId);
  const summary = checked.document.pending_changes_summary!;
  assert.equal(summary.git_commit, doc.baseline!.commit);
  assert.equal(summary.detection_reliable, true);
  assert.deepEqual(Object.fromEntries(summary.changed_files.map(f => [f.path, f.source])), {
    [owned.sensor]:'staged', [owned.persist]:'unstaged', 'new/owner.ts':'untracked',
  });
  assert.deepEqual(summary.impact_preview!.unmapped_files, ['new/owner.ts']);
  assert.equal(checked.document.update_status, 'changes_pending');
  assert.ok(summary.checked_at);
  assert.equal(checked.document.version, doc.version);
  assert.equal(checked.document.updated_at, doc.updated_at);
  assert.throws(() => store.patchArchitectureCheckState(doc.id, doc.version - 1, undefined, 'up_to_date'),
    /Architecture document version conflict/);
  assert.deepEqual(store.getArchitectureDocById(doc.id), checked.document);
  assert.deepEqual(store.versions('architecture_doc', doc.id), [doc]);
  assert.equal(calls.length, 0);
  const statusBefore = git(root, 'status', '--porcelain', '-uall');
  const run = await service.updateAffectedArchitecture(projectId);
  assert.ok(calls.some(u => u.kind === 'unmapped' && u.paths.includes('new/owner.ts')));
  assert.equal(run.update_run.model_calls, calls.length);
  assert.deepEqual(run.document.modules.map(m => m.id), doc.modules.map(m => m.id));
  assert.equal(git(root, 'status', '--porcelain', '-uall'), statusBefore);
  assert.deepEqual(await treeState(), beforeCheck, 'worktree and .git (including index bytes and mtimes) must remain intact');
  git(root, 'add', owned.persist);
  git(root, 'commit', '-m', 'sensor changes');
  const committed = await detectArchitectureChanges(root, doc);
  assert.ok(committed.detection_summary.changed_files.some(f => f.path === owned.sensor && f.source === 'committed'));
});

test('A08: an edited rename remains a review decision until accepted', async t => {
  const {root, doc, service} = await fixture(t);
  const dest = 'new-sensor/read.c';
  await fs.mkdir(path.join(root, 'new-sensor'));
  git(root, 'mv', owned.sensor, dest);
  await write(root, dest, sources[owned.sensor].replace('+ 1', '+ 9'));
  const result = await service.updateAffectedArchitecture(projectId);
  const item = result.document.review_items.find(i => i.category === 'rename_uncertain');
  assert.ok(item);
  assert.equal(result.document.modules[0].code_links[0].path, owned.sensor);
  assert.equal(result.update_run.overall_status, 'needs_review');
  const accepted = await service.resolveArchitectureReview(projectId, {reviewId:item.id, decision:'accept'});
  const mod = accepted.document.modules.find(m => m.id === 'sensor')!;
  assert.equal(mod.code_links[0].path, dest);
  assert.equal(mod.evidence[0].path, dest);
  assert.equal(mod.notes, doc.modules[0].notes);
  assert.deepEqual(accepted.document.layout, doc.layout);
});

test('A09: private transform change updates only the saved walkthrough selected for review', async t => {
  const {store, snapshot, root, analyzer, service, calls, doc} = await fixture(t);
  const walk = saveWalkthrough(store, snapshot, 'sample', owned.sensor);
  const unrelated = saveWalkthrough(store, snapshot, 'schedule', owned.timer);
  const otherScenario = saveWalkthrough(store, snapshot, 'sample', owned.persist, 'sample-storage');
  await write(root, owned.sensor, sources[owned.sensor].replace('value + 1', 'value < 0 ? 0 : value + 1'));
  analyzer.analyze = async ({unit, snapshot:s1}) => {
    if (unit.kind !== 'feature') return [];
    assert.equal(unit.explanation!.result_id, walk.result_id);
    const ev = cite(s1, owned.sensor, 2);
    return [{category:'dataflow_change', target_kind:'feature', target_id:unit.id, title:'Clamp negative samples',
      proposed:{explanation_id:walk.result_id,reading_guide:guide('Clamp negative samples', ev)}, evidence:[ev]}];
  };
  const result = await service.updateAffectedArchitecture(projectId);
  assert.ok(['local_module','dataflow_only'].includes(result.update_run.impact_summary.mode));
  assert.deepEqual(result.update_run.impact_summary.affected_module_ids, ['sensor','persist']);
  assert.deepEqual(result.update_run.impact_summary.affected_feature_ids, ['sample']);
  assert.deepEqual(calls.filter(u => u.kind === 'feature').map(u => u.id), ['sample']);
  assert.deepEqual(result.document.modules.map(m => m.summary), doc.modules.map(m => m.summary));
  const review = result.document.review_items.find(i => i.category === 'dataflow_change');
  assert.ok(review);
  assert.ok(JSON.stringify(review.before).includes('Old transform'));
  assert.deepEqual(store.get('explanation', walk.result_id), walk);
  const revised = structuredClone(walk);
  revised.result.reading_guide!.steps[0].text = 'Owner revised this step';
  store.put('explanation',walk.result_id,revised);
  await assert.rejects(service.resolveArchitectureReview(projectId,{reviewId:review.id,decision:'accept'}),/走读已变化/);
  assert.deepEqual(store.getArchitectureDoc(projectId,'main'),result.document);
  assert.deepEqual(store.get('explanation',walk.result_id),revised);
  store.put('explanation',walk.result_id,walk);
  await service.resolveArchitectureReview(projectId, {reviewId:review.id, decision:'accept'});
  const updated = store.all<Explanation>('explanation').find(e => e.result.reading_guide?.steps[0]?.text === 'Clamp negative samples')!;
  assert.ok(updated);
  assert.equal(updated.result.binding.feature_id, 'sample');
  assert.equal(updated.scenario_id, walk.scenario_id);
  assert.ok(updated.result.evidence.some(ev => ev.source_snapshot_id === result.update_run.read_baseline.snapshot_id && ev.path === owned.sensor));
  const project = store.get<Project>('project',projectId);
  const latestWalk = (branch: string) => store.latestFeatureExplanations(project,branch).find(e => e.scenario_id === walk.scenario_id);
  assert.equal(latestWalk('main')?.result_id, updated.result_id);
  assert.deepEqual(latestWalk('other-branch'), walk);
  assert.deepEqual(store.get('explanation', walk.result_id), walk);
  assert.deepEqual(store.get('explanation', unrelated.result_id), unrelated);
  assert.deepEqual(store.get('explanation', otherScenario.result_id), otherScenario);
});

test('A08 to A09: a walkthrough follows successive exact moves before reanalyzing changed logic', async t => {
  const {store,snapshot,root,analyzer,service,calls} = await fixture(t);
  const walk = saveWalkthrough(store,snapshot,'sample',owned.sensor);
  let current = owned.sensor;
  for (const moved of ['sensor/moved.c','sensor/relocated.c']) {
    await fs.rename(path.join(root,current),path.join(root,moved));
    const result = await service.updateAffectedArchitecture(projectId);
    assert.equal(result.update_run.impact_summary.mode,'reference_only');
    assert.equal(result.update_run.model_calls,0);
    current = moved;
  }
  await write(root,current,sources[owned.sensor].replace('+ 1','+ 3'));
  analyzer.analyze = async ({unit,snapshot:s1}) => {
    if (unit.kind!=='feature') return [];
    assert.deepEqual(unit.paths,[current]);
    assert.deepEqual(unit.explanation,walk);
    const ev = {...cite(s1,current,2),evidence_id:walk.result.evidence[0].evidence_id};
    return [{category:'dataflow_change',target_kind:'feature',target_id:unit.id,title:'Change calibration',
      proposed:{explanation_id:walk.result_id,reading_guide:guide('Apply new calibration',ev)},evidence:[ev]}];
  };
  const changed = await service.updateAffectedArchitecture(projectId);
  assert.deepEqual(changed.update_run.impact_summary.affected_feature_ids,['sample']);
  assert.equal(calls.filter(unit=>unit.kind==='feature').length,1);
  const review=changed.document.review_items.find(item=>item.category==='dataflow_change');
  assert.ok(review);
  assert.equal(review.evidence[0].path,current);
  assert.deepEqual(store.get('explanation',walk.result_id),walk);
});

test('A10: a changed header reaches its static include consumer without an architecture relation', async t => {
  const {root, service, calls, store, snapshot} = await fixture(t);
  saveWalkthrough(store,snapshot,'show-sample',owned.display);
  await write(root, owned.api, sources[owned.api].replace('int voltage', 'long voltage'));
  const result = await service.checkArchitectureUpdates(projectId);
  const preview = result.document.pending_changes_summary!.impact_preview!;
  assert.equal(preview.mode, 'cross_module');
  assert.deepEqual(new Set(preview.affected_module_ids), new Set(['api','display']));
  assert.deepEqual(new Set(preview.reused_module_ids), new Set(['sensor','persist','timer']));
  assert.equal(calls.length, 0);
  await service.updateAffectedArchitecture(projectId);
  for (const id of ['display','show-sample']) {
    const consumer = calls.find(unit => unit.id === id)!;
    assert.deepEqual(new Set(consumer.paths),new Set([owned.display,owned.api]));
  }
});

test('deleting the only evidence for a confirmed relation checks both endpoints and leaves a review', async t => {
  const {root,service,doc,snapshot,calls} = await fixture(t);
  const file = 'legacy/normalize.c', rel = doc.relations[0];
  rel.status = 'confirmed';
  rel.evidence = [cite(snapshot,file)];
  service.saveArchitectureDocument(projectId,doc,doc.version);
  await fs.unlink(path.join(root,file));
  const result = await service.updateAffectedArchitecture(projectId);
  assert.deepEqual(result.update_run.impact_summary.affected_module_ids.sort(),[rel.to,rel.from].sort());
  assert.ok(calls.some(unit => unit.id === rel.from));
  assert.ok(calls.some(unit => unit.id === rel.to));
  assert.equal(result.document.update_status,'needs_review');
  assert.ok(result.document.review_items.some(item => item.target_id === rel.id && item.title.includes(file)));
});

test('unindexed contract consumers receive the changed protocol in every affected frozen read', async t => {
  const file = 'api/sample.proto';
  const {root,service,doc,calls,store,snapshot} = await fixture(t,{[file]:'message Sample { int32 x = 1; }'});
  doc.modules.find(m => m.id === 'api')!.code_links.push({id:'proto',origin:'manual',kind:'file',path:file});
  service.saveArchitectureDocument(projectId,doc,doc.version);
  saveWalkthrough(store,snapshot,'generated-consumer',owned.display);
  await write(root,file,'message Sample { int64 x = 1; }');
  const {update_run} = await service.updateAffectedArchitecture(projectId);
  assert.equal(update_run.impact_summary.mode,'wide_recheck');
  assert.match(update_run.impact_summary.reason,/契约/);
  assert.deepEqual(new Set(calls.map(unit => unit.id)),new Set([...doc.modules.map(m => m.id),'generated-consumer']));
  assert.ok(calls.every(unit => unit.paths.includes(file)));
});

test('bound nonstandard text files and new directory members participate in frozen and live manifests', async t => {
  const link = 'api/linked.idl', evidence = 'display/display.idl', relation = 'api/edge.idl';
  const {root,service,doc,snapshot,store} = await fixture(t,{[link]:'link',[evidence]:'display',[relation]:'edge'});
  doc.modules[0].code_links.push({id:'idl',kind:'file',path:link,origin:'manual'},
    {id:'owned-dir',kind:'directory',path:'extra',origin:'manual'});
  doc.modules[1].evidence.push(cite(snapshot,evidence));
  doc.relations[0].evidence = [cite(snapshot,relation)];
  const scoped = service.saveArchitectureDocument(projectId,doc,doc.version);
  for (const file of [link,evidence,relation]) assert.equal(scoped.baseline!.file_hashes[file],cite(snapshot,file).content_sha256);
  // Simulate a pre-fix document whose persisted, extension-only manifest missed the bound files.
  store.saveArchitectureDoc({...scoped,baseline:doc.baseline},scoped.version);
  await write(root,link,'changed link');
  await write(root,evidence,'changed evidence');
  await fs.unlink(path.join(root,relation));
  const added = 'extra/new.ipp';
  await write(root,added,'template <class T> struct Value {};');
  for (const file of ['extra/cache/ignore.ipp','extra/.test-data/ignore.ipp','extra/node_modules/p/file.ipp',
      'extra/dist/file.ipp','extra/trace.log','extra/binary.ipp']) {
    await write(root,file,file.endsWith('binary.ipp') ? 'a\0b' : 'excluded');
  }
  const {detection} = await service.checkArchitectureUpdates(projectId);
  assert.deepEqual(Object.fromEntries(detection.detection_summary.changed_files.map(f => [f.path,f.status])),
    {[added]:'added',[link]:'modified',[evidence]:'modified',[relation]:'deleted'});
  const update = await service.updateAffectedArchitecture(projectId);
  assert.equal(update.update_run.post_check_consistent,true);
  assert.equal(update.update_run.read_baseline.file_hashes[added],detection.live_hashes[added]);
});

test('newly assigned owner during an S1 run is completed on the next run before advancing the baseline', async t => {
  const {root,service,store,doc,analyzer,calls} = await fixture(t);
  await write(root,owned.sensor,sources[owned.sensor].replace('+ 1','+ 3'));
  analyzer.analyze = async ({unit}) => {
    if (unit.id === 'sensor') {
      const latest = store.getArchitectureDoc(projectId,'main')!;
      latest.modules.find(m => m.id === 'timer')!.code_links.push({id:'new-owner',kind:'file',path:owned.sensor,origin:'manual'});
      service.saveArchitectureDocument(projectId,latest,latest.version);
    }
    return [];
  };
  const first = await service.updateAffectedArchitecture(projectId);
  assert.equal(first.document.baseline!.snapshot_id,doc.baseline!.snapshot_id);
  assert.equal(first.document.update_status,'changes_pending');
  assert.deepEqual(first.update_run.remaining_units,[JSON.stringify(['module','timer'])]);
  assert.equal(first.update_run.module_outcomes.timer,undefined);
  assert.ok(!first.update_run.impact_summary.reused_module_ids.includes('timer'));
  calls.length = 0;
  const second = await service.updateAffectedArchitecture(projectId);
  assert.deepEqual(calls.map(u => u.id),['timer']);
  assert.deepEqual(second.update_run.remaining_units,[]);
  assert.equal(second.document.baseline!.snapshot_id,first.update_run.read_baseline.snapshot_id);
});

test('a new owner of an exact move is analyzed on the next update even when the move only relocated references', async t => {
  const {root,service,doc,store,calls} = await fixture(t);
  const dest = 'sensor/relocated.c';
  git(root,'mv',owned.sensor,dest);
  const read = fs.readFile;
  let saved = false;
  t.mock.method(fs,'readFile',async (...args: Parameters<typeof read>) => {
    if (!saved && args[0] === path.join(root,dest)) {
      saved = true;
      const latest = store.getArchitectureDoc(projectId,'main')!;
      latest.modules.find(m => m.id === 'timer')!.code_links.push({id:'extra-owner',kind:'file',path:dest,origin:'manual'});
      service.saveArchitectureDocument(projectId,latest,latest.version);
    }
    return read(...args);
  });
  const first = await service.updateAffectedArchitecture(projectId);
  assert.equal(first.update_run.impact_summary.mode,'reference_only');
  assert.deepEqual(first.update_run.remaining_units,[JSON.stringify(['module','timer'])]);
  assert.equal(first.document.baseline!.snapshot_id,doc.baseline!.snapshot_id);
  assert.equal(calls.length,0);
  const next = await service.updateAffectedArchitecture(projectId);
  assert.deepEqual(calls.map(unit => unit.id),['timer']);
  assert.ok(calls[0].paths.includes(dest));
  assert.equal(next.update_run.module_outcomes.timer.status,'succeeded');
  assert.equal(next.document.baseline!.snapshot_id,first.update_run.read_baseline.snapshot_id);
});

for (const change of ['content','membership']) test('dirty live scan rejects mid-scan ' + change + ' changes', async t => {
  const {root,doc} = await fixture(t);
  const target = path.join(root,owned.sensor);
  await fs.appendFile(target,'// already dirty\n');
  const read = fs.readFile;
  let changed = false;
  t.mock.method(fs,'readFile',async (...args: Parameters<typeof read>) => {
    const result = await read(...args);
    if (!changed && args[0] === target) {
      changed = true;
      if (change === 'content') await fs.appendFile(target,'// modified during scan\n');
      else await write(root,'new.c','int added;');
    }
    return result;
  });
  const {detection_summary} = await detectArchitectureChanges(root,doc);
  assert.ok(changed);
  assert.equal(detection_summary.detection_reliable,false);
  assert.equal(detection_summary.detection_error,'扫描期间工作区文件发生变化，请重新检查');
});

test('a directory disappearing during enumeration reports the same unstable-scan error', async t => {
  const {root,doc} = await fixture(t);
  await fs.appendFile(path.join(root,owned.sensor),'// already dirty\n');
  const directory = path.join(root,'timers'), read = fs.readdir;
  let moved = false;
  t.mock.method(fs,'readdir',async (...args: Parameters<typeof read>) => {
    if (!moved && args[0] === directory) {
      await fs.rename(directory,path.join(path.dirname(root),'removed-timers'));
      moved = true;
    }
    return read(...args);
  });
  const {detection_summary} = await detectArchitectureChanges(root,doc);
  assert.ok(moved);
  assert.equal(detection_summary.detection_reliable,false);
  assert.equal(detection_summary.detection_error,'扫描期间工作区文件发生变化，请重新检查');
});

test('A10: a committed public signature change reaches its static caller while an unrelated line shift only relocates evidence', async t => {
  const {root,service,calls} = await fixture(t);
  await write(root, owned.sensor, sources[owned.sensor].replace('int read_sensor', 'long read_sensor'));
  await write(root, owned.timer, '\n\n' + sources[owned.timer]);
  git(root, 'add', owned.sensor, owned.timer);
  git(root, 'commit', '-m', 'Widen public sensor reading');
  const run = await service.updateAffectedArchitecture(projectId);
  assert.ok(run.update_run.detection_summary.changed_files.every(f => f.source === 'committed'));
  assert.equal(run.update_run.impact_summary.mode, 'cross_module');
  assert.deepEqual(new Set(run.update_run.impact_summary.affected_module_ids), new Set(['sensor','persist','display']));
  assert.deepEqual(new Set(run.update_run.impact_summary.reused_module_ids), new Set(['api','timer']));
  assert.equal(run.document.modules.find(m => m.id === 'timer')!.evidence[0].line_start, 3);
  assert.ok(run.update_run.auto_updates.some(a => a.target_id === 'timer'));
  assert.deepEqual(new Set(calls.map(u => u.id)), new Set(['sensor','persist','display']));
});

test('A11: deleted relation stays excluded with identical evidence and a new callsite requires explicit review', async t => {
  const {root, doc, service, analyzer} = await fixture(t);
  const sensor = doc.modules.find(m => m.id === 'sensor')!;
  sensor.code_links.push({id:'sensor-directory', kind:'directory', path:'sensor', origin:'code_analysis'});
  const original = doc.relations[0];
  const removed = service.saveArchitectureDocument(projectId, applyRelationDelete(doc, original.id, computeEvidenceFingerprint), doc.version);
  const signature = buildRelationExclusionSignature(original.from, original.to, original.kind);
  assert.equal(removed.exclusions[0].evidence_fingerprint, computeEvidenceFingerprint(original.evidence, signature));
  let evidenceLine = 1;
  analyzer.analyze = async ({unit,snapshot}) => unit.id === sensor.id ? [{
    category:'relation_add',target_kind:'relation',target_id:original.id,title:original.label,
    proposed:{from:original.from,to:original.to,kind:original.kind,label:original.label},
    evidence:[cite(snapshot, owned.sensor, evidenceLine)],
  }] : [];
  // The unit changes while the originally rejected anchor retains its bytes.
  await write(root, 'sensor/filter.c', 'int filter(int v) { return v < 0 ? 0 : v; }\n');
  const suppressed = await service.updateAffectedArchitecture(projectId);
  assert.ok(suppressed.update_run.model_calls > 0);
  assert.deepEqual(suppressed.document.review_items, []);
  assert.deepEqual(suppressed.document.relations, []);
  const repeated = await service.updateAffectedArchitecture(projectId);
  assert.equal(repeated.update_run.model_calls, 0);
  assert.deepEqual(repeated.document.relations, []);
  await write(root, owned.sensor, 'extern int save_value(int);\nint read_sensor(int value) {\n  return save_value(value);\n}\n');
  evidenceLine = 3;
  const changed = await service.updateAffectedArchitecture(projectId);
  const conflict = changed.document.review_items.find(i => i.category === 'exclusion_conflict');
  assert.ok(conflict);
  assert.deepEqual(conflict.before, removed.exclusions[0]);
  assert.notEqual(conflict.evidence_fingerprint, removed.exclusions[0].evidence_fingerprint);
  assert.deepEqual(changed.document.relations, []);
  const accept = await service.resolveArchitectureReview(projectId, {reviewId:conflict.id,decision:'accept'});
  assert.deepEqual(accept.document.relations.map(r => [r.from,r.to,r.kind]), [[original.from,original.to,original.kind]]);
  assert.deepEqual(accept.document.exclusions, []);
  // The user corrected the evidence on the accepted relation, then deleted it.
  // Rediscovering the earlier callsite must produce a fresh conflict against that deletion.
  const acceptedRelation = accept.document.relations[0];
  acceptedRelation.origin = 'manual_override';
  acceptedRelation.evidence = original.evidence;
  const corrected = service.saveArchitectureDocument(projectId, accept.document, accept.document.version);
  service.saveArchitectureDocument(projectId, applyRelationDelete(corrected,acceptedRelation.id),corrected.version);
  await write(root, 'sensor/filter.c', 'int filter(int v) { return v < 1 ? 1 : v; }\n');
  const rediscovered = await service.updateAffectedArchitecture(projectId);
  const pending = rediscovered.document.review_items.find(item => item.category === 'exclusion_conflict' && item.status === 'pending');
  assert.ok(pending);
  assert.notEqual(pending.id,conflict.id);
  assert.equal(pending.dedupe_key,conflict.dedupe_key);
  assert.equal(rediscovered.document.review_items.find(item => item.id === conflict.id)?.status,'accepted');
});

test('A12: a different checkout cannot consume reviews from main and returning restores the saved main document', async t => {
  const {root,service,doc,analyzer} = await fixture(t);
  const updated = structuredClone(doc);
  updated.modules[0].notes = 'Branch A owner decision';
  service.saveArchitectureDocument(projectId, updated, doc.version);
  await write(root, owned.sensor, sources[owned.sensor].replace('+ 1','+ 2'));
  git(root, 'add', owned.sensor);
  git(root, 'commit', '-m', 'branch A change');
  analyzer.analyze = async input => [proposedUpdate(input, 'Sample now increased by two')];
  const main = await service.updateAffectedArchitecture(projectId);
  const item = main.document.review_items[0];
  assert.ok(item);
  git(root, 'switch', '-c', 'branch-b');
  const b = await service.updateAffectedArchitecture(projectId, {moduleIds:[]});
  assert.equal(b.document.branch_key, 'branch-b');
  assert.ok(!b.document.review_items.some(i => i.id === item.id));
  await assert.rejects(service.resolveArchitectureReview(projectId, {reviewId:item.id,decision:'accept'}));
  git(root, 'switch', 'main');
  assert.deepEqual(await service.getArchitectureDocument(projectId), main.document);
  assert.equal(main.document.modules[0].notes, 'Branch A owner decision');
});

test('A13: a changed live file and a concurrent manual edit cannot alter the S1 result or user layout', async t => {
  const {root, store, service, analyzer} = await fixture(t);
  const s1 = sources[owned.sensor].replace('+ 1', '+ 6'), s2 = s1.replace('+ 6', '+ 9');
  await write(root, owned.sensor, s1);
  let baseVersion = -1;
  analyzer.analyze = async input => {
    if (input.unit.id !== 'sensor') return [];
    baseVersion = input.doc.version;
    await write(root, owned.sensor, s2);
    const manual = store.getArchitectureDoc(projectId, 'main')!;
    const sensor = manual.modules.find(m => m.id === 'sensor')!;
    sensor.summary = 'Manual threshold decision';
    sensor.origin = 'manual_override';
    manual.layout.positions.sensor = {x:99, y:81};
    service.saveArchitectureDocument(projectId, manual, manual.version);
    assert.equal((await readSource(store.directory, input.snapshot, owned.sensor)).text, s1);
    return [proposedUpdate(input, 'Frozen proposal +6')];
  };
  const result = await service.updateAffectedArchitecture(projectId);
  assert.equal(result.update_run.base_doc_version, baseVersion);
  assert.equal(result.update_run.read_baseline.file_hashes[owned.sensor], sha(s1));
  assert.equal(result.update_run.post_check_consistent, false);
  assert.ok(result.update_run.stale_reason?.includes('S1'));
  assert.ok(['changes_pending','needs_review'].includes(result.document.update_status));
  const saved = result.document.modules.find(m => m.id === 'sensor')!;
  assert.equal(saved.summary, 'Manual threshold decision');
  assert.deepEqual(result.document.layout.positions.sensor, {x:99, y:81});
  const review = result.document.review_items.find(i => i.category === 'manual_conflict');
  assert.ok(review);
  assert.ok(JSON.stringify(review.before).includes(saved.summary));
  assert.ok(JSON.stringify(review.proposed).includes('Frozen proposal +6'));
  assert.equal(review.evidence[0].content_sha256, sha(s1));
  const resolved = await service.resolveArchitectureReview(projectId, {reviewId:review.id, decision:'reject'});
  assert.notEqual(resolved.document.update_status, 'up_to_date');
});

test('A14: failure preserves usable content and retry invokes only the failed unit', async t => {
  const {root, doc, service, calls, analyzer} = await fixture(t);
  for (const id of ['sensor','persist']) await write(root, owned[id], sources[owned[id]].replace(/ [12];/, ' 5;'));
  analyzer.analyze = async input => {
    if (input.unit.id === 'sensor') throw Error('fixture sensor timeout');
    return [proposedUpdate(input, 'Persist transformed value')];
  };
  const failed = await service.updateAffectedArchitecture(projectId);
  assert.equal(failed.update_run.overall_status, 'partial');
  assert.equal(failed.update_run.model_calls, 2);
  assert.equal(failed.update_run.module_outcomes.sensor.status, 'failed');
  assert.equal(failed.update_run.module_outcomes.persist.status, 'needs_review');
  const sensor = failed.document.modules.find(m => m.id === 'sensor')!;
  assert.equal(sensor.analysis_status, 'failed');
  assert.match(sensor.analysis_error!, /fixture sensor timeout/);
  assert.equal(sensor.summary, doc.modules[0].summary);
  assert.deepEqual(failed.document.layout, doc.layout);
  assert.deepEqual(failed.document.relations, doc.relations);
  assert.equal(failed.document.baseline!.snapshot_id, doc.baseline!.snapshot_id);
  const pending = failed.document.review_items.find(i => i.target_id === 'persist')!;
  calls.length = 0;
  analyzer.analyze = async () => [];
  const retried = await service.updateAffectedArchitecture(projectId, {retryFailedOnly:true});
  assert.deepEqual(calls.map(u => [u.kind, u.id]), [['module','sensor']]);
  assert.equal(retried.update_run.model_calls, 1);
  assert.equal(retried.update_run.module_outcomes.sensor.status, 'succeeded');
  assert.equal(retried.document.modules.find(m => m.id === 'sensor')!.analysis_error, undefined);
  assert.equal(retried.document.update_status, 'needs_review');
  assert.equal(retried.document.review_items.find(i => i.id === pending.id)!.status, 'pending');
});

test('A15: individual decisions preserve siblings and repeated runs do not duplicate nodes, relations or reviews', async t => {
  const {root, doc, service, analyzer} = await fixture(t);
  await write(root, owned.sensor, sources[owned.sensor].replace('+ 1','+ 8'));
  analyzer.analyze = async input => {
    if (input.unit.id !== 'sensor') return [];
    const evidence = [cite(input.snapshot, owned.sensor)];
    return [
      proposedUpdate(input, 'Adjusted conversion'),
      {category:'relation_add', target_kind:'relation', target_id:'send', title:'Send timer event',
        proposed:{from:'sensor', to:'timer',kind:'queue_send', label:'Send timer event'}, evidence},
      {category:'module_add', target_kind:'module', target_id:'conversion', title:'Conversion stage',
        proposed:{name:'Conversion stage',kind:'stage',layer:'core',summary:'Convert',parent_id:'sensor'}, evidence},
    ];
  };
  const first = await service.updateAffectedArchitecture(projectId);
  assert.equal(first.document.review_items.length, 3);
  const byCategory = (category: string) => first.document.review_items.find(i => i.category === category)!.id;
  const repeat = await service.updateAffectedArchitecture(projectId);
  assert.deepEqual(repeat.document.review_items.map(i => i.id), first.document.review_items.map(i => i.id));
  const accepted = await service.resolveArchitectureReview(projectId, {reviewId:byCategory('module_add'),decision:'accept',note:'Owner agreed'});
  assert.equal(accepted.document.modules.find(m => m.id === 'conversion')!.origin, 'code_analysis');
  assert.equal(accepted.document.modules.find(m => m.id === 'conversion')!.implementation_status, 'implemented');
  assert.deepEqual(accepted.document.layout, doc.layout);
  assert.equal(accepted.document.modules[0].summary, doc.modules[0].summary);
  assert.deepEqual(accepted.document.relations, doc.relations);
  const rejected = await service.resolveArchitectureReview(projectId, {reviewId:byCategory('relation_add'),decision:'reject',note:'False relation'});
  const reject = rejected.document.review_items.find(i => i.id === byCategory('relation_add'))!;
  assert.equal(reject.status, 'rejected');
  assert.ok(reject.decided_at);
  assert.equal(reject.decision_note, 'False relation');
  assert.equal(rejected.document.exclusions[0].evidence_fingerprint, reject.evidence_fingerprint);
  const deferred = await service.resolveArchitectureReview(projectId, {reviewId:byCategory('module_update'),decision:'defer',note:'Ask owner'});
  assert.equal(deferred.document.review_items.find(i => i.id === byCategory('module_update'))!.status, 'deferred');
  assert.equal(deferred.document.update_status, 'needs_review');
  const final = await service.updateAffectedArchitecture(projectId);
  assert.deepEqual(final.document.review_items.map(i => [i.id,i.status]), deferred.document.review_items.map(i => [i.id,i.status]));
  assert.equal(final.document.modules.filter(m => m.id === 'conversion').length, 1);
  assert.deepEqual(final.document.relations.map(r => r.id), doc.relations.map(r => r.id));
});

test('missing workspace produces an unreliable detection and cannot transition a saved document to up to date', async t => {
  const {doc, root, service, store, calls} = await fixture(t);
  const project = store.get<Project>('project', projectId);
  const missingRoot = path.join(root, 'root-does-not-exist');
  store.put('project', projectId, {...project,root_path:missingRoot});
  const failure = await detectArchitectureChanges(missingRoot, doc);
  assert.equal(failure.has_changes, true);
  assert.equal(failure.detection_summary.detection_reliable, false);
  assert.ok(failure.detection_summary.detection_error);
  const check = await service.checkArchitectureUpdates(projectId);
  assert.equal(check.detection.has_changes, true);
  assert.equal(check.impact.impact_summary.mode, 'wide_recheck');
  assert.notEqual(check.document.update_status, 'up_to_date');
  await assert.rejects(service.updateAffectedArchitecture(projectId));
  const stored = store.getArchitectureDocById(doc.id)!;
  assert.equal(stored.pending_changes_summary!.detection_reliable, false);
  assert.ok(stored.pending_changes_summary!.checked_at);
  assert.equal(stored.pending_changes_summary!.impact_preview, undefined);
  assert.equal(stored.update_status, check.document.update_status);
  assert.equal(stored.version, doc.version);
  assert.deepEqual(store.versions('architecture_doc', doc.id), [doc]);
  assert.equal(calls.length, 0);
});

test('checking an unsaved branch leaves it at version zero', async t => {
  const {root, service, store} = await fixture(t);
  git(root, 'checkout', '-b', 'draft');
  const {document} = await service.checkArchitectureUpdates(projectId);
  assert.equal(document.branch_key, 'draft');
  assert.equal(document.version, 0);
  assert.ok(document.pending_changes_summary?.checked_at);
  assert.equal(store.getArchitectureDocById(document.id), undefined);
  assert.deepEqual(store.listArchitectureDocVersions(document.id), []);
});

test('global contract change is listed as unmapped and requires a wide recheck', async t => {
  const {service, root} = await fixture(t);
  await write(root, 'package.json', '{"name":"controls","type":"module"}');
  const checked = await service.checkArchitectureUpdates(projectId);
  const summary = checked.document.pending_changes_summary!;
  assert.deepEqual(summary.changed_files.map(f => [f.path, f.category]), [['package.json', 'config_or_contract']]);
  assert.equal(summary.impact_preview!.mode, 'wide_recheck');
  assert.deepEqual(summary.impact_preview!.unmapped_files, ['package.json']);
});

test('a proposal citing a nonexistent S1 line fails its unit and creates no review', async t => {
  const {service, root, analyzer, doc} = await fixture(t);
  await write(root, owned.sensor, sources[owned.sensor].replace('+ 1','+ 8'));
  analyzer.analyze = async input => [{
    ...proposedUpdate(input, 'Bad evidence'), evidence:[cite(input.snapshot, owned.sensor, 50)],
  }];
  const result = await service.updateAffectedArchitecture(projectId);
  assert.equal(result.update_run.overall_status, 'update_failed');
  assert.equal(result.update_run.module_outcomes.sensor.status, 'failed');
  assert.deepEqual(result.document.review_items, []);
  assert.equal(result.document.baseline!.snapshot_id, doc.baseline!.snapshot_id);
  assert.equal(result.document.modules[0].summary, doc.modules[0].summary);
});

test('uncertain rename without a module owner remains visible alongside a newly unmapped source', async t => {
  const {root, service, calls} = await fixture(t);
  const dest = 'unowned/normalize.c';
  await fs.mkdir(path.join(root, 'unowned'));
  git(root, 'mv', 'legacy/normalize.c', dest);
  await write(root, dest, 'int normalize(int value) { return value < 0 ? 0 : value; }\n');
  await write(root, 'unowned/flush.c', 'void flush(void) {}\n');
  const result = await service.updateAffectedArchitecture(projectId);
  const changed = result.update_run.detection_summary.changed_files;
  assert.ok(changed.some(f => f.path === dest && f.old_path === 'legacy/normalize.c' && f.status === 'renamed'));
  assert.ok(calls.some(u => u.kind === 'unmapped' && u.paths.includes('unowned/flush.c')));
  const review = result.document.review_items.find(i => i.category === 'rename_uncertain' && i.evidence.some(e => e.path === dest));
  assert.ok(review);
  assert.equal(result.update_run.overall_status, 'needs_review');
});

test('switching to another branch during analysis leaves the anchored update on its starting branch', async t => {
  const {root, service, analyzer} = await fixture(t);
  await write(root, owned.sensor, sources[owned.sensor].replace('+ 1','+ 4'));
  analyzer.analyze = async input => {
    git(root, 'switch', '-c', 'during-analysis');
    return [proposedUpdate(input, 'Main branch transformation')];
  };
  const result = await service.updateAffectedArchitecture(projectId);
  assert.equal(result.document.branch_key, 'main');
  assert.equal(result.update_run.read_baseline.branch, 'main');
  assert.equal(result.update_run.post_check_consistent, false);
  assert.notEqual(result.update_run.overall_status, 'up_to_date');
  const otherBranch = await service.getArchitectureDocument(projectId);
  assert.equal(otherBranch.branch_key, 'during-analysis');
  assert.deepEqual(otherBranch.review_items, []);
  const review = result.document.review_items[0];
  assert.ok(review);
  await assert.rejects(service.resolveArchitectureReview(projectId, {decision:'accept',reviewId:review.id}));
});

test('incremental IPC operations validate renderer payloads and expose a no-change analysis through ArcService', async t => {
  const {store} = await fixture(t);
  const arc = new ArcService(store.directory, process.cwd());
  try {
    const p = {project_id:projectId};
    const checked = await architectureIpc(arc, 'architecture_check_updates', p);
    assert.ok('detection' in checked && !checked.detection.has_changes);
    const updated = await architectureIpc(arc, 'architecture_update_affected', {...p,branch_key:'main',retry_failed_only:false});
    assert.ok('update_run' in updated && updated.update_run && typeof updated.update_run === 'object' &&
      'model_calls' in updated.update_run && updated.update_run.model_calls === 0);
    await assert.rejects(architectureIpc(arc, 'architecture_check_updates', {...p,branch_key:5}));
    await assert.rejects(architectureIpc(arc, 'architecture_update_affected', {...p,module_ids:'sensor'}));
    await assert.rejects(architectureIpc(arc, 'architecture_update_affected', {...p,retry_failed_only:1}));
    await assert.rejects(architectureIpc(arc, 'architecture_review_resolve', {...p,review_id:'some-id',decision:'bulk-accept'}));
    await assert.rejects(architectureIpc(arc, 'architecture_review_resolve', {...p,review_id:'some-id',decision:'accept',note:[]}));
  } finally {await arc.shutdown(); arc.store.close();}
});

test('review decisions reject a hierarchy cycle atomically and apply only the selected relation or module operation', async t => {
  const {service,store,root,doc,analyzer} = await fixture(t);
  const first = doc.relations[0];
  first.origin = 'manual_override';
  doc.relations.push({...first,id:'sensor-clock',to:'timer',origin:'code_analysis'},
    {...first,id:'display-clock',from:'display',to:'timer',origin:'code_analysis'});
  doc.modules.find(m => m.id === 'timer')!.parent_id = 'sensor';
  service.saveArchitectureDocument(projectId, doc, doc.version);
  await write(root, owned.sensor, sources[owned.sensor].replace('+ 1', '+ 5'));
  analyzer.analyze = async input => {
    const evidence = [cite(input.snapshot, owned.sensor)];
    return [
      {category:'hierarchy_change',target_kind:'module',target_id:'sensor',title:'Move under timer',proposed:{parent_id:'timer'},evidence},
      {category:'relation_update',target_kind:'relation',target_id:first.id,title:'Rename handoff',proposed:{label:'New handoff'},evidence},
      {category:'relation_remove',target_kind:'relation',target_id:'sensor-clock',title:'Remove sensor timer edge',evidence},
      {category:'module_remove',target_kind:'module',target_id:'sensor',title:'Remove sensor',evidence},
    ];
  };
  const result = await service.updateAffectedArchitecture(projectId);
  const byOperation = (operation: string) => result.document.review_items.find(i => i.operation === operation)!;
  const decide = (operation: string) => service.resolveArchitectureReview(projectId, {reviewId:byOperation(operation).id,decision:'accept'});
  assert.equal(byOperation('relation_update').category, 'manual_conflict');
  await assert.rejects(decide('hierarchy_change'), /cycle|循环/i);
  assert.deepEqual(store.getArchitectureDoc(projectId,'main'), result.document);
  const edited = await decide('relation_update');
  assert.equal(edited.document.relations.find(r => r.id === first.id)!.label, 'New handoff');
  assert.equal(edited.document.relations.length, 3);
  assert.deepEqual(edited.document.layout, doc.layout);
  const removal = await decide('relation_remove');
  assert.deepEqual(new Set(removal.document.relations.map(r => r.id)), new Set([first.id,'display-clock']));
  // The accepted rename changed an edge that the original module removal would delete.
  await assert.rejects(decide('module_remove'),/目标内容已变化/);
  analyzer.analyze = async input => input.unit.id==='sensor' ? [{category:'module_remove',target_kind:'module',target_id:'sensor',
    title:'Remove sensor',evidence:[cite(input.snapshot,owned.sensor)]}] : [];
  const rechecked = await service.updateAffectedArchitecture(projectId);
  const removalId = rechecked.document.review_items.find(i=>i.operation==='module_remove')!.id;
  assert.notEqual(removalId,byOperation('module_remove').id);
  const graph = (await service.resolveArchitectureReview(projectId,{reviewId:removalId,decision:'accept'})).document;
  assert.ok(!graph.modules.some(m => m.id === 'sensor'));
  assert.equal(graph.modules.find(m => m.id === 'timer')!.parent_id, undefined);
  assert.deepEqual(graph.relations.map(r => r.id), ['display-clock']);
  assert.deepEqual(graph.layout.positions, {persist:doc.layout.positions.persist});
  assert.deepEqual(graph.layout.manual_positions, ['persist']);
});

test('selecting modules across runs advances the baseline only after all affected modules complete on S1', async t => {
  const {root,service,doc,calls} = await fixture(t);
  for (const id of ['sensor','persist']) await write(root, owned[id], sources[owned[id]].replace(/ [12];/, ' 7;'));
  const first = await service.updateAffectedArchitecture(projectId, {moduleIds:['sensor']});
  assert.deepEqual(calls.map(u => u.id), ['sensor']);
  assert.equal(first.update_run.model_calls, 1);
  assert.equal(first.document.update_status, 'changes_pending');
  assert.equal(first.document.baseline!.snapshot_id, doc.baseline!.snapshot_id);
  assert.equal(first.document.last_confirmed_version, doc.last_confirmed_version);
  const second = await service.updateAffectedArchitecture(projectId, {moduleIds:['persist']});
  assert.deepEqual(calls.map(u => u.id), ['sensor', 'persist']);
  assert.equal(second.update_run.model_calls, 1);
  assert.equal(second.update_run.read_baseline.snapshot_id, first.update_run.read_baseline.snapshot_id);
  assert.equal(second.document.update_status, 'up_to_date');
  assert.equal(second.document.baseline!.snapshot_id, first.update_run.read_baseline.snapshot_id);
  assert.equal(second.document.last_confirmed_version, second.document.version);
});

test('a no-model check between a proposed change and final acceptance confirms the analyzed snapshot', async t => {
  const {root,service,doc,analyzer,calls} = await fixture(t);
  analyzer.analyze = async input => input.unit.id === 'sensor' ? [proposedUpdate(input, 'Calibrated sensor')] : [];
  await write(root, owned.sensor, sources[owned.sensor].replace('+ 1', '+ 8'));
  const pending = await service.updateAffectedArchitecture(projectId);
  assert.equal(pending.document.update_status, 'needs_review');
  assert.equal(pending.document.baseline!.snapshot_id, doc.baseline!.snapshot_id);
  const checked = await service.checkArchitectureUpdates(projectId);
  assert.equal(checked.document.update_status, 'needs_review');
  assert.equal(checked.document.baseline!.snapshot_id, doc.baseline!.snapshot_id);
  assert.deepEqual(calls.map(unit => unit.id), ['sensor','persist']);
  const item = pending.document.review_items[0];
  const accepted = await service.resolveArchitectureReview(projectId,{reviewId:item.id,decision:'accept'});
  assert.equal(accepted.document.modules[0].summary, 'Calibrated sensor');
  assert.equal(accepted.document.update_status, 'up_to_date');
  assert.equal(accepted.document.baseline!.snapshot_id, pending.update_run.read_baseline.snapshot_id);
  assert.equal(accepted.document.last_confirmed_version, accepted.document.version);
  assert.equal((await service.updateAffectedArchitecture(projectId)).update_run.model_calls, 0);
});

test('a manual save keeps the later host check and a restored version requires a fresh check', async t => {
  const {root,service,doc} = await fixture(t);
  await write(root,owned.sensor,sources[owned.sensor].replace('+ 1','+ 9'));
  const checked = await service.checkArchitectureUpdates(projectId);
  const saved = service.saveArchitectureDocument(projectId,{...doc,title:'Local edit'},doc.version);
  assert.equal(saved.update_status,'changes_pending');
  assert.deepEqual(saved.pending_changes_summary,checked.document.pending_changes_summary);
  await service.updateAffectedArchitecture(projectId);
  const restored = service.restoreArchitectureVersion(projectId,'main',saved.version);
  assert.equal(restored.pending_changes_summary,undefined);
  assert.equal(restored.update_status,'changes_pending');
  assert.equal(restored.baseline?.snapshot_id,doc.baseline?.snapshot_id);
  const edited = service.saveArchitectureDocument(projectId,{...restored,title:'Restored edit'},restored.version);
  assert.equal(edited.update_status,'changes_pending');
});

test('accept checks the proposed module and relation fields and the latest read fingerprint before writing', async t => {
  const {root,service,doc,store,analyzer} = await fixture(t);
  await write(root,owned.sensor,sources[owned.sensor].replace('+ 1','+ 9'));
  analyzer.analyze = async input => input.unit.id==='sensor' ? [proposedUpdate(input,'Proposed summary'),
    {category:'relation_update',target_kind:'relation',target_id:doc.relations[0].id,title:'Proposed label',
      proposed:{label:'Proposed label'},evidence:[cite(input.snapshot,owned.sensor)]}] : [];
  const {document} = await service.updateAffectedArchitecture(projectId);
  const edited = structuredClone(document);
  edited.modules[0].summary='New user summary';
  edited.relations[0].label='New user label';
  const saved = service.saveArchitectureDocument(projectId,edited,document.version);
  for (const item of saved.review_items) {
    await assert.rejects(service.resolveArchitectureReview(projectId,{reviewId:item.id,decision:'accept'}),/目标内容已变化.*重新检查/);
  }
  assert.deepEqual(store.getArchitectureDoc(projectId,'main'),saved);
  // S2 observes a different checkout state and produces no replacement proposal.
  await write(root,owned.sensor,sources[owned.sensor].replace('+ 1','+ 12'));
  analyzer.analyze = async () => [];
  const newer = await service.updateAffectedArchitecture(projectId);
  assert.notEqual(newer.update_run.read_baseline.fingerprint,saved.last_update!.read_baseline.fingerprint);
  await assert.rejects(service.resolveArchitectureReview(projectId,{reviewId:saved.review_items[0].id,decision:'accept'}),/读取快照已变化.*重新检查/);
  assert.deepEqual(store.getArchitectureDoc(projectId,'main'),newer.document);
});

test('rechecking the same snapshot replaces a conflicting suggestion and preserves independent edits', async t => {
  const {root,service,analyzer} = await fixture(t);
  await write(root,owned.sensor,sources[owned.sensor].replace('+ 1','+ 9'));
  analyzer.analyze = async input => input.unit.id==='sensor' ? [proposedUpdate(input,'Proposal')] : [];
  const {document} = await service.updateAffectedArchitecture(projectId);
  const original = document.review_items[0];
  const deferred = await service.resolveArchitectureReview(projectId,{reviewId:original.id,decision:'defer',note:'Ask owner'});
  const edited = deferred.document;
  edited.modules[0].summary='Owner revision';
  service.saveArchitectureDocument(projectId,edited,edited.version);
  const refreshed = await service.updateAffectedArchitecture(projectId);
  const replacement = refreshed.document.review_items.find(i=>i.dedupe_key===original.dedupe_key)!;
  assert.notEqual(replacement.id,original.id);
  assert.equal(replacement.status,'deferred');
  assert.equal(replacement.decision_note,'Ask owner');
  assert.equal((replacement.before as ArchitectureModule).summary,'Owner revision');
  await assert.rejects(service.resolveArchitectureReview(projectId,{reviewId:original.id,decision:'accept'}));
  refreshed.document.modules[0].notes='Unrelated new note';
  service.saveArchitectureDocument(projectId,refreshed.document,refreshed.document.version);
  const accepted = await service.resolveArchitectureReview(projectId,{reviewId:replacement.id,decision:'accept'});
  assert.equal(accepted.document.modules[0].summary,'Proposal');
  assert.equal(accepted.document.modules[0].notes,'Unrelated new note');
});

test('an old module removal cannot delete a newly edited edge or reparent a newly attached child', async t => {
  const {root,service,store,analyzer} = await fixture(t);
  await write(root,owned.sensor,sources[owned.sensor].replace('+ 1','+ 9'));
  analyzer.analyze = async input => input.unit.id==='sensor' ? [{category:'module_remove',target_kind:'module',target_id:'sensor',
    title:'Remove sensor',evidence:[cite(input.snapshot,owned.sensor)]}] : [];
  const {document} = await service.updateAffectedArchitecture(projectId);
  const reviewId = document.review_items[0].id;
  const changedEdge = structuredClone(document);
  changedEdge.relations[0].label='User edited this edge';
  const saved = service.saveArchitectureDocument(projectId,changedEdge,document.version);
  await assert.rejects(service.resolveArchitectureReview(projectId,{reviewId,decision:'accept'}),/目标内容已变化/);
  assert.deepEqual(store.getArchitectureDoc(projectId,'main'),saved);
  const changedChild = structuredClone(saved);
  changedChild.relations=document.relations;
  changedChild.modules.find(m=>m.id==='timer')!.parent_id='sensor';
  const next = service.saveArchitectureDocument(projectId,changedChild,saved.version);
  await assert.rejects(service.resolveArchitectureReview(projectId,{reviewId,decision:'accept'}),/目标内容已变化/);
  assert.deepEqual(store.getArchitectureDoc(projectId,'main'),next);
});
