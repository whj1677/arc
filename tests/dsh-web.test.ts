import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DshRemote,launchUrl,cleanDshLog} from '../src/main/dsh-web';
function transport(handler:(method:string,request:any)=>any){const calls:any[]=[];const fetcher=(async(url:any,init:any)=>{calls.push({url,init});if(!init?.body)return new Response(null,{status:303,headers:{location:'./','set-cookie':'dsh-auth=abc123; HttpOnly; Path=/'}});const req=JSON.parse(init.body);return Response.json({type:'server-response',rpcId:req.rpcId,result:{ok:true,value:handler(req.method,req.payload.args.request)}});}) as typeof fetch;return {fetcher,calls};}
test('native Web launch is restricted to the owned loopback origin; token is redacted',()=>{
 assert.equal(launchUrl('dsh web: http://127.0.0.1:12345/?token=private'),'http://127.0.0.1:12345/?token=private');
 assert.throws(()=>launchUrl('dsh web: http://example.org:12345/?token=private'));
 assert.throws(()=>launchUrl('dsh web: http://127.0.0.1:12345/evil?token=private'));
 assert.throws(()=>launchUrl('dsh web: http://127.0.0.1:12345/?token=x&redirect=evil'));
 assert.ok(!cleanDshLog('url http://127.0.0.1/?token=secret').includes('secret'));
});
test('Remote uses its authenticated cookie and exact request envelope, without repeating mutations',async()=>{
 const {fetcher,calls}=transport((method,request)=>({method,request}));const c=new DshRemote('http://127.0.0.1:12/?token=x',fetcher);
 const value=await c.rpc('session/prompt',{sessionId:'owned',requestId:'stable'});
 assert.equal(value.request.requestId,'stable');assert.equal(calls.length,2);assert.equal(calls[1].init.headers.Cookie,'dsh-auth=abc123');assert.equal(new URL(calls[1].url).search,'');
 const failing=(async(url:any,init:any)=>init?.body?new Response('lost',{status:500}):new Response(null,{status:303,headers:{location:'./','set-cookie':'dsh-auth=abc'}})) as typeof fetch;
 await assert.rejects(new DshRemote('http://127.0.0.1:12/?token=x',failing).rpc('session/prompt',{}),/HTTP 500/);
});
test('history paging retains source event sequence and rejects rewind or incomplete tails',async()=>{
 const {fetcher}=transport((method,req)=>method==='session/projections'?{asOfSeq:3,values:{}}:req.beforeSeq===undefined?{hasMore:true,records:[2,3].map(seq=>({type:'event',event:{seq,type:'user/message'}}))}:{hasMore:false,records:[0,1].map(seq=>({type:'event',event:{seq,type:'turn/start'}}))});
 const c=new DshRemote('http://127.0.0.1:12/?token=x',fetcher);assert.deepEqual((await c.snapshot('s')).events.map(e=>e.seq),[0,1,2,3]);await assert.rejects(c.snapshot('s',4),/不可核验/);
 const bad=transport(method=>method==='session/projections'?{asOfSeq:3,values:{}}:{hasMore:false,records:[{type:'event',event:{seq:2,type:'turn/start'}}]});
 await assert.rejects(new DshRemote('http://127.0.0.1:12/?token=x',bad.fetcher).snapshot('s'),/历史缺失/);
});
