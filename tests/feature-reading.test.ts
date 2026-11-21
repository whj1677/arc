import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Ajv2020 from 'ajv/dist/2020';
import {featureReadingModel,featureReadingPosition,featureViewPosition,featurePathPosition,functionPathPosition,featureViews,guideItem,guidePathForStep} from '../src/ui/feature-reading-model';
import {FeatureReading,FeatureReadingDetail} from '../src/ui/FeatureReading';
import {validateReadingGuide} from '../src/main/reading-guide-validation';
import {normalizeTransport,schema} from '../src/main/validation';
import type {AnalysisResult,ReadingGuide,ReadingState} from '../src/shared';

const base=JSON.parse(fs.readFileSync('examples/analysis-result.json','utf8')) as AnalysisResult;
const ev=base.evidence[0],node=base.nodes[0];
const guide:ReadingGuide={
 steps:[{id:'input',title:'编辑输入',actor:'用户',text:'输入暂留在页面',outcome:'等待操作',detail:'编辑不会自动发起处理',node_ids:[node.node_id],evidence_ids:[ev.evidence_id]},{id:'save',title:'提交保存',actor:'用户',text:'点击按钮',outcome:'交给系统',detail:'保存触发',node_ids:[node.node_id],evidence_ids:[ev.evidence_id]}],
 roles:[{id:'input',title:'保存服务',duty:'保存已提交输入',files:[ev.path],evidence_ids:[ev.evidence_id]}],
 handoffs:[],files:[{path:ev.path,title:'输入保存',description:'本功能的输入落点',detail:'只说明已分析片段',step_ids:['save'],evidence_ids:[ev.evidence_id]}],
 paths:[{id:'draft',label:'底稿',entry:'工作台',intro:'先操作，再保存',boundary:'不包含后续处理',step_ids:['input'],lanes:[{label:'只保存',step_ids:['save'],link_labels:[]}],failure_ids:[],role_ids:['input'],handoff_ids:[],files:[ev.path]}]
};
const result={...base,reading_guide:guide};
const render=(r:AnalysisResult,view='timeline')=>renderToStaticMarkup(React.createElement(FeatureReading,{result:r,guide:featureReadingModel(r),view,zoom:1,pathId:"",selected:"",focus:"",search:"",onPath:()=>{},onSelect:()=>{},onNavigate:()=>{},onStep:()=>{}}));

test('reading contract accepts source-bound copy and rejects extra fields and missing refs',()=>{
 const validate=new Ajv2020({strict:false}).compile(schema);assert.equal(validate(result),true,JSON.stringify(validate.errors));assert.deepEqual(validateReadingGuide(result),[]);
 for(const alter of [(g:any)=>g.files[0].path='unrelated/secret.ts',(g:any)=>g.paths[0].step_ids=['absent'],(g:any)=>g.steps[0].node_ids=['absent'],(g:any)=>g.steps[0].evidence_ids=['absent'],(g:any)=>g.paths[0].lanes[0].link_labels=['unexpected'],(g:any)=>g.roles[0].files=['unrelated/secret.ts']]){
   const bad=structuredClone(result);alter(bad.reading_guide);assert.ok(validateReadingGuide(bad).length);
 }
 const extra=structuredClone(result) as any;extra.reading_guide.execute='code';assert.equal(validate(extra),false);
 assert.deepEqual(normalizeTransport({reading_guide:null}),{});
});
test('file page and details stay within the selected explanation, including historical results',()=>{
 const before=JSON.stringify(result),html=render(result,'files');assert.ok(html.includes('本功能的输入落点'));assert.ok(html.includes(ev.path));
 assert.equal(featureReadingModel(result),guide);assert.equal(JSON.stringify(result),before);
 const historical={...base,evidence:[ev]};const fallback=featureReadingModel(historical);assert.deepEqual(fallback.files.map(f=>f.path),[ev.path]);assert.ok(!render(historical,'files').includes('本功能的输入落点'));
 const detail=renderToStaticMarkup(React.createElement(FeatureReadingDetail,{guide,result,selected:'file:'+ev.path,view:'files',onFile:()=>{},onStep:()=>{},onEvidence:()=>{}}));
 assert.ok(detail.includes('在哪一步用到'));assert.ok(detail.includes('提交保存'));assert.equal(guidePathForStep(guide,'save')?.id,'draft');
});
test('incomplete saved guides recover evidence-bound file entries without inventing file purposes',()=>{
 const incomplete={...result,reading_guide:{...guide,files:[],paths:[{...guide.paths[0],files:[]}]}};
 const projected=featureReadingModel(incomplete);assert.deepEqual(projected.files.map(file=>file.path),[ev.path]);assert.deepEqual(projected.paths[0].files,[ev.path]);assert.deepEqual(projected.files[0].step_ids,['input','save']);assert.match(projected.files[0].description,/职责尚未单独分析/);assert.equal(incomplete.reading_guide.files.length,0);
});

test('a selected cross-file step includes the receiver file when only the callsite is quoted',()=>{
 const receiver={...guide.files[0],path:'store/save.ts',title:'保存实现',step_ids:['save']};
 const detail=renderToStaticMarkup(React.createElement(FeatureReadingDetail,{
   guide:{...guide,files:[...guide.files,receiver]},result,selected:'step:save',view:'timeline',
   onFile:()=>{},onStep:()=>{},onEvidence:()=>{},
 }));
 assert.ok(detail.includes('store/save.ts'));
 assert.ok(detail.includes(ev.path));
});

test('unknown order has no sequence arrows and distinct selection types cannot collide',()=>{
 const unordered={...base,edges:[]};const html=render(unordered);assert.ok(html.includes('先后关系未确认'));assert.ok(!html.includes('fr-arrow'));
 assert.equal((guideItem(guide,'step:input') as any).title,'编辑输入');assert.equal((guideItem(guide,'role:input') as any).title,'保存服务');
});
test('legacy exception edges targeting function nodes do not crash business timeline rendering',()=>{
 const fnNode={...node,node_id:'fn-abort',kind:'function' as const};
 const exEdge={edge_id:'ex-fn',kind:'control_flow' as const,flow_role:'exception' as const,status:'source_supported' as const,source_node_id:node.node_id,target_node_id:'fn-abort',label:'中止',claim_ids:node.claim_ids,evidence_ids:[ev.evidence_id]};
 const legacy:AnalysisResult={...base,reading_guide:undefined,nodes:[...base.nodes,fnNode],edges:[...base.edges,exEdge]};
 assert.ok(!featureReadingModel(legacy).paths[0].failure_ids.includes('fn-abort'));
 assert.doesNotThrow(()=>render(legacy,'timeline'));
});
test('legacy feature views migrate once without switching explanation or source snapshot',()=>{
 const old={entrance:'walk',view:'sequence',selected:'old',result_id:'history',source_snapshot_id:'frozen',file:'other',reading_path:'stale'} as ReadingState;
 const migrated=featureReadingPosition(old);assert.equal(migrated.view,'collaboration');assert.equal(migrated.result_id,'history');assert.equal(migrated.source_snapshot_id,'frozen');assert.equal(migrated.file,'');assert.equal(old.selected,'old');assert.equal(featureReadingPosition({...migrated,view:'files',selected:'file:current'}).selected,'file:current');
});

test('function navigation preserves the selected historical explanation across all feature pages',()=>{
 const old:ReadingState={entrance:'walk',view:'functions',scenario_id:'feature',selected:'fn-old',result_id:'history',source_snapshot_id:'frozen',file:'',evidence_id:'',mode:'normal',left_width:220,right_width:360,catalog_hidden:false,pinned:false,detail_tab:'details',expanded:[],scroll:{},zoom:1,stage:'',compare_id:'',linked:true,view_states:{functions:{result_id:'latest',source_snapshot_id:'new-source',selected:'other-function',file:'',evidence_id:'',mode:'normal',detail_tab:'details',zoom:1,stage:''}}};
 let reading=featureReadingPosition(old);assert.equal(reading.view,'functions');
 for(const [view] of [...featureViews,...featureViews].reverse()){
  reading=featureViewPosition(reading,view,'frozen')!;
  assert.equal(reading.view,view);assert.equal(reading.result_id,'history');assert.equal(reading.source_snapshot_id,'frozen');assert.equal(reading.selected,'');
 }
 assert.equal(old.view_states?.functions.result_id,'latest');
 assert.equal(featureViewPosition({...reading,entrance:'overview'},'functions','frozen'),null);
});

test('auxiliary function paths preserve the selected business entrance and explicit shared paths stay aligned',()=>{
 const r:AnalysisResult={...result,reading_guide:{...guide,paths:[{...guide.paths[0],id:'upload'},{...guide.paths[0],id:'retry'}]},function_walkthroughs:['upload','retry','parser'].map(id=>({id,label:id,trigger:'选择入口',entry_node_id:node.node_id,boundary:'只检查阅读位置',evidence_ids:[ev.evidence_id],steps:[]}))};
 const state={entrance:'walk',view:'timeline',reading_path:'retry',result_id:'history',source_snapshot_id:'old-snapshot',function_path:'upload'} as ReadingState;
 const retry=featurePathPosition(state,r,'retry');assert.equal(retry.function_path,'retry');
 const helper=functionPathPosition(retry,r,'parser','fn-parser');assert.equal(helper.reading_path,'retry');assert.equal(helper.function_path,'parser');
 const files=featureViewPosition(helper,'files','old-snapshot')!;assert.equal(files.reading_path,'retry');assert.equal(files.function_path,'parser');
 const upload=functionPathPosition(files,r,'upload','fn-upload');assert.equal(upload.reading_path,'upload');assert.equal(upload.function_path,'upload');
 for(const next of [retry,helper,files,upload]){assert.equal(next.result_id,'history');assert.equal(next.source_snapshot_id,'old-snapshot');}
 assert.equal(featurePathPosition(upload,r,'legacy-business').function_path,'');assert.equal(state.function_path,'upload');
});
