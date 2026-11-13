import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ArcService} from '../src/main/service';
import {ArcMcpBridge} from '../src/main/mcp-bridge';
import {makePrompt,type runCodex} from '../src/main/providers';
import {readingAnswerTransportSchema} from '../src/main/reading-question';
import {buildReadingContext} from '../src/main/prompt-context';
import type {AnalysisResult,ReadingQuestion,Run,Snapshot} from '../src/shared';

async function setup(t:any,codexRunner?:typeof runCodex) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-reading-')),root=path.join(dir,'中文 工程');
  await fs.mkdir(path.join(root,'src'),{recursive:true});await fs.writeFile(path.join(root,'src/main.ts'),'export function calculate(x:number) {\n  return x + 3;\n}\n');
  const service=new ArcService(path.join(dir,'data'),path.resolve('.'),undefined,codexRunner),project=await service.openProject(root);
  const {scenario}=service.addFeature(project.project_id,'计算数值','返回的数值来自哪里？'),snapshot=service.store.get<Snapshot>('snapshot',project.snapshot_id);
  t.after(async()=>{await service.shutdown();service.store.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,root,service,project,scenario,snapshot};
}

test('cancelling during provider preparation prevents launch and rejects a late started callback',async t=>{
  let release!:()=>void,preparing!:()=>void,canStart:boolean|undefined,stopped=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{preparing=resolve;});
  const runner:typeof runCodex=async options=>{
    preparing();await gate;canStart=options.shouldStart!();
    // Also exercise the guard against an adapter whose startup completed just
    // as cancellation arrived. It must stop without reviving the cancelled run.
    options.started({child:{pid:123} as any,cancel:async()=>{stopped=true;}});
    return {code:0,raw:'late output must not be accepted',stderr:''};
  };
  const {service,project,scenario}=await setup(t,runner);
  service.store.put('provider','codex',{provider_id:'codex',status:'available',version:'test-runner'});
  const q=await service.askReading({project_id:project.project_id,scenario_id:scenario.scenario_id,target:{kind:'file',id:'src/main.ts'},question:'说明这个文件',mode:'codex',submission_key:'cancel-preparing-key'});
  await entered;await service.cancel(q.run_id);release();await Promise.all(service.executing.values());
  assert.equal(canStart,false);assert.equal(stopped,true);assert.equal(service.store.get('run',q.run_id).status,'cancelled');
  assert.equal(service.store.get('reading_question',q.question_id).answer,undefined);assert.equal(service.active.size,0);
});
async function savedResult(service:ArcService,project:any,scenario:any,snapshot:Snapshot) {
  const run:Run={binding:{project_id:project.project_id,feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,question_revision_id:scenario.question_revision_id,source_snapshot_id:snapshot.source_snapshot_id,run_id:'original-run'},provider_id:'codex',status:'running',question:scenario.question,title:scenario.title,created_at:new Date().toISOString(),submission_key:'original-key',output_path:''};
  const file=snapshot.files[0];
  const value:AnalysisResult={schema_version:'1.0',fictional:false,result_id:'original-result',binding:run.binding,provider:{provider_id:'codex',connection_id:'local-codex',adapter_version:'0.1.0'},summary:{text:'计算输入加三',claim_ids:['claim']},coverage:{covered_scope:['calculate'],unresolved_scope:['调用者']},nodes:[{node_id:'node',kind:'function',label:'计算输入加三',description:'接收 x，返回 x + 3。',execution_context:{kind:'unknown',identity:null,label:'未知',status:'unknown',claim_ids:[],evidence_ids:[]},inputs:[],outputs:[],claim_ids:['claim'],evidence_ids:['ev']}],edges:[],claims:[{claim_id:'claim',statement:'calculate 返回 x+3',status:'source_supported',rationale:'函数体',limitations:['未运行'],evidence_ids:['ev'],targets:{node_ids:['node'],edge_ids:[],io_ids:[]}}],evidence:[{evidence_id:'ev',source_snapshot_id:snapshot.source_snapshot_id,path:file.path,line_start:1,line_end:3,content_sha256:file.content_sha256,role:'definition',note:'函数实现'}],gaps:[]};
  service.store.put('run',run.binding.run_id,run);assert.equal((await service.acceptResult(run.binding.run_id,value)).status,'completed');return value;
}
function answer(service:ArcService,q:ReadingQuestion) {
  const run=service.store.get<Run>('run',q.run_id),snapshot=service.store.get<Snapshot>('snapshot',q.source_snapshot_id),file=snapshot.files[0];
  return {schema_version:'reading-1' as const,question_id:q.question_id,binding:run.binding,answer:'返回值由输入 x 加三得到。[answer-source]',evidence:[{evidence_id:'answer-source',source_snapshot_id:snapshot.source_snapshot_id,path:file.path,line_start:1,line_end:3,content_sha256:file.content_sha256,role:'definition' as const,note:'calculate 的返回实现'}],uncertainties:['调用者尚未确认']};
}

test('reading question freezes selected explanation and clues, carries answers forward, and restores from storage',async t=>{
  const {service,project,scenario,snapshot}=await setup(t),result=await savedResult(service,project,scenario,snapshot);
  service.annotate(scenario.scenario_id,'请注意返回的是数值，不是持久化成功',result.result_id,'node');
  const other=service.addFeature(project.project_id,'无关功能');service.annotate(other.scenario.scenario_id,'不应带入的其他功能线索',null,null);
  const input={project_id:project.project_id,scenario_id:scenario.scenario_id,result_id:result.result_id,target:{kind:'node' as const,id:'node'},question:'这个返回值意味着什么？',mode:'mcp' as const,submission_key:'first-reading-key'};
  const first=await service.askReading(input);assert.equal(service.store.get('run',first.run_id).status,'waiting_agent');
  assert.equal(first.context.annotations.length,1);assert.match(JSON.stringify(first.context.existing_explanation),/接收 x/);
  assert.deepEqual((await service.askReading(input)).question_id,first.question_id);
  await assert.rejects(service.askReading({...input,question:'不同问题'}),/幂等/);
  const bridge=new ArcMcpBridge(service,path.resolve('.'));await bridge.enable(project.project_id);
  const task=await bridge.call('arc_begin_analysis',{request_id:'claim-question',question_id:first.question_id});
  assert.deepEqual(task.context,first.context);assert.equal(task.schema_version,'reading-1');assert.equal(task.result_schema.properties.nodes,undefined);
  assert.deepEqual((await bridge.call('arc_list_files',{run_id:first.run_id,query:'main.ts'})).files,snapshot.files);
  const prompt=await makePrompt(service.store.get('run',first.run_id),snapshot,service.directory,[]);
  assert.match(prompt,/返回的是数值/);assert.doesNotMatch(prompt,/不应带入/);
  service.reviseScenario(scenario.scenario_id,'切换后修改场景问题');
  const saved=await bridge.call('arc_submit_result',{run_id:first.run_id,result:answer(service,first)});assert.equal(saved.status,'completed');
  assert.equal(service.data().explanations.length,1,'a small answer must not rewrite the graph');
  const next=await service.askReading({...input,question:'输入是谁传来的？',correction:true,submission_key:'second-reading-key',previous_question_id:first.question_id});
  assert.equal(next.question_revision_id,first.question_revision_id);assert.equal(next.context.reply_to!.question_id,first.question_id);
  assert.match(next.context.reply_to!.answer!,/输入 x 加三/);assert.equal(next.context.annotations.at(-1)!.target!.id,'node');
  const nodeCorrection=next.context.annotations.at(-1)!;
  const contextInput={project,feature:service.store.get('feature',scenario.feature_id),scenario,snapshot,annotations:service.data().annotations,questions:[],sourceMode:'bound' as const,previousSnapshotId:null};
  const stepContext=buildReadingContext({...contextInput,target:{kind:'step',id:'calculation-step'},result:{...result,reading_guide:{steps:[{id:'calculation-step',title:'计算',actor:'函数',text:'计算输入',outcome:'得到返回值',detail:'参数处理',node_ids:['node'],evidence_ids:['ev']}],roles:[],handoffs:[],files:[],paths:[]}}});
  const edgeContext=buildReadingContext({...contextInput,target:{kind:'edge',id:'related-edge'},result:{...result,edges:[{edge_id:'related-edge',kind:'dependency',source_node_id:'node',target_node_id:'node',label:'相关关系',status:'unknown',claim_ids:[],evidence_ids:['ev']}]}});
  for(const related of [stepContext,edgeContext])assert.ok(related.annotations.some(a=>a.annotation_id===nodeCorrection.annotation_id),'a correction on an underlying node must accompany its related step or edge');
  const reopened=new ArcService(service.directory,path.resolve('.'));try{
    assert.equal(reopened.data().questions!.length,2);assert.equal(reopened.store.get('run',next.run_id).status,'waiting_agent');
    assert.equal(reopened.data().questions![0].answer!.evidence[0].content_sha256,snapshot.files[0].content_sha256);
  }finally{reopened.store.close();}
  await bridge.close();
});

test('unexplained files and directories can be asked directly; old and explicit latest snapshots remain distinct',async t=>{
  const {service,root,project,scenario,snapshot}=await setup(t),result=await savedResult(service,project,scenario,snapshot);
  const basic={project_id:project.project_id,scenario_id:scenario.scenario_id,result_id:result.result_id,target:{kind:'node' as const,id:'node'},question:'它现在怎样计算？',mode:'mcp' as const};
  await fs.writeFile(path.join(root,'src/main.ts'),'export function calculate(x:number) {\n  return x + 5;\n}\n');
  const bound=await service.askReading({...basic,submission_key:'bound-reading-key'});assert.equal(bound.source_snapshot_id,snapshot.source_snapshot_id);
  assert.equal((await service.acceptResult(bound.run_id,answer(service,bound))).status,'completed');
  for(let index=0;index<7;index++){
    const recent=await service.askReading({...basic,question:`近期问题 ${index}`,submission_key:`recent-question-${index}`});
    assert.equal((await service.acceptResult(recent.run_id,answer(service,recent))).status,'completed');
  }
  const oldReply=await service.askReading({...basic,question:'继续最早那条答案',previous_question_id:bound.question_id,submission_key:'reply-older-question'});
  assert.equal(oldReply.context.reply_to!.question_id,bound.question_id);assert.match(oldReply.context.reply_to!.answer!,/输入 x 加三/);
  assert.equal(oldReply.context.recent_questions.length,6);assert.ok(!oldReply.context.recent_questions.some(q=>q.question_id===bound.question_id));
  const latest=await service.askReading({...basic,submission_key:'latest-reading-key',source_mode:'latest',previous_question_id:bound.question_id});
  assert.notEqual(latest.source_snapshot_id,bound.source_snapshot_id);assert.equal(latest.context.source.previous_snapshot_id,bound.source_snapshot_id);
  assert.equal((latest.context.existing_explanation as any).historical,true);
  assert.equal(latest.context.reply_to!.question_id,bound.question_id);assert.equal(latest.context.reply_to!.source_snapshot_id,bound.source_snapshot_id);assert.equal(latest.context.reply_to!.historical,true);assert.match(latest.context.reply_to!.answer!,/输入 x 加三/);
  assert.match((await service.source(bound.source_snapshot_id,'src/main.ts')).text,/x \+ 3/);
  assert.match((await service.source(latest.source_snapshot_id,'src/main.ts')).text,/x \+ 5/);
  const continued=await service.askReading({...basic,question:'那失败会怎样？',submission_key:'continue-latest-key',previous_question_id:latest.question_id});
  assert.equal(continued.source_snapshot_id,latest.source_snapshot_id);
  const file=await service.askReading({project_id:project.project_id,target:{kind:'file',id:'src/main.ts'},question:'这个文件负责什么？',mode:'mcp',submission_key:'unexplained-file-key'});
  assert.equal(file.result_id,null);assert.equal(file.context.existing_explanation,null);assert.equal(file.target.id,'src/main.ts');
  const folder=await service.askReading({project_id:project.project_id,target:{kind:'directory',id:'src'},question:'目录的职责？',mode:'mcp',submission_key:'unexplained-folder-key'});
  assert.equal(folder.target.kind,'directory');
  await assert.rejects(service.askReading({...basic,target:{kind:'file',id:'../outside'},submission_key:'outside-file-key'}),/路径/);
});

test('failed answers retain questions; retry and cancellation keep original ownership and validate source anchors',async t=>{
  const {service,project,scenario,snapshot}=await setup(t),result=await savedResult(service,project,scenario,snapshot);
  service.store.put('provider','codex',{provider_id:'codex',status:'auth_required',reason:'测试：缺少授权'});
  const q=await service.askReading({project_id:project.project_id,scenario_id:scenario.scenario_id,result_id:result.result_id,target:{kind:'node',id:'node'},question:'这里做了什么？',mode:'codex',submission_key:'blocked-question-key'});
  await Promise.all(service.executing.values());assert.equal(service.store.get('run',q.run_id).status,'blocked_external');
  const retry=service.retryReading(q.question_id,'mcp','retry-question-key');assert.notEqual(retry.run_id,q.run_id);assert.deepEqual(retry.context,q.context);
  const bad=answer(service,retry);bad.evidence[0].content_sha256='0'.repeat(64);
  assert.equal((await service.acceptResult(retry.run_id,bad)).status,'failed');
  assert.equal(service.data().questions![0].answer,undefined);assert.match(service.store.get('run',retry.run_id).error,/哈希/);
  const again=service.retryReading(q.question_id,'mcp','retry-question-again');
  await service.cancel(again.run_id);await assert.rejects(service.acceptResult(again.run_id,answer(service,again)),/迟到/);
  const final=service.retryReading(q.question_id,'mcp','retry-question-final');
  const wrong=answer(service,final);wrong.binding={...wrong.binding,scenario_id:'other-scenario'};
  assert.equal((await service.acceptResult(final.run_id,wrong)).status,'failed');
  assert.equal(service.data().questions![0].run_ids.length,4);assert.equal(service.data().explanations.length,1);
  const schema=readingAnswerTransportSchema();assert.deepEqual(schema.required,['schema_version','question_id','binding','answer','evidence','uncertainties']);
});
