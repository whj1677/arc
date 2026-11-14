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

test('command matcher unwraps exact shell body without turning unrelated output into test evidence',()=>{
  assert.equal(commandBody('powershell.exe -NoProfile -Command "npm test"'),'npm test');
  assert.notEqual(commandBody('echo npm test'),'npm test');
  assert.notEqual(commandBody('npm test; echo failed'),'npm test');
});
test('development orchestration captures real differences, observed exit evidence and inherited configuration',async()=>{
  const f=await fixture();let optionsSeen:any;
  const runner:typeof runDevelopmentCodex=async options=>{
    optionsSeen=options;
    await options.commandCompleted!({id:'test-before',command:'node --test',cwd:f.source,cwd_source:'task_workspace',exit_code:1,output:'assertion failed',completed_at:new Date().toISOString()});
    await fs.writeFile(path.join(f.source,'main.ts'),'export const value=2;\n');
    await options.commandCompleted!({id:'test-command',command:'node --test',cwd:f.source,cwd_source:'task_workspace',exit_code:0,output:'1 passed',completed_at:new Date().toISOString()});
    const output=completed(options.task.task_id,[{command:'node --test',outcome:'passed',note:'simulated pass'}]);
    return {...output,result:{...output.result,context_entries:[{entry_id:'',expected_version:0,category:'design',key:'Addition boundary',text:'Retain current API; only change the value.'}]}};
  };
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,configuration);
  try{
    await fs.writeFile(path.join(f.source,'user-note.txt'),'keep user text');
    const task=await development.start({project_id:f.project.project_id,goal:'change value',submission_key:'first'});await Promise.all([...development.executing.values()]);
    const saved=f.service.engineering.task(task.task_id),attempt=f.service.store.get<any>('development_attempt',saved.attempt_ids[0]);
    assert.equal(saved.status,'completed');assert.deepEqual(saved.changes.map(item=>item.path),['main.ts']);assert.equal(await fs.readFile(path.join(f.source,'user-note.txt'),'utf8'),'keep user text');
    assert.equal(saved.verification_status,'passed');
    assert.deepEqual(saved.verification.map(e=>[e.origin,e.outcome,e.exit_code]),[['observed','failed',1],['observed','passed',0]]);
    assert.match(attempt.model,/配置.*test-configured-model/);
    assert.equal(optionsSeen.task.workspace_path,f.source);assert.equal((await development.start({project_id:f.project.project_id,goal:'change value',submission_key:'first'})).task_id,task.task_id);
    const design=(await f.service.engineering.context({project_id:f.project.project_id,category:'design'})).entries;assert.equal(design.length,1);assert.equal(design[0].origin,'agent');assert.equal(design[0].status,'needs_review');assert.equal(design[0].text,'Retain current API; only change the value.');
    assert.match(await fs.readFile(path.join(f.service.directory,saved.verification[0].log_path!),'utf8'),/assertion failed/);
    assert.match(await fs.readFile(path.join(f.service.directory,saved.verification[1].log_path!),'utf8'),/1 passed/);
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
  try{const task=await development.start({project_id:f.project.project_id,goal:'change',submission_key:'stale'});await Promise.all([...development.executing.values()]);const saved=f.service.engineering.task(task.task_id);assert.equal(saved.verification_status,'stale');assert.notEqual(saved.verification[0].code_state.fingerprint,saved.end_state?.fingerprint);}
  finally{await development.shutdown();await f.close();}
});
test('cancellation during provider preflight prevents launch and ignores the later probe response',async()=>{
  const f=await fixture(),gate=deferred<ProviderProfile[]>();let calls=0;
  const runner:typeof runDevelopmentCodex=async options=>{calls++;return completed(options.task.task_id);};
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,()=>gate.promise,configuration);
  try{const task=await development.start({project_id:f.project.project_id,goal:'cancel',submission_key:'cancel'});await development.cancel(task.task_id);gate.resolve([profile]);await Promise.all([...development.executing.values()]);assert.equal(calls,0);assert.equal(f.service.engineering.task(task.task_id).status,'cancelled');}
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
    const task=await development.start({project_id:f.project.project_id,goal:'blocked sandbox',submission_key:'sandbox-blocked'});await Promise.all([...development.executing.values()]);
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
  try{const task=await development.start({project_id:f.project.project_id,goal:'cancel late',submission_key:'cancel-late'});await launched.promise;await development.cancel(task.task_id);release.resolve();await Promise.all([...development.executing.values()]);assert.equal(cancellations,1);assert.equal(f.service.engineering.task(task.task_id).status,'cancelled');assert.match(await fs.readFile(path.join(f.source,'main.ts'),'utf8'),/value=2/);}
  finally{release.resolve();await development.shutdown();await f.close();}
});
test('branch movement during configuration blocks launch without silently rebinding the task',async()=>{
  const f=await fixture();let calls=0;
  const runner:typeof runDevelopmentCodex=async options=>{calls++;return completed(options.task.task_id);};
  const config=async()=>{await exec('git',['-C',f.source,'checkout','-b','changed-during-preflight'],{windowsHide:true});return configuration();};
  const development=new DevelopmentService(f.service.engineering,f.service.store,path.resolve('.'),()=>{},runner,probe,config);
  try{const task=await development.start({project_id:f.project.project_id,goal:'branch conflict',submission_key:'branch'});await Promise.all([...development.executing.values()]);const saved=f.service.engineering.task(task.task_id);assert.equal(calls,0);assert.equal(saved.status,'blocked');assert.match(saved.unresolved.join('\n'),/WORKSPACE_CONFLICT/);}
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
    const task=await development.start({project_id:f.project.project_id,goal:'change value',submission_key:'entry-conflict'});await Promise.all([...development.executing.values()]);
    const saved=f.service.engineering.task(task.task_id);
    assert.equal(saved.status,'completed');assert.equal(saved.summary,'Changed value and verified it');assert.deepEqual(saved.decisions,['Preserve existing interface']);
    assert.deepEqual(saved.changes.map(c=>c.path),['main.ts']);assert.equal(saved.verification_status,'passed');assert.equal(saved.verification[0].origin,'observed');assert.equal(saved.verification[0].exit_code,0);
    assert.match(saved.unresolved.join('\n'),/工程条目 1（design）未保存：VERSION_CONFLICT/);
    assert.match(await fs.readFile(path.join(f.service.directory,saved.verification[0].log_path!),'utf8'),/value check passed/);
    const current=(await f.service.engineering.context({project_id:f.project.project_id,entry_id:initial.entry_id})).entries[0];assert.equal(current.version,2);assert.equal(current.text,'User revised the design during execution');assert.equal(current.origin,'user');
    assert.match(JSON.stringify(f.service.store.events(saved.attempt_ids[0])),/context_entry_failed/);
  }finally{await development.shutdown();await f.close();}
});
