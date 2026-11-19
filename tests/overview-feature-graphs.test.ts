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
import {canRepairDshReturn} from '../src/shared';
import {dshWaitTimeout,type runDshWeb} from '../src/main/dsh-web';
import {applyEvidenceRepair,readRepairBase,saveRepairBase,shrinkingEvidence} from '../src/main/evidence-repair';

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

test('DSH keeps rejected replies isolated, repairs the chosen reply, and publishes both child graphs',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'arc-dsh-return-')),root=path.join(temp,'project');
  await fs.mkdir(root);await fs.writeFile(path.join(root,'main.c'),source.join('\n'));
  const prompts:string[]=[],originalReplies:string[]=[];
  const runner:typeof runDshWeb=async options=>{
    options.started({child:{pid:123} as any,cancel:async()=>{}});
    options.event({type:'session.started',thread_id:'test-'+prompts.length,native_ui:'dsh-web'});
    prompts.push(options.prompt);
    let raw:string;
    if(options.run.overview_parent_run_id){
      const name=entries.find(entry=>options.run.title.includes(entry))!;
      const line=entries.indexOf(name)+2,missingCall=name===entries[0]&&!options.repairAttempt;
      const entry={kind:'entry',from:null,to:name,text:'从入口读取',input:'无',output:'进入处理',condition:'',evidence_ids:['caller']};
      const step={...entry,kind:missingCall?'work':'call',from:name,to:missingCall?name:'record',text:'读取记录',evidence_ids:['site']};
      raw=JSON.stringify({schema_version:'function-1',summary:'入口调用记录函数',unresolved:[],functions:[
        {id:name,symbol:name,signature:null,purpose:'接收请求',definition:'caller',parameters:[],returns:null},
        {id:'record',symbol:'record',signature:null,purpose:'给出记录值',definition:'callee',parameters:[],returns:null}],
        paths:[{label:'读取',trigger:name,boundary:'静态源码',steps:[entry,step]}],
        evidence:[{id:'caller',path:'main.c',start:line,end:line,quote:source[line-1]},
          {id:'callee',path:'main.c',start:1,end:1,quote:source[0]},{id:'site',path:'main.c',start:line,end:line,quote:'return record();'}]});
    }else if(options.run.repair_from_run_id){
      // A live edit does not alter this run's authorized frozen source.
      await fs.appendFile(path.join(root,'main.c'),'\n// source changed during analysis');
      raw=JSON.stringify(overview);
    }
    else {raw='invalid reply '+prompts.length;originalReplies.push(raw);}
    const dir=options.repairAttempt?path.join(path.dirname(options.run.output_path),'repair-'+options.repairAttempt):path.dirname(options.run.output_path);
    await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'result.json'),raw);
    return {code:0,stderr:'',raw,cancelled:false};
  };
  const service=new ArcService(path.join(temp,'data'),path.resolve('.'),undefined,undefined,runner);
  t.after(async()=>{await service.shutdown();service.store.close();await fs.rm(temp,{recursive:true,force:true});});
  const project=await service.openProject(root),scene=service.overview(project.project_id);
  service.store.put('provider','dsh',{status:'available',version:'offline-runner'});
  const first=await service.startRun(scene.scenario_id,'dsh','first-return-check',undefined,{projectAnalysis:true});
  await service.executing.get(first.binding.run_id);
  const failed=service.store.get<Run>('run',first.binding.run_id);
  assert.equal(failed.status,'failed');assert.ok(canRepairDshReturn(failed));assert.equal(originalReplies.length,3);
  assert.match(prompts[1],/invalid reply 1/);assert.match(prompts[2],/invalid reply 2/);assert.doesNotMatch(prompts[2],/invalid reply 1/);
  assert.equal(await fs.readFile(failed.output_path,'utf8'),originalReplies[0]);
  assert.ok(!canRepairDshReturn({...failed,status:'unknown'}));assert.ok(!canRepairDshReturn({...failed,status:'cancelled'}));
  const repaired=await service.repairRun(first.binding.run_id,'repair-selected-return');
  assert.equal((await service.repairRun(first.binding.run_id,'repair-selected-return')).binding.run_id,repaired.binding.run_id);
  await service.executing.get(repaired.binding.run_id);assert.equal(service.store.get<Run>('run',repaired.binding.run_id).status,'completed');
  assert.match(prompts[3],/invalid reply 3/);assert.doesNotMatch(prompts[3],/invalid reply [12]/);
  const until=Date.now()+5000;
  while(service.data().runs.filter(r=>r.overview_parent_run_id===repaired.binding.run_id&&r.status==='completed').length<2){
    const failedChild=service.data().runs.find(r=>r.overview_parent_run_id===repaired.binding.run_id&&r.status==='failed');
    assert.ok(!failedChild,failedChild?.error);
    assert.ok(Date.now()<until,'both DSH feature analyses completed');await new Promise(resolve=>setTimeout(resolve,10));
  }
  const children=service.data().runs.filter(r=>r.overview_parent_run_id===repaired.binding.run_id);
  assert.deepEqual(children.map(r=>r.dsh_return_attempt),[1,0]);
  for(const child of children){
    const saved=service.data().explanations.find(e=>e.result.binding.run_id===child.binding.run_id)!;
    assert.equal(saved.source_status,'needs_review');
    assert.equal(saved.result.binding.source_snapshot_id,repaired.binding.source_snapshot_id);
    assert.ok(hasFunctionGraphs(saved.result));
  }
  assert.match(prompts[5],/调用链和调用时间图缺少/);assert.equal(prompts.length,7);
});

test('DSH only times out after a nonterminal remote turn stops emitting events',()=>{
  const minute=60_000;
  assert.equal(dshWaitTimeout(10*minute,20*minute),undefined);
  assert.match(dshWaitTimeout(8*minute,20*minute)!,/12 分钟/);
  assert.equal(dshWaitTimeout(120*minute,121*minute),undefined);
});

test('only rejected evidence IDs can change, including after a bad patch and manual recovery',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'arc-dsh-patch-')),root=path.join(temp,'project');
  await fs.mkdir(root);await fs.writeFile(path.join(root,'main.c'),source.join('\n'));
  const correct=overview.evidence[0],bad={...correct,quote:'wrong initial quote'};
  const draft={...overview,evidence:[bad,...overview.evidence.slice(1)]};
  const wrongPatch={evidence:[{...correct,quote:'wrong second quote'}]};
  const calls:{patch:boolean;prompt:string}[]=[];
  const runner:typeof runDshWeb=async options=>{
    options.started({child:{pid:123} as any,cancel:async()=>{}});
    options.event({type:'session.started',thread_id:'patch-test',native_ui:'dsh-web'});
    if(options.run.overview_parent_run_id)return {code:0,raw:'',stderr:'',cancelled:true};
    calls.push({patch:!!options.evidencePatch,prompt:options.prompt});
    const response=[draft,{evidence:[correct,overview.evidence[1]]},wrongPatch,{evidence:[correct]}][calls.length-1];
    const raw=JSON.stringify(response),dir=path.dirname(options.run.output_path);
    const replyDir=options.repairAttempt?path.join(dir,'repair-'+options.repairAttempt):dir;
    await fs.mkdir(replyDir,{recursive:true});await fs.writeFile(path.join(replyDir,'result.json'),raw);
    return {code:0,raw,stderr:'',cancelled:false};
  };
  const service=new ArcService(path.join(temp,'data'),path.resolve('.'),undefined,undefined,runner);
  t.after(async()=>{await service.shutdown();service.store.close();await fs.rm(temp,{recursive:true,force:true});});
  const project=await service.openProject(root),scene=service.overview(project.project_id);
  service.store.put('provider','dsh',{status:'available',version:'offline-runner'});
  const first=await service.startRun(scene.scenario_id,'dsh','evidence-first-pass',undefined,{projectAnalysis:true});
  await service.executing.get(first.binding.run_id);
  assert.equal(service.store.get<Run>('run',first.binding.run_id).status,'failed');
  assert.deepEqual(await readRepairBase(path.join(path.dirname(first.output_path),'repair-2','result.json'),'input'),{draft,ids:[correct.id]});
  const oldExtra={...overview.evidence[1],start:1,end:2,quote:source.slice(0,2).join('\\n')};
  const historicalDraft={...draft,evidence:[wrongPatch.evidence[0],oldExtra,...overview.evidence.slice(2)]};
  const oldReply=path.join(path.dirname(first.output_path),'repair-2','result.json');
  await saveRepairBase(oldReply,'rejected',{draft:historicalDraft,ids:[correct.id,oldExtra.id]});
  const manual=await service.repairRun(first.binding.run_id,'evidence-manual-fix');
  await service.executing.get(manual.binding.run_id);
  assert.equal(service.store.get<Run>('run',manual.binding.run_id).status,'completed');
  assert.deepEqual(calls.map(call=>call.patch),[false,true,true,true]);
  assert.match(calls[2].prompt,/只返回这些 ID/);assert.match(calls[3].prompt,/wrong second quote/);
  const base=await readRepairBase(manual.output_path,'input');
  assert.deepEqual(base,{draft:historicalDraft,ids:[correct.id]});
  assert.deepEqual(JSON.parse(calls[3].prompt.split('\n').at(-1)!).required_evidence_ids,[correct.id]);
  assert.deepEqual(applyEvidenceRepair(base!,{evidence:[correct]}),{...overview,evidence:[correct,oldExtra,...overview.evidence.slice(2)]});
  for(const patch of [{evidence:[{...correct,id:'other'}]},{evidence:[correct,correct]},{...overview,evidence:[correct]}])
    assert.throws(()=>applyEvidenceRepair(base!,patch));
  assert.deepEqual(JSON.parse(await fs.readFile(first.output_path,'utf8')),draft);
  assert.deepEqual(JSON.parse(await fs.readFile(manual.output_path,'utf8')),{evidence:[correct]});
  // A prior release rejected a literal line-break escape now proven by the frozen file.
  await saveRepairBase(oldReply,'rejected',{draft:{...overview,evidence:[correct,oldExtra,...overview.evidence.slice(2)]},ids:[oldExtra.id]});
  const replay=await service.repairRun(first.binding.run_id,'fully-replay-evidence');
  await service.executing.get(replay.binding.run_id);
  assert.equal(service.store.get<Run>('run',replay.binding.run_id).status,'completed');assert.equal(calls.length,4);
  assert.ok(service.store.events(replay.binding.run_id).some(e=>e.type==='local.return_replayed'&&e.previous_run_id===first.binding.run_id));
});

test('six rejected anchors narrowing to one permits an extra repair with exact source choices',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'arc-dsh-anchor-')),root=path.join(temp,'project');
  const lines=[...source,'db.execute("""SELECT project_id FROM projects WHERE id = ?""", args)'];
  await fs.mkdir(root);await fs.writeFile(path.join(root,'main.c'),lines.join('\n'));
  const evidence=[...overview.evidence,...['first','second','sql'].map(id=>({id,path:'main.c',start:4,end:4,quote:'SELECT project_id FROM projects'}))];
  const draft={...overview,evidence:evidence.map(row=>({...row,quote:row.quote+' incorrect'}))};
  let turns=0;
  const runner:typeof runDshWeb=async options=>{
    options.started({child:{pid:123} as any,cancel:async()=>{}});
    if(options.run.overview_parent_run_id)return {code:0,raw:'',stderr:'',cancelled:true};
    options.event({type:'session.started',thread_id:'sql-fixture',native_ui:'dsh-web'});turns++;
    let raw:string;
    if(turns===1)raw='interrupted JSON';
    else if(turns===2)raw=JSON.stringify({schema_version:'overview-1'});
    else if(turns===3)raw=JSON.stringify(draft);
    else{
      assert.equal(options.evidencePatch,true);
      const feedback=JSON.parse(options.prompt.split('\n').at(-1)!);
      assert.deepEqual(feedback.required_evidence_ids,turns===4?evidence.map(row=>row.id):['sql']);
      const selected=feedback.source_hints.map((hint:{id:string;path:string;start:number;end:number;candidates:{line:number;quote:string}[]})=>{
        const {id,path,start,end}=hint,choice=hint.candidates[0];
        assert.ok(lines[choice.line-1].includes(choice.quote));
        if(id==='sql'){assert.match(choice.quote,/SELECT project_id/);assert.doesNotMatch(choice.quote,/"/);}
        return {id,path,start,end,quote:id==='sql'&&turns===4?'still incorrect':choice.quote};
      });
      raw=JSON.stringify({evidence:selected});
    }
    return {code:0,raw,stderr:'',cancelled:false};
  };
  const service=new ArcService(path.join(temp,'data'),path.resolve('.'),undefined,undefined,runner);
  t.after(async()=>{await service.shutdown();service.store.close();await fs.rm(temp,{recursive:true,force:true});});
  const project=await service.openProject(root),scene=service.overview(project.project_id);
  service.store.put('provider','dsh',{status:'available',version:'offline-runner'});
  const run=await service.startRun(scene.scenario_id,'dsh','shrinking-evidence',undefined,{projectAnalysis:true});
  await service.executing.get(run.binding.run_id);
  const end=service.store.get<Run>('run',run.binding.run_id);
  assert.equal(end.status,'completed',end.error);assert.equal(end.dsh_return_attempt,4);assert.equal(turns,5);
  assert.equal(shrinkingEvidence(['a','b'],['c']),false);
  assert.equal(shrinkingEvidence(['a'],['a']),false);
});
