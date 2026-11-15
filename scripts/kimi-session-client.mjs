// Kimi session adapter for real ARC acceptance. With ARC_MCP_CONNECTION it uses
// the authenticated ARC MCP transport; otherwise it reuses the same local service.
// The Agent must read source and execute work; this adapter never creates content.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ArcService} from '../src/main/service.ts';
import {ArcMcpBridge} from '../src/main/mcp-bridge.ts';
import {callArcWithOutbox} from '../src/main/development-outbox.ts';

const [command,dataDirectory,...args]=process.argv.slice(2),root=path.resolve('.'),connection=process.env.ARC_MCP_CONNECTION;
if(!command||!dataDirectory)throw Error('Usage: kimi-session-client <command> <ARC data directory> ...');
const service=connection?undefined:new ArcService(path.resolve(dataDirectory),root),bridge=service?new ArcMcpBridge(service,root):undefined,client={name:'Kimi Work',configured_provider:'kimi'};
const print=value=>console.log(JSON.stringify(value,null,2));
const call=(name,callArgs)=>connection?callArcWithOutbox(connection,{name,args:callArgs,client}):bridge.call(name,callArgs,client);
const readTask=taskId=>call('arc_development_task',{task_id:taskId});
async function resumeWaitingRun(runId){if(!service)return;const run=service.store.get('run',runId);if(run.origin!=='mcp'||run.status!=='waiting_agent')throw Error('Only this adapter’s waiting MCP analysis can be resumed');run.status='running';run.mcp_connection_id=bridge.connectionId;service.store.put('run',runId,run);}
try{
  if(command==='setup'){
    if(!service)throw Error('Setup runs before the MCP host starts');const [workspace,name,question]=args,project=await service.openProject(path.resolve(workspace));let scenario=service.data().scenarios.find(item=>item.project_id===project.project_id&&item.title===question);
    if(!scenario)scenario=service.addFeature(project.project_id,name,question).scenario;await bridge.enable(project.project_id);print({project,scenario});
  }else if(command==='current'){
    print(await call('arc_current_project',{}));
  }else if(command==='context'){
    print(await call('arc_engineering_context',{workspace_path:path.resolve(args[0])}));
  }else if(command==='begin-analysis'){
    const [scenarioId,requestId,taskId]=args,value=await call('arc_begin_analysis',{scenario_id:scenarioId,request_id:requestId,...(taskId?{development_task_id:taskId}:{})});
    if(service){const run=service.store.get('run',value.binding.run_id);run.status='waiting_agent';service.store.put('run',run.binding.run_id,run);}print(value);
  }else if(command==='read-source'){
    const [runId,file,start='1',count='160']=args;await resumeWaitingRun(runId);const value=await call('arc_read_source',{run_id:runId,path:file,line_start:Number(start),line_count:Number(count)});if(service){const run=service.store.get('run',runId);run.status='waiting_agent';service.store.put('run',runId,run);}print(value);
  }else if(command==='validate-analysis'){
    const [runId,file]=args,result=JSON.parse(await fs.readFile(file,'utf8'));
    if(connection)print(await call('arc_validate_result',{run_id:runId,result}));
    else{await resumeWaitingRun(runId);const run=service.store.get('run',runId),snapshot=service.store.get('snapshot',run.binding.source_snapshot_id),{validateResult}=await import('../src/main/validation.ts');print(await validateResult(result,run,snapshot,service.directory));run.status='waiting_agent';service.store.put('run',runId,run);}
  }else if(command==='submit-analysis'){
    const [runId,file]=args;await resumeWaitingRun(runId);const result=JSON.parse(await fs.readFile(file,'utf8'));print(await call('arc_submit_result',{run_id:runId,result}));
  }else if(command==='task'){
    print(await readTask(args[0]));
  }else if(command==='begin-development'){
    const [workspace,taskId,goal,submissionKey]=args;print(await call('arc_begin_development',{workspace_path:path.resolve(workspace),task_id:taskId,goal,submission_key:submissionKey}));
  }else if(command==='finish-development'){
    const [workspace,taskId,submissionKey,reportFile]=args,task=await readTask(taskId),report=JSON.parse(await fs.readFile(reportFile,'utf8'));
    const verification=(report.verification??[]).map(item=>({...item,evidence_id:item.evidence_id??randomUUID(),cwd:path.resolve(workspace),created_at:item.created_at??new Date().toISOString()}));
    const saved=await call('arc_finish_development',{task_id:taskId,expected_version:task.version,submission_key:submissionKey,status:report.status,summary:report.summary,decisions:report.decisions??[],unresolved:report.unresolved??[],steps:report.steps,verification});if(service)await service.refreshTaskWalkthrough(taskId);print(saved);
  }else if(command==='update-development'){
    const [taskId,submissionKey,reportFile]=args,task=await readTask(taskId),report=JSON.parse(await fs.readFile(reportFile,'utf8'));
    const verification=(report.verification??[]).map(item=>({...item,evidence_id:item.evidence_id??randomUUID(),cwd:task.workspace_path,created_at:item.created_at??new Date().toISOString()}));
    print(await call('arc_update_development',{task_id:taskId,expected_version:task.version,submission_key:submissionKey,summary:report.summary,decisions:report.decisions,unresolved:report.unresolved,steps:report.steps,verification}));
  }else throw Error(`Unknown command ${command}`);
}finally{
  // Only the direct mode closes its Store. A remote MCP host owns its lifecycle.
  service?.store.close();
}
