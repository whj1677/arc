import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {AcpConnection,redact,CodexTurnErrors} from '../src/main/providers';

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
import {dshFinalMessage,parseProviderText} from '../src/main/dsh';
import {normalizeTransport,schema,transportSchema} from '../src/main/validation';
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
test('ACP commentary and final message separated by real messageId; only outer fence removal',()=>{
  const events=[
    {update:{sessionUpdate:'agent_message_chunk',messageId:'commentary',content:{type:'text',text:'前置说明，不属于 JSON'}}},
    {update:{sessionUpdate:'agent_message_chunk',messageId:'final',content:{type:'text',text:'```json\n{"a":'}}},
    {update:{sessionUpdate:'agent_message_chunk',messageId:'final',content:{type:'text',text:'1}\n```'}}}
  ];
  assert.deepEqual(parseProviderText(dshFinalMessage(events),'dsh'),{a:1});
  assert.throws(()=>parseProviderText('前言 {"a":1} 后记','dsh'));
  assert.throws(()=>parseProviderText('{"a":','dsh'));
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
