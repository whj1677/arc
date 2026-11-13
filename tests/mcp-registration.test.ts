import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ArcService} from '../src/main/service';
import {ArcMcpBridge} from '../src/main/mcp-bridge';
import {ownedArcRegistration,adoptConnection} from '../src/main/mcp-registration';

test('registration recognizes releases from the same installation, rejects unrelated servers and host overrides',()=>{
 const root=path.resolve('test-install'),resources=path.join(root,'release/new/resources/app');
 const old={transport:{type:'stdio',command:process.execPath,args:[path.join(root,'release/old/resources/app/dist/arc-mcp.cjs'),path.join(os.tmpdir(),'old-arc/mcp/connection.json')]}};
 assert.equal(ownedArcRegistration(old,resources),true);
 assert.equal(ownedArcRegistration(old,root),true);
 assert.equal(ownedArcRegistration({...old,transport:{...old.transport,args:[path.resolve('another-install/release/old/resources/app/dist/arc-mcp.cjs'),old.transport.args[1]]}},resources),false);
 assert.equal(ownedArcRegistration({...old,transport:{...old.transport,env:{ARC_MCP_HOST:'dsh'}}},resources),false);
 assert.equal(ownedArcRegistration({...old,transport:{...old.transport,command:'unrelated.exe'}},resources),false);
});

test('explicit retired-file repair reaches the chosen task through an already-running proxy, survives restart, and respects revoke',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-rebind-')),source=path.join(dir,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'a.ts'),'export const a=1;');
 const service=new ArcService(path.join(dir,'current'),path.resolve('.')),project=await service.openProject(source),scene=service.addFeature(project.project_id,'评审需求文档').scenario;
 service.prepareAnalysis(scene.scenario_id);
 let bridge=new ArcMcpBridge(service,path.resolve('.'));await bridge.start();await bridge.enable(project.project_id);
 const old=path.join(dir,'retired/mcp/connection.json');await fs.mkdir(path.dirname(old),{recursive:true});await fs.copyFile(bridge.connectionFile,old);
 const child=spawn(process.execPath,['dist/arc-mcp.cjs',old],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let buffer='',sequence=0;const pending=new Map<number,(v:any)=>void>();child.stdout!.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const x=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(x.id)?.(x.result);pending.delete(x.id);}});
 const rpc=()=>new Promise<any>((resolve,reject)=>{const id=++sequence,t=setTimeout(()=>reject(Error('RPC timeout')),5000);pending.set(id,x=>{clearTimeout(t);resolve(x);});child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'arc_current_project',arguments:{}}})+'\n');});
 try{
  assert.equal(JSON.parse((await rpc()).content[0].text).requested_analysis.scenario_id,scene.scenario_id);
  await bridge.close();assert.equal((await rpc()).isError,true);
  bridge=new ArcMcpBridge(service,path.resolve('.'));await bridge.start();
  const connection=JSON.parse(await fs.readFile(bridge.connectionFile,'utf8'));
  assert.equal(await adoptConnection(old,bridge.connectionFile,connection),true);service.store.put('setting','mcp-connection-aliases',[old]);
  assert.equal(JSON.parse((await rpc()).content[0].text).requested_analysis.title,'评审需求文档 · 整体走读');
  await bridge.close();bridge=new ArcMcpBridge(service,path.resolve('.'));await bridge.start();
  assert.equal(JSON.parse((await rpc()).content[0].text).project.project_id,project.project_id);
  bridge.disable();assert.match((await rpc()).content[0].text,/授权/);
  await fs.writeFile(old,JSON.stringify(connection));assert.equal(await adoptConnection(old,bridge.connectionFile,connection,true),false,'restart cannot seize a file whose ownership changed');
 }finally{child.kill();await bridge.close();await service.shutdown();service.store.close();}
});

test('a live other Arc connection cannot be replaced, even when its project access is disabled',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arc-live-'));
 const service=new ArcService(path.join(dir,'old'),path.resolve('.')),bridge=new ArcMcpBridge(service,path.resolve('.'));await bridge.start();
 try{const original=await fs.readFile(bridge.connectionFile,'utf8');await assert.rejects(adoptConnection(bridge.connectionFile,path.join(dir,'new/mcp/connection.json'),{url:'http://127.0.0.1:1/tool',token:'new'}),/另一 Arc/);assert.equal(await fs.readFile(bridge.connectionFile,'utf8'),original);}
 finally{await bridge.close();service.store.close();}
});
