import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {flowLayout,edgeCaption,overlaps,cubicPoint} from '../src/ui/flow-layout';
import type {AnalysisResult} from '../src/shared';
const actual=JSON.parse(fs.readFileSync('evidence/trade-readable-20261020/feature-result.json','utf8')) as AnalysisResult;
test('actual six-step graph has labelled curves without node or label collisions, including the retry branch',()=>{
 const layout=flowLayout(actual.nodes,actual.edges);assert.equal(layout.routes.length,6);
 for(const route of layout.routes){
  assert.ok(route.label,route.edge.edge_id+' needs a visible label');assert.ok(!/[HV]/.test(route.d));
  for(const [id,rect]of layout.positions){
   assert.equal(overlaps(route.label!,rect),false,'label must not cover '+id);
   if(id===route.edge.source_node_id||id===route.edge.target_node_id)continue;
   for(let t=0.01;t<1;t+=0.01){const p=cubicPoint(route.points,t);assert.equal(overlaps({...p,width:0.2,height:0.2},rect),false,route.edge.edge_id+' must avoid '+id);}
  }
 }
 for(let i=0;i<layout.routes.length;i++)for(let j=i+1;j<layout.routes.length;j++)assert.equal(overlaps(layout.routes[i].label!,layout.routes[j].label!),false);
 assert.deepEqual(actual.nodes.map(n=>layout.positions.get(n.node_id)?.x),[30,420,420,30,30,420]);
});
test('labels use explicit transfer mappings, never fabricate a handoff from matching node names',()=>{
 const old=actual.edges[0];assert.equal(edgeCaption(old).data,false);assert.equal(edgeCaption(old).text,old.label);
 const transferred={...old,transfers:[{label:'当天金额',source_output_id:'output',target_input_id:'input',status:'inferred' as const,claim_ids:[],evidence_ids:[]}]};
 assert.deepEqual(edgeCaption(transferred),{text:'当天金额',data:true,uncertain:true});
 const before=JSON.stringify(actual);flowLayout(actual.nodes,actual.edges);assert.equal(JSON.stringify(actual),before);
});
test('self loops and reverse connections remain within the graph and selectable',()=>{
 const first=actual.nodes[0],edges=[{...actual.edges[0],source_node_id:first.node_id,target_node_id:first.node_id}];
 const result=flowLayout([first],edges);assert.equal(result.routes.length,1);assert.match(result.routes[0].d,/C/);
 const route=result.routes[0];assert.ok(route.label);assert.equal(overlaps(route.label!,result.positions.get(first.node_id)!),false);assert.ok(route.label!.x>=0&&route.label!.x+route.label!.width<=result.width);
 for(let t=.01;t<1;t+=.01){const p=cubicPoint(route.points,t);assert.equal(overlaps({...p,width:.1,height:.1},result.positions.get(first.node_id)!),false);}
});
