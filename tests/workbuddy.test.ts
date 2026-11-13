import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkBuddyClient} from '../server/workbuddy-client';
test('WorkBuddy official transport protocol fixture: HTTP 200/business error is not success',async()=>{
  const client=new WorkBuddyClient(async()=>'fixture-token',async()=>new Response(JSON.stringify({code:500,msg:'failure',request_id:'fixture'})) as any);
  await assert.rejects(client.status(),/business error/);
});
test('WorkBuddy fixture preserves submitted identity, encodes cursor, and never calls online a workspace binding',async()=>{
  const requests:any[]=[];
  const client=new WorkBuddyClient(async()=>'fixture-token',async(url,options)=>{
    requests.push({url,options});
    const data=options?.method==='POST'?{message_id:'msg-fixture'}:String(url).includes('?')?{messages:[]}:{online:true};
    return new Response(JSON.stringify({code:0,data}));
  });
  assert.deepEqual(await client.status(),{online:true,workspaceBinding:'unverified'});
  assert.deepEqual(await client.sendMessage('fixture; $(not executed)'),{message_id:'msg-fixture',remote_status:'submitted'});
  await client.messagesAfter('x&y');
  assert.match(requests[2].url,/message_id=x%26y$/);
  assert.equal(JSON.parse(requests[1].options.body).msg_type,'text');
  assert.equal(requests[1].options.redirect,'error');
});
