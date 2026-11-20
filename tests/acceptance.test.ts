import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ArcService} from '../src/main/service';
import {capture,sha} from '../src/main/snapshot';
import {AcpConnection} from '../src/main/providers';
import {overviewDiscoveryBudget} from '../src/main/prompt-context';
import {annotationTarget} from '../src/ui/annotation';
test('actual frozen-source MCP rejects traversal, absolute paths, unknown methods and junctions',async t=>{
  const root=path.resolve('.test-data','mcp-adversarial-'+Date.now()),source=path.join(root,'source'),storage=path.join(root,'data');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
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
    const {tools}=await client.request('tools/list',{});
    assert.deepEqual(tools.map((tool:{name:string})=>tool.name),['arc_list_files','arc_search_source','arc_read_source']);
    const allowed=await client.request('tools/call',{name:'arc_read_source',arguments:{path:'a & $(echo owned).c'}});
    assert.match(JSON.stringify(allowed),/harmless/);
    const inventory=JSON.parse((await client.request('tools/call',{name:'arc_list_files',arguments:{offset:1,limit:1}})).content[0].text);
    assert.equal(inventory.offset,1);assert.equal(inventory.files[0].path,'jump/outside.txt');assert.equal(inventory.next_offset,null);
    const invalidPage=await client.request('tools/call',{name:'arc_list_files',arguments:{limit:101}});assert.equal(invalidPage.isError,true);
    for(const file of ['../outside.txt',path.join(root,'outside.txt'),'jump/outside.txt','javascript:alert(1)','file:///C:/Windows/win.ini']){
      const r=await client.request('tools/call',{name:'arc_read_source',arguments:{path:file}});
      assert.equal(r.isError,true,file);assert.ok(!JSON.stringify(r).includes('MCP_OUTSIDE_CANARY'));records.push({file,error:r});
      const search=await client.request('tools/call',{name:'arc_search_source',arguments:{query:'MCP_OUTSIDE_CANARY',path:file}});
      assert.equal(search.isError,true,file);assert.ok(!JSON.stringify(search).includes('MCP_OUTSIDE_CANARY'));
    }
    const linkedPrefix=await client.request('tools/call',{name:'arc_search_source',arguments:{query:'MCP_OUTSIDE_CANARY',path_prefix:'jump/'}});
    assert.equal(linkedPrefix.isError,true);assert.ok(!JSON.stringify(linkedPrefix).includes('MCP_OUTSIDE_CANARY'));
    const unknown=await client.request('tools/call',{name:'shell',arguments:{command:'echo forbidden'}});
    assert.equal(unknown.isError,true);
    assert.equal(await fs.readFile(path.join(source,'a & $(echo owned).c'),'utf8'),'int harmless = 42;\n');
    await fs.mkdir('evidence/remaining',{recursive:true});
    await fs.writeFile('evidence/remaining/mcp-adversarial.json',JSON.stringify({at:new Date().toISOString(),actual_mcp_process:true,records,unknown_tool:unknown,source_unchanged:true},null,2));
  }finally{child.stdin.end();await new Promise(r=>child.once('close',r));}
});
test('frozen-source search locates literal matches in large files with stable evidence',async t=>{
  const root=path.resolve('.test-data','mcp-search-'+Date.now()),source=path.join(root,'source'),storage=path.join(root,'data');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const tasks='kernel/tasks.c',queue='kernel/queue.c',example='examples/example.c';
  const definition='void vTaskSwitchContext(void) {';
  const call='  vTaskSwitchContext();';
  const longLine='  VTASKSWITCHCONTEXT();'+' '.repeat(320)+'// comment';
  const tasksText=[...Array(6100).fill('// unrelated'),definition,longLine].join('\r\n')+'\r\n';
  await fs.mkdir(path.join(source,'kernel'),{recursive:true});
  await fs.mkdir(path.join(source,'examples'),{recursive:true});
  await fs.writeFile(path.join(source,tasks),tasksText);
  await fs.writeFile(path.join(source,queue),call+'\n');
  await fs.writeFile(path.join(source,example),call+'\n');
  const snapshot=await capture(source,'search',storage,'');
  snapshot.files.push({path:'kernel/binary',content_sha256:'',bytes:0,line_count:0,encoding:'binary'});
  const context=path.join(root,'context.json');
  await fs.writeFile(context,JSON.stringify({storage,snapshot}));
  await fs.writeFile(path.join(source,tasks),'// changed live source');
  const child=spawn(process.execPath,['dist/context-server.cjs',context],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const client=new AcpConnection(child,()=>{});
  const invoke=(name:string,args:object)=>client.request('tools/call',{name,arguments:args});
  const search=async(args:object)=>{
    const result=await invoke('arc_search_source',args);
    assert.equal(result.isError,undefined,result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try{
    const query='vTaskSwitchContext(';
    const first={path:tasks,content_sha256:sha(tasksText),line:6101,text:definition};
    const second={...first,line:6102,text:longLine.slice(0,300)};
    assert.deepEqual(await search({query,path:tasks}),{
      source_snapshot_id:snapshot.source_snapshot_id,query,matches:[first,second],truncated:false,
    });
    assert.deepEqual((await search({query,path:tasks,case_sensitive:true})).matches,[first]);
    const limited=await search({query,path:tasks,limit:1});
    assert.deepEqual(limited.matches,[first]);assert.equal(limited.truncated,true);
    const exact=await search({query,path:tasks,limit:2});
    assert.equal(exact.truncated,false);
    const scoped=await search({query,path_prefix:'kernel/',limit:3});
    assert.deepEqual(scoped.matches,[{path:queue,content_sha256:sha(call+'\n'),line:1,text:call},first,second]);
    assert.equal(scoped.truncated,false);
    assert.equal((await search({query})).matches.length,4);
    for(const args of [{path:'../secret'},{path_prefix:'../secret'},{path_prefix:'C:/kernel'},{path_prefix:'kernel\\'},{path_prefix:'/kernel'},{limit:61}]){
      assert.equal((await invoke('arc_search_source',{query,...args})).isError,true,JSON.stringify(args));
    }
    const read=JSON.parse((await invoke('arc_read_source',{path:tasks,line_start:5702,line_count:400})).content[0].text);
    assert.equal(read.lines.length,400);
    assert.deepEqual(read.lines.at(-1),{line:first.line,text:first.text});
    assert.equal((await invoke('arc_read_source',{path:tasks,line_count:401})).isError,true);
  }finally{child.stdin.end();await new Promise(r=>child.once('close',r));}
});
test('first Codex overview bounds parallel discovery on a 2109-file manifest and reserves direct reads',async t=>{
  await fs.mkdir('.test-data',{recursive:true});
  const root=await fs.mkdtemp(path.resolve('.test-data','mcp-overview-')),source=path.join(root,'source'),storage=path.join(root,'data');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(source);
  await fs.writeFile(path.join(source,'main.c'),'int main(void) { return boot(); }\n'+'// other\n'.repeat(100));
  const snapshot=await capture(source,'overview',storage,'');
  const entry=snapshot.files[0];
  // Only the real entry should be opened. A broad search must reject this manifest before file I/O.
  snapshot.files.push(...Array.from({length:2108},(_,i)=>({...entry,path:`lib/module${i}.c`})));
  const context=path.join(root,'context.json');
  await fs.writeFile(context,JSON.stringify({storage,snapshot}));
  const child=spawn(process.execPath,['dist/context-server.cjs',context,'overview-discovery'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const client=new AcpConnection(child,()=>{});
  const invoke=(name:string,args:object)=>client.request('tools/call',{name,arguments:args});
  try{
    const broad=await invoke('arc_search_source',{query:'boot'});
    assert.equal(broad.isError,true);
    assert.match(broad.content[0].text,/2109.*path_prefix/);
    const search=await invoke('arc_search_source',{query:'boot',path:'main.c'});
    assert.equal(JSON.parse(search.content[0].text).matches[0].line,1);
    const listings=await Promise.all(Array.from({length:overviewDiscoveryBudget.calls},()=>invoke('arc_list_files',{query:'main.c'})));
    assert.equal(listings.filter(reply=>!reply.isError).length,overviewDiscoveryBudget.calls-4);
    assert.match(listings.at(-1).content[0].text,/只用于 arc_read_source/);
    const reads=await Promise.all(Array.from({length:3},()=>invoke('arc_read_source',{path:'main.c',line_count:400})));
    assert.deepEqual(reads.map(reply=>!!reply.isError),[false,false,true]);
    const last=JSON.parse(reads[1].content[0].text);
    assert.equal(last.lines[0].text,'int main(void) { return boot(); }');
    assert.equal(last.lines.length,overviewDiscoveryBudget.readLines);
    assert.equal(last.remaining_source_calls,0);
    assert.match(reads[2].content[0].text,/立即输出 overview-1 JSON/);
  }finally{child.stdin.end();await new Promise(r=>child.once('close',r));}
});
test('annotations cannot attach to objects outside original result; changed IDs never match names',async t=>{
  const root=path.resolve('.test-data','annotation-guard-'+Date.now()),service=new ArcService(root,path.resolve('.'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
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
