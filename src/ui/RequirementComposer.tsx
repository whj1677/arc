import React,{useEffect,useRef,useState} from 'react';
import type {EngineeringContext,EngineeringTask,GoalRefinement} from '../engineering';
import {normalizeBoundaryText} from '../task-boundaries';
import {analysisModes,type AnalysisMode} from './discovery-state';
import {CodexModelSelect,type CodexModelSelection} from './CodexModelSelect';
import {useProjectEnvironment} from './project-environment-store';
import './requirement-composer.css';

type Boundaries=NonNullable<EngineeringTask['boundaries']>;
const suggestedScopes=['不改公开接口签名','不改构建与发布脚本','不引入新外部依赖'];
const phases=['① 写目标与边界','② 只读出方案','③ 确认后开发','④ 自检交付'];
const starters=[
  ['新增功能','希望为谁新增什么功能？\n使用场景：\n预期结果：','新增功能的使用场景与预期结果：'],
  ['修复问题','遇到了什么问题？\n复现步骤：\n实际表现：\n预期表现：','问题的复现步骤、实际表现和预期表现：'],
  ['补齐测试','需要验证哪项行为？\n已有覆盖：\n待补场景：','需要补齐的测试场景与断言：'],
  ['重构优化','希望改善哪处实现？\n当前问题：\n需要保持的行为：','重构时需要保持的行为：'],
] as const;
const commandLabels=[['build','构建'],['test','测试'],['typecheck','类型检查']] as const;

interface ComposerProps {
  projectId:string;
  disabledProject:boolean;
  context:EngineeringContext|null;
  defaultEngine:AnalysisMode;
  codexModel:CodexModelSelection;
  onEngineChange:(mode:AnalysisMode)=>void;
  enginePending:boolean;
  onSettings:()=>void;
  goal:string;
  onGoalChange:(value:string)=>void;
  goalInput:React.RefObject<HTMLTextAreaElement|null>;
  disabled:boolean;
  busy:boolean;
  onSubmit:(boundaries:Boundaries)=>void;
  onCancel?:()=>void;
}

export function RequirementComposer({projectId,disabledProject,context,defaultEngine,codexModel,onEngineChange,enginePending,onSettings,
  goal,onGoalChange,goalInput,disabled,busy,onSubmit,onCancel}:ComposerProps) {
  const {environment,error}=useProjectEnvironment(context?.workspace);
  const [nonGoals,setNonGoals]=useState<string[]>([]);
  const [adding,setAdding]=useState(false);
  const [value,setValue]=useState(''),[boundaryError,setBoundaryError]=useState('');
  const [refinement,setRefinement]=useState<GoalRefinement|null>(null);
  const [originalGoal,setOriginalGoal]=useState<string|null>(null);
  const [refining,setRefining]=useState(false),[refineError,setRefineError]=useState('');
  const requestSequence=useRef(0);
  const addButton=useRef<HTMLButtonElement>(null);
  const commands=commandLabels.filter(([key])=>environment?.effective_commands[key]);
  const bound=context?.workspace.status==='bound';
  const activeStarter=starters.find(([,starter])=>goal===starter)?.[0];
  const scopeKeys=new Set(nonGoals.map(normalizeBoundaryText));

  useEffect(()=>{
    setRefinement(null);setRefineError('');setRefining(false);
    if(!goal.trim())setOriginalGoal(null);
    return ()=>{requestSequence.current++;};
  },[projectId,goal]);

  async function refineGoal(){
    const sequence=++requestSequence.current;
    setRefining(true);setRefineError('');setRefinement(null);
    try{
      const result=await window.arc.invoke<GoalRefinement>('development_refine_goal',{
        project_id:projectId,goal,non_goals:nonGoals,engine:defaultEngine==='dsh'?'dsh':'codex',
      });
      if(sequence===requestSequence.current)setRefinement(result);
    }catch(error){
      if(sequence===requestSequence.current)setRefineError((error as Error).message);
    }finally{
      if(sequence===requestSequence.current)setRefining(false);
    }
  }

  function closeEditor(){
    setAdding(false);setValue('');setBoundaryError('');
    requestAnimationFrame(()=>addButton.current?.focus());
  }
  function withScope(text:string){
    if(!text)return nonGoals;
    if(scopeKeys.has(normalizeBoundaryText(text))){setBoundaryError('这条范围已添加。');return;}
    if(nonGoals.length>=40){setBoundaryError('最多可添加 40 项不改范围。');return;}
    return [...nonGoals,text];
  }
  function addCustomScope(){
    const next=withScope(value.trim());
    if(next){setNonGoals(next);closeEditor();}
  }
  function toggleScope(text:string){
    setBoundaryError('');
    const key=normalizeBoundaryText(text);
    const next=scopeKeys.has(key)?nonGoals.filter(item=>normalizeBoundaryText(item)!==key):withScope(text);
    if(next)setNonGoals(next);
  }

  return <form className="requirement-composer" aria-labelledby="requirement-composer-title"
    onSubmit={e=>{
      e.preventDefault();
      if(disabled)return;
      const next=withScope(value.trim());
      if(next){
        requestSequence.current++;setRefining(false);setRefineError('');setRefinement(null);
        onSubmit({non_goals:next,revoked:[]});
      }
    }}>
    <header className="composer-heading">
      <h2 id="requirement-composer-title">发起新需求</h2>
      <ol className="composer-phases" aria-label="需求开发流程">{phases.map((phase,index)=>
        <li key={phase} aria-current={index===0?'step':undefined}>{index>0&&<span aria-hidden="true">→ </span>}{phase}</li>
      )}</ol>
    </header>
    <div className="composer-body">
      <label className="composer-goal-label" htmlFor="development-goal">希望完成什么修改</label>
      <textarea id="development-goal" aria-label="开发任务" ref={goalInput} value={goal} required disabled={busy}
        placeholder="描述当前行为、希望实现的修改，以及怎样判断已经完成。"
        onChange={e=>onGoalChange(e.target.value)} onKeyDown={e=>{
          if(e.ctrlKey&&e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();if(!disabled)e.currentTarget.form?.requestSubmit();}
        }}/>
      <div className="composer-starters" role="group" aria-label="需求起草工具">{starters.map(([label,starter,addition])=>
        <button type="button" key={label} disabled={busy} aria-pressed={activeStarter===label} onClick={()=>{
          if(!goal.trim())onGoalChange(starter);
          else if(activeStarter===label)onGoalChange('');
          else if(activeStarter)onGoalChange(starter);
          else if(!goal.includes(addition))onGoalChange(goal+(goal.endsWith('\n')?'':'\n')+addition);
          goalInput.current?.focus();
        }}>{label}</button>
      )}
        <div className="composer-refine-actions">
          {originalGoal!==null&&<button className="composer-link" type="button" disabled={busy} onClick={()=>{
            onGoalChange(originalGoal);setOriginalGoal(null);goalInput.current?.focus();
          }}>恢复原文</button>}
          <button className="composer-refine-button" type="button" disabled={!goal.trim()||busy||refining||disabledProject}
            onClick={()=>void refineGoal()}>{refining?'优化中…':'优化提示词'}</button>
        </div>
      </div>
      {refineError&&<p className="composer-refine-error" role="alert">{refineError}</p>}
      {refinement&&<section className="composer-refinement" aria-labelledby="refinement-title">
        <header className="refinement-header">
          <h3 id="refinement-title">优化建议</h3>
          <small>{refinement.engine==='dsh'?'DSH':'Codex'} · {(refinement.duration_ms/1000).toFixed(1)}s</small>
          <button type="button" className="composer-link" onClick={()=>setRefinement(null)}>收起</button>
          <button type="button" className="primary" disabled={busy} onClick={()=>{
            setOriginalGoal(goal);onGoalChange(refinement.refined_goal);setRefinement(null);goalInput.current?.focus();
          }}>采用到输入框</button>
        </header>
        <p className="refinement-text">{refinement.refined_goal}</p>
        {refinement.suggested_non_goals.length>0&&<div className="refinement-scopes" role="group" aria-label="推荐不改范围">
          <span>推荐不改范围</span>
          {refinement.suggested_non_goals.map(item=>{
            const selected=scopeKeys.has(normalizeBoundaryText(item));
            return <button type="button" key={item} disabled={busy} aria-pressed={selected} onClick={()=>toggleScope(item)}>
              {selected?'✓':'+'} {item}
            </button>;
          })}
        </div>}
        {refinement.clarifications.length>0&&<div className="refinement-clarifications">
          <span>建议顺手明确</span>
          <ul>{refinement.clarifications.map((item,index)=><li key={index}>{item}</li>)}</ul>
        </div>}
      </section>}
      <section className="composer-boundaries" aria-labelledby="composer-scopes">
        <h3 id="composer-scopes">本轮不改范围 <small>（可选，派活与交付自检自动守卫）</small></h3>
        <div className="composer-scope-options">
          {[...suggestedScopes,...nonGoals.filter(item=>!suggestedScopes.includes(normalizeBoundaryText(item)))].map(item=>
            <button type="button" className="composer-scope" key={item} disabled={busy}
              aria-pressed={scopeKeys.has(normalizeBoundaryText(item))} onClick={()=>toggleScope(item)}>{item}</button>
          )}
          {adding?<div className="composer-scope-editor" onKeyDown={e=>{
            if(e.key==='Escape'&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();closeEditor();}
          }}>
            <input aria-label="边界内容" value={value} disabled={busy} maxLength={6000} autoFocus
              placeholder="例如：不改 queue.h 公开签名、不动构建脚本"
              onChange={e=>{setValue(e.target.value);setBoundaryError('');}} onKeyDown={e=>{
                if(e.key==='Enter'){e.preventDefault();if(!e.nativeEvent.isComposing)addCustomScope();}
              }}/>
            <button type="button" disabled={busy||!value.trim()} onClick={addCustomScope}>添加</button>
            <button type="button" className="composer-link" aria-label="关闭边界输入" disabled={busy} onClick={closeEditor}>收起</button>
          </div>:<button type="button" className="composer-custom" ref={addButton} disabled={busy} onClick={()=>setAdding(true)}>+ 自定义范围</button>}
        </div>
        {boundaryError&&<p className="warning" role="alert">{boundaryError}</p>}
      </section>
      <section className="composer-exec-strip" aria-label="执行环境">
        <div className="composer-engine-controls">
          {defaultEngine==='codex_desktop'||defaultEngine==='mcp'?<span className="composer-engine-current">{analysisModes[defaultEngine].name}</span>:
          <span className="composer-engines" role="group" aria-label="执行引擎">{(['codex','dsh'] as const).map(mode=>
            <button key={mode} type="button" disabled={enginePending||busy} aria-pressed={defaultEngine===mode} onClick={()=>onEngineChange(mode)}>{analysisModes[mode].name}</button>
          )}</span>}
          {defaultEngine==='codex'&&<CodexModelSelect {...codexModel} label="本次 Codex 模型" disabled={enginePending||busy}/>}
          <button type="button" className="composer-link" onClick={onSettings}>连接设置</button>
        </div>
        <span className={'composer-binding'+(bound?' is-bound':'')}>{context?(bound?'工作区已绑定':'工作区未绑定'):'正在读取工作区…'}
          {context&&` · 资料 v${context.version}`}</span>
        <div className="composer-commands" aria-label="有效命令">
          {error?<span role="alert" className="warning">{error}</span>:context&&!bound?'绑定工作区后读取':!environment?<span>正在读取命令…</span>:
            commands.length?commands.map(([key,label])=><span className="composer-command" key={key} title={environment.effective_commands[key]}>
              {label}<code>{environment.effective_commands[key]}</code></span>):'未配置命令'}
        </div>
      </section>
    </div>
    <div className="composer-footer"><small>先只读分析生成需求包，经你确认范围后再改代码</small>
      <div>{onCancel&&<button type="button" className="composer-link" disabled={busy} onClick={onCancel}>取消</button>}
        <button type="submit" className="primary" aria-keyshortcuts="Control+Enter" disabled={disabled}>{busy?'正在提交…':'开始只读分析并生成需求包'}
          <kbd aria-hidden="true">Ctrl+Enter</kbd></button></div>
    </div>
  </form>;
}
