import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ArcService} from '../src/main/service';
import {prepareOverview} from '../src/main/overview-result';
import {sha} from '../src/main/snapshot';
import type {runCodex} from '../src/main/providers';
import {hasFunctionGraphs,type AnalysisResult,type Run,type Snapshot} from '../src/shared';

const entries=['read_value','write_value'];
const source=['int record(void) { return 7; }',...entries.map(name=>`int ${name}(void) { return record(); }`)];
const overview={
  schema_version:'overview-1',summary:{text:'两个入口均调用 record。',evidence_ids:['definition']},
  scope:'main.c',unresolved:[],components:[{id:'component',kind:'stage',label:'读写接口',description:'对外提供读写入口。',inputs:[],outputs:[],evidence_ids:['definition']}],
  features:[{label:'接口',items:entries.map(name=>({id:name,label:name,description:`从 ${name} 调用 record。`,evidence_ids:[name+'-line']}))}],
  readings:entries.map(name=>({node_id:name,entry:name,outcome:'返回记录值',steps:[{text:'调用 record。',evidence_ids:[name+'-line']}],boundary:'仅静态调用'})),
  relations:[],evidence:source.map((quote,i)=>({id:i?entries[i-1]+'-line':'definition',path:'main.c',start:i+1,end:i+1,quote})),
};
function detail(run:Run,snapshot:Snapshot,name:string):AnalysisResult{
  const line=entries.indexOf(name)+2;
  const nodes=[name,'record'].map(symbol=>({node_id:symbol,kind:'function' as const,label:symbol,description:symbol,
    execution_context:{kind:'unknown' as const,identity:null,label:'未运行',status:'unknown' as const,claim_ids:[],evidence_ids:[]},
    inputs:[],outputs:[],evidence_ids:['site'],claim_ids:['fact']}));
  const first={id:'start',kind:'entry' as const,from_node_id:null,to_node_id:name,text:'由入口触发',input:'无',output:'进入函数',condition:'',evidence_ids:['site']};
  return {schema_version:'1.0',fictional:false,result_id:'result-'+run.binding.run_id,binding:run.binding,
    provider:{provider_id:run.provider_id,connection_id:'local-'+run.provider_id,adapter_version:'0.1.0'},
    summary:{text:'调用 record 并返回',claim_ids:['fact']},coverage:{covered_scope:[name],unresolved_scope:[]},
    nodes,edges:[{edge_id:'call-record',kind:'sync_call',source_node_id:name,target_node_id:'record',label:'读取记录',status:'source_supported',claim_ids:['fact'],evidence_ids:['site']}],
    claims:[{claim_id:'fact',statement:'入口调用 record。',status:'source_supported',rationale:'函数体包含调用',limitations:[],evidence_ids:['site'],targets:{node_ids:[name,'record'],edge_ids:['call-record'],io_ids:[]}}],
    evidence:[{evidence_id:'site',path:'main.c',source_snapshot_id:snapshot.source_snapshot_id,content_sha256:snapshot.files[0].content_sha256,line_start:line,line_end:line,role:'callsite',note:source[line-1]}],gaps:[],
    function_walkthroughs:[{id:'path',label:name,trigger:name,entry_node_id:name,boundary:'仅静态调用',evidence_ids:['site'],steps:[first,{...first,id:'invoke',kind:'call',from_node_id:name,to_node_id:'record',text:'调用 record'}]}]};
}

test('one project analysis schedules frozen feature graphs, continues after a failure and reuses ready graphs',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'arc-project-graphs-')),root=path.join(temp,'project');
  await fs.mkdir(root);await fs.writeFile(path.join(root,'main.c'),source.join('\n'));
  const attempts:string[]=[];
  let active=0,peak=0,failOnce=true;
  const runner:typeof runCodex=async options=>{
    options.started({child:{pid:123} as any,cancel:async()=>{}});
    if(options.phase==='overview_review'){
      const draft=await prepareOverview(overview,options.run,options.snapshot,options.storage);
      return {code:0,stderr:'',raw:JSON.stringify({schema_version:'overview-review-1',run_id:options.run.binding.run_id,
        source_snapshot_id:options.snapshot.source_snapshot_id,draft_sha256:sha(JSON.stringify(draft)),summary:{verdict:'supported',reason:'入口见源码'},relations:[]})};
    }
    if(!options.run.overview_parent_run_id)return {code:0,stderr:'',raw:JSON.stringify(overview)};
    const name=entries.find(entry=>options.run.title.includes(entry))!;
    attempts.push(name);peak=Math.max(peak,++active);
    try{
      await new Promise(resolve=>setTimeout(resolve,10));
      if(name==='read_value'&&failOnce){failOnce=false;throw Error('controlled failure');}
      return {code:0,stderr:'',raw:JSON.stringify(detail(options.run,options.snapshot,name))};
    }finally{active--;}
  };
  const service=new ArcService(path.join(temp,'data'),path.resolve('.'),undefined,runner);
  t.after(async()=>{await service.shutdown();service.store.close();await fs.rm(temp,{recursive:true,force:true});});
  const project=await service.openProject(root),scene=service.overview(project.project_id);
  service.store.put('provider','codex',{status:'available',checked_at:new Date().toISOString(),version:'offline-runner'});
  async function analyze(key:string,expectedNew:number){
    const parent=await service.startRun(scene.scenario_id,'codex',key,undefined,{projectAnalysis:true});
    await service.executing.get(parent.binding.run_id);
    assert.equal(service.store.get<Run>('run',parent.binding.run_id).status,'completed');
    await new Promise<void>((resolve,reject)=>{
      const until=Date.now()+5000;
      const check=()=>{
        const children=service.data().runs.filter(r=>r.overview_parent_run_id===parent.binding.run_id);
        if(children.length===expectedNew&&children.every(r=>['failed','completed'].includes(r.status)))return resolve();
        if(Date.now()>=until)return reject(Error('Unexpected child runs: '+JSON.stringify(children.map(r=>[r.title,r.status,r.error]))));
        setTimeout(check,10);
      };check();
    });
    return parent;
  }
  await analyze('project-pass-one',2);
  assert.deepEqual(attempts,entries);
  const last=await analyze('project-pass-two',1);
  assert.deepEqual(attempts,['read_value','write_value','read_value']);assert.equal(peak,1);
  const saved=service.data().explanations.find(e=>e.result.binding.run_id===last.binding.run_id)!;
  for(const entry of entries){
    const opened=service.openDiscoveredFeature(project.project_id,saved.result_id,entry);
    assert.ok(opened.result_id);
    const result=service.data().explanations.find(e=>e.result_id===opened.result_id)!.result;
    assert.ok(hasFunctionGraphs(result));assert.equal(result.binding.source_snapshot_id,project.snapshot_id);
  }
  await analyze('project-pass-three',0);
  assert.equal(attempts.length,3);
});

test('local runs cap feature batches at two, skip cancelled waiters and prioritize overview', {timeout:10000}, async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'arc-local-slots-')),root=path.join(temp,'project');
  await fs.mkdir(root);await fs.writeFile(path.join(root,'main.c'),source.join('\n'));
  const deferred=()=>{
    let resolve!:()=>void;
    const promise=new Promise<void>(done=>{resolve=done;});
    return {promise,resolve};
  };
  const keys=['batch-one','batch-two','batch-cancelled','batch-four','priority-overview'];
  const gates=new Map(keys.map(key=>[key,{entered:deferred(),release:deferred()}]));
  const launches:Parameters<typeof runCodex>[0][]=[];
  let active=0,peak=0;
  const runner:typeof runCodex=async options=>{
    const gate=gates.get(options.run.submission_key!)!;
    launches.push(options);
    options.started({child:{pid:123} as any,cancel:async()=>gate.release.resolve()});
    peak=Math.max(peak,++active);
    gate.entered.resolve();
    try{
      await gate.release.promise;
      if(options.run.overview_format)return {code:1,stderr:'controlled stop',raw:''};
      return {code:0,stderr:'',raw:JSON.stringify(detail(options.run,options.snapshot,entries[0]))};
    }finally{active--;}
  };
  const service=new ArcService(path.join(temp,'data'),path.resolve('.'),undefined,runner);
  t.after(async()=>{
    for(const gate of gates.values())gate.release.resolve();
    await service.shutdown();service.store.close();await fs.rm(temp,{recursive:true,force:true});
  });
  const project=await service.openProject(root);
  service.store.put('provider','codex',{status:'available',checked_at:new Date().toISOString(),version:'offline-runner'});
  const runs=await Promise.all(keys.slice(0,4).map(key=>{
    const {scenario}=service.addFeature(project.project_id,key);
    return service.startRun(scenario.scenario_id,'codex',key);
  }));
  const overviewRun=await service.startRun(service.overview(project.project_id).scenario_id,'codex',keys[4]);
  const [first,second,,fourth]=keys.map(key=>gates.get(key)!);
  const priority=gates.get(keys[4])!;
  await Promise.all([first.entered.promise,second.entered.promise]);
  assert.deepEqual(launches.map(call=>call.run.submission_key),keys.slice(0,2));
  const cancelledId=runs[2].binding.run_id;
  const cancelledExecution=service.executing.get(cancelledId);
  assert.ok(cancelledExecution);
  assert.equal((await service.cancel(cancelledId)).status,'cancelled');
  await cancelledExecution;
  assert.equal(service.executing.has(cancelledId),false);
  assert.equal(active,2);

  first.release.resolve();
  await priority.entered.promise;
  assert.deepEqual(launches.map(call=>call.run.submission_key),[keys[0],keys[1],keys[4]]);
  priority.release.resolve();
  await fourth.entered.promise;
  second.release.resolve();
  fourth.release.resolve();
  await Promise.all(service.executing.values());

  assert.equal(peak,2);
  assert.deepEqual(launches.map(call=>call.run.submission_key),[keys[0],keys[1],keys[4],keys[3]]);
  for(const call of launches.filter(call=>!call.run.overview_format)){
    assert.match(call.prompt,/只展开当前功能/);
    assert.doesNotMatch(call.prompt,/feature_catalog\.groups 引用/);
  }
  assert.deepEqual(runs.map(run=>service.store.get<Run>('run',run.binding.run_id).status),['completed','completed','cancelled','completed']);
  assert.equal(service.store.get<Run>('run',overviewRun.binding.run_id).status,'failed');
});
