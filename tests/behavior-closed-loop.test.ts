import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test,type TestContext} from 'node:test';
import type {CodeState,DevelopmentStep,EngineeringTask,RequirementPackage,VerificationEvidence} from '../src/engineering';
import {approvedRequirement} from '../src/task-boundaries';
import {readRequirementPlan} from '../src/main/dsh-development';
import {DevelopmentService} from '../src/main/development-service';
import {applyScenarioResults,EngineeringService} from '../src/main/engineering-service';
import {capture} from '../src/main/snapshot';
import {Store} from '../src/main/store';

const file='cart.js';
const discount={id:'discount',behavior:'计算满减金额',design:'按订单金额结算',files:[file],step_ids:['price'],verification:'检查实付金额'};
const decision={id:'tiers',behavior_id:'discount',title:'满减次数',question:'满 1000 元时优惠几次？',example_label:'订单 1000 元',
  options:[{id:'once',label:'只减一次',example_outcome:'950'},{id:'repeat',label:'每满 500 减 50',example_outcome:'900'}]};
const step=(id:string):DevelopmentStep=>({step_id:id,title:id,change:id,progress:'已完成',status:'completed',
  criteria:[{criterion_id:id,text:'检查'+id,evidence_ids:[]}],evidence_ids:[],unresolved:[],created_at:'',updated_at:''});
const pkg:RequirementPackage={short_title:'订单结算',rule_decisions:[{...decision,chosen_option_id:'once'}],behaviors:[
  {...discount,short_title:'订单满减',before_behavior:'无折扣',rule_summary:'满 500 减一次',scenarios:[
    {id:'1000',input:'1000',expected:'950',actual:'950',status:'passed',evidence_id:'original'},
    {id:'499',input:'499',expected:'499',actual:'499',status:'passed',evidence_id:'original'}]},
  {id:'shipping',behavior:'运费计算',design:'固定运费',files:[file],step_ids:['ship'],verification:'检查运费',
    scenarios:[{id:'standard',input:'普通配送',expected:'10',actual:'10',status:'passed',evidence_id:'original'}]},
]};

// Start from a previously saved SQLite task, including its original execution evidence.
async function fixture(t:TestContext){
  const temp=path.resolve('.test-data');
  await fs.mkdir(temp,{recursive:true});
  const dir=await fs.mkdtemp(path.join(temp,'behavior-loop-')),root=path.join(dir,'订单 工程');
  const store=new Store(path.join(dir,'data'));
  t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true});});
  await fs.mkdir(root);await fs.writeFile(path.join(root,file),'export const discount = 50;\n');
  const snapshot=await capture(root,'p',store.directory,'');
  const state:CodeState={snapshot_id:snapshot.source_snapshot_id,fingerprint:snapshot.fingerprint,workspace_fingerprint:'historical',
    head:null,branch:null,git_common_dir:null,dirty:[],captured_at:snapshot.captured_at};
  const history:VerificationEvidence={evidence_id:'original',command:'npm test',cwd:root,outcome:'passed',exit_code:0,origin:'observed',
    code_state:state,created_at:state.captured_at,log_path:'development/task/history.log',code_state_verified:true};
  const task:EngineeringTask={task_id:'task',project_id:'p',workspace_id:'ws',workspace_path:root,version:3,submission_key:'initial',
    goal:'订单结算',scope:[file],proposed_scope:[file],approval:{reviewed_version:1,scope:[file]},workflow:'execution',status:'completed',
    requirement_package:structuredClone(pkg),baseline:state,end_state:state,context_version:1,summary:'已完成',decisions:['保留固定运费'],
    unresolved:[],changes:[],verification:[history],verification_status:'passed',steps:[step('price'),step('ship')],
    attempt_ids:[],requests:[],created_at:state.captured_at,updated_at:state.captured_at,saved:'saved'};
  store.put('snapshot',state.snapshot_id,snapshot);
  store.put('project','p',{project_id:'p',root_path:root,snapshot_id:state.snapshot_id,build_config:''});
  store.put('engineering_workspace','ws',{workspace_id:'ws',project_id:'p',root_path:root,status:'bound',git_common_dir:null});
  store.put('engineering_context_state','p',{version:1});
  store.putVersion('engineering_task','task',task.version,task);
  return {task,store,engineering:new EngineeringService(store),state,history};
}

test('legacy and structured plans round-trip, with blank Codex option fields omitted',()=>{
  const plan={summary:'订单结算',steps:[{...step('price'),status:'pending'}],proposed_scope:[file],decisions:[],unresolved:[]};
  const {created_at,updated_at,...plannedStep}=plan.steps[0];
  const read=(requirement_package:RequirementPackage)=>readRequirementPlan(JSON.stringify({...plan,steps:[plannedStep],requirement_package})).requirement_package;
  assert.deepEqual(read({behaviors:[discount]}),{behaviors:[discount]});
  const contract={short_title:'订单结算',behaviors:[{...discount,short_title:'订单满减',before_behavior:'无折扣',rule_summary:'待确定满减次数',
    scenarios:[{id:'1000',input:'1000',expected:'优惠金额按选项确定'}]}],rule_decisions:[decision]};
  assert.deepEqual(read({...contract,rule_decisions:[{...decision,custom_rule:'',chosen_option_id:''}]}),contract);
});

test('editing a rule invalidates only its scenarios and records one versioned decision',async t=>{
  const {task,engineering}=await fixture(t);
  const edit={task_id:task.task_id,behavior_id:'discount',expected_version:task.version,submission_key:'choose',
    decision_id:'tiers',chosen_option_id:'repeat',scenarios:[{id:'1000',input:'1000',expected:'900'}]};
  assert.throws(()=>engineering.updateBehaviorContract({...edit,chosen_option_id:'missing'}));
  const saved=engineering.updateBehaviorContract(edit),contract=saved.requirement_package!;
  assert.equal(contract.rule_decisions![0].chosen_option_id,'repeat');
  assert.deepEqual(contract.behaviors[0].scenarios!.map(row=>[row.id,row.expected,row.status]),[['1000','900','stale'],['499','499','stale']]);
  assert.deepEqual(contract.behaviors[1],pkg.behaviors[1]);
  assert.equal(saved.verification_status,'stale');
  assert.deepEqual(saved.verification,task.verification);
  assert.deepEqual(saved.steps,[{...task.steps![0],verification_status:'stale'},task.steps![1]]);
  assert.match(saved.decisions.join('\n'),/每满 500 减 50/);
  assert.equal(engineering.updateBehaviorContract(edit).version,saved.version);
  assert.throws(()=>engineering.updateBehaviorContract({...edit,submission_key:'outdated'}),/VERSION_CONFLICT/);
  assert.deepEqual(engineering.task(task.task_id).decisions,saved.decisions);
});

test('editing a legacy rule invalidates linked criterion evidence on unchanged code',async t=>{
  const {task,engineering,store,history,state}=await fixture(t);
  const receipt={...history,code_state:state,step_id:'price',criterion_id:'price'};
  const {scenarios,...shipping}=pkg.behaviors[1];
  task.requirement_package={behaviors:[discount,shipping]};
  task.verification=[receipt];
  task.steps![0].criteria[0].evidence_ids=[receipt.evidence_id];
  store.put('engineering_task',task.task_id,task);
  store.put('engineering_state',task.workspace_id,state);
  const currentTask=async()=>(await engineering.currentTasks({project_id:task.project_id},true))[0];
  assert.equal((await currentTask()).steps![0].verification_status,'passed');

  const saved=engineering.updateBehaviorContract({task_id:task.task_id,behavior_id:'discount',expected_version:task.version,
    submission_key:'legacy-rule',rule_summary:'每满 500 减 50'});
  assert.equal(saved.verification_status,'stale');
  assert.equal(saved.steps![0].verification_status,'stale');
  store.put('engineering_task',task.task_id,{...saved,status:'running'});
  const progress=engineering.updateTask({task_id:task.task_id,expected_version:saved.version,submission_key:'progress',
    steps:[{...saved.steps![0],progress:'待复验'}],verification:[receipt]});
  const current=await currentTask();
  assert.equal(current.verification_status,'stale');
  assert.equal(current.steps![0].verification_status,'stale');
  assert.equal(current.steps![1].verification_status,'not_run');

  const verified=engineering.updateTask({task_id:task.task_id,expected_version:progress.version,submission_key:'fresh-test',
    verification:[{...receipt,evidence_id:'fresh-test'}]});
  assert.equal(verified.verification_status,'passed');
  assert.equal((await currentTask()).steps![0].verification_status,'passed');
});

test('adding a scenario after a passing execution requires fresh verification',async t=>{
  const {task,engineering}=await fixture(t);
  const saved=engineering.updateBehaviorContract({task_id:task.task_id,behavior_id:'discount',expected_version:task.version,
    submission_key:'add-example',scenarios:[{id:'zero',input:'0',expected:'0'}]});
  assert.equal(saved.verification_status,'stale');
  const rows=saved.requirement_package!.behaviors[0].scenarios!;
  assert.equal(rows.find(row=>row.id==='zero')?.status??'unverified','unverified');
  assert.equal(rows.find(row=>row.id==='1000')?.status,'passed');
});

test('a targeted revision keeps the reviewed scope, other steps and previous evidence',async t=>{
  const {task,engineering}=await fixture(t);
  const input={task_id:task.task_id,behavior_id:'discount',expected_version:task.version,submission_key:'repair',
    action:'fix_implementation' as const,instruction:'1000 元应实付 900 元',rule_summary:'每满 500 减 50'};
  const revised=await engineering.prepareBehaviorRevision(input),approved=approvedRequirement(revised);
  assert.equal(revised.workflow,'execution');assert.equal(revised.status,'pending');
  assert.equal(revised.steps![0].status,'pending');assert.deepEqual(revised.steps![0].unresolved,[]);
  assert.deepEqual(revised.steps![1],task.steps![1]);assert.deepEqual(revised.verification,task.verification);
  assert.deepEqual(revised.requirement_package!.behaviors[1],pkg.behaviors[1]);assert.deepEqual(revised.approval,task.approval);
  assert.deepEqual(revised.scope,task.scope);assert.ok(revised.decisions.includes(task.decisions[0]));
  assert.equal(approved.active_behavior_focus?.instruction,input.instruction);assert.equal(approved.behaviors[0].rule_summary,input.rule_summary);
  assert.equal(revised.requests!.at(-1)!.text,input.instruction);
  assert.equal((await engineering.prepareBehaviorRevision(input)).version,revised.version);
});

test('a revision after rollback starts from the restored workspace',async t=>{
  const {task,engineering,store,state}=await fixture(t);
  const restored={...state,workspace_fingerprint:'restored'};
  const captureState=t.mock.method(engineering,'captureState',async()=>restored);
  const rolledBack:EngineeringTask={...task,rolled_back_at:state.captured_at,diff_review:{verdict:'approved',summary:'已审阅'},
    changes:[{path:file,before_sha256:'before',after_sha256:'after',ownership:'task_change'}]};
  store.put('engineering_task',task.task_id,rolledBack);

  const revised=await engineering.prepareBehaviorRevision({task_id:task.task_id,behavior_id:'discount',expected_version:rolledBack.version,
    submission_key:'after-rollback',action:'fix_implementation',instruction:'重新实现满减'});
  assert.deepEqual(captureState.mock.calls[0]?.arguments,[task.project_id,task.workspace_path]);
  assert.deepEqual(revised.diff_baseline,restored);
  assert.deepEqual(revised.changes,[]);
  assert.equal(revised.end_state,undefined);
  assert.equal(revised.rolled_back_at,undefined);
  assert.equal(revised.diff_review,undefined);
});

test('host check evidence describes the checked state without replacing delivery attribution',async t=>{
  const {store,engineering,task,state,history}=await fixture(t);
  const changes=[{path:file,before_sha256:null,after_sha256:'delivered',ownership:'task_change' as const}];
  store.put('engineering_task',task.task_id,{...task,changes});
  await fs.writeFile(path.join(task.workspace_path,file),'export const discount = 150;\n');
  const snapshot=await capture(task.workspace_path,task.project_id,store.directory,'');
  store.put('snapshot',snapshot.source_snapshot_id,snapshot);
  const checked={...state,snapshot_id:snapshot.source_snapshot_id,fingerprint:snapshot.fingerprint,workspace_fingerprint:'user-edited'};
  const saved=engineering.recordHostChecks(task.task_id,[{...history,evidence_id:'host-check'}],checked);
  assert.notEqual(checked.fingerprint,state.fingerprint);
  assert.deepEqual(saved.end_state,task.end_state);
  assert.deepEqual(saved.changes,changes);
  assert.deepEqual(saved.verification.at(-1)?.code_state,checked);
  assert.equal(saved.verification_status,'passed');
});

test('only observed passing test evidence on the final state backs a scenario pass',async t=>{
  const {task,state,history}=await fixture(t);
  const row=task.requirement_package!.behaviors[0].scenarios![0];
  const result={behavior_id:'discount',scenario_id:'1000',actual:'900',status:'passed' as const,command:'npm test'};
  const testReceipt={...history,evidence_id:'final-test'};
  for(const receipt of [{...history,origin:'self_reported' as const},{...history,command:'npm run typecheck'},
    {...history,command:'npm run build'},{...history,code_state_verified:false},
    {...history,code_state:{...state,workspace_fingerprint:'different-code'}}]){
    applyScenarioResults(task,[{...result,command:receipt.command}],[receipt],state);
    assert.equal(row.status,'unverified');assert.equal(row.actual,'900');assert.equal(row.evidence_id,undefined);
  }
  for(const command of [undefined,'npm test -- other']){
    applyScenarioResults(task,[{...result,command}],[testReceipt],state);
    assert.equal(row.status,'unverified');assert.equal(row.evidence_id,undefined);
  }
  applyScenarioResults(task,[result],[testReceipt],state);
  assert.equal(row.status,'passed');assert.equal(row.evidence_id,'final-test');

  row.criterion_id='price';
  for(const receipt of [testReceipt,{...testReceipt,step_id:'ship',criterion_id:'price'},
    {...testReceipt,step_id:'price',criterion_id:'other'}]){
    applyScenarioResults(task,[result],[receipt],state);
    assert.equal(row.status,'unverified');assert.equal(row.evidence_id,undefined);
  }
  for(const criterion_id of [undefined,'price']){
    applyScenarioResults(task,[result],[{...testReceipt,step_id:'price',criterion_id}],state);
    assert.equal(row.status,'passed');assert.equal(row.evidence_id,'final-test');
  }
  applyScenarioResults(task,[{...result,status:'failed',actual:'950'}],[],state);
  assert.equal(row.status,'failed');assert.equal(row.actual,'950');
});

test('filtered host checks persist real output and leave business scenarios and criteria alone',async t=>{
  const {store,engineering,task}=await fixture(t),events:string[]=[];
  const command='node -e "console.log(42)"';
  await engineering.saveEnvironmentCommands(task.project_id,{typecheck:'node -e "process.exit(1)"',test:command});
  const service=new DevelopmentService(engineering,store,path.resolve('.'),event=>events.push(event.type));
  const result=await service.runHostChecks(task.task_id,['test']);
  assert.deepEqual(result.failed,[]);assert.deepEqual(result.skipped,[]);assert.equal(result.receipts.length,1);
  const [receipt]=result.receipts;
  assert.equal(receipt.command,command);assert.equal(receipt.origin,'observed');assert.equal(receipt.outcome,'passed');
  assert.equal(receipt.code_state_verified,true);
  assert.equal(receipt.code_state.fingerprint,task.end_state!.fingerprint);
  assert.match(receipt.log_path!,/^development\/task\/host-checks\//);
  assert.match((await engineering.readLog(task.task_id,receipt.log_path!)).text,/42/);
  assert.deepEqual(result.task.requirement_package,task.requirement_package);assert.deepEqual(result.task.steps,task.steps);
  assert.deepEqual(result.task.verification,[...task.verification,receipt]);assert.deepEqual(result.task.attempt_ids,[]);
  assert.ok(events.includes('engineering_changed'));
});

test('DSH rejects a verification-only revision without changing the task',async t=>{
  const {store,engineering,task}=await fixture(t);
  const service=new DevelopmentService(engineering,store,path.resolve('.'),()=>{});
  const before=engineering.task(task.task_id);
  await assert.rejects(service.reviseBehavior({task_id:task.task_id,project_id:task.project_id,behavior_id:'discount',
    expected_version:task.version,submission_key:'dsh-verify',action:'add_verification',instruction:'补齐测试'},'dsh'),
  {message:'DSH 仅支持编辑源码，无法运行命令补齐场景验证，请改用 Codex 或直接运行工程检查。'});
  assert.deepEqual(engineering.task(task.task_id),before);
});
