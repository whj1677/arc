import React,{useEffect,useMemo,useRef,useState} from 'react';
import {developmentFileError,type ContextEntry,type EngineeringContext,type EngineeringTask,type GoalRefinement,type TaskReadingBinding} from '../engineering';
import type {SourceFile} from '../shared';
import {normalizeBoundaryText} from '../task-boundaries';
import {analysisModes,type AnalysisMode} from './discovery-state';
import {CodexModelSelect,type CodexModelSelection} from './CodexModelSelect';
import {useProjectEnvironment} from './project-environment-store';
import './requirement-composer.css';

type Boundaries=NonNullable<EngineeringTask['boundaries']>;
export interface RequirementReadingDraft {
  label: string;
  stepTitle?: string;
  reading: TaskReadingBinding;
  initialGoal?: string;
}
export interface FeatureContextOption {
  scenarioId: string;
  label: string;
  reading: TaskReadingBinding;
}
export type RequirementSubmission=Boundaries & {fast_mode?:true;scope?:string[];reading?:TaskReadingBinding};
const suggestedScopes=['不改公开接口签名','不改构建与发布脚本','不引入新外部依赖'];
const fileSeparator=/[,，\n]/;
const starters=[
  ['新增功能','希望为谁新增什么功能？\n使用场景：\n预期结果：','新增功能的使用场景与预期结果：'],
  ['修复问题','遇到了什么问题？\n复现步骤：\n实际表现：\n预期表现：','问题的复现步骤、实际表现和预期表现：'],
  ['补齐测试','需要验证哪项行为？\n已有覆盖：\n待补场景：','需要补齐的测试场景与断言：'],
  ['重构优化','希望改善哪处实现？\n当前问题：\n需要保持的行为：','重构时需要保持的行为：'],
] as const;
const commandLabels=[['build','构建'],['test','测试'],['typecheck','类型检查']] as const;
const placeholderRulePattern=/尚待工程负责人确认|暂无具体约束|待工程负责人|通用说明/;

function extractRuleSummary(entry: ContextEntry): string {
  const rawKey=entry.key.replace(/^(?:entry|initial|document|rule|decision|interface):/,'').trim();
  const detailLine=entry.text
    .split(/\r?\n/)
    .map(line=>line.trim())
    .filter(line=>line.length>=4&&!/^#+\s/.test(line)&&!placeholderRulePattern.test(line))
    .map(line=>line.replace(/^[-*]\s*/,'').trim())
    .find(Boolean);
  if(rawKey&&detailLine&&detailLine!==rawKey){
    const merged=`${rawKey}：${detailLine}`;
    return merged.length>76?`${merged.slice(0,76)}…`:merged;
  }
  const single=detailLine||rawKey||'已记录项目约束';
  return single.length>76?`${single.slice(0,76)}…`:single;
}

interface ComposerProps {
  projectId:string;
  disabledProject:boolean;
  context:EngineeringContext|null;
  snapshotFiles?:SourceFile[];
  readingDraft?:RequirementReadingDraft|null;
  onClearReadingDraft?:()=>void;
  featureOptions?:FeatureContextOption[];
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
  onSubmit:(submission:RequirementSubmission)=>void;
  onCancel?:()=>void;
}

export function RequirementComposer({projectId,disabledProject,context,snapshotFiles,readingDraft,onClearReadingDraft,featureOptions,defaultEngine,codexModel,onEngineChange,enginePending,onSettings,
  goal,onGoalChange,goalInput,disabled,busy,onSubmit,onCancel}:ComposerProps) {
  const {environment,error}=useProjectEnvironment(context?.workspace);
  const [nonGoals,setNonGoals]=useState<string[]>([]);
  const [directEdit,setDirectEdit]=useState(false),[fileInput,setFileInput]=useState('');
  const [pickedFeatureId,setPickedFeatureId]=useState('');
  const [showConstraints,setShowConstraints]=useState(false);
  const fastMode=defaultEngine==='codex'&&directEdit;
  const fileParts=fileInput.split(fileSeparator);
  const parsedFiles=[...new Set(fileParts.map(part=>part.trim().replaceAll('\\','/')).filter(Boolean))];
  const fileError=parsedFiles.length>50?'每次最多指定 50 个文件。':parsedFiles.map(developmentFileError).find(Boolean);
  const submitDisabled=disabled||(fastMode&&(!parsedFiles.length||!!fileError));
  const query=fileParts.at(-1)!.trim().replaceAll('\\','/').toLowerCase();
  const suggestions=fastMode&&query?snapshotFiles?.filter(file=>file.path.toLowerCase().includes(query)&&!parsedFiles.includes(file.path)&&!developmentFileError(file.path)).slice(0,5):undefined;
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

  const pickedFeature=useMemo(
    ()=>featureOptions?.find(opt=>opt.scenarioId===pickedFeatureId),
    [featureOptions,pickedFeatureId],
  );
  const activeReading=readingDraft?.reading??pickedFeature?.reading;
  const activeFeatureLabel=readingDraft
    ? (readingDraft.stepTitle?`${readingDraft.label} · ${readingDraft.stepTitle}`:readingDraft.label)
    : pickedFeature?.label;
  const activeSourceLabel=activeReading?.evidence
    ? `${activeReading.evidence.path}:L${activeReading.evidence.line_start}–L${activeReading.evidence.line_end}`
    : undefined;

  const knownConstraints=useMemo(()=>{
    const entries=context?.entries??[];
    return entries
      .filter(e=>!e.task_id&&e.status!=='superseded'&&(e.category==='rule'||e.category==='decision'||e.category==='interface'))
      .filter(e=>e.origin==='user'||(!e.key.startsWith('initial:')&&!placeholderRulePattern.test(e.text)))
      .slice(0,8)
      .map(entry=>({id:entry.entry_id,category:entry.category==='rule'?'业务规则':entry.category==='interface'?'接口约定':'架构决定',summary:extractRuleSummary(entry)}));
  },[context?.entries]);

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

  const versionTag=[context?.code_state.branch,context?.code_state.head?.slice(0,7)].filter(Boolean).join(' @ ');

  return <form className="requirement-composer" aria-labelledby="requirement-composer-title"
    onSubmit={e=>{
      e.preventDefault();
      if(submitDisabled)return;
      const next=withScope(value.trim());
      if(next){
        requestSequence.current++;setRefining(false);setRefineError('');setRefinement(null);
        onSubmit({non_goals:next,revoked:[],...(activeReading?{reading:activeReading}:{}),...(fastMode&&{fast_mode:true,scope:parsedFiles})});
      }
    }}>
    <header className="composer-heading">
      <div>
        <h2 id="requirement-composer-title">提出新需求</h2>
        <p className="composer-subtitle">直接描述业务目标与预期变化；ARC 自动结合工程上下文定位关联实现与待决定规则。</p>
      </div>
      {defaultEngine==='codex'&&<span className="composer-engines" role="group" aria-label="开发模式">
        <button type="button" disabled={busy} aria-pressed={!directEdit} onClick={()=>setDirectEdit(false)}>标准受控</button>
        <button type="button" disabled={busy} aria-pressed={directEdit} onClick={()=>setDirectEdit(true)}>快速直改</button>
      </span>}
    </header>
    <div className="composer-body">
      {/* 自动带入的工程上下文带：关联功能走读、源码版本、已确认项目规则 */}
      <section className="composer-context-strip" aria-label="已带入的工程上下文">
        <div className="composer-context-row">
          <span className="composer-context-kicker">已带入工程上下文</span>
          <span className={`composer-ctx-pill${bound?' is-ok':' is-warn'}`}>
            {context?(bound?(versionTag?`源码 ${versionTag}`:'工作区已绑定'):'工作区未绑定'):'读取工作区…'}
            {context&&` · 资料 v${context.version}`}
          </span>
          {activeFeatureLabel?(
            <span className="composer-ctx-pill is-feature">
              关联功能：{activeFeatureLabel}
              {activeSourceLabel&&<code>{activeSourceLabel}</code>}
              <button
                type="button"
                className="composer-ctx-clear"
                aria-label="取消关联功能"
                onClick={()=>{
                  if(readingDraft)onClearReadingDraft?.();
                  setPickedFeatureId('');
                }}
              >✕</button>
            </span>
          ):featureOptions&&featureOptions.length>0&&(
            <select
              className="composer-feature-picker"
              aria-label="关联已有功能走读"
              value={pickedFeatureId}
              disabled={busy}
              onChange={e=>setPickedFeatureId(e.target.value)}
            >
              <option value="">＋ 关联已有功能走读（可选）</option>
              {featureOptions.map(opt=><option key={opt.scenarioId} value={opt.scenarioId}>{opt.label}</option>)}
            </select>
          )}
          {knownConstraints.length>0&&(
            <button
              type="button"
              className="composer-ctx-pill is-clickable"
              aria-expanded={showConstraints}
              onClick={()=>setShowConstraints(v=>!v)}
            >
              已带入 {knownConstraints.length} 条项目规则 {showConstraints?'▴':'▾'}
            </button>
          )}
        </div>
        {showConstraints&&knownConstraints.length>0&&(
          <ul className="composer-constraint-list">
            {knownConstraints.map(item=>{
              const pinned=scopeKeys.has(normalizeBoundaryText(item.summary));
              return <li key={item.id}>
                <span className="composer-constraint-tag">{item.category}</span>
                <span>{item.summary}</span>
                <button type="button" className="composer-link" disabled={busy} onClick={()=>toggleScope(item.summary)}>
                  {pinned?'已设为本轮守卫':'+ 设为本轮不改守卫'}
                </button>
              </li>;
            })}
          </ul>
        )}
      </section>

      <label className="composer-goal-label" htmlFor="development-goal">你想实现什么业务变化？</label>
      <textarea id="development-goal" aria-label="开发任务" ref={goalInput} value={goal} required disabled={busy}
        placeholder="用自然语言说明业务目标即可，例如：给订单增加满减和 VIP10 优惠券；非法券不能扣库存。"
        onChange={e=>onGoalChange(e.target.value)} onKeyDown={e=>{
          if(e.ctrlKey&&e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}
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
            onClick={()=>void refineGoal()}>{refining?'优化中…':'润色需求描述'}</button>
        </div>
      </div>
      {refineError&&<p className="composer-refine-error" role="alert">{refineError}</p>}
      {refinement&&<section className="composer-refinement" aria-labelledby="refinement-title">
        <header className="refinement-header">
          <h3 id="refinement-title">润色建议</h3>
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
      {fastMode&&<div className="composer-targets">
        <label className="composer-goal-label" htmlFor="development-files">指定允许修改的文件（必填，支持多个路径，用逗号或换行分隔）</label>
        <textarea id="development-files" rows={2} required disabled={busy} value={fileInput} aria-invalid={!!fileError}
          placeholder="例如：src/main.ts, tests/main.test.ts" onChange={e=>setFileInput(e.target.value)}/>
        {fileError&&<p className="warning" role="alert">{fileError}</p>}
        {!!suggestions?.length&&<div className="composer-scope-options" role="group" aria-label="匹配的工程文件">{suggestions.map(file=>
          <button key={file.path} type="button" disabled={busy} onClick={()=>{
            setFileInput([...fileParts.slice(0,-1).map(part=>part.trim()).filter(Boolean),file.path,''].join(', '));
            document.getElementById('development-files')?.focus();
          }}>{file.path}</button>)}</div>}
      </div>}
      <section className="composer-boundaries" aria-labelledby="composer-scopes">
        <h3 id="composer-scopes">本轮不改范围 <small>（可选，分析与验收自动守卫）</small></h3>
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

      {/* 模型、连接、构建命令放入次级可折叠设置 */}
      <details className="composer-settings-drawer" open={!!error||(!!context&&!bound)}>
        <summary>
          <span className="composer-settings-title">执行设置</span>
          <span className="composer-settings-summary">
            {analysisModes[defaultEngine].name}
            {' · '}
            {context?(bound?'工作区已绑定':'工作区未绑定'):'读取工作区中'}
            {commands.length>0?` · ${commands.length} 条工程检查命令`:''}
          </span>
        </summary>
        <section className="composer-exec-strip" aria-label="执行环境">
          <div className="composer-engine-controls">
            {defaultEngine==='codex_desktop'||defaultEngine==='mcp'?<span className="composer-engine-current">{analysisModes[defaultEngine].name}</span>:
            <span className="composer-engines" role="group" aria-label="执行引擎">{(['codex','dsh'] as const).map(mode=>
              <button key={mode} type="button" disabled={enginePending||busy} aria-pressed={defaultEngine===mode} onClick={()=>onEngineChange(mode)}>{analysisModes[mode].name}</button>
            )}</span>}
            {defaultEngine==='codex'&&<CodexModelSelect {...codexModel} label="本次 Codex 模型" disabled={enginePending||busy}/>}
            <button type="button" className="composer-link" onClick={onSettings}>连接设置</button>
          </div>
          <div className="composer-commands" aria-label="有效命令">
            {error?<span role="alert" className="warning">{error}</span>:context&&!bound?'绑定工作区后读取':!environment?<span>正在读取命令…</span>:
              commands.length?commands.map(([key,label])=><span className="composer-command" key={key} title={environment.effective_commands[key]}>
                {label}<code>{environment.effective_commands[key]}</code></span>):'未配置自动检查命令'}
          </div>
        </section>
      </details>
    </div>
    <div className="composer-footer"><small>{fastMode?'仅允许修改指定文件。宿主未运行验证时，仍执行独立审查。':'只读分析不改代码，先列出关联实现、影响范围与待决规则供你拍板'}</small>
      <div>{onCancel&&<button type="button" className="composer-link" disabled={busy} onClick={onCancel}>取消</button>}
        <button type="submit" className="primary" aria-keyshortcuts="Control+Enter" disabled={submitDisabled}>{busy?'正在提交…':fastMode?'快速直改并验证':'分析影响与待决问题'}
          <kbd aria-hidden="true">Ctrl+Enter</kbd></button></div>
    </div>
  </form>;
}
