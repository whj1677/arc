import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test, type TestContext} from 'node:test';
import {buildDevelopmentKnowledgeBrief} from '../src/main/development-knowledge';
import {Store} from '../src/main/store';

function database(t: TestContext) {
  fs.mkdirSync('.test-data', {recursive:true});
  const directory = fs.mkdtempSync(path.resolve('.test-data', 'knowledge-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, {recursive:true}); });
  store.put('project', 'p', {project_id:'p', overview_scenario_id:'overview', snapshot_id:'snap'});
  return store;
}
function node(id: string, label: string, evidence: string[], kind = 'stage') {
  return {node_id:id, label, description:label + '的说明', evidence_ids:evidence, kind};
}
const binding = {project_id:'p', scenario_id:'overview', source_snapshot_id:'snap'};
const overview = {
  result_id:'overview-result', binding,
  feature_catalog:{groups:[{label:'台账', node_ids:['stock']}, {label:'系统', node_ids:['mail']}]},
  nodes:[node('stock', '库存核对', ['db', 'api']), node('mail', '邮件投递', ['mail']),
    node('http', '接口层', ['api'], 'component'), node('repo', '持久化层', ['db'], 'component')],
  architecture:{node_ids:['http', 'repo'], edge_ids:['read']},
  edges:[{edge_id:'read', source_node_id:'http', target_node_id:'repo', label:'读取记录', evidence_ids:['db']}],
  evidence:[{evidence_id:'db', path:'lib/ledger_store.cpp', line_start:17}, {evidence_id:'api', path:'handlers/query.cpp', line_start:33},
    {evidence_id:'mail', path:'services/delivery.cpp', line_start:9}],
};
function putOverview(store: Store, result = overview) {
  store.put('explanation', result.result_id, {result_id:result.result_id, scenario_id:'overview', source_status:'current', created_at:'2026-01-02', result});
}

test('selects features by Chinese bigrams, identifiers and scoped paths with relevant relations and ready calls', t => {
  const store = database(t);
  putOverview(store);
  store.put('feature', 'f', {feature_id:'f', project_id:'p', discovery:{node_id:'stock', result_id:overview.result_id, source_snapshot_id:'snap'}});
  store.put('scenario', 'walk', {scenario_id:'walk', feature_id:'f', kind:'feature_overview', question_revision_id:'rev'});
  const graph = {binding:{...binding, feature_id:'f', scenario_id:'walk', question_revision_id:'rev'},
    nodes:[node('a','queryLedger',['api'],'function'), node('b','loadLedger',['db'],'function')],
    edges:[{kind:'sync_call', status:'source_supported', source_node_id:'a', target_node_id:'b'}],
    evidence:overview.evidence, function_walkthroughs:[{entry_node_id:'a', steps:[{kind:'entry', to_node_id:'a'}, {kind:'call', from_node_id:'a', to_node_id:'b'}]}]};
  store.put('explanation', 'graph', {scenario_id:'walk', source_status:'current', created_at:'2026-01-03', result:graph});
  store.put('explanation', 'obsolete-graph', {scenario_id:'walk', source_status:'current', created_at:'2026-01-04',
    result:{...graph, binding:{...graph.binding, question_revision_id:'previous'}, nodes:[node('a','stale',['api'],'function'), graph.nodes[1]]}});
  for (const [query, scope] of [['增加库存检查', []], ['ledgerStore', []], ['', ['lib\\ledger_store.cpp']]] as const) {
    const brief = buildDevelopmentKnowledgeBrief(store, 'p', query, scope);
    assert.match(brief, /台账\(1\)、系统\(1\)/);
    assert.match(brief, /台账 \/ 库存核对 — 库存核对的说明/);
    assert.match(brief, /lib\/ledger_store\.cpp:17, handlers\/query\.cpp:33/);
    assert.match(brief, /接口层 -> 持久化层: 读取记录/);
    assert.match(brief, /queryLedger -> loadLedger \(handlers\/query\.cpp, lib\/ledger_store\.cpp\)/);
    assert.doesNotMatch(brief, /邮件投递|stale/);
  }
  assert.equal(buildDevelopmentKnowledgeBrief(store, 'p', 'unrelated'), '子系统：台账(1)、系统(1)');
});

test('limits the brief and the number of features and relations for large catalogs', t => {
  const store = database(t);
  const nodes = Array.from({length:12}, (_, i) => node('f' + i, '核对' + '库存'.repeat(700), ['db']));
  const edges = nodes.map((n, i) => ({edge_id:'e' + i, source_node_id:n.node_id, target_node_id:'f0', label:'核对'.repeat(300), evidence_ids:['db']}));
  putOverview(store, {...overview, nodes, edges, feature_catalog:{groups:[{label:'长组'.repeat(250), node_ids:nodes.map(n => n.node_id)}]},
    architecture:{node_ids:nodes.map(n => n.node_id), edge_ids:edges.map(e => e.edge_id)}});
  const brief = buildDevelopmentKnowledgeBrief(store, 'p', '核对');
  assert.ok(brief.length <= 4000);
  assert.equal(brief.match(/^功能：/gm)?.length, 6);
  assert.equal(brief.match(/^架构：/gm)?.length, 6);
  assert.equal(buildDevelopmentKnowledgeBrief(store, 'p', '核对'), brief);
});

test('uses the latest catalog in this project and stays empty until one exists', t => {
  const store = database(t);
  putOverview(store, {...overview, result_id:'foreign', binding:{...binding, project_id:'q'}});
  assert.equal(buildDevelopmentKnowledgeBrief(store, 'p', '库存'), '');
  putOverview(store);
  store.put('explanation', 'old', {scenario_id:'overview', created_at:'2026-01-01',
    result:{...overview, feature_catalog:{groups:[{label:'过时分组', node_ids:['stock']}]}}});
  store.put('explanation', 'newer-without-catalog', {scenario_id:'overview', created_at:'2026-01-06', result:{binding}});
  const brief = buildDevelopmentKnowledgeBrief(store, 'p', '库存');
  assert.match(brief, /台账/);
  assert.doesNotMatch(brief, /过时分组/);
});
