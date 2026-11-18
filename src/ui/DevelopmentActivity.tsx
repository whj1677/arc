import React,{useEffect,useRef,useState,type ReactNode} from 'react';
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
export function PlanDecision({children}:{children:ReactNode}){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  return <div className="plan-decision"><button type="button" onClick={()=>dialog.current?.showModal()}>审阅待确认方案</button>
    <dialog ref={dialog} aria-label="确认开发方案"><header><h3>确认开发方案</h3><button type="button" onClick={()=>dialog.current?.close()}>稍后处理</button></header>{children}</dialog>
  </div>;
}
