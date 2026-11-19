import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ArcService} from '../src/main/service';
import {ArcMcpBridge,bridgeTools} from '../src/main/mcp-bridge';
import {activity} from '../src/ui/activity';
async function setup(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-mcp-'));const source=path.join(dir,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'a.ts'),'export const value=1;\n');const service=new ArcService(path.join(dir,'data'),path.resolve('.'));const project=await service.openProject(source);const bridge=new ArcMcpBridge(service,path.resolve('.'));await bridge.start();return {dir,source,service,project,bridge};}
test('MCP authenticated stdio round trip, scoped frozen reads, progress, revoke and idempotence',async()=>{
 const {source,service,project,bridge}=await setup();let child:ReturnType<typeof spawn>|undefined;
 try{
 await assert.rejects(bridge.call('arc_current_project',{}),/授权/);
 const connection=JSON.parse(await fs.readFile(bridge.connectionFile,'utf8'));assert.equal((await fetch(connection.url,{method:'POST',body:'{}'})).status,403);
 await bridge.enable(project.project_id);
 child=spawn(process.execPath,['dist/arc-mcp.cjs',bridge.connectionFile],{stdio:['pipe','pipe','pipe'],windowsHide:true});let sequence=0,buffer='';const pending=new Map<number,(x:any)=>void>();child.stdout!.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const response=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(response.id)?.(response.result);pending.delete(response.id);}});
 const rpc=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(Error('RPC timeout')),10000);pending.set(id,x=>{clearTimeout(timer);resolve(x);});child!.stdin!.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 assert.equal((await rpc('initialize',{clientInfo:{name:'protocol-test'}})).serverInfo.name,'arc');const listed=(await rpc('tools/list')).tools;assert.deepEqual(listed.map((tool:any)=>tool.name).sort(),bridgeTools.map(tool=>tool.name).sort());
 const current=await rpc('tools/call',{name:'arc_current_project',arguments:{}});assert.equal(JSON.parse(current.content[0].text).project.project_id,project.project_id);
 const begun=await rpc('tools/call',{name:'arc_begin_analysis',arguments:{request_id:'test'}});const task=JSON.parse(begun.content[0].text),run_id=task.binding.run_id;
 assert.deepEqual((await bridge.call('arc_begin_analysis',{request_id:'test'})).binding,task.binding);assert.equal(service.active.size,0);
 await fs.writeFile(path.join(source,'a.ts'),'changed\n');assert.equal((await bridge.call('arc_read_source',{run_id,path:'a.ts'})).lines[0].text,'export const value=1;');
 await service.engineering.connect(project.project_id);const refreshed=await bridge.call('arc_engineering_context',{workspace_path:source,refresh:true});
 const next=await bridge.call('arc_begin_analysis',{request_id:'after-rescan'});assert.equal(next.binding.source_snapshot_id,service.store.get('project',project.project_id).snapshot_id);assert.notEqual(next.binding.source_snapshot_id,task.binding.source_snapshot_id);
 assert.equal((await bridge.call('arc_read_source',{run_id:next.binding.run_id,path:'a.ts'})).lines[0].text,'changed');assert.equal((await bridge.call('arc_read_source',{run_id,path:'a.ts'})).lines[0].text,'export const value=1;');assert.equal(refreshed.code_state.fingerprint,service.store.get('snapshot',next.binding.source_snapshot_id).fingerprint);
 await assert.rejects(bridge.call('arc_read_source',{run_id,path:'../secret'}));
 await bridge.call('arc_report_progress',{run_id,event_id:'progress-1',message:'已读取真实冻结文件'});await bridge.call('arc_report_progress',{run_id,event_id:'progress-1',message:'已读取真实冻结文件'});
 assert.equal(service.store.events(run_id).filter(e=>e.item?.type==='agent_message').length,1);
 bridge.disable();await assert.rejects(bridge.call('arc_read_source',{run_id,path:'a.ts'}),/授权/);assert.equal(service.store.get('run',run_id).status,'cancelled');
 }finally{child?.kill();await bridge.close();await service.shutdown();service.store.close();}
});
test('registered desktop bridge dispatches only explicitly selected desktop runs',async()=>{
 const {dir,service,project,bridge}=await setup();
 try{
  const {scenario:local}=service.addFeature(project.project_id,'Local','Review locally');
  const {scenario:external}=service.addFeature(project.project_id,'Desktop','Review in Desktop');
  const {scenario:dsh}=service.addFeature(project.project_id,'DSH','Review in DSH');
  for(const provider of ['codex','dsh'])service.store.put('provider',provider,{provider_id:provider,status:'blocked_external',transport:provider==='dsh'?'dsh web':'test',checked_at:new Date().toISOString(),reason:'fixture'});
  const localRun=await service.startRun(local.scenario_id,'codex','local-arc-run');
  const dshRun=await service.startRun(dsh.scenario_id,'dsh','local-dsh-run');
  assert.equal(localRun.execution_mode,'codex');
  assert.equal(dshRun.provider_id,'dsh');
  assert.equal(bridge.status().enabled,false);
  assert.deepEqual(bridge.dispatch.items(project.project_id),[]);
  const desktop=await service.startRun(external.scenario_id,'codex_desktop','desktop-arc-run');
  assert.equal(desktop.provider_id,'codex');
  assert.equal(desktop.execution_mode,'codex_desktop');
  assert.equal(desktop.status,'waiting_agent');
  assert.deepEqual(bridge.dispatch.items(project.project_id).map(item=>item.run_id),[desktop.binding.run_id]);
 }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('MCP host configuration accepts Codex and rejects unsupported hosts',async()=>{
 const {service,project,bridge}=await setup();try{
  await bridge.enable(project.project_id);
  const task=await bridge.call('arc_begin_analysis',{request_id:'codex-host'},{name:'Codex Desktop',configured_provider:'codex'});
  assert.equal(task.provider.provider_id,'codex');assert.equal(task.provider.connection_id,'local-codex');
  assert.equal(service.store.get('run',task.binding.run_id).provider_id,'codex');
  assert.match(service.store.events(task.binding.run_id)[0].message,/未由 Arc 核验/);
  await assert.rejects(bridge.call('arc_begin_analysis',{request_id:'bad-host'},{configured_provider:'unknown'}),/仅支持 Codex/);
  await assert.rejects(bridge.call('arc_begin_analysis',{request_id:'wb'},{name:'WorkBuddy',configured_provider:'workbuddy'}),/仅支持 Codex/);
  const legacy=await bridge.call('arc_begin_analysis',{request_id:'legacy'},{name:'WorkBuddy'});
  assert.equal(legacy.provider.provider_id,'codex','a self-reported client name must not silently choose another provider');
 }finally{await bridge.close();await service.shutdown();service.store.close();}
});

test('dispatch context combines effective project materials with only its own task and exposes all editable categories',async()=>{
 const {source,service,project,bridge}=await setup();try{
  await bridge.enable(project.project_id);await service.engineering.connect(project.project_id);
  const schema=bridgeTools.find(t=>t.name==='arc_save_engineering_entry')!.inputSchema.properties.category;
  for(const category of ['purpose','build','rule','issue','module','interface']){
   assert.ok(schema.enum.includes(category));
   const entry=await bridge.call('arc_save_engineering_entry',{workspace_path:source,category,key:category,text:`Project ${category}`,expected_version:0,submission_key:`material-${category}`});assert.equal(entry.category,category);assert.equal(entry.task_id,undefined);
  }
  const task=await service.engineering.createTask({project_id:project.project_id,goal:'current task',scope:['a.ts'],submission_key:'current'});
  const other=await service.engineering.createTask({project_id:project.project_id,goal:'other task',scope:['a.ts'],submission_key:'other'});
  for(const item of [task,other])await service.engineering.saveEntry({project_id:project.project_id,task_id:item.task_id,category:'plan',key:'task plan',text:item.goal,expected_version:0,submission_key:item.task_id},'user');
  // Protocol fixture: delivery itself is covered by external-dispatch tests;
  // real fresh-session acceptance is performed separately against the live app.
  await bridge.queueDevelopment({project_id:project.project_id,task_id:task.task_id,goal:'Check task context',phase:'analysis',expected_version:task.version,submission_key:'claim-context'});
  const dispatch=bridge.dispatch.items(project.project_id).at(-1)!;
  service.store.put('external_dispatch',dispatch.dispatch_id,{...dispatch,state:'awaiting_claim'});
  const claimed=await bridge.call('arc_claim_dispatch',{dispatch_id:dispatch.dispatch_id});
  for(const category of ['purpose','build','rule','issue','module','interface'])assert.ok(claimed.context.entries.some((e:any)=>e.text===`Project ${category}`));
  assert.ok(claimed.context.entries.some((e:any)=>e.text==='current task'));assert.ok(!claimed.context.entries.some((e:any)=>e.task_id===other.task_id));assert.ok(!claimed.context.recent_tasks.some((t:any)=>t.task_id===other.task_id));
  const strict=await bridge.call('arc_engineering_context',{workspace_path:source,task_id:task.task_id,view:'strict'});assert.deepEqual(strict.entries.map((e:any)=>e.text),['current task']);
 }finally{await bridge.close();await service.shutdown();service.store.close();}
});
test('dispatched tasks can finish without documents or save only a needed design',async()=>{
 const {source,service,project,bridge}=await setup();try{
  await bridge.enable(project.project_id);await service.engineering.connect(project.project_id);
  for(const category of [null,'design'] as const){
   const key=category||'no-documents';
   const task=await bridge.queueDevelopment({project_id:project.project_id,goal:'A small scoped change',phase:'analysis',submission_key:key});
   // Only desktop delivery is simulated. The task still follows the review and approval workflow.
   const analysis=bridge.dispatch.items(project.project_id).at(-1)!;
   service.store.put('external_dispatch',analysis.dispatch_id,{...analysis,state:'awaiting_claim'});
   const initial=await bridge.call('arc_claim_dispatch',{dispatch_id:analysis.dispatch_id});
   const step={step_id:'small',title:'Scoped check',change:'Check the requested behavior',status:'pending',progress:'Ready for review',criteria:[{criterion_id:'scope',text:'No generated documents',evidence_ids:[]}],evidence_ids:[],unresolved:[]};
   const ready=await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:initial.task.version,submission_key:key+'-review',status:'completed',summary:'Review the public value.',proposed_scope:['a.ts'],steps:[step],requirement_package:{behaviors:[{id:'value',behavior:'Keep the numeric export.',design:'Keep the export in a.ts.',files:['a.ts'],step_ids:['small'],verification:'Read the export from a.ts.'}]}});
   await bridge.dispatch.pump();
   await bridge.queueDevelopment({project_id:project.project_id,task_id:task.task_id,phase:'execution',expected_version:ready.version,goal:'Execute',scope:['a.ts'],submission_key:key+'-approve'});
   const dispatch=bridge.dispatch.items(project.project_id).at(-1)!;
   service.store.put('external_dispatch',dispatch.dispatch_id,{...dispatch,state:'awaiting_claim'});
   const claimed=await bridge.call('arc_claim_dispatch',{dispatch_id:dispatch.dispatch_id});
   assert.match(claimed.instructions,/均为可选资料/);assert.match(claimed.instructions,/无需时不调用/);
   assert.doesNotMatch(claimed.instructions,/先调用 arc_save_engineering_entry/);
   const read=()=>bridge.call('arc_engineering_context',{workspace_path:source,task_id:task.task_id,view:'strict'});
   assert.deepEqual((await read()).entries,[],'submission and claim must not create documents');
   const updated=await bridge.call('arc_update_development',{task_id:task.task_id,expected_version:claimed.task.version,submission_key:key+'-step',steps:[{...step,status:'completed',progress:'Protocol check only'}]});
   if(category)await bridge.call('arc_save_engineering_entry',{workspace_path:source,task_id:task.task_id,category,key:'Return contract',text:'Keep the exported value as a number; do not change its consumers.',expected_version:0,submission_key:key+'-entry'});
   const finished=await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:updated.version,submission_key:key+'-finish',status:'completed',summary:'Protocol regression only; no model or code execution.',verification:[]});
   assert.equal(finished.status,'completed');assert.equal(finished.verification_status,'not_run');await bridge.dispatch.pump();
   assert.deepEqual((await read()).entries.map((e:any)=>e.category),category?[category]:[],'completion must not fill missing document categories');
  }
 }finally{await bridge.close();await service.shutdown();service.store.close();}
});

test('MCP rejects forged binding, preserves raw result, accepts valid result once',async()=>{
 const {service,project,bridge}=await setup();try{
 await bridge.enable(project.project_id);const t=await bridge.call('arc_begin_analysis',{request_id:'valid'}),file=t.files[0];

 // A minimal uncertainty result uses no invented factual claims or source anchors.
 const value={schema_version:'1.0',fictional:false,result_id:'mcp-result',binding:t.binding,provider:t.provider,summary:{text:'协议测试：仅确认冻结文件清单；业务语义未分析',claim_ids:['unknown-claim']},coverage:{covered_scope:[],unresolved_scope:['仅检查冻结清单，尚未读取业务入口实现。']},feature_catalog:{scope:'仅冻结文件清单',groups:[],readings:[]},nodes:[],edges:[],claims:[{claim_id:'unknown-claim',statement:'业务语义未分析',status:'unknown',rationale:'协议验证未调用模型',limitations:['业务语义未验证'],evidence_ids:[],targets:{node_ids:[],edge_ids:[],io_ids:[]}}],evidence:[],gaps:[{gap_id:'gap',kind:'missing_entry',question:'业务行为待分析',impact:'未形成业务结论',suggested_action:'真实 Agent 分析',related_node_ids:[],claim_ids:[],evidence_ids:[]}]};
 const {feature_catalog,...missingCatalog}=value;
 const absent=await bridge.call('arc_validate_result',{run_id:t.binding.run_id,result:missingCatalog});assert.match(absent.errors.join(','),/缺少 feature_catalog/);
 const incomplete=await bridge.call('arc_validate_result',{run_id:t.binding.run_id,result:{...value,feature_catalog:{scope:feature_catalog.scope,groups:[]}}});assert.match(incomplete.errors.join(','),/readings/);
 const checked=await bridge.call('arc_validate_result',{run_id:t.binding.run_id,result:value});assert.deepEqual(checked.errors,[]);assert.equal(service.data().explanations.length,0);assert.equal(service.store.get('run',t.binding.run_id).status,'running');
 const saved=await bridge.call('arc_submit_result',{run_id:t.binding.run_id,result:value});assert.equal(saved.status,'completed',JSON.stringify(saved));assert.equal((await bridge.call('arc_submit_result',{run_id:t.binding.run_id,result:value})).idempotent,true);assert.equal(service.data().explanations.length,1);
 const bad=await bridge.call('arc_begin_analysis',{request_id:'bad'});const rejected=await bridge.call('arc_submit_result',{run_id:bad.binding.run_id,result:{...value,result_id:'bad',binding:t.binding}});assert.equal(rejected.status,'failed');assert.equal(service.data().explanations.length,1);
 }finally{await bridge.close();await service.shutdown();service.store.close();}
});
test('activity exposes public events, detects silence, avoids fake progress or reasoning',()=>{
 const run:any={status:'running',created_at:'2026-10-20T00:00:00Z',binding:{run_id:'r'}};
 const events=[{type:'local.stage',stage:'mcp_connected',message:'connected',received_at:run.created_at},{type:'item.completed',item:{type:'reasoning',text:'secret'}},{type:'item.completed',item:{type:'agent_message',id:'m',text:'public'},received_at:run.created_at},{type:'item.completed',item:{type:'mcp_tool_call',id:'tool',tool:'arc_read_source',arguments:{path:'a.ts'},status:'completed'},received_at:run.created_at}];
 const a=activity(run,events,Date.parse(run.created_at)+60000);assert.equal(a.stalled,true);assert.equal(a.connected,true);assert.deepEqual(a.files,['a.ts']);assert.equal(a.latestMessage?.text,'public');assert.ok(!JSON.stringify(a.items).includes('secret'));assert.equal(a.output,false);
});

test('ACP completion retains tool input from the initial event and counts only successful source reads',()=>{
 const run:any={status:'completed',created_at:'2026-10-20T00:00:00Z',ended_at:'2026-10-20T00:01:00Z',binding:{run_id:'r'}};
 const updates=[{sessionUpdate:'tool_call',toolCallId:'read',title:'mcp__arc-frozen-source__arc_read_source',status:'in_progress',rawInput:{path:'main.py'}},{sessionUpdate:'tool_call_update',toolCallId:'read',status:'completed'},{sessionUpdate:'tool_call_update',toolCallId:'read',status:'completed'},{sessionUpdate:'tool_call',toolCallId:'failed',title:'arc_read_source',rawInput:{path:'missing.py'}},{sessionUpdate:'tool_call_update',toolCallId:'failed',status:'failed'},{sessionUpdate:'tool_call',toolCallId:'other',title:'other_tool',rawInput:{path:'other.py'}},{sessionUpdate:'tool_call_update',toolCallId:'other',status:'completed'}];
 const a=activity(run,updates.map(update=>({type:'session.update',update})),Date.now());
 assert.deepEqual(a.files,['main.py']);assert.equal(a.pending,0);assert.match(a.items[0].text,/已完成.*main.py/);assert.doesNotMatch(a.items[0].text,/正在执行/);
});
test('manual import activity cannot claim a completed Agent analysis',()=>{
 const a=activity({status:'completed',origin:'manual_import',created_at:new Date().toISOString()} as any,[],Date.now());
 assert.match(a.phase,/手动导入.*未调用 Agent/);assert.equal(a.connected,false);assert.doesNotMatch(a.phase,/分析完成/);
});
test('long event histories retain final messages and monotonic sequence beyond 2000',async()=>{
 const {service,bridge}=await setup();try{for(let n=1;n<=2002;n++)service.store.event('long',String(n),n,{sequence:n,type:'test'});assert.equal(service.store.nextSequence('long'),2003);assert.equal(service.store.events('long').at(-1).sequence,2002);}finally{await bridge.close();service.store.close();}
});

test('feature development saves exact frozen evidence and rejects a mismatched line',async()=>{
 const {dir,source,service,project,bridge}=await setup();
 try{
   const {feature,scenario}=service.addFeature(project.project_id,'Value','Review the value');
   const snapshot=service.store.get<import('../src/shared').Snapshot>('snapshot',project.snapshot_id);
   const evidence={evidence_id:'value-evidence',path:'a.ts',line_start:1,line_end:1,source_snapshot_id:snapshot.source_snapshot_id,content_sha256:snapshot.files[0].content_sha256};
   const resultId='source-proof';
   service.store.put('explanation',resultId,{result_id:resultId,scenario_id:scenario.scenario_id,result:{binding:{project_id:project.project_id,feature_id:feature.feature_id,scenario_id:scenario.scenario_id,source_snapshot_id:snapshot.source_snapshot_id},summary:{text:'The existing declaration.',claim_ids:[]},nodes:[],evidence:[evidence]}});
   const reading={feature_id:feature.feature_id,scenario_id:scenario.scenario_id,result_id:resultId,source_snapshot_id:snapshot.source_snapshot_id,target:{kind:'file' as const,id:'a.ts'},evidence:{evidence_id:evidence.evidence_id,path:evidence.path,line_start:1,line_end:1}};
   await assert.rejects(service.engineering.createTask({project_id:project.project_id,goal:'Wrong line',submission_key:'wrong-line',reading:{...reading,evidence:{...reading.evidence,line_end:2}}}),/走读证据不一致/);
   const saved=await service.engineering.createTask({project_id:project.project_id,goal:'Retain anchor',submission_key:'good-line',reading});
   assert.deepEqual(saved.reading?.evidence,reading.evidence);
   assert.equal(await fs.readFile(path.join(source,'a.ts'),'utf8'),'export const value=1;\n');
 }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('ARC requirement analysis waits for reviewed scope, keeps one task and creates no document suite',async()=>{
 const {dir,source,service,project,bridge}=await setup();try{
  const task=await bridge.queueDevelopment({project_id:project.project_id,goal:'Change value after review',phase:'analysis',submission_key:'analysis'});
  assert.equal(task.workflow,'analysis');assert.deepEqual(task.scope,[]);
  assert.equal((await bridge.queueDevelopment({project_id:project.project_id,goal:'retry',phase:'analysis',submission_key:'analysis'})).task_id,task.task_id);
  await assert.rejects(bridge.queueDevelopment({project_id:project.project_id,goal:'new execution',phase:'execution',scope:['a.ts'],submission_key:'unreviewed'}),/审阅/);
  const dispatch=bridge.dispatch.items(project.project_id).at(-1)!;
  // Only the protocol delivery state is simulated here; real UI/CLI acceptance is separate.
  service.store.put('external_dispatch',dispatch.dispatch_id,{...dispatch,state:'awaiting_claim'});
  const local=await service.engineering.createTask({project_id:project.project_id,goal:'Another local task',submission_key:'other-local'});
  const localAttempt=service.engineering.startAttempt(local.task_id,{provider_id:'dsh',model:'fixture',origin:'arc',write_scope:[]});
  await assert.rejects(bridge.call('arc_claim_dispatch',{dispatch_id:dispatch.dispatch_id}),/已有开发任务/);
  assert.equal(bridge.dispatch.items(project.project_id).at(-1)!.state,'awaiting_claim');
  await service.engineering.finishTask({task_id:local.task_id,expected_version:service.engineering.task(local.task_id).version,submission_key:'finish-other-local',status:'cancelled'});
  service.engineering.updateAttempt(localAttempt.attempt_id,{status:'cancelled'});
  const claim=await bridge.call('arc_claim_dispatch',{dispatch_id:dispatch.dispatch_id});
  assert.equal(claim.phase,'analysis');assert.deepEqual(claim.allowed_files,[]);assert.match(claim.instructions,/只读需求分析/);
  await assert.rejects(bridge.queueDevelopment({project_id:project.project_id,task_id:task.task_id,goal:'premature',phase:'execution',scope:['a.ts'],submission_key:'premature'}));
  await assert.rejects(bridge.call('arc_update_development',{task_id:task.task_id,expected_version:claim.task.version,submission_key:'false-proof',verification:[{}]}),/只读分析/);
  const step={step_id:'change',title:'Change exported value',change:'Change only a.ts; keep the exported name.',status:'pending',progress:'Read a.ts; implementation waits for approval.',criteria:[{criterion_id:'value',text:'Export value is 2.',evidence_ids:[]}],evidence_ids:[],unresolved:[]};
  const design={behaviors:[{id:'value',behavior:'The exported value equals 2.',design:'Change the constant initializer and retain the exported name.',files:['a.ts'],step_ids:['change'],verification:'Import value and assert it equals 2.'}]};
  const finish={task_id:task.task_id,expected_version:claim.task.version,submission_key:'analysis-finish',status:'completed',summary:'Read the source and found a single exported value.',proposed_scope:['a.ts'],steps:[step],verification:[]};
  await assert.rejects(bridge.call('arc_finish_development',finish),/需求包/);
  await assert.rejects(bridge.call('arc_finish_development',{...finish,requirement_package:{behaviors:[{...design.behaviors[0],step_ids:['absent']}]}}),/步骤/);
  const ready=await bridge.call('arc_finish_development',{...finish,requirement_package:design});
  assert.equal(ready.workflow,'ready');assert.equal(ready.status,'pending');assert.equal(ready.verification_status,'not_run');assert.deepEqual(ready.proposed_scope,['a.ts']);assert.deepEqual(ready.scope,[]);
  assert.equal(await fs.readFile(path.join(source,'a.ts'),'utf8'),'export const value=1;\n');
  assert.equal(bridge.dispatch.items(project.project_id).at(-1)!.state,'completed','review can be approved immediately after the finish receipt');
  await assert.rejects(bridge.queueDevelopment({project_id:project.project_id,task_id:task.task_id,expected_version:ready.version-1,goal:'execute',phase:'execution',scope:['a.ts'],submission_key:'old-review'}),/VERSION_CONFLICT/);
  await assert.rejects(bridge.call('arc_begin_development',{workspace_path:source,task_id:ready.task_id,goal:'Continue',scope:['a.ts'],submission_key:'continue-ready'}),/审阅/);
  const execute=await bridge.queueDevelopment({project_id:project.project_id,task_id:task.task_id,expected_version:ready.version,goal:'execute reviewed scope',phase:'execution',scope:['a.ts'],submission_key:'execute'});
  assert.equal(execute.task_id,task.task_id);assert.equal(execute.workflow,'execution');assert.deepEqual(execute.approval,{reviewed_version:ready.version,scope:['a.ts']});
  const next=bridge.dispatch.items(project.project_id).at(-1)!;service.store.put('external_dispatch',next.dispatch_id,{...next,state:'awaiting_claim'});
  service.engineering.updateBoundaries({task_id:task.task_id,expected_version:execute.version,non_goals:['API'],revoked:['legacy export']});
  const executing=await bridge.call('arc_claim_dispatch',{dispatch_id:next.dispatch_id});assert.deepEqual(executing.allowed_files,['a.ts']);
  assert.deepEqual(executing.task.boundaries,{non_goals:['API'],revoked:['legacy export']});
  assert.deepEqual(executing.task.behaviors,design.behaviors);assert.equal(executing.task.requests,undefined);
  assert.match(executing.environment_brief,/可用工具/);
  await assert.rejects(bridge.call('arc_update_development',{task_id:task.task_id,expected_version:executing.task.version,submission_key:'replace-design',requirement_package:design}),/已批准/);
  await fs.writeFile(path.join(source,'a.ts'),'export const value=2;\n');
  const {code_state}=await bridge.call('arc_engineering_context',{workspace_path:source,task_id:task.task_id,refresh:true});
  const evidence={evidence_id:'value-read',command:'Inspect exported value',cwd:source,outcome:'passed',exit_code:0,code_state,created_at:new Date().toISOString()};
  assert.equal(await fs.readFile(path.join(source,'a.ts'),'utf8'),'export const value=2;\n');
  await assert.rejects(bridge.call('arc_update_development',{task_id:task.task_id,expected_version:executing.task.version,submission_key:'unlinked-evidence',verification:[evidence]}),/验收条件/);
  const done=await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:executing.task.version,submission_key:'executed',status:'completed',summary:'Changed requested export; protocol regression only.',verification:[{...evidence,step_id:'change',criterion_id:'value'}]});
  assert.equal(done.verification[0].criterion_id,'value');assert.equal(done.verification[0].origin,'self_reported');
  assert.deepEqual(done.approval,execute.approval);assert.deepEqual(service.engineering.history('task',task.task_id).find(item=>item.version===done.approval.reviewed_version).requirement_package,design);
  assert.equal(done.status,'completed');assert.equal(done.attempt_ids.length,2);assert.equal(done.changes[0].path,'a.ts');
  assert.deepEqual((await bridge.call('arc_engineering_context',{workspace_path:source,task_id:task.task_id,view:'strict'})).entries,[]);
 }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('MCP-only development waits for a manual claim and keeps the approval gate',async()=>{
 const {dir,source,service,project,bridge}=await setup();
 try{
  const task=await bridge.queueDevelopment({project_id:project.project_id,goal:'Review a.ts',phase:'analysis',submission_key:'save-manual'},'mcp');
  assert.equal(task.execution_mode,'mcp');
  assert.deepEqual(bridge.dispatch.items(project.project_id),[]);
  const input={workspace_path:source,task_id:task.task_id,submission_key:'claim-manual'};
  const claim=await bridge.call('arc_begin_development',input);
  assert.equal(claim.phase,'analysis');
  assert.deepEqual(claim.allowed_files,[]);
  assert.deepEqual((await bridge.call('arc_begin_development',input)).task.attempt_ids,claim.task.attempt_ids);
  await assert.rejects(bridge.queueDevelopment({project_id:project.project_id,task_id:task.task_id,expected_version:claim.task.version,goal:'Execute',phase:'execution',scope:['a.ts'],submission_key:'premature-manual'},'mcp'),/审阅|已有开发任务/);
 }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('upgrade retains legacy read-only analysis and retires unapproved pending execution without blocking revision',async()=>{
 const {dir,service,project,bridge}=await setup();try{
  const eng=service.engineering;
  const old=await eng.createTask({project_id:project.project_id,goal:'Old request',submission_key:'old-execution'});
  Object.assign(old,{workflow:'execution',scope:['a.ts']});service.store.put('engineering_task',old.task_id,old);
  const legacy={dispatch_id:'old-queue',project_id:project.project_id,task_id:old.task_id,phase:'execution',scope:['a.ts'],state:'unknown',created_at:old.created_at};
  service.store.put('external_dispatch',legacy.dispatch_id,legacy);
  await bridge.enable(project.project_id);
  await assert.rejects(bridge.call('arc_claim_dispatch',{dispatch_id:legacy.dispatch_id}),/原任务.*重新分析/);
  assert.equal(eng.task(old.task_id).attempt_ids.length,0);
  assert.equal(bridge.dispatch.items(project.project_id).find(i=>i.dispatch_id===legacy.dispatch_id)?.state,'cancelled');
  const revised=await bridge.queueDevelopment({project_id:project.project_id,task_id:old.task_id,goal:'Review before any changes.',phase:'analysis',expected_version:old.version,submission_key:'renew'});
  assert.equal(revised.workflow,'analysis');assert.equal(revised.task_id,old.task_id);assert.deepEqual(revised.scope,[]);
  const pending=bridge.dispatch.items(project.project_id).find(item=>item.submission_key==='renew')!;
  delete pending.task_version;pending.state='awaiting_claim';service.store.put('external_dispatch',pending.dispatch_id,pending);
  delete revised.analysis_channel;service.store.put('engineering_task',revised.task_id,revised);
  const claim=await bridge.call('arc_claim_dispatch',{dispatch_id:pending.dispatch_id});
  assert.deepEqual(claim.allowed_files,[]);assert.match(claim.instructions,/requirement_package/);assert.equal(claim.task.workflow,'analysis');
 }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('analysis detects source changes, while direct Agent development has no ARC review gate',async()=>{
 const {dir,source,service,project,bridge}=await setup();try{
  const task=await bridge.queueDevelopment({project_id:project.project_id,goal:'Read only',phase:'analysis',submission_key:'readonly'});
  const dispatch=bridge.dispatch.items(project.project_id).at(-1)!;service.store.put('external_dispatch',dispatch.dispatch_id,{...dispatch,state:'awaiting_claim'});
  const claim=await bridge.call('arc_claim_dispatch',{dispatch_id:dispatch.dispatch_id});await fs.writeFile(path.join(source,'a.ts'),'export const value=3;\n');
  const blocked=await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:claim.task.version,submission_key:'analysis-changed',status:'completed',summary:'Unexpected change detected',verification:[]});
  assert.equal(blocked.status,'blocked');assert.equal(blocked.workflow,'analysis');assert.match(blocked.unresolved.join(' '),/代码状态发生变化/);
  const direct=await bridge.call('arc_begin_development',{workspace_path:source,goal:'User authorized direct change',scope:['a.ts'],submission_key:'direct'});
  assert.equal(direct.status,'running');assert.equal(direct.workflow,undefined);
  const done=await bridge.call('arc_finish_development',{task_id:direct.task_id,expected_version:direct.version,submission_key:'direct-finish',status:'completed',summary:'Direct path receives results without requiring documents.',verification:[]});
  assert.equal(done.status,'completed');assert.equal(done.workflow,undefined);
 }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(dir,{recursive:true,force:true});}
});
