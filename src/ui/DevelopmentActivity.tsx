import React,{useEffect,useState} from 'react';
import type {DevelopmentAttempt,EngineeringTask} from '../engineering';
import type {Dispatch} from '../main/external-dispatch';
import {TaskBoundaries} from './TaskBoundaries';
import {verificationEvidenceLabel} from '../delivery-audit';

export type ActivityEvent={attempt_id:string;received_at:string;type:string;message?:string;item?:{type:string;text?:string;command?:string;aggregated_output?:string;exit_code?:number}};
const receiptNames:Record<Dispatch['state'],string>={queued:'已排队，等待发送',sending:'正在发送',awaiting_claim:'已发送，等待 Agent 领取',running:'Agent 已领取',completed:'回填完成',blocked:'派发受阻',unknown:'派发状态待核对',cancelled:'派发已取消'};
const executionNames:Record<DevelopmentAttempt['status'],string>={starting:'准备执行',running:'执行中',completed:'执行结束',failed:'执行失败',cancelled:'已取消',interrupted:'执行中断'};

export function taskDetailStage(task:EngineeringTask){
  if(task.workflow==='ready')return 'approval';
  if(task.status!=='pending'&&task.status!=='running')return 'delivery';
  if(task.workflow==='analysis')return 'analysis';
  if(task.workflow==='execution'||task.status==='running'||task.attempt_ids.length||task.changes.length||task.verification.length)return 'delivery';
  return 'pending';
}

export function publicActivity(event:ActivityEvent){
  if(event.type==='local.stage'||event.type==='error')return event.message;
  if(event.item?.type==='agent_message')return event.item.text;
  if(event.item?.type==='command_execution'){
    return [event.item.command,event.item.aggregated_output,typeof event.item.exit_code==='number'?'退出码 '+event.item.exit_code:''].filter(Boolean).join('\n');
  }
}
export function DevelopmentActivity({task,attempt,dispatch,events,onSettings}:{task:EngineeringTask;attempt?:DevelopmentAttempt;dispatch?:Dispatch;events:ActivityEvent[];onSettings:()=>void}){
  const terminal=['completed','failed','blocked','cancelled','interrupted'].includes(task.status);
  const [expanded,setExpanded]=useState(!terminal&&task.workflow!=='ready');
  const lines=events.filter(event=>event.attempt_id===attempt?.attempt_id).flatMap(event=>{
    const text=publicActivity(event);
    return text?[{at:event.received_at,text}]:[];
  });
  const step=task.steps?.filter(item=>item.status==='in_progress'&&item.updated_at>=(attempt?.started_at??dispatch?.created_at??task.created_at)).sort((a,b)=>b.updated_at.localeCompare(a.updated_at))[0];
  const receipt=dispatch?receiptNames[dispatch.state]:attempt?executionNames[attempt.status]:'等待执行记录';
  const latest=lines.at(-1);

  const stepIsLatest=step?.progress&&(!latest||step.updated_at>=latest.at);
  const backfilled=terminal||task.workflow==='ready';
  const at=[dispatch?.last_activity,dispatch?.claimed_at,dispatch?.sent_at,dispatch?.created_at,attempt?.ended_at,attempt?.started_at,latest?.at,step?.updated_at,backfilled?task.updated_at:undefined].filter((s):s is string=>!!s).sort().at(-1);
  const message=(backfilled?task.summary:'')||dispatch?.error||attempt?.error||(stepIsLatest?step.progress:latest?.text)||'尚未收到本轮的公开输出。';
  return <section className="development-activity" aria-label="执行动态">
    <div className="development-activity-heading"><button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>执行动态 {expanded?'▴':'▾'}</button>
      {!backfilled&&<span role="status">{attempt?.provider_id==='dsh'?'DeepSeek Harness · ':''}{receipt}</span>}
      {at&&<time dateTime={at} title={new Date(at).toLocaleString()}>最近记录 {new Date(at).toLocaleTimeString()}</time>}
    </div>
    {expanded&&<div className="development-activity-body"><p>{message.length>240?message.slice(0,240)+'…':message}</p>
      {!!lines.length&&<details><summary>查看已收到的输出 · {lines.length} 条</summary><ol>{lines.map((line,i)=><li key={i}><time>{new Date(line.at).toLocaleTimeString()}</time><pre>{line.text}</pre></li>)}</ol></details>}
      {dispatch&&['blocked','unknown'].includes(dispatch.state)&&<button onClick={onSettings}>核对连接与派发</button>}
    </div>}
  </section>;
}
function RequirementQuestions({task}:{task:EngineeringTask}){
  const pkg=task.requirement_package!;
  const assumptions=pkg.assumptions??[];
  const questions=pkg.open_questions??[...new Set([...task.unresolved,...(task.steps??[]).filter(step=>step.status!=='superseded').flatMap(step=>step.unresolved)])];
  const any=!!(assumptions.length||questions.length);
  return <section className={any?'requirement-uncertainties':''}><h4>假设与待确认</h4>
    {assumptions.length>0&&<ApprovalGroup title="AI 假设" items={assumptions}/>}
    {questions.length>0&&<ApprovalGroup title="待确认项" items={questions}/>}
    {!any&&<p className="muted">暂无假设或待确认项。</p>}
  </section>;
}
function RequirementPackage({task,record=task,readOnly=true,onSaved,showBoundaries=true}:{
  task:EngineeringTask;record?:EngineeringTask;readOnly?:boolean;showBoundaries?:boolean;onSaved?:(task:EngineeringTask)=>void;
}){
  const pkg=task.requirement_package;
  if(!pkg)return <p>此版本没有正式需求包。</p>;
  const scope=record.approval?.scope??task.proposed_scope??task.scope;
  return <section aria-label="正式需求包" className="requirement-package">
    <h3>正式需求包 · v{task.version}</h3><h4>需求目标</h4><p>{task.goal}</p>
    {task.requests?.some(request=>request.text!==task.goal)&&<details><summary>历史接续要求</summary><ul>{task.requests.filter(request=>request.text!==task.goal).map(request=><li key={request.submission_key}>{request.text}</li>)}</ul></details>}
    {task.summary&&<><h4>任务摘要</h4><p>{task.summary}</p></>}
    <h4>行为变化</h4>{pkg.behaviors.map(behavior=><article key={behavior.id} className="requirement-behavior">
      <strong>{behavior.behavior}</strong><p>{behavior.design}</p>
      <dl><dt>涉及文件</dt><dd>{behavior.files.map(file=><code key={file}>{file}</code>)}</dd>
      <dt>验收方式</dt><dd>{behavior.verification}</dd></dl>
      {behavior.step_ids.map(id=>{
        const step=task.steps?.find(item=>item.step_id===id);
        if(!step)return <p key={id}>缺少关联步骤 {id}</p>;
        const recordedStep=record.steps?.find(item=>item.step_id===id);
        const evidence=record.verification.filter(item=>item.step_id===id||recordedStep?.evidence_ids.includes(item.evidence_id)||recordedStep?.criteria.some(c=>c.evidence_ids.includes(item.evidence_id)));
        return <div className="requirement-step" key={id}>
          <strong>{step.title}</strong><p>{step.change}</p>
          <ul>{step.criteria.map(criterion=><li key={criterion.criterion_id}>{criterion.text}</li>)}</ul>
          {!!step.unresolved?.length&&<><small>此步骤待解决</small><ul>{step.unresolved.map((item,i)=><li key={i}>{item}</li>)}</ul></>}
          {evidence.length?<><small>关联验证记录{record.verification_status==='stale'?' · 代码已变化，需重新验证':''}</small><ul>{evidence.map(item=><li key={item.evidence_id}>
            {verificationEvidenceLabel(item)} · {item.origin==='observed'?'实际执行':'Agent 上报'} · <code>{item.command}</code>{item.criterion_id&&' · '+(step.criteria.find(c=>c.criterion_id===item.criterion_id)?.text??item.criterion_id)}
          </li>)}</ul></>:<small>尚无关联验证记录</small>}
        </div>;
      })}
    </article>)}
    {task.decisions.length>0&&<><h4>已记录的决定</h4><ul>{task.decisions.map((item,i)=><li key={i}>{item}</li>)}</ul></>}
    {task.unresolved.length>0&&<><h4>待解决事项</h4><ul>{task.unresolved.map((item,i)=><li key={i}>{item}</li>)}</ul></>}
    <h4>{record.approval?'已批准修改文件':'建议修改文件'}</h4><ul>{scope.map(file=><li key={file}><code>{file}</code></li>)}</ul>
    <RequirementQuestions task={task}/>
    {showBoundaries&&<TaskBoundaries task={record} readOnly={readOnly} onSaved={onSaved} title="本轮不改与已撤销红线"/>}
  </section>;
}

export function SavedRequirementPackage({task,readOnly=false,onSaved}:{task:EngineeringTask;readOnly?:boolean;onSaved?:(task:EngineeringTask)=>void}){
  const [open,setOpen]=useState(false),[reviewed,setReviewed]=useState<EngineeringTask|null>(null),[error,setError]=useState('');
  const version=task.approval?.reviewed_version;
  useEffect(()=>{
    if(!open||!version)return;
    let current=true;
    setError('');
    void window.arc.invoke<EngineeringTask[]>('engineering_history',{kind:'task',id:task.task_id}).then(rows=>{
      if(!current)return;
      const snapshot=rows.find(row=>row.task_id===task.task_id&&row.version===version);
      if(!snapshot)throw Error('未找到已批准的需求包版本 v'+version);
      setReviewed(snapshot);
    }).catch(e=>{if(current)setError(e.message);});
    return()=>{current=false;};
  },[open,task.task_id,version]);
  const snapshot=version?(reviewed?.task_id===task.task_id&&reviewed.version===version?reviewed:null):task;
  return <details className="saved-requirement-package" onToggle={event=>setOpen(event.currentTarget.open)}><summary>查看正式需求包</summary>
    {open&&(snapshot?<RequirementPackage task={snapshot} record={task} readOnly={readOnly} onSaved={onSaved}/>:<p role={error?'alert':'status'}>{error||'正在读取已批准的版本…'}</p>)}
  </details>;
}

function ApprovalGroup({title,items,format='bullets',empty}:{title:string;items:string[];format?:'bullets'|'numbered'|'files';empty?:string}){
  const [expanded,setExpanded]=useState(false);
  const List=format==='numbered'?'ol':'ul';
  const filenames=format==='files'?items.map(path=>path.split('/').at(-1)||path):[];
  const distinctFiles=new Set(filenames).size===filenames.length;
  const abbreviated=format==='files'&&distinctFiles&&items.some((path,index)=>path!==filenames[index]);
  return <section>
    <div className="approval-group-title"><h4>{title}</h4><span>{items.length} {format==='files'?'个文件':'项'}</span></div>
    {items.length?<List className={format==='files'?'approval-file-list':undefined}>{items.map((item,index)=><li key={index}>{format==='files'?<code title={item}>{abbreviated&&!expanded?filenames[index]:item}</code>:item}</li>)}</List>:<p>{empty}</p>}
    {abbreviated&&<button type="button" className="approval-expand" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起完整路径':'查看完整路径'}</button>}
  </section>;
}

function ApprovalOverview({snapshot,scope,disabled,onSaved,onSavingChange}:{snapshot:EngineeringTask;scope:string[];disabled:boolean;onSaved:(task:EngineeringTask)=>void;onSavingChange:(saving:boolean)=>void}){
  const pkg=snapshot.requirement_package;
  if(!pkg)return <p>此版本没有正式需求包。</p>;
  return <>
    <section aria-label="批准内容" className="approval-overview">
      <ApprovalGroup title="行为变化" items={pkg.behaviors.map(item=>item.behavior)} format="numbered"/>
      <ApprovalGroup title="建议修改文件" items={scope} format="files" empty="未列出建议修改文件。"/>
      <ApprovalGroup title="验收方式" items={pkg.behaviors.map(item=>item.verification)} format="numbered"/>
      <RequirementQuestions task={snapshot}/>
    </section>
    <TaskBoundaries task={snapshot} title="本轮不改与已撤销红线" disabled={disabled} onSaved={onSaved} onSavingChange={onSavingChange}/>
    <details className="approval-source"><summary>查看完整需求包</summary><RequirementPackage task={snapshot} showBoundaries={false}/></details>
  </>;
}

export function PlanDecision({task,busy,error,onDecision,onTaskSaved}:{task:EngineeringTask;busy:boolean;error:string;onDecision:(snapshot:EngineeringTask,revision?:string)=>void;onTaskSaved?:(task:EngineeringTask)=>void}){
  const [snapshot,setSnapshot]=useState(task),[feedback,setFeedback]=useState('');
  const [saving,setSaving]=useState(false);
  const stale=snapshot.version!==task.version;
  const scope=snapshot.proposed_scope??snapshot.scope;
  const refresh=()=>{setSnapshot(task);setFeedback('');};
  return <section className="plan-decision engineering-approval" aria-label="审阅待确认方案">
      <header><h3>审阅待确认方案 <small>v{snapshot.version}</small></h3></header>
      <div className="plan-review-body">
        {stale&&<div role="alert">任务已更新至 v{task.version}，当前展示 v{snapshot.version}。<button disabled={busy} onClick={refresh}>查看最新版本</button></div>}
        {error&&<p role="alert">{error}</p>}
        <ApprovalOverview snapshot={snapshot} scope={scope} disabled={busy||stale} onSavingChange={setSaving}
          onSaved={updated=>{setSnapshot(updated);onTaskSaved?.(updated);}}/>
      </div>
      <footer className="plan-review-actions">
        {snapshot.requirement_package?<><label>修订意见<textarea aria-label="修订意见" placeholder="需要补充或调整什么？" rows={1} value={feedback} onChange={event=>setFeedback(event.target.value)}/></label>
          <div className="row"><button disabled={busy||saving||stale||!feedback.trim()} onClick={()=>onDecision(snapshot,feedback.trim())}>退回补充</button>
          <button className="primary" disabled={busy||saving||stale||!scope.length} onClick={()=>onDecision(snapshot)}>按此方案执行</button></div></>:
          <button disabled={busy||stale} onClick={()=>onDecision(snapshot,'根据当前目标和既有资料重新进行只读分析，生成完整需求包。')}>重新分析并生成需求包</button>}
      </footer>
  </section>;
}
