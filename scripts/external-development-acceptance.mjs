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

// Run after the ARC UI fixture has passed. Each invocation starts a fresh Codex session.
async function main(){
  const exec=promisify(execFile),root=path.resolve('.');
  const scratch=path.resolve(process.env.ARC_ACCEPTANCE_DIR||'../.test-data/engineering-integration'),workspace=path.join(scratch,'workspace');
  const run=await fs.mkdtemp(path.join(scratch,'external-development-'));
  const program=await locate('codex',process.env.ARC_ACCEPTANCE_CODEX);
  const env=codexChildEnvironment(process.env);
  const goal='修复订单收据导出标签 Totoal 的拼写，改为 Total。保留已有其他改动，运行 npm test 验证。';
  const assertion="node --input-type=module -e \"import assert from 'node:assert/strict'; import { receiptLabel } from './src/receipt.mjs'; assert.equal(receiptLabel, 'Total')\"";
  const source=path.join(workspace,'src/receipt.mjs'),userNote=path.join(workspace,'notes.txt');
  const original=await fs.readFile(source,'utf8'),notes=await fs.readFile(userNote,'utf8');
  assert.match(original,/Totoal/,'Use a fixture that still has the original receipt fault');
  let service,bridge,installed,originalRules,passed=false;
  const phases=[];
  const rules=path.join(workspace,'AGENTS.md');
  async function close(){
    await bridge?.close();bridge=undefined;
    await service?.shutdown();service?.store.close();service=undefined;
  }
  async function connect(project){
    bridge=new ArcMcpBridge(service,root);
    await bridge.start();await bridge.enable(project.project_id);
    await installArcAgentRules(workspace,{connectionFile:bridge.connectionFile});
    installed=await fs.readFile(rules,'utf8');
  }
  try{
    if(process.platform==='win32'){
      const probe=await probeDevelopmentSandbox(program,workspace,env);
      phases.push({stage:'sandbox_check',supported:probe.supported});
    }
    await exec(process.execPath,['--test','tests/order.test.mjs'],{cwd:workspace,env,windowsHide:true});
    service=new ArcService(path.join(scratch,'data'),root);
    const project=service.data().projects.find(item=>item.root_path===workspace);
    assert.ok(project,'Run ARC desktop acceptance first');
    const arcTask=service.engineering.tasks({project_id:project.project_id}).find(item=>item.status==='completed'&&item.verification_status==='passed'&&item.changes.some(change=>change.path==='src/cart.mjs'));
    assert.ok(arcTask,'ARC desktop must save the verified cart edit before external acceptance');
    originalRules=await fs.readFile(rules,'utf8');
    await connect(project);
    const existingTaskIds=new Set(service.engineering.tasks({project_id:project.project_id}).map(task=>task.task_id));
    const inventory=JSON.parse((await exec(program,['mcp','list','--json'],{env,windowsHide:true,timeout:10000})).stdout);
    async function session(prompt){
      const args=['-a','on-request','exec','--json','--sandbox','workspace-write','--color','never','--cd',workspace,
        '-c',`mcp_servers.arc.command=${JSON.stringify(process.execPath)}`,
        '-c',`mcp_servers.arc.args=${JSON.stringify([path.join(root,'dist/arc-mcp.cjs'),bridge.connectionFile])}`,
        '-c','mcp_servers.arc.enabled=true'];
      for(const item of inventory.filter(entry=>entry.name!=='arc'&&entry.enabled)){
        if(!/^[\w-]+$/.test(item.name))throw Error('Unsupported MCP registration name');
        const transport=item.transport;
        const endpoint=transport.type==='stdio'?['command',transport.command]:['url',transport.url];
        assert.equal(typeof endpoint[1],'string',`Unsupported MCP transport for ${item.name}`);
        // Codex validates an overridden server table before merging user settings.
        args.push('-c',`mcp_servers.${item.name}={${endpoint[0]}=${JSON.stringify(endpoint[1])},enabled=false}`);
      }
      args.push('-');
      const events=[];
      const result=await new Promise((resolve,reject)=>{
        const cli=spawn(program,args,{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let stderr='',failure;
        const frames=new JsonLines(frame=>{
          if(frame.type==='thread.started'||frame.item?.type==='mcp_tool_call'||frame.item?.type==='command_execution'||frame.type==='turn.failed')
            events.push(JSON.parse(redact(JSON.stringify(frame))));
        },16*1024*1024);
        const timer=setTimeout(()=>{failure=Error('Real external development timed out');void stopTree(cli).catch(reject);},180000);
        cli.stdout.on('data',chunk=>{try{frames.feed(chunk);}catch(error){failure=error;void stopTree(cli).catch(reject);}});
        cli.stderr.on('data',chunk=>{stderr=redact((stderr+chunk.toString('utf8')).slice(-12000));});
        cli.once('error',error=>{clearTimeout(timer);reject(error);});
        cli.once('close',code=>{clearTimeout(timer);try{frames.end();}catch(error){failure??=error;}if(failure)reject(failure);else resolve({code,stderr});});
        cli.stdin.on('error',()=>{});cli.stdin.end(prompt);
      });
      phases.push({stage:'session',result,events});
      assert.equal(result.code,0,result.stderr);
      const mcpCalls=events.filter(frame=>frame.type==='item.completed'&&frame.item?.type==='mcp_tool_call'&&frame.item.status==='completed'&&!frame.item.result?.isError).map(frame=>frame.item.tool);
      for(const name of ['arc_engineering_context','arc_begin_development','arc_finish_development'])assert.ok(mcpCalls.includes(name),`New session did not call ${name}`);
      return {id:events.find(frame=>frame.type==='thread.started')?.thread_id,commands:events.filter(frame=>frame.type==='item.completed'&&frame.item?.type==='command_execution').map(frame=>frame.item)};
    }
    console.log('Starting a new Codex session to reproduce the receipt test failure.');
    const failed=await session(`${goal}\n这是新的复现任务。先用 ${assertion} 验证准确标签。记录真实退出码和失败，本会话不编辑任何文件，等待我在新会话要求修复。工程记录遵循 AGENTS.md。`);
    assert.ok(failed.commands.some(item=>item.exit_code===1&&item.command.includes('receiptLabel')&&item.aggregated_output.includes('ERR_ASSERTION')));
    const prior=service.engineering.tasks({project_id:project.project_id}).find(item=>!existingTaskIds.has(item.task_id)&&item.status==='failed');
    assert.ok(prior,'The new session must save a failed development task');
    phases.push({stage:'failed_task',task:prior});
    assert.equal(prior.verification_status,'failed');
    assert.deepEqual(prior.changes,[]);
    assert.equal(await fs.readFile(source,'utf8'),original);
    const bundle=path.join(run,'engineering.json');
    await service.engineering.exportProject(project.project_id,bundle);
    await close();
    service=new ArcService(path.join(run,'restored'),root);
    assert.equal(service.data().projects.length,0);
    const restored=await service.engineering.restoreProject(bundle);
    assert.equal(restored.status,'unbound');
    await service.engineering.rebindWorkspace(project.project_id,workspace);
    await connect(project);
    assert.equal(service.engineering.task(prior.task_id).verification_status,'failed');
    console.log('Starting a fresh Codex session to fix the receipt in the restored workspace.');
    const fixed=await session(`继续 ARC 里已记录的收据标签失败任务 ${prior.task_id}。先读该任务、实际工作区及共享上下文，接续同一任务，然后完成真实修复。运行 npm test 和 ${assertion}，按 AGENTS.md 保存实际结果。`);
    assert.ok(failed.id&&fixed.id&&failed.id!==fixed.id);
    const task=service.engineering.task(prior.task_id);
    phases.push({stage:'saved_task',task});
    assert.equal(task?.status,'completed',JSON.stringify(task?.unresolved));
    assert.equal(task.workspace_path,workspace);
    assert.equal(task.changes_status,undefined);
    assert.equal(task.attempt_ids.length,prior.attempt_ids.length+1);
    assert.ok(service.engineering.history('task',task.task_id).some(version=>version.verification_status==='failed'));
    assert.deepEqual(task.changes.map(change=>[change.path,change.ownership]),[['src/receipt.mjs','task_change']]);
    assert.ok(task.verification.some(evidence=>evidence.origin==='self_reported'&&/npm(?:\.cmd)? test/.test(evidence.command)&&evidence.exit_code===0));
    assert.ok(fixed.commands.some(item=>/npm(?:\.cmd)? test/.test(item.command)&&item.exit_code===0));
    assert.ok(fixed.commands.some(item=>item.command.includes('receiptLabel')&&item.exit_code===0));
    assert.equal(await fs.readFile(source,'utf8'),original.replace('Totoal','Total'));
    assert.equal(await fs.readFile(userNote,'utf8'),notes);
    await exec(process.execPath,['--test','tests/order.test.mjs'],{cwd:workspace,env,windowsHide:true});
    passed=true;
    console.log(JSON.stringify({externalEntryPassed:true,restoredContinuationPassed:true,taskId:task.task_id,evidence:run}));
  }catch(error){
    phases.push({stage:'acceptance_failed',error:redact(String(error)),environmentBlocked:error.environmentBlocked===true});
    throw error;
  }finally{
    try{
      await fs.writeFile(path.join(run,'acceptance.json'),JSON.stringify(phases,null,2));
      if(!passed&&installed&&await fs.readFile(rules,'utf8')===installed)await fs.writeFile(rules,originalRules);
    }finally{await close();}
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
