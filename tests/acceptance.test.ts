import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ArcService} from '../src/main/service';
import {capture,sha} from '../src/main/snapshot';
import {AcpConnection} from '../src/main/providers';
import {annotationTarget} from '../src/ui/annotation';
test('actual frozen-source MCP rejects traversal, absolute paths, unknown methods and junctions',async()=>{
  const root=path.resolve('.test-data','mcp-adversarial-'+Date.now()),source=path.join(root,'source'),storage=path.join(root,'data');
  await fs.mkdir(source,{recursive:true});await fs.writeFile(path.join(source,'a & $(echo owned).c'),'int harmless = 42;\n');
  await fs.writeFile(path.join(root,'outside.txt'),'MCP_OUTSIDE_CANARY');
  const snapshot=await capture(source,'adversarial',storage,'');
  const frozen=path.join(storage,'snapshots',snapshot.source_snapshot_id);
  await fs.symlink(root,path.join(frozen,'jump'),'junction');
  snapshot.files.push({path:'jump/outside.txt',content_sha256:sha('MCP_OUTSIDE_CANARY'),bytes:18,line_count:1,encoding:'utf-8'});
  const context=path.join(root,'context.json');await fs.writeFile(context,JSON.stringify({storage,snapshot}));
  const child=spawn(process.execPath,['dist/context-server.cjs',context],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const client=new AcpConnection(child,()=>{}),records:any[]=[];
  try{
    await client.request('initialize',{});
    const allowed=await client.request('tools/call',{name:'arc_read_source',arguments:{path:'a & $(echo owned).c'}});
    assert.match(JSON.stringify(allowed),/harmless/);
    const inventory=JSON.parse((await client.request('tools/call',{name:'arc_list_files',arguments:{offset:1,limit:1}})).content[0].text);
    assert.equal(inventory.offset,1);assert.equal(inventory.files[0].path,'jump/outside.txt');assert.equal(inventory.next_offset,null);
    const invalidPage=await client.request('tools/call',{name:'arc_list_files',arguments:{limit:101}});assert.equal(invalidPage.isError,true);
    for(const file of ['../outside.txt',path.join(root,'outside.txt'),'jump/outside.txt','javascript:alert(1)','file:///C:/Windows/win.ini']){
      const r=await client.request('tools/call',{name:'arc_read_source',arguments:{path:file}});
      assert.equal(r.isError,true,file);assert.ok(!JSON.stringify(r).includes('MCP_OUTSIDE_CANARY'));records.push({file,error:r});
    }
    const unknown=await client.request('tools/call',{name:'shell',arguments:{command:'echo forbidden'}});
    assert.equal(unknown.isError,true);
    assert.equal(await fs.readFile(path.join(source,'a & $(echo owned).c'),'utf8'),'int harmless = 42;\n');
    await fs.mkdir('evidence/remaining',{recursive:true});
    await fs.writeFile('evidence/remaining/mcp-adversarial.json',JSON.stringify({at:new Date().toISOString(),actual_mcp_process:true,records,unknown_tool:unknown,source_unchanged:true},null,2));
  }finally{child.stdin.end();await new Promise(r=>child.once('close',r));}
});
test('annotations cannot attach to objects outside original result; changed IDs never match names',async()=>{
  const root=path.resolve('.test-data','annotation-guard-'+Date.now()),service=new ArcService(root,path.resolve('.'));
  try{
    const p=await service.loadDemo(),data=service.data(),e=data.explanations[0],s=data.scenarios[0];
    assert.throws(()=>service.annotate(s.scenario_id,'invalid',e.result_id,'nonexistent'),/不属于/);
    const a=service.annotate(s.scenario_id,'kept',e.result_id,e.result.nodes[0].node_id);
    const changed:any=structuredClone(e.result);changed.result_id='new';changed.nodes[0].node_id='same-name-new-id';
    assert.match(annotationTarget(a,e.result,changed),/待重新定位/);
    const same:any=structuredClone(e.result);same.result_id='same-evidence';
    assert.match(annotationTarget(a,e.result,same),/可关联/);
    assert.equal(service.data().annotations[0].result_id,e.result_id);
    assert.equal(service.data().annotations[0].source_snapshot_id,p.snapshot_id);
  }finally{service.store.close();}
});
