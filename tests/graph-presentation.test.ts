import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {AnalysisResult} from '../src/shared';
import {focusRelations,canShowSequence,architectureOnlyDependencies} from '../src/ui/graph-presentation';
import {edgeSelection} from '../src/ui/reading-target';
import {wheelZoom,clampZoom} from '../src/ui/zoom';
import {edgeExplanation} from '../src/ui/presentation';
const real=JSON.parse(fs.readFileSync('evidence/trade-readable-20261020/feature-result.json','utf8')) as AnalysisResult;

test('aggregate business steps are not treated as self calls on one execution lane',()=>{
  assert.equal(canShowSequence(real.nodes),false);
  const nodes=real.nodes.slice(0,2).map((n,i)=>({...n,execution_context:{...n.execution_context,kind:'caller' as const,status:'source_supported' as const,identity:'context-'+i}}));
  assert.equal(canShowSequence(nodes),true);
  assert.equal(canShowSequence(nodes.map(n=>({...n,execution_context:{...n.execution_context,identity:'same'}}))),false);
});
test('focus preserves exact endpoints, isolates returns and never invents adjacent edges',()=>{
  const first=real.nodes[0].node_id,call=real.edges[0];
  const returned={...call,edge_id:'paired-return',kind:'return' as const,source_node_id:call.target_node_id,target_node_id:call.source_node_id,related_call_edge_id:call.edge_id};
  const edges=[...real.edges,returned],before=JSON.stringify(edges);
  const focused=focusRelations(real.nodes,edges,first);
  assert.deepEqual(focused.main,edges.filter(e=>e.source_node_id===first&&e.kind!=='return'));
  assert.deepEqual(focused.returns,[returned]);
  assert.deepEqual(focusRelations(real.nodes,edges,edgeSelection(returned.edge_id)).main,[returned]);
  assert.equal(JSON.stringify(edges),before);
});
test('architecture-only dependencies are explicitly incomplete, not silently expanded from other versions',()=>{
  const edge={...real.edges[0],kind:'dependency' as const};
  const result={...real,architecture:{node_ids:real.nodes.map(n=>n.node_id),edge_ids:[edge.edge_id]}};
  assert.equal(architectureOnlyDependencies(result,[edge]),true);
  assert.equal(architectureOnlyDependencies(result,[edge,{...edge,edge_id:'module-dependency'}]),false);
  assert.equal(architectureOnlyDependencies(result,[]),false);
});
test('wheel and button zoom share hard bounds; wheel directions and delta units are consistent',()=>{
  assert.ok(wheelZoom(1,-80,0)>1);assert.ok(wheelZoom(1,80,0)<1);
  assert.equal(wheelZoom(1,1,1),wheelZoom(1,16,0));
  assert.equal(wheelZoom(.25,1000,0),.25);assert.equal(wheelZoom(3,-1000,0),3);
  assert.equal(clampZoom(.1),.25);assert.equal(clampZoom(4),3);
  // A single standard Windows wheel notch (120px) stays smooth (~11-13%) instead of jumping ~27%.
  const oneNotchIn=wheelZoom(1,-120,0);
  assert.ok(oneNotchIn>1.08&&oneNotchIn<1.16);
});
test('an edge opens its own condition or claim instead of repeating the entire project summary',()=>{
 const edge=real.edges[0];assert.notEqual(edgeExplanation(real,edge),real.summary.text);
 assert.equal(edgeExplanation(real,{...edge,condition:'only this branch'}),'only this branch');
});
