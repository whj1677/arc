import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {AnalysisResult,Snapshot} from '../src/shared';
import {applyOverviewReview,makeOverviewReviewPrompt,overviewReviewSchema} from '../src/main/overview-review';
import {dshWebPrompt} from '../src/main/dsh-web';
import {sha} from '../src/main/snapshot';

const source='export const read = (db:Database) => db.get("item");\n';
function draft():AnalysisResult{
  const node=(id:string,label:string):AnalysisResult['nodes'][number]=>({node_id:id,kind:'resource',label,description:label,execution_context:{kind:'unknown',identity:null,label:'未确认',status:'unknown',claim_ids:[],evidence_ids:[]},inputs:[],outputs:[],claim_ids:[],evidence_ids:['ev']});
  const claim=(id:string,edge_ids:string[]):AnalysisResult['claims'][number]=>({claim_id:id,statement:id==='read-claim'?'数据库读取服务':'服务使用数据库',status:'source_supported',rationale:'待语义复核',limitations:[],evidence_ids:['ev'],targets:{node_ids:edge_ids.length?['db','reader']:[],edge_ids,io_ids:[]}});
  return {schema_version:'1.0',fictional:false,result_id:'draft',binding:{project_id:'project',feature_id:'feature',scenario_id:'scenario',question_revision_id:'revision',source_snapshot_id:'frozen',run_id:'run'},provider:{provider_id:'codex',connection_id:'local-codex',adapter_version:'0.1.0'},
    summary:{text:'服务使用数据库',claim_ids:['summary-claim']},coverage:{covered_scope:['读取入口'],unresolved_scope:['未运行']},
    nodes:[node('reader','读取服务'),node('db','数据库')],
    edges:[{edge_id:'backward-read',kind:'data_read',source_node_id:'db',target_node_id:'reader',label:'数据库读取服务',status:'source_supported',claim_ids:['read-claim'],evidence_ids:['ev']},{edge_id:'dependency',kind:'dependency',source_node_id:'reader',target_node_id:'db',label:'使用数据库',status:'source_supported',claim_ids:['dependency-claim'],evidence_ids:['ev']}],
    claims:[claim('summary-claim',[]),claim('read-claim',['backward-read']),claim('dependency-claim',['dependency'])],
    evidence:[{evidence_id:'ev',source_snapshot_id:'frozen',path:'src/read.ts',line_start:1,line_end:1,content_sha256:sha(source),role:'context',note:'读取实现'}],gaps:[],architecture:{node_ids:['reader','db'],edge_ids:['backward-read','dependency']}};
}
function review(result:AnalysisResult){return {schema_version:'overview-review-1',run_id:result.binding.run_id,source_snapshot_id:result.binding.source_snapshot_id,draft_sha256:sha(JSON.stringify(result)),summary:{verdict:'supported',reason:'源码有数据库读取'},relations:result.edges.map(edge=>({edge_id:edge.edge_id,verdict:'supported',reason:'来源支持',evidence_ids:[...edge.evidence_ids]}))};}

test('overview review rejects omitted, duplicate or invented relations and mismatched task/draft bindings',()=>{
  const result=draft(),valid=review(result);
  for(const key of ['run_id','source_snapshot_id','draft_sha256'] as const)assert.throws(()=>applyOverviewReview({...valid,[key]:key==='draft_sha256'?'0'.repeat(64):'different'},result),/不匹配/);
  assert.throws(()=>applyOverviewReview({...valid,relations:valid.relations.slice(1)},result),/遗漏/);
  assert.throws(()=>applyOverviewReview({...valid,relations:[valid.relations[0],valid.relations[0]]},result),/重复/);
  assert.throws(()=>applyOverviewReview({...valid,relations:[...valid.relations,{...valid.relations[0],edge_id:'invented'}]},result),/未知/);
  assert.throws(()=>applyOverviewReview({...valid,extra:'not allowed'},result),/格式错误/);
});

test('a rejected direction is excluded instead of silently changing its kind, preserving the original draft',()=>{
  for(const verdict of ['contradicted','uncertain']){
    const result=draft(),original=structuredClone(result),value=review(result);
    value.relations[0]={...value.relations[0],verdict,reason:'data_read 应从读取服务指向数据库；本条方向相反'};
    const applied=applyOverviewReview(value,result);
    assert.equal(applied.checked,2);assert.equal(applied.excluded,1);assert.deepEqual(result,original);
    assert.deepEqual(applied.result.edges,[result.edges[1]]);assert.deepEqual(applied.result.architecture?.edge_ids,['dependency']);
    assert.deepEqual(applied.result.claims,[result.claims[0],result.claims[2]]);assert.deepEqual(applied.result.nodes,result.nodes);
    assert.match(applied.result.gaps[0].question,/backward-read.*数据库读取服务.*方向相反/);
    assert.match(applied.result.gaps[0].impact,/模型复核不等于事实证明/);
    assert.deepEqual(applied.result.coverage.unresolved_scope,['未运行',applied.result.gaps[0].question]);
  }
});

test('review requires original relation evidence, rejects contradicted summaries, and marks uncertain summaries',()=>{
  const result=draft(),value=review(result);
  for(const ids of [[],['new-evidence']])assert.throws(()=>applyOverviewReview({...value,relations:[{...value.relations[0],evidence_ids:ids},value.relations[1]]},result),/原始依据/);
  const reason='摘要声称完成了源码未证明的全部业务';
  assert.throws(()=>applyOverviewReview({...value,summary:{verdict:'contradicted',reason}},result),/摘要未通过.*源码未证明/);
  const applied=applyOverviewReview({...value,summary:{verdict:'uncertain',reason}},result).result;
  const [gap]=applied.gaps;
  assert.equal(gap.gap_id,'overview-review-summary');
  assert.equal(gap.reason,reason);
  assert.deepEqual(applied.coverage.unresolved_scope,[...result.coverage.unresolved_scope,gap.question]);
  assert.deepEqual(applied.claims[0].limitations,[`独立复核提示摘要仍有未完全覆盖的细节：${reason}`]);
  assert.deepEqual(applied.architecture,result.architecture);
});

test('a rejected edge with a shared claim requires a new draft instead of breaking other facts',()=>{
  const result=draft();
  const shared={...result,summary:{...result.summary,claim_ids:[...result.summary.claim_ids,'read-claim']}};
  const value=review(shared);value.relations[0].verdict='contradicted';
  assert.throws(()=>applyOverviewReview(value,shared),/共享断言：read-claim/);
});

test('review prompt carries frozen source excerpts, component labels and exact draft binding',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-overview-review-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'snapshots','frozen','src'),{recursive:true});
  await fs.writeFile(path.join(dir,'snapshots','frozen','src','read.ts'),source);
  const result=draft(),snapshot:Snapshot={source_snapshot_id:'frozen',project_id:'project',captured_at:'2026-11-13T00:00:00Z',root_path:path.join(dir,'unavailable-live-tree'),files:[{path:'src/read.ts',content_sha256:sha(source),bytes:Buffer.byteLength(source),line_count:1,encoding:'utf-8'}],excluded:[],fingerprint:'fingerprint',commit:null,dirty:null,build_config:'',consistency:'verified'};
  const prompt=await makeOverviewReviewPrompt(result,snapshot,dir),input=JSON.parse(prompt.split('待复核输入：')[1]);
  const dshPrompt=dshWebPrompt({prompt,outputSchema:overviewReviewSchema});
  assert.ok(dshPrompt.includes(JSON.stringify(overviewReviewSchema)));
  assert.deepEqual(JSON.parse(dshPrompt.split('待复核输入：')[1]),input);
  assert.equal(input.draft_sha256,sha(JSON.stringify(result)));assert.equal(input.source_snapshot_id,'frozen');
  assert.equal(input.evidence.length,1);assert.match(input.evidence[0].source,/1: export const read/);
  assert.equal(input.components[0].label,'读取服务');assert.equal(input.relations[0].claims[0].statement,'数据库读取服务');
  assert.match(prompt,/Promise.*不代表同步调用/);assert.match(prompt,/非空子集/);assert.match(prompt,/不得把初稿结论本身当作支持依据/);
  assert.match(prompt,/同一共享字段的写入与读取.*同一回调槽的注册与调用/);
  assert.match(prompt,/原始 evidence_ids 已覆盖双方.*给 supported.*覆盖双方的原始依据/);
  await fs.writeFile(path.join(dir,'snapshots','frozen','src','read.ts'),'changed');
  await assert.rejects(makeOverviewReviewPrompt(result,snapshot,dir),/哈希不匹配/);
});
