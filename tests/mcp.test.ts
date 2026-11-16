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
test('MCP host configuration labels WorkBuddy without claiming verified identity',async()=>{
 const {service,project,bridge}=await setup();try{
  await bridge.enable(project.project_id);
  const task=await bridge.call('arc_begin_analysis',{request_id:'wb'},{name:'WorkBuddy',configured_provider:'workbuddy'});
  assert.equal(task.provider.provider_id,'workbuddy');assert.equal(task.provider.connection_id,'local-workbuddy');
  assert.equal(service.store.get('run',task.binding.run_id).provider_id,'workbuddy');
  assert.match(service.store.events(task.binding.run_id)[0].message,/未由 Arc 核验/);
  assert.deepEqual((await bridge.call('arc_begin_analysis',{request_id:'wb'},{configured_provider:'workbuddy'})).binding,task.binding);
  await assert.rejects(bridge.call('arc_begin_analysis',{request_id:'wb'}),/其他宿主/);
  await assert.rejects(bridge.call('arc_begin_analysis',{request_id:'bad-host'},{configured_provider:'unknown'}),/宿主配置无效/);
  const legacy=await bridge.call('arc_begin_analysis',{request_id:'legacy'},{name:'WorkBuddy'});
  assert.equal(legacy.provider.provider_id,'codex','a self-reported client name must not silently choose a provider');
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
  const dispatch=bridge.dispatch.enqueue(project.project_id,{task_id:task.task_id,submission_key:'claim-context',scope:['a.ts']});
  service.store.put('external_dispatch',dispatch.dispatch_id,{...dispatch,state:'awaiting_claim'});
  const claimed=await bridge.call('arc_claim_dispatch',{dispatch_id:dispatch.dispatch_id});
  for(const category of ['purpose','build','rule','issue','module','interface'])assert.ok(claimed.context.entries.some((e:any)=>e.text===`Project ${category}`));
  assert.ok(claimed.context.entries.some((e:any)=>e.text==='current task'));assert.ok(!claimed.context.entries.some((e:any)=>e.task_id===other.task_id));assert.ok(!claimed.context.recent_tasks.some((t:any)=>t.task_id===other.task_id));
  const strict=await bridge.call('arc_engineering_context',{workspace_path:source,task_id:task.task_id,view:'strict'});assert.deepEqual(strict.entries.map((e:any)=>e.text),['current task']);
 }finally{await bridge.close();await service.shutdown();service.store.close();}
});
test('MCP rejects forged binding, preserves raw result, accepts valid result once',async()=>{
 const {service,project,bridge}=await setup();try{
 await bridge.enable(project.project_id);const t=await bridge.call('arc_begin_analysis',{request_id:'valid'}),file=t.files[0];

 // A minimal uncertainty result uses no invented factual claims or source anchors.
 const value={schema_version:'1.0',fictional:false,result_id:'mcp-result',binding:t.binding,provider:t.provider,summary:{text:'协议测试：仅确认冻结文件清单；业务语义未分析',claim_ids:['unknown-claim']},coverage:{covered_scope:[],unresolved_scope:['业务语义']},nodes:[],edges:[],claims:[{claim_id:'unknown-claim',statement:'业务语义未分析',status:'unknown',rationale:'协议验证未调用模型',limitations:['业务语义未验证'],evidence_ids:[],targets:{node_ids:[],edge_ids:[],io_ids:[]}}],evidence:[],gaps:[{gap_id:'gap',kind:'missing_entry',question:'业务行为待分析',impact:'未形成业务结论',suggested_action:'真实 Agent 分析',related_node_ids:[],claim_ids:[],evidence_ids:[]}]};
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
