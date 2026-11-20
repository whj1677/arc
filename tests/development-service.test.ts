import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ArcService} from '../src/main/service';
import {DevelopmentService,commandBody} from '../src/main/development-service';
import type {runDevelopmentCodex} from '../src/main/development-runner';
import {developmentSandboxError} from '../src/main/development-runner';
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
