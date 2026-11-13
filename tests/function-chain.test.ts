import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AnalysisResult} from '../src/shared';
import {functionChain,functionInfo} from '../src/ui/function-chain';
const node=(id:string,kind='function')=>({node_id:id,kind,label:id,description:'职责 '+id,inputs:[],outputs:[],evidence_ids:[],claim_ids:[]});
const edge=(id:string,a:string,b:string,kind='sync_call')=>({edge_id:id,source_node_id:a,target_node_id:b,kind,status:'source_supported'});
const fixture=(nodes:any[],edges:any[])=>({nodes,edges,evidence:[]} as unknown as AnalysisResult);
test('function cloud includes only explicit function calls, never business sequence or dependency',()=>{
  const r=fixture([node('a'),node('b'),node('stage','stage')],[edge('ab','a','b'),edge('ba','b','a','return'),edge('order','b','a','control_flow'),edge('dep','b','a','dependency'),edge('stage-call','stage','b')]);
  const saved=JSON.stringify(r),model=functionChain(r);
  assert.deepEqual(model.nodes.map(n=>n.node_id),['a','b']);assert.deepEqual(model.edges.map(e=>e.edge_id),['ab']);
  assert.ok(model.positions.get('a')!.x<model.positions.get('b')!.x);assert.equal(JSON.stringify(r),saved);
});
test('cycles, recursion, isolated nodes and bounds remain finite with distinct positions',()=>{
  const model=functionChain(fixture([node('a'),node('b'),node('c'),node('d')],[edge('ab','a','b'),edge('ba','b','a'),edge('bb','b','b'),edge('bc','b','c')]));
  assert.equal(model.positions.size,4);assert.equal(new Set([...model.positions.values()].map(p=>`${p.x},${p.y}`)).size,4);
  for(const p of model.positions.values()){assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));assert.ok(p.x+105<=model.width);assert.ok(p.y+92<=model.height);}
});

test('explicit dispatch stays distinct from direct calls and never connects component dependencies',()=>{
 const r=fixture([node('send'),node('process'),node('service','component')],[edge('dispatch','send','process','execution_boundary'),edge('http','service','process','execution_boundary')]);
 const model=functionChain(r);assert.deepEqual(model.edges.map(e=>[e.edge_id,e.kind]),[['dispatch','execution_boundary']]);assert.ok(model.positions.get('send')!.x<model.positions.get('process')!.x);
});
test('filter and explicit rendering limit do not manufacture dangling edges',()=>{
  const r=fixture([node('a'),node('b'),node('c')],[edge('ab','a','b'),edge('bc','b','c')]);
  assert.equal(functionChain(r,'b').edges.length,0);const limited=functionChain(r,'',2);assert.equal(limited.truncated,true);assert.equal(limited.matched,3);assert.deepEqual(limited.edges.map(e=>e.edge_id),['ab']);
});
test('legacy business I/O is not presented as a known function parameter or return',()=>{
  const r=fixture([{...node('a'),inputs:[{io_id:'in'}],outputs:[{io_id:'out'}]}],[]),info=functionInfo(r,r.nodes[0]);
  assert.equal(info.parameters,null);assert.equal(info.returns,null);assert.equal(info.definition,undefined);assert.equal(info.otherOutputs.length,1);
});
test('exact function references separate returns from side effects and resolve only definition evidence',()=>{
  const n={...node('a'),function_details:{symbol:'a',signature:'a(x)',definition_evidence_id:'definition',parameter_io_ids:['x'],return_io_ids:['return']},inputs:[{io_id:'x'},{io_id:'context'}],outputs:[{io_id:'return'},{io_id:'write'}]};
  const r={...fixture([n],[]),evidence:[{evidence_id:'other',path:'wrong.py'},{evidence_id:'definition',path:'right.py'}]} as unknown as AnalysisResult;
  const info=functionInfo(r,r.nodes[0]);assert.equal(info.definition?.path,'right.py');assert.deepEqual(info.parameters?.map(io=>io.io_id),['x']);assert.deepEqual(info.returns?.map(io=>io.io_id),['return']);assert.deepEqual(info.otherOutputs.map(io=>io.io_id),['write']);
});
