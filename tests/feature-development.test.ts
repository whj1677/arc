import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ArcService} from '../src/main/service';
import {ArcMcpBridge} from '../src/main/mcp-bridge';
import type {runCodex} from '../src/main/providers';
import type {AnalysisResult,Snapshot,Run} from '../src/shared';

async function fixture(runner:typeof runCodex){
  const temp=path.resolve('.test-data');await fs.mkdir(temp,{recursive:true});const directory=await fs.mkdtemp(path.join(temp,'feature-development-')),root=path.join(directory,'source');await fs.mkdir(root);
  await fs.writeFile(path.join(root,'main.ts'),'export const value=1;\n');
  const service=new ArcService(path.join(directory,'data'),path.resolve('.'),()=>{},runner),project=await service.openProject(root),{feature,scenario}=service.addFeature(project.project_id,'数值更新','核对数值更新的入口和状态变化');
  service.store.put('provider','codex',{provider_id:'codex',requested_name:'codex',product:'test double',status:'available',path:process.execPath,version:'test',reason:'orchestration only',transport:'test',auth:'test',capabilities:{},checked_at:new Date().toISOString()});
  return {directory,root,service,project,feature,scenario};
}
function result(run:Run,snapshot:Snapshot,text:string):AnalysisResult{
  const file=snapshot.files.find(item=>item.path==='main.ts')!,evidenceId=`evidence-${run.binding.run_id}`,claimId=`claim-${run.binding.run_id}`,nodeId=`node-${run.binding.run_id}`;
  return {schema_version:'1.0',fictional:false,result_id:`result-${run.binding.run_id}`,binding:run.binding,provider:{provider_id:run.provider_id,connection_id:`local-${run.provider_id}`,adapter_version:'0.1.0'},summary:{text,claim_ids:[claimId]},coverage:{covered_scope:['main.ts'],unresolved_scope:['运行行为仍需真实验证']},nodes:[{node_id:nodeId,kind:'stage',label:'数值更新',description:text,execution_context:{kind:'unknown',identity:null,label:'未确认',status:'unknown',claim_ids:[],evidence_ids:[]},inputs:[],outputs:[],claim_ids:[claimId],evidence_ids:[evidenceId]}],edges:[],claims:[{claim_id:claimId,statement:text,status:'source_supported',rationale:'回归夹具的冻结源码声明',limitations:['不等于真实 Agent 或运行验收'],evidence_ids:[evidenceId],targets:{node_ids:[nodeId],edge_ids:[],io_ids:[]}}],evidence:[{evidence_id:evidenceId,source_snapshot_id:snapshot.source_snapshot_id,path:'main.ts',line_start:1,line_end:1,content_sha256:file.content_sha256,role:'definition',note:text}],gaps:[]};
}
async function close(service:ArcService,bridge?:ArcMcpBridge){await bridge?.close();await service.shutdown();service.store.close();}

test('blocked development without changes does not dispatch an automatic walkthrough',async()=>{
  let calls=0;const runner:typeof runCodex=async options=>{calls++;return {code:0,raw:JSON.stringify(result(options.run,options.snapshot,'原实现')),stderr:''};};
  const f=await fixture(runner);
  try{
    const run=await f.service.startRun(f.scenario.scenario_id,'codex','blocked-original');await f.service.executing.get(run.binding.run_id);
    const old=f.service.data().explanations[0],reading={feature_id:f.feature.feature_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,source_snapshot_id:old.result.binding.source_snapshot_id,target:{kind:'feature' as const,id:f.feature.feature_id}};
    let task=await f.service.engineering.createTask({project_id:f.project.project_id,goal:'权限受阻',submission_key:'blocked-task',reading});
    const attempt=f.service.engineering.startAttempt(task.task_id,{provider_id:'codex',model:'test',origin:'agent'});task=f.service.engineering.task(task.task_id);
    task=await f.service.engineering.finishTask({task_id:task.task_id,attempt_id:attempt.attempt_id,expected_version:task.version,submission_key:'blocked-finish',status:'blocked',summary:'宿主只读'});
    assert.equal(task.walkthrough?.status,'failed');assert.equal(task.changes.length,0);assert.equal(calls,1);assert.equal(f.service.data().runs.length,1);
  }finally{await close(f.service);await fs.rm(f.directory,{recursive:true,force:true});}
});

test('feature-linked development republishes the same scenario and preserves full MCP and export continuity',async()=>{
  const prompts:string[]=[];let calls=0;
  const runner:typeof runCodex=async options=>{calls++;prompts.push(options.prompt);return {code:0,raw:JSON.stringify(result(options.run,options.snapshot,calls===1?'旧实现说明':`第 ${calls-1} 次开发后的新实现`)),stderr:''};};
  const f=await fixture(runner);let bridge:ArcMcpBridge|undefined,restored:ArcService|undefined;
  try{
    const initial=await f.service.startRun(f.scenario.scenario_id,'codex','initial-feature-reading');await f.service.executing.get(initial.binding.run_id);
    const old=f.service.data().explanations[0],oldNode=old.result.nodes[0];
    const reading={feature_id:f.feature.feature_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,source_snapshot_id:old.result.binding.source_snapshot_id,target:{kind:'node' as const,id:oldNode.node_id}};
    let task=await f.service.engineering.createTask({project_id:f.project.project_id,goal:'保留原始目标和边界',submission_key:'feature-create',reading});
    assert.deepEqual(task.reading,reading);
    await fs.writeFile(path.join(f.root,'main.ts'),'export const value=2;\n');
    task=await f.service.engineering.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:'feature-finish',status:'completed',summary:'真实源码修改已保存（执行由测试夹具完成）'});await f.service.refreshTaskWalkthrough(task.task_id);
    task=f.service.engineering.task(task.task_id);assert.equal(task.status,'completed');assert.equal(task.walkthrough?.status,'completed');
    const renewed=f.service.store.get<import('../src/shared').Explanation>('explanation',task.walkthrough!.result_id!);assert.equal(renewed.scenario_id,old.scenario_id);assert.equal(renewed.result.binding.feature_id,old.result.binding.feature_id);assert.notEqual(renewed.result.binding.source_snapshot_id,old.result.binding.source_snapshot_id);assert.equal(f.service.store.get('explanation',old.result_id).result.summary.text,'旧实现说明');
    const refreshRun=f.service.store.get<Run>('run',renewed.result.binding.run_id);assert.equal(refreshRun.development_task_id,task.task_id);assert.match(prompts.at(-1)!,/重新核对功能入口/);assert.match(prompts.at(-1)!,/不能只读 diff/);
    bridge=new ArcMcpBridge(f.service,path.resolve('.'));await bridge.enable(f.project.project_id);
    const continued=await bridge.call('arc_begin_development',{workspace_path:f.root,task_id:task.task_id,goal:'后续要求原文不变',submission_key:'feature-mcp-continue'});assert.equal(continued.task_id,task.task_id);assert.deepEqual(continued.reading,reading);assert.equal(continued.goal,'保留原始目标和边界');assert.equal(continued.requests.at(-1).text,'后续要求原文不变');
    const finished=await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:continued.version,submission_key:'feature-mcp-finish',status:'completed',summary:'MCP 续接已保存',verification:[]});assert.equal(finished.walkthrough.status,'completed','无代码变化的续接应复用仍匹配的新走读');assert.equal(f.service.data().explanations.length,2);
    const complete=await bridge.call('arc_development_task',{task_id:task.task_id});assert.equal(complete.walkthrough.status,'completed');assert.deepEqual(complete.reading,reading);assert.equal(complete.goal,'保留原始目标和边界');assert.equal(complete.requests[0].text,'后续要求原文不变');assert.ok(Array.isArray(complete.decisions)&&Array.isArray(complete.unresolved)&&Array.isArray(complete.verification));
    const bundle=path.join(f.directory,'feature.json');await f.service.engineering.exportProject(f.project.project_id,bundle);restored=new ArcService(path.join(f.directory,'restored'),path.resolve('.'));await restored.engineering.restoreProject(bundle);const recovered=restored.engineering.task(task.task_id);assert.deepEqual(recovered.reading,reading);assert.equal(recovered.walkthrough!.status,'completed');assert.ok(restored.store.get('explanation',old.result_id));assert.ok(restored.store.get('explanation',recovered.walkthrough!.result_id!));
  }finally{await close(f.service,bridge);if(restored)await close(restored);await fs.rm(f.directory,{recursive:true,force:true});}
});

test('failed walkthrough refresh retains saved code and old explanation, then retries and detects later stale source',async()=>{
  let calls=0,allow=false;
  const runner:typeof runCodex=async options=>{calls++;if(calls>1&&!allow)return {code:1,raw:'',stderr:'analysis unavailable'};return {code:0,raw:JSON.stringify(result(options.run,options.snapshot,calls===1?'原始走读':'修复后的走读')),stderr:''};};
  const f=await fixture(runner);
  try{
    const initial=await f.service.startRun(f.scenario.scenario_id,'codex','initial-before-failure');await f.service.executing.get(initial.binding.run_id);const old=f.service.data().explanations[0];
    const reading={feature_id:f.feature.feature_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,source_snapshot_id:old.result.binding.source_snapshot_id,target:{kind:'feature' as const,id:f.feature.feature_id}};
    let task=await f.service.engineering.createTask({project_id:f.project.project_id,goal:'修改但保留边界',submission_key:'failure-create',reading});await fs.writeFile(path.join(f.root,'main.ts'),'export const value=3;\n');
    task=await f.service.engineering.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:'failure-finish',status:'completed',summary:'开发成果已经保存'});await f.service.refreshTaskWalkthrough(task.task_id);task=f.service.engineering.task(task.task_id);
    assert.equal(task.status,'completed');assert.equal(task.end_state?.fingerprint,f.service.store.get<Snapshot>('snapshot',task.walkthrough!.source_snapshot_id!).fingerprint);assert.equal(task.walkthrough?.status,'failed');assert.match(task.walkthrough?.error||'',/analysis unavailable/);assert.equal(f.service.store.get('explanation',old.result_id).result.summary.text,'原始走读');assert.equal(f.service.data().explanations.length,1);
    allow=true;await f.service.refreshTaskWalkthrough(task.task_id,'retry-feature-walkthrough');task=f.service.engineering.task(task.task_id);assert.equal(task.walkthrough?.status,'completed');assert.equal(f.service.data().explanations.length,2);
    await fs.appendFile(path.join(f.root,'main.ts'),'// changed after the refreshed explanation\n');await f.service.checkFreshness(f.project.project_id);assert.equal(f.service.store.get<import('../src/shared').Explanation>('explanation',task.walkthrough!.result_id!).source_status,'needs_review');
  }finally{await close(f.service);await fs.rm(f.directory,{recursive:true,force:true});}
});

test('Kimi MCP development waits for source rereading and publishes the linked walkthrough',async()=>{
  const runner:typeof runCodex=async options=>({code:0,raw:JSON.stringify(result(options.run,options.snapshot,'初始走读')),stderr:''}),f=await fixture(runner);let bridge:ArcMcpBridge|undefined;
  try{
    const initial=await f.service.startRun(f.scenario.scenario_id,'codex','kimi-initial-reading');await f.service.executing.get(initial.binding.run_id);const old=f.service.data().explanations[0],reading={feature_id:f.feature.feature_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,source_snapshot_id:old.result.binding.source_snapshot_id,target:{kind:'feature' as const,id:f.feature.feature_id}};
    bridge=new ArcMcpBridge(f.service,path.resolve('.'));await bridge.enable(f.project.project_id);const client={name:'Kimi Work',configured_provider:'kimi'};
    const task=await bridge.call('arc_begin_development',{workspace_path:f.root,goal:'按任务边界修改',submission_key:'kimi-begin',reading},client);assert.equal(task.status,'running');await fs.writeFile(path.join(f.root,'main.ts'),'export const value=4;\n');
    const saved=await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:task.version,submission_key:'kimi-finish',status:'completed',summary:'Kimi 外部修改已保存',verification:[]},client);await f.service.refreshTaskWalkthrough(task.task_id);assert.equal(saved.walkthrough.status,'pending');assert.equal(f.service.store.maybe('setting','mcp-requested-analysis').scenario_id,f.scenario.scenario_id);assert.equal(f.service.data().runs.length,1,'Kimi 不应被静默替换为 Codex 分析');
    const begun=await bridge.call('arc_begin_analysis',{scenario_id:f.scenario.scenario_id,request_id:'kimi-refresh',development_task_id:task.task_id},client),run=f.service.store.get<Run>('run',begun.binding.run_id),snapshot=f.service.store.get<Snapshot>('snapshot',run.binding.source_snapshot_id);assert.equal(run.provider_id,'kimi');assert.equal(f.service.engineering.task(task.task_id).walkthrough!.status,'running');
    const submitted=await bridge.call('arc_submit_result',{run_id:run.binding.run_id,result:result(run,snapshot,'Kimi 新版走读')},client);assert.equal(submitted.status,'completed',JSON.stringify(submitted));const completed=f.service.engineering.task(task.task_id);assert.equal(completed.walkthrough!!.status,'completed');assert.equal(completed.walkthrough!!.result_id,submitted.result_id);assert.deepEqual(completed.reading,reading);
  }finally{await close(f.service,bridge);await fs.rm(f.directory,{recursive:true,force:true});}
});

test('continuous development queues the latest walkthrough generation and recovers an inactive pending update',async()=>{
  let calls=0,release=()=>{},started=()=>{};const gate=new Promise<void>(done=>release=done),firstStarted=new Promise<void>(done=>started=done);
  const runner:typeof runCodex=async options=>{calls++;if(calls===2){started();await gate;}return {code:0,raw:JSON.stringify(result(options.run,options.snapshot,calls===1?'初始':calls===2?'中间':'最新')),stderr:''};};
  const f=await fixture(runner);let first:Promise<void>|undefined;
  try{
    const initial=await f.service.startRun(f.scenario.scenario_id,'codex','queue-initial');await f.service.executing.get(initial.binding.run_id);const old=f.service.data().explanations[0],reading={feature_id:f.feature.feature_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,source_snapshot_id:old.result.binding.source_snapshot_id,target:{kind:'feature' as const,id:f.feature.feature_id}};
    let task=await f.service.engineering.createTask({project_id:f.project.project_id,goal:'连续两轮修改',submission_key:'queue-create',reading});await fs.writeFile(path.join(f.root,'main.ts'),'export const value=2;\n');
    task=await f.service.engineering.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:'queue-first-finish',status:'completed'});first=f.service.refreshTaskWalkthrough(task.task_id);await firstStarted;
    await f.service.engineering.createTask({project_id:f.project.project_id,task_id:task.task_id,goal:'第二轮原始要求',submission_key:'queue-second-request'});const attempt=f.service.engineering.startAttempt(task.task_id,{provider_id:'codex',model:'test',origin:'arc'});await fs.writeFile(path.join(f.root,'main.ts'),'export const value=3;\n');
    task=await f.service.engineering.finishTask({task_id:task.task_id,attempt_id:attempt.attempt_id,expected_version:f.service.engineering.task(task.task_id).version,submission_key:'queue-second-finish',status:'completed'});const second=f.service.refreshTaskWalkthrough(task.task_id,'queue-latest');release();await Promise.all([first,second]);
    assert.equal(calls,3,'第二轮走读必须在新代次中执行');assert.equal(f.service.data().explanations.length,3);task=f.service.engineering.task(task.task_id);assert.equal(task.walkthrough!.status,'completed');const latest=f.service.store.get<import('../src/shared').Explanation>('explanation',task.walkthrough!.result_id!);assert.equal(latest.result.summary.text,'最新');assert.equal(f.service.store.get<Snapshot>('snapshot',latest.result.binding.source_snapshot_id).fingerprint,task.end_state!.fingerprint);
    f.service.engineering.saveWalkthrough(task.task_id,{status:'pending',previous_result_id:latest.result_id,result_id:latest.result_id,source_snapshot_id:latest.result.binding.source_snapshot_id,updated_at:new Date().toISOString()});await f.service.refreshTaskWalkthrough(task.task_id,'queue-recover-pending');assert.equal(calls,4);assert.equal(f.service.engineering.task(task.task_id).walkthrough!.status,'completed');
  }finally{release();if(first)await first;await close(f.service);await fs.rm(f.directory,{recursive:true,force:true});}
});

test('Kimi handoff carries its development task, outranks waiting reading questions and refreshes source automatically',async()=>{
  const runner:typeof runCodex=async options=>({code:0,raw:JSON.stringify(result(options.run,options.snapshot,'初始走读')),stderr:''}),f=await fixture(runner);let bridge:ArcMcpBridge|undefined;
  try{
    const initial=await f.service.startRun(f.scenario.scenario_id,'codex','handoff-initial');await f.service.executing.get(initial.binding.run_id);const old=f.service.data().explanations[0],reading={feature_id:f.feature.feature_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,source_snapshot_id:old.result.binding.source_snapshot_id,target:{kind:'feature' as const,id:f.feature.feature_id}};
    bridge=new ArcMcpBridge(f.service,path.resolve('.'));await bridge.enable(f.project.project_id);const client={name:'Kimi Work',configured_provider:'kimi'},task=await bridge.call('arc_begin_development',{workspace_path:f.root,goal:'读取原任务修改',submission_key:'handoff-begin',reading},client);await fs.writeFile(path.join(f.root,'main.ts'),'export const value=5;\n');
    await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:task.version,submission_key:'handoff-finish',status:'completed',summary:'开发已保存',verification:[]},client);await f.service.refreshTaskWalkthrough(task.task_id);
    const offered=await bridge.call('arc_current_project',{},client);assert.equal(offered.requested_analysis.development_task_id,task.task_id);assert.match(offered.requested_analysis.instruction,/development_task_id/);
    const waiting=await f.service.askReading({project_id:f.project.project_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,target:{kind:'feature',id:f.feature.feature_id},question:'另一个阅读追问',mode:'mcp',submission_key:'waiting-reading'});const waitingRunId=waiting.run_id;
    // Standard handoff needs no manually supplied development_task_id or scenario.
    const begun=await bridge.call('arc_begin_analysis',{request_id:'handoff-standard'},client),run=f.service.store.get<Run>('run',begun.binding.run_id);assert.equal(run.development_task_id,task.task_id);assert.equal(run.reading_question_id,undefined);assert.equal(run.binding.scenario_id,f.scenario.scenario_id);assert.equal(f.service.store.get<Run>('run',waitingRunId).status,'waiting_agent');
    const retried=await bridge.call('arc_begin_analysis',{request_id:'handoff-standard'},client);assert.equal(retried.binding.run_id,run.binding.run_id,'pending 已消费后仍须按 request_id 恢复原运行');assert.equal(f.service.store.get<Run>('run',run.binding.run_id).development_task_id,task.task_id);
    const snapshot=f.service.store.get<Snapshot>('snapshot',run.binding.source_snapshot_id),submitted=await bridge.call('arc_submit_result',{run_id:run.binding.run_id,result:result(run,snapshot,'自动领取的新版')},client);assert.equal(submitted.status,'completed',JSON.stringify(submitted));assert.equal(f.service.store.get<import('../src/shared').Project>('project',f.project.project_id).snapshot_id,run.binding.source_snapshot_id);assert.equal(f.service.store.get<import('../src/shared').Explanation>('explanation',submitted.result_id).source_status,'current');
    const second=await f.service.engineering.createTask({project_id:f.project.project_id,goal:'显式开发后复核',submission_key:'explicit-create',reading});f.service.engineering.saveWalkthrough(second.task_id,{status:'pending',previous_result_id:old.result_id,updated_at:new Date().toISOString()});const explicit=await bridge.call('arc_begin_analysis',{request_id:'explicit-development-priority',development_task_id:second.task_id},client);assert.equal(explicit.binding.scenario_id,f.scenario.scenario_id);assert.equal(explicit.question_id,undefined);assert.equal(f.service.store.get<Run>('run',explicit.binding.run_id).development_task_id,second.task_id);assert.equal(f.service.store.get<Run>('run',waitingRunId).status,'waiting_agent');
  }finally{await close(f.service,bridge);await fs.rm(f.directory,{recursive:true,force:true});}
});

test('second development during an active Kimi review is registered after the old run finishes',async()=>{
  const runner:typeof runCodex=async options=>({code:0,raw:JSON.stringify(result(options.run,options.snapshot,'初始走读')),stderr:''}),f=await fixture(runner);let bridge:ArcMcpBridge|undefined;
  try{
    const initial=await f.service.startRun(f.scenario.scenario_id,'codex','external-queue-initial');await f.service.executing.get(initial.binding.run_id);const old=f.service.data().explanations[0],reading={feature_id:f.feature.feature_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,source_snapshot_id:old.result.binding.source_snapshot_id,target:{kind:'feature' as const,id:f.feature.feature_id}};
    bridge=new ArcMcpBridge(f.service,path.resolve('.'));await bridge.enable(f.project.project_id);const client={name:'Kimi Work',configured_provider:'kimi'},task=await bridge.call('arc_begin_development',{workspace_path:f.root,goal:'两轮外部修改',submission_key:'external-queue-begin',reading},client);await fs.writeFile(path.join(f.root,'main.ts'),'export const value=2;\n');
    await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:task.version,submission_key:'external-queue-first-finish',status:'completed',summary:'第一轮已保存',verification:[]},client);await f.service.refreshTaskWalkthrough(task.task_id);const first=await bridge.call('arc_begin_analysis',{request_id:'external-queue-first-review'},client),firstRun=f.service.store.get<Run>('run',first.binding.run_id);assert.equal(firstRun.development_task_id,task.task_id);
    const continued=await bridge.call('arc_begin_development',{workspace_path:f.root,task_id:task.task_id,goal:'第二轮原始要求',submission_key:'external-queue-second-begin'},client);await fs.writeFile(path.join(f.root,'main.ts'),'export const value=3;\n');const finished=await bridge.call('arc_finish_development',{task_id:task.task_id,expected_version:continued.version,submission_key:'external-queue-second-finish',status:'completed',summary:'第二轮已保存',verification:[]},client);assert.equal(finished.walkthrough.status,'pending');const queued=f.service.refreshTaskWalkthrough(task.task_id);assert.equal(f.service.store.maybe('setting','mcp-requested-analysis'),null,'旧复核尚未结束，不能把它当成最新复核');
    const firstSnapshot=f.service.store.get<Snapshot>('snapshot',firstRun.binding.source_snapshot_id);await bridge.call('arc_submit_result',{run_id:firstRun.binding.run_id,result:result(firstRun,firstSnapshot,'旧复核结果')},client);await queued;const pending=f.service.engineering.task(task.task_id);assert.equal(pending.walkthrough!.status,'pending');const offered=await bridge.call('arc_current_project',{},client);assert.equal(offered.requested_analysis.development_task_id,task.task_id);assert.equal(f.service.store.get<Snapshot>('snapshot',offered.requested_analysis.source_snapshot_id).fingerprint,pending.end_state!.fingerprint);
    const second=await bridge.call('arc_begin_analysis',{request_id:'external-queue-second-review'},client),secondRun=f.service.store.get<Run>('run',second.binding.run_id);assert.notEqual(secondRun.binding.run_id,firstRun.binding.run_id);assert.equal(secondRun.development_task_id,task.task_id);const secondSnapshot=f.service.store.get<Snapshot>('snapshot',secondRun.binding.source_snapshot_id);assert.equal(secondSnapshot.fingerprint,pending.end_state!.fingerprint);const submitted=await bridge.call('arc_submit_result',{run_id:secondRun.binding.run_id,result:result(secondRun,secondSnapshot,'第二轮新版走读')},client);assert.equal(submitted.status,'completed',JSON.stringify(submitted));const completed=f.service.engineering.task(task.task_id);assert.equal(completed.walkthrough!.status,'completed');assert.equal(completed.walkthrough!.result_id,submitted.result_id);
  }finally{await close(f.service,bridge);await fs.rm(f.directory,{recursive:true,force:true});}
});

test('explicit reading question bypasses pending development inference while mutually exclusive identities are rejected',async()=>{
  const runner:typeof runCodex=async options=>({code:0,raw:JSON.stringify(result(options.run,options.snapshot,'初始走读')),stderr:''}),f=await fixture(runner);let bridge:ArcMcpBridge|undefined;
  try{
    const initial=await f.service.startRun(f.scenario.scenario_id,'codex','route-initial');await f.service.executing.get(initial.binding.run_id);const old=f.service.data().explanations[0],reading={feature_id:f.feature.feature_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,source_snapshot_id:old.result.binding.source_snapshot_id,target:{kind:'feature' as const,id:f.feature.feature_id}},task=await f.service.engineering.createTask({project_id:f.project.project_id,goal:'开发后待复核',submission_key:'route-create',reading});f.service.prepareAnalysis(f.scenario.scenario_id,task.task_id);
    const waiting=await f.service.askReading({project_id:f.project.project_id,scenario_id:f.scenario.scenario_id,result_id:old.result_id,target:{kind:'feature',id:f.feature.feature_id},question:'明确阅读追问',mode:'mcp',submission_key:'route-waiting'});bridge=new ArcMcpBridge(f.service,path.resolve('.'));await bridge.enable(f.project.project_id);const client={name:'Kimi Work',configured_provider:'kimi'};
    await assert.rejects(bridge.call('arc_begin_analysis',{request_id:'route-exclusive',question_id:waiting.question_id,development_task_id:task.task_id},client),/归属不一致/);assert.equal(f.service.store.get<Run>('run',waiting.run_id).status,'waiting_agent');
    const claimed=await bridge.call('arc_begin_analysis',{request_id:'route-explicit-question',question_id:waiting.question_id},client);assert.equal(claimed.question_id,waiting.question_id);assert.equal(claimed.binding.run_id,waiting.run_id);assert.equal(f.service.store.get<Run>('run',waiting.run_id).development_task_id,undefined);assert.equal(f.service.store.maybe('setting','mcp-requested-analysis').development_task_id,task.task_id,'显式追问不应消费开发后待领取记录');
  }finally{await close(f.service,bridge);await fs.rm(f.directory,{recursive:true,force:true});}
});
