import React,{useEffect,useState} from 'react';
import type {Project,Scenario,AnalysisResult,ReadingTarget} from '../shared';
import type {EngineeringTask} from '../engineering';

const api=window.arc;
const developmentStates:Record<EngineeringTask['status'],string>={pending:'待执行',running:'开发执行中',blocked:'开发需要处理',completed:'开发结果已保存',failed:'开发失败，成果已保留',cancelled:'开发已取消，成果已保留',interrupted:'开发中断，成果已保留'};
const walkthroughStates={pending:'等待更新功能走读',running:'正在按新代码更新功能走读',completed:'新版功能走读已保存',failed:'功能走读更新失败'};

export interface FeatureDevelopmentDraft {editing:boolean;request:string;scope:string;mode:'codex'|'kimi'}
type Props={
  project:Project;scenario:Scenario;result:AnalysisResult;target:ReadingTarget;task?:EngineeringTask;suggestedFile:string;
  draft:FeatureDevelopmentDraft;onDraft:(patch:Partial<FeatureDevelopmentDraft>)=>void;
  reload:()=>Promise<unknown>;onViewResult:(resultId:string)=>void;onOpenTask:(taskId:string)=>void;
};

/** A small in-place action over the existing reading and development channels. */
export function FeatureDevelopment({project,scenario,result,target,task,draft,onDraft,reload,onViewResult,onOpenTask}:Props){
  const {editing,request,scope,mode}=draft,setEditing=(value:boolean)=>onDraft({editing:value}),setRequest=(value:string)=>onDraft({request:value}),setScope=(value:string)=>onDraft({scope:value}),setMode=(value:'codex'|'kimi')=>onDraft({mode:value});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[currentTask,setCurrentTask]=useState(task);
  useEffect(()=>{setError('');setNotice('');},[scenario.scenario_id,task?.task_id]);
  useEffect(()=>{let active=true;setCurrentTask(task);if(!task)return;const read=async()=>{try{const value=await api.invoke<EngineeringTask>('engineering_task',{task_id:task.task_id});if(active)setCurrentTask(value);}catch(e){if(active)setError((e as Error).message);}};void read();const timer=setInterval(()=>void read(),5000);return()=>{active=false;clearInterval(timer);};},[task?.task_id,task?.updated_at]);
  const running=task?.status==='running',walkthrough=task?.walkthrough,verificationStatus=currentTask?.verification_status??task?.verification_status;
  async function submit(event:React.FormEvent){
    event.preventDefault();if(busy||running||!request.trim())return;
    const files=scope.split(/\r?\n/).map(file=>file.trim()).filter(Boolean);if(!files.length){setError('请明确填写本次允许修改的现有文件；选中位置不会自动扩大写入权限。');return;}
    setBusy(true);setError('');setNotice('');
    try{
      const saved=await api.invoke<EngineeringTask>(mode==='kimi'?'development_begin_kimi':'development_start',{project_id:project.project_id,task_id:task?.task_id,goal:request,scope:files,submission_key:crypto.randomUUID(),reading:task?.reading??{feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,result_id:result.result_id,source_snapshot_id:result.binding.source_snapshot_id,target}});
      setRequest('');setEditing(false);setNotice(mode==='kimi'?'任务和关联已保存；请在 Kimi 会话中凭任务 ID 接续，ARC 不会自动唤醒对话。':task?'已在原任务追加要求并开始执行。':'已保存原要求和功能关联，开始执行。');await reload();return saved;
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function retry(){
    if(!task||busy)return;setBusy(true);setError('');
    try{await api.invoke('walkthrough_retry',{task_id:task.task_id,submission_key:crypto.randomUUID()});await reload();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="feature-development" aria-label="围绕当前位置修改">
    <div className="row between"><div><span className="eyebrow">从理解进入修改</span><h3>围绕这里修改</h3></div><button className="secondary" disabled={busy||running||project.fictional} onClick={()=>{setEditing(!editing);setError('');}}>{editing?'收起':task?'续接此功能任务':'围绕这里修改'}</button></div>
    {!task&&!editing&&<p>保留当前功能、走读版本、源码快照和选中位置；只需描述希望改变的行为。</p>}
    {task&&<div className="feature-task-status" role="status"><strong>{developmentStates[task.status]}</strong><span>验证：{verificationStatus==='passed'?'通过':verificationStatus==='failed'?'失败':verificationStatus==='stale'?'代码已变化，需复验':verificationStatus==='partial'?'部分完成':'未执行'}</span>{walkthrough&&<span className={walkthrough.status==='failed'?'warning':''}>{walkthroughStates[walkthrough.status]}</span>}<button className="quiet" onClick={()=>onOpenTask(task.task_id)}>任务与验证</button></div>}
    {task&&<details className="feature-task-origin"><summary>原任务与后续要求</summary><p>{task.goal}</p>{task.requests?.map((item,index)=><p key={item.submission_key}>补充 {index+1}：{item.text}</p>)}<small>任务 {task.task_id} · 新会话可凭此 ID 读取完整记录。</small></details>}
    {walkthrough?.status==='completed'&&walkthrough.result_id&&<div className="row">{walkthrough.result_id===result.result_id?<span className="tag feature-current-version" role="status">当前已是新版走读</span>:<button className="primary" onClick={()=>onViewResult(walkthrough.result_id!)}>查看同一功能的新版走读</button>}</div>}
    {walkthrough?.status==='failed'&&<div className="feature-refresh-error"><p className="warning">{walkthrough.error||'分析未完成'}。旧说明仍绑定其原始来源，开发结果没有回滚。</p><button disabled={busy||running} onClick={()=>void retry()}>重试功能走读更新</button></div>}
    {editing&&<form onSubmit={submit}><label>{task?'追加到原任务的修改要求':'希望怎样修改这里'}<textarea aria-label="围绕这里修改的要求" required maxLength={20000} placeholder="直接描述需要改变和必须保持不变的行为。" value={request} onChange={e=>setRequest(e.target.value)}/></label><label>开发执行通道<select aria-label="开发执行通道" value={mode} onChange={e=>setMode(e.target.value as 'codex'|'kimi')}><option value="codex">Codex · ARC 内文件沙箱</option><option value="kimi">Kimi · 通过 ARC MCP 会话接续</option></select></label><label>本次允许修改的现有文件<textarea aria-label="本次允许修改的文件" required rows={2} placeholder="每行一个工程相对路径" value={scope} onChange={e=>setScope(e.target.value)}/></label><small>{mode==='kimi'?'文件范围随任务保存；Kimi 的实际读写权限由其宿主控制，ARC 不自动扩大授权。':'每次执行都需确认写入范围；分析范围仍按源码判断，不限于选中节点的下游。'}</small><div className="row"><button className="primary" disabled={busy||!request.trim()||!scope.trim()}>{busy?'保存中…':mode==='kimi'?(task?'续接原任务并等待 Kimi':'保存并等待 Kimi 接续'):(task?'续接原任务并开发':'保存任务并开发')}</button><button type="button" onClick={()=>setEditing(false)}>取消</button></div></form>}
    {notice&&<p role="status">{notice}</p>}{error&&<p className="warning" role="alert">{error}</p>}
  </section>;
}
