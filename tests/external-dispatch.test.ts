import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Store} from '../src/main/store';
import {ExternalDispatch} from '../src/main/external-dispatch';

test('delivery stays pending until claim, duplicate enqueue is stable, restart never resends',async()=>{
  const directory=await fs.mkdtemp(path.resolve('.test-data/dispatch-'));
  const store=new Store(directory);let sends=0;
  const metadata=async()=>({thread:{id:'thread-1',cwd:directory,model:'session-model',reasoningEffort:'high'}});
  const command=async(_program:string,args:string[])=>{
    if(args[0]==='queue'&&args.includes('--message'))sends++;
    return {stdout:args[0]==='--version'?'codex-cli test':args[0]==='queue'?'--resume':'{}',stderr:''};
  };
  const dispatch=new ExternalDispatch(store,()=>{},metadata,command as any);
  try{
    const first=dispatch.enqueue('p',{run_id:'r'});
    assert.equal(dispatch.enqueue('p',{run_id:'r'}).dispatch_id,first.dispatch_id);
    assert.equal(store.get<any>('external_dispatch',first.dispatch_id).state,'queued');
    await dispatch.bind('p',directory,process.execPath,'thread-1');
    // bind starts the pump asynchronously, wait for its finite mocked protocol calls.
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(sends,1);
    assert.equal(store.get<any>('external_dispatch',first.dispatch_id).state,'awaiting_claim');
    const second=dispatch.enqueue('p',{run_id:'r2'});await dispatch.pump();assert.equal(sends,1);
    assert.equal(dispatch.claim(first.dispatch_id).state,'running');
    dispatch.close();
    const resumed=new ExternalDispatch(store,()=>{},metadata,command as any);
    await resumed.pump();assert.equal(sends,1);
    assert.equal(store.get<any>('external_dispatch',first.dispatch_id).state,'unknown');
    await assert.rejects(resumed.retry(first.dispatch_id),/不能重发/);
    assert.equal(store.get<any>('external_dispatch',second.dispatch_id).state,'queued');
    resumed.close();
  }finally{dispatch.close();store.close();await fs.rm(directory,{recursive:true});}
});

test('missing daemon saves a blocked unsent task and rejects a different workspace binding',async()=>{
  const directory=await fs.mkdtemp(path.resolve('.test-data/dispatch-'));
  const store=new Store(directory);
  const metadata=async()=>({thread:{id:'t',cwd:directory,model:null}});
  const command=async(_program:string,args:string[])=>{
    if(args[0]==='app-server')throw Error('daemon unavailable');
    return {stdout:args[0]==='--version'?'codex-cli test':'--resume',stderr:''};
  };
  const dispatch=new ExternalDispatch(store,()=>{},metadata,command as any);
  try{
    let authorized=0;
    const configure=async(program:string)=>{assert.equal(program,process.execPath);authorized++;};
    await assert.rejects(dispatch.bind('p',path.dirname(directory),process.execPath,'t',configure),/工作目录/);
    assert.equal(authorized,0);
    assert.equal(dispatch.binding('p'),null);
    await assert.rejects(dispatch.bind('p',directory,process.execPath,'t',async()=>{throw Error('注册失败');}),/注册失败/);
    assert.equal(dispatch.binding('p'),null);
    await dispatch.bind('p',directory,process.execPath,'t',configure);
    assert.equal(authorized,1);
    const item=dispatch.enqueue('p',{run_id:'r'});await new Promise(resolve=>setTimeout(resolve,20));
    const saved=store.get<any>('external_dispatch',item.dispatch_id);
    assert.equal(saved.state,'blocked');assert.equal(saved.sent_at,undefined);
    assert.match(saved.error,/daemon unavailable/);
  }finally{dispatch.close();store.close();await fs.rm(directory,{recursive:true});}
});

test('continuations remain distinct and revoked unknown work blocks the same session until acknowledged',async()=>{
  const directory=await fs.mkdtemp(path.resolve('.test-data/dispatch-')),store=new Store(directory);let sends=0;
  const metadata=async()=>({thread:{id:'t',cwd:directory}}),command=async(_p:string,args:string[])=>{if(args.includes('--message'))sends++;return {stdout:args[0]==='--version'?'codex-cli test':'--resume',stderr:''};};
  const queue=new ExternalDispatch(store,()=>{},metadata,command as any);
  try{
    await queue.bind('p',directory,process.execPath,'t');
    const first=queue.enqueue('p',{task_id:'task',submission_key:'first'});await new Promise(resolve=>setTimeout(resolve,20));queue.claim(first.dispatch_id);
    const next=queue.enqueue('p',{task_id:'task',submission_key:'continuation'});assert.notEqual(first.dispatch_id,next.dispatch_id);await queue.pump();assert.equal(sends,1);
    queue.cancel(first.dispatch_id);assert.throws(()=>queue.claim(first.dispatch_id),/撤销/);
    store.put('engineering_task','task',{status:'cancelled'});await queue.pump();assert.equal(store.get<any>('external_dispatch',first.dispatch_id).state,'unknown');assert.equal(sends,1);
    queue.acknowledgeStop(first.dispatch_id);await queue.pump();assert.equal(sends,2);assert.equal(store.get<any>('external_dispatch',next.dispatch_id).state,'awaiting_claim');
  }finally{queue.close();store.close();await fs.rm(directory,{recursive:true});}
});

test('terminal reconciliation requires the exact dispatch and an ended session; continuation uses its own attempt',async()=>{
  const directory=await fs.mkdtemp(path.resolve('.test-data/dispatch-')),store=new Store(directory);let turns:any[]=[];
  const metadata=async()=>({thread:{id:'t',cwd:directory,turns}}),command=async(_p:string,args:string[])=>({stdout:args[0]==='--version'?'codex-cli test':'--resume',stderr:''});
  const queue=new ExternalDispatch(store,()=>{},metadata,command as any);
  try{
    await queue.bind('p',directory,process.execPath,'t');
    store.put('engineering_task','task',{status:'completed'});
    const item=queue.enqueue('p',{task_id:'task',submission_key:'next',request:'new request',scope:['a.c']});await new Promise(resolve=>setTimeout(resolve,20));queue.claim(item.dispatch_id);queue.started(item.dispatch_id,'attempt');
    store.put('development_attempt','attempt',{status:'running'});await queue.pump();assert.equal(store.get<any>('external_dispatch',item.dispatch_id).state,'running');
    queue.cancel(item.dispatch_id);await assert.rejects(queue.verifyStopped(item.dispatch_id),/未找到/);
    turns=[{status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:'ARC 派发 '+item.dispatch_id+'。'}]}]}];await assert.rejects(queue.verifyStopped(item.dispatch_id),/仍在执行/);
    turns[0].status='completed';assert.equal((await queue.verifyStopped(item.dispatch_id)).state,'cancelled');assert.throws(()=>queue.claim(item.dispatch_id),/撤销/);
  }finally{queue.close();store.close();await fs.rm(directory,{recursive:true});}
});

test('external analysis budget preserves unknown stop state and never releases another queued task',async()=>{
  const directory=await fs.mkdtemp(path.resolve('.test-data/dispatch-')),store=new Store(directory);
  const queue=new ExternalDispatch(store,()=>{});
  try{
    const item=queue.enqueue('p',{run_id:'r'});store.put('run','r',{binding:{run_id:'r'},status:'running'});
    store.put('external_dispatch',item.dispatch_id,{...item,state:'running',thread_id:'t',claimed_at:new Date(Date.now()-301000).toISOString()});
    await queue.pump();assert.equal(store.get<any>('run','r').status,'blocked_external');assert.equal(store.get<any>('external_dispatch',item.dispatch_id).state,'unknown');assert.throws(()=>queue.claim(item.dispatch_id),/撤销/);
    await queue.pump();assert.equal(store.get<any>('external_dispatch',item.dispatch_id).state,'unknown');await assert.rejects(queue.retry(item.dispatch_id),/不能重发/);
  }finally{queue.close();store.close();await fs.rm(directory,{recursive:true});}
});

test('revoked authority holds queued dispatches and is checked after the daemon probe',async()=>{
  const directory=await fs.mkdtemp(path.resolve('.test-data/dispatch-'));
  const store=new Store(directory);
  let allowed=false,revokeAtProbe=true,sends=0;
  const metadata=async()=>({thread:{id:'t',cwd:directory}});
  const command=async(_program:string,args:string[])=>{
    if(args[0]==='app-server'&&revokeAtProbe)allowed=false;
    if(args.includes('--message'))sends++;
    return {stdout:args[0]==='--version'?'codex-cli test':'--resume',stderr:''};
  };
  const dispatch=new ExternalDispatch(store,()=>{},metadata,command as any,()=>allowed);
  try{
    await dispatch.bind('p',directory,process.execPath,'t');
    const item=dispatch.enqueue('p',{run_id:'r'});
    assert.match(store.get<any>('external_dispatch',item.dispatch_id).error,/重新授权/);
    allowed=true;
    await dispatch.pump();
    assert.equal(sends,0);
    assert.equal(store.get<any>('external_dispatch',item.dispatch_id).state,'queued');
    allowed=true;revokeAtProbe=false;
    await dispatch.pump();
    assert.equal(sends,1);
    assert.equal(store.get<any>('external_dispatch',item.dispatch_id).state,'awaiting_claim');
  }finally{dispatch.close();store.close();await fs.rm(directory,{recursive:true});}
});
