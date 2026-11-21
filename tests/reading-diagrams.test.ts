import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AnalysisResult,ReadingGuide} from '../src/shared';
import {functionSequence,selectedCallStep,callStepKey} from '../src/ui/function-sequence-model';
import {FunctionChain,FunctionDetail} from '../src/ui/FunctionChain';
import {callLabelHeight,callLabelWidth,functionCallMap,recursiveCallRoute} from '../src/ui/function-call-map';
import {readingFailureLinks,readingCollaboration} from '../src/ui/reading-diagram-model';

const result={nodes:[{node_id:'entry',kind:'function',label:'save',description:'save',inputs:[],outputs:[],evidence_ids:[]},{node_id:'store',kind:'function',label:'write',description:'write',inputs:[],outputs:[],evidence_ids:[]}],edges:[],evidence:[],function_walkthroughs:[{id:'save',label:'保存',trigger:'点击',entry_node_id:'entry',boundary:'只覆盖保存',evidence_ids:[],steps:[
 {id:'start',kind:'entry',from_node_id:null,to_node_id:'entry',text:'进入',input:'请求',output:'校验',condition:'',evidence_ids:[]},
 {id:'save',kind:'call',from_node_id:'entry',to_node_id:'store',text:'写入',input:'内容',output:'完成',condition:'校验通过',evidence_ids:[]},
 {id:'work',kind:'work',from_node_id:'store',to_node_id:'store',text:'替换文件',input:'临时文件',output:'文件',condition:'',evidence_ids:[]},
 {id:'done',kind:'return',from_node_id:'store',to_node_id:'entry',text:'返回',input:'项目',output:'交回请求方',condition:'',evidence_ids:[]},
]}]} as unknown as AnalysisResult;
test('a repeated callee and returned caller each render as one function participant',()=>{
 const model=functionSequence(result,'save')!;
 assert.deepEqual(model.participants.map(n=>n.node_id),['entry','store']);
 const html=renderToStaticMarkup(React.createElement(FunctionChain,{result,pathId:'save',selected:'',select:()=>{},zoom:1,search:'',onPath:()=>{},evidence:()=>{}}));
 assert.equal((html.match(/data-function-node=/g)||[]).length,2);
 assert.equal((html.match(/data-function-call=/g)||[]).length,1);
 assert.equal((html.match(/data-call-step=/g)||[]).length,0);
 assert.ok(html.includes('传入'));assert.ok(html.includes('内容'));
 assert.ok(html.includes('函数调用链'));assert.ok(html.includes('调用时间图'));
 assert.ok(!html.includes('function-sequence-steps'));
});
test('function detail offers editors only for an explicit source location',()=>{
 const node:AnalysisResult['nodes'][number]={...result.nodes[0],function_details:{
   symbol:'save',signature:'save()',definition_evidence_id:'save-definition',parameter_io_ids:[],return_io_ids:[],
 }};
 const definition={evidence_id:'save-definition',source_snapshot_id:'snapshot',path:'src/save.ts',line_start:2,line_end:4,
   role:'definition' as const,content_sha256:'',note:''};
 const detail=(evidence:AnalysisResult['evidence'])=>renderToStaticMarkup(React.createElement(FunctionDetail,{
   result:{...result,evidence},node,select:()=>{},evidence:()=>{},
 }));
 const resolved=detail([definition]);
 assert.match(resolved,/在编辑器中打开（第 2 行）/);
 assert.deepEqual([...resolved.matchAll(/<button[^>]*>(默认编辑器|Trae|VS Code)<\/button>/g)].map(match=>match[1]),
   ['默认编辑器','Trae','VS Code']);
 const unresolved=detail([{...definition,role:'callsite'}]);
 assert.match(unresolved,/尚未记录准确的函数定义或声明文件/);
 assert.doesNotMatch(unresolved,/在编辑器中打开|>默认编辑器<|>Trae<|>VS Code</);
});
test('a call map keeps siblings attached to their actual caller and labels arguments',()=>{
 const extra={...result.nodes[1],node_id:'audit',label:'audit'};
 const base=result.function_walkthroughs![0];
 const r:AnalysisResult={...result,nodes:[...result.nodes,extra],edges:['store','audit'].map(target=>({edge_id:'call-'+target,kind:'sync_call',status:'source_supported',source_node_id:'entry',target_node_id:target,label:'调用 '+target,claim_ids:[],evidence_ids:[]})),function_walkthroughs:[{...base,steps:[...base.steps,{...base.steps[1],id:'audit',from_node_id:'entry',to_node_id:'audit',input:'保存结果'}]}]};
 const map=functionCallMap(r,'save');
 assert.deepEqual(map.links.map(e=>[e.from,e.to,e.input]),[['entry','store','内容'],['entry','audit','保存结果']]);
 assert.equal(map.entry,'entry');assert.equal(map.nodes.length,3);
 assert.equal(map.boxes.get('store')?.x,map.boxes.get('audit')?.x);
 const entry=map.boxes.get('entry')!,store=map.boxes.get('store')!,route=map.routes.get(map.links[0].id)!;
 assert.equal(store.x-entry.x,432);
 assert.equal(route.labelX-(entry.x+entry.w),16);
 assert.equal(store.x-(route.labelX+callLabelWidth),16);
 assert.ok(!map.links.some(e=>e.from==='store'&&e.to==='audit'));

 const throughStore={...base.steps[1],id:'store-audit',from_node_id:'store',to_node_id:'audit'};
 const jump=functionCallMap({...r,
   edges:[...r.edges,{...r.edges[0],edge_id:'store-audit',source_node_id:'store',target_node_id:'audit'}],
   function_walkthroughs:[{...base,steps:[...r.function_walkthroughs![0].steps,throughStore]}],
 },'save');
 const direct=jump.routes.get(callStepKey('save','audit'))!;
 const first=jump.routes.get(callStepKey('save','save'))!;
 assert.equal(direct.labelX,first.labelX);
 assert.ok(direct.labelX+callLabelWidth<jump.boxes.get('store')!.x);
 assert.ok(Math.abs(direct.labelY-first.labelY)>=callLabelHeight(true));
});

test('recursive call labels stay above their node and clear of outgoing arguments',()=>{
 const original=result.function_walkthroughs![0];
 const self={...original.steps[1],id:'recursive',from_node_id:'entry',to_node_id:'entry',input:'child bytes'};
 const r={...result,function_walkthroughs:[{...original,steps:[...original.steps,self]}]};
 const map=functionCallMap(r,'save'),box=map.boxes.get('entry')!,route=recursiveCallRoute(box);
 assert.equal(map.nodes.filter(n=>n.node_id==='entry').length,1);
 const halfLabel=callLabelHeight(true)/2;
 assert.ok(route.labelY-halfLabel>=0);assert.ok(route.labelY+halfLabel<box.y);
 assert.ok(route.labelX>=box.x&&route.labelX+callLabelWidth<=box.x+box.w);
 assert.ok(box.y-110>=0);assert.ok(box.y+box.h<=map.height);
});
test('step details and participants never fall back to another explanation',()=>{
 const key=callStepKey('save','done');assert.equal(selectedCallStep(result,key)?.step.from_node_id,'store');
 const old={...result,function_walkthroughs:undefined};assert.equal(functionSequence(old,'save'),undefined);assert.equal(selectedCallStep(old,key),undefined);
 assert.notEqual(callStepKey('a:b','c'),callStepKey('a','b:c'));
});
test('business failure lines require a supported edge in the selected path',()=>{
 const guide={steps:[{id:'submit',node_ids:['request']},{id:'other',node_ids:['other']},{id:'fail',node_ids:['conflict']}],paths:[]} as unknown as ReadingGuide;
 const path={step_ids:['submit'],lanes:[],failure_ids:['fail']} as unknown as ReadingGuide['paths'][number];
 const edge={edge_id:'rejected',kind:'control_flow',flow_role:'exception',status:'source_supported',source_node_id:'request',target_node_id:'conflict',condition:'版本改变'};
 const r={...result,edges:[edge,{...edge,edge_id:'unproved',status:'inferred'},{...edge,edge_id:'other-path',source_node_id:'other'}]} as unknown as AnalysisResult;
 assert.deepEqual(readingFailureLinks(r,guide,path),[{id:'rejected',from:'submit',to:'fail',label:'版本改变'}]);
 assert.deepEqual(readingFailureLinks({...r,edges:[]},guide,path),[]);
});
test('collaboration cannot add an unrelated participant or a dangling handoff',()=>{
 const guide={roles:[{id:'page'},{id:'service'},{id:'unrelated'}],handoffs:[{id:'save',from:'page',to:'service'},{id:'other',from:'page',to:'unrelated'}]} as unknown as ReadingGuide;
 const path={role_ids:['page','service'],handoff_ids:['save','other']} as unknown as ReadingGuide['paths'][number];
 const graph=readingCollaboration(guide,path);assert.deepEqual(graph.roles.map(r=>r.id),['page','service']);assert.deepEqual(graph.handoffs.map(h=>h.id),['save']);
});
