import React,{useRef,useState} from 'react';
import type {EngineeringContext,EngineeringTask} from '../engineering';
import {analysisModes,type AnalysisMode} from './discovery-state';
import {useProjectEnvironment} from './project-environment-store';
import './task-boundaries.css';
import './requirement-composer.css';

type Boundaries=NonNullable<EngineeringTask['boundaries']>;
type BoundaryKind=keyof Boundaries;
const boundaryLabels={non_goals:'本轮不改',revoked:'已撤销红线'} as const;
const steps=['明确目标与边界','只读分析与确认方案','沙箱开发与真实验证','交付自检与资料联动'];
const starters=[
  ['新增功能','希望为谁新增什么功能？\n使用场景：\n预期结果：','新增功能的使用场景与预期结果：'],
  ['修复问题','遇到了什么问题？\n复现步骤：\n实际表现：\n预期表现：','问题的复现步骤、实际表现和预期表现：'],
  ['补齐测试','需要验证哪项行为？\n已有覆盖：\n待补场景：','需要补齐的测试场景与断言：'],
  ['重构优化','希望改善哪处实现？\n当前问题：\n需要保持的行为：','重构时需要保持的行为：'],
] as const;
const commandLabels=[['build','构建'],['test','测试'],['typecheck','类型检查']] as const;

interface ComposerProps {
  context:EngineeringContext|null;
  defaultEngine:AnalysisMode;
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

export function RequirementComposer({context,defaultEngine,onEngineChange,enginePending,onSettings,
  goal,onGoalChange,goalInput,disabled,busy,onSubmit,onCancel}:ComposerProps) {
  const {environment,error}=useProjectEnvironment(context?.workspace);
  const [boundaries,setBoundaries]=useState<Boundaries>({non_goals:[],revoked:[]});
  const [adding,setAdding]=useState(false),[kind,setKind]=useState<BoundaryKind>('non_goals');
  const [value,setValue]=useState(''),[boundaryError,setBoundaryError]=useState('');
  const addButton=useRef<HTMLButtonElement>(null);
  const commands=commandLabels.filter(([key])=>environment?.effective_commands[key]);
  const bound=context?.workspace.status==='bound';
  const activeStarter=starters.find(([,starter])=>goal===starter)?.[0];

  function closeEditor(){
    setAdding(false);setValue('');setBoundaryError('');
    requestAnimationFrame(()=>addButton.current?.focus());
  }
  function boundariesWithInput(){
    const text=value.trim();
    if(!text)return boundaries;
    if(boundaries[kind].includes(text)){setBoundaryError('这条边界已存在。');return;}
    if(boundaries[kind].length>=40){setBoundaryError('每组边界最多可保存 40 项。');return;}
    return {...boundaries,[kind]:[...boundaries[kind],text]};
  }
  function addBoundary(){
    const next=boundariesWithInput();
    if(next){setBoundaries(next);closeEditor();}
  }

  return <form className="requirement-composer" aria-labelledby="requirement-composer-title"
    onSubmit={e=>{
      e.preventDefault();
      if(disabled)return;
      const next=boundariesWithInput();
      if(next)onSubmit(next);
    }}>
    <header className="composer-heading">
      <h2 id="requirement-composer-title">新需求发起工作台</h2>
      <ol className="composer-steps" aria-label="需求开发流程">{steps.map((step,index)=>
        <li key={step} aria-current={index===0?'step':undefined}><b>{String(index+1).padStart(2,'0')}</b><span>{step}</span></li>
      )}</ol>
    </header>
    <div className="composer-body">
      <div className="composer-input-heading"><label htmlFor="development-goal">希望完成什么修改</label>
        <small><kbd>Ctrl + Enter</kbd> 提交</small></div>
      <textarea id="development-goal" aria-label="开发任务" ref={goalInput} value={goal} required disabled={busy}
        placeholder="描述当前行为、希望实现的修改，以及怎样判断已经完成。"
        onChange={e=>onGoalChange(e.target.value)} onKeyDown={e=>{
          if(e.ctrlKey&&e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();if(!disabled)e.currentTarget.form?.requestSubmit();}
        }}/>
      <div className="composer-starters" role="group" aria-label="需求起草模板">{starters.map(([label,starter,addition])=>
        <button type="button" key={label} disabled={busy} aria-pressed={activeStarter===label} onClick={()=>{
          if(!goal.trim())onGoalChange(starter);
          else if(activeStarter===label)onGoalChange('');
          else if(activeStarter)onGoalChange(starter);
          else if(!goal.includes(addition))onGoalChange(goal+(goal.endsWith('\n')?'':'\n')+addition);
          goalInput.current?.focus();
        }}>{label}</button>
      )}</div>
      <section className="task-boundaries composer-boundaries" aria-label="本轮边界与红线">
        <div className="boundary-heading"><h4>本轮边界与红线<small>（可选）</small></h4>
          {!adding&&<button type="button" className="boundary-add" ref={addButton} disabled={busy} onClick={()=>setAdding(true)}>+ 添加不改范围 / 红线</button>}</div>
        {(Object.keys(boundaryLabels) as BoundaryKind[]).map(key=>boundaries[key].length>0&&
          <div key={key} className="boundary-row"><span className="boundary-label">{boundaryLabels[key]}</span>
            <div className="boundary-values">{boundaries[key].map(item=>
              <span className={'boundary-chip boundary-'+key} key={item}><span>{item}</span>
                <button type="button" disabled={busy} aria-label={'移除'+boundaryLabels[key]+' · '+item} onClick={()=>
                  setBoundaries({...boundaries,[key]:boundaries[key].filter(entry=>entry!==item)})}>×</button></span>
            )}</div></div>)}
        {adding&&<div className="boundary-form" onKeyDown={e=>{
          if(e.key==='Escape'&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();closeEditor();}
        }}>
          <select aria-label="边界类型" value={kind} disabled={busy} onChange={e=>{setKind(e.target.value as BoundaryKind);setBoundaryError('');}}>
            <option value="non_goals">不改范围</option><option value="revoked">已撤销红线</option>
          </select>
          <input aria-label="边界内容" value={value} disabled={busy} maxLength={6000} autoFocus placeholder={'输入'+boundaryLabels[kind]+'内容'}
            onChange={e=>{setValue(e.target.value);setBoundaryError('');}} onKeyDown={e=>{
              if(e.key==='Enter'){e.preventDefault();if(!e.nativeEvent.isComposing)addBoundary();}
            }}/>
          <button type="button" disabled={busy||!value.trim()} onClick={addBoundary}>添加</button>
          <button type="button" aria-label="关闭边界输入" disabled={busy} onClick={closeEditor}>收起</button>
        </div>}
        {boundaryError&&<p role="alert">{boundaryError}</p>}
      </section>
      <section className="composer-context" aria-labelledby="composer-context-title">
        <h3 id="composer-context-title">本轮自动注入给 Agent</h3>
        <dl><dt>执行引擎</dt><dd>
          <span className="composer-engines" role="group" aria-label="执行引擎">{(['codex','dsh'] as const).map(mode=>
            <button key={mode} type="button" disabled={enginePending||busy} aria-pressed={defaultEngine===mode} onClick={()=>onEngineChange(mode)}>{analysisModes[mode].name}</button>
          )}</span>
          {(defaultEngine==='codex_desktop'||defaultEngine==='mcp')&&<span className="composer-engine-current">{analysisModes[defaultEngine].name}</span>}
          <button type="button" className="composer-settings" onClick={onSettings}>连接设置</button>
        </dd><dt>已实测有效命令</dt><dd>
          {error?<span role="alert" className="warning">{error}</span>:context&&!bound?'绑定工作区后读取':!environment?<span>正在读取命令…</span>:
            commands.length?commands.map(([key,label])=><span className="composer-command" key={key}><span>{label}</span><code>{environment.effective_commands[key]}</code></span>):'未配置有效命令'}
        </dd><dt>工作区与资料</dt><dd>
          <span className={'composer-binding'+(bound?' is-bound':'')}>{context?(bound?'工作区已绑定':'工作区未绑定'):'正在读取工作区…'}</span>
          {context&&<span>工程资料 v{context.version}</span>}
        </dd></dl>
        <p>Code Agent 专注改代码与真验证，无需在仓库生成文档套件</p>
      </section>
    </div>
    <div className="composer-footer"><small>先只读分析源码并生成需求包，经你确认范围后再修改文件</small>
      <div>{onCancel&&<button type="button" className="composer-cancel" disabled={busy} onClick={onCancel}>取消</button>}
        <button type="submit" className="primary" disabled={disabled}>{busy?'正在提交…':'开始只读分析并生成需求包'}</button></div>
    </div>
  </form>;
}
