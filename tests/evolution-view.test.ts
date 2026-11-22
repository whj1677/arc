import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {computeStructureDiff, computeWalkthroughDiff, type TaskHudSnapshot} from '../src/development-hud';
import type {CodeState, EngineeringTask} from '../src/engineering';
import type {LiveWorkspaceRadar} from '../src/live-radar';
import {assembleCodeIndex, parseSourceUnit} from '../src/main/code-index';
import {reviewDevelopmentDiff} from '../src/main/development-review';
import {diffLines} from '../src/main/evolution-flows';
import {buildRadarEvolutionView, buildTaskEvolutionView} from '../src/main/evolution-view';
import type {AnalysisResult, Explanation} from '../src/shared';

const example: AnalysisResult = JSON.parse(readFileSync('examples/analysis-result.json', 'utf8'));
const source = 'entry/main.ts', api = 'core/sample.ts', store = 'storage/write.ts';
const state = (id: string): CodeState => ({snapshot_id:id, fingerprint:id, workspace_fingerprint:id,
  captured_at:'now', branch:null, head:null, git_common_dir:null, dirty:[]});
const fileChange = (path: string): EngineeringTask['changes'][number] =>
  ({path, before_sha256:'old', after_sha256:'new', ownership:'task_change'});
function task(files: string[], extra: Partial<EngineeringTask> = {}): EngineeringTask {
  return {task_id:'t', project_id:'p', workspace_id:'w', workspace_path:'.', version:1, submission_key:'test',
    goal:'Read samples', scope:files, baseline:state('before'), end_state:state('after'), status:'completed', context_version:1,
    summary:'', decisions:[], unresolved:[], changes:files.map(fileChange), verification:[], verification_status:'not_run',
    attempt_ids:[], created_at:'now', updated_at:'now', saved:'saved', ...extra};
}
function hud(): TaskHudSnapshot {
  return {task_id:'t', version:1, impacted_features:[], walkthrough_diffs:[], impact:{scope_files:[], scope_declared:false,
    impacted_features:[], external_callers:[], shared_states:[], architecture_nodes:[], architecture_edges:[],
    related_constraints:[], untested_symbols:[]}};
}
async function indexes(before: Record<string,string>, after: Record<string,string>) {
  const beforeSources = new Map(Object.entries(before)), afterSources = new Map(Object.entries(after));
  const parse = async (sources: Map<string,string>, id: string) => assembleCodeIndex(
    await Promise.all([...sources].map(([file, code]) => parseSourceUnit(file, code))), id, id);
  return {beforeSources, afterSources, beforeIndex:await parse(beforeSources, 'before'), afterIndex:await parse(afterSources, 'after')};
}
function radar(context: Awaited<ReturnType<typeof indexes>>, files: string[]): LiveWorkspaceRadar {
  return {project_id:'p', workspace_path:'.', source:'git', is_git:true, branch:null, head_sha:null, mode:'worktree',
    base_ref:'HEAD', target_ref:'worktree', fingerprint:'test', computed_ms:0, cache_hit:false, recent_commits:[],
    impact:hud().impact, changed_files:files.map(path => ({path, status:'modified'})),
    structure_diff:computeStructureDiff(context.beforeIndex, context.afterIndex, [], files)};
}
function node(id: string, file: string, kind: AnalysisResult['nodes'][number]['kind']): AnalysisResult['nodes'][number] {
  return {...example.nodes[0], node_id:id, label:id, description:id, kind, source_scope:{kind:'file', path:file},
    evidence_ids:[id], claim_ids:[]};
}
function result(nodes: AnalysisResult['nodes']): AnalysisResult {
  return {...example, nodes, edges:[], result_id:'old-reading', architecture:undefined, evidence:nodes.map(n => ({
    ...example.evidence[0], evidence_id:n.node_id, path:n.source_scope!.path, role:'definition', line_start:1, line_end:1,
  }))};
}

test('moving the last unique line to the front preserves the other 1599 line matches', () => {
  const lines = Array.from({length:1600}, (_, i) => 'line ' + (i + 1));
  const diff = diffLines(lines.join('\n'), [lines[1599], ...lines.slice(0, -1)].join('\n'));
  assert.deepEqual([...diff.changedBeforeLines], [1600]);
  assert.deepEqual([...diff.insertions], [1]);
  assert.deepEqual(lines.slice(0, -1).map((_, i) => diff.mapAfterToBefore(i + 2)),
    lines.slice(0, -1).map((_, i) => i + 1));
});

test('AST symbol projection keeps both occurrences of one callee and removes the call at its old line', async () => {
  const files = {[source]:'function poll() {\n  sample(1);\n  const id = 2;\n  sample(id);\n}',
    [api]:'function sample(id: number) { return id; }'};
  const context = await indexes(files, {...files,
    [source]:'function poll() {\n  const start = 0;\n  const offset = 2;\n  const id = start + offset;\n\n  sample(id);\n}'});
  const workspace = buildRadarEvolutionView(radar(context, [source]), context);
  assert.equal(workspace.mode, 'workspace_radar');
  assert.deepEqual(workspace.approach, []);
  assert.deepEqual(workspace.assumptions, []);
  const flow = workspace.features[workspace.active_feature_index];
  assert.equal(flow.mode, 'ast_symbol_flow');
  assert.deepEqual([flow.before_snapshot_id, flow.after_snapshot_id], ['before', 'after']);
  const sites = flow.steps.find(s => s.symbol === 'poll')?.call_sites;
  assert.ok(sites);
  assert.deepEqual([...sites].sort((a,b) => a.line - b.line)
    .map(s => [s.status, s.line, s.caller_symbol, s.target_symbol, s.file, s.target_file]), [
    ['removed', 2, 'poll', 'sample', source, api], ['unchanged', 6, 'poll', 'sample', source, api],
  ]);
});

test('architecture distinguishes stronger and new cross-layer edges, with exact calls and a directory fallback', async () => {
  const files = {[source]:'function poll() {\n  sample(1);\n}', [api]:'function sample(id: number) { return id; }',
    [store]:'function write() {}'};
  const context = await indexes(files, {...files, [source]:'function poll() {\n  sample(1);\n  sample(2);\n  sample(3);\n  write();\n}'});
  const nodes = [node('entry', source, 'execution_boundary'), node('core', api, 'stage'), node('db', store, 'resource'),
    node('idle', 'other/unused.ts', 'stage')];
  const overview = {...result(nodes), architecture:{node_ids:nodes.map(n => n.node_id), edge_ids:[]}};
  const input = radar(context, [source]);
  const view = buildRadarEvolutionView(input, {...context, overview});
  const arch = view.architecture;
  assert.equal(arch.mode, 'overview');
  assert.equal(arch.modules.length, 4);
  assert.equal(arch.modules.find(m => m.id === 'idle')?.relation, 'unchanged');
  const existing = arch.edges.find(e => e.from_id === 'entry' && e.to_id === 'core');
  assert.deepEqual([existing?.cross_layer, existing?.kind, existing?.before_count, existing?.after_count], [true,'strengthened',1,3]);
  const newEdge = arch.edges.find(e => e.from_id === 'entry' && e.to_id === 'db');
  assert.deepEqual([newEdge?.kind, newEdge?.before_count, newEdge?.after_count], ['new_cross_layer',0,1]);
  assert.deepEqual(newEdge?.sample_call, {file:source, line:5, caller_symbol:'poll', callee_symbol:'write'});
  assert.deepEqual(view.side_effects.filter(s => s.category === 'new_cross_layer_edge')
    .map(s => [s.evidence_kind, s.file, s.line, s.module_ids]), [['ast_proved',source,5,['entry','db']]]);
  const fallback = buildRadarEvolutionView(input, context).architecture;
  assert.equal(fallback.mode, 'directory_fallback');
  assert.ok(fallback.modules.every(m => m.source_kind === 'directory_fallback'));
  assert.deepEqual(fallback.edges.map(e => [e.from_label, e.to_label, e.before_count, e.after_count]).sort(),
    [['entry','core',1,3], ['entry','storage',0,1]]);
  const large = [...nodes, ...Array.from({length:8}, (_,i) => node('idle-' + i, 'misc/' + i + '.ts', 'stage'))];
  const bounded = buildRadarEvolutionView(input, {...context, overview:{...result(large),
    architecture:{node_ids:large.map(n => n.node_id), edge_ids:[]}}}).architecture;
  assert.equal(bounded.all_modules_count, large.length);
  assert.ok(bounded.modules.length <= 8);
  assert.equal(bounded.omitted_modules, large.length - bounded.modules.length);
  assert.ok(bounded.modules.some(m => m.changed_files.includes(source)));
});

test('a removed edge cites its old call and a new same-layer call creates no cross-layer warning', async () => {
  const files = {[source]:'function poll() {\n  sample(1);\n}', [api]:'function sample(id: number) { return id; }',
    [store]:'function write() {}'};
  const context = await indexes(files, {...files, [source]:'function poll() {\n\n  write();\n}'});
  const nodes = [node('poll', source, 'stage'), node('api', api, 'stage'), node('store', store, 'stage')];
  const overview = {...result(nodes), architecture:{node_ids:nodes.map(n => n.node_id), edge_ids:[]}};
  const view = buildRadarEvolutionView(radar(context, [source]), {...context, overview});
  assert.deepEqual(view.architecture.edges.map(edge => [edge.kind, edge.from_id, edge.to_id, edge.sample_call?.line]).sort(),
    [['new_same_layer','poll','store',3], ['removed','poll','api',2]]);
  assert.ok(!view.side_effects.some(effect => effect.category === 'new_cross_layer_edge'));
});

test('runtime evidence cannot claim a build file, while a dedicated document keeps its owner', () => {
  const build = 'CMakeLists.txt', doc = 'DOCS/protocol', config = 'settings.ini';
  const hal = {...node('node-hal', 'hal/port.cpp', 'stage'), evidence_ids:['node-hal', 'build']};
  const base = result([hal, node('manual', doc, 'resource')]);
  const overview = {...base, evidence:[...base.evidence, {...base.evidence[0], evidence_id:'build', path:build}],
    architecture:{node_ids:['node-hal', 'manual'], edge_ids:[]}};
  const current = task([build, doc, config, 'hal/port.cpp']);
  current.changes[2].after_sha256 = null;
  const view = buildTaskEvolutionView(current, hud(), {overview});
  assert.deepEqual(view.changed_files.map(f => [f.path, f.role, f.module_id]),
    [[build, 'build', undefined], [doc, 'doc', 'manual'], [config, 'config', undefined], ['hal/port.cpp', 'code', 'node-hal']]);
  const runtime = view.architecture.modules.find(m => m.id === 'node-hal')!;
  assert.deepEqual(runtime.changed_files, ['hal/port.cpp']);
  assert.deepEqual(view.architecture.modules.find(m => m.id === 'manual')?.changed_files, []);
  assert.deepEqual(view.architecture.non_code_changes, [
    {path:build, role:'build', status:'modified'}, {path:doc, role:'doc', status:'modified'},
    {path:config, role:'config', status:'removed'},
  ]);
});

test('a static overview neighbor and a new call recipient have distinct relations', async () => {
  const files = {[source]:'function poll() {}', [api]:'function sample() {}', [store]:'function write() {}'};
  const context = await indexes(files, {...files, [source]:'function poll() { sample(); }'});
  const nodes = [node('entry', source, 'execution_boundary'), node('api', api, 'stage'), node('store', store, 'resource')];
  const link = {...example.edges[0], edge_id:'uses-store', source_node_id:'entry', target_node_id:'store'};
  const overview = {...result(nodes), edges:[link], architecture:{node_ids:nodes.map(n => n.node_id), edge_ids:[link.edge_id]}};
  const view = buildRadarEvolutionView(radar(context, [source]), {...context, overview});
  assert.deepEqual(Object.fromEntries(view.architecture.modules.map(m => [m.id, m.relation])),
    {entry:'direct', api:'edge_impacted', store:'neighbor'});
});

test('actual task summaries and progress use reviewed work, while a blueprint uses planned behaviors', () => {
  const behavior = {id:'plan', behavior:'计划采样', design:'原设计', files:['core\\sample.ts'], step_ids:['impl'], verification:'运行检查'};
  const step = {step_id:'impl', title:'完成采样', change:'实现采样', progress:'  已记录采样值  ', status:'completed' as const,
    criteria:[], evidence_ids:[], unresolved:[], created_at:'now', updated_at:'now'};
  const current = task([api], {summary:'  任务总结  ', diff_review:{verdict:'approved', summary:'  审查已确认采样行为  '},
    requirement_package:{behaviors:[behavior, {...behavior, id:'also-plan', files:[api, store]}]},
    steps:[step, {...step, step_id:'verify', title:'设备验证', progress:'  ', change:'等待设备', status:'blocked'},
      {...step, step_id:'old', status:'superseded'}]});
  const actual = buildTaskEvolutionView(current, hud(), {});
  assert.equal(actual.verdict_summary, '审查已确认采样行为');
  assert.deepEqual(actual.approach, [
    {id:'impl', title:'完成采样', detail:'已记录采样值', files:[api, store], status:'done'},
    {id:'verify', title:'设备验证', detail:'等待设备', files:[], status:'blocked'},
  ]);
  const blueprint = buildTaskEvolutionView({...current, end_state:undefined, diff_review:{verdict:'approved', summary:' '}}, hud(), {});
  assert.equal(blueprint.verdict_summary, '任务总结');
  assert.deepEqual(blueprint.approach.map(s => [s.id, s.detail, s.status]), [
    ['plan','原设计','planned'], ['also-plan','原设计','planned'],
  ]);
});

test('walkthrough wording, stale evidence, bound selection, and document-only edits remain distinct', async () => {
  const files = {[source]:'function poll() {\n  sample(1);\n}', [api]:'function sample(id: number) { return id; }'};
  const context = await indexes(files, files);
  const base = result([node('poll', source, 'function'), node('sample', api, 'function')]);
  const feature = {feature_id:'paired', scenario_id:'paired-scenario', label:'轮询', previous_result_id:base.result_id,
    has_call_graph:true, refreshing:false};
  const stale = {...feature, feature_id:'stale', scenario_id:'stale-scenario'};
  const step = {id:'call', kind:'call' as const, from_node_id:'poll', to_node_id:'sample', text:'读取参数',
    input:'id', output:'value', condition:'有请求', evidence_ids:['poll']};
  const primary = {id:'primary', label:'读取', trigger:'poll', entry_node_id:'poll', boundary:'', evidence_ids:['poll'], steps:[step]};
  const old: AnalysisResult = {...base, function_walkthroughs:[primary]};
  const next: AnalysisResult = {...old, result_id:'new-reading', function_walkthroughs:[
    {...primary, steps:[{...step, condition:'收到请求时', text:'读取采样参数'}]}]};
  const explanation: Explanation = {result_id:old.result_id, scenario_id:stale.scenario_id, created_at:'now', source_status:'changed', result:old};
  const data = {...context, explanations:new Map([[old.result_id, explanation]]), walkthroughIndexes:new Map([[feature.scenario_id, context]])};
  const diff = computeWalkthroughDiff({...feature, feature_label:feature.label, before:old, after:next, ...context});
  assert.deepEqual([diff.paths[0].steps[0].status, diff.paths[0].steps[0].code_changed], ['modified',false]);
  const snapshot = hud();
  snapshot.walkthrough_diffs = [diff];
  snapshot.impacted_features = snapshot.impact.impacted_features = [feature, stale];
  const current = task([source]);
  const view = buildTaskEvolutionView(current, snapshot, data);
  const flow = view.features[view.active_feature_index];
  assert.equal(flow.mode, 'walkthrough_diff');
  assert.equal(flow.steps[0].status, 'description_only');
  assert.deepEqual(flow.steps[0].call_sites?.map(s => [s.line,s.caller_symbol,s.target_symbol,s.status]), [[2,'poll','sample','unchanged']]);
  current.reading = {feature_id:stale.feature_id, scenario_id:stale.scenario_id, result_id:old.result_id,
    source_snapshot_id:'before', target:{kind:'feature',id:stale.feature_id}};
  const bound = buildTaskEvolutionView(current, snapshot, data);
  const prior = bound.features[bound.active_feature_index];
  assert.equal(prior.mode, 'walkthrough_stale');
  assert.equal(prior.before_snapshot_id, old.binding.source_snapshot_id);
  assert.equal(prior.stale_notice, '改后走读待刷新（当前基于改前走读投影）');
  assert.equal(prior.steps[0].status, 'unchanged');
  const blueprint = buildTaskEvolutionView({...current, workflow:'ready', changes:[]}, {...snapshot, walkthrough_diffs:[]}, data);
  assert.equal(blueprint.mode, 'task_blueprint');
  assert.equal(blueprint.features[blueprint.active_feature_index].steps[0].status, 'planned');
  const docs = buildTaskEvolutionView(task(['docs/guide.md']), snapshot, data);
  assert.equal(docs.document_only, true);
  assert.deepEqual(docs.features.map(f => f.mode), ['document_only']);
});

test('a long stale walkthrough keeps untouched functions and inserts new calls at their original run positions', async () => {
  const file = 'startup.cpp';
  const stages = Array.from({length:16}, (_, i) => '  value += ' + (i + 1) + ';');
  const run = 'int Startup::run() {', parseCall = '  int value = parse_arguments_();';
  const before = ['struct Startup { static int run(); };', 'int parse_arguments_() { return 0; }', 'void record() {}', '',
    run, parseCall, ...stages, '  return value;', '}', 'int main() { return Startup::run(); }'];
  const helpers = [...Array.from({length:150}, (_, i) => '// header ' + i),
    '/** @brief Record component version */', 'void log_version() { record(); }',
    '// Record startup state', 'void log_state() { record(); }'];
  const callback = '  register_callback(log_state);';
  const after = before.flatMap(line => line === run ? [...helpers, line] :
    line === stages[9] ? [line, '  log_version();'] :
    line === stages[13] ? [line, callback, '  register_callback(record);', '  log_version();'] : [line]);
  const context = await indexes({[file]:before.join('\n')}, {[file]:after.join('\n')});
  const symbols = context.beforeIndex.symbols.filter(s => s.has_body && ['main', 'parse_arguments_', 'run'].includes(s.name));
  const nodes = symbols.map(s => ({...node(s.name, file, 'function'), function_details:{symbol:s.name, signature:s.signature,
    definition_evidence_id:s.name, parameter_io_ids:[], return_io_ids:[]}}));
  const base = result(nodes);
  const evidence: AnalysisResult['evidence'][number][] = symbols.map(s => ({...base.evidence[0], evidence_id:s.name,
    path:file, line_start:s.start_line, line_end:s.end_line, role:'definition'}));
  type Step = NonNullable<AnalysisResult['function_walkthroughs']>[number]['steps'][number];
  function step(id: string, kind: Step['kind'], from: string|null, to: string, sourceLine: string): Step {
    const line = before.indexOf(sourceLine) + 1;
    evidence.push({...base.evidence[0], evidence_id:id, path:file, line_start:line, line_end:id === 'stage-10' ? line + 1 : line,
      role:kind === 'call' ? 'callsite' : 'context'});
    return {id, kind, from_node_id:from, to_node_id:to, text:id, input:'', output:'', condition:'',
      evidence_ids:kind === 'call' ? [id, to] : [id]};
  }
  const steps = [step('enter', 'entry', null, 'main', before.at(-1)!),
    step('start', 'call', 'main', 'run', before.at(-1)!),
    step('parse', 'call', 'run', 'parse_arguments_', parseCall),
    ...stages.map((line, i) => {
      const stage = step('stage-' + (i + 1), 'work', 'run', 'run', line);
      return i === 15 ? {...stage, evidence_ids:[...stage.evidence_ids, 'earlier-helper']} : stage;
    })];
  const helperLine = before.indexOf('void record() {}') + 1;
  evidence.push({...base.evidence[0], evidence_id:'earlier-helper', path:file, line_start:helperLine, line_end:helperLine, role:'context'});
  const reading: AnalysisResult = {...base, binding:{...base.binding, source_snapshot_id:'before'}, evidence,
    function_walkthroughs:[{id:'startup', label:'Startup', trigger:'entry', boundary:'', entry_node_id:'main', evidence_ids:['main'], steps}]};
  const snapshot = hud();
  const feature = {feature_id:'startup', scenario_id:'startup', label:'Startup', previous_result_id:reading.result_id,
    has_call_graph:true, refreshing:false};
  snapshot.impacted_features = snapshot.impact.impacted_features = [feature];
  snapshot.structure_diff = computeStructureDiff(context.beforeIndex, context.afterIndex, [file], [file]);
  const explanation: Explanation = {result_id:reading.result_id, scenario_id:feature.scenario_id, created_at:'now',
    source_status:'changed', result:reading};
  const view = buildTaskEvolutionView(task([file]), snapshot, {...context, explanations:new Map([[reading.result_id, explanation]])});
  const flow = view.features.find(f => f.mode === 'walkthrough_stale')!;
  assert.deepEqual([flow.before_snapshot_id, flow.after_snapshot_id, flow.omitted_steps], ['before','after',0]);
  const added = flow.steps.filter(s => s.inserted);
  assert.ok(context.afterIndex.calls.some(c => c.callee_name === 'log_state' && c.syntax === 'reference'));
  const names = ['log_version', 'log_state'];
  assert.deepEqual(added.map(s => [s.status, s.symbol, s.parent_symbol, s.title, s.sub_calls]), [
    ['added', names[0], 'Startup::run', 'Record component version', ['record']],
    ['added', names[1], 'Startup::run', 'Record startup state', ['record']],
  ]);
  for (const [i, s] of added.entries()) {
    const line = after.indexOf(i === 0 ? '  log_version();' : callback) + 1;
    assert.deepEqual([s.id, s.file, s.line, s.after_line, s.subtitle],
      ['ast-ins:' + file + ':' + line + ':' + names[i], file, line, line, '在 Startup::run 中新增调用']);
    assert.deepEqual(s.call_sites?.map(c => [c.caller_symbol, c.target_symbol, c.line, c.status]), [['Startup::run', names[i], line, 'added']]);
  }
  assert.deepEqual(flow.steps.map(s => s.id), steps.flatMap(s =>
    s.id === 'stage-10' ? [s.id, added[0].id] : s.id === 'stage-14' ? [s.id, added[1].id] : [s.id]));
  assert.deepEqual(flow.steps.map(s => s.order), flow.steps.map((_, i) => i + 1));
  for (const id of ['enter', 'start', 'parse', 'stage-3']) assert.equal(flow.steps.find(s => s.id === id)?.status, 'unchanged', id);
  for (const id of ['stage-10', 'stage-14']) assert.equal(flow.steps.find(s => s.id === id)?.status, 'modified', id);
  assert.deepEqual(view.architecture.modules.find(m => m.relation === 'direct')?.key_symbols?.map(s => [s.name, s.status, s.doc]),
    [['log_version', 'added', 'Record component version'], ['log_state', 'added', 'Record startup state'], ['Startup::run', 'modified', undefined]]);
});

test('a changed second walkthrough path is selected by default and both frozen paths are preserved', async () => {
  const files = {[source]:'function poll() { sample(1); }', [api]:'function sample(id: number) { return id; }'};
  const context = await indexes(files, {...files, [source]:'function poll() { sample(2); }'});
  const base = result([node('poll', source, 'function'), node('sample', api, 'function')]);
  const step = {id:'call', kind:'call' as const, from_node_id:'poll', to_node_id:'sample', text:'采样',
    input:'id', output:'value', condition:'', evidence_ids:['poll']};
  const first = {id:'first', label:'默认分支', trigger:'poll', entry_node_id:'poll', boundary:'', evidence_ids:['poll'], steps:[step]};
  const second = {...first, id:'second', label:'备用分支'};
  const before = {...base, binding:{...base.binding, source_snapshot_id:'reading-before'}, function_walkthroughs:[first, second]};
  const after = {...before, result_id:'new-reading', binding:{...base.binding, source_snapshot_id:'reading-after'},
    function_walkthroughs:[first, {...second, steps:[{...step, text:'采样备用通道'}]}]};
  const diff = computeWalkthroughDiff({feature_id:'poll', scenario_id:'poll-scenario', feature_label:'轮询', before, after, ...context});
  assert.deepEqual(diff.paths.map(path => path.steps[0].status), ['unchanged', 'modified']);
  const snapshot = {...hud(), walkthrough_diffs:[diff]};
  const current = task([source]);
  const view = buildTaskEvolutionView(current, snapshot, context);
  const flows = view.features.filter(flow => flow.mode === 'walkthrough_diff');
  assert.deepEqual(flows.map(flow => [flow.id, flow.feature_label, flow.steps[0].status]), [
    ['diff:poll-scenario:' + diff.paths[1].path_key, '轮询 · 备用分支', 'modified'],
    ['diff:poll-scenario:' + diff.paths[0].path_key, '轮询 · 默认分支', 'unchanged'],
  ]);
  assert.equal(view.features[view.active_feature_index], flows[0]);
  for (const flow of flows) {
    assert.deepEqual([flow.before_snapshot_id, flow.after_snapshot_id], ['reading-before', 'reading-after']);
  }
  const pending = buildTaskEvolutionView({...current, changes_status:'needs_review'}, snapshot, context);
  assert.deepEqual(pending.features.map(flow => flow.mode), ['empty']);
});

test('empty scoped review bypasses the model and returns no_diff', async () => {
  const baseline = state('before');
  const options: Parameters<typeof reviewDevelopmentDiff>[0] = {
    task:task([]), writeScope:[], workspace:'.', verificationSummary:'', preferences:{model:'test', reasoning_effort:'low'},
    context:{code_state:baseline} as Parameters<typeof reviewDevelopmentDiff>[0]['context'],
    profile:{path:'unused'} as Parameters<typeof reviewDevelopmentDiff>[0]['profile'],
  };
  assert.deepEqual(await reviewDevelopmentDiff(options, () => assert.fail('no reviewer should run')),
    {verdict:'no_diff',summary:'批准范围内无代码差异，无需审查。',blocking_issues:[],notes:[]});
});

test('actual drift, verification and inferred blockers remain distinct from AST caller evidence', async () => {
  const files = {[source]:'function poll() {\n  sample(1);\n}', [api]:'function sample(id: number) { return id; }'};
  const context = await indexes(files, {...files, [api]:'function sample(id: string) { return id; }'});
  const planned = [api,'tests/sample.ts'], changed = [api,'notes.md'];
  const snapshot = hud();
  snapshot.impact.related_constraints = [{entry_id:'constraint', category:'rule', key:'采集约束', excerpt:'保留输入契约'}];
  snapshot.structure_diff = computeStructureDiff(context.beforeIndex, context.afterIndex, planned, changed);
  const current = task(changed, {scope:['superseded.ts'], approval:{reviewed_version:1, scope:planned},
    requirement_package:{assumptions:['输入已校验'], behaviors:[{id:'b', behavior:'更新采样', design:'更改参数',
      files:[api], step_ids:[], verification:'运行检查'}]},
    unresolved:[api + '：缺少输入校验；修复要求：拒绝空输入'],
    verification_status:'passed', verification:[{evidence_id:'check',command:'tsc',cwd:'.',code_state:state('after'),
      origin:'observed', outcome:'passed', exit_code:0, created_at:'now', log_path:'tsc.log', note:'静态检查通过，设备验证待执行'}]});
  current.changes[0].ownership = 'preexisting_overlap';
  const view = buildTaskEvolutionView(current, snapshot, context);
  assert.equal(view.mode, 'task_actual');
  assert.deepEqual([view.base_snapshot_id, view.target_snapshot_id], ['before', 'after']);
  assert.deepEqual(view.drift, {planned_count:2, actual_count:2, matched_files:[api], untouched_planned_files:['tests/sample.ts'],
    out_of_scope_files:['notes.md'], overlap_files:[api], attribution_pending:false});
  assert.deepEqual(view.approach.map(s => [s.title, s.detail, s.files]), [['更新采样','更改参数',[api]]]);
  assert.deepEqual(view.assumptions.map(s => [s.source,s.text,s.file,s.fix]), [
    ['requirement_package','输入已校验',undefined,undefined], ['review_blocker','缺少输入校验',api,'拒绝空输入']]);
  assert.deepEqual(view.side_effects.filter(s => s.category === 'review_blocker').map(s => [s.evidence_kind,s.file,s.fix]),
    [['ai_inferred',api,'拒绝空输入']]);
  assert.deepEqual(view.side_effects.filter(s => s.category === 'contract_break')
    .map(s => [s.evidence_kind,s.file,s.line,s.target_file,s.target_line]), [['ast_proved',source,2,api,1]]);
  assert.equal(view.architecture.modules.find(m => m.files.includes(source))?.relation, 'edge_impacted');
  assert.equal(view.side_effects.find(s => s.category === 'constraint')?.evidence_kind, 'ai_inferred');
  assert.equal(view.verification_badge?.tone, 'warn');
  assert.equal(view.verification_badge?.label, '部分已验 · 含待执行项');
  const structured = buildTaskEvolutionView({...current, unresolved:[], diff_review:{verdict:'needs_fix', summary:'需修复',
    blocking_issues:[{file:api, issue:'缺少输入校验', fix:'拒绝空输入'}]}}, snapshot, context);
  assert.deepEqual(structured.assumptions, view.assumptions);
  assert.deepEqual(structured.side_effects, view.side_effects);
  const blueprint = buildTaskEvolutionView({...current,end_state:undefined,changes:[]}, hud(), {beforeIndex:context.beforeIndex});
  assert.equal(blueprint.mode, 'task_blueprint');
  assert.equal(blueprint.drift, undefined);
  assert.deepEqual(blueprint.changed_files, []);
});

test('pending attribution projects only planned scope even when prior delivery evidence is present', async () => {
  const files = {[source]:'function poll() {}', [api]:'function sample(id: number) { return id; }'};
  const context = await indexes(files, {...files, [source]:'function poll() { sample(1); }'});
  const current = task([source, 'notes.md'], {scope:[api], changes_status:'needs_review', diff_baseline:state('retry-base')});
  current.changes[0].ownership = 'preexisting_overlap';
  const snapshot = hud();
  snapshot.structure_diff = computeStructureDiff(context.beforeIndex, context.afterIndex, [api], [source]);
  const view = buildTaskEvolutionView(current, snapshot, context);
  assert.equal(view.mode, 'task_blueprint');
  assert.deepEqual([view.base_snapshot_id, view.target_snapshot_id], ['retry-base', undefined]);
  assert.deepEqual(view.changed_files, []);
  assert.deepEqual(view.architecture.modules.flatMap(module => module.changed_files), [api]);
  assert.deepEqual(view.architecture.edges, []);
  assert.deepEqual(view.side_effects, []);
  assert.deepEqual(view.features.map(flow => flow.mode), ['empty']);
  assert.deepEqual(view.drift, {planned_count:1, actual_count:0, matched_files:[], untouched_planned_files:[api],
    out_of_scope_files:[], overlap_files:[], attribution_pending:true});
});
