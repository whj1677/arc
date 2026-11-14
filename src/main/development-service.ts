import fs from 'node:fs/promises';
import path from 'node:path';
import type {EngineeringTask,DevelopmentAttempt,VerificationEvidence,CodeState} from '../engineering';
import type {ProviderProfile} from '../shared';
import {EngineeringService,sameVerificationState} from './engineering-service';
import {runDevelopmentCodex,type DevelopmentCommand} from './development-runner';
import {readCodexConfiguration} from './codex-configuration';
import {probeProviders,redact,type ActiveProcess} from './providers';
import {id,now,Store} from './store';

type CommandRecord={command:DevelopmentCommand;state:CodeState;log:string;stateVerified:boolean};

// Only strip a known shell wrapper; never match a test name as a substring of
// an unrelated command (for example `echo npm test`).
export function commandBody(value:string){
  let body=value.trim();
  const wrapped=body.match(/^(?:"[^"]*(?:powershell|pwsh|bash|sh)(?:\.exe)?"|\S*(?:powershell|pwsh|bash|sh)(?:\.exe)?)\s+(?:-[A-Za-z]+\s+)*?(?:-Command|-c)\s+([\s\S]+)$/i);
  if(wrapped){body=wrapped[1].trim();if((body.startsWith("'")&&body.endsWith("'"))||(body.startsWith('"')&&body.endsWith('"')))body=body.slice(1,-1);}
  return body.replace(/\r\n/g,'\n').trim();
}

export class DevelopmentService {
  readonly active=new Map<string,ActiveProcess>();
  readonly executing=new Map<string,Promise<void>>();
  private starting=new Set<string>();
  private cancelled=new Set<string>();
  private closing=false;
  constructor(readonly engineering:EngineeringService,readonly store:Store,readonly resources:string,readonly emit:(event:any)=>void,private readonly runner=runDevelopmentCodex,private readonly probe=probeProviders,private readonly configuration=readCodexConfiguration){}
  private event(attemptId:string,value:any){this.engineering.appendAttemptEvent(attemptId,JSON.parse(redact(JSON.stringify(value))));this.emit({type:'development_event',attempt_id:attemptId});}
  events(taskId:string){const task=this.engineering.task(taskId),attempts=task.attempt_ids.map(key=>this.store.get<DevelopmentAttempt>('development_attempt',key));return {attempts,events:attempts.flatMap(attempt=>this.engineering.attemptEvents(attempt.attempt_id).map((item:any)=>({...item.event,received_at:item.at,attempt_id:attempt.attempt_id})))};}
  async start(input:{project_id:string;goal:string;submission_key:string;task_id?:string}):Promise<EngineeringTask>{
    const workspace=await this.engineering.resolve({project_id:input.project_id});
    const receipt=this.store.maybe<{task_id:string}>('development_submission',input.submission_key);
    if(receipt){const prior=this.engineering.task(receipt.task_id);if(prior.project_id!==input.project_id)throw Error('开发请求标识属于另一个工程');return prior;}
    if(this.closing||this.starting.has(workspace.workspace_id))throw Error('此工作区已有开发任务，请等待结束或停止后再继续。');
    this.engineering.checkWorkspaceAvailable(workspace);
    this.starting.add(workspace.workspace_id);
    try{
      const task=await this.engineering.createTask(input);
      const attempt=this.engineering.startAttempt(task.task_id,{provider_id:'codex',model:'等待官方执行配置',origin:'arc'});
      this.store.put('development_submission',input.submission_key,{task_id:task.task_id});
      const pending=this.execute(attempt).catch(error=>this.fail(attempt,error)).finally(()=>{this.active.delete(attempt.attempt_id);this.executing.delete(attempt.attempt_id);this.cancelled.delete(attempt.attempt_id);});
      this.executing.set(attempt.attempt_id,pending);
      return this.engineering.task(task.task_id);
    }finally{this.starting.delete(workspace.workspace_id);}
  }
  private async execute(attempt:DevelopmentAttempt){
    const attemptId=attempt.attempt_id,taskId=attempt.task_id;
    this.event(attemptId,{type:'local.stage',message:'开发任务与工作区已固定，正在检查官方 Codex 登录和执行能力。'});
    const config=this.store.maybe<Record<string,string>>('settings','providers')||{};
    const profile=(await this.probe(config,'codex')).find(value=>value.provider_id==='codex')!;
    this.store.put('provider','codex',profile);
    if(profile.status!=='available'||!profile.path)throw Error(profile.reason+'；'+profile.auth);
    if(this.isStopped(attemptId))return;
    const configured=await this.configuration(profile.path,attempt.workspace_path);
    if(this.isStopped(attemptId))return;
    this.engineering.updateAttempt(attemptId,{model:configured.model?`配置：${configured.model}`:'沿用 Codex 默认模型（未取得标识）',runtime_version:profile.version});
    const task=this.engineering.task(taskId),context=await this.engineering.context({project_id:task.project_id});
    const baseline=attempt.baseline??task.baseline;
    if(context.workspace.workspace_id!==task.workspace_id||context.workspace.root_path!==task.workspace_path||!sameVerificationState(context.code_state,baseline))throw Error('WORKSPACE_CONFLICT：启动前工作区或代码基线已改变，未派发开发。');
    const records:CommandRecord[]=[];let captureQueue=Promise.resolve(),possibleWrite=0;
    const result=await this.runner({task,context,profile,storage:this.store.directory,
      event:event=>{if(event.item?.type==='file_change'||event.type==='item.started'&&event.item?.type==='command_execution')possibleWrite++;this.event(attemptId,event);},
      shouldStart:()=>!this.isStopped(attemptId),
      started:process=>{this.active.set(attemptId,process);if(this.isStopped(attemptId)){void process.cancel().catch(error=>this.event(attemptId,{type:'error',message:redact(String(error))}));return;}this.engineering.updateAttempt(attemptId,{status:'running',pid:process.child.pid});},
      commandCompleted:command=>{
        const atReceipt=possibleWrite;
        captureQueue=captureQueue.then(async()=>{
          const state=await this.engineering.captureState(task.project_id,task.workspace_path);
          const log=`development/${taskId}/${attemptId}/${id('command')}.log`;
          await fs.mkdir(path.dirname(path.join(this.store.directory,log)),{recursive:true});
          await fs.writeFile(path.join(this.store.directory,log),`${command.command}\n${command.output}`);
          records.push({command,state,log,stateVerified:atReceipt===possibleWrite});
        });return captureQueue;
      },
    });
    this.active.delete(attemptId);
    const diagnostic=`development/${taskId}/${attemptId}/diagnostic.json`;
    if(await fs.access(path.join(this.store.directory,diagnostic)).then(()=>true,()=>false))this.engineering.updateAttempt(attemptId,{log_path:diagnostic});
    if(this.cancelled.has(attemptId)||this.closing){await this.finishCancelled(attempt);return;}
    const latestAttempt=this.store.get<DevelopmentAttempt>('development_attempt',attemptId);
    if(latestAttempt.status==='interrupted')throw Error('停止状态未确认，拒绝迟到开发结果');
    if(result.code!==0||result.protocol_error||!result.result)throw Error(`Codex 开发未正常结束：${result.protocol_error||result.stderr||`exit ${result.code}`}`);
    const end=await this.engineering.captureState(task.project_id,task.workspace_path),verification:VerificationEvidence[]=[];
    const commandOutcome=(command:DevelopmentCommand)=>command.exit_code===0?'passed':command.exit_code===null?'blocked':'failed';
    const observedCommands=new Set<string>();
    for(const report of result.result.verification){
      const key=commandBody(report.command);
      if(observedCommands.has(key))continue;
      const matches=records.filter(record=>commandBody(record.command.command)===key);
      if(!matches.length){
        verification.push({evidence_id:id('verification'),command:report.command,cwd:task.workspace_path,
          outcome:report.outcome,exit_code:report.outcome==='passed'?0:null,origin:'self_reported',
          code_state:end,created_at:now(),code_state_verified:false,
          note:`${report.note}；未匹配实际命令回执，此项为 Agent 自述，不能作为独立验证通过。`});
        continue;
      }
      for(const record of matches){
        const outcome=commandOutcome(record.command);
        const note=result.result.verification.findLast(item=>commandBody(item.command)===key&&item.outcome===outcome)?.note;
        verification.push({evidence_id:id('verification'),command:record.command.command,cwd:task.workspace_path,
          outcome,exit_code:record.command.exit_code,origin:'observed',
          code_state:record.state,created_at:record.command.completed_at,log_path:record.log,code_state_verified:record.stateVerified,
          note:`${note?note+'；':''}代码状态采集于命令完成回执后，工作目录为绑定执行目录。${record.stateVerified?'':'采集期间出现后续命令或修改，验证对应代码状态不确定。'}`});
      }
      observedCommands.add(key);
    }
    verification.sort((a,b)=>a.created_at.localeCompare(b.created_at));
    const entryFailures:string[]=[];
    for(const [index,entry]of (result.result.context_entries??[]).entries()){
      if(this.isStopped(attemptId))throw Error('执行已停止，拒绝迟到工程条目');
      try{
        await this.engineering.saveEntry({...entry,entry_id:entry.entry_id||undefined,project_id:task.project_id,workspace_path:task.workspace_path,submission_key:`${attemptId}:entry:${index}`,status:'needs_review'},'agent',()=>!this.isStopped(attemptId));
      }catch(error){
        if(this.isStopped(attemptId))throw error;
        const message=`工程条目 ${index+1}（${entry.category}）未保存：${redact((error as Error).message||String(error))}`;
        entryFailures.push(message);this.event(attemptId,{type:'local.stage',stage:'context_entry_failed',message});
      }
    }
    if(this.isStopped(attemptId))throw Error('执行已停止，拒绝迟到开发结果');
    const current=this.engineering.task(taskId);
    const saved=await this.engineering.finishTask({task_id:taskId,attempt_id:attemptId,expected_version:current.version,submission_key:`${attemptId}:finish`,status:result.result.status,completion_binding:end.workspace_fingerprint?{workspace_path:task.workspace_path,workspace_fingerprint:end.workspace_fingerprint,head:end.head,branch:end.branch,git_common_dir:end.git_common_dir}:null,summary:result.result.summary,decisions:result.result.decisions,unresolved:[...result.result.unresolved,...entryFailures],verification});
    this.engineering.updateAttempt(attemptId,{status:saved.status==='completed'?'completed':'failed',session_id:result.session_id,
      ...(result.model?{model:`运行回执：${result.model}`}:{})});
    this.event(attemptId,{type:'local.stage',message:`开发结果已自动保存到原任务，验证状态：${saved.verification_status}。${entryFailures.length?`另有 ${entryFailures.length} 项工程条目未保存，详见未解决事项。`:''}`});
  }
  private isStopped(attemptId:string){return this.closing||this.cancelled.has(attemptId)||['cancelled','interrupted'].includes(this.store.get<DevelopmentAttempt>('development_attempt',attemptId).status);}
  private async fail(attempt:DevelopmentAttempt,error:unknown){
    const text=redact((error as Error).message||String(error)),current=this.store.get<DevelopmentAttempt>('development_attempt',attempt.attempt_id);
    if(current.status==='cancelled')return;
    if(this.cancelled.has(attempt.attempt_id)&&!(error as any)?.remoteUnknown){await this.finishCancelled(attempt);return;}
    const status=(error as any)?.remoteUnknown?'interrupted':'failed',environmentBlocked=(error as any)?.environmentBlocked===true;
    const diagnostic=`development/${attempt.task_id}/${attempt.attempt_id}/diagnostic.json`;
    const hasDiagnostic=await fs.access(path.join(this.store.directory,diagnostic)).then(()=>true,()=>false);
    if(!['failed','interrupted','cancelled','completed'].includes(current.status))this.engineering.updateAttempt(attempt.attempt_id,{status,error:text,...(hasDiagnostic?{log_path:diagnostic}:{})});
    let task=this.engineering.task(attempt.task_id);if(task.status==='cancelled')return;
    try{await this.engineering.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:`${attempt.attempt_id}:failure`,status:environmentBlocked?'blocked':'failed',summary:environmentBlocked?'开发环境未就绪；尚未调用模型或修改工程，代码验证未运行。':'开发未完成；已取得的修改和日志保留。',unresolved:[text]});}
    catch(captureError){task=this.engineering.task(task.task_id);this.engineering.updateTask({task_id:task.task_id,expected_version:task.version,submission_key:`${attempt.attempt_id}:failure-state`,status:status==='interrupted'?'interrupted':'blocked',summary:'开发未完成，工作区状态需核查。',unresolved:[text,redact((captureError as Error).message)]});}
    this.event(attempt.attempt_id,{type:'error',message:text});
  }
  private async finishCancelled(attempt:DevelopmentAttempt){
    const current=this.store.get<DevelopmentAttempt>('development_attempt',attempt.attempt_id);if(current.status!=='cancelled')this.engineering.updateAttempt(attempt.attempt_id,{status:'cancelled'});
    let task=this.engineering.task(attempt.task_id);if(task.status==='cancelled')return;
    try{await this.engineering.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:`${attempt.attempt_id}:cancelled`,status:'cancelled',summary:'已停止本次开发，保留已经产生的修改；不会自动重放。'});}
    catch(error){task=this.engineering.task(task.task_id);this.engineering.updateTask({task_id:task.task_id,expected_version:task.version,submission_key:`${attempt.attempt_id}:cancelled-state`,status:'cancelled',unresolved:[redact((error as Error).message)]});}
  }
  async cancel(taskId:string){
    const task=this.engineering.task(taskId),attemptId=task.attempt_ids.at(-1);if(!attemptId)return task;
    const attempt=this.store.get<DevelopmentAttempt>('development_attempt',attemptId);if(!['starting','running'].includes(attempt.status))return task;
    if(attempt.origin==='agent')throw Error('这是外部 Agent 正在执行的任务，ARC 无法确认其进程已停止。请在原 Agent 中停止，ARC 会保留已有记录。');
    this.cancelled.add(attemptId);this.event(attemptId,{type:'local.stage',message:'正在请求停止开发进程；已经写入的代码不会回滚。'});
    const process=this.active.get(attemptId);
    if(!process){await this.finishCancelled(attempt);return this.engineering.task(taskId);}
    try{await process.cancel();}catch(error){this.cancelled.delete(attemptId);this.engineering.updateAttempt(attemptId,{status:'interrupted',error:'无法确认开发进程已停止：'+redact(String(error))});throw error;}
    return {task_id:taskId,status:'cancel_requested'};
  }
  async shutdown(){this.closing=true;await Promise.allSettled([...this.executing.keys()].map(attemptId=>this.cancel(this.store.get<DevelopmentAttempt>('development_attempt',attemptId).task_id)));await Promise.allSettled([...this.executing.values()]);}
}
