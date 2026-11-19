import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {capture} from '../src/main/snapshot';
import {prepareFunctionGraphs} from '../src/main/function-result';
import {makePrompt} from '../src/main/providers';
import {OverviewValidationError} from '../src/main/overview-result';
import {hasFunctionGraphs,type Run} from '../src/shared';

test('DSH graph transport binds real definitions, ordered call sites and business steps; rejects incorrect anchors or an empty graph',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-function-result-')),root=path.join(dir,'project');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(root);await fs.writeFile(path.join(root,'main.c'),'int read_item(void) {\n  return 1;\n}\nint run(void) {\n  return read_item();\n}\nvoid poll(void) { schedule(poll); }');
  const snapshot=await capture(root,'project',dir,'');
  const run={binding:{run_id:'r',feature_id:'f',project_id:'project',scenario_id:'s',question_revision_id:'q',source_snapshot_id:snapshot.source_snapshot_id},
    provider_id:'dsh',dsh_function_format:'function-1',overview_parent_run_id:'parent',question:'查看读取功能'} as Run;
  const fn=(id:string)=>({id,symbol:id,purpose:'读取值',signature:`int ${id}(void)`,definition:'def-'+id,parameters:[],returns:[{name:'返回值',description:'整数结果',type:'int'}]});
  const entry={kind:'entry',from:null,to:'run',text:'开始读取',input:'无参数',output:'进入读取过程',condition:'',evidence_ids:['def-run']};
  const call={kind:'call',from:'run',to:'read_item',text:'调用读取方法',input:'无参数',output:'整数结果',condition:'',evidence_ids:['site']};
  const evidence=(id:string,line:number,quote:string)=>({id,path:'main.c',start:line,end:line,quote});
  const draft={schema_version:'function-1',summary:'从入口读取一个值',unresolved:['不含运行时耗时'],functions:[fn('run'),fn('read_item')],
    paths:[{label:'读取值',trigger:'调用 run',boundary:'仅核查读取函数',steps:[entry,call]}],
    evidence:[evidence('def-run',4,'int run(void)'),evidence('def-read_item',1,'int read_item(void)'),evidence('site',5,'return read_item();')]};
  const prompt=await makePrompt(run,snapshot,dir,[],{summary:{text:'先前说明'}},true);
  assert.match(prompt,/function-1/);assert.doesNotMatch(prompt,/先前说明/);
  const result=await prepareFunctionGraphs(draft,run,snapshot,dir);
  assert.ok(hasFunctionGraphs(result));assert.equal(result.nodes.some(n=>n.kind==='stage'),true);
  assert.equal(result.nodes.find(n=>n.node_id==='run')?.function_details?.definition_evidence_id,'def-run');
  assert.equal(result.evidence.find(e=>e.evidence_id==='site')?.content_sha256,snapshot.files[0].content_sha256);
  assert.deepEqual(result.function_walkthroughs![0].steps.map(s=>s.kind),['entry','call']);
  assert.deepEqual(result.edges.map(e=>[e.source_node_id,e.target_node_id,e.evidence_ids]),[['run','read_item',['site']]]);
  const polling=structuredClone(draft);
  polling.functions.push({...fn('poll'),signature:'void poll(void)'});
  polling.evidence.push({id:'def-poll',path:'main.c',start:7,end:7,quote:'void poll(void)'},{id:'reschedule',path:'main.c',start:7,end:7,quote:'schedule(poll)'});
  polling.paths.push({...draft.paths[0],steps:[{...entry,to:'poll',evidence_ids:['def-poll']},
    {...call,kind:'dispatch',from:'poll',to:'poll',text:'登记下一次轮询',evidence_ids:['reschedule']}]});
  const selfDispatch=await prepareFunctionGraphs(polling,run,snapshot,dir);
  assert.deepEqual(selfDispatch.claims.find(c=>c.statement==='登记下一次轮询')?.targets.node_ids,['poll']);
  const bad=structuredClone(draft);bad.evidence[2].start=1;bad.evidence[2].end=1;
  await assert.rejects(prepareFunctionGraphs(bad,run,snapshot,dir),e=>e instanceof OverviewValidationError&&e.evidenceIds?.join()==='site');
  const missing=structuredClone(draft);missing.paths[0].steps[1]={...call,kind:'work',to:'run'};
  await assert.rejects(prepareFunctionGraphs(missing,run,snapshot,dir),/缺少有依据的跨函数调用/);
});
