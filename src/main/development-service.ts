import fs from 'node:fs/promises';
import path from 'node:path';
import type {CreateEngineeringTask,EngineeringContext,EngineeringTask,DevelopmentAttempt,VerificationEvidence,CodeState} from '../engineering';
import type {ProviderProfile,Run,Snapshot} from '../shared';
import {inspectVerificationOutput} from '../delivery-audit';
import {EngineeringService,sameVerificationState} from './engineering-service';
import {runDevelopmentCodex,type DevelopmentCommand} from './development-runner';
import {readCodexConfiguration} from './codex-configuration';
import {probeProviders,redact,runCodex,type ActiveProcess} from './providers';
import {DshMalformedReply,runDshWeb} from './dsh-web';
import {applyDshEdits,codexRequirementPlanSchema,dshEditSchema,readDshEdits,readRequirementPlan,requirementPlanSchema,requirementPrompt} from './dsh-development';
import {id,now,Store} from './store';
import {resolveDevelopmentScope} from './development-scope';
import {sha} from './snapshot';

type CommandRecord={command:DevelopmentCommand;state:CodeState;log:string;stateVerified:boolean;metrics:VerificationEvidence['metrics']};
type LocalMode='codex'|'dsh';
type RequirementInput=CreateEngineeringTask & {project_id:string;phase?:'analysis'|'execution';expected_version?:number};

// Only strip a known shell wrapper; never match a test name as a substring of
// an unrelated command (for example `echo npm test`).
export function commandBody(value:string){
  let body=value.trim();
  const wrapped=body.match(/^(?:"(?:[^"]*[\\/])?(?:powershell|pwsh|bash|sh)(?:\.exe)?"|(?:\S*[\\/])?(?:powershell|pwsh|bash|sh)(?:\.exe)?)\s+(?:-[A-Za-z]+\s+)*?(?:-Command|-c)\s+([\s\S]+)$/i);
  if(wrapped){
    body=wrapped[1].trim();
    // Codex prints the shell argument as adjacent shlex-quoted fragments.
    // Decode the outer argument only. Quotes inside the script are significant.
    if(/^(?:'[^']*'|"(?:[^"\\]|\\[\s\S])*")+$/.test(body)){
      const fragments=body.matchAll(/'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"/g);
      body=Array.from(fragments,([,single,double])=>single??double.replace(/\\(["\\$\x60]|\r?\n)/g,(_,escaped)=>escaped.endsWith('\n')?'':escaped)).join('');
    }
  }
  return body.replace(/\r\n/g,'\n').trim();
}

export class DevelopmentService {
  readonly active=new Map<string,ActiveProcess>();
  readonly executing=new Map<string,Promise<void>>();
  private starting=new Set<string>();
  private cancelled=new Set<string>();
  private closing=false;
  constructor(readonly engineering:EngineeringService,readonly store:Store,readonly resources:string,readonly emit:(event:any)=>void,private readonly runner=runDevelopmentCodex,private readonly probe=probeProviders,private readonly configuration=readCodexConfiguration,private readonly codexAnalysis=runCodex,private readonly dshWeb=runDshWeb){}
  private event(attemptId:string,value:any){this.engineering.appendAttemptEvent(attemptId,JSON.parse(redact(JSON.stringify(value))));this.emit({type:'development_event',attempt_id:attemptId});}
  events(taskId:string){const task=this.engineering.task(taskId),attempts=task.attempt_ids.map(key=>this.store.get<DevelopmentAttempt>('development_attempt',key));return {attempts,events:attempts.flatMap(attempt=>this.engineering.attemptEvents(attempt.attempt_id).map((item:any)=>({...item.event,received_at:item.at,attempt_id:attempt.attempt_id})))};}
  async start(input:CreateEngineeringTask&{project_id:string;scope:string[]}):Promise<EngineeringTask>{
    const workspace=await this.engineering.resolve({project_id:input.project_id});
    const receipt=this.store.maybe<{task_id:string}>('development_submission',input.submission_key);
    if(receipt){const prior=this.engineering.task(receipt.task_id);if(prior.project_id!==input.project_id)throw Error('开发请求标识属于另一个工程');return prior;}
    if(this.closing||this.starting.has(workspace.workspace_id))throw Error('此工作区已有开发任务，请等待结束或停止后再继续。');
    this.engineering.checkWorkspaceAvailable(workspace);
    this.starting.add(workspace.workspace_id);
    try{
      const files=await resolveDevelopmentScope(workspace.root_path,input.scope);
      const scope=files.map(file=>path.relative(workspace.root_path,file).split(path.sep).join('/'));
      const task=await this.engineering.createTask(input);
      const attempt=this.engineering.startAttempt(task.task_id,{provider_id:'codex',model:'等待官方执行配置',origin:'arc',write_scope:scope});
      this.store.put('development_submission',input.submission_key,{task_id:task.task_id});
      this.launch(attempt);
      return this.engineering.task(task.task_id);
    }finally{this.starting.delete(workspace.workspace_id);}
  }
  async submit(input:RequirementInput,mode:LocalMode):Promise<EngineeringTask>{
    const phase=input.phase??'analysis';
    if(phase!=='analysis'&&phase!=='execution')throw Error('开发阶段无效');
    if(phase==='execution'&&!input.task_id)throw Error('请先提交并审阅需求包');
    const workspace=await this.engineering.connect(input.project_id);
    if(this.closing||this.starting.has(workspace.workspace_id))throw Error('此工作区已有开发任务，请等待结束或停止后再继续。');
    this.starting.add(workspace.workspace_id);
    try{
      const files=phase==='execution'?await resolveDevelopmentScope(workspace.root_path,input.scope):[];
      const scope=files.map(file=>path.relative(workspace.root_path,file).split(path.sep).join('/'));
      const task=await this.engineering.createTask({...input,scope},{phase,expected_version:input.expected_version,
        channel:mode,executionMode:mode,checkAvailable:()=>{
          if(this.closing)throw Error('Arc 正在退出，未启动开发任务');
          this.engineering.checkWorkspaceAvailable(workspace);
        },onSaved:()=>{}});
      if(task.workflow!==phase||task.status!=='pending'||task.execution_mode!==mode)return task;
      const attempt=this.engineering.startAttempt(task.task_id,{provider_id:mode,model:'等待本机引擎',origin:'arc',write_scope:task.scope});
      this.launch(attempt);
      return this.engineering.task(task.task_id);
    }finally{this.starting.delete(workspace.workspace_id);}
  }
  private launch(attempt:DevelopmentAttempt){
    const attemptId=attempt.attempt_id;
    const pending=this.execute(attempt).catch(error=>this.fail(attempt,error)).finally(()=>{
      this.active.delete(attemptId);this.executing.delete(attemptId);this.cancelled.delete(attemptId);
    });
    this.executing.set(attemptId,pending);
  }
  private started(attemptId:string,process:ActiveProcess){
    this.active.set(attemptId,process);
    if(this.isStopped(attemptId)){
      void process.cancel().catch(error=>this.event(attemptId,{type:'error',message:redact(String(error))}));
      return;
    }
    this.engineering.updateAttempt(attemptId,{status:'running',pid:process.child.pid});
  }
  private async execute(attempt:DevelopmentAttempt){
    const attemptId=attempt.attempt_id,taskId=attempt.task_id;
    const mode=attempt.provider_id==='dsh'?'dsh':'codex',engine=mode==='dsh'?'DSH Web':'Codex';
    this.event(attemptId,{type:'local.stage',message:`开发任务与工作区已固定，正在检查本机 ${engine} 登录和执行能力。`});
    const config=this.store.maybe<Record<string,string>>('settings','providers')||{};
    const [profile]=await this.probe(config,mode);
    this.store.put('provider',mode,profile);
    this.emit({type:'changed'});
    if(profile.status!=='available'||!profile.path)throw Object.assign(Error(profile.reason+'；'+profile.auth),{environmentBlocked:true});
    if(this.isStopped(attemptId))return;
    const task=this.engineering.task(taskId);
    const configured=mode==='codex'&&task.workflow!=='analysis'?await this.configuration(profile.path,attempt.workspace_path):undefined;
    if(this.isStopped(attemptId))return;
    this.engineering.updateAttempt(attemptId,{model:configured?.model?`配置：${configured.model}`:`沿用 ${engine} 默认模型`,runtime_version:profile.version});
    const context=await this.engineering.executionContext(task.project_id,task.task_id);
    const baseline=attempt.baseline??task.baseline;
    if(context.workspace.workspace_id!==task.workspace_id||context.workspace.root_path!==task.workspace_path||!sameVerificationState(context.code_state,baseline))throw Error('WORKSPACE_CONFLICT：启动前工作区或代码基线已改变，未派发开发。');
    if(task.workflow==='analysis'||mode==='dsh'){
      await this.executeFrozen(attempt,task,context,profile,mode);
      return;
    }
    const records:CommandRecord[]=[];let captureQueue=Promise.resolve(),possibleWrite=0;
    const result=await this.runner({task,context,profile,storage:this.store.directory,writeScope:attempt.write_scope!,
      event:event=>{if(event.item?.type==='file_change'||event.type==='item.started'&&event.item?.type==='command_execution')possibleWrite++;this.event(attemptId,event);},
      shouldStart:()=>!this.isStopped(attemptId),
      started:process=>this.started(attemptId,process),
      saveSteps:async value=>{if(this.isStopped(attemptId))throw Error('执行已停止，拒绝迟到步骤');const current=this.engineering.task(taskId);this.engineering.updateTask({task_id:taskId,attempt_id:attemptId,expected_version:current.version,steps:value as EngineeringTask['steps'],submission_key:`${attemptId}:steps:${sha(JSON.stringify(value))}`});this.event(attemptId,{type:'local.stage',stage:'development_steps_saved',message:'方案与步骤进展已保存到当前任务。'});},
      commandCompleted:command=>{
        const atReceipt=possibleWrite;
        captureQueue=captureQueue.then(async()=>{
          const state=await this.engineering.captureState(task.project_id,task.workspace_path);
          const log=`development/${taskId}/${attemptId}/${id('command')}.log`;
          await fs.mkdir(path.dirname(path.join(this.store.directory,log)),{recursive:true});
          await fs.writeFile(path.join(this.store.directory,log),`${command.command}\n${command.output}`);
          const {label,skipped_flag,...metrics}=inspectVerificationOutput(command.command,command.exit_code,command.output);
          records.push({command,state,log,stateVerified:atReceipt===possibleWrite,metrics:Object.keys(metrics).length?metrics:undefined});
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
          code_state:end,created_at:now(),code_state_verified:false,step_id:report.step_id,criterion_id:report.criterion_id,
          note:`${report.note}；未匹配实际命令回执，此项为 Agent 自述，不能作为独立验证通过。`});
        continue;
      }
      for(const record of matches){
        const outcome=commandOutcome(record.command);
        const matchedReport=result.result.verification.findLast(item=>commandBody(item.command)===key&&item.outcome===outcome),note=matchedReport?.note;
        verification.push({evidence_id:id('verification'),command:record.command.command,cwd:task.workspace_path,
          outcome,exit_code:record.command.exit_code,origin:'observed',metrics:record.metrics,
          code_state:record.state,created_at:record.command.completed_at,log_path:record.log,code_state_verified:record.stateVerified,
          step_id:(matchedReport??report).step_id,criterion_id:(matchedReport??report).criterion_id,
          note:`${note?note+'；':''}代码状态采集于命令完成回执后，工作目录为绑定执行目录。${record.stateVerified?'':'采集期间出现后续命令或修改，验证对应代码状态不确定。'}`});
      }
      observedCommands.add(key);
    }
    verification.sort((a,b)=>a.created_at.localeCompare(b.created_at));
    const entryFailures:string[]=[];
    for(const [index,entry]of (result.result.context_entries??[]).entries()){
      if(this.isStopped(attemptId))throw Error('执行已停止，拒绝迟到工程条目');
      try{
        const existing=entry.entry_id?context.entries.find(value=>value.entry_id===entry.entry_id):undefined;
        if(entry.entry_id&&!existing)throw Error('条目不属于本次执行上下文');
        await this.engineering.saveEntry({...entry,task_id:entry.entry_id?existing?.task_id:task.task_id,entry_id:entry.entry_id||undefined,project_id:task.project_id,workspace_path:task.workspace_path,submission_key:`${attemptId}:entry:${index}`,status:'needs_review'},'agent',()=>!this.isStopped(attemptId));
      }catch(error){
        if(this.isStopped(attemptId))throw error;
        const message=`工程条目 ${index+1}（${entry.category}）未保存：${redact((error as Error).message||String(error))}`;
        entryFailures.push(message);this.event(attemptId,{type:'local.stage',stage:'context_entry_failed',message});
      }
    }
    if(this.isStopped(attemptId))throw Error('执行已停止，拒绝迟到开发结果');
    const current=this.engineering.task(taskId);
    const saved=await this.engineering.finishTask({task_id:taskId,attempt_id:attemptId,expected_version:current.version,submission_key:`${attemptId}:finish`,status:result.result.status,completion_binding:end.workspace_fingerprint?{workspace_path:task.workspace_path,workspace_fingerprint:end.workspace_fingerprint,head:end.head,branch:end.branch,git_common_dir:end.git_common_dir}:null,summary:result.result.summary,decisions:result.result.decisions,unresolved:[...result.result.unresolved,...entryFailures],steps:result.result.steps,verification},()=>!this.isStopped(attemptId));
    this.engineering.updateAttempt(attemptId,{status:saved.status==='completed'?'completed':'failed',session_id:result.session_id,
      ...(result.model?{model:`运行回执：${result.model}`}:{})});
    this.event(attemptId,{type:'local.stage',message:`开发结果已自动保存到原任务，验证状态：${saved.verification_status}。${entryFailures.length?`另有 ${entryFailures.length} 项工程条目未保存，详见未解决事项。`:''}`});
  }
  private async executeFrozen(attempt:DevelopmentAttempt,task:EngineeringTask,context:EngineeringContext,profile:ProviderProfile,mode:LocalMode){
    const {attempt_id:attemptId}=attempt,{task_id:taskId}=task,planning=task.workflow==='analysis';
    const storage=this.store.directory,outputDirectory=path.join(storage,'development',taskId,attemptId);
    const snapshot=this.store.get<Snapshot>('snapshot',context.code_state.snapshot_id);
    const run:Run={binding:{run_id:attemptId,source_snapshot_id:snapshot.source_snapshot_id,project_id:task.project_id,
      feature_id:task.reading?.feature_id??taskId,scenario_id:task.reading?.scenario_id??taskId,question_revision_id:`task-${task.version}`},
      provider_id:mode,execution_mode:mode,status:'queued',created_at:attempt.started_at,question:task.goal,
      title:planning?'只读需求分析':'批准范围实施',submission_key:task.submission_key,output_path:path.join(outputDirectory,'result.json')};
    const reads=new Set<string>(),pendingReads=new Map<string,string>();
    const checkRunning=()=>{if(this.isStopped(attemptId))throw Error('执行已停止，拒绝迟到结果');};
    this.event(attemptId,{type:'local.stage',stage:planning?'requirement_analysis':'dsh_implementation',
      message:planning?'正在读取冻结源码并形成可审阅需求包。':'正在读取批准文件并生成变更。'});
    const options={run,snapshot,storage,resources:this.resources,profile,prompt:requirementPrompt(task,context),
      outputSchema:planning?(mode==='codex'?codexRequirementPlanSchema:requirementPlanSchema):dshEditSchema,shouldStart:()=>!this.isStopped(attemptId),
      started:(process:ActiveProcess)=>this.started(attemptId,process),
      event:(event:any)=>{
        if((event.type==='session.started'||event.type==='thread.started')&&typeof event.thread_id==='string'&&!this.isStopped(attemptId)){
          this.engineering.updateAttempt(attemptId,{session_id:event.thread_id});
        }
        const update=event.update;
        if(update?.sessionUpdate==='tool_call'&&/(?:^|__)arc_read_source$/.test(update.title)&&typeof update.rawInput?.path==='string'){
          pendingReads.set(update.toolCallId,update.rawInput.path);
        }
        if(update?.sessionUpdate==='tool_call_update'&&update.status==='completed'){
          const file=pendingReads.get(update.toolCallId);
          if(file)reads.add(file);
          pendingReads.delete(update.toolCallId);
        }
        this.event(attemptId,event);
      }};
    const readReply=async(optionsForTurn:typeof options)=>{
      const result=mode==='dsh'?await this.dshWeb({...optionsForTurn,submitResult:true}):await this.codexAnalysis({...optionsForTurn,outputDirectory});
      this.active.delete(attemptId);
      checkRunning();
      if(result.code!==0||result.protocol_error)throw Error(result.protocol_error||result.stderr||`引擎退出：${result.code}`);
      return result.raw;
    };
    const parseReply=(raw:string)=>{
      try{
        return planning
          ?{phase:'analysis' as const,value:readRequirementPlan(raw)}
          :{phase:'execution' as const,value:readDshEdits(raw)};
      }catch(error){
        throw new DshMalformedReply((error as Error).message);
      }
    };
    let reply:ReturnType<typeof parseReply>;
    try{reply=parseReply(await readReply(options));}
    catch(error){
      if(mode!=='dsh'||!(error instanceof DshMalformedReply))throw error;
      checkRunning();
      reads.clear();pendingReads.clear();
      this.event(attemptId,{type:'local.stage',stage:'dsh_structured_retry',message:'DSH 返回的 JSON 未通过合同校验，保留原始结果并重新生成一次。'});
      reply=parseReply(await readReply({...options,
        run:{...run,output_path:path.join(outputDirectory,'retry','result.json')},
        prompt:options.prompt+'\n上一轮结果未通过合同校验。请简洁重做这一轮，并通过结果提交工具完成。',
      }));
    }
    const current=this.engineering.task(taskId);
    if(current.version!==task.version)throw Error('任务版本已变化，请从最新版本重新分析');
    const finish={task_id:taskId,attempt_id:attemptId,expected_version:current.version,
      submission_key:`${attemptId}:finish`,status:'completed' as const};
    if(reply.phase==='analysis'){
      const plan=reply.value;
      await resolveDevelopmentScope(task.workspace_path,plan.proposed_scope);
      checkRunning();
      const saved=await this.engineering.finishTask({...finish,...plan},()=>!this.isStopped(attemptId));
      this.engineering.updateAttempt(attemptId,{status:saved.workflow==='ready'?'completed':'failed'});
      this.event(attemptId,{type:'local.stage',message:saved.workflow==='ready'?'需求包已保存，等待审阅确认。':saved.unresolved.at(-1)});
      return;
    }
    const {summary,edits,unresolved}=reply.value;
    const live=await this.engineering.captureState(task.project_id,task.workspace_path);
    if(!sameVerificationState(context.code_state,live)||this.engineering.task(taskId).version!==task.version){
      throw Error('工作区或需求版本已变化，请重新分析后再实施');
    }
    if(edits.some(edit=>!reads.has(edit.path)))throw Error('修改包含未通过冻结源码工具读取的文件，未写入工程');
    await applyDshEdits(task.workspace_path,task.scope,snapshot,edits,checkRunning);
    checkRunning();
    await this.engineering.finishTask({...finish,summary,unresolved:[...unresolved,'需求包中的业务验证尚未执行。']},()=>!this.isStopped(attemptId));
    this.engineering.updateAttempt(attemptId,{status:'completed'});
    this.event(attemptId,{type:'local.stage',message:'实施结果已保存到原任务，验证尚未运行。'});
  }
  private isStopped(attemptId:string){return this.closing||this.cancelled.has(attemptId)||['cancelled','interrupted'].includes(this.store.get<DevelopmentAttempt>('development_attempt',attemptId).status);}
  private async fail(attempt:DevelopmentAttempt,error:unknown){
    const text=redact((error as Error).message||String(error)),current=this.store.get<DevelopmentAttempt>('development_attempt',attempt.attempt_id);
    if(current.status==='cancelled')return;
    if((this.cancelled.has(attempt.attempt_id)||this.closing)&&!(error as any)?.remoteUnknown){
      await this.finishCancelled(attempt,(error as any)?.recoveryFailed?text:undefined);return;
    }
    const status=(error as any)?.remoteUnknown?'interrupted':'failed',environmentBlocked=(error as any)?.environmentBlocked===true;
    const diagnostic=`development/${attempt.task_id}/${attempt.attempt_id}/diagnostic.json`;
    const hasDiagnostic=await fs.access(path.join(this.store.directory,diagnostic)).then(()=>true,()=>false);
    if(!['failed','interrupted','cancelled','completed'].includes(current.status))this.engineering.updateAttempt(attempt.attempt_id,{status,error:text,...(hasDiagnostic?{log_path:diagnostic}:{})});
    let task=this.engineering.task(attempt.task_id);if(task.status==='cancelled')return;
    try{await this.engineering.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:`${attempt.attempt_id}:failure`,status:environmentBlocked?'blocked':'failed',summary:environmentBlocked?'开发环境未就绪；尚未调用模型或修改工程，代码验证未运行。':'开发未完成；已取得的修改和日志保留。',unresolved:[text]});}
    catch(captureError){task=this.engineering.task(task.task_id);this.engineering.updateTask({task_id:task.task_id,expected_version:task.version,submission_key:`${attempt.attempt_id}:failure-state`,status:status==='interrupted'?'interrupted':'blocked',summary:'开发未完成，工作区状态需核查。',unresolved:[text,redact((captureError as Error).message)]});}
    this.event(attempt.attempt_id,{type:'error',message:text});
  }
  private async finishCancelled(attempt:DevelopmentAttempt,recoveryError?:string){
    const current=this.store.get<DevelopmentAttempt>('development_attempt',attempt.attempt_id);if(current.status!=='cancelled')this.engineering.updateAttempt(attempt.attempt_id,{status:'cancelled'});
    let task=this.engineering.task(attempt.task_id);if(task.status==='cancelled')return;
    const unresolved=recoveryError?[...task.unresolved,recoveryError]:task.unresolved;
    try{await this.engineering.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:`${attempt.attempt_id}:cancelled`,status:'cancelled',summary:'已停止本次开发，保留当前工作区状态。',unresolved});}
    catch(error){task=this.engineering.task(task.task_id);this.engineering.updateTask({task_id:task.task_id,expected_version:task.version,submission_key:`${attempt.attempt_id}:cancelled-state`,status:'cancelled',unresolved:[...unresolved,redact((error as Error).message)]});}
  }
  async cancel(taskId:string){
    const task=this.engineering.task(taskId),attemptId=task.attempt_ids.at(-1);if(!attemptId||task.status!=='running')return task;
    const attempt=this.store.get<DevelopmentAttempt>('development_attempt',attemptId);if(!['starting','running'].includes(attempt.status))return task;
    if(attempt.origin==='agent')throw Error('这是外部 Agent 正在执行的任务，ARC 无法确认其进程已停止。请在原 Agent 中停止，ARC 会保留已有记录。');
    this.cancelled.add(attemptId);this.event(attemptId,{type:'local.stage',message:'正在请求停止本机开发。'});
    const process=this.active.get(attemptId);
    if(!process&&attempt.status==='starting'){await this.finishCancelled(attempt);return this.engineering.task(taskId);}
    if(!process)return {task_id:taskId,status:'cancel_requested'};
    try{await process.cancel();}catch(error){this.cancelled.delete(attemptId);this.engineering.updateAttempt(attemptId,{status:'interrupted',error:'无法确认开发进程已停止：'+redact(String(error))});throw error;}
    return {task_id:taskId,status:'cancel_requested'};
  }
  async shutdown(){this.closing=true;await Promise.allSettled([...this.executing.keys()].map(attemptId=>this.cancel(this.store.get<DevelopmentAttempt>('development_attempt',attemptId).task_id)));await Promise.allSettled([...this.executing.values()]);}
}
