import React,{useRef,useState} from 'react';
import type {EngineeringTask} from '../engineering';
import {effectiveTaskBoundaries,taskBoundaryKey} from '../task-boundaries';
import './task-boundaries.css';

const labels={non_goals:'本轮不改',revoked:'已撤销红线'} as const;
type BoundaryKind=keyof typeof labels;
type Boundaries=NonNullable<EngineeringTask['boundaries']>;

export function TaskBoundaries({task,title='当前边界与红线',readOnly=false,disabled=false,onSaved,onSavingChange}:{
  task:EngineeringTask;title?:string;readOnly?:boolean;disabled?:boolean;
  onSaved?:(task:EngineeringTask)=>void;onSavingChange?:(saving:boolean)=>void;
}) {
  const [saved,setSaved]=useState<EngineeringTask|null>(null);
  const [adding,setAdding]=useState(false),[kind,setKind]=useState<BoundaryKind>('non_goals');
  const [value,setValue]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const addButton=useRef<HTMLButtonElement>(null);
  const current=!readOnly&&saved?.task_id===task.task_id&&saved.version>task.version?saved:task;
  const boundaries=effectiveTaskBoundaries(current);
  const mode=current.execution_mode??current.analysis_channel;
  const frozenRun=mode==='dsh'||mode==='codex'&&current.workflow==='analysis';

  async function save(next:Boundaries) {
    setSaving(true);onSavingChange?.(true);setError('');
    try{
      const updated=await window.arc.invoke<EngineeringTask>('engineering_task_boundaries',{
        task_id:task.task_id,expected_version:current.version,...next,
      });
      setSaved(updated);onSaved?.(updated);
      return true;
    } catch(e) {setError((e as Error).message);return false;}
    finally {setSaving(false);onSavingChange?.(false);}
  }
  function closeEditor() {
    setAdding(false);setValue('');setError('');
    requestAnimationFrame(()=>addButton.current?.focus());
  }
  async function add() {
    const text=value.trim();
    if(!text)return;
    const key=taskBoundaryKey(text);
    if(boundaries[kind].some(item=>taskBoundaryKey(item)===key)){setError('这条边界已存在。');return;}
    if(await save({...boundaries,[kind]:[...boundaries[kind],text]}))closeEditor();
  }
  const locked=saving||disabled;
  return <section className="task-boundaries" aria-label={title}>
    <div className="boundary-heading"><h4>{title}</h4>{!readOnly&&!adding&&
      <button className="boundary-add" type="button" disabled={locked} ref={addButton} onClick={()=>setAdding(true)}>+ 添加</button>}</div>
    {(Object.keys(labels) as BoundaryKind[]).map(key=><div key={key} className="boundary-row">
      <span className="boundary-label">{labels[key]}</span><div className="boundary-values">
        {boundaries[key].length?boundaries[key].map(item=><span key={item} className={'boundary-chip boundary-'+key}>
          <span>{item}</span>{!readOnly&&<button type="button" aria-label={'移除'+labels[key]+' · '+item} disabled={locked}
            onClick={()=>void save({...boundaries,[key]:boundaries[key].filter(entry=>entry!==item)})}>×</button>}
        </span>):<span className="boundary-empty">暂无</span>}
      </div></div>)}
    {!readOnly&&adding&&<form className="boundary-form" onSubmit={event=>{event.preventDefault();void add();}}>
      <select aria-label="边界类型" disabled={locked} value={kind} onChange={event=>setKind(event.target.value as BoundaryKind)}>
        <option value="non_goals">不改范围</option><option value="revoked">已撤销红线</option>
      </select>
      <input aria-label="边界内容" autoFocus maxLength={6000} value={value} placeholder={'输入'+labels[kind]+'内容'} disabled={locked}
        onChange={event=>setValue(event.target.value)} onKeyDown={event=>{
          if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeEditor();}
        }}/>
      <button type="submit" disabled={locked||!value.trim()}>添加</button><button type="button" disabled={locked} onClick={closeEditor}>取消</button>
    </form>}
    {!readOnly&&current.status==='running'&&<small className="boundary-empty">
      {frozenRun?'本次执行已锁定任务版本。现在修改边界会使本轮结果失效，需按新版重新派发。':'执行已启动，新边界用于交付核对和下次派发。'}
    </small>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
