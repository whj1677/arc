import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture} from '../src/main/snapshot';
import {applyDshEdits,runDshRequirement} from '../src/main/dsh-development';
import type {EngineeringTask} from '../src/engineering';

async function fixture(t:TestContext){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'DSH 开发测试 ')),root=path.join(dir,'工程'),storage=path.join(dir,'storage');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(root);
  await fs.writeFile(path.join(root,'a.ts'),'export const value = 1;\r\n');
  await fs.writeFile(path.join(root,'b.ts'),'old\n');
  return {dir,root,storage,snapshot:await capture(root,'project',storage,'')};
}

test('DSH applies only exact existing frozen text files and keeps concurrent changes intact',async t=>{
  const {root,snapshot}=await fixture(t),signal=new AbortController().signal;
  const first={path:'a.ts',content:'export const value = 2;\r\n'},second={path:'b.ts',content:'new\n'};
  await assert.rejects(applyDshEdits(root,['a.ts'],snapshot,[second],signal),/范围/);
  await assert.rejects(applyDshEdits(root,['a.ts'],snapshot,[first,first],signal),/重复/);
  await assert.rejects(applyDshEdits(root,['a.ts'],snapshot,[{...first,content:'x'.repeat(2*1024*1024+1)}],signal),/大小/);
  await fs.writeFile(path.join(root,'b.ts'),'changed by user');
  await assert.rejects(applyDshEdits(root,['a.ts','b.ts'],snapshot,[first,second],signal),/冻结版本/);
  assert.equal(await fs.readFile(path.join(root,'a.ts'),'utf8'),'export const value = 1;\r\n');
  assert.equal(await fs.readFile(path.join(root,'b.ts'),'utf8'),'changed by user');
  await applyDshEdits(root,['a.ts'],snapshot,[first],signal);
  assert.deepEqual(await fs.readFile(path.join(root,'a.ts')),Buffer.from(first.content));
});

test('cancellation after first edit restores original bytes for the whole batch',async t=>{
  const {root,snapshot}=await fixture(t),controller=new AbortController();
  const first=path.join(root,'a.ts'),second=path.join(root,'b.ts');
  const check=controller.signal.throwIfAborted.bind(controller.signal);
  t.mock.method(controller.signal,'throwIfAborted',()=>{
    if(readFileSync(first,'utf8')==='first replacement')controller.abort(Error('test cancellation'));
    check();
  });
  await assert.rejects(applyDshEdits(root,['a.ts','b.ts'],snapshot,[{path:'a.ts',content:'first replacement'},{path:'b.ts',content:'second replacement'}],controller.signal),/test cancellation/);
  assert.equal(await fs.readFile(first,'utf8'),'export const value = 1;\r\n');assert.equal(await fs.readFile(second,'utf8'),'old\n');
});

test('offline ACP fixture reads actual frozen source, retries invalid model output only once and returns the validated plan',async t=>{
  const {dir,root,snapshot,storage}=await fixture(t);
  const configured=path.join(dir,'fake ACP.cjs');
  const plan={summary:'保留导出名称，调整常量',proposed_scope:['a.ts'],requirement_package:{behaviors:[{id:'value',behavior:'返回值为 2',design:'更改常量初始值',files:['a.ts'],step_ids:['change'],verification:'检查导出值'}]},steps:[{step_id:'change',title:'调整常量',change:'更新初始化',status:'pending',progress:'等待审阅',criteria:[{criterion_id:'value',text:'导出的 value 为 2',evidence_ids:[]}],evidence_ids:[],unresolved:[]}],decisions:[],unresolved:[]};
  const host=[
    "if(process.argv.includes('--version')){console.log('0.2.1-rc.2');process.exit(0);}",
    "const send=o=>console.log(JSON.stringify({jsonrpc:'2.0',...o}));let tools;",
    "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{",
    "const {id,method,params}=JSON.parse(line);const result=value=>send({id,result:value});",
    "if(method==='initialize')return result({protocolVersion:1});",
    "if(method==='session/new'){tools=params.mcpServers;return result({sessionId:'offline'});}",
    "if(method==='session/close')return result({}); if(method!=='session/prompt')return;",
    "const source=tools[0],call=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'arc_read_source',arguments:{path:'a.ts'}}});",
    "const raw=require('node:child_process').execFileSync(source.command,source.args,{input:call+'\\n',encoding:'utf8',windowsHide:true});",
    "const content=JSON.parse(raw).result.content[0].text;if(!content.includes('export const value = 1'))throw Error('source was not frozen');",
    "const update=u=>send({method:'session/update',params:{sessionId:'offline',update:u}});",
    "update({sessionUpdate:'tool_call',toolCallId:'1',title:'arc-frozen-source__arc_read_source',rawInput:{path:'a.ts'}});",
    "update({sessionUpdate:'tool_call_update',toolCallId:'1',status:'completed',content:[{type:'content',content:{type:'text',text:content}}]});",
    "const output=params.prompt[0].text.includes('上次结果未保存')?"+JSON.stringify(plan)+":{summary:'incomplete'};",
    "update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text:JSON.stringify(output)}});return result({stopReason:'end_turn'});});",
  ].join('\n');
  await fs.writeFile(configured,host);
  const former=process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY='offline-fixture-no-network';
  t.after(()=>{if(former===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=former;});
  await fs.writeFile(path.join(root,'a.ts'),'local workspace content must not be read');
  const task={task_id:'test',goal:'调整常量',project_id:'project',workflow:'analysis'} as EngineeringTask;
  const events:any[]=[];let validated=0;
  const answer=await runDshRequirement({task,snapshot,storage,resources:path.resolve('.'),configured,selectedSource:'old anchor',signal:new AbortController().signal,event:e=>events.push(e),validatePlan:async result=>{
    assert.deepEqual(result.requirement_package,plan.requirement_package);validated++;
  }});
  assert.equal(validated,1);assert.equal(answer.steps?.[0].criteria[0].criterion_id,'value');
  assert.equal(events.filter(e=>e.stage==='dsh_repair').length,1);assert.equal(events.filter(e=>e.type==='dsh.source_read').length,2);
  assert.ok(!JSON.stringify(events).includes('export const'));assert.equal(await fs.readFile(path.join(root,'a.ts'),'utf8'),'local workspace content must not be read');
});
