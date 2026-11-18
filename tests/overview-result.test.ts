import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {capture} from '../src/main/snapshot';
import {overviewSchema,prepareOverview,overviewPrompt} from '../src/main/overview-result';
import {overviewDiscoveryQuestion} from '../src/main/architecture-analysis';
import {promptContext} from '../src/main/prompt-context';
import type {Run} from '../src/shared';

async function fixture(t:TestContext){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-overview-')),root=path.join(dir,'source'),storage=path.join(dir,'data');
  t.after(async()=>{assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true});});
  await fs.mkdir(root);
  const source=['export const queue:string[] = [];','export const store:string[] = [];','export function submit(value:string) {','  queue.push(value);','}','export function receive() {','  const value=queue.shift();','  if(value)store.push(value);','  return value;','}'].join('\r\n');
  await fs.writeFile(path.join(root,'main.ts'),source);
  const snapshot=await capture(root,'project',storage,'');
  const run:Run={binding:{project_id:'project',feature_id:'feature',scenario_id:'scenario',question_revision_id:'revision',source_snapshot_id:snapshot.source_snapshot_id,run_id:'overview-run'},provider_id:'codex',status:'running',created_at:new Date().toISOString(),question:'了解工程全貌',title:'工程全貌',submission_key:'overview-submit',output_path:''};
  const value={schema_version:'overview-1',summary:{text:'提交先入队，接收时读取队列并写入存储。',evidence_ids:['e-send','e-receive']},scope:'main.ts 的提交、队列和接收实现',unresolved:['真实调用方与运行时行为未验证'],components:[
    {id:'producer',kind:'stage',label:'提交入口',description:'将收到的值加入队列。',inputs:['待加入队列的字符串'],outputs:[],evidence_ids:['e-send']},
    {id:'queue',kind:'resource',label:'内存队列',description:'保存待接收的字符串。',inputs:[],outputs:[],evidence_ids:['e-state']},
    {id:'consumer',kind:'stage',label:'接收入口',description:'从队列取出一个值，有值时写入存储并返回它。',inputs:[],outputs:['从队列取出的值'],evidence_ids:['e-receive']},
    {id:'store',kind:'resource',label:'内存存储',description:'保存接收端写入的字符串。',inputs:[],outputs:[],evidence_ids:['e-state','e-receive']},
  ],features:[{label:'消息处理',items:[{id:'send-feature',label:'提交消息',description:'调用 submit 将消息加入队列。',evidence_ids:['e-send']}]}],relations:[
    {id:'send',kind:'queue_send',source:'producer',target:'queue',label:'入队',description:'submit 将 value 加入 queue。',evidence_ids:['e-send']},
    {id:'receive',kind:'queue_receive',source:'queue',target:'consumer',label:'出队',description:'receive 从 queue 取出一个值。',evidence_ids:['e-receive']},
    {id:'save',kind:'data_publish',source:'consumer',target:'store',label:'有值时写入',description:'receive 在 value 非空时加入 store。',evidence_ids:['e-receive']},
  ],evidence:[
    {id:'e-state',path:'main.ts',start:1,end:2,quote:'export const queue:string[] = [];\nexport const store:string[] = [];'},
    {id:'e-send',path:'main.ts',start:3,end:5,quote:'  queue.push(value);'},
    {id:'e-receive',path:'main.ts',start:6,end:10,quote:'  const value=queue.shift();\n  if(value)store.push(value);'},
  ]};
  return {value,run,snapshot,storage};
}

test('compact overview verifies exact source and maps facts to the existing result without inventing IO or execution context',async t=>{
  const {value,run,snapshot,storage}=await fixture(t),original=structuredClone(value);
  const result=await prepareOverview(value,run,snapshot,storage);
  assert.deepEqual(value,original,'conversion must preserve the original transport for review');
  assert.deepEqual(result.binding,run.binding);assert.equal(result.provider.connection_id,'local-codex');
  assert.deepEqual(result.evidence.map(e=>e.content_sha256),value.evidence.map(()=>snapshot.files[0].content_sha256));
  assert.deepEqual(result.edges.map(e=>[e.edge_id,e.kind,e.source_node_id,e.target_node_id]),value.relations.map(e=>[e.id,e.kind,e.source,e.target]));
  const io=result.nodes[0].inputs[0];assert.equal(io.availability,'partial');assert.equal(io.data_type,null);assert.equal(io.value_or_shape,null);assert.equal(io.description,value.components[0].inputs[0]);
  assert.ok(result.claims.find(c=>c.claim_id===io.claim_ids[0])?.targets.io_ids.includes(io.io_id));
  assert.ok(result.nodes.every(n=>n.execution_context.kind==='unknown'&&n.execution_context.identity===null));
  assert.equal(result.claims.length,value.components.length+value.features[0].items.length+value.relations.length+1);
  const summary=result.claims.find(c=>c.claim_id===result.summary.claim_ids[0]);assert.equal(summary?.status,'inferred');assert.deepEqual(summary?.evidence_ids,value.summary.evidence_ids);
  assert.equal(result.reading_guide,undefined);assert.equal(result.function_walkthroughs,undefined);
  assert.deepEqual(await prepareOverview(value,run,snapshot,storage),result,'conversion is deterministic');
  const prompt=overviewPrompt(run,snapshot,promptContext(snapshot,[]));assert.match(prompt,/overview-1/);assert.match(prompt,/不表示同步完成/);assert.match(prompt,/unresolved/);
  const check=(schema:any)=>{if(schema&&typeof schema==='object'){if(schema.properties){assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,Object.keys(schema.properties));}Object.values(schema).forEach(check);}};check(overviewSchema);
});

test('overview generates source-bound readings with the catalog, preserves a legacy draft without readings',async t=>{
  const {value,run,snapshot,storage}=await fixture(t);
  const reading={node_id:'send-feature',entry:'调用 submit',outcome:'字符串进入队列',steps:[{text:'把传入的值加入队列。',evidence_ids:['e-send']}],boundary:'接收时机与外部调用方未查证。'};
  const current={...run,question:overviewDiscoveryQuestion};
  await assert.rejects(prepareOverview(value,current,snapshot,storage),/readings/);
  const result=await prepareOverview({...value,readings:[reading]},current,snapshot,storage);
  assert.deepEqual(result.feature_catalog?.readings,[reading]);
  assert.equal(result.evidence.find(e=>e.evidence_id===reading.steps[0].evidence_ids[0])?.line_start,3);
  await assert.rejects(prepareOverview({...value,readings:[]},run,snapshot,storage),/功能缺少阅读内容/);
  const empty={...value,features:[],readings:[],unresolved:[]};
  await assert.rejects(prepareOverview(empty,current,snapshot,storage),/功能目录为空/);
  assert.deepEqual((await prepareOverview({...empty,unresolved:['只取得了队列实现，未找到对外业务入口。']},current,snapshot,storage)).feature_catalog?.readings,[]);
  const old=await prepareOverview(value,run,snapshot,storage);
  assert.equal(Object.hasOwn(old.feature_catalog!,'readings'),false);
});

test('compact overview rejects paraphrased quote and changed frozen bytes',async t=>{
  const {value,run,snapshot,storage}=await fixture(t);
  const changed=structuredClone(value);changed.evidence[1].quote='queue.push( value );';
  await assert.rejects(prepareOverview(changed,run,snapshot,storage),/引用原文不在/);
  await fs.appendFile(path.join(storage,'snapshots',snapshot.source_snapshot_id,'main.ts'),'\n// changed');
  await assert.rejects(prepareOverview(value,run,snapshot,storage),/快照缓存哈希不匹配/);
});

test('compact overview rejects a synchronous relation instead of changing its meaning',async t=>{
  const {value,run,snapshot,storage}=await fixture(t);value.relations[0].kind='sync_call';
  await assert.rejects(prepareOverview(value,run,snapshot,storage),/工程全貌格式错误/);
  assert.equal(value.relations[0].kind,'sync_call');
});

test('compact overview rejects missing evidence, invalid endpoints and duplicate object identities',async t=>{
  const {value,run,snapshot,storage}=await fixture(t);
  const missing=structuredClone(value);missing.summary.evidence_ids=['not-read'];
  await assert.rejects(prepareOverview(missing,run,snapshot,storage),/缺失引用 evidence_ids: not-read/);
  const endpoint=structuredClone(value);endpoint.relations[1].target='not-a-component';
  await assert.rejects(prepareOverview(endpoint,run,snapshot,storage),/关系端点不存在|架构关系端点/);
  const featureEndpoint=structuredClone(value);featureEndpoint.relations[1].target='send-feature';
  await assert.rejects(prepareOverview(featureEndpoint,run,snapshot,storage),/架构关系端点/);
  const duplicate=structuredClone(value);duplicate.features[0].items[0].id='producer';
  await assert.rejects(prepareOverview(duplicate,run,snapshot,storage),/重复 ID/);
});
