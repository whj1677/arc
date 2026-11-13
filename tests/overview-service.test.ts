// Service lifecycle checks use an injected runner; these are not real Agent acceptance.
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ArcService} from '../src/main/service';
import {prepareOverview} from '../src/main/overview-result';
import {sha} from '../src/main/snapshot';
import type {runCodex} from '../src/main/providers';
import type {Run,Snapshot} from '../src/shared';

const overview={
  schema_version:'overview-1',summary:{text:'提交入口把字符串保存到内存记录中。',evidence_ids:['source-submit','source-store']},
  scope:'两个文件中的提交入口与内存存储',unresolved:['没有验证运行时调用和持久化'],
  components:[
    {id:'submit',kind:'stage',label:'提交入口',description:'将收到的字符串交给保存函数。',inputs:['待保存的字符串'],outputs:[],evidence_ids:['source-submit']},
    {id:'store',kind:'resource',label:'内存记录',description:'保存提交的字符串。',inputs:['提交的字符串'],outputs:[],evidence_ids:['source-store']},
  ],
  features:[{label:'记录管理',items:[{id:'save-feature',label:'提交记录',description:'将字符串加入内存记录。',evidence_ids:['source-submit','source-store']}]}],
  relations:[{id:'save',kind:'data_publish',source:'submit',target:'store',label:'保存字符串',description:'提交入口调用 save，将值加入 records。',evidence_ids:['source-submit','source-store']}],
  evidence:[
    {id:'source-submit',path:'入口.ts',start:1,end:2,quote:"import {save} from './存储';\nexport function submit(value:string) { save(value); }"},
    {id:'source-store',path:'存储.ts',start:1,end:2,quote:'export const records:string[] = [];\nexport function save(value:string) { records.push(value); }'},
  ],
};

function signal(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const active=(cancel:()=>Promise<void>=async()=>{})=>({child:{pid:123} as any,cancel});
async function fixture(t:TestContext,runner:typeof runCodex){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'arc-overview-service-')),root=path.join(directory,'中文 空格工程');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'入口.ts'),overview.evidence[0].quote+'\n');
  await fs.writeFile(path.join(root,'存储.ts'),overview.evidence[1].quote+'\n');
  const service=new ArcService(path.join(directory,'data'),path.resolve('.'),undefined,runner);
  t.after(async()=>{
    await service.shutdown();service.store.close();
    assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true});
  });
  const project=await service.openProject(root),scenario=service.overview(project.project_id);
  service.store.put('provider','codex',{provider_id:'codex',status:'available',version:'injected-test-runner',checked_at:new Date().toISOString()});
  return {service,project,scenario,snapshot:service.store.get<Snapshot>('snapshot',project.snapshot_id)};
}
async function generation(options:Parameters<typeof runCodex>[0]){
  assert.equal(options.shouldStart?.(),true);options.started(active());
  await fs.mkdir(path.dirname(options.run.output_path),{recursive:true});
  const raw=JSON.stringify(overview);await fs.writeFile(options.run.output_path,raw);
  return {code:0,raw,stderr:''};
}
async function reviewFor(options:Parameters<typeof runCodex>[0]){
  const draft=await prepareOverview(overview,options.run,options.snapshot,options.storage);
  return {schema_version:'overview-review-1',run_id:options.run.binding.run_id,source_snapshot_id:options.snapshot.source_snapshot_id,draft_sha256:sha(JSON.stringify(draft)),summary:{verdict:'supported',reason:'摘要对应提交和保存两处实现。'},relations:draft.edges.map(edge=>({edge_id:edge.edge_id,verdict:'supported',reason:'提交端调用存储函数，存储端将相同值加入记录。',evidence_ids:edge.evidence_ids}))};
}

test('overview publishes only after two phases complete under the same frozen run',async t=>{
  const entered=signal(),release=signal(),phases:{id:string;phase:string;output:string}[]=[];
  const runner:typeof runCodex=async options=>{
    phases.push({id:options.run.binding.run_id,phase:options.phase||'generation',output:options.run.output_path});
    if(!options.phase)return generation(options);
    const review=await reviewFor(options);entered.resolve();await release.promise;
    assert.equal(options.shouldStart?.(),true);options.started(active());
    return {code:0,raw:JSON.stringify(review),stderr:''};
  };
  const {service,scenario,project}=await fixture(t,runner);
  const run=await service.startRun(scenario.scenario_id,'codex','overview-success-key');
  try{
    await entered.promise;
    assert.equal(service.data().explanations.length,0,'the generated draft is not a published explanation');
    assert.equal(service.data().runs.length,1);assert.equal(service.store.get<Run>('run',run.binding.run_id).status,'validating');
    assert.deepEqual(phases.map(p=>[p.id,p.phase]),[[run.binding.run_id,'generation'],[run.binding.run_id,'overview_review']]);
    assert.notEqual(phases[0].output,phases[1].output,'review output must not replace the original response');
  }finally{release.resolve();await Promise.all(service.executing.values());}
  const completed=service.store.get<Run>('run',run.binding.run_id),saved=service.data().explanations;
  assert.equal(completed.status,'completed');assert.equal(saved.length,1);
  assert.deepEqual(saved[0].result.binding,run.binding);assert.equal(saved[0].result.binding.source_snapshot_id,project.snapshot_id);
  assert.match(completed.validation!.semantic,/独立 Agent/);assert.equal(service.active.size,0);
  assert.equal(await fs.readFile(run.output_path,'utf8'),JSON.stringify(overview),'the raw compact result stays intact');
});

test('cancelling during review preparation rejects its late startup and never publishes the draft',async t=>{
  const entered=signal(),release=signal();let mayStart:boolean|undefined,stopped=false;
  const runner:typeof runCodex=async options=>{
    if(!options.phase)return generation(options);
    const review=await reviewFor(options);assert.equal(options.shouldStart?.(),true);
    entered.resolve();await release.promise;mayStart=options.shouldStart?.();
    // Simulate an adapter completing startup after cancellation arrived.
    options.started(active(async()=>{stopped=true;}));
    return {code:0,raw:JSON.stringify(review),stderr:''};
  };
  const {service,scenario}=await fixture(t,runner);
  const run=await service.startRun(scenario.scenario_id,'codex','overview-cancel-key');
  try{await entered.promise;await service.cancel(run.binding.run_id);assert.equal(service.store.get<Run>('run',run.binding.run_id).status,'cancelled');}
  finally{release.resolve();await Promise.all(service.executing.values());}
  assert.equal(mayStart,false);assert.equal(stopped,true);assert.equal(service.active.size,0);
  assert.equal(service.store.get<Run>('run',run.binding.run_id).status,'cancelled');
  assert.equal(service.data().runs.length,1);assert.equal(service.data().explanations.length,0);
});

test('failed or incomplete review cannot be bypassed through direct acceptance or raw revalidation',async t=>{
  for(const failure of ['runner-failure','missing-relation'] as const)await t.test(failure,async t=>{
    let calls=0;
    const runner:typeof runCodex=async options=>{
      calls++;if(!options.phase)return generation(options);
      assert.equal(options.shouldStart?.(),true);options.started(active());
      if(failure==='runner-failure')return {code:1,raw:'',stderr:'review unavailable'};
      const review=await reviewFor(options);review.relations=[];
      return {code:0,raw:JSON.stringify(review),stderr:''};
    };
    const {service,scenario,snapshot}=await fixture(t,runner);
    const run=await service.startRun(scenario.scenario_id,'codex','overview-'+failure);
    await Promise.all(service.executing.values());
    const failed=service.store.get<Run>('run',run.binding.run_id);
    assert.equal(failed.status,'failed');assert.ok(failed.error);assert.equal(calls,2);
    const draft=await prepareOverview(overview,run,snapshot,service.directory);
    await assert.rejects(service.acceptResult(run.binding.run_id,draft),/尚未完成独立关系复核/);
    await assert.rejects(service.revalidate(run.binding.run_id),/独立关系复核/);
    assert.equal(service.data().explanations.length,0);assert.equal(service.data().runs.length,1);
    assert.equal(service.store.get<Run>('run',run.binding.run_id).status,'failed');
    assert.equal(service.active.size,0);assert.equal(calls,2,'blocked recovery must not dispatch another model task');
    assert.equal(await fs.readFile(run.output_path,'utf8'),JSON.stringify(overview));
  });
});
