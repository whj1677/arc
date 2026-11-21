import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test, type TestContext} from 'node:test';
import {ArcService} from '../src/main/service';
import {ArcMcpBridge} from '../src/main/mcp-bridge';
import {approvedRequirement} from '../src/task-boundaries';
import {computeAstCallGraphDiff, computeStructureDiff, computeWalkthroughDiff} from '../src/development-hud';
import type {CodeCall, CodeIndex, CodeSymbol} from '../src/main/code-index';
import type {AnalysisResult, Explanation, Run, Scenario, Snapshot} from '../src/shared';

function symbol(name: string, file = `src/${name}.ts`, line = 1, signature = `function ${name}()`): CodeSymbol {
  return {
    id: `${file}:${line}:${name}`, file, name, qualified_name: name, kind: 'function',
    start_line: line, end_line: line + 1, signature, public_entry: true, has_body: true, language: 'typescript',
  };
}

function call(caller: CodeSymbol, target: CodeSymbol, line = caller.start_line + 1): CodeCall {
  return {
    caller_id: caller.id, file: caller.file, line, callee_name: target.name,
    target_ids: [target.id], qualifier: '', syntax: 'direct',
  };
}

function index(symbols: CodeSymbol[], calls: CodeCall[] = []): CodeIndex {
  return {
    schema_version: 4, snapshot_id: 'fixture', fingerprint: 'fixture', files: [...new Set(symbols.map(s => s.file))],
    symbols, calls, modules: [], module_edges: [], shared_states: [], parse_errors: [],
  };
}

test('local AST call graph compares callable changes and prioritizes external contract risks', () => {
  const file = 'api/service.ts';
  const oldApi = symbol('submit', file, 1, 'submit(value: string)');
  const newApi = symbol('submit', file, 1, 'submit(value: number)');
  const sibling = symbol('helper', file, 4);
  const retired = symbol('retired', file, 7);
  const enabled = symbol('enabled', 'jobs/worker.ts');
  const client = symbol('consume'), removedClient = symbol('legacy'), newCallee = symbol('notify');
  const ordinary = Array.from({length: 9}, (_, i) => symbol(`utility${i}`));
  const unrelated = symbol('otherCandidate');
  const type = {...symbol('Config', file, 13), kind: 'interface' as const};
  const beforeIndex = index([oldApi, sibling, retired, client, removedClient, unrelated, ...ordinary], [
    ...ordinary.map(target => call(oldApi, target)), call(ordinary[0], ordinary[1]),
    call(oldApi, sibling, 3), call(oldApi, sibling, 2), call(oldApi, retired), call(client, oldApi),
    {...call(removedClient, retired), target_ids: [retired.id, unrelated.id]},
  ]);
  const afterIndex = index([newApi, sibling, enabled, client, removedClient, newCallee, unrelated, type, ...ordinary], [
    ...ordinary.map(target => call(newApi, target)), call(ordinary[0], ordinary[1]),
    call(newApi, sibling), call(newApi, enabled), call(newApi, newCallee),
    call(client, newApi),
  ]);
  const options = {
    beforeIndex, afterIndex, beforeSnapshotId: 'before', afterSnapshotId: 'after', changedFiles: ['api\\service.ts', enabled.file],
    beforeSources: new Map([[file, 'function submit(value: string) {\n  return helper() + retired(); }\n\nfunction helper() {\n  return 1; } // old comment']]),
    afterSources: new Map([[file, 'function submit(value: number) {\n  return helper() + enabled(); }\n\nfunction  helper() {\n  return 1; } // new comment']]),
  };
  const diff = computeAstCallGraphDiff(options)!;
  assert.deepEqual([diff.before_snapshot_id, diff.after_snapshot_id], ['before', 'after']);
  assert.equal(diff.omitted_changes, 0);
  assert.equal(diff.omitted_neighbors, 4);
  assert.equal(diff.path.label, '本地 AST 调用图');
  assert.equal(diff.path.entry_symbol, client.name);
  assert.deepEqual(diff.path.steps, []);
  const nodes = new Map(diff.path.participants.map(node => [node.symbol, node]));
  assert.deepEqual([...nodes.values()].filter(node => node.code_changed).map(node => [node.symbol, node.status]), [
    ['submit', 'modified'], ['retired', 'removed'], ['enabled', 'added'],
  ]);
  assert.equal(nodes.get('helper')?.status, 'unchanged');
  assert.equal(nodes.get('submit')?.before_signature, oldApi.signature);
  assert.equal(nodes.get('submit')?.after_signature, newApi.signature);
  assert.equal(nodes.get('Config'), undefined);
  assert.equal(nodes.get(unrelated.name), undefined);
  const external = diff.path.participants.filter(node => node.file !== file && node.file !== enabled.file);
  assert.equal(external.length, 8);
  assert.deepEqual(external.slice(0, 3).map(node => node.symbol), [client.name, removedClient.name, newCallee.name]);
  assert.ok(external.every(node => node.status === 'unchanged'));
  const edge = (from: CodeSymbol, to: CodeSymbol) => diff.path.edges.find(edge =>
    edge.from_key === `${from.file}::${from.qualified_name}` && edge.to_key === `${to.file}::${to.qualified_name}`);
  assert.equal(edge(client, newApi)?.after_label, '未同步调用');
  assert.equal(edge(client, newApi)?.ast_confirmed, true);
  assert.equal(edge(removedClient, retired)?.before_label, '候选未同步调用');
  assert.equal(edge(removedClient, retired)?.ast_confirmed, false);
  assert.equal(edge(oldApi, retired)?.before_label, '移除调用');
  assert.equal(edge(newApi, enabled)?.after_label, '跨文件新增');
  assert.equal(edge(newApi, sibling)?.after_label, '调用');
  assert.equal(edge(ordinary[0], ordinary[1])?.after_label, '跨文件调用');
  assert.equal(new Set(diff.path.edges.map(edge => edge.key)).size, diff.path.edges.length);
  assert.ok(diff.path.edges.every(edge => edge.kind === 'sync_call'));
  assert.deepEqual(diff.path.counts, {
    added_nodes: 1, removed_nodes: 1, modified_nodes: 1, added_edges: 2, removed_edges: 2,
    added_steps: 0, removed_steps: 0, modified_steps: 0, noise_count: 0,
  });

  assert.equal(computeAstCallGraphDiff({...options, changedFiles: []}), undefined);
  const commentOnly = {...options, beforeIndex: index([sibling]), afterIndex: index([sibling, type])};
  assert.equal(computeAstCallGraphDiff(commentOnly), undefined);
  const edited = computeAstCallGraphDiff({...commentOnly,
    afterSources: new Map([[file, options.afterSources.get(file)!.replace('return 1;', 'return 2;')]]),
  });
  assert.equal(edited?.path.participants[0].status, 'modified');
});

test('local AST call graph aligns C++ overloads and routes calls to the edited definition', () => {
  const file = 'api/score.cpp';
  const first = {...symbol('score', file, 1, 'int score(int value)'), language: 'cpp' as const};
  const second = {...symbol('score', file, 3, 'int score(double value)'), language: 'cpp' as const};
  const next = {...second, signature: 'int  score(double value)'};
  const caller = {...symbol('consume', 'app/client.cpp'), language: 'cpp' as const};
  const beforeSource = 'int score(int value) {\n  return 1; }\nint score(double value) {\n  return 2; }';
  const options = {
    beforeIndex: index([first, second, caller], [call(caller, first), call(caller, second)]),
    afterIndex: index([first, next, caller], [call(caller, first), call(caller, next)]),
    beforeSnapshotId: 'before', afterSnapshotId: 'after', changedFiles: [file],
    beforeSources: new Map([[file, beforeSource]]),
    afterSources: new Map([[file, beforeSource.replace('return 2;', 'return 3;')]]),
  };
  const firstKey = `${file}::score::int score(int value)`;
  const secondKey = `${file}::score::int score(double value)`;
  const diff = computeAstCallGraphDiff(options)!;
  assert.deepEqual(diff.path.participants.filter(node => node.code_changed).map(node => [node.key, node.status]), [
    [secondKey, 'modified'],
  ]);
  assert.deepEqual(diff.path.edges.map(edge => [edge.to_key, edge.status]), [[secondKey, 'unchanged']]);

  const addedOverload = computeAstCallGraphDiff({...options,
    beforeIndex: index([second, caller], [call(caller, second)]),
  })!;
  assert.deepEqual(addedOverload.path.participants.filter(node => node.code_changed).map(node => [node.key, node.status]), [
    [firstKey, 'added'], [secondKey, 'modified'],
  ]);
  assert.deepEqual(addedOverload.path.edges.map(edge => [edge.to_key, edge.status]), [
    [secondKey, 'unchanged'], [firstKey, 'added'],
  ]);
});

test('local AST call graph preserves Python indentation and ignores comments and blank lines', () => {
  const file = 'jobs/worker.py';
  const worker = {...symbol('work', file, 1, 'def work():'), language: 'python' as const, end_line: 4};
  const next = {...worker, end_line: 6};
  const commented = 'def work():\n    if enabled: # condition\n\n        # explain\n        log("# started")  \n    finish()';
  const options = {
    beforeIndex: index([worker]), afterIndex: index([next]),
    beforeSnapshotId: 'before', afterSnapshotId: 'after', changedFiles: [file],
    beforeSources: new Map([[file, 'def work():\n    if enabled:\n        log("# started")\n    finish()']]),
    afterSources: new Map([[file, commented]]),
  };
  assert.equal(computeAstCallGraphDiff(options), undefined);
  const diff = computeAstCallGraphDiff({...options,
    afterSources: new Map([[file, commented.replace('        log', '    log')]]),
  })!;
  assert.equal(diff.path.participants[0].status, 'modified');
});

test('local AST call graph distinguishes callback references from direct calls and candidate risks', () => {
  const old = symbol('handle', 'api/handler.ts', 1, 'handle(value: string)');
  const next = {...old, signature: 'handle(value: number)'};
  const local = symbol('local', old.file, 4);
  const cross = symbol('cross');
  const registered = symbol('registered'), added = symbol('added'), removed = symbol('removed');
  const mixed = symbol('mixed'), candidate = symbol('candidate'), candidateRef = symbol('candidateRef');
  const switched = symbol('switched');
  const other = symbol('other');
  const reference = (from: CodeSymbol, to: CodeSymbol): CodeCall => ({...call(from, to), syntax: 'reference'});
  const ambiguous = (edge: CodeCall): CodeCall => ({...edge, target_ids: [...edge.target_ids, other.id]});
  const surrounding = [local, cross, registered, added, removed, mixed, candidate, candidateRef, switched, other];
  const edges = (target: CodeSymbol) => [
    reference(target, local), reference(target, cross), reference(registered, target),
    reference(mixed, target), ambiguous(call(mixed, target)), call(mixed, target, 3),
    ambiguous(call(candidate, target)), ambiguous(reference(candidateRef, target)),
  ];
  const source = (target: CodeSymbol) => `${target.signature} {\n  return value; }\n\nfunction local() {\n  return 1; }`;
  const diff = computeAstCallGraphDiff({
    beforeIndex: index([old, ...surrounding], [...edges(old), reference(removed, old), call(switched, old)]),
    afterIndex: index([next, ...surrounding], [...edges(next), reference(added, next), reference(switched, next)]),
    beforeSnapshotId: 'before', afterSnapshotId: 'after', changedFiles: [old.file],
    beforeSources: new Map([[old.file, source(old)]]), afterSources: new Map([[next.file, source(next)]]),
  })!;
  const key = (target: CodeSymbol) => `${target.file}::${target.qualified_name}`;
  const pair = (from: CodeSymbol, to: CodeSymbol) => diff.path.edges.filter(edge =>
    edge.from_key === key(from) && edge.to_key === key(to),
  ).map(edge => [edge.kind, edge.status, edge.after_label ?? edge.before_label, edge.ast_confirmed]);
  assert.deepEqual(pair(next, local), [['reference', 'unchanged', '回调引用', true]]);
  assert.deepEqual(pair(next, cross), [['reference', 'unchanged', '跨文件回调引用', true]]);
  assert.deepEqual(pair(registered, next), [['reference', 'unchanged', '未同步回调引用', true]]);
  assert.deepEqual(pair(added, next), [['reference', 'added', '新增回调引用', true]]);
  assert.deepEqual(pair(removed, old), [['reference', 'removed', '移除回调引用', true]]);
  assert.deepEqual(pair(mixed, next), [['sync_call', 'unchanged', '未同步调用', true]]);
  assert.deepEqual(pair(candidate, next), [['sync_call', 'unchanged', '候选未同步调用', false]]);
  assert.deepEqual(pair(candidateRef, next), [['reference', 'unchanged', '候选未同步回调引用', false]]);
  assert.deepEqual(pair(switched, next), [
    ['sync_call', 'removed', '跨文件移除', true], ['reference', 'added', '新增回调引用', true],
  ]);
});

test('local AST call graph caps seeds and unchanged internal participants', () => {
  const file = 'api/service.ts';
  const bodyChanges = Array.from({length: 14}, (_, i) => symbol(`changed${i}`));
  const siblings = Array.from({length: 7}, (_, i) => symbol(`helper${i}`, file, 3 + 2 * i));
  const old = symbol('submit', file, 1, 'submit(value: string)');
  const next = symbol('submit', file, 1, 'submit(value: number)');
  const siblingSource = siblings.map(({name}) => `function ${name}() {\n  return 1; }`).join('\n');
  const diff = computeAstCallGraphDiff({
    beforeIndex: index([...bodyChanges, ...siblings, old], siblings.map(target => call(old, target))),
    afterIndex: index([...bodyChanges, ...siblings, next], siblings.map(target => call(next, target))),
    beforeSnapshotId: 'before', afterSnapshotId: 'after', changedFiles: [file, ...bodyChanges.map(sym => sym.file)],
    beforeSources: new Map([[file, 'function submit(value: string) {\n  return 1; }\n' + siblingSource]]),
    afterSources: new Map([[file, 'function submit(value: number) {\n  return 1; }\n' + siblingSource]]),
  })!;
  assert.equal(diff.path.counts.modified_nodes, 14);
  assert.equal(diff.path.entry_symbol, 'submit');
  assert.equal(diff.path.participants.filter(node => node.status === 'unchanged').length, 6);
  assert.equal(diff.path.edges.length, 6);
  assert.equal(diff.omitted_changes, 1);
  assert.equal(diff.omitted_neighbors, 0);
});

test('structure diff aligns symbols and call edges across line drift and reports untouched callers of changed contracts', () => {
  const file = 'api/service.ts';
  const oldApi = symbol('submit', file, 1, 'submit(value: string)');
  const newApi = symbol('submit', file, 11, 'submit(value: number)');
  const oldHelper = symbol('helper', file, 4, 'function  helper()');
  const newHelper = symbol('helper', file, 14);
  const removed = {...symbol('retired', file, 7), public_entry: false};
  const added = symbol('enabled', file, 20);
  const client = symbol('consume', 'app/client.ts');
  const updated = symbol('migrate', 'jobs/migrate.ts');
  const before = index([oldApi, oldHelper, removed, client, updated], [
    call(client, oldApi, 8), call(client, removed, 10), call(updated, oldApi),
  ]);
  const after = index([newApi, newHelper, added, client, updated], [
    call(client, newApi, 8), call(updated, newApi), call(newApi, client, 12),
    {...call(newHelper, client), target_ids: []},
  ]);
  const diff = computeStructureDiff(before, after, [file], ['api\\service.ts', updated.file]);
  assert.deepEqual(diff.changed_files, [file, updated.file]);
  assert.deepEqual(diff.out_of_scope_files, [updated.file]);
  assert.deepEqual(diff.added_symbols.map(s => s.symbol), ['enabled']);
  assert.deepEqual(diff.removed_symbols.map(s => s.symbol), ['retired']);
  assert.deepEqual(diff.signature_changed_symbols.map(s => s.symbol), ['submit']);
  const contract = diff.signature_changed_symbols[0];
  assert.equal(contract.public_entry, true);
  assert.equal(contract.before_signature, oldApi.signature);
  assert.equal(contract.after_signature, newApi.signature);
  assert.deepEqual(contract.unupdated_external_callers, [{
    caller_symbol: client.name, caller_file: client.file, caller_line: 8,
    target_symbol: newApi.name, target_file: file, target_line: 11,
  }]);
  assert.equal(diff.removed_symbols[0].unupdated_external_callers?.[0].caller_line, 10);
  assert.deepEqual(diff.added_calls.map(c => [c.caller_symbol, c.callee_symbol, c.caller_line]), [['submit', 'consume', 12]]);
  assert.deepEqual(diff.removed_calls.map(c => [c.caller_symbol, c.callee_symbol]), [['consume', 'retired']]);
});

test('module cycles require a new edge; increased weights and pre-existing cycles stay distinct', () => {
  const before = index([]), after = index([]);
  const ab = {from: 'a', to: 'b', count: 1}, ba = {from: 'b', to: 'a', count: 1};
  before.module_edges = [ab, ba, {from: 'a', to: 'retired', count: 2}];
  after.module_edges = [{...ab, count: 2}, ba, {from: 'b', to: 'c', count: 1}, {from: 'c', to: 'a', count: 1}];
  const state = {file: 'a/state.cpp', name: 'pending', line: 2, access_dirs: ['a', 'retired']};
  before.shared_states = [state];
  after.shared_states = [{...state, line: 9, access_dirs: ['a', 'b', 'c']}];
  const diff = computeStructureDiff(before, after, [], ['a/state.cpp', 'b/use.cpp', 'c/use.cpp']);
  assert.deepEqual(diff.added_module_edges.map(e => [e.from, e.to, e.before_count, e.after_count]), [
    ['a', 'b', 1, 2], ['b', 'c', 0, 1], ['c', 'a', 0, 1],
  ]);
  assert.deepEqual(diff.removed_module_edges, [{from: 'a', to: 'retired', before_count: 2, after_count: 0}]);
  assert.equal(diff.new_cycles.length, 1);
  const [cycle] = diff.new_cycles;
  assert.equal(cycle[0], cycle.at(-1));
  assert.deepEqual(cycle.slice(0, -1).sort(), ['a', 'b', 'c']);
  assert.deepEqual(diff.shared_state_changes, [{
    name: 'pending', file: 'a/state.cpp', added_dirs: ['b', 'c'], removed_dirs: ['retired'],
  }]);
});

test('structure diff reports only task-related calls, cycles and shared state with no declared scope', () => {
  const app = symbol('app', 'owned/app.ts');
  const a = symbol('a', 'outside/a/helper.ts'), b = symbol('b', 'outside/b/helper.ts');
  const before = index([app, a, b], [call(b, a)]);
  const after = index([app, a, b], [call(a, b), call(app, a)]);
  before.module_edges = [{from: 'outside/b', to: 'outside/a', count: 1}];
  after.module_edges = [
    ...before.module_edges, {from: 'outside/a', to: 'outside/b', count: 1},
    {from: 'owned', to: 'outside/a', count: 1},
  ];
  before.shared_states = [{name: 'related', file: a.file, line: 1, access_dirs: ['outside/b']}];
  after.shared_states = [
    {...before.shared_states[0], access_dirs: ['owned', 'outside/a']},
    {name: 'unrelated', file: b.file, line: 1, access_dirs: ['outside/a', 'outside/b']},
  ];
  const diff = computeStructureDiff(before, after, [], [app.file]);
  assert.equal(diff.scope_declared, false);
  assert.deepEqual(diff.out_of_scope_files, []);
  assert.deepEqual(diff.added_calls.map(c => [c.caller_file, c.callee_file]), [[app.file, a.file]]);
  assert.deepEqual(diff.removed_calls, []);
  assert.deepEqual(diff.added_module_edges.map(edge => [edge.from, edge.to]), [['owned', 'outside/a']]);
  assert.deepEqual(diff.new_cycles, []);
  assert.deepEqual(diff.shared_state_changes, [
    {name: 'related', file: a.file, added_dirs: ['owned'], removed_dirs: []},
  ]);
});

const base = JSON.parse(readFileSync('examples/analysis-result.json', 'utf8')) as AnalysisResult;
type Action = {to: string; condition?: string; text?: string; kind?: 'call' | 'dispatch'};

function walkthrough(version: string, actions: Action[]): AnalysisResult {
  const id = (name: string) => version + '-' + name;
  const names = [...new Set(['entry', ...actions.map(a => a.to)])];
  const nodes = names.map(name => ({
    ...base.nodes[0], kind: 'function' as const, label: name, node_id: id(name),
    evidence_ids: [id('def-' + name)],
    function_details: {symbol: name, signature: `function ${name}()`, definition_evidence_id: id('def-' + name),
      return_io_ids: [], parameter_io_ids: []},
  }));
  const steps = [{to: 'entry'}, ...actions].map((action: Action, i) => ({
    id: id('step-' + i), kind: i === 0 ? 'entry' as const : action.kind ?? 'call' as const,
    from_node_id: i === 0 ? null : id('entry'), to_node_id: id(action.to), input: '', output: '',
    condition: action.condition ?? '', text: action.text ?? action.to, evidence_ids: [id('def-' + action.to)],
  }));
  return {
    ...base, result_id: id('result'), binding: {...base.binding, source_snapshot_id: id('snapshot')}, nodes,
    evidence: names.map(name => ({...base.evidence[0], evidence_id: id('def-' + name), role: 'definition',
      path: symbol(name).file, line_start: 1, line_end: 2, source_snapshot_id: id('snapshot')})),
    edges: names.slice(1).map(name => ({
      ...base.edges[0], edge_id: id('call-' + name),
      kind: actions.some(a => a.to === name && a.kind === 'dispatch') ? 'execution_boundary' : 'sync_call', source_node_id: id('entry'),
      target_node_id: id(name), evidence_ids: [id('def-' + name)],
    })),
    function_walkthroughs: [{id: id('path'), label: '提交流程', trigger: '提交', entry_node_id: id('entry'),
      boundary: '', evidence_ids: [id('def-entry')], steps}],
  };
}

function snapshot(result: AnalysisResult, hashes: Record<string, string>): Snapshot {
  return {
    source_snapshot_id: result.binding.source_snapshot_id, project_id: result.binding.project_id, captured_at: '',
    root_path: '', files: Object.entries(hashes).map(([name, hash]) => ({
      path: symbol(name).file, content_sha256: hash, bytes: 10, line_count: 2, encoding: 'utf8',
    })),
    excluded: [], fingerprint: result.result_id, commit: null, dirty: null, build_config: '', consistency: 'verified',
  };
}

const feature = {feature_id: 'submit', feature_label: '提交', scenario_id: 'submit.overview'};

test('walkthrough editor lines track their own snapshot and exclude callsite evidence', () => {
  const before = walkthrough('old', [{to: 'save'}]);
  const generated = walkthrough('new', [{to: 'save'}]);
  const after: AnalysisResult = {...generated, evidence: generated.evidence.map(item => item.evidence_id === 'new-def-save'
    ? {...item, role: 'callsite', line_start: 10, line_end: 10}
    : {...item, line_start: 6, line_end: 7})};
  const [walk] = computeWalkthroughDiff({...feature, before, after,
    beforeSnapshot: snapshot(before, {entry: 'old-entry', save: 'old-save'}),
    afterSnapshot: snapshot(after, {entry: 'new-entry', save: 'new-save'}),
  }).paths;
  assert.deepEqual(walk.participants.map(node => [node.symbol, node.before_editor_line, node.after_editor_line]), [
    ['entry', 1, 6], ['save', 1, undefined],
  ]);
  assert.equal(walk.participants.find(node => node.symbol === 'save')?.after_line, 10);
});

test('walkthrough aligns regenerated IDs and uses LCS through inserted and deleted steps and repeated calls', () => {
  const before = walkthrough('old', [{to: 'validate'}, {to: 'obsolete'}, {to: 'save', condition: 'ready'}, {to: 'validate'}]);
  const after = walkthrough('new', [{to: 'validate'}, {to: 'save', condition: 'approved'}, {to: 'notify'}, {to: 'validate'}]);
  const oldHashes = {entry: 'same', validate: 'same', obsolete: 'old', save: 'same'};
  const newHashes = {entry: 'same', validate: 'same', notify: 'new', save: 'same'};
  const diff = computeWalkthroughDiff({...feature, before, after,
    beforeSnapshot: snapshot(before, oldHashes), afterSnapshot: snapshot(after, newHashes)});
  assert.equal(diff.paths.length, 1);
  const [path] = diff.paths;
  assert.equal(path.before_path_id, 'old-path');
  assert.equal(path.after_path_id, 'new-path');
  assert.equal(path.status, 'modified');
  assert.deepEqual(path.steps.filter(s => s.status === 'added').map(s => s.to_symbol), ['notify']);
  assert.deepEqual(path.steps.filter(s => s.status === 'removed').map(s => s.to_symbol), ['obsolete']);
  assert.deepEqual(path.steps.filter(s => s.status === 'modified').map(s => [s.to_symbol, s.diff_reasons]), [['save', ['condition']]]);
  assert.deepEqual(path.steps.filter(s => s.status === 'unchanged').map(s => s.to_symbol), ['entry', 'validate', 'validate']);
  const aligned = path.participants.find(n => n.symbol === 'validate')!;
  assert.equal(aligned.key, 'src/validate.ts::validate');
  assert.equal(aligned.before_node_id, 'old-validate');
  assert.equal(aligned.after_node_id, 'new-validate');
  assert.deepEqual(path.counts, {
    added_nodes: 1, removed_nodes: 1, modified_nodes: 0, added_edges: 1, removed_edges: 1,
    added_steps: 1, removed_steps: 1, modified_steps: 1, noise_count: 0,
  });
});

test('unchanged SHAs and AST calls isolate extra walkthrough detail and rewritten wording in noise_count', () => {
  const before = walkthrough('old', [{to: 'save', text: '保存'}]);
  const after = walkthrough('new', [{to: 'save', text: '写入记录'}, {to: 'audit'}]);
  const entry = symbol('entry'), save = symbol('save'), audit = symbol('audit');
  const unchangedIndex = index([entry, save, audit], [call(entry, save), call(entry, audit)]);
  const hashes = {entry: 'same-entry', save: 'same-save', audit: 'same-audit'};
  const [path] = computeWalkthroughDiff({...feature, before, after,
    beforeSnapshot: snapshot(before, hashes), afterSnapshot: snapshot(after, hashes),
    beforeIndex: unchangedIndex, afterIndex: unchangedIndex,
  }).paths;
  assert.deepEqual(path.participants.map(n => [n.symbol, n.status, n.code_changed]), [
    ['entry', 'unchanged', false], ['save', 'unchanged', false], ['audit', 'noise', false],
  ]);
  assert.equal(path.edges.find(e => e.to_key === 'src/audit.ts::audit')?.status, 'noise');
  assert.deepEqual(path.steps.map(s => [s.to_symbol, s.status]), [['entry', 'unchanged'], ['save', 'noise'], ['audit', 'noise']]);
  assert.deepEqual(path.counts, {
    added_nodes: 0, removed_nodes: 0, modified_nodes: 0, added_edges: 0, removed_edges: 0,
    added_steps: 0, removed_steps: 0, modified_steps: 0, noise_count: 4,
  });

  // A previously unresolved call can become resolvable even when both endpoint files have identical bytes.
  const unresolved = {...call(entry, audit), target_ids: []};
  const [resolved] = computeWalkthroughDiff({...feature, before, after,
    beforeSnapshot: snapshot(before, hashes), afterSnapshot: snapshot(after, hashes),
    beforeIndex: index([entry, save, audit], [call(entry, save), unresolved]), afterIndex: unchangedIndex,
  }).paths;
  const edge = resolved.edges.find(e => e.to_key === 'src/audit.ts::audit')!;
  assert.equal(edge.ast_confirmed, true);
  assert.equal(edge.status, 'added');
  assert.equal(resolved.steps.find(s => s.to_symbol === 'audit')?.status, 'added');
});

test('a single changed dispatch kind between LCS anchors remains a semantic modification', () => {
  const before = walkthrough('old', [{to: 'send'}, {to: 'finish'}]);
  const after = walkthrough('new', [{to: 'send', kind: 'dispatch'}, {to: 'finish'}]);
  const hashes = {entry: 'a', send: 'b', finish: 'c'};
  const [path] = computeWalkthroughDiff({...feature, before, after,
    beforeSnapshot: snapshot(before, hashes), afterSnapshot: snapshot(after, hashes)}).paths;
  const step = path.steps[1];
  assert.deepEqual([step.status, step.kind, step.diff_reasons, step.code_changed], ['modified', 'dispatch', ['kind'], false]);
  assert.deepEqual([path.counts.added_steps, path.counts.removed_steps, path.counts.modified_steps], [0, 0, 1]);
});

test('walkthrough compares aligned function bodies and keeps regenerated step IDs', () => {
  const before = walkthrough('old', [{to: 'save', text: '保存'}]);
  const after = walkthrough('new', [{to: 'save', text: '写入记录'}]);
  const entry = {...symbol('entry'), qualified_name: 'Reader.entry', end_line: 3};
  const original = [
    'function entry() {',
    '  return "/* keep */" + \'// a  b\';',
    '}',
    'function sibling() { return 1; }',
  ].join('\n');
  for (const [source, endLine, nodeStatus, stepStatus] of [
    [original.replace('  return', '  /* inserted */\n  return').replace(';', '; // note'), 4, 'unchanged', 'noise'],
    [original.replace('return 1', 'return 2'), 3, 'unchanged', 'noise'],
    [original.replace('a  b', 'a b'), 3, 'modified', 'modified'],
  ] as const) {
    const [path] = computeWalkthroughDiff({...feature, before, after,
      beforeSnapshot: snapshot(before, {entry: 'old', save: 'same'}),
      afterSnapshot: snapshot(after, {entry: 'new', save: 'same'}),
      beforeIndex: index([entry]), afterIndex: index([{...entry, end_line: endLine}]),
      beforeSources: new Map([[entry.file, original]]), afterSources: new Map([[entry.file, source]]),
    }).paths;
    assert.equal(path.participants[0].status, nodeStatus);
    assert.deepEqual([path.steps[1].status, path.steps[1].before_step_id, path.steps[1].after_step_id],
      [stepStatus, 'old-step-1', 'new-step-1']);
  }
});

const header = 'core/measure.h', client = 'client/read.c';

function saveWalkthrough(service: ArcService, scene: Scenario, snapshot: Snapshot, id: string, created: string,
    {runId, graph = true}: {runId?: string; graph?: boolean} = {}) {
  const evidence = [client, header].map((file, i) => ({
    evidence_id: 'ref' + i, path: file, line_start: 2, line_end: 2,
    source_snapshot_id: snapshot.source_snapshot_id,
    content_sha256: snapshot.files.find(f => f.path === file)!.content_sha256,
  }));
  const nodes = ['consumer', 'sample'].map((symbol, i) => ({
    node_id: id + symbol, kind: 'function', label: symbol, description: symbol,
    evidence_ids: [evidence[i].evidence_id],
  }));
  const [from, to] = nodes.map(n => n.node_id);
  const result = {
    result_id: id, fictional: false, binding: {
      project_id: scene.project_id, feature_id: scene.feature_id, scenario_id: scene.scenario_id,
      question_revision_id: scene.question_revision_id, source_snapshot_id: snapshot.source_snapshot_id, run_id: runId,
    },
    summary: {text: '读取测量值', claim_ids: []},
    nodes, evidence, edges: [{ edge_id: id + 'edge', kind: 'sync_call', status: 'source_supported',
      source_node_id: from, target_node_id: to, label: '调用测量' }],
    function_walkthroughs: graph ? [{ id, label: '读取', entry_node_id: from, steps: [{
      id, kind: 'call', from_node_id: from, to_node_id: to, text: '采样', condition: '', input: '', output: '测量值',
      evidence_ids: ['ref0'],
    }] }] : [],
  };
  service.store.put('explanation', id, { result_id: id, scenario_id: scene.scenario_id, created_at: created, result });
}

test('task HUD connects pre-change impact and saved walkthroughs to their own frozen indexes', async t => {
  const temp = path.resolve('.test-data');
  await fs.mkdir(temp, { recursive: true });
  const dir = await fs.mkdtemp(path.join(temp, 'hud-'));
  const root = path.join(dir, '工程');
  const original = 'int reading;\nint sample(void) { return reading; }\nint clean(void) { return 1; }\n';
  const files = {
    [header]: original,
    [client]: 'extern int reading;\nint consumer(void) { return sample() + reading; }\n',
    'tests/measure.c': 'int check(void) { return clean(); }\n',
  };
  for (const [file, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  }
  const service = new ArcService(path.join(dir, 'arc'), process.cwd());
  t.after(async () => {
    await service.shutdown();
    service.store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const project = await service.openProject(root);
  const { feature, scenario } = service.addFeature(project.project_id, '测量');
  const task = await service.engineering.createTask({
    project_id: project.project_id, goal: '调整测量', scope: [header], submission_key: 'hud-task',
  });
  const before = service.store.get<Snapshot>('snapshot', task.baseline.snapshot_id);
  const constraint = await service.engineering.saveEntry({
    project_id: project.project_id, expected_version: 0, submission_key: 'rule', category: 'rule',
    key: '保留单位', text: '测量返回毫伏。',
    sources: [{ path: header, snapshot_id: before.source_snapshot_id, line_start: 2, line_end: 2,
      content_sha256: before.files.find(f => f.path === header)!.content_sha256 }],
  }, 'user');
  const overview = service.overview(project.project_id);
  service.store.put('explanation', 'architecture', {
    result_id: 'architecture', scenario_id: overview.scenario_id, created_at: '2026-01-01',
    result: { result_id: 'architecture',
      binding: {project_id: project.project_id, source_snapshot_id: before.source_snapshot_id}, fictional: false,
      summary: {text: '测量与读取', claim_ids: []}, coverage: {covered_scope: [header], unresolved_scope: []},
      evidence: [{ evidence_id: 'ref', path: header, source_snapshot_id: before.source_snapshot_id,
        content_sha256: before.files.find(f => f.path === header)!.content_sha256, line_start: 2, line_end: 2 }],
      nodes: [
        { node_id: 'measure', kind: 'component', label: '测量', evidence_ids: ['ref'] },
        { node_id: 'read', kind: 'component', label: '客户端', evidence_ids: [] },
      ],
      architecture: { node_ids: ['measure', 'read'], edge_ids: ['depends'] },
      edges: [{ edge_id: 'depends', source_node_id: 'read', target_node_id: 'measure', label: '读取' }],
    },
  });
  saveWalkthrough(service, scenario, before, 'historical', '2010-01-01');
  saveWalkthrough(service, scenario, before, 'old', before.captured_at);
  const first = await service.taskHud(task.task_id);
  assert.deepEqual(first.impact.scope_files, [header]);
  assert.equal(first.impact.scope_declared, true);
  assert.equal(first.impact.architecture_result_id, 'architecture');
  assert.deepEqual(first.impact.external_callers.map(c => [c.caller_symbol, c.target_symbol]).sort(),
    [['check', 'clean'], ['consumer', 'sample']]);
  assert.deepEqual(first.impact.shared_states, [
    { name: 'reading', file: header, line: 1, access_dirs: ['client', 'core'], external_dirs: ['client'] },
  ]);
  assert.deepEqual(first.impact.architecture_nodes.map(n => [n.label, n.relation]), [['测量', 'direct'], ['客户端', 'neighbor']]);
  assert.deepEqual(first.impact.architecture_edges.map(e => [e.from_label, e.label, e.to_label]), [['客户端', '读取', '测量']]);
  assert.deepEqual(first.impact.untested_symbols, [{ symbol: 'sample', file: header, line: 2 }]);
  assert.deepEqual(first.impact.related_constraints, [{
    entry_id: constraint.entry_id, key: constraint.key, category: 'rule', excerpt: constraint.text,
  }]);
  assert.deepEqual(first.impacted_features.map(f => [f.feature_id, f.previous_result_id]), [[feature.feature_id, 'old']]);
  assert.equal(first.structure_diff, undefined);
  assert.deepEqual(first.walkthrough_diffs, []);

  // Several readings may already exist when a task ends without changing source.
  const noChanges = { ...task, task_id: 'unchanged-task', status: 'completed', end_state: task.baseline };
  service.store.put('engineering_task', noChanges.task_id, noChanges);
  const unchanged = await service.taskHud(noChanges.task_id);
  assert.equal(unchanged.impacted_features[0].refreshed_result_id, undefined);
  assert.deepEqual(unchanged.walkthrough_diffs, []);

  await fs.writeFile(path.join(root, header), original.replace('sample(void)', 'sample(int offset)').replace('return reading;', 'return reading + offset;'));
  const finished = await service.engineering.finishTask({
    task_id: task.task_id, expected_version: task.version, submission_key: 'done', status: 'completed',
  });
  const after = service.store.get<Snapshot>('snapshot', finished.end_state!.snapshot_id);
  const immediate = await service.taskHud(task.task_id);
  assert.deepEqual(immediate.walkthrough_diffs, []);
  const ast = immediate.ast_call_graph!;
  assert.deepEqual([ast.before_snapshot_id, ast.after_snapshot_id], [before.source_snapshot_id, after.source_snapshot_id]);
  assert.deepEqual(ast.path.participants.map(node => [node.symbol, node.status]), [['sample', 'modified'], ['consumer', 'unchanged']]);
  assert.equal(ast.path.edges[0].after_label, '未同步调用');

  const later = await service.engineering.createTask({
    project_id: project.project_id, goal: '再次调整测量', scope: [header], submission_key: 'hud-task-b',
  });
  await fs.writeFile(path.join(root, header), original.replace('return reading;', 'return reading * 2;'));
  const finishedLater = await service.engineering.finishTask({
    task_id: later.task_id, expected_version: later.version, submission_key: 'done-b', status: 'completed',
  });
  const laterSnapshot = service.store.get<Snapshot>('snapshot', finishedLater.end_state!.snapshot_id);
  assert.notEqual(laterSnapshot.fingerprint, after.fingerprint);
  saveWalkthrough(service, scenario, laterSnapshot, 'later-task', '2099-03-01');
  assert.equal((await service.taskHud(task.task_id)).impacted_features[0].refreshed_result_id, undefined);

  service.store.put('engineering_task', task.task_id, {...finished, execution_mode: 'mcp'});
  await service.refreshFeatureWalkthrough(task.task_id, scenario.scenario_id, 'hud-historical-refresh');
  const run = service.store.all<Run>('run').find(r => r.feature_refresh_task_id === task.task_id)!;
  assert.equal(run.binding.source_snapshot_id, finished.end_state!.snapshot_id);
  saveWalkthrough(service, scenario, after, 'refreshed', '2099-01-01', {runId: run.binding.run_id});
  // A baseline-bound reading can be published after the result for the end snapshot.
  saveWalkthrough(service, scenario, before, 'late-baseline', '2099-02-01');
  saveWalkthrough(service, scenario, after, 'unbound-end-snapshot', '2099-04-01');
  const completed = await service.taskHud(task.task_id);
  assert.deepEqual(completed.structure_diff!.changed_files, [header]);
  assert.equal(completed.structure_diff!.scope_declared, true);
  const [changed] = completed.structure_diff!.signature_changed_symbols;
  assert.equal(changed.symbol, 'sample');
  assert.deepEqual(changed.unupdated_external_callers?.map(c => [c.caller_file, c.caller_line]), [[client, 2]]);
  assert.equal(completed.walkthrough_diffs.length, 1);
  const [diff] = completed.walkthrough_diffs;
  assert.deepEqual([diff.before_result_id, diff.after_result_id], ['late-baseline', 'refreshed']);
  assert.deepEqual([diff.before_snapshot_id, diff.after_snapshot_id], [before.source_snapshot_id, after.source_snapshot_id]);
  assert.deepEqual(diff.paths[0].participants.map(n => [n.symbol, n.status]), [['consumer', 'unchanged'], ['sample', 'modified']]);

  const graphless = service.addFeature(project.project_id, '只有新走读有调用图').scenario;
  saveWalkthrough(service, graphless, before, 'graphless-before', task.created_at, {graph: false});
  saveWalkthrough(service, graphless, after, 'graph-after', '2099-01-01');
  service.store.put('engineering_task', task.task_id, {...finished, changes_status: 'needs_review'});
  const review = await service.taskHud(task.task_id);
  const featureWithoutGraph = review.impacted_features.find(f => f.scenario_id === graphless.scenario_id)!;
  assert.equal(featureWithoutGraph.previous_result_id, 'graphless-before');
  assert.equal(featureWithoutGraph.refreshed_result_id, 'graph-after');
  assert.equal(featureWithoutGraph.has_call_graph, false);
  assert.equal(review.walkthrough_diffs.some(diff => diff.scenario_id === graphless.scenario_id), false);
  assert.equal(review.structure_diff, undefined);
  assert.equal(review.ast_call_graph, undefined);
});

async function fixture(t: TestContext) {
  const temp = path.resolve('.test-data');
  await fs.mkdir(temp, {recursive: true});
  const directory = await fs.mkdtemp(path.join(temp, 'hud-refresh-'));
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.ts'), 'export function read() { return 1; }\n');
  const service = new ArcService(path.join(directory, 'data'), path.resolve('.'));
  const bridge = new ArcMcpBridge(service, path.resolve('.'));
  t.after(async () => {
    await bridge.close();
    await service.shutdown();
    service.store.close();
    await fs.rm(directory, {recursive: true, force: true});
  });
  const project = await service.openProject(root);
  return {service, bridge, project, root};
}

test('development_start approval validates notes atomically and includes them in the approved requirement', async t => {
  const {service, bridge, project} = await fixture(t);
  const input = {project_id: project.project_id, goal: '调整读取结果'};
  const task = await bridge.queueDevelopment({...input, submission_key: 'hud-plan'}, 'mcp');
  const attempt = service.engineering.startAttempt(task.task_id, {origin: 'agent', provider_id: 'codex', model: 'fixture'});
  const ready = await service.engineering.finishTask({
    task_id: task.task_id, expected_version: service.engineering.task(task.task_id).version,
    status: 'completed', submission_key: 'hud-ready', summary: '已核对读取函数', decisions: ['保留入口'],
    proposed_scope: ['main.ts'],
    steps: [{step_id: 'read', title: '读取', change: '调整返回值', status: 'pending', progress: '已定位读取函数',
      criteria: [{criterion_id: 'value', text: '返回目标值', evidence_ids: []}],
      evidence_ids: [], unresolved: [], created_at: '', updated_at: ''}],
    requirement_package: {behaviors: [{id: 'value', behavior: '返回目标值', design: '调整返回语句',
      files: ['main.ts'], step_ids: ['read'], verification: '读取返回值'}]},
  });
  service.engineering.updateAttempt(attempt.attempt_id, {status: 'completed'});
  const approval = {...input, task_id: task.task_id, expected_version: ready.version,
    submission_key: 'hud-approve', phase: 'execution', scope: ['main.ts']};
  for (const invalid of [[' '], ['x'.repeat(2001)], Array(21).fill('x'), [12]]) {
    await assert.rejects(bridge.queueDevelopment({...approval, notes: invalid}, 'mcp'), /2000|20/);
  }
  assert.equal(service.engineering.task(task.task_id).version, ready.version);
  const approved = await bridge.queueDevelopment({...approval, notes: [' 保留入口 ', ' 保留缓存 ', '保留缓存']}, 'mcp');
  assert.deepEqual(approved.decisions, ['保留入口', '保留缓存']);
  assert.deepEqual(approved.approval?.notes, approved.decisions);
  assert.deepEqual(approvedRequirement(service.engineering.task(task.task_id)).decisions, approved.decisions);
  service.engineering.startAttempt(task.task_id, {origin: 'agent', provider_id: 'codex', model: 'fixture', write_scope: ['main.ts']});
  const updated = service.engineering.updateTask({
    task_id: task.task_id, expected_version: service.engineering.task(task.task_id).version,
    submission_key: 'hud-update', decisions: [' 保留缓存 ', '执行说明', ' 执行说明 '],
  });
  assert.deepEqual(updated.decisions, ['保留入口', '保留缓存', '执行说明']);
  const finished = await service.engineering.finishTask({
    task_id: task.task_id, expected_version: updated.version, submission_key: 'hud-finish', status: 'completed', decisions: [],
  });
  assert.deepEqual(finished.decisions, ['保留入口', '保留缓存']);
});

test('MCP queues multiple frozen feature refreshes and preserves their HUD state after restart', async t => {
  const {service, bridge, project, root} = await fixture(t);
  const {scenario} = service.addFeature(project.project_id, '读取数值');
  const second = service.addFeature(project.project_id, '另一个功能').scenario;
  const task = await service.engineering.createTask({
    project_id: project.project_id, goal: '核对读取', scope: ['main.ts'], submission_key: 'hud-task',
  });
  const before = service.store.get<Snapshot>('snapshot', project.snapshot_id);
  const prior: AnalysisResult = {
    schema_version: '1.0', fictional: false, result_id: 'old-reading',
    binding: {project_id: project.project_id, feature_id: scenario.feature_id, scenario_id: scenario.scenario_id,
      question_revision_id: scenario.question_revision_id, source_snapshot_id: project.snapshot_id, run_id: 'old-run'},
    provider: {provider_id: 'codex', connection_id: 'fixture', adapter_version: '0.1.0'},
    summary: {text: '读取数值', claim_ids: []}, coverage: {covered_scope: ['main.ts'], unresolved_scope: []},
    nodes: [], edges: [], claims: [], gaps: [],
    evidence: [{evidence_id: 'read', path: 'main.ts', line_start: 1, line_end: 1,
      source_snapshot_id: project.snapshot_id, content_sha256: before.files[0].content_sha256,
      role: 'definition', note: '读取定义'}],
  };
  const explanation: Explanation = {result_id: prior.result_id, scenario_id: scenario.scenario_id,
    created_at: task.created_at, source_status: 'current', result: prior};
  service.store.put('explanation', prior.result_id, explanation);
  service.store.put('explanation', 'second-reading', {
    ...explanation, result_id: 'second-reading', scenario_id: second.scenario_id,
    result: {...prior, result_id: 'second-reading',
      binding: {...prior.binding, scenario_id: second.scenario_id, feature_id: second.feature_id,
        question_revision_id: second.question_revision_id}},
  });
  service.store.put('engineering_task', task.task_id, {...task, execution_mode: 'mcp'});
  const other = {...scenario, project_id: 'different-project', scenario_id: 'other-scene'};
  service.store.put('scenario', other.scenario_id, other);
  await assert.rejects(service.refreshFeatureWalkthrough(task.task_id, other.scenario_id, 'hud-cross-project'), /同一工程/);
  await bridge.enable(project.project_id);
  await service.refreshFeatureWalkthrough(task.task_id, scenario.scenario_id, 'hud-refresh-mcp');
  await service.refreshFeatureWalkthrough(task.task_id, second.scenario_id, 'hud-refresh-second');
  const [run, secondRun] = service.store.all<Run>('run');
  assert.equal(run.status, 'waiting_agent');
  assert.equal(run.refresh_from_result_id, prior.result_id);
  const originalRequest = service.store.get('setting', 'mcp-requested-analysis');
  assert.equal(originalRequest.feature_refresh_run_id, run.binding.run_id);
  const current = await bridge.call('arc_current_project', {});
  assert.deepEqual(current.requested_refreshes, [run, secondRun].map(item => ({
    run_id: item.binding.run_id, task_id: task.task_id, scenario_id: item.binding.scenario_id,
    source_snapshot_id: item.binding.source_snapshot_id, title: item.title,
  })));
  assert.equal(current.requested_analysis.scenario_id, scenario.scenario_id);
  service.store.put('setting', 'mcp-requested-analysis', {...originalRequest, feature_refresh_run_id: 'old-run'});
  assert.equal((await bridge.call('arc_current_project', {})).requested_analysis.scenario_id, scenario.scenario_id);
  service.store.put('setting', 'mcp-requested-analysis', originalRequest);
  await fs.writeFile(path.join(root, 'main.ts'), 'export function read() { return 2; }\n');
  const latest = await service.refresh(project.project_id);
  assert.notEqual(latest.source_snapshot_id, run.binding.source_snapshot_id);
  const claim = await bridge.call('arc_begin_analysis', {request_id: 'hud-claim'},
    {name: 'test', configured_provider: 'codex'});
  assert.deepEqual(claim.binding, run.binding);
  assert.equal(service.store.get('setting', 'mcp-requested-analysis').feature_refresh_run_id, secondRun.binding.run_id);
  await service.cancel(run.binding.run_id);

  const restarted = new ArcService(service.directory, service.resources);
  try {
    const features = (await restarted.taskHud(task.task_id)).impacted_features;
    const firstFeature = features.find(f => f.scenario_id === scenario.scenario_id)!;
    assert.equal(firstFeature.refreshing, false);
    assert.match(firstFeature.error!, /撤销/);
    assert.equal(features.find(f => f.scenario_id === second.scenario_id)?.refreshing, true);
  } finally {
    await restarted.shutdown();
    restarted.store.close();
  }

  service.store.put('setting', 'mcp-requested-analysis', null);
  const secondClaim = await bridge.call('arc_begin_analysis', {request_id: 'hud-claim-second'},
    {name: 'test', configured_provider: 'codex'});
  assert.deepEqual(secondClaim.binding, secondRun.binding);
  assert.deepEqual((await bridge.call('arc_current_project', {})).requested_refreshes, []);
  assert.equal(service.engineering.task(task.task_id).walkthrough, undefined);
});
