import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {shallowOverviewQuestion} from '../src/main/architecture-analysis';
import {ArcService,overviewQuestion} from '../src/main/service';
import {capture,readSource,sha,relativePath,safeFile,freshness} from '../src/main/snapshot';
import {validateResult,normalizeTransport} from '../src/main/validation';
import {JsonLines} from '../src/main/providers';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import type {Run,Snapshot,AnalysisResult} from '../src/shared';
const resource=path.resolve('.');
test('snapshot honors Git ignored untracked outputs and retains tracked sources and both app layers',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-ignore-')),root=path.join(dir,'project');await fs.mkdir(root);
 execFileSync('git',['init',root],{windowsHide:true,stdio:'ignore'});
 await fs.writeFile(path.join(root,'.gitignore'),'.verify-build/\n/build/\ndata/\n*.generated.py\n');
 for(const file of ['app/main.py','web/src/main.tsx','server/build/manager.mjs','build/generated.js','.verify-build/vendor.py','data/private.txt','app/tracked.generated.py','app/ignored.generated.py']){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),'// sample source\n');}
 execFileSync('git',['-C',root,'add','-f','app/tracked.generated.py'],{windowsHide:true});
 const snap=await capture(root,'project',path.join(dir,'snapshots'),'');
 const names=snap.files.map(f=>f.path);assert.ok(names.includes('app/main.py'));assert.ok(names.includes('web/src/main.tsx'));assert.ok(names.includes('app/tracked.generated.py'));
 assert.ok(names.includes('server/build/manager.mjs'));
 for(const file of ['build/generated.js','.verify-build/vendor.py','data/private.txt','app/ignored.generated.py'])assert.ok(!names.includes(file));
 assert.ok(snap.excluded.some(e=>/Git/.test(e.reason)));
 assert.deepEqual(await freshness(snap),[]);
 await fs.writeFile(path.join(root,'app/new.py'),'new source');assert.deepEqual(await freshness(snap),['app/new.py']);
 const nested=await capture(path.join(root,'app'),'app',path.join(dir,'nested'),'');assert.deepEqual(nested.files.map(f=>f.path),['main.py','new.py','tracked.generated.py']);
});
test('source folders named build remain readable and freshness detects their additions outside Git',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-source-build-')),root=path.join(dir,'project');
 await fs.mkdir(path.join(root,'server/build'),{recursive:true});
 await fs.writeFile(path.join(root,'server/build/manager.mjs'),'export const start = () => 1;\n');
 const storage=path.join(dir,'data'),snap=await capture(root,'project',storage,'');
 assert.deepEqual(snap.files.map(f=>f.path),['server/build/manager.mjs']);
 assert.match((await readSource(storage,snap,'server/build/manager.mjs')).text,/start/);
 assert.deepEqual(await freshness(snap),[]);
 await fs.writeFile(path.join(root,'server/build/verify.mjs'),'export const verify = () => true;\n');
 assert.deepEqual(await freshness(snap),['server/build/verify.mjs']);
});
async function context(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-test-'));const project=path.join(dir,'中文 工程');await fs.mkdir(project);await fs.writeFile(path.join(project,'source.c'),'int calculate(int x) {\r\n  return x + 3;\r\n}\r\n');return {dir,project,service:new ArcService(path.join(dir,'data'),resource)};}
function resultFor(run:Run,snapshot:Snapshot):AnalysisResult {
  const file=snapshot.files[0];
  return {schema_version:'1.0',fictional:false,result_id:'result-'+run.binding.run_id,binding:run.binding,provider:{provider_id:run.provider_id,connection_id:'local-'+run.provider_id,adapter_version:'0.1.0'},summary:{text:'计算输入加三',claim_ids:['claim']},coverage:{covered_scope:['calculate'],unresolved_scope:['调用入口未提供']},nodes:[{node_id:'node',kind:'function',label:'calculate',description:'输入加三',execution_context:{kind:'unknown',identity:null,label:'未知调用上下文',status:'unknown',claim_ids:[],evidence_ids:[]},inputs:[{io_id:'input',name:'x',availability:'specified',data_type:'int',value_or_shape:null,description:'输入参数',claim_ids:['claim'],evidence_ids:['ev']}],outputs:[],claim_ids:['claim'],evidence_ids:['ev']}],edges:[],claims:[{claim_id:'claim',statement:'calculate 返回 x+3',status:'source_supported',rationale:'函数体',limitations:['无实际运行记录'],evidence_ids:['ev'],targets:{node_ids:['node'],edge_ids:[],io_ids:['input']}}],evidence:[{evidence_id:'ev',source_snapshot_id:snapshot.source_snapshot_id,path:file.path,line_start:1,line_end:3,content_sha256:file.content_sha256,role:'definition',note:'函数体'}],gaps:[{gap_id:'gap',kind:'missing_entry',question:'谁调用此函数',impact:'调用上下文未知',suggested_action:'补充入口',related_node_ids:['node'],claim_ids:[],evidence_ids:[]}]};
}
function fakeRun(service:ArcService,scenario:any,project:any):Run {
  const run:Run={binding:{project_id:project.project_id,feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,question_revision_id:scenario.question_revision_id,source_snapshot_id:project.snapshot_id,run_id:'run-'+Math.random()},provider_id:'codex',status:'running',question:scenario.question,title:scenario.title,created_at:new Date().toISOString(),submission_key:'test-key',output_path:''};
  service.store.put('run',run.binding.run_id,run);return run;
}

test('function details require owned I/O and exact claimed definition; older results remain valid',async()=>{
 const {service,project}=await context();try{
  const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'函数链'),run=fakeRun(service,scenario,p),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const value:any=resultFor(run,snap);value.evidence[0].symbol_id='calculate';
  value.nodes[0].function_details={symbol:'calculate',signature:'int calculate(int x)',definition_evidence_id:'ev',parameter_io_ids:['input'],return_io_ids:null};
  assert.deepEqual((await validateResult(value,run,snap,service.directory)).errors,[]);
  for(const alter of [(v:any)=>v.nodes[0].kind='stage',(v:any)=>v.nodes[0].function_details.symbol='other',(v:any)=>v.evidence[0].role='callsite',(v:any)=>v.nodes[0].function_details.parameter_io_ids=['missing'],(v:any)=>v.nodes[0].function_details.return_io_ids=['input'],(v:any)=>v.claims[0].targets.node_ids=[]]){
   const bad=structuredClone(value);alter(bad);assert.match((await validateResult(bad,run,snap,service.directory)).errors.join(','),/函数/);
  }
  delete value.nodes[0].function_details;assert.deepEqual((await validateResult(value,run,snap,service.directory)).errors,[]);
  assert.deepEqual(normalizeTransport({function_details:null}),{});
 }finally{service.store.close();}
});

test('file purposes require explicit frozen scope, resource kind and matching source support',async()=>{
 const {service,project}=await context();try{
  await fs.mkdir(path.join(project,'folder'));await fs.writeFile(path.join(project,'folder','other.c'),'int other=1;\n');
  const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'文件用途'),run=fakeRun(service,scenario,p),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const value:any=resultFor(run,snap),f=snap.files.find(f=>f.path==='source.c')!;
  value.evidence[0]={...value.evidence[0],path:f.path,content_sha256:f.content_sha256};
  value.nodes[0].kind='resource';value.nodes[0].source_scope={kind:'file',path:f.path};
  assert.deepEqual((await validateResult(value,run,snap,service.directory)).errors,[]);
  for(const alter of [(v:any)=>v.nodes[0].kind='function',(v:any)=>v.nodes[0].source_scope.path='../source.c',(v:any)=>v.nodes[0].source_scope.path='missing.c',(v:any)=>v.nodes[0].source_scope.path='folder/other.c',(v:any)=>v.claims[0].targets.node_ids=[]]){
   const invalid=structuredClone(value);alter(invalid);assert.match((await validateResult(invalid,run,snap,service.directory)).errors.join(','),/文件用途范围错误/);
  }
  const folder=structuredClone(value),other=snap.files.find(f=>f.path==='folder/other.c')!;
  folder.nodes[0].source_scope={kind:'folder',path:'folder'};folder.evidence[0]={...folder.evidence[0],path:other.path,line_end:1,content_sha256:other.content_sha256};
  assert.deepEqual((await validateResult(folder,run,snap,service.directory)).errors,[]);
  delete value.nodes[0].source_scope;assert.deepEqual((await validateResult(value,run,snap,service.directory)).errors,[]);
  assert.deepEqual(normalizeTransport({source_scope:null}),{});
 }finally{service.store.close();}
});
test('data transfers bind the actual source output and target input; old results stay valid',async()=>{
 const {service,project}=await context();try{
  const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'transfer protocol fixture'),run=fakeRun(service,scenario,p),snapshot=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const value=JSON.parse(JSON.stringify(resultFor(run,snapshot)));
  value.nodes[0].outputs=[{...value.nodes[0].inputs[0],io_id:'source-output',name:'计算结果'}];
  value.nodes.push({...structuredClone(value.nodes[0]),node_id:'receiver',inputs:[{...value.nodes[0].inputs[0],io_id:'target-input',name:'待处理结果'}],outputs:[]});
  value.edges=[{edge_id:'handoff',kind:'data_publish',source_node_id:'node',target_node_id:'receiver',label:'交给下一步',status:'source_supported',claim_ids:['claim'],evidence_ids:['ev'],transfers:[{label:'计算结果',source_output_id:'source-output',target_input_id:'target-input',status:'source_supported',claim_ids:['claim'],evidence_ids:['ev']}]}];
  value.claims[0].targets={node_ids:['node','receiver'],edge_ids:['handoff'],io_ids:['input','source-output','target-input']};
  assert.deepEqual((await validateResult(value,run,snapshot,service.directory)).errors,[]);
  for(const [field,bad,pattern] of [['source_output_id','input',/传递输出/],['target_input_id','source-output',/传递输入/]] as const){const invalid=structuredClone(value);invalid.edges[0].transfers[0][field]=bad;assert.match((await validateResult(invalid,run,snapshot,service.directory)).errors.join(','),pattern);}
  const unsupported=structuredClone(value);unsupported.claims[0].targets.io_ids=[];assert.match((await validateResult(unsupported,run,snapshot,service.directory)).errors.join(','),/传递映射缺少/);
  const legacy=structuredClone(value);delete legacy.edges[0].transfers;assert.deepEqual((await validateResult(legacy,run,snapshot,service.directory)).errors,[]);
  assert.equal('transfers' in normalizeTransport({transfers:null}),false);
 }finally{service.store.close();}
});
test('architecture references stay inside the result and cannot turn functions into system components',async()=>{
  const {service,project}=await context();
  try{
    const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'架构'),run=fakeRun(service,scenario,p),snapshot=service.store.get<Snapshot>('snapshot',p.snapshot_id);
    const base=JSON.parse(JSON.stringify(resultFor(run,snapshot)));
    base.architecture={node_ids:['node'],edge_ids:[]};
    assert.match((await validateResult(base,run,snapshot,service.directory)).errors.join(','),/内部函数/);
    base.nodes[0].kind='stage';
    assert.deepEqual((await validateResult(base,run,snapshot,service.directory)).errors,[]);
    const badReference=structuredClone(base);badReference.architecture.node_ids=['other-project-node'];
    assert.match((await validateResult(badReference,run,snapshot,service.directory)).errors.join(','),/缺失引用/);
    base.nodes.push({...structuredClone(base.nodes[0]),node_id:'internal',inputs:[],parent_node_id:'node'});
    base.edges=[{edge_id:'edge',kind:'dependency',source_node_id:'node',target_node_id:'internal',label:'内部依赖',status:'source_supported',claim_ids:['claim'],evidence_ids:['ev']}];
    base.architecture.edge_ids=['edge'];
    assert.match((await validateResult(base,run,snapshot,service.directory)).errors.join(','),/架构关系端点/);
  }finally{service.store.close();}
});
test('feature discovery requires real references and keeps shallow catalogs compatible',async()=>{
 const {service,project}=await context();try{
  const p=await service.openProject(project),scene=service.overview(p.project_id),run=fakeRun(service,scene,p),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const value:any=resultFor(run,snap);value.nodes[0].kind='stage';value.feature_catalog={scope:'仅测试文件入口，非全工程',groups:[{label:'入口',node_ids:['node']}]};
  const missingCatalog=structuredClone(value);delete missingCatalog.feature_catalog;
  assert.match((await validateResult(missingCatalog,run,snap,service.directory)).errors.join(','),/缺少 feature_catalog/);
  const legacy={...run,question:shallowOverviewQuestion};
  assert.deepEqual((await validateResult(value,legacy,snap,service.directory)).errors,[]);
  assert.match((await validateResult(value,run,snap,service.directory)).errors.join(','),/需要为每个目录功能提供 readings/);
  value.feature_catalog.readings=[{node_id:'node',entry:'输入数字',outcome:'返回计算值',steps:[{text:'对输入加三并返回。',evidence_ids:['ev']}],boundary:'未检查调用入口以外的业务。'}];
  assert.deepEqual((await validateResult(value,run,snap,service.directory)).errors,[]);
  for(const change of [(v:any)=>v.feature_catalog.readings[0].steps[0].evidence_ids=['absent'],(v:any)=>v.feature_catalog.readings[0].node_id='missing',(v:any)=>v.feature_catalog.readings=[],(v:any)=>v.feature_catalog.readings.push(v.feature_catalog.readings[0]),(v:any)=>v.feature_catalog.readings[0].steps=[],(v:any)=>v.feature_catalog.groups[0].node_ids=['missing'],(v:any)=>v.feature_catalog.groups.push({label:'重复',node_ids:['node']}),(v:any)=>v.nodes[0].kind='function',(v:any)=>v.claims[0].targets.node_ids=[],(v:any)=>v.architecture={node_ids:['node'],edge_ids:[]}]){const bad=structuredClone(value);change(bad);assert.ok((await validateResult(bad,run,snap,service.directory)).errors.length);}
  value.feature_catalog.readings=[{node_id:'node',entry:'',outcome:'',steps:[],boundary:'仅查到声明，未找到实现文件。'}];
  assert.deepEqual((await validateResult(value,run,snap,service.directory)).errors,[]);
  assert.deepEqual(normalizeTransport({feature_catalog:null}),{});
  assert.deepEqual(normalizeTransport({feature_catalog:{scope:'历史资料',readings:null}}),{feature_catalog:{scope:'历史资料'}});
 }finally{service.store.close();}
});
test('discovery opens only one bound feature; cached results, revision invalidation, archive and snapshot gates',async()=>{
 const {service,project}=await context();try{
  const p=await service.openProject(project),scene=service.overview(p.project_id),run=fakeRun(service,scene,p),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const value:any=resultFor(run,snap);value.nodes[0].kind='stage';value.feature_catalog={scope:'测试目录',groups:[{label:'入口',node_ids:['node']}]};
  service.store.put('explanation',value.result_id,{result_id:value.result_id,scenario_id:scene.scenario_id,created_at:new Date().toISOString(),source_status:'current',result:value});
  const count=service.data().runs.length,opened=service.openDiscoveredFeature(p.project_id,value.result_id,'node');
  assert.equal(service.data().runs.length,count);assert.equal(opened.scenario.kind,'feature_overview');assert.equal(opened.feature.discovery?.source_snapshot_id,p.snapshot_id);
  service.organize('feature',opened.feature.feature_id,{name:'用户修改显示名'});
  assert.equal(service.openDiscoveredFeature(p.project_id,value.result_id,'node').feature.feature_id,opened.feature.feature_id);
  assert.throws(()=>service.openDiscoveredFeature(p.project_id,value.result_id,'missing'),/目录/);
  service.openDiscoveredFeature(p.project_id,value.result_id,'node',true);
  assert.equal(service.data().requested_analysis?.scenario_id,opened.scenario.scenario_id);
  assert.equal(service.data().requested_analysis?.question_revision_id,opened.scenario.question_revision_id);
  const detailRun=fakeRun(service,opened.scenario,p);detailRun.status='completed';service.store.put('run',detailRun.binding.run_id,detailRun);
  const detail=resultFor(detailRun,snap);service.store.put('explanation',detail.result_id,{result_id:detail.result_id,scenario_id:opened.scenario.scenario_id,result:detail});
  assert.equal(service.openDiscoveredFeature(p.project_id,value.result_id,'node').result_id,detail.result_id);
  const updatedCatalog=structuredClone(value);updatedCatalog.result_id='updated-overview';
  service.store.put('explanation',updatedCatalog.result_id,{result_id:updatedCatalog.result_id,scenario_id:scene.scenario_id,result:updatedCatalog});
  const featureCount=service.data().features.length;
  const reopened=service.openDiscoveredFeature(p.project_id,updatedCatalog.result_id,'node',true);
  assert.equal(reopened.feature.feature_id,opened.feature.feature_id);assert.equal(reopened.result_id,detail.result_id);
  assert.equal(service.data().features.length,featureCount);assert.equal(service.data().requested_analysis,undefined);
  service.organize('feature',opened.feature.feature_id,{archived:true});
  assert.throws(()=>service.openDiscoveredFeature(p.project_id,updatedCatalog.result_id,'node'),/归档/);
  service.organize('feature',opened.feature.feature_id,{archived:false});
  service.openDiscoveredFeature(p.project_id,value.result_id,'node',true);assert.equal(service.data().requested_analysis,undefined);
  service.reviseScenario(opened.scenario.scenario_id,'用户的新问题');assert.equal(service.openDiscoveredFeature(p.project_id,value.result_id,'node').result_id,undefined);
  service.organize('feature',opened.feature.feature_id,{archived:true});assert.throws(()=>service.openDiscoveredFeature(p.project_id,value.result_id,'node'),/归档/);service.organize('feature',opened.feature.feature_id,{archived:false});
  await fs.writeFile(path.join(project,'new.ts'),'changed');await service.refresh(p.project_id);
  const refreshed=service.data().projects.find(x=>x.project_id===p.project_id)!;
  assert.equal(service.analysisSnapshot(opened.scenario),refreshed.snapshot_id);
  service.prepareAnalysis(opened.scenario.scenario_id);
  assert.equal(service.data().requested_analysis?.source_snapshot_id,refreshed.snapshot_id);
  assert.equal(service.store.get<any>('feature',opened.feature.feature_id).discovery.source_snapshot_id,p.snapshot_id);
  assert.equal(service.store.get<any>('explanation',detail.result_id).result.binding.source_snapshot_id,p.snapshot_id);
  service.openDiscoveredFeature(p.project_id,value.result_id,'node',true);
  assert.equal(service.data().requested_analysis?.source_snapshot_id,refreshed.snapshot_id);
  const newer:any=structuredClone(value);newer.result_id='old-catalog-2';service.store.put('explanation',newer.result_id,{scenario_id:scene.scenario_id,result:newer});assert.throws(()=>service.openDiscoveredFeature(p.project_id,newer.result_id,'node'),/旧快照/);
 }finally{service.store.close();}
});

test('catalog matching does not reuse a node whose purpose or source evidence changed',async()=>{
 const {service,project}=await context();try{
  const p=await service.openProject(project),scene=service.overview(p.project_id),run=fakeRun(service,scene,p),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const value:any=resultFor(run,snap);value.nodes[0].kind='stage';value.feature_catalog={scope:'测试目录',groups:[{label:'入口',node_ids:['node']}]};
  const save=(v:any)=>service.store.put('explanation',v.result_id,{result_id:v.result_id,scenario_id:scene.scenario_id,result:v});save(value);
  const first=service.openDiscoveredFeature(p.project_id,value.result_id,'node');
  for(const [index,change] of [(v:any)=>v.nodes[0].description='不同的职责',(v:any)=>v.evidence[0].line_end++,(v:any)=>v.evidence[0].content_sha256='different'].entries()){
   const changed=structuredClone(value);changed.result_id=`changed-catalog-${index}`;change(changed);save(changed);
   assert.notEqual(service.openDiscoveredFeature(p.project_id,changed.result_id,'node').feature.feature_id,first.feature.feature_id);
  }
 }finally{service.store.close();}
});

test('refresh keeps never-analyzed discovery blocked and cannot borrow another scenario result',async()=>{
 const {service,project}=await context();try{
  const p=await service.openProject(project),overview=service.overview(p.project_id),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id),run=fakeRun(service,overview,p);
  const catalog:any=resultFor(run,snap);catalog.nodes[0].kind='stage';catalog.feature_catalog={scope:'测试目录',groups:[{label:'入口',node_ids:['node']}]};
  service.store.put('explanation',catalog.result_id,{result_id:catalog.result_id,scenario_id:overview.scenario_id,result:catalog});
  const opened=service.openDiscoveredFeature(p.project_id,catalog.result_id,'node');
  const unrelated=service.addFeature(p.project_id,'另一个功能').scenario;
  const otherResult=resultFor(fakeRun(service,unrelated,p),snap);
  service.store.put('explanation',otherResult.result_id,{result_id:otherResult.result_id,scenario_id:unrelated.scenario_id,result:otherResult});
  await fs.writeFile(path.join(project,'source.c'),'int calculate(int x) { return x + 4; }\n');await service.refresh(p.project_id);
  assert.throws(()=>service.prepareAnalysis(opened.scenario.scenario_id),/旧快照/);
  assert.throws(()=>service.openDiscoveredFeature(p.project_id,catalog.result_id,'node',true),/旧快照/);
  assert.equal(service.data().requested_analysis,undefined);
  assert.equal(service.data().runs.length,2);
  const current=structuredClone(catalog);current.result_id='current-catalog';current.binding.source_snapshot_id=service.data().projects.find(x=>x.project_id===p.project_id)!.snapshot_id;
  current.evidence.forEach((e:any)=>{e.source_snapshot_id=current.binding.source_snapshot_id;e.content_sha256='updated-file';});
  service.store.put('explanation',current.result_id,{result_id:current.result_id,scenario_id:overview.scenario_id,result:current});
  const count=service.data().features.length,reused=service.openDiscoveredFeature(p.project_id,current.result_id,'node',true);
  assert.equal(reused.feature.feature_id,opened.feature.feature_id);assert.equal(service.data().features.length,count);
  assert.equal(reused.feature.discovery?.source_snapshot_id,current.binding.source_snapshot_id);
  assert.equal(service.data().requested_analysis?.source_snapshot_id,current.binding.source_snapshot_id);
  assert.equal(service.store.get<any>('explanation',catalog.result_id).result.binding.source_snapshot_id,p.snapshot_id);
 }finally{service.store.close();}
});
test('MCP preparation freezes the chosen scope without launching a process, and rejects archived or fictional targets',async()=>{
 const {service,project}=await context();try{
  const p=await service.openProject(project),scene=service.overview(p.project_id);const count=service.data().runs.length;
  service.prepareAnalysis(scene.scenario_id);assert.equal(service.data().runs.length,count);assert.equal(service.data().requested_analysis?.scenario_id,scene.scenario_id);assert.equal(service.data().requested_analysis?.source_snapshot_id,p.snapshot_id);assert.equal(service.data().requested_analysis?.question_revision_id,scene.question_revision_id);
  const run=fakeRun(service,scene,p);run.status='running';service.store.put('run',run.binding.run_id,run);const previous=service.data().requested_analysis;assert.equal(service.prepareAnalysis(scene.scenario_id).run_id,run.binding.run_id);assert.deepEqual(service.data().requested_analysis,previous);
  service.organize('scenario',scene.scenario_id,{archived:true});assert.throws(()=>service.prepareAnalysis(scene.scenario_id),/归档/);
 }finally{service.store.close();}
});
test('overview defaults request explicit architecture without overwriting a user question',async()=>{
  const {service,project}=await context();
  try{
    const p=await service.openProject(project),scene=service.overview(p.project_id);
    assert.equal(scene.question,overviewQuestion);
    const prior=service.reviseScenario(scene.scenario_id,shallowOverviewQuestion);
    const upgraded=service.overview(p.project_id);
    assert.equal(upgraded.question,overviewQuestion);assert.notEqual(upgraded.question_revision_id,prior.question_revision_id);
    const custom=service.reviseScenario(scene.scenario_id,'只分析用户指定的模块边界');
    assert.equal(service.overview(p.project_id).question_revision_id,custom.question_revision_id);
    assert.equal(service.overview(p.project_id).question,'只分析用户指定的模块边界');
  }finally{service.store.close();}
});
test('feature walkthrough and scenario scopes stay explicit; hidden overview and archived feature reject new scenes',async()=>{
  const {service,project}=await context();
  try{
    const p=await service.openProject(project),overview=service.overview(p.project_id);
    assert.throws(()=>service.addScenario(overview.feature_id,'用户场景'),/请选择|选择一个用户功能/);
    const {feature,scenario}=service.addFeature(p.project_id,'结果发布');
    assert.equal(scenario.kind,'feature_overview');
    assert.equal(scenario.title,'结果发布 · 整体走读');
    assert.match(scenario.question,/整体走读/);
    const specific=service.addScenario(feature.feature_id,'拒绝非法绑定后是否写入？');
    assert.equal(specific.feature_id,feature.feature_id);
    assert.equal(specific.kind,undefined);
    service.reviseScenario(specific.scenario_id,'更正后的具体问题');
    assert.equal(service.store.get<any>('scenario',scenario.scenario_id).question,scenario.question);
    service.organize('feature',feature.feature_id,{archived:true});
    const count=service.data().scenarios.length;
    assert.throws(()=>service.addScenario(feature.feature_id,'不得落入归档'),/恢复已归档/);
    assert.equal(service.data().scenarios.length,count);
    service.organize('feature',feature.feature_id,{archived:false});
    assert.equal(service.addScenario(feature.feature_id,'恢复后可新增').feature_id,feature.feature_id);
  }finally{service.store.close();}
});
test('新增源码也使旧说明待复核；校验途中取消不得发布',async()=>{
  const {service,project}=await context();const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'冻结');
  await fs.writeFile(path.join(project,'added.c'),'new source\n');
  assert.deepEqual((await service.checkFreshness(p.project_id)).changed_files,['added.c']);
  const run=fakeRun(service,scenario,p),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const accepting=service.acceptResult(run.binding.run_id,resultFor(run,snap));
  run.status='cancel_requested';service.store.put('run',run.binding.run_id,run);
  await assert.rejects(accepting,/迟到/);assert.equal(service.data().explanations.length,0);service.store.close();
});
test('真实 Git commit/dirty/untracked 进入快照；捕获中修改拒绝发布',async()=>{
  const {service,project,dir}=await context();
  const git=(args:string[])=>execFileSync('git',['-C',project,...args],{windowsHide:true,stdio:'pipe'});
  git(['init']);git(['add','source.c']);
  const hooks=path.join(dir,'empty-hooks');await fs.mkdir(hooks);
  git(['-c','user.name=Arc Test','-c','user.email=arc-test@example.invalid','-c','commit.gpgsign=false','-c',`core.hooksPath=${hooks}`,'commit','-m','controlled fixture']);
  await fs.writeFile(path.join(project,'source.c'),'int tracked = 17;\n');await fs.writeFile(path.join(project,'untracked.h'),'extern int tracked;\n');
  const p=await service.openProject(project),snapshot=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  assert.match(snapshot.commit!,/^[0-9a-f]{40}$/);assert.match(snapshot.dirty!,/M source.c/);assert.match(snapshot.dirty!,/\?\? untracked.h/);
  assert.ok(snapshot.files.some(f=>f.path==='untracked.h'));assert.ok(snapshot.excluded.some(f=>f.path==='.git'));
  const changing=path.join(dir,'changing');await fs.mkdir(changing);
  for(let i=0;i<60;i++)await fs.writeFile(path.join(changing,`f-${String(i).padStart(3,'0')}.c`),'old\n');
  await assert.rejects(capture(changing,'race',service.directory,'',undefined,n=>{if(n===50)writeFileSync(path.join(changing,'f-000.c'),'new\n');}),/捕获期间文件变化/);
  service.store.close();
});
test('兼容结果导入保留人工来源，校验归属，不伪造外部运行',async()=>{
  const {dir,service,project}=await context();const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'导入');
  const original=fakeRun(service,scenario,p),file=path.join(dir,'input.json'),value=resultFor(original,service.store.get('snapshot',p.snapshot_id));
  await fs.writeFile(file,JSON.stringify(value));
  const imported=await service.importResult(scenario.scenario_id,file);
  assert.equal(imported.origin,'manual_import');assert.equal(imported.status,'completed');
  assert.notEqual(imported.binding.run_id,original.binding.run_id);assert.deepEqual(imported.imported_binding,original.binding);
  assert.equal(service.active.size,0);
  (value.binding as any).project_id='wrong';await fs.writeFile(file,JSON.stringify(value));
  await assert.rejects(service.importResult(scenario.scenario_id,file),/不属于/);service.store.close();
});
test('构建条件独立快照；同名私有符号不合并；批注保留旧对象',async()=>{
  const {service,project}=await context();
  await fs.writeFile(path.join(project,'source.c'),'#ifdef TARGET_A\nstatic int state=1; static int helper(){return state;}\n#else\nstatic int state=2; static int helper(){return state;}\n#endif\n');
  await fs.writeFile(path.join(project,'other.c'),'static int state=9; static int helper(){return state;}\n');
  const p=await service.openProject(project,false,'TARGET_A=1'),{scenario}=service.addFeature(p.project_id,'私有符号');
  const run=fakeRun(service,scenario,p),snapshot=service.store.get<Snapshot>('snapshot',p.snapshot_id);const result:any=resultFor(run,snapshot);
  result.evidence[0].line_end=1;
  result.nodes[0].label='helper';result.evidence[0].symbol_id='other.c::helper';
  const other=snapshot.files.find(f=>f.path==='source.c')!;
  result.evidence.push({...result.evidence[0],evidence_id:'ev-second',path:other.path,content_sha256:other.content_sha256,symbol_id:'source.c::helper@TARGET_A'});
  result.nodes.push({...structuredClone(result.nodes[0]),node_id:'second-node',label:'helper',inputs:[],outputs:[],evidence_ids:['ev-second']});
  result.claims[0].statement='协议夹具用于验证两个私有符号的身份；语义仍需独立核对';
  await service.acceptResult(run.binding.run_id,result);
  assert.equal(service.data().explanations[0].result.nodes.filter(n=>n.label==='helper').length,2);
  const clue=service.annotate(scenario.scenario_id,'旧对象批注',result.result_id,'node');
  const changed=await service.refresh(p.project_id,'TARGET_A=0');
  assert.notEqual(changed.fingerprint,snapshot.fingerprint);
  assert.deepEqual(changed.files,snapshot.files);
  assert.equal(service.data().explanations[0].result.binding.source_snapshot_id,p.snapshot_id);
  assert.equal(service.data().explanations[0].source_status,'needs_review');
  assert.equal(service.store.get('annotation',clue.annotation_id).source_snapshot_id,p.snapshot_id);service.store.close();
});
test('提交幂等键只创建一个运行；关联重试是新运行而非伪恢复',async()=>{
  const {service,project}=await context(),p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'幂等');
  service.store.put('provider','codex',{provider_id:'codex',status:'blocked_external',reason:'controlled missing authorization fixture',checked_at:new Date().toISOString()});
  const a=await service.startRun(scenario.scenario_id,'codex','same-submission'),b=await service.startRun(scenario.scenario_id,'codex','same-submission');
  assert.equal(a.binding.run_id,b.binding.run_id);assert.equal(service.data().runs.length,1);
  const retry=await service.startRun(scenario.scenario_id,'codex','new-submission',a.binding.run_id);
  assert.notEqual(retry.binding.run_id,a.binding.run_id);assert.equal(retry.previous_run_id,a.binding.run_id);
  assert.equal(service.active.size,0);await service.shutdown();service.store.close();
});
test('真实原始字节冻结，中文路径/CRLF/dirty 文件变化不污染历史',async()=>{
  const {service,project}=await context();const p=await service.openProject(project);const snapshot=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  assert.equal(snapshot.files[0].content_sha256,sha(await fs.readFile(path.join(project,'source.c'))));
  await fs.writeFile(path.join(project,'source.c'),'changed');
  assert.match((await service.source(p.snapshot_id,'source.c')).text,/x \+ 3/);
  assert.deepEqual((await service.checkFreshness(p.project_id)).changed_files,['source.c']);service.store.close();
});
test('同名工程、重复主题独立身份；SQLite 重开恢复输入、修订与阅读位置',async()=>{
  const {dir,service,project}=await context();const p=await service.openProject(project);const a=service.addFeature(p.project_id,'重复 <script>'),b=service.addFeature(p.project_id,'重复 <script>');
  assert.notEqual(a.feature.feature_id,b.feature.feature_id);service.reviseScenario(a.scenario.scenario_id,'新的独立问题');
  service.reading('test',{left_width:260} as any);
  const second=path.join(dir,'other','中文 工程');await fs.mkdir(second,{recursive:true});await fs.writeFile(path.join(second,'source.c'),'different');
  const p2=await service.openProject(second);assert.notEqual(p.project_id,p2.project_id);
  service.store.close();const reopened=new ArcService(path.join(dir,'data'),resource);
  assert.equal(reopened.data().features.length,2);assert.equal(reopened.data().revisions.length,3);assert.equal(reopened.reading('test').left_width,260);reopened.store.close();
});
test('旧问题运行结果原子保存到原修订，切场景和新问题不改变归属',async()=>{
  const {service,project}=await context();const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'算术','解释 calculate');
  const run=fakeRun(service,scenario,p),snapshot=service.store.get<Snapshot>('snapshot',p.snapshot_id),result=resultFor(run,snapshot);
  service.reviseScenario(scenario.scenario_id,'新的问题');service.addFeature(p.project_id,'另一个主题');
  await service.acceptResult(run.binding.run_id,result);
  assert.equal(service.data().explanations[0].result.binding.question_revision_id,scenario.question_revision_id);
  assert.notEqual(service.data().scenarios[0].question_revision_id,scenario.question_revision_id);
  assert.equal(service.store.get<Run>('run',run.binding.run_id).status,'completed');
  await service.acceptResult(run.binding.run_id,result);assert.equal(service.data().explanations.length,1);service.store.close();
});
test('结构、重复 ID、引用、绑定、路径、哈希和行范围失败不会替换稳定说明',async()=>{
  const {service,project}=await context();const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'算术');const run=fakeRun(service,scenario,p),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const original=resultFor(run,snap);assert.equal((await validateResult(original,run,snap,service.directory)).anchors,'passed');
  for(const change of [
    (r:any)=>{r.binding.scenario_id='wrong';},
    (r:any)=>{r.nodes.push(r.nodes[0]);},
    (r:any)=>{r.claims[0].targets.node_ids=['missing'];},
    (r:any)=>{r.evidence[0].content_sha256='a'.repeat(64);},
    (r:any)=>{r.evidence[0].line_end=999;},
    (r:any)=>{r.evidence[0].path='../source.c';},
    (r:any)=>{r.nodes[0].parent_node_id='node';},
    (r:any)=>{r.edges=[{edge_id:'bad',kind:'sync_call',source_node_id:'node',target_node_id:'absent',label:'bad',status:'unknown',claim_ids:[],evidence_ids:[]}];}
  ]){const copy=structuredClone(original);change(copy);assert.ok((await validateResult(copy,run,snap,service.directory)).errors.length);}
  const invalid:any=structuredClone(original);invalid.evidence[0].content_sha256='b'.repeat(64);
  await service.acceptResult(run.binding.run_id,invalid);assert.equal(service.data().explanations.length,0);assert.equal(service.data().runs[0].status,'failed');service.store.close();
});
test('取消后的迟到结果拒绝发布；重复/乱序事件不回退终态',async()=>{
  const {service,project}=await context();const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'算术');const run=fakeRun(service,scenario,p);
  run.status='cancelled';service.store.put('run',run.binding.run_id,run);
  service.event(run.binding.run_id,{type:'turn.started'},'duplicate',10);
  service.event(run.binding.run_id,{type:'turn.started'},'duplicate',2);
  assert.equal(service.store.events(run.binding.run_id).length,1);assert.equal(service.data().runs[0].status,'cancelled');
  await assert.rejects(service.acceptResult(run.binding.run_id,resultFor(run,service.store.get('snapshot',p.snapshot_id))),/迟到/);service.store.close();
});
test('重启后未结束运行保持未知，不能假完成或自动重发',async()=>{
  const {dir,service,project}=await context();const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'算术');fakeRun(service,scenario,p);service.store.close();
  const reopened=new ArcService(path.join(dir,'data'),resource);assert.equal(reopened.data().runs[0].status,'unknown');assert.equal(reopened.active.size,0);
  const unknown=reopened.data().runs[0];unknown.error='ACP remote connection failed: precise original diagnostic';reopened.store.put('run',unknown.binding.run_id,unknown);reopened.store.close();
  const again=new ArcService(path.join(dir,'data'),resource);assert.equal(again.data().runs[0].error,unknown.error);assert.equal(again.active.size,0);again.store.close();
});
test('受限路径拒绝绝对路径、盘符、父目录和越界链接；默认排除凭据',async()=>{
  for(const value of ['../a','C:/a','/a','a\\b','a/../b','a//b','a/./b'])assert.throws(()=>relativePath(value));
  const {dir,service,project}=await context();await fs.writeFile(path.join(project,'.env'),'SECRET=must-not-index');
  const outside=path.join(dir,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'private.txt'),'private');
  await fs.symlink(outside,path.join(project,'escape'),'junction');
  const p=await service.openProject(project),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  assert.equal(snap.files.length,1);assert.equal(snap.excluded.length,2);
  await assert.rejects(safeFile(project,'escape/private.txt'),/越界/);service.store.close();
});
test('取消索引不会注册项目或发布残缺快照',async()=>{
  const {service,project}=await context();const controller=new AbortController();controller.abort();
  await assert.rejects(capture(project,'p',service.directory,'',controller.signal),/取消/);
  assert.equal(service.data().projects.length,0);service.store.close();
});
test('演示显式隔离、夹具锚点真实匹配，不能通过演示调用真实 Agent',async()=>{
  const {service}=await context();const p=await service.loadDemo();assert.ok(p.fictional);
  const data=service.data();assert.equal(data.explanations.length,1);assert.equal(data.explanations[0].result.provider.provider_id,'demo');
  assert.equal(data.runs[0].validation?.anchors,'passed');
  await assert.rejects(service.startRun(data.scenarios[0].scenario_id,'codex','abcdefgh'),/演示/);service.store.close();
});
test('未知数据库版本拒绝打开，保留已有文件',async()=>{
  const {service}=await context();service.store.db.exec('PRAGMA user_version=99');service.store.close();
  assert.throws(()=>new ArcService(service.directory,resource),/版本/);assert.ok((await fs.stat(path.join(service.directory,'arc.sqlite'))).size>0);
});
test('保存事务故障回滚，不出现半个主题',async()=>{
  const {service,project}=await context();const p=await service.openProject(project);
  service.store.db.exec("CREATE TRIGGER reject_question BEFORE INSERT ON objects WHEN NEW.kind='revision' BEGIN SELECT RAISE(FAIL,'simulated disk error'); END");
  assert.throws(()=>service.addFeature(p.project_id,'不会半保存'));assert.equal(service.data().features.length,0);assert.equal(service.data().scenarios.length,0);service.store.close();
});
test('JSONL 中文跨字节边界与异常帧、输出预算',()=>{
  const frames:any[]=[];const parser=new JsonLines(f=>frames.push(f));const bytes=Buffer.from('{"text":"中文"}\n{"end":true}\n');
  for(const byte of bytes)parser.feed(Buffer.from([byte]));parser.end();assert.equal(frames[0].text,'中文');assert.equal(frames.length,2);
  assert.throws(()=>new JsonLines(()=>{}).feed(Buffer.from('not json\n')));
  assert.throws(()=>new JsonLines(()=>{},4).feed(Buffer.from('12345')));
});
test('输出 schema 可选 null 归一化不删除必需 I/O 未知值',()=>{
  const value=normalizeTransport({architecture:null,parent_node_id:null,inputs:[{data_type:null,value_or_shape:null}],condition:null});
  assert.equal('architecture'in value,false);
  const populated={node_ids:['system'],edge_ids:[]};
  assert.deepEqual(normalizeTransport({architecture:populated}).architecture,populated);
  assert.equal('parent_node_id'in value,false);assert.equal(value.inputs[0].data_type,null);
});

test('packaged Python runtime and tool caches are excluded while project source and lockfiles remain',async()=>{
 const {service,project}=await context();for(const name of ['.runtime','.work','.pytest_cache','__pycache__']){await fs.mkdir(path.join(project,name));await fs.writeFile(path.join(project,name,'generated.py'),'generated = True\n');}await fs.writeFile(path.join(project,'requirements-lock.txt'),'fastapi==0.100.0\n');const p=await service.openProject(project),s=service.store.get<Snapshot>('snapshot',p.snapshot_id);assert.deepEqual(s.files.map(f=>f.path).sort(),['requirements-lock.txt','source.c']);assert.equal(s.excluded.length,4);service.store.close();
});


test('declared business main path rejects cycles, forks and non-control edge roles',async()=>{
 const {service,project}=await context();try{
  const p=await service.openProject(project),{scenario}=service.addFeature(p.project_id,'flow role fixture'),run=fakeRun(service,scenario,p),snap=service.store.get<Snapshot>('snapshot',p.snapshot_id);
  const value:any=resultFor(run,snap);value.nodes[0].inputs=[];value.claims[0].targets.io_ids=[];
  value.nodes.push({...structuredClone(value.nodes[0]),node_id:'second'},{...structuredClone(value.nodes[0]),node_id:'third'});
  const edge=(id:string,source:string,target:string)=>({edge_id:id,kind:'control_flow',flow_role:'main',source_node_id:source,target_node_id:target,label:'continue',status:'source_supported',claim_ids:['claim'],evidence_ids:['ev']});
  value.edges=[edge('first','node','second'),edge('next','second','third')];
  assert.deepEqual((await validateResult(value,run,snap,service.directory)).errors,[]);
  for(const extra of [edge('cycle','third','node'),edge('fork','node','third')]){const bad=structuredClone(value);bad.edges.push(extra);assert.match((await validateResult(bad,run,snap,service.directory)).errors.join(','),/主线必须/);}
  const bad=structuredClone(value);bad.edges[0].kind='data_read';assert.match((await validateResult(bad,run,snap,service.directory)).errors.join(','),/只能用于 control_flow/);
  assert.deepEqual(normalizeTransport({flow_role:null}),{});
 }finally{service.store.close();}
});
