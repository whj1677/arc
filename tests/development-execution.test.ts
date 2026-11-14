import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {developmentArguments,developmentPrompt,developmentSandboxArguments,developmentSandboxError,supportsDevelopmentSandboxProbe} from '../src/main/development-runner';
import {callArcWithOutbox,pendingDevelopmentWrites,flushDevelopmentWrites,queueDevelopmentWrite} from '../src/main/development-outbox';
import {ArcService} from '../src/main/service';
import {ArcMcpBridge,bridgeTools} from '../src/main/mcp-bridge';

async function temporary(){const root=path.resolve('.test-data');await fs.mkdir(root,{recursive:true});return fs.mkdtemp(path.join(root,'development-execution-'));}
test('development uses actual workspace, host model, bounded write sandbox and requested approvals',()=>{
  const args=developmentArguments('C:\\工程 workspace','schema.json','result.json');
  assert.equal(args[args.indexOf('--cd')+1],'C:\\工程 workspace');assert.equal(args[args.indexOf('--sandbox')+1],'workspace-write');
  assert.deepEqual(args.slice(0,3),['-a','on-request','exec']);assert.ok(!args.includes('-m'));assert.ok(!args.join(' ').includes('danger'));
  assert.match(developmentPrompt({task_id:'task-a',workspace_path:'real-workspace',goal:'fix typo'} as any,{} as any),/task-a/);
});
test('Windows sandbox preflight preserves managed permissions and reports identity failures before model dispatch',()=>{
  const args=developmentSandboxArguments('C:\\工作 区');
  assert.ok(args.includes('--include-managed-config'));assert.equal(args[args.indexOf('--permission-profile')+1],':workspace');assert.equal(args[args.indexOf('--cd')+1],'C:\\工作 区');assert.ok(!args.join(' ').includes('danger'));
  const error=developmentSandboxError({stderr:'registered Core process has no package identity'});assert.equal(error.environmentBlocked,true);assert.match(error.message,/尚未调用模型/);assert.match(error.message,/不会移除身份检查/);
  assert.match(developmentSandboxError({killed:true,message:'Command failed'}).message,/预检超时/);
  assert.equal(supportsDevelopmentSandboxProbe('--include-managed-config --permission-profile --cd'),true);assert.equal(supportsDevelopmentSandboxProbe('Usage: codex sandbox windows'),false);
});
test('offline completion persists across clients, retries idempotently, and never reports sync success',async()=>{
  const directory=await temporary(),file=path.join(directory,'connection.json');
  const request={name:'arc_finish_development',args:{task_id:'t',expected_version:1,submission_key:'finish-1',status:'completed',summary:'done'},client:{configured_provider:'codex'}};
  let server:http.Server|undefined;
  try{
    await fs.writeFile(file,JSON.stringify({url:'http://127.0.0.1:1/tool',token:'test-only'}));
    const result=await callArcWithOutbox(file,request);assert.equal(result.saved,'pending_sync');
    assert.equal((await pendingDevelopmentWrites(file)).length,1);
    await callArcWithOutbox(file,request);assert.equal((await pendingDevelopmentWrites(file)).length,1);
    await assert.rejects(queueDevelopmentWrite(file,{...request,args:{...request.args,summary:'conflicting'}}),/不同待同步内容/);
    const accepted=new Set<string>();let requests=0;
    server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const entry=JSON.parse(body);requests++;accepted.add(entry.args.submission_key);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:{saved:'saved'}}));});
    await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
    await fs.writeFile(file,JSON.stringify({url:`http://127.0.0.1:${(server.address() as any).port}/tool`,token:'test-only'}));
    const {sendArcTool}=await import('../src/main/development-outbox');
    const flushed=await flushDevelopmentWrites(file,value=>sendArcTool(file,value));assert.equal(flushed[0].saved,'saved');assert.equal((await pendingDevelopmentWrites(file)).length,0);assert.equal(requests,1);assert.equal(accepted.size,1);
  }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
});
test('server validation failure remains inspectable and is not relabelled as offline success',async()=>{
  const directory=await temporary(),file=path.join(directory,'connection.json');
  const server=http.createServer((_req,res)=>{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'VERSION_CONFLICT'}));});
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));await fs.writeFile(file,JSON.stringify({url:`http://127.0.0.1:${(server.address() as any).port}/tool`,token:'test'}));
    await assert.rejects(callArcWithOutbox(file,{name:'arc_finish_development',args:{task_id:'t',expected_version:1,submission_key:'key'},client:{}}),/VERSION_CONFLICT/);
    assert.equal((await pendingDevelopmentWrites(file)).length,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
});
test('external development scopes real workspace, preserves reading path and records self-reported verification',async()=>{
  const directory=await temporary(),source=path.join(directory,'工作 区');await fs.mkdir(source);await fs.writeFile(path.join(source,'main.ts'),'export const value=1;\n');
  const service=new ArcService(path.join(directory,'data'),path.resolve('.')),project=await service.openProject(source),bridge=new ArcMcpBridge(service,path.resolve('.'));
  try{
    await bridge.start();await bridge.enable(project.project_id);
    const context=await bridge.call('arc_engineering_context',{workspace_path:source});assert.equal(context.project_id,project.project_id);
    await assert.rejects(bridge.call('arc_engineering_context',{workspace_path:directory}),/绑定|归属/);
    const task=await bridge.call('arc_begin_development',{workspace_path:source,goal:'change value',submission_key:'begin'});
    assert.equal((await bridge.call('arc_begin_development',{workspace_path:source,goal:'change value',submission_key:'begin'})).task_id,task.task_id);
    const second=path.join(directory,'second');await fs.mkdir(second);await fs.writeFile(path.join(second,'b.ts'),'export const b=1;');
    const secondProject=await service.openProject(second);
    await assert.rejects(bridge.call('arc_engineering_context',{workspace_path:second}),/授权/);
    await bridge.enable(secondProject.project_id);
    assert.equal((await bridge.call('arc_engineering_context',{workspace_path:source})).project_id,project.project_id,'changing the selected project cannot rebind a connected session');
    await fs.writeFile(path.join(source,'main.ts'),'export const value=2;\n');
    const after=await bridge.call('arc_engineering_context',{workspace_path:source});
    const finish={task_id:task.task_id,expected_version:task.version,submission_key:'finish',status:'completed',summary:'Changed value',verification:[{evidence_id:'check',command:'node check.mjs',cwd:source,outcome:'passed',exit_code:0,origin:'observed',code_state:after.code_state,created_at:new Date().toISOString()}]};
    const saved=await bridge.call('arc_finish_development',finish);
    assert.equal(saved.changes[0].path,'main.ts');assert.equal(saved.verification[0].origin,'self_reported');assert.equal(saved.verification_status,'partial');
    assert.deepEqual(await bridge.call('arc_finish_development',finish),saved);
    const repeated=await bridge.call('arc_begin_development',{workspace_path:source,goal:'change value',submission_key:'begin'});assert.equal(repeated.status,'completed');assert.equal(repeated.attempt_ids.length,1,'retrying a previously completed begin cannot dispatch a new attempt');
    assert.ok(bridgeTools.some(t=>t.name==='arc_read_source'));assert.ok(bridgeTools.some(t=>t.name==='arc_begin_analysis'));
  }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(directory,{recursive:true,force:true});}
});
test('an external task keeps its version across ARC restart and queued completion is saved automatically',async()=>{
  const directory=await temporary(),source=path.join(directory,'source'),data=path.join(directory,'data');await fs.mkdir(source);await fs.writeFile(path.join(source,'main.ts'),'export const value=1;\n');
  let service=new ArcService(data,path.resolve('.')),bridge=new ArcMcpBridge(service,path.resolve('.'));
  try{
    const project=await service.openProject(source);await bridge.start();await bridge.enable(project.project_id);
    const task=await bridge.call('arc_begin_development',{workspace_path:source,goal:'external change while ARC is closed',submission_key:'begin'}),connectionFile=bridge.connectionFile;
    await bridge.close();await service.shutdown();service.store.close();
    await fs.writeFile(path.join(source,'main.ts'),'export const value=2;\n');
    const queued=await callArcWithOutbox(connectionFile,{name:'arc_finish_development',args:{task_id:task.task_id,expected_version:task.version,submission_key:'offline-finish',status:'completed',summary:'外部会话完成；验证未执行',verification:[]},client:{configured_provider:'codex'}});
    assert.equal(queued.saved,'pending_sync');
    service=new ArcService(data,path.resolve('.'));bridge=new ArcMcpBridge(service,path.resolve('.'));await bridge.start();
    const saved=service.engineering.task(task.task_id);assert.equal(saved.status,'completed');assert.equal(saved.changes[0].path,'main.ts');assert.equal(saved.verification_status,'not_run');assert.equal((await bridge.pendingWrites()).length,0);
  }finally{await bridge.close();await service.shutdown();service.store.close();await fs.rm(directory,{recursive:true,force:true});}
});
