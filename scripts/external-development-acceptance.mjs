import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {ArcService} from '../src/main/service.ts';
import {ArcMcpBridge} from '../src/main/mcp-bridge.ts';
import {installArcAgentRules} from '../src/main/aec-migration.ts';
import {codexChildEnvironment,JsonLines,locate,redact,stopTree} from '../src/main/providers.ts';
import {probeDevelopmentSandbox} from '../src/main/development-runner.ts';

// Genuine Codex acceptance. Run after the ARC UI fixture has passed npm test.
async function main(){
  const exec=promisify(execFile),root=path.resolve('.');
  const scratch=path.resolve('../.test-data/engineering-integration'),workspace=path.join(scratch,'workspace');
  const run=await fs.mkdtemp(path.join(scratch,'external-development-'));
  const program=await locate('codex',process.env.ARC_ACCEPTANCE_CODEX);
  const env=codexChildEnvironment(process.env);
  const goal='修复订单收据导出标签 Totoal 的拼写，改为 Total。保留已有其他改动，运行 npm test 验证。';
  const source=path.join(workspace,'src/receipt.mjs'),userNote=path.join(workspace,'notes.txt');
  const original=await fs.readFile(source,'utf8'),notes=await fs.readFile(userNote,'utf8');
  assert.match(original,/Totoal/,'Use a fixture that still has the original receipt fault');
  let service,bridge,installed,originalRules,phases=[];
  const rules=path.join(workspace,'AGENTS.md');
  try{
    if(process.platform==='win32'){
      const probe=await probeDevelopmentSandbox(program,workspace,env);
      phases.push({stage:'sandbox_check',supported:probe.supported});
    }
    await exec(process.execPath,['--test','tests/order.test.mjs'],{cwd:workspace,env,windowsHide:true});
    service=new ArcService(path.join(run,'data'),root);
    bridge=new ArcMcpBridge(service,root);
    const project=await service.openProject(workspace);
    await bridge.start();await bridge.enable(project.project_id);
    originalRules=await fs.readFile(rules,'utf8');
    await installArcAgentRules(workspace,{connectionFile:bridge.connectionFile});
    installed=await fs.readFile(rules,'utf8');
    const args=['-a','on-request','exec','--json','--sandbox','workspace-write','--color','never','--cd',workspace,
      '-c',`mcp_servers.arc.command=${JSON.stringify(process.execPath)}`,
      '-c',`mcp_servers.arc.args=${JSON.stringify([path.join(root,'dist/arc-mcp.cjs'),bridge.connectionFile])}`,
      '-c','mcp_servers.arc.enabled=true','-'];
    const inventory=JSON.parse((await exec(program,['mcp','list','--json'],{env,windowsHide:true,timeout:10000})).stdout);
    for(const item of inventory.filter(entry=>entry.name!=='arc')){
      if(!/^[\w-]+$/.test(item.name))throw Error('Unsupported MCP registration name');
      args.splice(-1,0,'-c',`mcp_servers.${item.name}.enabled=false`);
    }
    const result=await new Promise((resolve,reject)=>{
      const cli=spawn(program,args,{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let stderr='',failure;
      const frames=new JsonLines(frame=>{
        if(frame.type==='thread.started'||frame.item?.type==='mcp_tool_call'||frame.item?.type==='command_execution'||frame.type==='turn.failed')
          phases.push(JSON.parse(redact(JSON.stringify(frame))));
      },16*1024*1024);
      const timer=setTimeout(()=>{failure=Error('Real external development timed out');void stopTree(cli).catch(reject);},180000);
      cli.stdout.on('data',chunk=>{try{frames.feed(chunk);}catch(error){failure=error;void stopTree(cli).catch(reject);}});
      cli.stderr.on('data',chunk=>{stderr=redact((stderr+chunk.toString('utf8')).slice(-12000));});
      cli.once('error',error=>{clearTimeout(timer);reject(error);});
      cli.once('close',code=>{clearTimeout(timer);try{frames.end();}catch(error){failure??=error;}if(failure)reject(failure);else resolve({code,stderr});});
      cli.stdin.on('error',()=>{});cli.stdin.end(goal);
    });
    const task=service.engineering.tasks({project_id:project.project_id})[0];
    phases.push({stage:'saved_task',result,task});
    const mcpCalls=phases.filter(frame=>frame.type==='item.completed'&&frame.item?.type==='mcp_tool_call'&&frame.item.status==='completed').map(frame=>frame.item.tool);
    for(const name of ['arc_engineering_context','arc_begin_development','arc_finish_development'])assert.ok(mcpCalls.includes(name),`New session did not call ${name}`);
    assert.equal(result.code,0,result.stderr);
    assert.equal(task?.status,'completed',JSON.stringify(task?.unresolved));
    assert.equal(task.workspace_path,workspace);
    assert.equal(task.changes_status,undefined);
    assert.ok(task.changes.some(change=>change.path==='src/receipt.mjs'));
    assert.ok(!task.changes.some(change=>change.path==='notes.txt'));
    assert.ok(task.verification.some(evidence=>evidence.origin==='self_reported'&&/npm(?:\.cmd)? test/.test(evidence.command)&&evidence.exit_code===0));
    assert.ok(phases.some(frame=>frame.type==='item.completed'&&frame.item?.type==='command_execution'&&/npm(?:\.cmd)? test/.test(frame.item.command)&&frame.item.exit_code===0));
    assert.equal(await fs.readFile(source,'utf8'),original.replace('Totoal','Total'));
    assert.equal(await fs.readFile(userNote,'utf8'),notes);
    await exec(process.execPath,['--test','tests/order.test.mjs'],{cwd:workspace,env,windowsHide:true});
    console.log(JSON.stringify({externalEntryPassed:true,taskId:task.task_id,evidence:run}));
  }catch(error){
    phases.push({stage:'acceptance_failed',error:redact(String(error)),environmentBlocked:error.environmentBlocked===true});
    throw error;
  }finally{
    await fs.writeFile(path.join(run,'acceptance.json'),JSON.stringify(phases,null,2));
    if(installed&&await fs.readFile(rules,'utf8')===installed)await fs.writeFile(rules,originalRules);
    await bridge?.close();await service?.shutdown();service?.store.close();
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
