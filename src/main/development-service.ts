import fs from 'node:fs/promises';
import path from 'node:path';
import type {CreateEngineeringTask,EngineeringContext,EngineeringTask,DevelopmentAttempt,VerificationEvidence,CodeState} from '../engineering';
import type {CodexPreferences,ProviderProfile,Run,Snapshot} from '../shared';
import {commandBody,inspectVerificationOutput} from '../delivery-audit';
import {EngineeringService,sameVerificationState} from './engineering-service';
import {runDevelopmentCodex,type DevelopmentCommand,type DevelopmentResult} from './development-runner';
import {runHostVerification} from './development-verify';
import {reviewDevelopmentDiff} from './development-review';
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

function observedEvidence(record:CommandRecord,host:boolean):VerificationEvidence{
  const {command,state,log,stateVerified,metrics}=record;
  const failed=command.exit_code!==0||!!metrics?.failed||(host&&metrics?.suspicious_empty);
  return {evidence_id:id('verification'),command:command.command,cwd:command.cwd,
    outcome:!host&&command.exit_code===null?'blocked':failed?'failed':'passed',exit_code:command.exit_code,origin:'observed',metrics,
    code_state:state,created_at:command.completed_at,log_path:log,code_state_verified:stateVerified,
    note:host?'ARC 宿主在绑定工作区执行并采集代码状态。':'代码状态采集于命令完成回执后。'+(stateVerified?'':'采集期间出现后续命令或修改，验证对应代码状态不确定。')};
}

// A sandbox error while editing or an unrelated unfinished requirement must stay blocked.
function onlySandboxVerificationBlocked(result:DevelopmentResult,verifiedCommands:string[]){
  const commands=verifiedCommands.map(commandBody);
  const pending=result.verification.filter(v=>v.outcome!=='passed');
  if(pending.some(v=>!commands.includes(commandBody(v.command))))return false;
  const parts=(text:string)=>text.split(/[;；。\n]|\.\s+|\s+(?:but|and also)\s+|此外|另有/i).map(s=>s.trim()).filter(Boolean);
  const kinds=[/\b(?:tests?|pytest|ctest|vitest|jest)\b|测试/i,/\bbuild\b|构建|编译/i,/\b(?:typecheck|tsc)\b|类型检查/i];
  const resolved=(text:string)=>{
    if(!/sandbox|沙箱|EPERM|EACCES/i.test(text))return false;
    if(/\b(?:edit|implement|requirement|business|approval)\b|修改源码|实现需求|业务|需授权|待确认/i.test(text))return false;
    const checks=kinds.filter(kind=>kind.test(text));
    return checks.length?checks.every(check=>commands.some(cmd=>check.test(cmd))):
      pending.length>0&&/verification|验证/i.test(text);
  };
  const blockers=(result.unresolved.length?result.unresolved:[result.summary]).flatMap(parts);
  if(!blockers.length||!blockers.every(resolved))return false;
  const summaryBlockers=parts(result.summary).filter(s=>/blocked|cannot|unable|missing|needs? approval|未完成|无法|缺少|待确认|受阻|阻塞/i.test(s));
  return summaryBlockers.every(resolved)&&(result.steps??[]).every(s=>s.status==='superseded'||
    (s.status==='completed'||s.status==='blocked'&&s.unresolved.length>0)&&s.unresolved.flatMap(parts).every(resolved));
}

function stripHostWait(text:string,commands:string[]){
  // Clear only clauses describing the host receipt. Keep independent acceptance work,
  // including a follow-up in the same sentence ("验证后仍需人工验收").
  const wait=/(?:等待|交由|由)\s*ARC\s*宿主.*(?:回填|执行|验证|补充|运行)/i;
  return text.split(/(?<=[。；;，,])|(?<=\n)/).map(part=>{
    const match=wait.exec(part);
    if(!match)return part;
    const subject=part.slice(0,match.index).trim().replace(/^现有\s*/,'');
    if(subject&&!commands.includes(subject)&&!/^(?:验证|测试|构建)(?:结果|证据|回执)?$/.test(subject))return part;
    const followUp=part.match(/(?:之?后|但|同时|并且|并)((?:仍|还|另|尚)?(?:需|须|待|应|要|人工|手动|修复).*)/);
    if(followUp)return followUp[1];
    return /尚未|仍未|失败|受阻|待确认/.test(part)?part:'';
  }).join('');
}
function reconcileHostSteps(result:DevelopmentResult,current:EngineeringTask,receipts:VerificationEvidence[]){
  const commands=receipts.map(item=>commandBody(item.command)),strip=(text:string)=>stripHostWait(text,commands);
  result.unresolved=result.unresolved.map(strip).filter(Boolean);
  const updates=new Map(result.steps?.map(step=>[step.step_id,step]));
  const savedSteps=(current.steps??[]).filter(step=>!updates.has(step.step_id));
  for(const step of [...savedSteps,...updates.values()]){
    if(step.status!=='in_progress'&&step.status!=='completed')continue;
    const progress=strip(step.progress),unresolved=step.unresolved.map(strip).filter(Boolean);
    if(progress===step.progress&&step.unresolved.every((line,index)=>line===unresolved[index]))continue;
    const matches=receipts.filter(item=>!item.step_id||item.step_id===step.step_id);
    if(!matches.length)continue;
    step.unresolved=unresolved;
    if(!step.unresolved.length&&!/(?:仍需|尚需|还需|待确认|待验收|需人工|需手动)/.test(progress))step.status='completed';
    if(progress!==step.progress)step.progress=progress.trimEnd()+'ARC 宿主验证通过。';
    step.evidence_ids=[...new Set([...step.evidence_ids,...matches.map(item=>item.evidence_id)])];
    for(const criterion of step.criteria){
      if(!criterion.evidence_ids.length)criterion.evidence_ids=matches.filter(item=>!item.criterion_id||item.criterion_id===criterion.criterion_id).map(item=>item.evidence_id);
    }
    updates.set(step.step_id,step);
  }
  if(updates.size)result.steps=[...updates.values()];
}

export {commandBody} from '../delivery-audit';

export class DevelopmentService {
  readonly active=new Map<string,ActiveProcess>();
  readonly executing=new Map<string,Promise<void>>();
  private starting=new Set<string>();
  private cancelled=new Set<string>();
  private closing=false;
  constructor(readonly engineering:EngineeringService,readonly store:Store,readonly resources:string,readonly emit:(event:any)=>void,
    private readonly runner=runDevelopmentCodex,private readonly probe=probeProviders,private readonly configuration=readCodexConfiguration,
    private readonly codexAnalysis=runCodex,private readonly dshWeb=runDshWeb,
    private readonly hostVerify:typeof runHostVerification|undefined=runner===runDevelopmentCodex?runHostVerification:undefined,
    private readonly diffReview:typeof reviewDevelopmentDiff|undefined=runner===runDevelopmentCodex?reviewDevelopmentDiff:undefined){}
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
      const task=await this.engineering.createTask({...input,scope});
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
    const preferences=this.store.codexPreferences();
    const configured=mode==='codex'&&task.workflow!=='analysis'?await this.configuration(profile.path,attempt.workspace_path):undefined;
    if(this.isStopped(attemptId))return;
    const model=mode==='codex'?(preferences.model||configured?.model):undefined;
    this.engineering.updateAttempt(attemptId,{model:model?`配置：${model}`:`沿用 ${engine} 默认模型`,runtime_version:profile.version});
    const context=await this.engineering.executionContext(task.project_id,task.task_id);
    const baseline=attempt.baseline??task.baseline;
    if(context.workspace.workspace_id!==task.workspace_id||context.workspace.root_path!==task.workspace_path||!sameVerificationState(context.code_state,baseline))throw Error('WORKSPACE_CONFLICT：启动前工作区或代码基线已改变，未派发开发。');
    if(task.workflow==='analysis'||mode==='dsh'){
      await this.executeFrozen(attempt,task,context,profile,mode,preferences);
      return;
    }
    const records:CommandRecord[]=[],hostReceipts=new Map<string,VerificationEvidence>();
    let captureQueue=Promise.resolve(),possibleWrite=0;
    const isStopped=()=>this.isStopped(attemptId);
    const checkRunning=()=>{if(isStopped())throw Error('执行已停止，拒绝迟到开发结果');};
    const capture=(command:DevelopmentCommand,host=false,link?:DevelopmentResult['verification'][number])=>{
      const atReceipt=possibleWrite;
      captureQueue=captureQueue.then(async()=>{
        const state=await this.engineering.captureState(task.project_id,task.workspace_path);
        const log=`development/${taskId}/${attemptId}/${id('command')}.log`;
        await fs.mkdir(path.dirname(path.join(this.store.directory,log)),{recursive:true});
        await fs.writeFile(path.join(this.store.directory,log),`${command.command}\n${command.output}`);
        const {label,skipped_flag,...metrics}=inspectVerificationOutput(command.command,command.exit_code,command.output);
        const record={command,state,log,stateVerified:atReceipt===possibleWrite,metrics:Object.keys(metrics).length?metrics:undefined};
        if(host){
          const current=this.engineering.task(taskId);
          const criterion=current.steps?.find(step=>step.step_id===link?.step_id)?.criteria.find(c=>c.criterion_id===link?.criterion_id);
          const receipt={...observedEvidence(record,true),...(criterion&&{step_id:link!.step_id,criterion_id:criterion.criterion_id})};
          this.engineering.updateTask({task_id:taskId,attempt_id:attemptId,expected_version:current.version,
            submission_key:log,verification:[receipt]},true);
          hostReceipts.set(command.id,receipt);
          this.event(attemptId,{type:'local.stage',stage:'host_command',message:`${command.command} · ${label}`});
        }else records.push(record);
      });
      return captureQueue;
    };
    const writeScope=attempt.write_scope!;
    const runEdit=async(repairFeedback?:string)=>{
      checkRunning();
      const result=await this.runner({task:repairFeedback?this.engineering.task(taskId):task,context,profile,preferences,storage:this.store.directory,writeScope,repairFeedback,
        event:event=>{if(event.item?.type==='file_change'||event.type==='item.started'&&event.item?.type==='command_execution')possibleWrite++;this.event(attemptId,event);},
        shouldStart:()=>!this.isStopped(attemptId),
        started:process=>this.started(attemptId,process),
        saveSteps:async value=>{if(this.isStopped(attemptId))throw Error('执行已停止，拒绝迟到步骤');const current=this.engineering.task(taskId);this.engineering.updateTask({task_id:taskId,attempt_id:attemptId,expected_version:current.version,steps:value as EngineeringTask['steps'],submission_key:`${attemptId}:steps:${sha(JSON.stringify(value))}`});this.event(attemptId,{type:'local.stage',stage:'development_steps_saved',message:'方案与步骤进展已保存到当前任务。'});},
        commandCompleted:command=>capture(command),
      });
      this.active.delete(attemptId);
      await captureQueue;
      checkRunning();
      if(result.code!==0||result.protocol_error||!result.result)throw Error(`Codex 开发未正常结束：${result.protocol_error||result.stderr||`exit ${result.code}`}`);
      this.engineering.updateAttempt(attemptId,{session_id:result.session_id,...(result.model?{model:`运行回执：${result.model}`}:{})});
      return result.result;
    };
    let result=await runEdit();
    const diagnostic=`development/${taskId}/${attemptId}/diagnostic.json`;
    if(await fs.access(path.join(this.store.directory,diagnostic)).then(()=>true,()=>false))this.engineering.updateAttempt(attemptId,{log_path:diagnostic});
    const priorReports:DevelopmentResult['verification']=[];
    const decisions=[...result.decisions];
    const repair=async(feedback:string)=>{
      priorReports.push(...result.verification);
      const previous=result;
      try{
        const state=await this.engineering.captureState(task.project_id,task.workspace_path);
        if(state.head!==baseline.head||state.branch!==baseline.branch||state.git_common_dir!==baseline.git_common_dir){
          throw Error('WORKSPACE_CONFLICT：修复前分支或仓库基线已改变。');
        }
        result=await runEdit(feedback);
      }
      catch(error){
        if(isStopped()||(error as {remoteUnknown?:boolean}).remoteUnknown)throw error;
        return {...previous,status:'failed' as const,summary:'自动修复未完成，已保留先前编辑和验证回执。',
          unresolved:[...previous.unresolved,`修复回合失败：${redact(String(error))}`]};
      }
      result.steps??=previous.steps;
      const entries=new Map([...(previous.context_entries??[]),...(result.context_entries??[])].map(e=>[e.entry_id||JSON.stringify([e.category,e.key]),e]));
      result.context_entries=[...entries.values()];
      decisions.push(...result.decisions);
      return result;
    };
    const gates=await this.verifyAndReview(attempt,task,context,profile,preferences,result,repair,decisions,command=>
      capture(command,true,result.verification.find(v=>commandBody(v.command)===commandBody(command.command))));
    result=gates.result;
    checkRunning();
    const end=await this.engineering.captureState(task.project_id,task.workspace_path),verification:VerificationEvidence[]=[];
    const latestReceipts=(gates.host?.commands??[]).map(command=>hostReceipts.get(command.id)!)
      .filter(item=>item.outcome==='passed'&&item.code_state_verified&&sameVerificationState(item.code_state,end));
    const hostPassed=latestReceipts.length>0&&latestReceipts.length===gates.host?.commands.length&&!gates.host.failed.length;
    if(gates.reviewedState&&!sameVerificationState(gates.reviewedState,end)){
      result.status='blocked';result.unresolved.push('独立审查期间代码发生变化，最终差异待复核。');
    }else if(gates.skippedFastReview&&!hostPassed){
      result.status='blocked';result.summary='最终代码与宿主验证回执不一致。';
      result.unresolved.push('快速直改的宿主验证未覆盖最终代码状态，请重新验证。');
    }else if(gates.sandboxBlockResolved&&hostPassed){
      decisions.push('沙箱中受限的验证已由 ARC 宿主执行通过。');
      result.status='completed';result.summary='已完成授权修改，ARC 宿主验证通过。';result.unresolved=[];
    }
    const observedCommands=new Set<string>();
    const reports=[...priorReports,...result.verification];
    for(const report of reports){
      const key=commandBody(report.command);
      if(observedCommands.has(key))continue;
      const matches=records.filter(record=>commandBody(record.command.command)===key);
      if(!matches.length){
        if(!result.verification.includes(report)||[...hostReceipts.values()].some(r=>commandBody(r.command)===key))continue;
        verification.push({evidence_id:id('verification'),command:report.command,cwd:task.workspace_path,
          outcome:report.outcome,exit_code:report.outcome==='passed'?0:null,origin:'self_reported',
          code_state:end,created_at:now(),code_state_verified:false,step_id:report.step_id,criterion_id:report.criterion_id,
          note:`${report.note}；未匹配实际命令回执，此项为 Agent 自述，不能作为独立验证通过。`});
        continue;
      }
      for(const record of matches){
        const evidence=observedEvidence(record,false);
        const matchedReport=reports.findLast(item=>commandBody(item.command)===key&&item.outcome===evidence.outcome),note=matchedReport?.note;
        verification.push({...evidence,
          step_id:(matchedReport??report).step_id,criterion_id:(matchedReport??report).criterion_id,
          note:`${note?note+'；':''}${evidence.note}`});
      }
      observedCommands.add(key);
    }
    verification.sort((a,b)=>a.created_at.localeCompare(b.created_at));
    const entryFailures:string[]=[];
    for(const [index,entry]of (result.context_entries??[]).entries()){
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
    if(hostPassed)reconcileHostSteps(result,current,latestReceipts);
    const saved=await this.engineering.finishTask({task_id:taskId,attempt_id:attemptId,expected_version:current.version,submission_key:`${attemptId}:finish`,status:result.status,completion_binding:end.workspace_fingerprint?{workspace_path:task.workspace_path,workspace_fingerprint:end.workspace_fingerprint,head:end.head,branch:end.branch,git_common_dir:end.git_common_dir}:null,summary:result.summary,decisions:[...new Set(decisions)],unresolved:[...result.unresolved,...entryFailures],steps:result.steps,verification},()=>!this.isStopped(attemptId),gates.diffReview);
    this.engineering.updateAttempt(attemptId,{status:saved.status==='completed'?'completed':'failed'});
    this.event(attemptId,{type:'local.stage',message:`开发结果已自动保存到原任务，验证状态：${saved.verification_status}。${entryFailures.length?`另有 ${entryFailures.length} 项工程条目未保存，详见未解决事项。`:''}`});
  }
  private async verifyAndReview(attempt:DevelopmentAttempt,task:EngineeringTask,context:EngineeringContext,profile:ProviderProfile,
    preferences:CodexPreferences,result:DevelopmentResult,repair:(feedback:string)=>Promise<DevelopmentResult>,decisions:string[],
    onCommand:(command:DevelopmentCommand)=>Promise<void>){
    const {attempt_id:attemptId,write_scope:writeScope=[]}=attempt,workspace=task.workspace_path;
    const stage=(code:string,message:string)=>this.event(attemptId,{type:'local.stage',stage:code,message});
    const isStopped=()=>this.isStopped(attemptId);
    const checkRunning=()=>{if(isStopped())throw Error('执行已停止，拒绝迟到交付结果');};
    let host:Awaited<ReturnType<typeof runHostVerification>>|undefined,reviewedState:CodeState|undefined;
    if(result.status==='failed'||(!this.hostVerify&&!this.diffReview))return {result};
    const env=this.hostVerify?await this.engineering.projectEnvironment(task.project_id):undefined;
    const verify=async()=>{
      checkRunning();
      if(!this.hostVerify||!env)return;
      stage('host_verification','ARC 宿主正在执行本机验证命令。');
      const check=await this.hostVerify({workspace,env,writeScope,isStopped,onCommand});
      checkRunning();
      this.engineering.updateAttempt(attemptId,{skipped_verification:check.skipped});
      for(const note of check.skipped){decisions.push(note);stage('host_verify_skipped',note);}
      return check;
    };
    const failures=(checks:NonNullable<typeof host>,withOutput=false)=>checks.failed.map(f=>
      `${f.command}（exit ${f.exit_code}）：${f.reason}${withOutput?'\n'+f.output.slice(-6000):''}`);
    host=await verify();
    if(host?.failed.length){
      stage('host_verify_repair','本机验证失败，正在进行一次自动修复。');
      result=await repair(failures(host,true).join('\n'));
      if(result.status!=='failed')host=await verify();
    }
    const stopForFailure=()=>{
      if(!host?.failed.length)return false;
      result.status='failed';result.summary='宿主验证未通过。';result.unresolved.push(...failures(host));
      return true;
    };
    if(stopForFailure()||result.status==='failed')return {result};

    let diffReview:EngineeringTask['diff_review'];
    const fastVerified=task.fast_mode&&!task.workflow&&host?.commands.length&&!host.skipped.length;
    if(this.diffReview&&!fastVerified){
      const review=this.diffReview;
      const inspect=async()=>{
        checkRunning();
        stage('delivery_review','正在独立复核批准范围内的代码差异。');
        reviewedState=await this.engineering.captureState(task.project_id,workspace);
        checkRunning();
        const summary=host?[...host.commands.map(c=>`${c.command} · ${inspectVerificationOutput(c.command,c.exit_code,c.output).label}`),...host.skipped].join('\n'):'';
        const verdict=await review({task,context,workspace,writeScope,profile,preferences,
          baselineRoot:path.join(this.store.directory,'snapshots',context.code_state.snapshot_id),verificationSummary:summary||'没有本机验证回执。'});
        checkRunning();
        const repaired=diffReview?.verdict==='needs_fix'&&verdict.verdict==='approved';
        diffReview={verdict:verdict.verdict,summary:verdict.summary,...(repaired&&{repaired:true})};
        decisions.push(`独立 Diff 审查（${verdict.verdict}）：${verdict.summary}`,...verdict.notes);
        return verdict.blocking_issues.map(i=>`${i.file}：${i.issue}；修复要求：${i.fix}`);
      };
      let issues=await inspect();
      if(issues.length){
        stage('delivery_review_repair','独立审查发现阻塞问题，正在进行一次自动修复。');
        result=await repair(issues.join('\n'));
        if(result.status!=='failed'){
          host=await verify();
          if(!stopForFailure())issues=await inspect();
        }
        if(issues.length){
          if(result.status!=='failed'){result.status='blocked';result.summary='自动修复后，独立 Diff 审查仍有阻塞问题。';}
          result.unresolved.push(...issues);
          return {result,host,diffReview};
        }
      }
    }
    const sandboxBlockResolved=result.status==='blocked'&&!!host?.commands.length&&!host.skipped.length
      &&onlySandboxVerificationBlocked(result,host.commands.map(c=>c.command));
    return {result,reviewedState,host,sandboxBlockResolved,diffReview,skippedFastReview:fastVerified};
  }
  private async executeFrozen(attempt:DevelopmentAttempt,task:EngineeringTask,context:EngineeringContext,profile:ProviderProfile,mode:LocalMode,preferences:CodexPreferences){
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
      const result=mode==='dsh'?await this.dshWeb({...optionsForTurn,submitResult:true}):await this.codexAnalysis({...optionsForTurn,outputDirectory,preferences});
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
