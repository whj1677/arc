// Service lifecycle checks use an injected runner; these are not real Agent acceptance.
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ArcService} from '../src/main/service';
import {shallowOverviewQuestion} from '../src/main/architecture-analysis';
import {prepareOverview} from '../src/main/overview-result';
import {applyOverviewReview} from '../src/main/overview-review';
import {linesOf,readSource,sha} from '../src/main/snapshot';
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
  readings:[{node_id:'save-feature',entry:'调用提交入口',outcome:'字符串加入内存记录',steps:[
    {text:'提交函数将字符串交给存储函数。',evidence_ids:['source-submit']},
    {text:'存储函数把值加入 records 数组。',evidence_ids:['source-store']},
  ],boundary:'仅核对内存写入，未证实持久化。'}],
  relations:[{id:'save',kind:'data_publish',source:'submit',target:'store',label:'保存字符串',description:'提交入口调用 save，将值加入 records。',evidence_ids:['source-submit','source-store']}],
  evidence:[
    {id:'source-submit',path:'入口.ts',start:1,end:2,quote:"import {save} from './存储';\nexport function submit(value:string) { save(value); }"},
    {id:'source-store',path:'存储.ts',start:1,end:2,quote:'export const records:string[] = [];\nexport function save(value:string) { records.push(value); }'},
  ],
};

function signal(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const active=(cancel:()=>Promise<void>=async()=>{})=>({child:{pid:123} as any,cancel});
async function fixture(t:TestContext,runner:typeof runCodex,emit?:(event:any)=>void){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'arc-overview-service-')),root=path.join(directory,'中文 空格工程');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'入口.ts'),overview.evidence[0].quote+'\n');
  await fs.writeFile(path.join(root,'存储.ts'),overview.evidence[1].quote+'\n');
  const service=new ArcService(path.join(directory,'data'),path.resolve('.'),emit,runner);
  t.after(async()=>{
    await service.shutdown();service.store.close();
    assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true});
  });
  const project=await service.openProject(root),scenario=service.overview(project.project_id);
  service.store.put('provider','codex',{provider_id:'codex',status:'available',version:'injected-test-runner',checked_at:new Date().toISOString()});
  return {service,project,scenario,snapshot:service.store.get<Snapshot>('snapshot',project.snapshot_id)};
}
async function generation(options:Parameters<typeof runCodex>[0],value=overview){
  assert.equal(options.shouldStart?.(),true);options.started(active());
  await fs.mkdir(path.dirname(options.run.output_path),{recursive:true});
  const raw=JSON.stringify(value);await fs.writeFile(options.run.output_path,raw);
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
  assert.deepEqual(saved[0].result.feature_catalog?.readings,overview.readings);
  assert.match(completed.validation!.semantic,/独立 Agent/);assert.equal(service.active.size,0);
  assert.equal(await fs.readFile(run.output_path,'utf8'),JSON.stringify(overview),'the raw compact result stays intact');
});

test('new overview refuses a response without readings before requesting semantic review',async t=>{
  const {readings:_,...withoutReadings}=overview;
  let calls=0;
  const runner:typeof runCodex=async options=>{
    calls++;assert.equal(options.phase,undefined);assert.equal(options.shouldStart?.(),true);options.started(active());
    return phaseReply(options,withoutReadings);
  };
  const {service,scenario}=await fixture(t,runner);
  const run=await service.startRun(scenario.scenario_id,'codex','overview-missing-readings');
  await Promise.all(service.executing.values());
  const failed=service.store.get<Run>('run',run.binding.run_id);
  assert.equal(failed.status,'failed');assert.match(failed.error||'',/readings/);
  assert.equal(service.data().explanations.length,0);assert.equal(calls,2);
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

test('late generation success cannot revive a run whose stop could not be confirmed',async t=>{
  const entered=signal(),release=signal();let calls=0;
  const runner:typeof runCodex=async options=>{
    calls++;assert.equal(options.phase,undefined,'an unconfirmed stop must not dispatch review or research');
    assert.equal(options.shouldStart?.(),true);options.started(active(async()=>{throw Error('cannot confirm process stop');}));
    entered.resolve();await release.promise;
    return phaseReply(options,overview);
  };
  const {service,scenario}=await fixture(t,runner),run=await service.startRun(scenario.scenario_id,'codex','generation-stop-unknown');
  try{
    await entered.promise;await service.cancel(run.binding.run_id);
    assert.equal(service.store.get<Run>('run',run.binding.run_id).status,'unknown');
  }finally{release.resolve();await Promise.all(service.executing.values());}
  const stopped=service.store.get<Run>('run',run.binding.run_id);
  assert.equal(stopped.status,'unknown');assert.match(stopped.error!,/停止状态未确认，迟到结果不发布/);
  assert.equal(calls,1);assert.equal(service.active.size,0);assert.equal(service.data().explanations.length,0);
  assert.equal(await fs.readFile(run.output_path,'utf8'),JSON.stringify(overview),'late raw output remains available for diagnosis');
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

// The extra dependency stays accepted, so recheck must include only the
// repaired edge. Deliberately incorrect persistence wording exercises repair.
const researchOverview={...overview,relations:[
  {...overview.relations[0],label:'持久化字符串',description:'提交入口把字符串持久化到数据库。'},
  {id:'uses-store',kind:'dependency',source:'submit',target:'store',label:'依赖存储模块',description:'提交入口导入存储模块提供的 save 函数。',evidence_ids:['source-submit']},
]};
type RunnerOptions=Parameters<typeof runCodex>[0];
function phaseInput(options:RunnerOptions){return JSON.parse(options.prompt.split(options.phase==='overview_research'?'待补查关系：':'待复核输入：')[1]);}
async function phaseReply(options:RunnerOptions,value:unknown){
  const raw=JSON.stringify(value);await fs.mkdir(path.dirname(options.run.output_path),{recursive:true});await fs.writeFile(options.run.output_path,raw);
  return {code:0,raw,stderr:''};
}
function reviewReply(options:RunnerOptions,rejectSave=false){
  const input=phaseInput(options);
  return {schema_version:'overview-review-1',run_id:input.run_id,source_snapshot_id:input.source_snapshot_id,draft_sha256:input.draft_sha256,
    summary:{verdict:'supported',reason:'摘要仅描述源码中的内存保存。'},
    relations:input.relations.map((edge:any)=>({edge_id:edge.edge_id,verdict:rejectSave&&edge.edge_id==='save'?'contradicted':'supported',
      reason:rejectSave&&edge.edge_id==='save'?'只见 records.push，原断言的数据库持久化缺乏依据。':'引用实现支持本条关系。',evidence_ids:edge.evidence_ids}))};
}

test('overview tightens a rejected summary once and publishes only after independent recheck',async t=>{
  for(const verdict of ['supported','contradicted','cancelled'] as const)await t.test(verdict,async t=>{
    const phases:string[]=[];
    const reason='冻结源码只有内存写入，没有数据库持久化依据。';
    const summaryText='提交的字符串加入 records 数组。',statement='save 调用 records.push(value)。';
    const original={...overview,summary:{...overview.summary,text:'提交的字符串持久化到数据库。'}};
    let summaryClaimId:string;
    const runner:typeof runCodex=async options=>{
      const phase=options.phase??(options.reasoningEffort==='low'?'summary-repair':'generation');
      phases.push(phase);
      if(phase==='generation')return generation(options,original);
      assert.equal(options.shouldStart?.(),true);options.started(active());
      if(phase==='overview_review')return phaseReply(options,{...reviewReply(options),summary:{verdict:'uncertain',reason}});
      if(phase==='summary-repair'){
        assert.equal(options.reasoningEffort,'low');
        assert.equal(options.outputDirectory,path.join(options.storage,'runs',options.run.binding.run_id,'summary-repair'));
        assert.equal(options.run.output_path,path.join(options.outputDirectory,'result.json'));
        assert.deepEqual((options.outputSchema as {required:string[]}).required,['summary_text','claims']);
        const input=JSON.parse(options.prompt.split('待收紧摘要：')[1]);
        assert.equal(input.reason,reason);assert.equal(input.summary.text,original.summary.text);
        assert.equal(input.summary.claims[0].statement,original.summary.text);
        summaryClaimId=input.summary.claims[0].claim_id;
        assert.deepEqual(input.evidence.map(({path,source}:{path:string;source:string})=>[path,source]),
          overview.evidence.map(({path,quote})=>[path,quote.split('\n').map((line,index)=>`${index+1}: ${line}`).join('\n')]));
        if(verdict==='cancelled')await service.cancel(options.run.binding.run_id);
        return phaseReply(options,{summary_text:summaryText,claims:[{claim_id:summaryClaimId,statement}]});
      }
      assert.equal(phase,'overview_recheck');
      const input=phaseInput(options);
      assert.deepEqual(input.relations,[]);assert.equal(input.summary.text,summaryText);
      assert.deepEqual(input.summary.claims.map(({claim_id,statement}:any)=>({claim_id,statement})),[{claim_id:summaryClaimId,statement}]);
      assert.equal(service.data().explanations.length,0);
      return phaseReply(options,{...reviewReply(options),summary:{verdict,reason}});
    };
    const {service,scenario,snapshot}=await fixture(t,runner);
    const run=await service.startRun(scenario.scenario_id,'codex','summary-repair-'+verdict);
    await Promise.all(service.executing.values());
    assert.deepEqual(phases,['generation','overview_review','summary-repair',...(verdict==='cancelled'?[]:['overview_recheck'])]);
    assert.ok(service.store.events(run.binding.run_id).some(event=>event.stage==='repairing_validation'&&event.message.includes('最多 1 轮')));
    const outcome=service.store.get<Run>('run',run.binding.run_id),saved=service.data().explanations;
    assert.equal(service.active.size,0);
    assert.equal(await fs.readFile(run.output_path,'utf8'),JSON.stringify(original));
    if(verdict==='cancelled'){
      assert.equal(outcome.status,'cancelled');assert.equal(saved.length,0);
    }else if(verdict==='contradicted'){
      assert.equal(outcome.status,'failed');assert.match(outcome.error!,/工程全貌摘要未通过语义复核（contradicted）/);
      assert.equal(saved.length,0);
    }else{
      assert.equal(outcome.status,'completed',outcome.error);assert.equal(saved.length,1);
      const draft=await prepareOverview(original,run,snapshot,service.directory);
      const expected={...draft,summary:{...draft.summary,text:summaryText},claims:draft.claims.map(claim=>
        claim.claim_id===summaryClaimId?{...claim,statement}:claim)};
      const persistedDraft=JSON.parse(await fs.readFile(path.join(path.dirname(run.output_path),'overview-draft.json'),'utf8'));
      assert.deepEqual(persistedDraft,expected);
      assert.deepEqual(saved[0].result.edges,expected.edges);
      assert.deepEqual(saved[0].result.feature_catalog,expected.feature_catalog);
      assert.deepEqual(saved[0].result.summary,expected.summary);
    }
  });
});

async function researchReply(options:RunnerOptions,outcome:'resolved'|'unresolved'='resolved'){
  const input=phaseInput(options),evidence=[];
  assert.deepEqual(input.relations.map((edge:any)=>edge.edge_id),['save']);
  for(const [index,original] of overview.evidence.entries()){
    const source=await readSource(options.storage,options.snapshot,original.path),lines=linesOf(source.text);
    const receipt={source_snapshot_id:source.source_snapshot_id,path:source.path,content_sha256:source.content_sha256,total_lines:source.line_count,line_start:1,
      lines:lines.map((text,index)=>({line:index+1,text}))};
    // Official CLI event shape, injected locally; this is not real Agent evidence.
    options.event({type:'item.completed',item:{id:'read-'+index,type:'mcp_tool_call',server:'arc_frozen_source',tool:'arc_read_source',
      arguments:{path:source.path,line_start:1,line_count:source.line_count},status:'completed',error:null,
      result:{content:[{type:'text',text:JSON.stringify(receipt)}],structured_content:null}}});
    evidence.push({...original,id:`research-${sha(input.run_id).slice(0,12)}-${index}`});
  }
  const ids=evidence.map(item=>item.id);
  return {schema_version:'overview-research-1',run_id:input.run_id,source_snapshot_id:input.source_snapshot_id,draft_sha256:input.draft_sha256,
    relations:[{edge_id:'save',outcome,reason:outcome==='resolved'?'已重读入口.ts 的 submit 和存储.ts 的 save；将数据库持久化修订为内存记录写入。':'已查入口.ts 和存储.ts；源码仅有内存 records.push，未提供数据库持久化实现。',checked_evidence_ids:ids,
      proposal:outcome==='resolved'?{kind:'data_publish',label:'保存到内存记录',description:'submit 调用 save，将字符串加入 records 数组。',source_node_id:'submit',target_node_id:'store',evidence_ids:ids}:null}],evidence};
}

test('automatic source research stays unpublished until only its repaired relation passes recheck',async t=>{
  const entered=signal(),release=signal(),phases:{id:string;source:string;phase:string;output:string}[]=[];
  const runner:typeof runCodex=async options=>{
    phases.push({id:options.run.binding.run_id,source:options.snapshot.source_snapshot_id,phase:options.phase||'generation',output:options.run.output_path});
    if(!options.phase)return generation(options,researchOverview);
    if(options.phase==='overview_recheck'){
      assert.deepEqual(phaseInput(options).relations.map((edge:any)=>edge.edge_id),['save']);
      entered.resolve();await release.promise;
    }
    assert.equal(options.shouldStart?.(),true);options.started(active());
    return phaseReply(options,options.phase==='overview_research'?await researchReply(options):reviewReply(options,options.phase==='overview_review'));
  };
  const {service,scenario,snapshot}=await fixture(t,runner),run=await service.startRun(scenario.scenario_id,'codex','automatic-research-success');
  try{
    await entered.promise;assert.equal(service.data().explanations.length,0,'the repaired candidate must not appear before independent recheck');
    assert.equal(service.store.get<Run>('run',run.binding.run_id).status,'validating');
    assert.deepEqual(phases.map(item=>item.phase),['generation','overview_review','overview_research','overview_recheck']);
    assert.ok(phases.every(item=>item.id===run.binding.run_id&&item.source===snapshot.source_snapshot_id));
    assert.equal(new Set(phases.map(item=>item.output)).size,4);
  }finally{release.resolve();await Promise.all(service.executing.values());}
  const saved=service.data().explanations[0],completed=service.store.get<Run>('run',run.binding.run_id);
  assert.equal(completed.status,'completed');assert.equal(saved.result.gaps.length,0);assert.equal(saved.result.edges.length,2);
  assert.equal(saved.result.edges.find(edge=>edge.edge_id==='save')!.label,'保存到内存记录');
  assert.equal(saved.result.edges.find(edge=>edge.edge_id==='uses-store')!.label,'依赖存储模块');
  assert.deepEqual(saved.result.binding,run.binding);assert.match(completed.validation!.semantic,/自动补查 1 条，其中 1 条/);
  assert.equal(await fs.readFile(run.output_path,'utf8'),JSON.stringify(researchOverview));
  assert.equal(service.data().runs.length,1);assert.equal(service.active.size,0);
});

test('empty, failed or cancelled research never becomes a source-not-found conclusion or a published graph',async t=>{
  for(const failure of ['empty-result','runner-failure','cancel-preflight','cancel-local-validation'] as const)await t.test(failure,async t=>{
    const entered=signal(),release=signal(),phases:string[]=[];let mayStart:boolean|undefined,stopped=false;
    let observed:ArcService|undefined,researchReturned=false,localRequested=false,localCancellation:Promise<Run>|undefined;
    const runner:typeof runCodex=async options=>{
      phases.push(options.phase||'generation');
      if(!options.phase)return generation(options,researchOverview);
      if(options.phase==='overview_review'){options.started(active());return phaseReply(options,reviewReply(options,true));}
      assert.equal(options.phase,'overview_research');assert.equal(options.shouldStart?.(),true);
      if(failure==='cancel-preflight'){
        entered.resolve();await release.promise;mayStart=options.shouldStart?.();
        options.started(active(async()=>{stopped=true;}));
        return phaseReply(options,await researchReply(options));
      }
      if(failure==='cancel-local-validation'){
        options.started(active());const reply=await phaseReply(options,await researchReply(options));researchReturned=true;return reply;
      }
      options.started(active());return {code:failure==='runner-failure'?1:0,raw:'',stderr:failure==='runner-failure'?'source research unavailable':''};
    };
    const {service,scenario}=await fixture(t,runner,event=>{
      if(failure!=='cancel-local-validation'||event.type!=='changed'||!observed||!researchReturned||localRequested)return;
      const current=observed.data().runs[0];
      if(current.status!=='validating'||observed.active.size)return;
      // The subprocess has returned and its handle is gone; cancellation now
      // comes through the same changed notification observed by the UI.
      localRequested=true;localCancellation=observed.cancel(current.binding.run_id);
    });
    observed=service;const run=await service.startRun(scenario.scenario_id,'codex','research-'+failure);
    if(failure==='cancel-preflight'){
      try{await entered.promise;await service.cancel(run.binding.run_id);}
      finally{release.resolve();await Promise.all(service.executing.values());}
      assert.equal(mayStart,false);assert.equal(stopped,true);
    }else await Promise.all(service.executing.values());
    if(failure==='cancel-local-validation'){assert.equal(localRequested,true);assert.equal((await localCancellation)!.status,'cancelled');}
    const terminal=service.store.get<Run>('run',run.binding.run_id);
    assert.equal(terminal.status,failure.startsWith('cancel-')?'cancelled':'failed');
    if(failure==='runner-failure')assert.match(terminal.error!,/未完成，不能据此断言源码不存在.*source research unavailable/);
    if(failure==='empty-result')assert.ok(terminal.error,'empty output is an execution/format error');
    assert.equal(service.data().explanations.length,0);assert.equal(service.active.size,0);
    assert.deepEqual(phases,['generation','overview_review','overview_research']);
  });
});

test('researching a saved gap creates a new result on its original snapshot and preserves the prior explanation',async t=>{
  const phases:{id:string;phase:string;source:string}[]=[];let sourceOutcome:'resolved'|'unresolved'='unresolved';
  const runner:typeof runCodex=async options=>{
    phases.push({id:options.run.binding.run_id,phase:options.phase||'generation',source:options.snapshot.source_snapshot_id});
    if(!options.phase)return generation(options,researchOverview);
    assert.equal(options.shouldStart?.(),true);options.started(active());
    return phaseReply(options,options.phase==='overview_research'?await researchReply(options,sourceOutcome):reviewReply(options,options.phase==='overview_review'));
  };
  const {service,scenario,project,snapshot}=await fixture(t,runner),first=await service.startRun(scenario.scenario_id,'codex','save-unresolved-gap');
  await Promise.all(service.executing.values());
  const original=service.data().explanations[0];assert.ok(original,'a completed investigation can retain an explicit unresolved gap');
  assert.equal(original.result.gaps.length,1);assert.match(original.result.gaps[0].question,/已查入口.ts.*未提供数据库持久化实现/);
  assert.equal(original.result.edges.some(edge=>edge.edge_id==='save'),false);
  const originalResult=structuredClone(original.result),oldRun=structuredClone(service.store.get<Run>('run',first.binding.run_id));
  const auditPaths=[first.output_path,path.join(path.dirname(first.output_path),'overview-draft.json'),path.join(path.dirname(first.output_path),'overview-review.json')];
  const audits=await Promise.all(auditPaths.map(file=>fs.readFile(file,'utf8')));
  await fs.appendFile(path.join(project.root_path,'存储.ts'),'// 本地源码已更新\n');
  const refreshed=await service.refresh(project.project_id);assert.notEqual(refreshed.source_snapshot_id,snapshot.source_snapshot_id);
  sourceOutcome='resolved';
  const retry=await service.researchOverview(original.result_id,'research-saved-gap');
  await Promise.all(service.executing.values());
  const saved=service.data().explanations.find(item=>item.result.binding.run_id===retry.binding.run_id)!;
  assert.equal(service.store.get<Run>('run',retry.binding.run_id).status,'completed');assert.ok(saved);
  assert.notEqual(saved.result_id,original.result_id);assert.deepEqual(retry.binding,{...first.binding,run_id:retry.binding.run_id});
  assert.equal(saved.source_status,'needs_review');assert.equal(saved.result.gaps.length,0);
  assert.equal(saved.result.edges.find(edge=>edge.edge_id==='save')!.status,'source_supported');
  assert.deepEqual(phases.filter(item=>item.id===retry.binding.run_id).map(item=>[item.phase,item.source]),[['overview_research',snapshot.source_snapshot_id],['overview_recheck',snapshot.source_snapshot_id]]);
  assert.deepEqual(service.data().explanations.find(item=>item.result_id===original.result_id)!.result,originalResult);
  assert.deepEqual(service.store.get<Run>('run',first.binding.run_id),oldRun);
  assert.deepEqual(await Promise.all(auditPaths.map(file=>fs.readFile(file,'utf8'))),audits);
  assert.equal(service.data().explanations.length,2);assert.equal(service.active.size,0);
});

test('legacy two-phase results retain their original review hash when a later stored runtime version is present',async t=>{
  const phases:string[]=[];
  const runner:typeof runCodex=async options=>{
    assert.ok(options.phase==='overview_research'||options.phase==='overview_recheck','legacy recovery must not regenerate the overview');
    phases.push(options.phase);assert.equal(options.shouldStart?.(),true);options.started(active());
    return phaseReply(options,options.phase==='overview_research'?await researchReply(options):reviewReply(options));
  };
  const {service,scenario,project,snapshot}=await fixture(t,runner),created=new Date().toISOString();
  const historical=service.reviseScenario(scenario.scenario_id,shallowOverviewQuestion);
  const {readings:_,...legacyOverview}=researchOverview;
  const previous:Run={binding:{project_id:project.project_id,feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,question_revision_id:historical.question_revision_id,source_snapshot_id:snapshot.source_snapshot_id,run_id:'legacy-overview-run'},
    provider_id:'codex',overview_format:'overview-1',status:'completed',runtime_version:'codex-cli legacy-test',question:historical.question,title:scenario.title,
    created_at:created,ended_at:created,submission_key:'legacy-overview-key',output_path:path.join(service.directory,'runs','legacy-overview-run','result.json')};
  // The old pipeline created its draft from the initial envelope; only the
  // persisted run acquired runtime_version after process startup.
  const draft=await prepareOverview(legacyOverview,{...previous,runtime_version:undefined},snapshot,service.directory);
  const review={schema_version:'overview-review-1',run_id:previous.binding.run_id,source_snapshot_id:snapshot.source_snapshot_id,draft_sha256:sha(JSON.stringify(draft)),
    summary:{verdict:'supported',reason:'摘要描述内存保存。'},relations:draft.edges.map(edge=>({edge_id:edge.edge_id,verdict:edge.edge_id==='save'?'contradicted':'supported',reason:'数据库持久化的断言缺乏依据，模块依赖有源码支持。',evidence_ids:edge.evidence_ids}))};
  assert.notEqual(sha(JSON.stringify(await prepareOverview(legacyOverview,previous,snapshot,service.directory))),review.draft_sha256,'rebuilding with the stored runtime version must reproduce the observed mismatch');
  const original={result_id:draft.result_id,scenario_id:scenario.scenario_id,created_at:created,source_status:'current',result:applyOverviewReview(review,draft).result};
  service.store.put('run',previous.binding.run_id,previous);service.store.put('explanation',original.result_id,original);
  const directory=path.dirname(previous.output_path),reviewPath=path.join(directory,'review','result.json'),raw=JSON.stringify(legacyOverview),reviewRaw=JSON.stringify(review);
  await fs.mkdir(path.dirname(reviewPath),{recursive:true});await fs.writeFile(previous.output_path,raw);await fs.writeFile(reviewPath,reviewRaw);
  const newerAuditFiles=['overview-draft.json','overview-review.json'].map(name=>path.join(directory,name));
  for(const file of newerAuditFiles)await assert.rejects(fs.access(file),{code:'ENOENT'});
  const resumed=await service.researchOverview(original.result_id,'legacy-research-key');await Promise.all(service.executing.values());
  const completed=service.store.get<Run>('run',resumed.binding.run_id),saved=service.data().explanations.find(item=>item.result.binding.run_id===resumed.binding.run_id)!;
  assert.equal(completed.status,'completed',completed.error);assert.ok(saved);assert.notEqual(saved.result_id,original.result_id);
  assert.equal(saved.result.binding.source_snapshot_id,snapshot.source_snapshot_id);assert.equal(saved.result.gaps.length,0);
  assert.deepEqual(phases,['overview_research','overview_recheck']);
  assert.deepEqual(service.store.get<Run>('run',previous.binding.run_id),previous);
  assert.deepEqual(service.data().explanations.find(item=>item.result_id===original.result_id),original);
  assert.equal(await fs.readFile(previous.output_path,'utf8'),raw);assert.equal(await fs.readFile(reviewPath,'utf8'),reviewRaw);
  assert.equal(JSON.parse(await fs.readFile(reviewPath,'utf8')).draft_sha256,sha(JSON.stringify(draft)));
  for(const file of newerAuditFiles)await assert.rejects(fs.access(file),{code:'ENOENT'});
  assert.equal(service.data().explanations.length,2);assert.equal(service.active.size,0);
});
