import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ArcService} from '../src/main/service';
import {validateResult} from '../src/main/validation';
import type {runCodex} from '../src/main/providers';
import type {Run,Snapshot,AnalysisResult} from '../src/shared';
const resource=path.resolve('.');

async function context(codexRunner?:typeof runCodex, emit?:ConstructorParameters<typeof ArcService>[2]){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-test-'));const project=path.join(dir,'中文 工程');await fs.mkdir(project);await fs.writeFile(path.join(project,'source.c'),'int calculate(int x) {\r\n  return x + 3;\r\n}\r\n');return {dir,project,service:new ArcService(path.join(dir,'data'),resource,emit,codexRunner)};}
function resultFor(run:Run,snapshot:Snapshot,evidence: Partial<AnalysisResult['evidence'][number]> = {}):AnalysisResult {
  const file=snapshot.files[0];
  return {schema_version:'1.0',fictional:false,result_id:'result-'+run.binding.run_id,binding:run.binding,provider:{provider_id:run.provider_id,connection_id:'local-'+run.provider_id,adapter_version:'0.1.0'},summary:{text:'计算输入加三',claim_ids:['claim']},coverage:{covered_scope:['calculate'],unresolved_scope:['调用入口未提供']},nodes:[{node_id:'node',kind:'function',label:'calculate',description:'输入加三',execution_context:{kind:'unknown',identity:null,label:'未知调用上下文',status:'unknown',claim_ids:[],evidence_ids:[]},inputs:[{io_id:'input',name:'x',availability:'specified',data_type:'int',value_or_shape:null,description:'输入参数',claim_ids:['claim'],evidence_ids:['ev']}],outputs:[],claim_ids:['claim'],evidence_ids:['ev']}],edges:[],claims:[{claim_id:'claim',statement:'calculate 返回 x+3',status:'source_supported',rationale:'函数体',limitations:['无实际运行记录'],evidence_ids:['ev'],targets:{node_ids:['node'],edge_ids:[],io_ids:['input']}}],evidence:[{evidence_id:'ev',source_snapshot_id:snapshot.source_snapshot_id,path:file.path,line_start:1,line_end:3,content_sha256:file.content_sha256,role:'definition',note:'函数体',...evidence}],gaps:[{gap_id:'gap',kind:'missing_entry',question:'谁调用此函数',impact:'调用上下文未知',suggested_action:'补充入口',related_node_ids:['node'],claim_ids:[],evidence_ids:[]}]};
}

for(const outcome of ['completed','still invalid','invalid JSON','cancel before repair','cancel during repair'] as const) {
  test(`Codex validation repair: ${outcome}`,async t=>{
    const calls:Parameters<typeof runCodex>[0][]=[];
    let stops=0;
    const {dir,project,service}=await context(async options=>{
      calls.push(options);
      const value=resultFor(options.run,options.snapshot,calls.length===1 ? {path:'missing-draft.c'} : undefined);
      if(calls.length===2) {
        assert.equal(options.shouldStart?.(),true);
        if(outcome==='still invalid') return {code:0,raw:JSON.stringify({...value,evidence:[{...value.evidence[0],content_sha256:'0'.repeat(64)}]}),stderr:''};
        if(outcome==='invalid JSON') return {code:0,raw:'invalid JSON',stderr:''};
        if(outcome==='cancel during repair') {
          options.started({child:{pid:123} as any,cancel:async()=>{stops++;}});
          assert.equal(service.active.has(options.run.binding.run_id),true);
          await service.cancel(options.run.binding.run_id);
        }
      }
      return {code:0,raw:JSON.stringify(value),stderr:''};
    },event=>{
      if(outcome==='cancel before repair' && event.type==='run_event' && event.event.stage==='repairing_validation'){
        void service.cancel(event.run_id);
      }
    });
    t.after(async()=>{service.store.close();await fs.rm(dir,{recursive:true,force:true});});
    const opened=await service.openProject(project),{scenario}=service.addFeature(opened.project_id,'函数链');
    service.store.put('provider','codex',{status:'available',checked_at:new Date().toISOString()});
    const run=await service.startRun(scenario.scenario_id,'codex','repair-test-key');
    const runId=run.binding.run_id;
    await service.executing.get(runId);
    assert.equal(calls.length,outcome==='cancel before repair'?1:2);
    if(calls.length===2){
      const [primary,repair]=calls;
      assert.equal(repair.reasoningEffort,'low');
      assert.equal(repair.outputDirectory,path.join(path.dirname(run.output_path),'repair'));
      assert.equal(repair.outputPath,path.join(repair.outputDirectory!,'result.json'));
      assert.equal(primary.outputPath,undefined);
      const draft=resultFor(primary.run,primary.snapshot,{path:'missing-draft.c'});
      const report=await validateResult(draft,primary.run,primary.snapshot,service.directory);
      assert.ok(report.errors.length > 0);
      for(const error of report.errors) assert.ok(repair.prompt.split('\n').includes('- ' + error), error);
      assert.ok(repair.prompt.includes(JSON.stringify(draft)));
      assert.match(repair.prompt,/arc_read_source \/ arc_list_files/);
    }
    const saved=service.store.get<Run>('run',runId);
    const events=service.store.events(runId);
    assert.equal(events.filter(event=>event.stage==='repairing_validation').length,1);
    assert.equal(service.active.has(runId),false);
    assert.equal(stops,outcome==='cancel during repair'?1:0);
    const explanations=service.data().explanations;
    assert.equal(explanations.length,outcome==='completed'?1:0);
    if(outcome==='completed'){
      assert.equal(saved.status,'completed');
      assert.deepEqual(saved.validation?.errors,[]);
      assert.deepEqual(explanations[0].result.binding,run.binding);
      assert.equal(explanations[0].result.evidence[0].path,'source.c');
    }else if(outcome==='still invalid'||outcome==='invalid JSON'){
      assert.equal(saved.status,'failed');
      assert.match(saved.error!,/结果校验失败/);
      assert.match(saved.error!,outcome==='still invalid'?/哈希/:/文件不在本次授权快照内/);
      if(outcome==='invalid JSON') assert.ok(events.some(event=>event.stage==='repair_failed'&&/JSON/.test(event.message)));
    }else{
      assert.equal(saved.status,'cancelled');
    }
  });
}
