import React,{useEffect,useRef,useState} from 'react';
import type {DevelopmentAttempt,EngineeringTask} from '../engineering';
import type {Dispatch} from '../main/external-dispatch';

export type ActivityEvent={attempt_id:string;received_at:string;type:string;message?:string;item?:{type:string;text?:string;command?:string;aggregated_output?:string;exit_code?:number}};
const receiptNames:Record<Dispatch['state'],string>={queued:'已排队，等待发送',sending:'正在发送',awaiting_claim:'已发送，等待 Agent 领取',running:'Agent 已领取',completed:'回填完成',blocked:'派发受阻',unknown:'派发状态待核对',cancelled:'派发已取消'};
const executionNames:Record<DevelopmentAttempt['status'],string>={starting:'准备执行',running:'执行中',completed:'执行结束',failed:'执行失败',cancelled:'已取消',interrupted:'执行中断'};

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
  const message=dispatch?.error||attempt?.error||(backfilled?task.summary:'')||(stepIsLatest?step.progress:latest?.text)||'尚未收到本轮的公开输出。';
  return <section className="development-activity" aria-label="执行动态">
    <div className="development-activity-heading"><button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>执行动态 {expanded?'▴':'▾'}</button>
      <span role="status">{receipt}{task.workflow==='ready'?' · 方案待确认':''}</span>
      {at&&<time dateTime={at} title={new Date(at).toLocaleString()}>最近记录 {new Date(at).toLocaleTimeString()}</time>}
    </div>
    {expanded&&<div className="development-activity-body"><p>{message.length>240?message.slice(0,240)+'…':message}</p>
      {!!lines.length&&<details><summary>查看已收到的输出 · {lines.length} 条</summary><ol>{lines.map((line,i)=><li key={i}><time>{new Date(line.at).toLocaleTimeString()}</time><pre>{line.text}</pre></li>)}</ol></details>}
      {dispatch&&['blocked','unknown'].includes(dispatch.state)&&<button onClick={onSettings}>核对连接与派发</button>}
    </div>}
  </section>;
}
function RequirementPackage({task,record=task}:{task:EngineeringTask;record?:EngineeringTask}){
  const pkg=task.requirement_package;
  if(!pkg)return <p>此版本没有正式需求包。</p>;
  const scope=record.approval?.scope??task.proposed_scope??task.scope;
  const outcomeLabels={passed:'通过',failed:'失败',blocked:'受阻',not_run:'未执行'};
  return <section aria-label="正式需求包" className="requirement-package">
    <h3>正式需求包 · v{task.version}</h3><h4>需求目标</h4><p>{task.goal}</p>
    {task.requests?.some(request=>request.text!==task.goal)&&<><h4>接续要求</h4><ul>{task.requests.filter(request=>request.text!==task.goal).map(request=><li key={request.submission_key}>{request.text}</li>)}</ul></>}
    {task.summary&&<><h4>任务摘要</h4><p>{task.summary}</p></>}
    <h4>行为与实现</h4>{pkg.behaviors.map(behavior=><article key={behavior.id} className="requirement-behavior">
      <strong>{behavior.behavior}</strong><p>{behavior.design}</p>
      <dl><dt>涉及文件</dt><dd>{behavior.files.map(file=><code key={file}>{file}</code>)}</dd>
      <dt>验证方法</dt><dd>{behavior.verification}</dd></dl>
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
            {outcomeLabels[item.outcome]} · {item.origin==='observed'?'实际执行':'Agent 上报'} · <code>{item.command}</code>{item.criterion_id&&' · '+(step.criteria.find(c=>c.criterion_id===item.criterion_id)?.text??item.criterion_id)}
          </li>)}</ul></>:<small>尚无关联验证记录</small>}
        </div>;
      })}
    </article>)}
    {task.decisions.length>0&&<><h4>已记录的决定</h4><ul>{task.decisions.map((item,i)=><li key={i}>{item}</li>)}</ul></>}
    {task.unresolved.length>0&&<><h4>待解决事项</h4><ul>{task.unresolved.map((item,i)=><li key={i}>{item}</li>)}</ul></>}
    <h4>{record.approval?'已批准范围':'建议修改范围'}</h4><ul>{scope.map(file=><li key={file}><code>{file}</code></li>)}</ul>
  </section>;
}

export function SavedRequirementPackage({task}:{task:EngineeringTask}){
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
    {open&&(snapshot?<RequirementPackage task={snapshot} record={task}/>:<p role={error?'alert':'status'}>{error||'正在读取已批准的版本…'}</p>)}
  </details>;
}

export function PlanDecision({task,busy,error,onDecision}:{task:EngineeringTask;busy:boolean;error:string;onDecision:(snapshot:EngineeringTask,revision?:string)=>void}){
  const [snapshot,setSnapshot]=useState(task),[feedback,setFeedback]=useState('');
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  const stale=snapshot.version!==task.version;
  const scope=snapshot.proposed_scope??snapshot.scope;
  const refresh=()=>{setSnapshot(task);setFeedback('');};
  return <div className="plan-decision"><button type="button" onClick={()=>{refresh();dialog.current?.showModal();}}>审阅待确认方案</button>
    <dialog ref={dialog} aria-label="确认开发方案"><header><h3>确认开发方案</h3><button type="button" onClick={()=>dialog.current?.close()}>稍后处理</button></header>
      <div className="engineering-approval"><RequirementPackage task={snapshot}/>
        {stale&&<div role="alert">任务已更新至 v{task.version}，当前展示 v{snapshot.version}。<button disabled={busy} onClick={refresh}>查看最新版本</button></div>}
        {error&&<p role="alert">{error}</p>}
        {snapshot.requirement_package?<><label>修订意见<textarea aria-label="修订意见" placeholder="说明要补充的行为、验证方法或需要调整的文件范围" rows={2} value={feedback} onChange={event=>setFeedback(event.target.value)}/></label>
          <div className="row"><button disabled={busy||stale||!feedback.trim()} onClick={()=>onDecision(snapshot,feedback.trim())}>退回补充</button>
          <button className="primary" disabled={busy||stale||!scope.length} onClick={()=>onDecision(snapshot)}>按此方案执行</button></div></>:
          <button disabled={busy||stale} onClick={()=>onDecision(snapshot,'根据当前目标和既有资料重新进行只读分析，生成完整需求包。')}>重新分析并生成需求包</button>}
      </div>
    </dialog>
  </div>;
}
