import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/main/store';
import {capture,readSource} from '../src/main/snapshot';
import {EngineeringService} from '../src/main/engineering-service';
import {scanAecLegacy} from '../src/main/aec-migration';
import type {VerificationEvidence} from '../src/engineering';
import {ArcService} from '../src/main/service';
import {ArcMcpBridge} from '../src/main/mcp-bridge';
import type {AnalysisResult,Snapshot} from '../src/shared';

async function fixture(git=false) {
  const temp=path.resolve('.test-data');await fs.mkdir(temp,{recursive:true});const directory=await fs.mkdtemp(path.join(temp,'engineering-')),root=path.join(directory,'中文 工程');await fs.mkdir(root);
  await fs.writeFile(path.join(root,'README.md'),'# A real small project\nRun npm run missing to verify.\n');
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'example',description:'Fixture calculator',scripts:{test:'node --test'},main:'sum.js'},null,2));
  await fs.writeFile(path.join(root,'sum.js'),'export const sum = (a,b) => a+b;\n');
  await fs.writeFile(path.join(root,'other.js'),'export const unrelated = true;\n');
  if(git){execFileSync('git',['init',root],{stdio:'ignore',windowsHide:true});execFileSync('git',['-C',root,'add','.'],{windowsHide:true});execFileSync('git',['-C',root,'-c','user.name=ARC Test','-c','user.email=test@example.invalid','commit','-m','fixture'],{stdio:'ignore',windowsHide:true});}
  const store=new Store(path.join(directory,'data')),snapshot=await capture(root,'p',store.directory,'');store.put('snapshot',snapshot.source_snapshot_id,snapshot);store.put('project','p',{project_id:'p',name:'fixture',root_path:root,snapshot_id:snapshot.source_snapshot_id,fictional:false,build_config:'',created_at:new Date().toISOString()});
  const service=new EngineeringService(store);await service.connect('p');
  return {directory,root,store,service,cleanup:async()=>{store.close();await fs.rm(directory,{recursive:true,force:true});}};
}
test('engineering v1 upgrade preserves existing reading objects and persists version history',async()=>{
  const temp=path.resolve('.test-data');await fs.mkdir(temp,{recursive:true});const dir=await fs.mkdtemp(path.join(temp,'upgrade-'));const db=new DatabaseSync(path.join(dir,'arc.sqlite'));db.exec(`CREATE TABLE objects(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE TABLE events(run_id TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(run_id,event_id));PRAGMA user_version=1;`);db.prepare('INSERT INTO objects VALUES(?,?,?)').run('annotation','a',JSON.stringify({text:'保留批注'}));db.close();
  const store=new Store(dir);try{assert.equal(store.get<any>('annotation','a').text,'保留批注');assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version,2);store.transaction(()=>store.putVersion('engineering_task','t',1,{version:1}));assert.equal(store.versions('engineering_task','t').length,1);}finally{store.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('context shares source versions, detects document conflict and preserves user corrections through incremental scans',async()=>{
  const f=await fixture();try {
    const first=await f.service.context({project_id:'p'}),again=await f.service.context({project_id:'p'});assert.equal(first.version,again.version);assert.equal(first.code_state.snapshot_id,again.code_state.snapshot_id);
    const doc=first.entries.find(e=>e.key==='document:README.md')!;assert.equal(doc.status,'needs_review');assert.match(doc.conflict!,/missing/);
    const correction=f.service.reviseContext({entry_id:doc.entry_id,expected_version:doc.version,text:'使用 npm test；README 尚未修正',submission_key:'correct'});
    const corrected=f.service.reviseContext({entry_id:correction.entry_id,expected_version:correction.version,text:'用户已确认使用 npm test',submission_key:'correct-again'});assert.equal(corrected.entry_id,correction.entry_id);assert.equal(f.service.history('context',corrected.entry_id).length,2);
    const stable=first.entries.find(e=>e.key==='build:package.json:test')!;await fs.writeFile(path.join(f.root,'sum.js'),'export const sum = (a,b) => Number(a)+Number(b);\n');
    const refreshed=await f.service.context({project_id:'p'});assert.ok(refreshed.entries.some(e=>e.entry_id===correction.entry_id&&e.text==='用户已确认使用 npm test'));assert.equal(refreshed.entries.find(e=>e.entry_id===stable.entry_id)?.version,stable.version);
    assert.ok(refreshed.entries.every(e=>e.sources.length));
  }finally{await f.cleanup();}
});
test('task capture distinguishes preexisting dirty overlaps, idempotency, conflicts, verification versions and request continuation',async()=>{
  const f=await fixture(true);try {
    await fs.writeFile(path.join(f.root,'sum.js'),'export const sum = (a,b) => a+b+1;\n');await fs.writeFile(path.join(f.root,'other.js'),'export const unrelated = false;\n');
    const task=await f.service.createTask({project_id:'p',goal:'fix sum',submission_key:'begin'});assert.ok(task.baseline.dirty.includes('sum.js'));
    assert.equal((await f.service.createTask({project_id:'p',goal:'retry duplicate',submission_key:'begin'})).task_id,task.task_id);
    await fs.writeFile(path.join(f.root,'sum.js'),'export const sum = (a,b) => Number(a)+Number(b);\n');
    const code=await f.service.captureState('p'),evidence:VerificationEvidence={evidence_id:'e',command:'node --test',cwd:f.root,outcome:'passed',exit_code:0,origin:'self_reported',code_state:code,created_at:new Date().toISOString()};
    const finish={task_id:task.task_id,expected_version:task.version,submission_key:'finish',status:'completed' as const,summary:'corrected addition',verification:[evidence]};
    const [result,retry]=await Promise.all([f.service.finishTask(finish),f.service.finishTask(finish)]);assert.deepEqual(retry,result);assert.deepEqual(result.changes.map(c=>[c.path,c.ownership]),[['sum.js','preexisting_overlap']]);assert.equal(result.verification_status,'partial');assert.deepEqual(await f.service.finishTask(finish),result);
    const diff=await f.service.taskDiff(task.task_id,'sum.js');assert.match(diff.before,/a\+b\+1/);assert.match(diff.after,/Number/);await assert.rejects(f.service.taskDiff(task.task_id,'other.js'),/不属于/);
    assert.throws(()=>f.service.updateTask({task_id:task.task_id,expected_version:1,submission_key:'stale',summary:'overwrite'}),/VERSION_CONFLICT/);
    const continued=await f.service.createTask({task_id:task.task_id,project_id:'p',goal:'also handle decimals',submission_key:'continue'});assert.equal(continued.goal,'fix sum');assert.equal(continued.requests?.[0].text,'also handle decimals');assert.equal(f.service.history('task',task.task_id).length,3);
    assert.equal((await f.service.createTask({task_id:task.task_id,project_id:'p',goal:'also handle decimals',submission_key:'continue'})).requests?.length,1);
    assert.equal(await fs.readFile(path.join(f.root,'other.js'),'utf8'),'export const unrelated = false;\n');
  }finally{await f.cleanup();}
});
test('context reads are bounded and details/search/page requests keep the same shared version',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.root,'README.md'),'# Detailed context\n'+('A documented engineering fact.\n'.repeat(100)));
    await fs.writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'fixture',scripts:Object.fromEntries(Array.from({length:50},(_,i)=>[`check${i}`,'node --test']))}));
    const first=await f.service.context({project_id:'p'});assert.equal(first.entries.length,24);assert.ok(first.total_entries>40);assert.equal(first.next_offset,24);assert.ok(first.entries.every(e=>e.text.length<=1500));
    const second=await f.service.context({project_id:'p',offset:24,limit:40});assert.equal(second.version,first.version);assert.ok(second.entries.every(e=>!first.entries.some(a=>a.entry_id===e.entry_id)));
    const doc=first.entries.find(e=>e.key==='document:README.md')!;assert.equal(doc.truncated,true);const detail=await f.service.context({project_id:'p',entry_id:doc.entry_id});assert.equal(detail.entries.length,1);assert.ok(detail.entries[0].text.length>1500);assert.equal(detail.version,first.version);
    const search=await f.service.context({project_id:'p',query:'check49'});assert.equal(search.entries.length,1);assert.match(search.entries[0].key,/check49/);
  }finally{await f.cleanup();}
});
test('Agent reads the existing UI analysis on demand with identical frozen relationships and evidence, without republishing stale graphs',async()=>{
  const f=await fixture(),arc=new ArcService(f.store.directory,path.resolve('.')),bridge=new ArcMcpBridge(arc,path.resolve('.'));
  try{
    await fs.writeFile(path.join(f.root,'sum.js'),'import {number} from "./other.js";\nexport const sum = (a,b) => number(a)+number(b);\n');await fs.writeFile(path.join(f.root,'other.js'),'export const number = value => Number(value);\n');
    const context=await arc.engineering.context({project_id:'p'}),snapshot=arc.store.get<Snapshot>('snapshot',context.code_state.snapshot_id),scenario=arc.overview('p');
    const evidence={evidence_id:'import-evidence',source_snapshot_id:snapshot.source_snapshot_id,path:'sum.js',line_start:1,line_end:1,content_sha256:snapshot.files.find(f=>f.path==='sum.js')!.content_sha256,role:'declaration' as const,note:'实际导入声明'};
    const node=(node_id:string,label:string)=>({node_id,kind:'stage' as const,label,description:`${label}的已保存说明`,execution_context:{kind:'unknown' as const,identity:null,label:'未确认',status:'unknown' as const,claim_ids:[],evidence_ids:[]},inputs:[],outputs:[],claim_ids:['claim'],evidence_ids:['import-evidence']});
    const result:AnalysisResult={schema_version:'1.0',fictional:false,result_id:'saved-overview',binding:{project_id:'p',feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,question_revision_id:scenario.question_revision_id,source_snapshot_id:snapshot.source_snapshot_id,run_id:'saved-run'},provider:{provider_id:'codex',connection_id:'existing-analysis',adapter_version:'1'},summary:{text:'求和模块依赖数值转换模块；这是已有说明。',claim_ids:['claim']},coverage:{covered_scope:['sum.js 的导入声明'],unresolved_scope:['运行行为未在此说明中验证']},architecture:{node_ids:['sum','number'],edge_ids:['imports']},nodes:[node('sum','求和模块'),node('number','数值转换模块')],edges:[{edge_id:'imports',kind:'dependency',source_node_id:'sum',target_node_id:'number',label:'导入 number',status:'source_supported',claim_ids:['claim'],evidence_ids:['import-evidence']}],claims:[{claim_id:'claim',statement:'sum.js 导入 other.js 的 number',status:'source_supported',rationale:'导入声明',limitations:['静态导入关系不等于已运行验证'],evidence_ids:['import-evidence'],targets:{node_ids:['sum','number'],edge_ids:['imports'],io_ids:[]}}],evidence:[evidence],gaps:[]};
    arc.store.put('explanation',result.result_id,{result_id:result.result_id,scenario_id:scenario.scenario_id,created_at:new Date().toISOString(),source_status:'current',result});await bridge.enable('p');
    const base=await bridge.call('arc_engineering_context',{workspace_path:f.root});assert.equal(base.analysis,undefined);assert.equal(base.analysis_refs[0].summary,result.summary.text);assert.equal(base.analysis_refs[0].status,'current');
    const entriesBefore=arc.store.all('engineering_context').length;
    const page=await bridge.call('arc_engineering_context',{workspace_path:f.root,result_id:result.result_id,limit:1});assert.equal(page.analysis.total_items,3);assert.equal(page.analysis.nodes.length,1);assert.equal(page.analysis.next_offset,1);assert.deepEqual(page.analysis.binding,result.binding);assert.deepEqual(page.analysis.evidence,[evidence]);assert.equal(page.analysis.nodes[0].in_architecture,true);
    const relation=await bridge.call('arc_engineering_context',{workspace_path:f.root,result_id:result.result_id,query:'dependency',limit:1});assert.equal(relation.analysis.edges.length,1);assert.equal(relation.analysis.edges[0].edge_id,result.edges[0].edge_id);assert.equal(relation.analysis.edges[0].kind,'dependency');assert.equal(relation.analysis.edges[0].status,result.edges[0].status);assert.deepEqual(relation.analysis.claims,result.claims);assert.deepEqual(relation.analysis.node_refs.map((n:any)=>n.node_id),['sum','number']);assert.deepEqual(relation.analysis.evidence,[evidence]);assert.equal(arc.store.all('engineering_context').length,entriesBefore);assert.equal(arc.engineering.tasks().length,0);
    await fs.appendFile(path.join(f.root,'sum.js'),'// later code version\n');const historical=await bridge.call('arc_engineering_context',{workspace_path:f.root,result_id:result.result_id,offset:2,limit:1});assert.equal(historical.analysis.status,'needs_review');assert.equal(historical.analysis.source_snapshot_id,snapshot.source_snapshot_id);assert.deepEqual(historical.analysis.binding,result.binding);assert.deepEqual(arc.data().explanations[0].result,result);assert.deepEqual(historical.analysis.evidence,[evidence]);assert.equal(historical.analysis.edges[0].edge_id,'imports');
    arc.store.put('explanation','foreign-analysis',{result_id:'foreign-analysis',scenario_id:scenario.scenario_id,source_status:'current',result:{...result,result_id:'foreign-analysis',binding:{...result.binding,project_id:'other-project'}}});await assert.rejects(bridge.call('arc_engineering_context',{workspace_path:f.root,result_id:'foreign-analysis'}),/不属于当前授权工作区/);
  }finally{await bridge.close();await arc.shutdown();arc.store.close();await f.cleanup();}
});
test('AEC import preserves raw context, task and evidence sources, is idempotent, and keeps checker revisions after export recovery',async()=>{
  const f=await fixture();let restored:Store|undefined;try{
    const content:Record<string,string>={'docs/ai_engineering/current_state.json':'{"declared_stack":"legacy"}\n','docs/requirements/REQ-0042/requirement.md':'# Historical task\nThe old implementation changed arithmetic.\n','docs/requirements/REQ-0042/verification.md':'# Historical verification\nAll tests passed (old document statement).\n','scripts/check_ai_context.py':'# Original historical checker\nprint("requires REQ bundle")\n'};
    for(const [file,text]of Object.entries(content)){await fs.mkdir(path.dirname(path.join(f.root,file)),{recursive:true});await fs.writeFile(path.join(f.root,file),text);}
    const first=await f.service.importAec('p');assert.equal(first.imported,4);assert.equal(first.task_ids.length,1);
    const legacy=f.service.task(first.task_ids[0]);assert.equal(legacy.origin,'legacy_import');assert.equal(legacy.verification_status,'not_run');assert.deepEqual(legacy.verification,[]);assert.equal(legacy.legacy_import?.sources.length,2);
    const entries=f.store.all<any>('engineering_context'),checker=entries.find(e=>e.legacy_import?.import_key==='aec:scripts/check_ai_context.py');assert.equal(checker.text,content['scripts/check_ai_context.py']);assert.equal(checker.legacy_import.source_kind,'rule');
    const correction=f.service.reviseContext({entry_id:checker.entry_id,expected_version:checker.version,text:'用户说明：历史检查器已经退役',submission_key:'legacy-correction'});
    const again=await f.service.importAec('p');assert.equal(again.imported,0);assert.equal(again.reused,4);assert.deepEqual(again.task_ids,first.task_ids);
    await fs.writeFile(path.join(f.root,'scripts/check_ai_context.py'),'# ARC record checker replacement\n');const next=await f.service.importAec('p');assert.equal(next.imported,1);assert.equal(f.service.history('context',checker.entry_id).length,2);assert.equal(f.service.history('task',legacy.task_id).length,1);
    await f.service.context({project_id:'p',refresh:true});assert.equal(f.store.get<any>('engineering_context',correction.entry_id).text,'用户说明：历史检查器已经退役');
    const oldSource=f.service.history('context',checker.entry_id)[0].sources[0];assert.equal((await readSource(f.store.directory,f.store.get('snapshot',oldSource.snapshot_id),oldSource.path)).text,content['scripts/check_ai_context.py']);
    const scanned=await scanAecLegacy(f.root);await fs.writeFile(path.join(f.root,'docs/ai_engineering/current_state.json'),'{"declared_stack":"changed after scan"}\n');await assert.rejects(f.service.importAec('p',scanned),/扫描后变化/);
    const output=path.join(f.directory,'legacy.json');await f.service.exportProject('p',output);restored=new Store(path.join(f.directory,'restored-legacy'));const recovered=new EngineeringService(restored);await recovered.restoreProject(output);const history=recovered.history('context',checker.entry_id);assert.equal(history.length,2);assert.equal(history[0].text,content['scripts/check_ai_context.py']);assert.equal((await readSource(restored.directory,restored.get('snapshot',oldSource.snapshot_id),oldSource.path)).text,content['scripts/check_ai_context.py']);assert.equal(recovered.task(legacy.task_id).origin,'legacy_import');
  }finally{restored?.close();await f.cleanup();}
});
test('branch conflicts and cancelled attempt late results cannot overwrite a task; restart never replays work',async()=>{
  const f=await fixture(true);try {
    let task=await f.service.createTask({project_id:'p',goal:'fix',submission_key:'a'});const attempt=f.service.startAttempt(task.task_id,{provider_id:'codex',model:'model',origin:'arc'});task=f.service.task(task.task_id);
    execFileSync('git',['-C',f.root,'checkout','-b','other'],{stdio:'ignore',windowsHide:true});await assert.rejects(f.service.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:'b',status:'completed',attempt_id:attempt.attempt_id}),/WORKSPACE_CONFLICT/);
    f.service.updateAttempt(attempt.attempt_id,{status:'cancelled'});await assert.rejects(f.service.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:'c',status:'completed',attempt_id:attempt.attempt_id}),/迟到/);
    const second=await f.service.createTask({project_id:'p',goal:'next',submission_key:'d'});const live=f.service.startAttempt(second.task_id,{provider_id:'codex',model:'model',origin:'arc'});new EngineeringService(f.store);assert.equal(f.store.get<any>('development_attempt',live.attempt_id).status,'interrupted');assert.equal(f.service.task(second.task_id).status,'interrupted');
    const external=await f.service.createTask({project_id:'p',goal:'external continuation',submission_key:'e'}),remote=f.service.startAttempt(external.task_id,{provider_id:'codex',model:'model',origin:'agent'}),version=f.service.task(external.task_id).version;new EngineeringService(f.store);assert.equal(f.service.task(external.task_id).version,version);assert.equal(f.store.get<any>('development_attempt',remote.attempt_id).connection_status,'unknown');assert.equal((await f.service.finishTask({task_id:external.task_id,expected_version:version,submission_key:'queued-finish',status:'completed',attempt_id:remote.attempt_id})).status,'completed');
  }finally{await f.cleanup();}
});
test('a real command with uncertain code-state timing is partial and older verification becomes stale after edits',async()=>{
  const f=await fixture();try{
    const task=await f.service.createTask({project_id:'p',goal:'verify binding',submission_key:'a'}),code=await f.service.captureState('p');
    const evidence:VerificationEvidence={evidence_id:'e',command:'node --test',cwd:f.root,outcome:'passed',exit_code:0,origin:'observed',code_state:code,code_state_verified:false,created_at:new Date().toISOString()};
    const partial=await f.service.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:'b',status:'completed',verification:[evidence]});assert.equal(partial.verification_status,'partial');
    await fs.writeFile(path.join(f.root,'sum.js'),'export const sum = (a,b) => Number(a)+Number(b);\n');
    const stale=await f.service.finishTask({task_id:task.task_id,expected_version:partial.version,submission_key:'c',status:'completed'});assert.equal(stale.verification_status,'stale');
  }finally{await f.cleanup();}
});
test('export restores reading data, context, task history and logs into an unbound workspace; rejects collisions and path escape',async()=>{
  const f=await fixture();let restored:Store|undefined;try {
    const task=await f.service.createTask({project_id:'p',goal:'preserve data',submission_key:'a'}),code=await f.service.captureState('p');
    const logPath='logs/'+task.task_id+'/test.log';await fs.mkdir(path.dirname(path.join(f.store.directory,logPath)),{recursive:true});await fs.writeFile(path.join(f.store.directory,logPath),'actual local test output');
    const evidence:VerificationEvidence={evidence_id:'e',command:'node --test',cwd:f.root,outcome:'passed',exit_code:0,origin:'observed',code_state:code,created_at:new Date().toISOString(),log_path:logPath};
    const final=await f.service.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:'b',status:'completed',verification:[evidence]});assert.equal(final.verification_status,'passed');
    f.store.put('feature','feature',{feature_id:'feature',project_id:'p'});f.store.put('scenario','scene',{scenario_id:'scene',project_id:'p',feature_id:'feature'});f.store.put('revision','revision',{question_revision_id:'revision',scenario_id:'scene',question:'keep question'});f.store.put('annotation','annotation',{annotation_id:'annotation',project_id:'p',text:'keep annotation'});f.store.put('reading','scene',{selected:'keep selection'});f.store.put('engineering_mcp_begin','workspace:key',{task_id:task.task_id,provider:'codex'});
    const binding={project_id:'p',feature_id:'feature',scenario_id:'scene',question_revision_id:'revision',source_snapshot_id:code.snapshot_id,run_id:'reading-run'};
    f.store.put('run','reading-run',{binding,status:'completed',output_path:'',provider_id:'codex'});f.store.event('reading-run','event',1,{text:'saved reading activity'});
    const question={question_id:'question',project_id:'p',scenario_id:'scene',feature_id:'feature',question_revision_id:'revision',source_snapshot_id:code.snapshot_id,run_id:'reading-run',run_ids:['reading-run'],question:'What does this do?',answer:{answer:'Frozen answer retained',binding,evidence:[],uncertainties:['historical source']}};f.store.put('reading_question','question',question);
    f.store.put('reading','p/scene/wide',{scenario_id:'scene',selected:'retained node',scroll:{detail:{top:42,left:7}}});f.store.put('reading','project-session/p',{scenario_id:'scene',entrance:'walk'});f.store.put('reading','last-session',{project_id:'p'});f.store.put('reading','other-p/else/wide',{selected:'must not export'});
    const output=path.join(f.directory,'archive.json');await f.service.exportProject('p',output);restored=new Store(path.join(f.directory,'restored'));restored.put('reading','last-session',{project_id:'other-project'});const service=new EngineeringService(restored);await service.restoreProject(output);
    assert.equal(restored.get<any>('annotation','annotation').text,'keep annotation');assert.equal(restored.get<any>('revision','revision').question,'keep question');assert.equal(restored.get<any>('reading','scene').selected,'keep selection');assert.equal(restored.get<any>('engineering_mcp_begin','workspace:key').task_id,task.task_id);assert.equal(service.history('task',task.task_id).length,2);assert.equal((await service.readLog(task.task_id,logPath)).text,'actual local test output');assert.equal((await service.context({project_id:'p'})).workspace.status,'unbound');await assert.rejects(service.createTask({project_id:'p',goal:'no implicit binding',submission_key:'c'}),/重新绑定/);
    assert.deepEqual(restored.get('reading_question','question'),question);assert.deepEqual(restored.events('reading-run'),[{text:'saved reading activity'}]);assert.equal(restored.get<any>('reading','p/scene/wide').scroll.detail.top,42);assert.equal(restored.get<any>('reading','project-session/p').entrance,'walk');assert.equal(restored.get<any>('reading','last-session').project_id,'other-project');assert.equal(restored.maybe('reading','other-p/else/wide'),null);
    const versionBeforeRebind=service.task(task.task_id).version;await assert.rejects(service.rebindWorkspace('p',f.directory),/数据目录/);assert.equal((await service.context({project_id:'p'})).workspace.status,'unbound');assert.equal(service.task(task.task_id).version,versionBeforeRebind);
    const newRoot=path.join(f.directory,'新绑定工程');await fs.cp(f.root,newRoot,{recursive:true});await fs.writeFile(path.join(newRoot,'other.js'),'// change already present before explicit rebind\n');await service.rebindWorkspace('p',newRoot);assert.equal((await service.context({workspace_path:newRoot})).project_id,'p');assert.equal(service.task(task.task_id).workspace_path,newRoot);assert.equal(service.history('task',task.task_id)[0].workspace_path,f.root);assert.equal(restored.get<any>('snapshot',restored.get<any>('project','p').snapshot_id).root_path,newRoot);assert.equal((await service.createTask({project_id:'p',task_id:task.task_id,goal:'continue after restore',submission_key:'d'})).task_id,task.task_id);
    const continued=service.task(task.task_id);assert.ok(continued.preexisting_files?.some(f=>f.path==='other.js'));const finished=await service.finishTask({task_id:task.task_id,expected_version:continued.version,submission_key:'post-rebind',status:'completed'});assert.equal(finished.changes.find(c=>c.path==='other.js')?.ownership,'preexisting_overlap');
    await assert.rejects(service.restoreProject(output),/ID_CONFLICT/);
    const original=JSON.parse(await fs.readFile(output,'utf8')),malformed=structuredClone(original);malformed.files[0].path='../escaped';const bad=path.join(f.directory,'bad.json');await fs.writeFile(bad,JSON.stringify(malformed));const empty=new Store(path.join(f.directory,'empty'));try{
      const recovering=new EngineeringService(empty);await assert.rejects(recovering.restoreProject(bad),/越界/);assert.equal(empty.all('project').length,0);
      const duplicate=structuredClone(original);duplicate.objects.push(duplicate.objects[0]);await fs.writeFile(bad,JSON.stringify(duplicate));await assert.rejects(recovering.restoreProject(bad),/重复对象/);
      const foreign=structuredClone(original);foreign.objects.find((r:any)=>r.kind==='annotation').value.project_id='different-project';await fs.writeFile(bad,JSON.stringify(foreign));await assert.rejects(recovering.restoreProject(bad),/其他工程/);
      const outputCollision=structuredClone(original);outputCollision.objects.find((r:any)=>r.kind==='run').value.output_path=outputCollision.files.find((r:any)=>r.path.startsWith('snapshots/')).path;await fs.writeFile(bad,JSON.stringify(outputCollision));await assert.rejects(recovering.restoreProject(bad),/不属于该次执行/);
      assert.equal(empty.all('project').length,0);
    }finally{empty.close();}
  }finally{restored?.close();await f.cleanup();}
});
