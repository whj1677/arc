import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AcpConnection,redact,CodexTurnErrors,codexChildEnvironment,runCodex,readingWatchdog,isSupportedCodexVersion,codexFeatureFlags,reasoningEffortForRun} from '../src/main/providers';

test('direct Codex execution cannot inherit a desktop tool pipe or the calling session identity',()=>{
  const parent={PATH:'path',CODEX_HOME:'owned-codex-home',HTTPS_PROXY:'existing-proxy',CODEX_APP_TOOLS_PIPE_PATH:'host-pipe',CODEX_APP_RUNTIME_CLI_PATH:'host-cli',CODEX_THREAD_ID:'host-thread',CODEX_SESSION_ID:'host-session',CODEX_PERMISSION_PROFILE:'host-permissions',ELECTRON_RUN_AS_NODE:'1'};
  const child=codexChildEnvironment(parent);
  assert.deepEqual(child,{PATH:'path',CODEX_HOME:'owned-codex-home',HTTPS_PROXY:'existing-proxy'});
  assert.equal(parent.CODEX_APP_TOOLS_PIPE_PATH,'host-pipe','the parent process and user settings remain unchanged');
});

test('a changed executable cannot reuse a previously accepted Codex profile',async()=>{
  await assert.rejects(runCodex({profile:{path:process.execPath,version:'codex-cli 0.163.0-alpha.10.2'}} as any),/Codex 程序版本已变化.*尚未派发分析/);
});

test('DSH result tool stages one schema-valid result in its run directory',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'arc-staged-result-'));
  const contextPath=path.join(directory,'source-context.json');
  const resultPath=path.join(directory,'submitted-result.json');
  await fs.writeFile(contextPath,JSON.stringify({
    resultSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false},
  }));
  const child=spawn(process.execPath,[path.resolve('dist/context-server.cjs'),contextPath],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const client=new AcpConnection(child,()=>{});
  try{
    const {tools}=await client.request('tools/list',{});
    assert.deepEqual(tools.map((tool:{name:string})=>tool.name),['arc_list_files','arc_read_source','arc_submit_result']);
    const submit=(args:object)=>client.request('tools/call',{name:'arc_submit_result',arguments:args});
    assert.equal((await submit({summary:123})).isError,true);
    await assert.rejects(fs.access(resultPath),{code:'ENOENT'});
    assert.equal((await submit({summary:'approved result'})).isError,undefined);
    assert.equal((await submit({summary:'replacement'})).isError,true);
    assert.deepEqual(JSON.parse(await fs.readFile(resultPath,'utf8')),{summary:'approved result'});
  }finally{
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    child.stdin.end();
    await closed;
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test('reading questions and detailed function analysis both stop after five minutes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const events:any[]=[];let stopped=0,error='';
  const stop=async()=>{stopped++;};
  const deadline=readingWatchdog({reading_question_id:'reading-timeout'},stop,message=>{error=message;},event=>events.push(event),()=>assert.fail('stopping should succeed'));
  let detailed='';const full=readingWatchdog({},stop,message=>{detailed=message;},()=>{},()=>assert.fail('stopping should succeed'));
  t.mock.timers.tick(5*60*1000-1);assert.equal(stopped,0);assert.equal(error,'');
  t.mock.timers.tick(1);await Promise.resolve();assert.equal(stopped,2);assert.match(detailed,/功能与调用链分析/);assert.match(error,/5 分钟.*已收原文保留/);assert.equal(events[0].stage,'timeout');
  clearTimeout(deadline);clearTimeout(full);
});

test('a reading timeout reports a rejected stop instead of continuing to wait silently',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const stopError=new Error('process could not be terminated'),failures:unknown[]=[],events:any[]=[];
  readingWatchdog({reading_question_id:'reading-stop-failed'},async()=>{throw stopError;},()=>{},event=>events.push(event),error=>failures.push(error));
  t.mock.timers.tick(5*60*1000);await Promise.resolve();
  assert.deepEqual(failures,[stopError]);assert.equal(events[0].stage,'timeout');
});
test('overview generation and relation review share the same five-minute deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const run={overview_format:'overview-1' as const,created_at:new Date().toISOString()};
  let stopped=0;
  const first=readingWatchdog(run,async()=>{stopped++;},()=>{},()=>{},()=>{});
  t.mock.timers.tick(120000);clearTimeout(first);
  const review=readingWatchdog(run,async()=>{stopped++;},()=>{},()=>{},()=>{});
  t.mock.timers.tick(179999);assert.equal(stopped,0);
  t.mock.timers.tick(1);await Promise.resolve();assert.equal(stopped,1);clearTimeout(review);
});

test('long analysis waits beyond the former limit and accepts a later terminal reply',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  const client=new AcpConnection(child as any,()=>{});let settled=false;
  const result=client.request('session/prompt',{sessionId:'long'},null).finally(()=>{settled=true;});
  t.mock.timers.tick(24*60*60*1000);await Promise.resolve();assert.equal(settled,false);
  child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{stopReason:'end_turn'}})+'\n');
  assert.deepEqual(await result,{stopReason:'end_turn'});
});

test('unlimited analysis still reports disconnects and sends user cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  const client=new AcpConnection(child as any,()=>{});const frames:string[]=[];child.stdin.on('data',b=>frames.push(String(b)));
  const cancelled=client.request('session/prompt',{sessionId:'cancel-me'},null);
  client.notify('session/cancel',{sessionId:'cancel-me'});assert.match(frames.join(''),/session\/cancel/);
  child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{stopReason:'cancelled'}})+'\n');assert.deepEqual(await cancelled,{stopReason:'cancelled'});
  const pending=client.request('session/prompt',{sessionId:'lost'},null);const rejected=assert.rejects(pending,/连接已关闭/);child.emit('close');await rejected;
});

test('connection handshake retains its finite deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  const client=new AcpConnection(child as any,()=>{});
  const rejected=assert.rejects(client.request('initialize',{}),/initialize 超时；不能据此重发任务/);
  t.mock.timers.tick(20001);await rejected;
});
import {normalizeTransport,schema,transportSchema} from '../src/main/validation';
import Ajv2020 from 'ajv/dist/2020';
test('Codex transport rejects contradictory unknown or unsupported execution contexts before generation',()=>{
  const wire=transportSchema(),check=new Ajv2020({strict:false}).compile({$defs:wire.$defs,$ref:'#/$defs/execution_context'});
  const context={kind:'unknown',identity:null,label:'执行上下文未查明',status:'unknown',claim_ids:[],evidence_ids:[]};
  assert.equal(check(context),true);
  assert.equal(check({...context,status:'source_supported',claim_ids:['component-responsibility']}),false);
  assert.equal(check({...context,identity:'invented-thread'}),false);
  assert.equal(check({...context,kind:'caller',status:'source_supported',claim_ids:['call-context']}),true);
  assert.equal(check({...context,kind:'caller',status:'source_supported'}),false);
});
test('Codex transport schema keeps references pure without changing the canonical contract',()=>{
  const canonical=JSON.stringify(schema),wire=transportSchema();let count=0;
  function inspect(value:any){if(!value||typeof value!=='object')return;if(value.$ref){count++;assert.deepEqual(Object.keys(value),['$ref']);}if(value.enum){assert.ok(value.type);for(const item of value.enum)assert.equal(typeof item,value.type);}assert.ok(!Object.hasOwn(value,'const'));if(value.properties){assert.deepEqual(value.required,Object.keys(value.properties));assert.equal(value.additionalProperties,false);}Object.values(value).forEach(inspect);}
  inspect(wire);assert.ok(count>10);assert.equal(JSON.stringify(schema),canonical);
  assert.deepEqual(wire.properties.schema_version,{type:'string',enum:['1.0']});
  assert.deepEqual(wire.$defs.provider.properties.provider_id.enum,schema.$defs.provider.properties.provider_id.enum);
});
test('recovered Codex transport warnings remain events without poisoning a successful turn',()=>{
  const recovered=new CodexTurnErrors();recovered.accept({type:'error',message:'Reconnecting... 2/5 (request timed out)'});recovered.accept({type:'turn.completed'});assert.equal(recovered.failure(0),undefined);
  assert.match(recovered.failure(1)!,/timed out/);
  recovered.accept({type:'turn.failed',error:{message:'Invalid schema'}});assert.equal(recovered.failure(0),'Invalid schema');
});
test('ACP malformed frames poison the connection; no fake retry or plaintext success',async()=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  const client=new AcpConnection(child as any,()=>{});
  const pending=client.request('initialize',{},1000);
  child.stdout.write('{"jsonrpc":"wrong","id":1,"result":{}}\n');
  await assert.rejects(pending,/JSON-RPC/);
  await assert.rejects(client.request('session/new',{}),/JSON-RPC/);
});
test('Normalization removes only redundant references, never duplicate definitions or invents evidence',()=>{
  const audit:string[]=[],value={nodes:[{node_id:'same'},{node_id:'same'}],evidence_ids:['x','x'],outputs:[{data_type:null}]};
  normalizeTransport(value,audit);
  assert.equal(value.nodes.length,2);assert.deepEqual(value.evidence_ids,['x']);assert.equal(value.outputs[0].data_type,null);
  assert.equal(audit.length,1);assert.match(audit[0],/duplicate references/);
});
test('Provider diagnostic redaction strips known credential shapes',()=>{
  const output=redact('Bearer fixture-token-123 {"access_token":"fixture-secret","client_secret":"fixture-client"} sk-fixture123456789012');
  for(const secret of ['fixture-token','fixture-secret','fixture-client','sk-fixture'])assert.ok(!output.includes(secret));
});
test('Codex semver capability check supports modern versions and picks version-appropriate feature flags',()=>{
  assert.equal(isSupportedCodexVersion('codex-cli 0.163.0-alpha.10.2'),true);
  assert.equal(isSupportedCodexVersion('codex-cli 0.167.0-alpha.4.1'),true);
  assert.equal(isSupportedCodexVersion('codex-cli 0.169.0-alpha.11.1'),true);
  assert.equal(isSupportedCodexVersion('codex-cli 1.0.0'),true);
  assert.equal(isSupportedCodexVersion('codex-cli 0.162.9'),false);
  assert.equal(isSupportedCodexVersion('not-codex 1.0.0'),false);
  const legacy=codexFeatureFlags('codex-cli 0.163.0-alpha.10.2');
  assert.ok(legacy.includes('features.web_search=false'));
  assert.ok(!legacy.includes('features.code_mode_host=true'));
  const modern=codexFeatureFlags('codex-cli 0.169.0-alpha.11.1');
  assert.ok(!modern.includes('features.web_search=false'));
  assert.ok(modern.includes('features.code_mode_host=true'));
  assert.ok(modern.includes('features.skip_host_skill_discovery=true'));
  assert.equal(reasoningEffortForRun({reading_question_id:'q1',question:'why?',reading_context:{target:{kind:'node',id:'n1'}} as any}),'low');
  assert.equal(reasoningEffortForRun({reading_question_id:'q2',question:'overview?',reading_context:{target:{kind:'directory',id:'src'}} as any}),'medium');
  assert.equal(reasoningEffortForRun({question:'x'},'overview_recheck'),'low');
});
