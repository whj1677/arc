import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Snapshot} from '../src/shared';
import {makeDshWalkthroughReview} from '../src/main/dsh-walkthrough';
import {sha} from '../src/main/snapshot';
import {runDsh} from '../src/main/dsh';

test('walkthrough review receives exact call lines and branches from the frozen snapshot',async()=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'arc-walkthrough-'));
  try{
    const sources={
      'names.ts':'function generate() {\n  ctx.setParams({key})\n  ctx.subschema(key)\n  if (!valid) ctx.error()\n}',
      'extras.ts':'function generate() {\n  if (schema === false) {\n    ctx.setParams({extra})\n    ctx.error()\n  }\n}',
    };
    const sourceId='review-snapshot';
    const directory=path.join(storage,'snapshots',sourceId);
    await fs.mkdir(directory,{recursive:true});
    const files=await Promise.all(Object.entries(sources).map(async([name,source])=>{
      await fs.writeFile(path.join(directory,name),source);
      return {path:name,content_sha256:sha(source),line_count:source.split('\n').length,bytes:Buffer.byteLength(source),encoding:'utf8'};
    }));
    const snapshot:Snapshot={source_snapshot_id:sourceId,project_id:'project',captured_at:'',root_path:storage,files,
      excluded:[],fingerprint:'',commit:null,dirty:null,build_config:'',consistency:'verified'};
    await fs.writeFile(path.join(storage,'names.ts'),'ctx.subschema(key)\nctx.setParams({key})');
    const draft=JSON.stringify({summary:{text:'候选误写为先子校验再设置错误参数'},evidence:[
      {path:'extras.ts',line_start:2,line_end:5,content_sha256:files[1].content_sha256},
      {path:'../outside.ts',line_start:1,line_end:1},
    ]});
    const review=await makeDshWalkthroughReview(draft,snapshot,storage,['names.ts']);
    const excerpts=JSON.parse(review.split('\n').at(-1)!);
    assert.deepEqual(excerpts.map((item:{path:string})=>item.path),['names.ts','extras.ts']);
    assert.deepEqual(excerpts[0].lines.slice(1,4),[
      '2 |   ctx.setParams({key})','3 |   ctx.subschema(key)','4 |   if (!valid) ctx.error()',
    ]);
    assert.equal(excerpts[0].content_sha256,files[0].content_sha256);
    assert.equal(excerpts[1].lines[1],'2 |   if (schema === false) {');
    await fs.writeFile(path.join(directory,'names.ts'),'a modified snapshot');
    await assert.rejects(makeDshWalkthroughReview(draft,snapshot,storage,['names.ts']),/哈希不匹配/);
  }finally{await fs.rm(storage,{recursive:true,force:true});}
});

test('DSH saves only the reviewed turn, with the draft kept separately',async t=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'arc-walkthrough-acp-'));
  t.after(()=>fs.rm(storage,{recursive:true,force:true}));
  const previousKey=process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY='local-test-no-network';
  t.after(()=>{if(previousKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previousKey;});
  const snapshot:Snapshot={source_snapshot_id:'frozen',project_id:'project',captured_at:'',root_path:storage,files:[],
    excluded:[],fingerprint:'',commit:null,dirty:null,build_config:'',consistency:'verified'};
  await fs.mkdir(path.join(storage,'snapshots','frozen'),{recursive:true});
  const configured=path.join(storage,'fixture.cjs');
  await fs.writeFile(configured,`
    const send=message=>console.log(JSON.stringify({jsonrpc:'2.0',...message}));
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const {id,method,params}=JSON.parse(line);
      const reply=result=>send({id,result});
      const sessionId='offline';
      if(method==='initialize')return reply({protocolVersion:1});
      if(method==='session/new')return reply({sessionId});
      if(method==='session/close')return reply({});
      if(method!=='session/prompt')return;
      const text=JSON.stringify({text:params.prompt[0].text.startsWith('Review')?'params first':'reversed draft'});
      send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text}}}});
      reply({stopReason:params.prompt[0].text.startsWith('Cancel')?'cancelled':'end_turn'});
    });
  `);
  const outputPath=path.join(storage,'run','result.json');
  const events:{type:string;result_sha256?:string}[]=[];
  const result=await runDsh({run:{output_path:outputPath,binding:{task_id:'task',source_snapshot_id:'frozen',phase:'walkthrough'}},
    snapshot,storage,resources:path.resolve('.'),profile:{version:'0.2.1-rc.2',path:configured},prompt:'First draft',timeoutMs:5000,
    event:event=>events.push(event),started:()=>{},review:async draft=>{
      assert.equal(JSON.parse(draft).text,'reversed draft');
      await assert.rejects(fs.access(outputPath),{code:'ENOENT'});
      return 'Review from frozen source';
    }});
  assert.equal(JSON.parse(result.raw).text,'params first');
  assert.equal(await fs.readFile(outputPath,'utf8'),result.raw);
  assert.equal(JSON.parse(await fs.readFile(path.join(storage,'run','walkthrough-draft.txt'),'utf8')).text,'reversed draft');
  assert.equal(events.find(event=>event.type==='local.walkthrough_reviewed')?.result_sha256,sha(result.raw));

  const cancelledPath=path.join(storage,'cancelled','result.json');
  const cancelledEvents:string[]=[];
  const cancelled=await runDsh({run:{output_path:cancelledPath,binding:{task_id:'task',source_snapshot_id:'frozen',phase:'walkthrough'}},
    snapshot,storage,resources:path.resolve('.'),profile:{version:'0.2.1-rc.2',path:configured},prompt:'Cancel first turn',timeoutMs:5000,
    event:event=>cancelledEvents.push(event.type),started:()=>{},review:async()=>assert.fail('cancelled draft must not trigger review')});
  assert.equal(cancelled.cancelled,true);
  await assert.rejects(fs.access(cancelledPath),{code:'ENOENT'});
  assert.ok(!cancelledEvents.includes('local.walkthrough_reviewed'));
});
