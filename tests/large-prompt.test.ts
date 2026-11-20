import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makePrompt} from '../src/main/providers';
import {listFrozenFiles,promptContext} from '../src/main/prompt-context';
import {analysisErrorMessage} from '../src/ui/AnalysisError';
import {overviewDiscoveryQuestion} from '../src/main/architecture-analysis';
import type {Snapshot,Run,Annotation} from '../src/shared';

const snapshot:Snapshot={source_snapshot_id:'snapshot-large',project_id:'project',captured_at:'',root_path:'',fingerprint:'fingerprint',commit:null,dirty:null,build_config:'',consistency:'verified',excluded:[],files:Array.from({length:10000},(_,i)=>({path:`project-${i%23}/module-${i}/nested-component-${i}/source-${i}.ts`,content_sha256:String(i).padStart(64,'0'),bytes:1234,line_count:100,encoding:'utf-8'}))};
test('wrapped source inventory groups authored modules and keeps usable entry paths',()=>{
  const paths=[
    'README.md','src/app/main.cpp','src/app/control.cpp','src/mid/protocol.cpp','src/hal/bus/can/driver/codec.h',
    'src/hal/bus/can/driver/frames.cpp','src/mid/boot/init.cpp','misc/settings.sql','src/app/notes.txt',
    ...['tests','test','gtest','glog','third_party','vendor','CMakeFiles','build'].map(dir=>dir+'/main.cpp'),
  ];
  const wrapped={...snapshot,files:paths.map(path=>({...snapshot.files[0],path:'bams_code/'+path}))};
  const inventory=promptContext(wrapped,[]).inventory;
  assert.deepEqual(inventory.source_directories,[
    {dir:'bams_code/src/app',count:2,samples:['main.cpp','control.cpp']},
    {dir:'bams_code/src/hal/bus/can',count:2,samples:['driver/frames.cpp','driver/codec.h']},
    {dir:'bams_code/src/mid',count:1,samples:['protocol.cpp']},
    {dir:'bams_code/src/mid/boot',count:1,samples:['init.cpp']},
    {dir:'bams_code/misc',count:1,samples:['settings.sql']},
  ]);
  assert.deepEqual(inventory.entry_file_hints,['bams_code/README.md','bams_code/src/app/main.cpp','bams_code/src/mid/boot/init.cpp']);
  assert.equal(inventory.largest_roots[0].name,'bams_code/src/');
  const broad={...snapshot,files:Array.from({length:280},(_,i)=>({...snapshot.files[0],path:`wrapper/src/domain${i%35}/${'温度'.repeat(8)}${i}.java`}))};
  const groups=promptContext(broad,[]).inventory.source_directories;
  assert.equal(groups.length,30);
  assert.ok(groups.every(group=>group.count===8&&group.samples.length>=1&&group.samples.length<=6));
  assert.ok(Buffer.byteLength(JSON.stringify(groups))<=4096);
  const longPaths=broad.files.map(file=>({...file,path:file.path.replace('domain','目录'.repeat(45))}));
  const longGroups=promptContext({...snapshot,files:longPaths},[]).inventory.source_directories;
  assert.ok(longGroups.length>0&&longGroups.length<30);
  assert.ok(Buffer.byteLength(JSON.stringify(longGroups))<=4096);
  assert.ok(longGroups.every(group=>longPaths.some(file=>file.path===group.dir+'/'+group.samples[0])));
  const domains=['auth','billing','catalog','devices'];
  const packaged=domains.flatMap(domain=>Array.from({length:10},(_,i)=>({...snapshot.files[0],path:`wrapper/src/main/java/com/acme/${domain}/Service${i}.java`})));
  const [java]=promptContext({...snapshot,files:packaged},[]).inventory.source_directories;
  assert.equal(java.dir,'wrapper/src/main/java/com');
  assert.equal(java.count,40);
  assert.deepEqual(java.samples.slice(0,4),domains.map(domain=>`acme/${domain}/Service0.java`));
});

test('first overview asks for an evidenced architecture and catalog without requesting detailed function walks',async()=>{
  const run={question:overviewDiscoveryQuestion,provider_id:'codex',binding:{run_id:'overview',source_snapshot_id:snapshot.source_snapshot_id}} as Run;
  const prompt=await makePrompt(run,snapshot,'unused',[]);
  assert.match(prompt,/architecture/);assert.match(prompt,/feature_catalog/);assert.match(prompt,/SHA-256/);
  assert.doesNotMatch(prompt,/功能或场景详细分析必须同时提供关键函数调用链/);
  const compact=await makePrompt({...run,overview_format:'overview-1'},snapshot,'unused',[]);
  assert.match(compact,/overview-1/);assert.match(compact,/question_revision_id/);
  assert.ok(compact.length<prompt.length);assert.doesNotMatch(compact,/输出完整 Arc JSON/);
  const detailed=await makePrompt({...run,question:'分析一个功能的完整调用路径'},snapshot,'unused',[]);
  assert.match(detailed,/功能或场景详细分析必须同时提供关键函数调用链/);
});
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
