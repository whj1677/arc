import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Run,Snapshot} from '../src/shared';
import type {OverviewReview} from '../src/main/overview-review';
import {overviewResearchSchema,makeOverviewResearchPrompt,applyOverviewResearch} from '../src/main/overview-research';
import {prepareOverview} from '../src/main/overview-result';
import {sha} from '../src/main/snapshot';
import {overviewRelationSemantics} from '../src/main/architecture-analysis';

async function fixture(t:TestContext,unknown=false,extraLines=0){
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'arc-overview-research-'));
  t.after(()=>fs.rm(storage,{recursive:true,force:true}));
  const lines=['export const db = new Map<string,string>();','export function read() { return db.get("id"); }','export function send() { return transport.send("topic"); }','export const handler = process.env.HANDLER;',...Array.from({length:extraLines},(_,i)=>`// source line ${i+5}`)];
  const source=lines.join('\r\n'),hash=sha(source);
  await fs.mkdir(path.join(storage,'snapshots','snapshot'),{recursive:true});await fs.writeFile(path.join(storage,'snapshots','snapshot','main.ts'),source);
  const snapshot:Snapshot={source_snapshot_id:'snapshot',project_id:'project',captured_at:'2026-11-13T00:00:00Z',root_path:path.join(storage,'unused-live-root'),files:[{path:'main.ts',content_sha256:hash,line_count:lines.length,bytes:Buffer.byteLength(source),encoding:'utf-8'}],excluded:[],fingerprint:'fp',commit:null,dirty:null,build_config:'',consistency:'verified'};
  const run:Run={binding:{project_id:'project',feature_id:'feature',scenario_id:'scenario',question_revision_id:'revision',source_snapshot_id:'snapshot',run_id:'run'},provider_id:'codex',status:'running',created_at:new Date().toISOString(),question:'工程全貌',title:'工程全貌',submission_key:'research-test',output_path:''};
  const value={schema_version:'overview-1',summary:{text:'读取入口使用数据库。',evidence_ids:['old-read']},scope:'main.ts',unresolved:[],components:[
    {id:'reader',kind:'stage',label:'读取入口',description:'读取数据库内容。',inputs:[],outputs:[],evidence_ids:['old-read']},
    {id:'db',kind:'resource',label:'数据库',description:'保存键值。',inputs:[],outputs:[],evidence_ids:['old-read']},
    {id:'sender',kind:'stage',label:'发送入口',description:'发送到传输实现。',inputs:[],outputs:[],evidence_ids:['old-send']},
  ],features:[],relations:[
    {id:'wrong-read',kind:'data_read',source:'db',target:'reader',label:'数据库读取服务',description:'数据库读取服务。',evidence_ids:['old-read']},
    {id:'delivery',kind:'execution_boundary',source:'sender',target:'reader',label:'发送后由读取服务处理',description:'发送后由读取服务处理。',evidence_ids:['old-send']},
  ],evidence:[{id:'old-read',path:'main.ts',start:1,end:2,quote:lines[1]},{id:'old-send',path:'main.ts',start:3,end:3,quote:lines[2]}]};
  const prepared=await prepareOverview(value,run,snapshot,storage);
  const draft=unknown?{...prepared,edges:prepared.edges.map((edge,index)=>index===0?{...edge,status:'unknown' as const}:edge)}:prepared;
  const review:OverviewReview={schema_version:'overview-review-1',run_id:'run',source_snapshot_id:'snapshot',draft_sha256:sha(JSON.stringify(draft)),summary:{verdict:'supported',reason:'read 使用 db'},relations:[{edge_id:'wrong-read',verdict:'contradicted',reason:'data_read 方向相反',evidence_ids:['old-read']},{edge_id:'delivery',verdict:'uncertain',reason:'未看到接收目标的注册',evidence_ids:[]}]};
  const research={schema_version:'overview-research-1',run_id:'run',source_snapshot_id:'snapshot',draft_sha256:sha(JSON.stringify(draft)),relations:[
    {edge_id:'wrong-read',outcome:'resolved',reason:'重读 read 的 db.get，读取入口才是发起方，修正方向。',checked_evidence_ids:['new-read'],proposal:{kind:'data_read',label:'读取数据库',description:'读取入口通过 db.get 读取数据库。',source_node_id:'reader',target_node_id:'db',evidence_ids:['new-read']}},
    {edge_id:'delivery',outcome:'unresolved',reason:'已查 send 和 handler 配置声明；实际接收者由未提供的 HANDLER 环境配置决定。',checked_evidence_ids:['new-config'],proposal:null},
  ],evidence:[{id:'new-read',path:'main.ts',start:2,end:2,quote:lines[1]},{id:'new-config',path:'main.ts',start:3,end:4,quote:lines[3]}]};
  // Exact official CLI item.completed shape; this is a local fixture, not a
  // claim that a real model executed during this unit test.
  const receipt={source_snapshot_id:'snapshot',path:'main.ts',content_sha256:hash,total_lines:lines.length,line_start:1,lines:lines.map((text,index)=>({line:index+1,text}))};
  const event=(payload:unknown=receipt)=>({phase:'overview_research',type:'item.completed',item:{id:'item_6',type:'mcp_tool_call',server:'arc_frozen_source',tool:'arc_read_source',arguments:{path:'main.ts',line_start:1,line_count:lines.length},result:{content:[{type:'text',text:JSON.stringify(payload)}],structured_content:null},error:null,status:'completed'}});
  const apply=(v:unknown=research,events:unknown[]=[event()])=>applyOverviewResearch(v,draft,review,run,snapshot,storage,events);
  return {draft,review,research,receipt,event,apply,run,snapshot,storage};
}

test('research revises an explicit relation candidate and retains genuinely unresolved reading evidence without mutating the draft',async t=>{
  const f=await fixture(t,true),original=structuredClone(f.draft),result=await f.apply();
  assert.deepEqual(f.draft,original);assert.deepEqual(result.resolved,['wrong-read']);
  assert.match(result.unresolved.get('delivery')!,/已查 send.*HANDLER/);
  const corrected=result.draft.edges[0];assert.equal(corrected.source_node_id,'reader');assert.equal(corrected.target_node_id,'db');assert.equal(corrected.kind,'data_read');assert.equal(corrected.label,'读取数据库');assert.deepEqual(corrected.evidence_ids,['new-read']);
  assert.equal(corrected.status,'source_supported');
  const claim=result.draft.claims.find(claim=>corrected.claim_ids.includes(claim.claim_id))!;assert.equal(claim.statement,'读取入口通过 db.get 读取数据库。');assert.match(claim.limitations.at(-1)!,/自动补查修订：.*修正方向/);assert.doesNotMatch(claim.limitations.join('\n'),/尚待独立复核/);
  assert.equal(result.draft.edges[1].status,'unknown');assert.deepEqual(result.draft.edges[1].evidence_ids,['new-config']);assert.equal(result.draft.evidence.length,f.draft.evidence.length+2);
  assert.deepEqual(result.draft.nodes,f.draft.nodes);assert.deepEqual(result.draft.summary,f.draft.summary);
});

test('new evidence requires successful research-phase source receipts with matching hash, path and continuous source lines',async t=>{
  const f=await fixture(t),valid=f.event();
  for(const events of [[],[{...valid,phase:'overview_review'}],[{...valid,type:'item.started'}],[{...valid,item:{...valid.item,status:'failed'}}],[{...valid,item:{...valid.item,error:{message:'read failed'}}}],[{...valid,item:{...valid.item,result:{content:[]}}}]])await assert.rejects(f.apply(f.research,events),/本轮成功实际读取/);
  for(const payload of [
    {...f.receipt,content_sha256:'0'.repeat(64)},{...f.receipt,source_snapshot_id:'old-snapshot'},{...f.receipt,path:'other.ts'},
    {...f.receipt,lines:[]},{...f.receipt,lines:f.receipt.lines.filter(line=>line.line!==3)},
    {...f.receipt,lines:f.receipt.lines.map(line=>line.line===2?{...line,text:'invented source'}:line)},
    {...f.receipt,line_start:2,lines:f.receipt.lines.slice(1,3)},
  ])await assert.rejects(f.apply(f.research,[f.event(payload)]),/本轮成功实际读取/);
});

test('research rejects wrong bindings, missing relations, new endpoints and invalid quote or line provenance',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.apply({...f.research,draft_sha256:'0'.repeat(64)}),/不匹配/);
  await assert.rejects(f.apply({...f.research,relations:f.research.relations.slice(0,1)}),/遗漏/);
  const endpoint=structuredClone(f.research);endpoint.relations[0].proposal!.target_node_id='sender';await assert.rejects(f.apply(endpoint),/原端点/);
  const badQuote=structuredClone(f.research);badQuote.evidence[0].quote='return db.get("invented");';await assert.rejects(f.apply(badQuote),/引用原文不在/);
  const badRange=structuredClone(f.research);badRange.evidence[0].end=5;await assert.rejects(f.apply(badRange),/行范围无效/);
  const long=await fixture(t,false,79),wide=structuredClone(long.research);
  wide.evidence[1].end=82;
  assert.equal((await long.apply(wide)).draft.evidence.find(e=>e.evidence_id==='new-config')?.line_end,82);
  wide.evidence[1].end=83;
  await assert.rejects(long.apply(wide),/超过 80 行：new-config/);
  const reused=structuredClone(f.research);reused.evidence[0].id='old-read';reused.relations[0].checked_evidence_ids=['old-read'];reused.relations[0].proposal!.evidence_ids=['old-read'];await assert.rejects(f.apply(reused),/新证据 ID/);
  const noProposal=structuredClone(f.research);noProposal.relations[0].proposal=null;await assert.rejects(f.apply(noProposal),/修订提案不一致/);
});

test('research refuses to overwrite a rejected edge claim shared with an unchanged fact',async t=>{
  const f=await fixture(t),draft={...f.draft,summary:{...f.draft.summary,claim_ids:[...f.draft.summary.claim_ids,f.draft.edges[0].claim_ids[0]]}};
  const digest=sha(JSON.stringify(draft));
  await assert.rejects(applyOverviewResearch({...f.research,draft_sha256:digest},draft,{...f.review,draft_sha256:digest},f.run,f.snapshot,f.storage,[f.event()]),/共享断言/);
});

test('research prompt scopes automatic source follow-up to rejected relations and uses a strict schema',async t=>{
  const f=await fixture(t),review=structuredClone(f.review);review.relations[1]={...review.relations[1],verdict:'supported',evidence_ids:['old-send']};
  const prompt=makeOverviewResearchPrompt(f.draft,review),input=JSON.parse(prompt.split('待补查关系：')[1]);
  assert.deepEqual(input.relations.map((item:any)=>item.edge_id),['wrong-read']);assert.equal(input.relations[0].endpoint_roles[0].label,'数据库');assert.equal(input.relations[0].original_evidence[0].path,'main.ts');
  assert.match(prompt,/调用链上下游/);assert.match(prompt,/不要把“请用户核对\/补查”当作结果/);assert.match(prompt,/本轮一次成功 arc_read_source/);
  assert.match(prompt,/单段含首尾最多 80 行/);
  assert.ok(prompt.includes(overviewRelationSemantics));
  const strict=(schema:any)=>{if(schema&&typeof schema==='object'){if(schema.properties){assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,Object.keys(schema.properties));}Object.values(schema).forEach(strict);}};strict(overviewResearchSchema);
});
