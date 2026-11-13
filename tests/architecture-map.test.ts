import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AnalysisResult} from '../src/shared';
import {architectureMap} from '../src/ui/architecture-map';
const node=(id:string,parent?:string)=>({node_id:id,kind:'stage',label:id,description:id,parent_node_id:parent});
const edge=(id:string,a:string,b:string)=>({edge_id:id,source_node_id:a,target_node_id:b,label:id});
const fixture=(nodes:any[],edges:any[])=>({nodes,edges,architecture:{node_ids:nodes.map(n=>n.node_id),edge_ids:edges.map(e=>e.edge_id)}} as unknown as AnalysisResult);
test('architecture map preserves real containment, all relations and their distinct directions',()=>{
 const r=fixture([node('front'),node('back'),node('retrieval','back'),node('model'),node('db')],[edge('request','front','back'),edge('call','back','retrieval'),edge('return','retrieval','back'),edge('model','back','model'),edge('sql','back','db')]);
 const original=JSON.stringify(r),m=architectureMap(r);assert.equal(JSON.stringify(r),original);assert.equal(m.hub,'back');assert.equal(m.pairs.flat().length,5);assert.equal(m.pairs.find(p=>p.some(e=>e.edge_id==='call'))!.length,2);
 const box=m.boxes.get('retrieval')!,boundary=m.boundaries.find(b=>b.id==='back')!;assert.ok(box.x>=boundary.x&&box.y>=boundary.y&&box.x+box.width<=boundary.x+boundary.width&&box.y+box.height<=boundary.y+boundary.height);
 for(const b of m.boxes.values()){assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=m.width&&b.y+b.height<=m.height);}
});
test('search keeps a matched internal module inside its real parent',()=>{
 const r=fixture([node('front'),node('back'),node('retrieval','back')],[edge('request','front','back'),edge('call','back','retrieval')]);
 const m=architectureMap(r,'retrieval');assert.deepEqual(m.nodes.map(n=>n.node_id),['back','retrieval']);assert.equal(m.boundaries[0].id,'back');assert.deepEqual(m.edges.map(e=>e.edge_id),['call']);assert.equal(architectureMap(r,'missing').nodes.length,0);
});
test('isolated components and reciprocal calls gain no invented edges',()=>{
 const r=fixture([node('a'),node('b'),node('alone')],[edge('ab','a','b'),edge('ba','b','a')]);const m=architectureMap(r);assert.equal(m.boxes.size,3);assert.equal(m.pairs.length,1);assert.equal(m.edges.length,2);assert.equal(new Set([...m.boxes.values()].map(b=>`${b.x}/${b.y}`)).size,3);
});
test('fan-out architecture fits a balanced map without changing source directions',()=>{
 const r=fixture(['front','server','store','agent','model','browser','target'].map(id=>node(id)),[edge('request','front','server'),...['store','agent','model','browser','target'].map(id=>edge(id,'server',id))]);
 const m=architectureMap(r);assert.equal(m.hub,'server');assert.ok(m.height<=420);
 assert.equal([...m.boxes.values()].filter(b=>b.x===24).length,3);
 assert.equal([...m.boxes.values()].filter(b=>b.x===660).length,3);
 assert.deepEqual(m.edges,r.edges);
});
