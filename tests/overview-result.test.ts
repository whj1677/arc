import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {capture} from '../src/main/snapshot';
import {compactEvidence,deferredCatalogReadingBoundary,overviewSchema,prepareOverview,overviewPrompt,OverviewValidationError} from '../src/main/overview-result';
import {overviewDiscoveryQuestion,previousCatalogQuestion} from '../src/main/architecture-analysis';
import {promptContext} from '../src/main/prompt-context';
import {analysisBudget,type Run} from '../src/shared';

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

test('DSH compact citations preserve exact literals and decode at most one source-proven escape layer',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-escape-')),root=path.join(dir,'src'),storage=path.join(dir,'data');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(root);
  const lines=['const sql = "select qty {a} [b] (c)";','  return sql;','const literal = "\\n";'];
  await fs.writeFile(path.join(root,'sample.js'),lines.join('\r\n'));const snapshot=await capture(root,'fixture',storage,'');
  const original=lines.slice(0,2).join('\n'),encoded=JSON.stringify(original).slice(1,-1);
  const quote=(id:string,text:string,start=1,end=2)=>({id,path:'sample.js',start,end,quote:text});
  const audit:string[]=[];
  const checked=await compactEvidence([quote('json',encoded),quote('mixed',lines.slice(0,2).join('\\r\\n')),quote('literal',lines[2],3,3)],snapshot,storage,audit);
  assert.deepEqual(checked.map(item=>item.note),[lines.slice(0,2).join('\r\n'),lines.slice(0,2).join('\r\n'),lines[2]]);
  assert.equal(audit.length,2);assert.match(audit[0],/json: JSON string escape/);assert.match(audit[1],/mixed: escaped newline/);
  for(const wrong of [JSON.stringify(encoded).slice(1,-1),encoded.replace('  return',' return')]){
    await assert.rejects(compactEvidence([quote('bad',wrong)],snapshot,storage,[]),e=>e instanceof OverviewValidationError&&e.evidenceIds?.[0]==='bad');
  }
  await assert.rejects(compactEvidence([quote('other-range',encoded,2,3)],snapshot,storage,[]),OverviewValidationError);
});

test('one repair receives all bad source anchors while snapshot storage errors stay distinct',async t=>{
  const {value,run,snapshot,storage}=await fixture(t);
  value.evidence[0].end=11;value.evidence[1].quote='missing source text';value.evidence[2].path='missing.ts';
  await assert.rejects(prepareOverview(value,run,snapshot,storage),error=>{
    assert.ok(error instanceof OverviewValidationError);
    assert.deepEqual(error.evidenceIds,['e-state','e-send','e-receive']);
    assert.match(error.message,/e-state \(main.ts:1-11.*?文件共 10 行/s);
    assert.match(error.message,/e-send \(main.ts:3-5.*?引用原文不在指定源码片段内/s);
    assert.match(error.message,/e-receive \(missing.ts:6-10.*?文件不在本次授权快照内/s);
    return true;
  });
  await assert.rejects(prepareOverview(value,run,snapshot,path.join(storage,'missing')),error=>!(error instanceof OverviewValidationError));
});

test('frozen line ranges hydrate missing anchors and genuine 240-character delimiter drift only',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-anchor-')),root=path.join(dir,'src'),storage=path.join(dir,'data');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(root);
  const prefix='connect('.padEnd(235,'a')+'this',line=prefix+');';
  await fs.writeFile(path.join(root,'sample.cpp'),line+'\nconst ErrorCode   result = status;\n  \n');
  const snapshot=await capture(root,'fixture',storage,''),anchor={id:'ev',path:'sample.cpp',start:1,end:1};
  const verify=(quote:string|undefined,start=1)=>compactEvidence([{...anchor,quote,start,end:start}],snapshot,storage);
  for(const quote of [undefined,'',prefix+','])assert.equal((await verify(quote))[0].note,line.slice(0,240));
  assert.equal((await verify('ErrorCode result',2))[0].note,'const ErrorCode   result = status;');
  for(const invented of ['const ErrorCode temperature_placeholder',prefix.slice(0,-1)+'x,',prefix+'x',prefix.slice(1)+',']){
    await assert.rejects(verify(invented),/引用原文不在/);
  }
  await assert.rejects(verify(undefined,3),/片段为空/);
  await assert.rejects(verify(undefined,0),/行范围必须有效/);
});

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

test('compact architecture preserves major components alongside nested modules above the old 16-node limit',async t=>{
  const {value,run,snapshot,storage}=await fixture(t);
  const nested=(parent_id:string)=>({...value,components:value.components.map(item=>item.id==='queue'?{...item,parent_id}:item)});
  const input=nested('producer');
  const extra=Array.from({length:14},(_,index)=>({...value.components[0],id:`module-${index}`}));
  const result=await prepareOverview({...input,components:[...input.components,...extra]},run,snapshot,storage);
  assert.deepEqual(result.architecture?.node_ids,[...input.components,...extra].map(node=>node.id));
  assert.equal(result.nodes.find(node=>node.node_id==='queue')?.parent_node_id,'producer');
  assert.ok(result.nodes.filter(node=>node.node_id!=='queue').every(node=>!Object.hasOwn(node,'parent_node_id')));
  await assert.rejects(prepareOverview(nested('send-feature'),run,snapshot,storage),/parent_id 未引用架构组件/);
  await assert.rejects(prepareOverview(nested('queue'),run,snapshot,storage),/父子循环/);
});

test('overview generates source-bound readings with the catalog, preserves a legacy draft without readings',async t=>{
  const {value,run,snapshot,storage}=await fixture(t);
  const reading={node_id:'send-feature',entry:'调用 submit',outcome:'字符串进入队列',steps:[{text:'把传入的值加入队列。',evidence_ids:['e-send']}],boundary:'接收时机与外部调用方未查证。'};
  const current={...run,question:overviewDiscoveryQuestion};
  await assert.rejects(prepareOverview(value,current,snapshot,storage),/readings/);
  await assert.rejects(prepareOverview(value,{...run,question:previousCatalogQuestion},snapshot,storage),/readings/);
  const result=await prepareOverview({...value,readings:[reading]},current,snapshot,storage);
  assert.deepEqual(result.feature_catalog?.readings,[reading]);
  assert.equal(result.evidence.find(e=>e.evidence_id===reading.steps[0].evidence_ids[0])?.line_start,3);
  const clue={...reading,steps:[],boundary:deferredCatalogReadingBoundary};
  const deferred=await prepareOverview({...value,readings:[clue]},current,snapshot,storage);
  assert.deepEqual(deferred.feature_catalog?.readings,[clue]);
  assert.deepEqual(deferred.nodes.find(node=>node.node_id===clue.node_id)?.evidence_ids,['e-send']);
  await assert.rejects(prepareOverview({...value,readings:[]},run,snapshot,storage),/功能缺少阅读内容/);
  const empty={...value,features:[],readings:[],unresolved:[]};
  await assert.rejects(prepareOverview(empty,current,snapshot,storage),/功能目录为空/);
  assert.deepEqual((await prepareOverview({...empty,unresolved:['只取得了队列实现，未找到对外业务入口。']},current,snapshot,storage)).feature_catalog?.readings,[]);
  const old=await prepareOverview(value,run,snapshot,storage);
  assert.equal(Object.hasOwn(old.feature_catalog!,'readings'),false);
});

test('a broad overview preserves 16 groups of 24 verified capabilities and up to 512 anchors',async t=>{
  const {value,run,snapshot,storage}=await fixture(t);
  const [group]=value.features,[feature]=group.items;
  const groups=Array.from({length:16},(_,i)=>({label:`能力族 ${i+1}`,items:Array.from({length:24},(_,j)=>({
    ...feature,id:`feature-${i}-${j}`,evidence_ids:[`anchor-${i*24+j}`],
  }))}));
  const evidence=[...value.evidence,...Array.from({length:512-value.evidence.length},(_,i)=>({...value.evidence[1],id:`anchor-${i}`}))];
  const readings=groups.flatMap(({items})=>items.map(item=>({node_id:item.id,entry:'',outcome:'',steps:[],boundary:deferredCatalogReadingBoundary})));
  const current={...run,question:overviewDiscoveryQuestion};
  const result=await prepareOverview({...value,features:groups,evidence,readings},current,snapshot,storage);
  assert.equal(result.feature_catalog?.groups.length,16);
  assert.equal(result.feature_catalog?.groups[0].node_ids.length,24);
  assert.equal(result.evidence.length,512);
  assert.deepEqual(result.feature_catalog?.readings,readings);
  await assert.rejects(prepareOverview({...value,features:groups,readings,evidence:[...evidence,{...value.evidence[1],id:'extra-anchor'}]},current,snapshot,storage),/\/evidence: must NOT have more than 512 items/);
});

test('overview prompt asks for module-by-module coverage within the first-turn budget',async t=>{
  const {run,snapshot}=await fixture(t);
  const current={...run,question:overviewDiscoveryQuestion};
  const prompt=overviewPrompt(current,snapshot,promptContext(snapshot,[]));
  assert.ok(prompt.includes(`预算共 ${analysisBudget(snapshot).discovery.calls} 次源码工具调用`));
  assert.match(prompt,/完成逐目录清点且证据足够后，提前停止并立即返回完整 JSON/);
  for(const provider_id of ['codex','dsh'] as const){
    const instructions=overviewPrompt({...current,provider_id},snapshot,promptContext(snapshot,[]));
    assert.match(instructions,/先用 list_modules.*list_symbols.*get_call_graph.*arc_search_source/);
    assert.match(instructions,/返回结果前逐项核对 list_modules 的目录/);
    assert.match(instructions,/逐目录清点全部实质模块，不漏模块/);
    assert.match(instructions,/实际实现或公共接口的，都应纳入 features/);
    assert.match(instructions,/按模块独立职责拆分功能项/);
    assert.match(instructions,/约 4 条端到端主线写 steps/);
    const large={...snapshot,files:snapshot.files.map(file=>({...file,line_count:130000}))};
    const broad=overviewPrompt({...current,provider_id},large,promptContext(large,[]));
    assert.match(broad,/约 10 条端到端主线写 steps/);
    assert.ok(broad.includes(`预算共 ${analysisBudget(large).discovery.calls} 次源码工具调用`));
    assert.doesNotMatch(instructions,/30–70|20–50|目标各不超过 6 项|通常不超过 12 个/);
  }
  assert.match(prompt,/inventory\.source_directories.*entry_file_hints.*arc_list_files/);
  assert.match(prompt,/每个次要模块只需一处能确认入口与职责的短锚点/);
  assert.match(prompt,/库 \/ 内核 \/ SDK \/ 框架工程.*核心模块及其公共能力族/);
  assert.match(prompt,/示例 main\(\) 调用的少数 API/);
  assert.match(prompt,/steps: \[\].*功能锚点直接证明的触发入口或处理结果/);
  assert.ok(prompt.includes(deferredCatalogReadingBoundary));
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
