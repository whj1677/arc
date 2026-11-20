import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {developmentArguments,developmentPrompt,developmentSandboxArguments,developmentSandboxError,supportsDevelopmentSandboxProbe} from '../src/main/development-runner';
import {codexRequirementPlanSchema,readRequirementPlan,requirementPrompt} from '../src/main/dsh-development';
import type {EngineeringContext,EngineeringTask} from '../src/engineering';
import {callArcWithOutbox,pendingDevelopmentWrites,flushDevelopmentWrites,queueDevelopmentWrite} from '../src/main/development-outbox';
import {ArcService} from '../src/main/service';
import {ArcMcpBridge,bridgeTools} from '../src/main/mcp-bridge';
import {resolveDevelopmentScope} from '../src/main/development-scope';

async function temporary(){const root=path.resolve('.test-data');await fs.mkdir(root,{recursive:true});return fs.mkdtemp(path.join(root,'development-execution-'));}
test('development uses actual workspace, host model, exact permission profile and no escalation',()=>{
  const args=developmentArguments('C:\\工程 workspace','schema.json','result.json',['-c','default_permissions="arc-files-test"']);
  assert.equal(args[args.indexOf('--cd')+1],'C:\\工程 workspace');assert.ok(!args.includes('--sandbox'));
  assert.deepEqual(args.slice(0,3),['-a','never','exec']);assert.ok(args.includes('default_permissions="arc-files-test"'));assert.ok(!args.includes('-m'));assert.ok(!args.join(' ').includes('danger'));
  assert.match(developmentPrompt({task_id:'task-a',workspace_path:'real-workspace',goal:'fix typo'} as any,{} as any,['src/cart.mjs']),/src\/cart\.mjs/);
});
test('development exec passes a selected model and effort, leaving automatic effort to Codex',()=>{
  const args=(effort:'auto'|'high')=>developmentArguments('workspace','schema','output',[],{model:'local-model',reasoning_effort:effort});
  const high=args('high'),modelIndex=high.indexOf('-m');
  assert.deepEqual(high.slice(modelIndex,modelIndex+4),['-m','local-model','-c','model_reasoning_effort="high"']);
  assert.ok(!args('auto').some(arg=>arg.startsWith('model_reasoning_effort=')));
});
test('approved prompts use current behaviors, boundaries and host commands without superseded requests',()=>{
  const task={task_id:'current',workspace_path:'workspace',workflow:'execution',goal:'old-goal',
    summary:'old-summary',requests:[{text:'old-request'}],unresolved:['old-issue'],
    approval:{reviewed_version:3,scope:['current.ts']},decisions:['keep-current-decision'],
    requirement_package:{behaviors:[{behavior:'effective-behavior'}],assumptions:['old-assumption'],non_goals:['removed-boundary']},
    boundaries:{non_goals:['preserve-export'],revoked:['cancel-webhook']},
    steps:[{step_id:'now',title:'current-step',change:'implement',status:'pending',criteria:[{criterion_id:'verify',text:'check-current'}]},
      {title:'old-step',status:'superseded'}],
  } as EngineeringTask;
  const context={environment_brief:'测试：npm run verify-local',knowledge_brief:'调用：readCart -> price (cart.ts)',entries:[{text:'old-material'}]} as EngineeringContext;
  for(const prompt of [developmentPrompt(task,context,task.approval!.scope),requirementPrompt(task,context)]){
    assert.equal(prompt.split(context.knowledge_brief!).length,2);
    for(const expected of ['effective-behavior','current.ts','current-step','check-current','keep-current-decision','preserve-export','cancel-webhook','测试：npm run verify-local'])assert.ok(prompt.includes(expected),expected);
    for(const old of ['old-goal','old-summary','old-request','old-issue','old-assumption','removed-boundary','old-step','old-material'])assert.ok(!prompt.includes(old),old);
  }
  const codex=developmentPrompt(task,context,task.approval!.scope,'npm test: expected 2, got 1');
  assert.match(codex,/自动修复反馈[\s\S]*npm test: expected 2, got 1/);
  for(const guard of ['禁止空跑或跳过测试冒充通过','禁止将未定义行为','严守授权文件范围'])assert.ok(codex.includes(guard));
  const planning=requirementPrompt({...task,workflow:'analysis',boundaries:undefined},context);
  for(const expected of ['old-goal','old-request','old-material','assumptions','open_questions','non_goals','revoked','removed-boundary','npm run verify-local'])assert.ok(planning.includes(expected),expected);
});
test('plan contract accepts existing packages and validates optional structured lists',()=>{
  const behavior={id:'a',behavior:'show value',design:'existing export',files:['a.ts'],step_ids:['update'],verification:'test value'};
  const step={step_id:'update',title:'update',change:'value',status:'pending',progress:'waiting',criteria:[{criterion_id:'value',text:'read value',evidence_ids:[]}],evidence_ids:[],unresolved:[]};
  const plan={summary:'Change value',steps:[step],proposed_scope:['a.ts'],requirement_package:{behaviors:[behavior]},decisions:[],unresolved:[]};
  assert.deepEqual(readRequirementPlan(JSON.stringify(plan)),plan);
  const pkg={...plan.requirement_package,assumptions:['A'],open_questions:['Q'],non_goals:['N'],revoked:['R']};
  assert.deepEqual(readRequirementPlan(JSON.stringify({...plan,requirement_package:pkg})).requirement_package,pkg);
  assert.throws(()=>readRequirementPlan(JSON.stringify({...plan,requirement_package:{...pkg,revoked:Array(41).fill('x')}})),/结构检查/);
  assert.throws(()=>readRequirementPlan(JSON.stringify({...plan,requirement_package:{...pkg,assumptions:'A'}})),/结构检查/);
  assert.deepEqual((codexRequirementPlanSchema.properties.requirement_package as {required:string[]}).required,Object.keys(pkg));
});
test('file authorization refuses directories, metadata, wildcards, traversal and hard links',async()=>{
  const directory=await temporary();
  try{
    await fs.mkdir(path.join(directory,'src'));
    await fs.mkdir(path.join(directory,'.git'));
    const source=path.join(directory,'src','cart.mjs');
    await fs.writeFile(source,'source');await fs.writeFile(path.join(directory,'.git','HEAD'),'metadata');
    assert.deepEqual(await resolveDevelopmentScope(directory,['src/cart.mjs']),[await fs.realpath(source)]);
    for(const scope of [[],['src'],['src/*.mjs'],['../cart.mjs'],['.git/HEAD'],['src/cart.mjs:other']])await assert.rejects(resolveDevelopmentScope(directory,scope));
    await fs.link(source,path.join(directory,'alias.mjs'));
    await assert.rejects(resolveDevelopmentScope(directory,['src/cart.mjs']),/硬链接/);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('Windows sandbox preflight preserves managed permissions and reports identity failures before model dispatch',()=>{
  const args=developmentSandboxArguments('C:\\工作 区');
  assert.ok(args.includes('--include-managed-config'));assert.equal(args[args.indexOf('--permission-profile')+1],':workspace');assert.equal(args[args.indexOf('--cd')+1],'C:\\工作 区');assert.ok(!args.join(' ').includes('danger'));
  const error=developmentSandboxError({stderr:'registered Core process has no package identity'});assert.equal(error.environmentBlocked,true);assert.match(error.message,/尚未调用模型/);assert.match(error.message,/不会移除身份检查/);
  assert.match(developmentSandboxError({killed:true,message:'Command failed'}).message,/预检超时/);
  assert.match(developmentSandboxError({stderr:'CreateRestrictedToken failed: 87'}).message,/CreateRestrictedToken 87/);
  assert.equal(supportsDevelopmentSandboxProbe('--include-managed-config --permission-profile --cd'),true);assert.equal(supportsDevelopmentSandboxProbe('Usage: codex sandbox windows'),false);
});
test('offline completion persists across clients, retries idempotently, and never reports sync success',async()=>{
  const directory=await temporary(),file=path.join(directory,'connection.json');
  const request={name:'arc_finish_development',args:{task_id:'t',expected_version:1,submission_key:'finish-1',status:'completed',summary:'done'},client:{configured_provider:'codex'}};
  let server:http.Server|undefined;
  try{
    await fs.writeFile(file,JSON.stringify({url:'http://127.0.0.1:1/tool',token:'test-only'}));
    const result=await callArcWithOutbox(file,request);assert.equal(result.saved,'pending_sync');
    assert.equal((await pendingDevelopmentWrites(file)).length,1);
    await callArcWithOutbox(file,request);assert.equal((await pendingDevelopmentWrites(file)).length,1);
    await assert.rejects(queueDevelopmentWrite(file,{...request,args:{...request.args,summary:'conflicting'}}),/不同待同步内容/);
    const accepted=new Set<string>();let requests=0;
    server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const entry=JSON.parse(body);requests++;accepted.add(entry.args.submission_key);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:{saved:'saved'}}));});
    await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
    await fs.writeFile(file,JSON.stringify({url:`http://127.0.0.1:${(server.address() as any).port}/tool`,token:'test-only'}));
    const {sendArcTool}=await import('../src/main/development-outbox');
    const flushed=await flushDevelopmentWrites(file,value=>sendArcTool(file,value));assert.equal(flushed[0].saved,'saved');assert.equal((await pendingDevelopmentWrites(file)).length,0);assert.equal(requests,1);assert.equal(accepted.size,1);
  }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
});
test('server validation failure remains inspectable and is not relabelled as offline success',async()=>{
  const directory=await temporary(),file=path.join(directory,'connection.json');
  const server=http.createServer((_req,res)=>{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'VERSION_CONFLICT'}));});
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));await fs.writeFile(file,JSON.stringify({url:`http://127.0.0.1:${(server.address() as any).port}/tool`,token:'test'}));
    await assert.rejects(callArcWithOutbox(file,{name:'arc_finish_development',args:{task_id:'t',expected_version:1,submission_key:'key'},client:{}}),/VERSION_CONFLICT/);
    assert.equal((await pendingDevelopmentWrites(file)).length,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
});
test('external development scopes real workspace, preserves reading path and records self-reported verification',async()=>{
  const directory=await temporary(),source=path.join(directory,'工作 区');await fs.mkdir(source);await fs.writeFile(path.join(source,'main.ts'),'export const value=1;\n');
  const service=new ArcService(path.join(directory,'data'),path.resolve('.')),project=await service.openProject(source),bridge=new ArcMcpBridge(service,path.resolve('.'));
  try{
    await bridge.start();await bridge.enable(project.project_id);
    const context=await bridge.call('arc_engineering_context',{workspace_path:source});assert.equal(context.project_id,project.project_id);
    await assert.rejects(bridge.call('arc_engineering_context',{workspace_path:directory}),/绑定|归属/);
    const task=await bridge.call('arc_begin_development',{workspace_path:source,goal:'change value',submission_key:'begin'});
    assert.equal((await bridge.call('arc_begin_development',{workspace_path:source,goal:'change value',submission_key:'begin'})).task_id,task.task_id);
    await assert.rejects(bridge.call('arc_begin_development',{workspace_path:source,goal:'overlap',submission_key:'different'}),/已有开发任务/);
    await assert.rejects(service.development.start({project_id:project.project_id,goal:'overlap from ARC',submission_key:'arc-other',scope:['main.ts']}),/已有开发任务/);
    const otherTask=await service.engineering.createTask({project_id:project.project_id,goal:'overlap in shared service',submission_key:'shared-other'});
    assert.throws(()=>service.engineering.startAttempt(otherTask.task_id,{provider_id:'codex',model:'test',origin:'arc'}),/已有开发任务/);
    const second=path.join(directory,'second');await fs.mkdir(second);await fs.writeFile(path.join(second,'b.ts'),'export const b=1;');
    const secondProject=await service.openProject(second);
    await assert.rejects(bridge.call('arc_engineering_context',{workspace_path:second}),/授权/);
    await bridge.enable(secondProject.project_id);
    const independent=await bridge.call('arc_begin_development',{workspace_path:second,goal:'different workspace',submission_key:'second'});
    assert.equal(independent.status,'running');
    assert.equal((await bridge.call('arc_engineering_context',{workspace_path:source})).project_id,project.project_id,'changing the selected project cannot rebind a connected session');
    await fs.writeFile(path.join(source,'main.ts'),'export const value=2;\n');
    const after=await bridge.call('arc_engineering_context',{workspace_path:source});
    const finish={task_id:task.task_id,expected_version:task.version,submission_key:'finish',status:'completed',summary:'Changed value',verification:[{evidence_id:'check',command:'node check.mjs',cwd:source,outcome:'passed',exit_code:0,origin:'observed',code_state:after.code_state,created_at:new Date().toISOString()}]};
    const saved=await bridge.call('arc_finish_development',finish);
    assert.equal(saved.changes[0].path,'main.ts');assert.equal(saved.verification[0].origin,'self_reported');assert.equal(saved.verification_status,'partial');
    assert.deepEqual(await bridge.call('arc_finish_development',finish),saved);
    const repeated=await bridge.call('arc_begin_development',{workspace_path:source,goal:'change value',submission_key:'begin'});assert.equal(repeated.status,'completed');assert.equal(repeated.attempt_ids.length,1,'retrying a previously completed begin cannot dispatch a new attempt');
    const continued=await bridge.call('arc_begin_development',{workspace_path:source,goal:'continue',submission_key:'continue',task_id:task.task_id});
    assert.equal(continued.task_id,task.task_id);assert.equal(continued.attempt_ids.length,2);
    assert.ok(bridgeTools.some(t=>t.name==='arc_read_source'));assert.ok(bridgeTools.some(t=>t.name==='arc_begin_analysis'));
  }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(directory,{recursive:true,force:true});}
});
for(const changedAfterQueue of [false,true])test(`queued completion across ARC restart (workspace changed after queue: ${changedAfterQueue})`,async()=>{
  const directory=await temporary(),source=path.join(directory,'source'),data=path.join(directory,'data');await fs.mkdir(source);await fs.writeFile(path.join(source,'main.ts'),'export const value=1;\n');
  execFileSync('git',['-C',source,'init'],{stdio:'ignore',windowsHide:true});
  let service=new ArcService(data,path.resolve('.')),bridge=new ArcMcpBridge(service,path.resolve('.'));
  try{
    const project=await service.openProject(source);await bridge.start();await bridge.enable(project.project_id);
    const task=await bridge.call('arc_begin_development',{workspace_path:source,goal:'external change while ARC is closed',submission_key:'begin'}),connectionFile=bridge.connectionFile;
    await bridge.close();await service.shutdown();service.store.close();
    await fs.writeFile(path.join(source,'main.ts'),'export const value=2;\n');
    const queued=await callArcWithOutbox(connectionFile,{name:'arc_finish_development',args:{task_id:task.task_id,expected_version:task.version,submission_key:'offline-finish',status:'completed',summary:'外部会话完成；验证未执行',verification:[]},client:{configured_provider:'codex'}});
    assert.equal(queued.saved,'pending_sync');
    if(changedAfterQueue)await fs.writeFile(path.join(source,'later.bin'),Buffer.from([0,42]));
    service=new ArcService(data,path.resolve('.'));bridge=new ArcMcpBridge(service,path.resolve('.'));await bridge.start();
    const saved=service.engineering.task(task.task_id);assert.equal(saved.status,'completed');assert.deepEqual(saved.changes.map(c=>c.path),changedAfterQueue?[]:['main.ts']);assert.equal(saved.changes_status,changedAfterQueue?'needs_review':undefined);assert.equal(!!saved.end_state,!changedAfterQueue);assert.equal(saved.verification_status,'not_run');assert.equal((await bridge.pendingWrites()).length,0);
  }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(directory,{recursive:true,force:true});}
});
