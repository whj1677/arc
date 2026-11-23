import React,{useEffect,useState} from 'react';
import type {Project,Scenario,AnalysisResult,ReadingTarget} from '../shared';
import type {EngineeringTask,TaskReadingBinding} from '../engineering';
import {analysisModes,type AnalysisMode} from './discovery-state';
import type {RequirementReadingDraft} from './RequirementComposer';

const developmentStates:Record<EngineeringTask['status'],string>={pending:'待执行',running:'开发执行中',blocked:'开发需要处理',completed:'开发结果已保存',failed:'开发失败，成果已保留',cancelled:'开发已取消，成果已保留',interrupted:'开发中断，成果已保留'};
const analysisStates:Record<EngineeringTask['status'],string>={pending:'等待开始',running:'分析中',blocked:'需要处理',completed:'已保存',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
const walkthroughStates={pending:'等待更新功能走读',running:'正在按新代码更新功能走读',completed:'新版功能走读已保存',failed:'功能走读更新失败'};

export interface FeatureDevelopmentDraft {editing:boolean;request:string}
type Props={
  project:Project;scenario:Scenario;result:AnalysisResult;target:ReadingTarget;evidence?:TaskReadingBinding['evidence'];task?:EngineeringTask;
  defaultEngine:AnalysisMode;draft:FeatureDevelopmentDraft;onDraft:(patch:Partial<FeatureDevelopmentDraft>)=>void;
  reload:()=>Promise<unknown>;onViewResult:(resultId:string)=>void;onOpenTask:(taskId:string)=>void;
  onOpenComposer?:(draft:RequirementReadingDraft)=>void;
};

/** A small in-place action over the existing reading and development channels. */
export function FeatureDevelopment({project,scenario,result,target,evidence,task,defaultEngine,draft,onDraft,reload,onViewResult,onOpenTask,onOpenComposer}:Props){
  const api=window.arc;
  const {editing,request}=draft,setEditing=(value:boolean)=>onDraft({editing:value}),setRequest=(value:string)=>onDraft({request:value});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[currentTask,setCurrentTask]=useState(task);
  useEffect(()=>{setError('');setNotice('');},[scenario.scenario_id,task?.task_id]);
  useEffect(()=>{let active=true;setCurrentTask(task);if(!task)return;const read=async()=>{try{const value=await api.invoke<EngineeringTask>('engineering_task',{task_id:task.task_id});if(active)setCurrentTask(value);}catch(e){if(active)setError((e as Error).message);}};void read();const timer=setInterval(()=>void read(),5000);return()=>{active=false;clearInterval(timer);};},[task?.task_id,task?.updated_at]);
  const activeTask=currentTask?.task_id===task?.task_id?currentTask:task;
  const running=activeTask?.status==='running',walkthrough=activeTask?.walkthrough,verificationStatus=activeTask?.verification_status;
  const source=task?task.reading?.evidence:evidence;
  async function submit(event:React.FormEvent){
    event.preventDefault();if(busy||running||!request.trim())return;
    setBusy(true);setError('');setNotice('');
    try{
      const saved=await api.invoke<EngineeringTask>('development_start',{project_id:project.project_id,task_id:task?.task_id,expected_version:activeTask?.version,goal:request,phase:'analysis',submission_key:crypto.randomUUID(),reading:task?.reading??{feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,result_id:result.result_id,source_snapshot_id:result.binding.source_snapshot_id,target,...(source?{evidence:source}:{})}});
      onDraft({request:'',editing:false});setNotice(saved.execution_mode==='mcp'?'需求已保存，等待外部 Agent 领取。':'需求与功能关联已保存，正在准备只读分析。');await reload();onOpenTask(saved.task_id);return saved;
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function retry(){
    if(!task||busy)return;setBusy(true);setError('');
    try{await api.invoke('walkthrough_retry',{task_id:task.task_id,submission_key:crypto.randomUUID()});await reload();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  if(!task&&!editing&&!notice&&!error)return null;
  return <section className="feature-development compact" aria-label="围绕当前位置修改">
    {activeTask&&<div className="feature-task-status"><strong>{activeTask.workflow==='ready'?'需求包待审阅':activeTask.workflow==='analysis'?`需求分析 · ${analysisStates[activeTask.status]}`:developmentStates[activeTask.status]}</strong><span>验证：{verificationStatus==='passed'?'通过':verificationStatus==='failed'?'失败':verificationStatus==='stale'?'代码已变化，需复验':verificationStatus==='partial'?'部分完成':'未执行'}</span>{walkthrough&&<span className={walkthrough.status==='failed'?'warning':''}>{walkthroughStates[walkthrough.status]}</span>}<button className="quiet" onClick={()=>onOpenTask(activeTask.task_id)}>查看任务与验证</button>{!editing&&<button className="quiet" disabled={busy||running||project.fictional} onClick={()=>setEditing(true)}>续接任务</button>}</div>}
    {task&&editing&&<details className="feature-task-origin"><summary>原任务与后续要求</summary><p>{task.goal}</p>{task.requests?.map((item,index)=><p key={item.submission_key}>补充 {index+1}：{item.text}</p>)}<small>任务 {task.task_id} · 新会话可凭此 ID 读取完整记录。</small></details>}
    {walkthrough?.status==='completed'&&walkthrough.result_id&&<div className="row">{walkthrough.result_id===result.result_id?<span className="tag feature-current-version" role="status">当前已是新版走读</span>:<button className="primary" onClick={()=>onViewResult(walkthrough.result_id!)}>查看同一功能的新版走读</button>}</div>}
    {walkthrough?.status==='pending'&&!running&&<div className="row"><button disabled={busy} onClick={()=>void retry()}>继续走读更新</button></div>}
    {walkthrough?.status==='failed'&&<div className="feature-refresh-error"><p className="warning">{walkthrough.error||'分析未完成'}。旧说明仍绑定其原始来源，开发结果没有回滚。</p><button disabled={busy||running} onClick={()=>void retry()}>重试功能走读更新</button></div>}
    {editing&&<form onSubmit={submit}>{source&&<small aria-label="本任务关联源码">关联源码 · {source.path}:{source.line_start}–{source.line_end}</small>}<label>{task?'追加到原任务的修改要求':'希望怎样修改这里'}<textarea aria-label="围绕这里修改的要求" autoFocus required maxLength={20000} placeholder="直接描述需要改变和必须保持不变的行为。" value={request} onChange={e=>setRequest(e.target.value)}/></label><small>{analysisModes[activeTask?.execution_mode??defaultEngine].name} 负责只读分析。你可以在同一任务审阅需求包、调整范围并确认执行。</small><div className="row"><button className="primary" disabled={busy||running||project.fictional||!request.trim()}>{busy?'保存中…':'分析影响与待决问题'}</button>{!task&&onOpenComposer&&<button type="button" disabled={busy||project.fictional} onClick={()=>{onDraft({editing:false});onOpenComposer({label:scenario.title,reading:{feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,result_id:result.result_id,source_snapshot_id:result.binding.source_snapshot_id,target,...(source?{evidence:source}:{})},initialGoal:request.trim()||undefined});}}>带入完整需求页 →</button>}<button type="button" onClick={()=>setEditing(false)}>取消</button></div></form>}
    {notice&&<p role="status">{notice}</p>}{error&&<p className="warning" role="alert">{error}</p>}
  </section>;
}
