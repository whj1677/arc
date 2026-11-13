import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makePrompt} from '../src/main/providers';
import {listFrozenFiles} from '../src/main/prompt-context';
import {analysisErrorMessage} from '../src/ui/AnalysisError';
import type {Snapshot,Run,Annotation} from '../src/shared';

const snapshot:Snapshot={source_snapshot_id:'snapshot-large',project_id:'project',captured_at:'',root_path:'',fingerprint:'fingerprint',commit:null,dirty:null,build_config:'',consistency:'verified',excluded:[],files:Array.from({length:10000},(_,i)=>({path:`project-${i%23}/module-${i}/nested-component-${i}/source-${i}.ts`,content_sha256:String(i).padStart(64,'0'),bytes:1234,line_count:100,encoding:'utf-8'}))};
test('large project prompt remains small while every manifest entry can be discovered with its exact hash',async()=>{
  const run={question:'开始派单怎样运转',provider_id:'codex',binding:{run_id:'run',source_snapshot_id:snapshot.source_snapshot_id}} as Run;
  const annotations=Array.from({length:100},()=>({text:'历史线索'.repeat(20000),source_snapshot_id:'old',object_id:null})) as Annotation[];
  const prompt=await makePrompt(run,snapshot,'unused',annotations,{summary:{text:'旧说明'.repeat(200000)}});
  assert.ok(JSON.stringify(snapshot.files).length>1048576);
  assert.ok(prompt.length<30000,`actual length ${prompt.length}`);
  assert.match(prompt,/arc_list_files/);assert.match(prompt,/next_offset/);assert.match(prompt,/上下文节选/);
  const found=[];let offset:number|null=0;
  while(offset!==null){const page=listFrozenFiles(snapshot,{offset});assert.ok(Buffer.byteLength(JSON.stringify(page))<128*1024);found.push(...page.files);offset=page.next_offset;}
  assert.deepEqual(found,snapshot.files,'no lost or duplicated files after page 500');
  const match=listFrozenFiles(snapshot,{query:'source-9999.ts'});assert.deepEqual(match.files,[snapshot.files[9999]]);
  assert.equal(match.next_offset,null);assert.equal(match.total,1);
  for(const args of [{offset:-1},{limit:101},{offset:0.5},{limit:0}])assert.throws(()=>listFrozenFiles(snapshot,args));
});
test('oversized user question fails before dispatch rather than being silently changed',async()=>{
  await assert.rejects(makePrompt({question:'x'.repeat(16001)} as Run,snapshot,'unused',[]),/尚未调用 Agent/);
});
test('input limit diagnostic has a readable explanation',()=>{
  const message=analysisErrorMessage('Input exceeds the maximum length of 1048576 characters input_too_large');
  assert.match(message,/读取源码前/);assert.ok(!message.includes('1048576'));
});
test('invalid returned result is distinguished from a connection failure',()=>{
 const message=analysisErrorMessage('结果校验失败：/edges/2/kind: must be equal to one of the allowed values');
 assert.match(message,/已返回内容/);assert.match(message,/未保存为正式说明/);
});
