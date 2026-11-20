import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ArcService} from '../src/main/service';
import {DevelopmentService,commandBody} from '../src/main/development-service';
import type {runDevelopmentCodex} from '../src/main/development-runner';
import {developmentSandboxError} from '../src/main/development-runner';
import type {runHostVerification} from '../src/main/development-verify';
import type {reviewDevelopmentDiff} from '../src/main/development-review';
import {auditDelivery,sameVerificationState} from '../src/delivery-audit';
import type {ProviderProfile} from '../src/shared';
import type {runCodex} from '../src/main/providers';
import {DshMalformedReply,type runDshWeb} from '../src/main/dsh-web';

const exec=promisify(execFile);
const profile:ProviderProfile={provider_id:'codex',requested_name:'codex',product:'test double',status:'available',path:process.execPath,version:'simulated',reason:'test double; no model call',transport:'test',auth:'test',capabilities:{},checked_at:new Date().toISOString()};
const probe=async()=>[profile];
const configuration=async()=>({model:'test-configured-model',source:'configured' as const});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
async function fixture(){
  const root=path.resolve('.test-data');await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'development-service-')),source=path.join(directory,'真实 工作区');await fs.mkdir(source);
  await fs.writeFile(path.join(source,'main.ts'),'export const value=1;\n');await fs.writeFile(path.join(source,'README.md'),'Test fixture only\n');
  await exec('git',['init',source],{windowsHide:true});await exec('git',['-C',source,'add','.'],{windowsHide:true});await exec('git',['-C',source,'-c','user.name=ARC Test','-c','user.email=arc-test@example.invalid','commit','-m','fixture'],{windowsHide:true});
  const service=new ArcService(path.join(directory,'data'),path.resolve('.')),project=await service.openProject(source);
  return {directory,source,service,project,close:async()=>{await service.shutdown();service.store.close();await fs.rm(directory,{recursive:true,force:true});}};
}
const completed=(taskId:string,verification:any[]=[])=>({code:0,raw:'{}',stderr:'',commands:[],session_id:'simulated-session',result:{task_id:taskId,status:'completed' as const,summary:'Test change',decisions:[],unresolved:[],verification}});
const gitCheck="git diff --check; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git diff -- src/cart.mjs notes.txt; git status --short; if ((Get-FileHash -Algorithm SHA256 notes.txt).Hash -ne 'C4DBF5060D43AB26067554E2B9AEFB6A01E0E61EB676040B7E7CB7ACD0BEE5E3') { throw 'notes.txt changed during this task' }";
const gitReceipt=String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git diff --check; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git diff -- src/cart.mjs notes.txt; git status --short; if ((Get-FileHash -Algorithm SHA256 notes.txt).Hash -ne '"'C4DBF5060D43AB26067554E2B9AEFB6A01E0E61EB676040B7E7CB7ACD0BEE5E3') { throw 'notes.txt changed during this task' }"`;

test('command matcher unwraps exact shell body without turning unrelated output into test evidence',()=>{
  assert.equal(commandBody('powershell.exe -NoProfile -Command "npm test"'),'npm test');
  assert.equal(commandBody(gitReceipt),gitCheck);
  assert.equal(commandBody(String.raw`pwsh.exe -Command "git diff --check; git diff -- 'C:\\project\\cart.mjs'; Write-Output \"done\""`),String.raw`git diff --check; git diff -- 'C:\project\cart.mjs'; Write-Output "done"`);
  assert.notEqual(commandBody(gitReceipt),gitCheck.replace('-ne','-eq'));
  assert.notEqual(commandBody(gitReceipt),gitCheck.replace("'notes.txt changed during this task'",'"notes.txt changed during this task"'));
  assert.notEqual(commandBody(gitCheck),gitCheck.replace(/'/g,''));
  assert.notEqual(commandBody('my-pwsh.exe -Command "npm test"'),'npm test');
  assert.notEqual(commandBody('echo npm test'),'npm test');
  assert.notEqual(commandBody('npm test; echo failed'),'npm test');
});
const requirementPlan={summary:'Approve the change to the existing value',proposed_scope:['main.ts'],decisions:[],unresolved:[],
  requirement_package:{behaviors:[{id:'value',behavior:'Expose value 2',design:'Update the existing export',files:['main.ts'],step_ids:['update'],verification:'Check the value'}]},
  steps:[{step_id:'update',title:'Update the value',change:'Change the export',status:'pending',progress:'Awaiting approval',criteria:[{
    criterion_id:'value',text:'The value is 2',evidence_ids:[],
  }],evidence_ids:[],unresolved:[]}],
};

async function runQualityGate(t:TestContext,hostRuns:('pass'|'fail'|'skip'|'partial')[],reviews:('approved'|'needs_fix')[],
  {blockers=[],summary,sandboxCommand='npm test',fast=false,waitForHost=false,editAfterHost=false}:{blockers?:string[];summary?:string;sandboxCommand?:string;fast?:boolean;waitForHost?:boolean;editAfterHost?:boolean}={}) {
  const f=await fixture(),calls:string[]=[],feedback:string[]=[];
  const runner:typeof runDevelopmentCodex=async options=>{
    calls.push('edit');
    assert.deepEqual(options.writeScope,['main.ts']);
    if(options.repairFeedback)feedback.push(options.repairFeedback);
    const needsRepair=hostRuns[0]==='fail'||reviews[0]==='needs_fix';
    await fs.writeFile(path.join(f.source,'main.ts'),`export const value=${needsRepair&&!feedback.length?0:2};\n`);
    const reply=completed(options.task.task_id);
    if(waitForHost){
      const waiting='等待 ARC 宿主在本机执行 npm test 并回填结果';
      await options.saveSteps!(options.task.steps!.map(step=>step.step_id==='update'
        ? {...step,status:'in_progress',progress:'修改已完成，'+waiting,unresolved:[waiting]}
        : {...step,status:'completed',progress:'已回读确认 sum.mjs:1 的公开导出返回 a + b。代码修改完成，现有 npm run test 等待 ARC 宿主运行。',unresolved:[]}));
      return {...reply,result:{...reply.result,unresolved:[waiting,'等待 ARC 宿主验证后仍需人工验收','仍需现场验收']}};
    }
    if(!blockers.length&&!summary)return reply;
    await options.commandCompleted!({id:'sandbox',command:`pwsh.exe -Command "${sandboxCommand}"`,cwd:f.source,cwd_source:'task_workspace',exit_code:1,
      output:'spawn EPERM',completed_at:new Date().toISOString()});
    return {...reply,result:{...reply.result,status:'blocked',summary:summary??'沙箱中无法完成验证',unresolved:blockers,
      verification:[{command:sandboxCommand,outcome:'blocked',note:blockers[0]??summary!,step_id:'update',criterion_id:'value'}]}};
  };
  let hostCount=0,reviewCount=0;
  const host:typeof runHostVerification=async options=>{
    calls.push('host');
    const status=hostRuns[hostCount++];
    assert.ok(status,'unexpected host verification');
    assert.equal(options.workspace,f.source);
    assert.equal(options.env.project_id,f.project.project_id);
    const skipped=status==='skip'||status==='partial'?['本机缺少 CMake，已跳过本地构建。']:[];
    if(status==='skip')return {commands:[],failed:[],skipped};
    const code=status==='fail'?1:0;
    const command={id:'host-'+hostCount,command:waitForHost?'npm run test':'npm test',cwd:options.workspace,cwd_source:'task_workspace' as const,exit_code:code,
      output:'# tests 1\n# pass '+(1-code)+'\n# fail '+code+(code?'\nexpected 2, got 0':''),completed_at:new Date().toISOString()};
    await options.onCommand!(command);
    if(editAfterHost)await fs.writeFile(path.join(f.source,'main.ts'),'export const value=3;\n');
    return {commands:[command],failed:code?[{command:command.command,exit_code:code,reason:'assertion failed',output:command.output}]:[],skipped};
  };
  const review:typeof reviewDevelopmentDiff=async options=>{
    calls.push('review');
    const verdict=reviews[reviewCount++];
    assert.ok(verdict,'unexpected diff review');
    assert.deepEqual(options.writeScope,['main.ts']);
    assert.match(options.verificationSummary,hostRuns[hostCount-1]==='skip'?/缺少 CMake/:/npm (?:run )?test/);
    return {verdict,summary:verdict==='approved'?'边界条件已覆盖':'缺少空值处理',notes:[],
      blocking_issues:verdict==='approved'?[]:[{file:'main.ts',issue:'空值导致异常',fix:'空值应返回 0'}]};
  };
  const plan=structuredClone(requirementPlan);
  if(waitForHost){
    plan.requirement_package.behaviors[0].step_ids.push('check');
    plan.steps.push({...plan.steps[0],step_id:'check',title:'Verify the updated export',criteria:[
      {criterion_id:'signature',text:'Keep the public export',evidence_ids:[]},{criterion_id:'addition',text:'Return a + b',evidence_ids:[]}]});
  }
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,configuration,
    async()=>({code:0,raw:JSON.stringify(plan),stderr:''}),undefined,host,review);
  t.after(async()=>{await development.shutdown();await f.close();});
  const input={project_id:f.project.project_id,goal:'修改 main.ts 的导出值',submission_key:'quality-plan'};
  const task=fast?await development.start({...input,fast_mode:true,scope:['main.ts']}):await development.submit(input,'codex');
  const finish=async()=>{await Promise.all([...development.executing.values()]);return f.service.engineering.currentTask(task.task_id);};
  if(!fast){
    const plan=await finish();
    assert.deepEqual(calls,[]);
    await development.submit({...input,submission_key:'quality-approve',task_id:task.task_id,expected_version:plan.version,
      phase:'execution',scope:['main.ts']},'codex');
  }
  const saved=await finish();
  return {saved,feedback,calls,directory:f.service.directory,stages:development.events(task.task_id).events.map(event=>event.stage)};
}

test('host failure gets one repair and recheck, with all observed receipts bound to the edited code',async t=>{
  const {saved,feedback,calls,directory,stages}=await runQualityGate(t,['fail','pass'],['approved']);
  assert.deepEqual(calls,['edit','host','edit','host','review']);
  assert.equal(stages.filter(stage=>stage==='host_verify_repair').length,1);
  assert.equal(feedback.length,1);
  for(const detail of ['npm test','assertion failed','expected 2, got 0'])assert.ok(feedback[0].includes(detail));
  assert.equal(saved.status,'completed');
  assert.equal(saved.verification_status,'passed');
  assert.deepEqual(saved.verification.map(v=>[v.origin,v.exit_code,v.metrics?.passed]),[['observed',1,0],['observed',0,1]]);
  const [old,current]=saved.verification;
  assert.equal(sameVerificationState(old.code_state,saved.end_state!),false);
  assert.ok(sameVerificationState(current.code_state,saved.end_state!));
  assert.equal(current.code_state_verified,true);
  const logs=Object.fromEntries(await Promise.all(saved.verification.map(async v=>[v.evidence_id,await fs.readFile(path.join(directory,v.log_path!),'utf8')])));
  assert.match(logs[old.evidence_id],/expected 2, got 0/);
  assert.equal(auditDelivery(saved,[],logs).verification.status,'passed');
});

test('a repeated host failure stays failed and never reaches the independent reviewer',async t=>{
  const {saved,calls}=await runQualityGate(t,['fail','fail'],[]);
  assert.deepEqual(calls,['edit','host','edit','host']);
  assert.equal(saved.status,'failed');assert.equal(saved.verification_status,'failed');
  assert.match(saved.unresolved.join('\n'),/npm test/);
});

test('diff blockers trigger one bounded repair, another host check and a fresh independent verdict',async t=>{
  for(const finalVerdict of ['approved','needs_fix'] as const){
    const {saved,feedback,calls,stages}=await runQualityGate(t,['pass','pass'],['needs_fix',finalVerdict]);
    assert.deepEqual(calls,['edit','host','review','edit','host','review']);
    assert.equal(stages.filter(stage=>stage==='delivery_review_repair').length,1);
    assert.equal(feedback.length,1);
    for(const detail of ['main.ts','空值导致异常','空值应返回 0'])assert.ok(feedback[0].includes(detail));
    if(finalVerdict==='approved'){
      assert.deepEqual(saved.diff_review,{verdict:'approved',summary:'边界条件已覆盖',repaired:true});
      assert.equal(saved.status,'completed');assert.equal(saved.verification_status,'passed');
      assert.match(saved.decisions.join('\n'),/边界条件已覆盖/);
    }else{
      assert.deepEqual(saved.diff_review,{verdict:'needs_fix',summary:'缺少空值处理'});
      assert.equal(saved.status,'blocked');
      assert.match(saved.unresolved.join('\n'),/空值导致异常/);
    }
  }
});

test('an unavailable toolchain reaches review without manufacturing a verification pass',async t=>{
  const {saved,calls}=await runQualityGate(t,['skip'],['approved']);
  assert.deepEqual(calls,['edit','host','review']);
  assert.equal(saved.status,'completed');assert.equal(saved.verification_status,'not_run');
  assert.deepEqual(saved.verification,[]);
  assert.match(saved.decisions.join('\n'),/缺少 CMake/);
  const mixed=await runQualityGate(t,['partial'],['approved']);
  assert.equal(mixed.saved.status,'completed');
  assert.equal(mixed.saved.verification[0].outcome,'passed');
  assert.equal(mixed.saved.verification_status,'partial');
  assert.equal(auditDelivery(mixed.saved,[]).verification.status,'partial');
});

test('only a resolved sandbox verification blocker can be promoted by a passing host receipt',async t=>{
  const sandbox='沙箱内 npm test 遇到 spawn EPERM，无法运行测试';
  for(const [host,blockers,summary,sandboxCommand,expected] of [
    ['pass',[sandbox],undefined,'npm test','completed'],
    ['pass',[sandbox,'业务规则缺少确认'],undefined,'npm test','blocked'],
    ['skip',[sandbox],undefined,'npm test','blocked'],
    ['pass',[sandbox],'缺少业务规则确认，尚未实现对应逻辑','npm test','blocked'],
    ['pass',['沙箱内 npm run build 遇到 EACCES，无法构建'],undefined,'npm run build','blocked'],
  ] as const){
    const {saved,calls}=await runQualityGate(t,[host],['approved'],{blockers:[...blockers],summary,sandboxCommand});
    assert.deepEqual(calls,['edit','host','review']);
    assert.equal(saved.status,expected,JSON.stringify({host,blockers,summary:saved.summary,unresolved:saved.unresolved}));
    if(expected==='completed'){
      assert.deepEqual(saved.unresolved,[]);assert.equal(saved.verification_status,'passed');
      assert.deepEqual(saved.verification.map(v=>[v.origin,v.exit_code]),[['observed',1],['observed',0]]);
      assert.deepEqual(saved.verification.map(v=>[v.step_id,v.criterion_id]),[['update','value'],['update','value']]);
      assert.equal(auditDelivery(saved,[]).verification.status,'passed');
    }else assert.ok(saved.unresolved.includes(blockers.at(-1)!));
  }
});

test('passing final host receipts resolve waiting steps and preserve unrelated outstanding work',async t=>{
  const {saved}=await runQualityGate(t,['fail','pass'],['approved'],{waitForHost:true});
  assert.equal(saved.status,'completed');
  assert.deepEqual(saved.diff_review,{verdict:'approved',summary:'边界条件已覆盖'});
  assert.deepEqual(saved.unresolved,['仍需人工验收','仍需现场验收']);
  const step=saved.steps![0],receipt=saved.verification.at(-1)!;
  assert.equal(step.status,'completed');
  assert.equal(step.verification_status,'passed');
  assert.deepEqual(step.unresolved,[]);
  assert.doesNotMatch(step.progress,/等待/);
  assert.deepEqual(step.evidence_ids,[receipt.evidence_id]);
  assert.deepEqual(step.criteria[0].evidence_ids,[receipt.evidence_id]);
  const checked=saved.steps![1];
  assert.equal(checked.status,'completed');
  assert.equal(checked.progress,'已回读确认 sum.mjs:1 的公开导出返回 a + b。代码修改完成，ARC 宿主验证通过。');
  assert.deepEqual(checked.evidence_ids,[receipt.evidence_id]);
  assert.deepEqual(checked.criteria.map(c=>c.evidence_ids),[[receipt.evidence_id],[receipt.evidence_id]]);
});

test('fast direct edits skip review after a successful host recheck and keep review for missing tools',async t=>{
  const passed=await runQualityGate(t,['fail','pass'],[],{fast:true});
  assert.deepEqual(passed.calls,['edit','host','edit','host']);
  assert.equal(passed.saved.fast_mode,true);
  assert.equal(passed.saved.verification_status,'passed');
  assert.equal(passed.saved.diff_review,undefined);
  const drifted=await runQualityGate(t,['pass'],[],{fast:true,editAfterHost:true});
  assert.equal(drifted.saved.status,'blocked');
  assert.equal(drifted.saved.verification_status,'stale');
  assert.match(drifted.saved.unresolved.join('\n'),/最终代码状态/);
  for(const host of ['skip','partial'] as const){
    const {saved,calls}=await runQualityGate(t,[host],['approved'],{fast:true});
    assert.deepEqual(calls,['edit','host','review']);
    assert.equal(saved.diff_review?.verdict,'approved');
    assert.equal(saved.verification_status,host==='skip'?'not_run':'partial');
  }
});

test('direct Codex plans read-only and only runs approved execution with linked verification',async()=>{
  const f=await fixture();let plans=0,configured=0,executions=0;
  const analysisPreferences={model:'planning-model',reasoning_effort:'medium'} as const;
  const executionPreferences={model:'execution-model',reasoning_effort:'high'} as const;
  const analysis:typeof runCodex=async options=>{
    plans++;
    assert.deepEqual(options.preferences,analysisPreferences);
    assert.match(options.prompt,/只分析/);
    assert.equal(options.snapshot.project_id,f.project.project_id);
    assert.equal(options.run.execution_mode,'codex');
    return {code:0,raw:JSON.stringify(requirementPlan),stderr:''};
  };
  const runner:typeof runDevelopmentCodex=async options=>{
    executions++;
    assert.deepEqual(options.preferences,executionPreferences);
    assert.deepEqual(options.writeScope,['main.ts']);
    assert.deepEqual(options.task.requirement_package,requirementPlan.requirement_package);
    const receipt={id:'value-before',command:'node --test',cwd:f.source,cwd_source:'task_workspace' as const,
      exit_code:1,output:'incorrect value',completed_at:new Date().toISOString()};
    await options.commandCompleted!(receipt);
    await fs.writeFile(path.join(f.source,'main.ts'),'export const value=2;\n');
    await options.commandCompleted!({...receipt,id:'value-after',exit_code:0,output:'# tests 1\n# pass 1\n# fail 0\n# skipped 0',completed_at:new Date().toISOString()});
    return completed(options.task.task_id,[{command:'node --test',outcome:'passed',note:'Checked value 2',step_id:'update',criterion_id:'value'}]);
  };
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,
    async()=>{configured++;return configuration();},analysis);
  try{
    const input={project_id:f.project.project_id,goal:'Change value',submission_key:'codex-requirement'};
    f.service.store.put('settings','codex_preferences',analysisPreferences);
    const task=await development.submit(input,'codex');
    await Promise.all([...development.executing.values()]);
    const plan=f.service.engineering.task(task.task_id);
    assert.equal(plan.workflow,'ready');assert.equal(plan.status,'pending');assert.equal(configured,0);
    assert.equal((await development.submit(input,'codex')).task_id,task.task_id);assert.equal(plans,1);
    const approval={...input,task_id:task.task_id,phase:'execution' as const,submission_key:'codex-approval',scope:['main.ts']};
    await assert.rejects(development.submit({...approval,expected_version:plan.version-1},'codex'),/VERSION_CONFLICT/);
    assert.equal(executions,0);
    f.service.store.put('settings','codex_preferences',executionPreferences);
    await development.submit({...approval,expected_version:plan.version},'codex');
    await Promise.all([...development.executing.values()]);
    const saved=f.service.engineering.task(task.task_id);
    assert.equal(saved.status,'completed');assert.equal(configured,1);assert.equal(executions,1);
    assert.equal(saved.approval?.reviewed_version,plan.version);
    assert.deepEqual(saved.verification.map(({outcome,origin,step_id,criterion_id})=>[outcome,origin,step_id,criterion_id]),
      [['failed','observed','update','value'],['passed','observed','update','value']]);
    assert.deepEqual(saved.verification.at(-1)?.metrics,{total:1,passed:1,failed:0,skipped:0});
  }finally{await development.shutdown();await f.close();}
});

test('DSH Web retries malformed replies and applies approved edits only after a frozen source read',async()=>{
  const f=await fixture();let readSource=false,applyCalls=0;
  const web:typeof runDshWeb=async options=>{
    assert.equal(options.profile.provider_id,'dsh');
    if(options.run.title==='只读需求分析')return {code:0,raw:JSON.stringify(requirementPlan),stderr:''};
    if(readSource){
      if(++applyCalls===1)throw new DshMalformedReply('tool input is invalid JSON');
      options.event({type:'session.update',update:{sessionUpdate:'tool_call',toolCallId:'read',title:'arc_read_source',rawInput:{path:'main.ts'}}});
      options.event({type:'session.update',update:{sessionUpdate:'tool_call_update',toolCallId:'read',status:'completed'}});
    }
    return {code:0,raw:JSON.stringify({summary:'Change the value',edits:[{path:'main.ts',content:'export const value=2;\n'}],unresolved:[]}),stderr:''};
  };
  const noCodex=async()=>{throw Error('DSH must stay on DSH Web');};
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},noCodex,
    async(_,only)=>[({...profile,provider_id:only!})],noCodex,noCodex,web);
  try{
    const input={project_id:f.project.project_id,goal:'Change value',submission_key:'dsh-requirement'};
    const task=await development.submit(input,'dsh');
    const finish=async()=>{await Promise.all([...development.executing.values()]);return f.service.engineering.task(task.task_id);};
    const plan=await finish();assert.equal(plan.workflow,'ready');assert.equal(plan.execution_mode,'dsh');
    const approval={...input,task_id:task.task_id,phase:'execution' as const,submission_key:'dsh-approval',scope:['main.ts']};
    await development.submit({...approval,expected_version:plan.version},'dsh');
    const refused=await finish();assert.equal(refused.status,'failed');assert.match(refused.unresolved[0],/未通过冻结源码工具读取/);
    assert.match(await fs.readFile(path.join(f.source,'main.ts'),'utf8'),/value=1/);
    readSource=true;
    await development.submit({...input,task_id:task.task_id,expected_version:refused.version,submission_key:'dsh-revised'},'dsh');
    const revised=await finish();assert.equal(revised.workflow,'ready');
    await development.submit({...approval,expected_version:revised.version,submission_key:'dsh-approved-again'},'dsh');
    const saved=await finish();assert.equal(saved.status,'completed');assert.equal(saved.verification_status,'not_run');
    assert.deepEqual(saved.changes.map(({path})=>path),['main.ts']);
    assert.equal(applyCalls,2);
    assert.match(await fs.readFile(path.join(f.source,'main.ts'),'utf8'),/value=2/);
    assert.equal(await fs.readFile(path.join(f.source,'README.md'),'utf8'),'Test fixture only\n');
  }finally{await development.shutdown();await f.close();}
});

test('development orchestration captures real differences, observed exit evidence and inherited configuration',async()=>{
  const f=await fixture();let optionsSeen:any;
  const runner:typeof runDevelopmentCodex=async options=>{
    optionsSeen=options;
    const step={step_id:'step-order',title:'修改并验证订单计算',change:'只调整当前计算实现',status:'in_progress' as const,progress:'修改前方案已保存',criteria:[{criterion_id:'criterion-order',text:'相关测试有结果',evidence_ids:[]}],evidence_ids:[],unresolved:['尚未验证'],created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    await options.saveSteps?.([step]);
    await options.commandCompleted!({id:'test-before',command:'node --test',cwd:f.source,cwd_source:'task_workspace',exit_code:1,output:'assertion failed',completed_at:new Date().toISOString()});
    await fs.writeFile(path.join(f.source,'main.ts'),'export const value=2;\n');
    await options.commandCompleted!({id:'test-command',command:'node --test',cwd:f.source,cwd_source:'task_workspace',exit_code:0,output:'1 passed',completed_at:new Date().toISOString()});
    await options.commandCompleted!({id:'git-check',command:gitReceipt,cwd:f.source,cwd_source:'task_workspace',exit_code:0,output:'Git receipt output',completed_at:new Date().toISOString()});
    const output=completed(options.task.task_id,[{command:'node --test',outcome:'passed',note:'simulated pass',step_id:'step-order',criterion_id:'criterion-order'},{command:gitCheck,outcome:'passed',note:'Git check'}]);
    return {...output,result:{...output.result,steps:[{...step,status:'completed' as const,progress:'修改与验证完成',unresolved:[]}],context_entries:[{entry_id:'',expected_version:0,category:'design',key:'Addition boundary',text:'Retain current API; only change the value.'}]}};
  };
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,configuration);
  try{
    await fs.writeFile(path.join(f.source,'user-note.txt'),'keep user text');
    const task=await development.start({project_id:f.project.project_id,goal:'change value',submission_key:'first',scope:['main.ts']});await Promise.all([...development.executing.values()]);
    const saved=f.service.engineering.task(task.task_id),attempt=f.service.store.get<any>('development_attempt',saved.attempt_ids[0]);
    assert.equal(saved.status,'completed');assert.deepEqual(saved.changes.map(item=>item.path),['main.ts']);assert.equal(await fs.readFile(path.join(f.source,'user-note.txt'),'utf8'),'keep user text');
    assert.equal(saved.verification_status,'passed');
    assert.deepEqual(saved.verification.map(e=>[e.origin,e.outcome,e.exit_code]),[['observed','failed',1],['observed','passed',0],['observed','passed',0]]);
    assert.equal(saved.steps?.[0].status,'completed');assert.equal(saved.verification[1].step_id,'step-order');assert.equal(saved.verification[1].criterion_id,'criterion-order');
    assert.match(attempt.model,/配置.*test-configured-model/);
    assert.equal(optionsSeen.task.workspace_path,f.source);assert.equal((await development.start({project_id:f.project.project_id,goal:'change value',submission_key:'first',scope:['main.ts']})).task_id,task.task_id);
    const design=(await f.service.engineering.context({project_id:f.project.project_id,category:'design'})).entries;assert.equal(design.length,1);assert.equal(design[0].origin,'agent');assert.equal(design[0].status,'needs_review');assert.equal(design[0].text,'Retain current API; only change the value.');
    assert.match(await fs.readFile(path.join(f.service.directory,saved.verification[0].log_path!),'utf8'),/assertion failed/);
    assert.match(await fs.readFile(path.join(f.service.directory,saved.verification[1].log_path!),'utf8'),/1 passed/);
    assert.equal(await fs.readFile(path.join(f.service.directory,saved.verification[2].log_path!),'utf8'),gitReceipt+'\nGit receipt output');
  }finally{await development.shutdown();await f.close();}
});
test('modification after validation leaves evidence stale instead of passing the new code',async()=>{
  const f=await fixture();
  const runner:typeof runDevelopmentCodex=async options=>{
    await fs.writeFile(path.join(f.source,'main.ts'),'export const value=2;\n');
    await options.commandCompleted!({id:'old-check',command:'node --test',cwd:f.source,cwd_source:'task_workspace',exit_code:0,output:'passed on value 2',completed_at:new Date().toISOString()});
    await fs.writeFile(path.join(f.source,'main.ts'),'export const value=3;\n');return completed(options.task.task_id,[{command:'node --test',outcome:'passed',note:'earlier check'}]);
  };
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,configuration);
  try{const task=await development.start({project_id:f.project.project_id,goal:'change',submission_key:'stale',scope:['main.ts']});await Promise.all([...development.executing.values()]);const saved=f.service.engineering.task(task.task_id);assert.equal(saved.verification_status,'stale');assert.notEqual(saved.verification[0].code_state.fingerprint,saved.end_state?.fingerprint);}
  finally{await development.shutdown();await f.close();}
});
test('cancellation during provider preflight prevents launch and ignores the later probe response',async()=>{
  const f=await fixture(),gate=deferred<ProviderProfile[]>();let calls=0;
  const runner:typeof runDevelopmentCodex=async options=>{calls++;return completed(options.task.task_id);};
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,()=>gate.promise,configuration);
  try{const task=await development.start({project_id:f.project.project_id,goal:'cancel',submission_key:'cancel',scope:['main.ts']});await development.cancel(task.task_id);gate.resolve([profile]);await Promise.all([...development.executing.values()]);assert.equal(calls,0);assert.equal(f.service.engineering.task(task.task_id).status,'cancelled');}
  finally{gate.resolve([profile]);await development.shutdown();await f.close();}
});
test('sandbox environment failure is saved as blocked with no verification and retained diagnostic',async()=>{
  const f=await fixture();
  const runner:typeof runDevelopmentCodex=async options=>{
    const directory=path.join(options.storage,'development',options.task.task_id,options.task.attempt_ids.at(-1)!);await fs.mkdir(directory,{recursive:true});
    const blocked=developmentSandboxError({stderr:'registered Core process has no package identity'});
    await fs.writeFile(path.join(directory,'diagnostic.json'),JSON.stringify({stage:'sandbox_check',model_called:false,protocol_error:blocked.message}));throw blocked;
  };
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,configuration);
  try{
    const task=await development.start({project_id:f.project.project_id,goal:'blocked sandbox',submission_key:'sandbox-blocked',scope:['main.ts']});await Promise.all([...development.executing.values()]);
    const saved=f.service.engineering.task(task.task_id),attempt=f.service.store.get<any>('development_attempt',saved.attempt_ids.at(-1)!);
    assert.equal(saved.status,'blocked');assert.equal(saved.verification_status,'not_run');assert.deepEqual(saved.changes,[]);assert.match(saved.summary,/尚未调用模型/);assert.ok(attempt.log_path);
    const diagnostic=JSON.parse(await fs.readFile(path.join(f.service.directory,attempt.log_path),'utf8'));assert.equal(diagnostic.model_called,false);assert.equal(diagnostic.stage,'sandbox_check');
  }finally{await development.shutdown();await f.close();}
});
test('cancelled running attempt cannot accept a late successful result or roll back its written files',async()=>{
  const f=await fixture(),launched=deferred<void>(),release=deferred<void>();let cancellations=0;
  const runner:typeof runDevelopmentCodex=async options=>{
    options.started({child:{pid:999999} as any,cancel:async()=>{cancellations++;}});await fs.writeFile(path.join(f.source,'main.ts'),'export const value=2;\n');launched.resolve();await release.promise;return completed(options.task.task_id);
  };
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,configuration);
  try{const task=await development.start({project_id:f.project.project_id,goal:'cancel late',submission_key:'cancel-late',scope:['main.ts']});await launched.promise;await development.cancel(task.task_id);release.resolve();await Promise.all([...development.executing.values()]);assert.equal(cancellations,1);assert.equal(f.service.engineering.task(task.task_id).status,'cancelled');assert.match(await fs.readFile(path.join(f.source,'main.ts'),'utf8'),/value=2/);}
  finally{release.resolve();await development.shutdown();await f.close();}
});
test('branch movement during configuration blocks launch without silently rebinding the task',async()=>{
  const f=await fixture();let calls=0;
  const runner:typeof runDevelopmentCodex=async options=>{calls++;return completed(options.task.task_id);};
  const config=async()=>{await exec('git',['-C',f.source,'checkout','-b','changed-during-preflight'],{windowsHide:true});return configuration();};
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,config);
  try{const task=await development.start({project_id:f.project.project_id,goal:'branch conflict',submission_key:'branch',scope:['main.ts']});await Promise.all([...development.executing.values()]);const saved=f.service.engineering.task(task.task_id);assert.equal(calls,0);assert.equal(saved.status,'blocked');assert.match(saved.unresolved.join('\n'),/WORKSPACE_CONFLICT/);}
  finally{await development.shutdown();await f.close();}
});

test('concurrent user entry edits preserve completed code results, real verification and logs on writeback conflict',async()=>{
  const f=await fixture();await f.service.engineering.connect(f.project.project_id);
  const initial=await f.service.engineering.saveEntry({project_id:f.project.project_id,category:'design',key:'Shared design',text:'Original proposal',expected_version:0,submission_key:'initial-design'},'user');
  const runner:typeof runDevelopmentCodex=async options=>{
    await fs.writeFile(path.join(f.source,'main.ts'),'export const value=2;\n');
    const script="require('node:assert/strict').match(require('node:fs').readFileSync('main.ts','utf8'),/value=2/);console.log('value check passed')";
    const run=await exec(process.execPath,['-e',script],{cwd:f.source,windowsHide:true});
    const command=`node -e "${script}"`;
    await options.commandCompleted!({id:'real-check',command,cwd:f.source,cwd_source:'task_workspace',exit_code:0,output:run.stdout,completed_at:new Date().toISOString()});
    await f.service.engineering.saveEntry({project_id:f.project.project_id,entry_id:initial.entry_id,category:'design',key:initial.key,text:'User revised the design during execution',expected_version:initial.version,submission_key:'concurrent-user-edit'},'user');
    const output=completed(options.task.task_id,[{command,outcome:'passed',note:'Actual local assertion; provider orchestration simulated'}]);
    return {...output,result:{...output.result,summary:'Changed value and verified it',decisions:['Preserve existing interface'],context_entries:[{entry_id:initial.entry_id,expected_version:initial.version,category:'design',key:initial.key,text:'Stale Agent replacement'}]}};
  };
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,configuration);
  try{
    const task=await development.start({project_id:f.project.project_id,goal:'change value',submission_key:'entry-conflict',scope:['main.ts']});await Promise.all([...development.executing.values()]);
    const saved=f.service.engineering.task(task.task_id);
    assert.equal(saved.status,'completed');assert.equal(saved.summary,'Changed value and verified it');assert.deepEqual(saved.decisions,['Preserve existing interface']);
    assert.deepEqual(saved.changes.map(c=>c.path),['main.ts']);assert.equal(saved.verification_status,'passed');assert.equal(saved.verification[0].origin,'observed');assert.equal(saved.verification[0].exit_code,0);
    assert.match(saved.unresolved.join('\n'),/工程条目 1（design）未保存：VERSION_CONFLICT/);
    assert.match(await fs.readFile(path.join(f.service.directory,saved.verification[0].log_path!),'utf8'),/value check passed/);
    const current=(await f.service.engineering.context({project_id:f.project.project_id,entry_id:initial.entry_id})).entries[0];assert.equal(current.version,2);assert.equal(current.text,'User revised the design during execution');assert.equal(current.origin,'user');
    assert.match(JSON.stringify(f.service.store.events(saved.attempt_ids[0])),/context_entry_failed/);
  }finally{await development.shutdown();await f.close();}
});
