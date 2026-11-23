import React,{useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {analysisModes,type AnalysisMode} from './discovery-state';
import type {Project,SourceEvidence,SourceFile,AnalysisResult} from '../shared';
import type {ContextEntry,ContextSource,EngineeringContext,EngineeringTask,DevelopmentAttempt,TaskReadingBinding,VerificationEvidence,UpdateBehaviorContractInput,PrepareBehaviorRevisionInput} from '../engineering';
import {SourceExcerpt} from './SourceExcerpt';
import {TextDiffView} from './TextDiffView';
import {EngineeringSections,ContextBody,ContextText,ExternalExecutor,type EngineeringSection} from './EngineeringSections';
import {DevelopmentActivity,PlanDecision,SavedRequirementPackage,publicActivity,taskDetailStage,type ActivityEvent} from './DevelopmentActivity';
import {DeliveryHud,useTaskHud,type TaskArchitectureOverlay} from './DevelopmentHud';
import {EvolutionCockpit,type EvolutionFileDiff} from './EvolutionCockpit';
import {ProjectEnvironmentCard} from './ProjectEnvironmentCard';
import {useProjectEnvironment} from './project-environment-store';
import {RequirementComposer,type FeatureContextOption,type RequirementReadingDraft,type RequirementSubmission} from './RequirementComposer';
import type {CodexModelSelection} from './CodexModelSelect';
import {commandBody,sameVerificationState,verificationEvidenceLabel} from '../delivery-audit';
import {DeliveryAuditBar} from './DeliveryAuditBar';
import {TaskBoundaries} from './TaskBoundaries';
import {InlineCodeText,TaskBehaviorCockpit} from './TaskBehaviorCockpit';
import type {Dispatch} from '../main/external-dispatch';
import './engineering.css';

import {componentReading,contextSummary,type savedBusinessPath} from './home-reading';

const api=window.arc;
const stateNames:Record<string,string>={pending:'待执行',starting:'准备执行',running:'执行中',blocked:'需要处理',completed:'执行结束',failed:'执行失败',cancelled:'已取消',interrupted:'上次执行中断',passed:'通过',partial:'部分完成',not_run:'未执行',stale:'代码已变化，需重新验证'};
const stepStateNames:Record<string,string>={pending:'待开始',in_progress:'进行中',completed:'已完成',blocked:'受阻',failed:'失败',superseded:'已撤回 / 替换'};
const categoryNames:Record<ContextEntry['category'],string>={purpose:'工程概述',build:'构建与验证',rule:'约束与边界',technology:'技术与环境',module:'模块',interface:'接口',decision:'决定',issue:'已知问题与待确认',plan:'方案',architecture:'架构',design:'设计',verification_plan:'验证计划'};
const categoryQuestions:Record<ContextEntry['category'],string>={purpose:'这个工程服务谁、解决什么问题，能力边界在哪里？',build:'如何安装、启动、构建和验证？哪些命令只是发现，哪些实际执行过？',rule:'修改和运行时必须遵守哪些约束，哪些边界仍需确认？',technology:'使用什么运行环境、框架和外部依赖？',module:'系统由哪些模块组成，各自负责什么，应该去哪里修改？',interface:'模块之间通过什么 API、数据和事件协作，兼容约定是什么？',decision:'为什么选择当前实现，哪些方案和历史原因需要保留？',issue:'目前有哪些已知问题、风险和未覆盖范围？',plan:'本次准备如何实施，取舍、步骤和范围是什么？',architecture:'组件边界和协作关系是什么，变更会影响哪些部分？',design:'接口、数据和实现细节如何支撑目标？',verification_plan:'如何证明需求完成，哪些结果必须留下实际证据？'};
const originNames={source:'源码 / 配置',document:'文档声明',user:'用户补充',agent:'Agent 归纳'};
const when=(value:string)=>new Date(value).toLocaleString();
const recordDay=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit'});
const recordTime=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
const verificationLabels={not_run:'未验证',passed:'验证通过',failed:'验证失败',partial:'部分验证',stale:'待复验'};
function compactTimestamp(value:string){
  const date=new Date(value);
  return date.toDateString()===new Date().toDateString()?recordTime.format(date):recordDay.format(date);
}
function workflowLabel(task:EngineeringTask){
  if(task.workflow==='ready')return '方案待确认';
  if(task.workflow==='analysis'){
    if(task.status==='pending')return '待分析';
    if(task.status==='running')return '分析中';
    return '需求分析 · '+stateNames[task.status];
  }
  if(task.status==='blocked'&&task.verification_status==='passed'&&task.unresolved.length)return '待收尾（有遗留项）';
  return stateNames[task.status];
}
function toEvidence(source:ContextSource):SourceEvidence{return {evidence_id:`context:${source.path}:${source.line_start}`,source_snapshot_id:source.snapshot_id,path:source.path,line_start:source.line_start,line_end:source.line_end,content_sha256:source.content_sha256,role:'context',note:'工程上下文引用的冻结来源'};}
function contextEntryTitle(entry:ContextEntry,label:string){
  if(entry.key.startsWith('initial:'))return label;
  if(entry.key.startsWith('entry:'))return entry.key.slice(6);
  return entry.key.replace(/^(document|purpose|technology|module|build|interface|issue):/,'');
}

const contextCache=new Map<string,EngineeringContext>();
const lastFreshCheck=new Map<string,number>();
const contextListeners=new Set<()=>void>();
const subscribeContext=(notify:()=>void)=>{contextListeners.add(notify);return ()=>{contextListeners.delete(notify);};};
function publishContext(value:EngineeringContext){
  contextCache.set(value.project_id,value);for(const notify of contextListeners)notify();
}
type ContextLoad='cached'|'fresh'|'refresh';
const pendingContext=new Map<string,{mode:ContextLoad;result:Promise<EngineeringContext>}>();
function loadContext(projectId:string,mode:ContextLoad){
  const pending=pendingContext.get(projectId);
  if(pending&&(pending.mode===mode||pending.mode==='refresh'||mode==='cached'))return pending.result;
  const result=api.invoke<EngineeringContext>('engineering_context',{project_id:projectId,task_id:'',cached:mode==='cached',refresh:mode==='refresh'}).then(value=>{
    if(pendingContext.get(projectId)?.result===result){
      if(mode!=='cached')lastFreshCheck.set(projectId,Date.now());
      const previous=contextCache.get(projectId);
      if(previous?.version===value.version&&previous.entries.length>value.entries.length){
        publishContext({...value,entries:previous.entries,next_offset:previous.next_offset});
      }else publishContext(value);
    }
    return value;
  }).finally(()=>{if(pendingContext.get(projectId)?.result===result)pendingContext.delete(projectId);});
  pendingContext.set(projectId,{mode,result});return result;
}
function useContext(projectId:string){
  const context=useSyncExternalStore(subscribeContext,()=>contextCache.get(projectId)??null);
  const [error,setError]=useState(''),[checking,setChecking]=useState(false);
  const reload=useCallback(async(refresh=false)=>{
    if(refresh)setChecking(true);
    try{const value=await loadContext(projectId,refresh?'refresh':'fresh');setError('');return value;}
    catch(e){setError((e as Error).message);return null;}
    finally{if(refresh)setChecking(false);}
  },[projectId]);
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;
    async function open(){
      if(!contextCache.has(projectId))await loadContext(projectId,'cached');
      if(active&&Date.now()-(lastFreshCheck.get(projectId)??0)>15000)await reload();
    }
    void open().catch(e=>{if(active)setError(e.message);});
    const off=api.onEvent(e=>{
      if(e.type!=='changed'&&e.type!=='engineering_changed')return;
      lastFreshCheck.delete(projectId);
      clearTimeout(timer);timer=setTimeout(()=>{void reload();},400);
    });
    return()=>{active=false;clearTimeout(timer);off();};
  },[projectId,reload]);
  const more=async()=>{
    if(!context||context.next_offset===null)return;
    try{
      const next=await api.invoke<EngineeringContext>('engineering_context',{project_id:projectId,task_id:'',cached:true,offset:context.next_offset});
      if(contextCache.get(projectId)!==context)return;
      if(next.version!==context.version){await reload();return;}
      publishContext({...next,entries:[...context.entries,...next.entries]});
    }catch(e){setError((e as Error).message);}
  };
  return {context,error,reload,more,checking};
}

function shortMaterialTitle(name: string): string {
  if (!name.includes('/') && !name.includes('\\')) return name;
  const parts = name.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.length <= 2 ? name : `…/${parts.slice(-2).join('/')}`;
}

const barePathPattern = /^[a-zA-Z0-9._-]+(?:[\\/][a-zA-Z0-9._-]+)*$/;
const placeholderRulePattern = /尚待工程负责人确认|暂无具体约束|待工程负责人|通用说明/;

function materialHeadline(entry: ContextEntry, categoryLabel: string): { title: string; sourceIndex?: string } {
  const rawName = contextEntryTitle(entry, categoryLabel).trim();
  const looksLikeBarePath = barePathPattern.test(rawName) && (rawName.includes('/') || rawName.includes('\\') || /^(?:src|tests?|lib|app|pkg|cmd|internal|config|scripts?|docs?|web|ui|api|server|client|core)$/i.test(rawName) || /\.[a-z0-9]{1,5}$/i.test(rawName));
  if (!looksLikeBarePath) {
    const primarySource = entry.sources[0]?.path;
    return { title: shortMaterialTitle(rawName), sourceIndex: primarySource && primarySource !== rawName ? shortMaterialTitle(primarySource) : undefined };
  }
  const firstLine = entry.text
    .split(/\r?\n/)
    .map(line => line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim())
    .find(line => line.length >= 4 && !barePathPattern.test(line) && !/^来源[:：]/.test(line));
  const summary = firstLine ? firstLine.split(/[。！？；;]/)[0].trim().slice(0, 28) : '';
  const fallbackByName = /^tests?$/i.test(rawName) ? '测试套件与校验说明' : /^src$/i.test(rawName) ? '核心源码目录说明' : `${categoryLabel}说明`;
  return {
    title: summary && summary !== rawName ? summary : fallbackByName,
    sourceIndex: shortMaterialTitle(rawName),
  };
}

const recommendedKnowledgeSlots: {
  category: ContextEntry['category'];
  label: string;
  defaultTitle: string;
  template: string;
  needsSupplement: (entries: ContextEntry[]) => boolean;
}[] = [
  {
    category: 'rule',
    label: '业务约束与红线',
    defaultTitle: '核心业务约束与不可破坏规则',
    template: '## 必须遵守的业务规则\n- 规则 1：\n- 规则 2：\n\n## 边界与禁止事项\n- 不可修改或必须兼容的行为：\n',
    needsSupplement: list => {
      const rules = list.filter(e => e.category === 'rule' && !e.task_id && e.status !== 'superseded');
      return !rules.length || rules.every(e => e.origin !== 'user' && placeholderRulePattern.test(e.text));
    },
  },
  {
    category: 'interface',
    label: '接口与数据约定',
    defaultTitle: '对外接口与数据契约说明',
    template: '## 关键接口 / 数据结构\n- 入口与参数约定：\n- 返回值与错误码要求：\n\n## 兼容约束\n- 外部调用方依赖：\n',
    needsSupplement: list => !list.some(e => e.category === 'interface' && !e.task_id && e.status !== 'superseded'),
  },
  {
    category: 'build',
    label: '构建与运行方式',
    defaultTitle: '本地运行、构建与测试说明',
    template: '## 启动与构建\n- 安装依赖：\n- 构建命令：\n\n## 验证方式\n- 单元测试：\n- 类型/静态检查：\n',
    needsSupplement: list => !list.some(e => e.category === 'build' && !e.task_id && e.status !== 'superseded'),
  },
  {
    category: 'decision',
    label: '关键工程决定',
    defaultTitle: '已确认的技术与业务取舍',
    template: '## 决策背景\n- 面临的问题：\n\n## 选定方案与理由\n- 采用方案：\n- 放弃的备选及原因：\n',
    needsSupplement: list => {
      const items = list.filter(e => e.category === 'decision' && !e.task_id && e.status !== 'superseded');
      return !items.length || items.every(e => e.key.startsWith('initial:') && e.origin !== 'user');
    },
  },
];

function ContextFacts({context,reload,onMore,onRefreshSource,checking,createTrigger}:{context:EngineeringContext;reload:()=>Promise<unknown>;onMore?:()=>Promise<void>;onRefreshSource?:()=>void;checking?:boolean;createTrigger?:number}){
  const [selected,setSelected]=useState<ContextEntry|null>(null),[editing,setEditing]=useState(false),[preview,setPreview]=useState(false);
  const [category,setCategory]=useState<ContextEntry['category']>('rule'),[title,setTitle]=useState(''),[body,setBody]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[readingFull,setReadingFull]=useState(false),[notice,setNotice]=useState(''),[versions,setVersions]=useState<ContextEntry[]>([]);
  const [loadingHistory,setLoadingHistory]=useState(false);
  const [searchText,setSearchText]=useState(''),[filterCategory,setFilterCategory]=useState('');
  const [remoteResult,setRemoteResult]=useState<{entries:ContextEntry[];total:number}|null>(null);
  const [searching,setSearching]=useState(false);
  const request=useRef(0);
  useEffect(()=>()=>{request.current++;},[]);
  useEffect(()=>{
    if(!createTrigger)return;
    startCreate('rule','','');
  },[createTrigger]);
  useEffect(()=>{
    const q=searchText.trim();
    if(!q&&!filterCategory){setRemoteResult(null);setSearching(false);return;}
    let alive=true;
    setSearching(true);
    const timer=setTimeout(()=>{
      void api.invoke<EngineeringContext>('engineering_context',{
        project_id:context.project_id,task_id:'',cached:true,limit:40,
        ...(q?{query:q}:{}),...(filterCategory?{category:filterCategory}:{}),
      }).then(res=>{if(alive)setRemoteResult({entries:res.entries,total:res.total_entries});})
        .catch(e=>{if(alive)setError((e as Error).message);})
        .finally(()=>{if(alive)setSearching(false);});
    },220);
    return()=>{alive=false;clearTimeout(timer);};
  },[context.project_id,context.version,searchText,filterCategory]);
  const listedEntries=remoteResult?remoteResult.entries:context.entries;
  const listedTotal=remoteResult?remoteResult.total:context.total_entries;
  const missingSlots=recommendedKnowledgeSlots.filter(slot=>slot.needsSupplement(context.entries));
  const initialized=useRef(false);
  useEffect(()=>{if(initialized.current||!context.entries.length)return;initialized.current=true;const mine=request.current;void api.invoke('reading_get',{key:'engineering-material/'+context.project_id}).then(value=>{if(mine!==request.current)return;const preferredOrder:ContextEntry['category'][]=['rule','decision','interface','build','issue','purpose','module'];const preferred=preferredOrder.map(cat=>context.entries.find(e=>e.category===cat&&!e.task_id&&e.status!=='superseded')).find(Boolean);const entry=context.entries.find(e=>e.entry_id===value?.entry_id)??preferred??context.entries[0];void open(entry);}).catch(e=>{if(mine===request.current)setError(e.message);});},[context.entries]);
  function startCreate(nextCategory:ContextEntry['category'],defaultTitle='',defaultBody=''){
    clearSelection();setCategory(nextCategory);setTitle(defaultTitle);setBody(defaultBody);setEditing(true);setPreview(false);setError('');
  }
  function select(entry:ContextEntry,edit:boolean){
    setSelected(entry);setCategory(entry.category);setTitle(contextEntryTitle(entry,categoryNames[entry.category]));setBody(entry.text);setEditing(edit);setPreview(false);
  }
  async function open(entry:ContextEntry,edit=false){
    const mine=++request.current;setError('');setVersions([]);setLoadingHistory(false);select(entry,false);
    const needsFull=edit||entry.truncated;setReadingFull(!!needsFull);
    void api.invoke('reading_save',{key:'engineering-material/'+context.project_id,value:{entry_id:entry.entry_id}}).catch(e=>{if(mine===request.current)setError(e.message);});
    if(!needsFull)return;
    try{
      const value=await api.invoke<EngineeringContext>('engineering_context',{project_id:context.project_id,entry_id:entry.entry_id});
      if(mine!==request.current)return;
      const full=value.entries[0];if(!full||full.truncated)throw Error('未取得当前完整正文，不能覆盖编辑');
      select(full,edit);
    }catch(e){if(mine===request.current)setError((e as Error).message);}finally{if(mine===request.current)setReadingFull(false);}
  }
  useEffect(()=>{if(editing||!selected)return;const latest=context.entries.find(e=>e.entry_id===selected.entry_id);if(latest&&latest.version>selected.version)void open(latest);},[context.entries,editing,selected]);
  async function history(entry:ContextEntry){
    const mine=request.current;setLoadingHistory(true);setError('');try{const values=await api.invoke<ContextEntry[]>('engineering_history',{kind:'context',id:entry.entry_id});const original=entry.supersedes?await api.invoke<ContextEntry[]>('engineering_history',{kind:'context',id:entry.supersedes}):[];if(mine===request.current)setVersions([...original,...values]);}catch(e){if(mine===request.current)setError((e as Error).message);}finally{if(mine===request.current)setLoadingHistory(false);}
  }
  function clearSelection(){request.current++;setReadingFull(false);setLoadingHistory(false);setSelected(null);setVersions([]);}
  async function save(e:React.FormEvent){e.preventDefault();if(busy||!body.trim()||!title.trim())return;setBusy(true);setError('');try{
    const saved=await api.invoke<ContextEntry>('engineering_save_entry',{project_id:context.project_id,entry_id:selected?.entry_id,expected_version:selected?.version??0,submission_key:crypto.randomUUID(),category,key:title,text:body});setSelected(saved);setEditing(false);setVersions([]);setNotice('已保存当前有效资料；原始来源与旧版本保留。正文编辑未修改源码，也未执行验证。');await reload();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const selectedHeadline=selected?materialHeadline(selected,categoryNames[selected.category]):null;
  return <div className="eng-materials-shell">
    {error&&<p role="alert" className="warning eng-mat-banner">{error}</p>}
    {notice&&<div role="status" className="eng-notice-inline"><span>{notice}</span><button type="button" className="bw-inline-link" onClick={()=>setNotice('')}>关闭</button></div>}
    {missingSlots.length>0&&!editing&&(
      <div className="eng-missing-strip" aria-label="可补充的项目知识">
        <span className="eng-missing-label">待补充项目特有知识</span>
        <div className="eng-missing-chips">
          {missingSlots.map(slot=>(
            <button key={slot.category} type="button" className="eng-missing-chip" disabled={busy} onClick={()=>startCreate(slot.category,slot.defaultTitle,slot.template)}>
              + 补充{slot.label}
            </button>
          ))}
        </div>
      </div>
    )}
    <div className="engineering-material-layout">
      <nav className="engineering-material-directory" aria-label="工程资料目录">
        <div className="eng-mat-dir-tools">
          <input className="engineering-material-search" type="search" aria-label="搜索工程资料" placeholder="搜索规则、接口、目录…" value={searchText} onChange={e=>setSearchText(e.target.value)}/>
          <div className="eng-mat-dir-row">
            <select className="engineering-material-filter" aria-label="按分类筛选工程资料" value={filterCategory} onChange={e=>setFilterCategory(e.target.value)}>
              <option value="">全部分类 ({listedTotal})</option>
              {Object.entries(categoryNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}
            </select>
            {(searchText||filterCategory)&&<button type="button" className="bw-inline-link" onClick={()=>{setSearchText('');setFilterCategory('');}}>清除</button>}
          </div>
          {searching&&<small className="muted">正在筛选资料…</small>}
        </div>
        <div className="eng-mat-dir-items">
          {([
            ['项目规则与约束',['rule','decision','issue']],
            ['接口与运行方式',['interface','build','technology']],
            ['工程概述与模块',['purpose','module']],
            ['历史方案与验证',['plan','architecture','design','verification_plan']],
          ] as [string,ContextEntry['category'][]][]).map(([group,categories])=>{
            const entries=categories.flatMap(kind=>listedEntries.filter(e=>e.category===kind&&!e.task_id&&e.status!=='superseded').map(entry=>({entry,label:categoryNames[kind]})));
            return entries.length>0&&<section key={group}><h3>{group}</h3>{entries.map(({entry,label})=>{
              const info=materialHeadline(entry,label);
              const rawName=contextEntryTitle(entry,label);
              return <button key={entry.entry_id} disabled={busy} aria-pressed={selected?.entry_id===entry.entry_id} onClick={()=>{if(editing&&!window.confirm('离开编辑将丢弃未保存的正文，是否继续？'))return;void open(entry);}}>
                <span className="engineering-material-kind">{label}</span>
                <strong title={rawName}>{info.title}</strong>
                {info.sourceIndex&&<code className="eng-mat-source-index">{info.sourceIndex}</code>}
                <small>{originNames[entry.origin]} · v{entry.version}{entry.status==='needs_review'?' · 待复核':''}{entry.update_suggestion?' · 有更新建议':''}</small>
              </button>;
            })}</section>;
          })}
          {!listedEntries.length&&<p className="muted" style={{fontSize:'0.82rem',padding:'8px 0'}}>{searching?'正在筛选资料…':'没有匹配的工程资料。'}</p>}
          {!remoteResult&&context.next_offset!=null&&onMore&&<button type="button" className="engineering-material-more" onClick={()=>void onMore()}>加载更多（剩余 {Math.max(0,context.total_entries-context.entries.length)} 条）</button>}
        </div>
      </nav>
      <div className="engineering-material-article">
        {!selected&&!editing&&<div className="engineering-empty">
          <h3>{context.entries.length?'选择左侧资料开始阅读':'尚未形成项目特有资料'}</h3>
          <p>{context.entries.length?'已将项目规则、接口约定与运行方式置于前方；点击条目即可阅读全文或直接补充。':'点击上方「待补充项目特有知识」即可快速补齐业务约束、接口约定或构建命令。'}</p>
        </div>}
        {(selected||editing)&&<section className="engineering-source eng-mat-reader" aria-label="工程资料全文编辑">
          <div className="eng-mat-article-head">
            <div>
              {selected&&<span className="eng-mat-article-cat">{categoryNames[selected.category]}</span>}
              <h3>{selectedHeadline?selectedHeadline.title:'新增项目特有资料'}</h3>
              {selectedHeadline?.sourceIndex&&<span className="eng-mat-article-src">来源索引：<code>{selectedHeadline.sourceIndex}</code></span>}
            </div>
            <div className="row">
              {selected&&!editing&&<button disabled={busy||readingFull} onClick={()=>void open(selected,true)}>编辑全文</button>}
              {editing&&<button disabled={busy} onClick={()=>{setEditing(false);if(!selected)clearSelection();}}>取消编辑</button>}
              {!editing&&<button disabled={busy} onClick={()=>{clearSelection();setEditing(false);}}>关闭</button>}
            </div>
          </div>
          <div key={`${selected?.entry_id ?? ""}:${editing}`} className="eng-mat-article-scroll">
            {selected&&!editing&&selected.origin!=='user'&&placeholderRulePattern.test(selected.text)&&(
              <div className="eng-mat-placeholder-callout">
                <span>这条内容目前是通用初始化占位说明，尚未包含本项目特有的真实规则。</span>
                <button type="button" className="primary" disabled={busy||readingFull} onClick={()=>void open(selected,true)}>补充本项目规则</button>
              </div>
            )}
            {readingFull&&<p role="status">正在读取完整正文…</p>}
            {editing?<form onSubmit={save}>
              <div className="eng-mat-form-row">
                <label>资料类别<select aria-label="工程资料类别" disabled={busy||!!selected} value={category} onChange={e=>setCategory(e.target.value as ContextEntry['category'])}>{Object.entries(categoryNames).filter(([key])=>!['plan','design','verification_plan'].includes(key)).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
                <label>资料标题<input aria-label="工程资料标题" value={title} maxLength={300} disabled={busy} placeholder="一句话说明这份内容解释什么" onChange={e=>setTitle(e.target.value)} required/></label>
              </div>
              <div className="row"><button type="button" aria-pressed={!preview} onClick={()=>setPreview(false)}>编辑 Markdown</button><button type="button" aria-pressed={preview} onClick={()=>setPreview(true)}>预览 Markdown</button></div>
              {preview?<ContextText text={body}/>:<label>Markdown 正文<textarea aria-label="工程资料正文" value={body} maxLength={60000} rows={16} disabled={busy} onChange={e=>setBody(e.target.value)} required/></label>}
              <p className="muted" style={{margin:0,fontSize:'12.5px'}}>正文保存在 ARC 并自动参与后续需求分析；保存不会修改源码或产生验证通过记录。</p>
              <div><button className="primary" disabled={busy||!body.trim()||!title.trim()}>{busy?'保存中…':'保存当前资料'}</button></div>
            </form>:selected&&<div className="eng-mat-body"><ContextText text={selected.text}/></div>}
            {selected&&!editing&&<footer className="eng-mat-meta">
              <div className="eng-mat-meta-row">
                <small>{originNames[selected.origin]} · v{selected.version} · {when(selected.updated_at)}</small>
                <button type="button" className="bw-inline-link" disabled={busy||loadingHistory} onClick={()=>void history(selected)}>{loadingHistory?'加载历史…':'查看原文与版本历史'}</button>
              </div>
              {selected.update_suggestion&&<details><summary>局部更新建议 · 原来源 v{selected.update_suggestion.source_version}</summary><p>仅比较这条资料对应的来源，不会自动替换当前正文。核对后可在全文编辑中选择需要的修改。</p><h4>修订时来源</h4><ContextText text={selected.update_suggestion.previous_text}/><h4>重新扫描来源</h4><ContextText text={selected.update_suggestion.proposed_text}/></details>}
              <details><summary>冻结来源索引 · {selected.sources.length} 处引用</summary>{selected.sources.map((source,i)=><SourceExcerpt key={i} evidence={toEvidence(source)}/>)}{!selected.sources.length&&<p className="muted">尚无源码引用；属于{originNames[selected.origin]}或明确的待确认项。</p>}</details>
              {versions.map(v=><details key={v.entry_id+':'+v.version}><summary>{v.entry_id===selected.entry_id?(v.version===selected.version?'当前正文':'正文旧版'):'原始来源'} · v{v.version} · {originNames[v.origin]} · {when(v.updated_at)}</summary><ContextText text={v.text}/>{v.sources.map((source,i)=><SourceExcerpt key={i} evidence={toEvidence(source)}/>)}</details>)}
            </footer>}
          </div>
        </section>}
      </div>
    </div>
  </div>;
}

interface EngineeringOverviewSectionsProps {
  project: Project;
  result?: AnalysisResult;
  businessPath: ReturnType<typeof savedBusinessPath>;
  onBusinessStep: (last:boolean, showSource?:boolean)=>void;
  resumeLabel: string;
  onResume: ()=>void;
  onMaterials: ()=>void;
  onWalk: ()=>void;
  onArchitecture: (objectId:string)=>void;
  onFiles: ()=>void;
  onTask: (id:string)=>void;
}

export function EngineeringOverviewSections({
  project, result, onMaterials, onWalk, onArchitecture, onFiles, onTask,
  businessPath, onBusinessStep, resumeLabel, onResume,
}: EngineeringOverviewSectionsProps) {
  const {context,error}=useContext(project.project_id);
  const entries=context?.entries.filter(item=>item.status!=='superseded')??[];
  const entry=(category:ContextEntry['category'])=>entries.find(item=>item.category===category);
  const focus=componentReading(result);
  const recent=context?.recent_tasks??[];
  const review=recent.find(task=>task.verification_status==='stale'||task.verification_status==='failed');
  const current=recent.find(task=>task.status==='running'||task.status==='pending'||task.status==='blocked');
  const capability=result?.feature_catalog?.groups.flatMap(group=>group.node_ids).map(id=>result.nodes.find(node=>node.node_id===id)?.label).filter(Boolean);
  return <section className="project-home overview-below-architecture" aria-label="工程阅读与资料">
    {error&&<p role="alert" className="warning">{error}</p>}
    <div className="project-home-main">
      <section className="project-home-panel project-home-architecture">
        <div className="project-home-heading"><h2>从这里读起</h2></div>
        {businessPath?<div className="home-guide">
          <h3>{businessPath.path.label}</h3><p>{businessPath.path.intro}</p>
          <details>
            <summary>查看阅读步骤与源码</summary>
            <dl><dt>从哪里开始</dt><dd>{businessPath.path.entry}</dd><dt>读到什么结果</dt><dd>{businessPath.last.outcome||'当前走读尚未说明结果'}</dd></dl>
            <div className="home-guide-actions">
              <button className="primary" onClick={()=>onBusinessStep(false)}>从「{businessPath.first.title}」开始</button>
              <button onClick={()=>onBusinessStep(false,true)}>核对起点源码</button>
              {businessPath.first.id!==businessPath.last.id&&<button onClick={()=>onBusinessStep(true)}>查看结果步骤</button>}
            </div>
          </details>
        </div>:focus?<div className="home-guide">
          <h3>{focus.node.label}</h3><p>{focus.node.description}</p>
          <details>
            <summary>查看组件输入输出与源码</summary>
            <dl><dt>接收什么</dt><dd>{focus.inputs.map(io=>io.name).join('、')||'当前分析尚未说明输入'}</dd>
            <dt>产出什么</dt><dd>{focus.outputs.map(io=>io.name).join('、')||'当前分析尚未说明产出'}</dd></dl>
            <button className="home-source" onClick={()=>onArchitecture(focus.node.node_id)}><span>{result?.binding.source_snapshot_id===project.snapshot_id?'核对源码':'核对历史版本源码'}</span><code>{focus.source.path} · L{focus.source.line_start}{focus.source.line_end!==focus.source.line_start?'–'+focus.source.line_end:''}</code></button>
            {focus.edge&&focus.from&&focus.to&&<div className="home-guide-relation"><small>相关组件</small>
              <button onClick={()=>onArchitecture(focus.from!.node_id)}>{focus.from.label}</button>
              <button className="home-edge" onClick={()=>onArchitecture(focus.edge!.edge_id)}>{focus.edge.label} →</button>
              <button onClick={()=>onArchitecture(focus.to!.node_id)}>{focus.to.label}</button></div>}
          </details>
        </div>:<p>{result?'这份分析还没有可定位到源码的阅读起点。可先浏览源码目录，或打开功能目录选一个问题。':'先浏览工程文件，或点击上方分析按钮生成可核对的阅读起点。'}</p>}
        <div className="home-reading-links"><button onClick={onWalk}>{result?.feature_catalog?.readings?.some(r=>r.steps.length)?'阅读首轮功能说明':'功能走读'} →</button><button onClick={onFiles}>源码目录 →</button></div>
      </section>
      <aside className="project-home-panel"><h2>继续工作</h2>
        {resumeLabel&&<button className="home-continue" onClick={onResume}><small>上次阅读</small><strong>{resumeLabel}</strong><span>继续阅读 →</span></button>}
        {review&&<button className="home-continue review" onClick={()=>onTask(review.task_id)}><small>待复核任务 · {stateNames[review.verification_status]}</small><strong>{review.goal}</strong><span>查看任务 →</span></button>}
        {current&&current!==review&&<button className="home-continue" onClick={()=>onTask(current.task_id)}><small>{stateNames[current.status]}</small><strong>{current.goal}</strong><span>查看任务 →</span></button>}
        {recent.some(task=>task!==current&&task!==review)?<div className="home-task-list">{recent.filter(task=>task!==current&&task!==review).slice(0,3).map(task=><button key={task.task_id} onClick={()=>onTask(task.task_id)}><strong>{task.goal}</strong><small>{stateNames[task.status]} · {stateNames[task.verification_status]}</small></button>)}</div>:!current&&!review&&!resumeLabel&&<p className="muted">{context?'阅读组件或功能步骤后，可以从这里继续。':'正在读取开发记录…'}</p>}</aside>
    </div>
    {context?.workspace.status==='bound'&&<ProjectEnvironmentCard key={context.workspace.root_path} workspace={context.workspace}/>}
    <section className="project-home-section"><div className="project-home-heading"><h2>工程资料</h2><button onClick={onMaterials}>查看全部工程资料 →</button></div>
      <dl className="home-facts"><dt>核心能力</dt><dd>{capability?.slice(0,3).join('、')||'尚未形成功能目录'}</dd>
      <dt>构建与验证</dt><dd>{contextSummary(entry('build'))||(context?'暂无构建资料':'正在读取资料…')}</dd>
      <dt>风险与缺口</dt><dd>{contextSummary(entry('issue'))||result?.gaps[0]?.question||'暂无已记录问题'}</dd>
      <dt>分析覆盖</dt><dd>{result?`${result.coverage.covered_scope.length} 项已覆盖 · ${result.coverage.unresolved_scope.length} 项未覆盖`:'待分析'}{result?.coverage.unresolved_scope[0]&&' · '+result.coverage.unresolved_scope[0]}</dd>
      <dt>来源版本</dt><dd>{context?[context.workspace.status==='bound'?'工作区已绑定':'工作区待绑定',context.code_state.branch,context.code_state.head?.slice(0,8)].filter(Boolean).join(' · '):'正在读取代码状态…'}</dd></dl>
    </section>
  </section>;
}

export function EngineeringManagement({project,onRestored}:{project:Project;onRestored:(id:string)=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[rebindPath,setRebindPath]=useState('');
  const [pendingWrites,setPendingWrites]=useState<{task_id:string;error?:string}[]>([]);
  async function readPending(){setPendingWrites(await api.invoke('engineering_pending'));}
  useEffect(()=>{void readPending().catch(e=>setError(e.message));},[project.project_id]);
  async function action(fn:()=>Promise<unknown>,message=''){setBusy(true);setError('');try{await fn();if(message)setNotice(message);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section aria-label="工程连接与恢复">{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<details><summary>接入与恢复</summary><div className="engineering-management"><p>连接会为 Codex 普通新会话配置共享上下文与自动回填规则。实际执行能力与状态见任务记录。</p><button disabled={busy||project.fictional} onClick={()=>void action(()=>api.invoke('engineering_connect',{project_id:project.project_id}),'Agent 接入已保存；请在该工作区开启新会话')}>接入工程上下文 / 迁移旧规则</button><button disabled={busy} onClick={()=>void action(async()=>{const value=await api.invoke('engineering_export',{project_id:project.project_id});if(value)setNotice('已导出工程记录和引用证据');})}>导出工程记录</button><button disabled={busy} onClick={()=>void action(async()=>{const restored=await api.invoke('engineering_restore');if(restored?.project_id)onRestored(restored.project_id);})}>恢复工程记录</button><button disabled={busy} onClick={()=>void action(async()=>{const results=await api.invoke<any[]>('engineering_sync');await readPending();setNotice(results.some(item=>item.saved!=='saved')?'部分记录仍待同步，请查看原因':'待同步记录已检查');})}>检查 / 重试待同步记录</button>{pendingWrites.map((item,i)=><p key={i} className="warning">待同步 · {item.task_id}{item.error&&`：${item.error}`}</p>)}<label>重新绑定的工程目录<input aria-label="重新绑定工程目录" value={rebindPath} onChange={e=>setRebindPath(e.target.value)}/></label><button disabled={busy||!rebindPath.trim()} onClick={()=>void action(()=>api.invoke('engineering_rebind',{project_id:project.project_id,root_path:rebindPath}),'工作区已绑定，历史来源保持不变')}>绑定工作区</button><p className="muted">在 ARC 提交需求后，先进行只读分析，再审阅需求包与批准执行范围。</p></div></details></section>;
}

const taskLists=new Map<string,EngineeringTask[]>();
const selectedTasks=new Map<string,string>();

function cleanGoalHeadline(raw:string){
  const stripped=raw.trim().replace(/^对\s+\S+\s+进行\s*ARC\s*只读需求分析[，,:：\s]*/i,'').trim();
  return stripped||raw.trim();
}

function revealTaskRecord(id:string){
  const target=document.getElementById(id);
  if(!target)return;
  for(let details=target.closest('details');details;details=details.parentElement?.closest('details')??null)details.open=true;
  target.focus({preventScroll:true});
  target.scrollIntoView({block:'start'});
}

function VerificationList({task,onLog}:{task:EngineeringTask;onLog:(path:string)=>void}){
  const latest=new Map<string,VerificationEvidence>();
  for(const item of task.verification){
    const cmd=commandBody(item.command);
    if(item.origin!=='observed'||!sameVerificationState(item.code_state,task.end_state??task.baseline)||cmd.includes('\n'))continue;
    if(!item.note?.includes('ARC 宿主')&&!/\b(typecheck|test|build|pytest|ctest|cargo|mvnw?|gradlew?|vitest|jest)\b/i.test(cmd))continue;
    const previous=latest.get(cmd);
    if(!previous||item.created_at>=previous.created_at)latest.set(cmd,item);
  }
  const primary=latest.size?[...latest.values()]:task.verification;
  const selected=new Set(primary);
  const secondary=task.verification.filter(item=>!selected.has(item));
  const card=(item:VerificationEvidence)=><article className="engineering-verification behavior-record-target" key={item.evidence_id} id={`${task.task_id}-receipt-${item.evidence_id}`} tabIndex={-1}>
    <strong>{verificationEvidenceLabel(item)} · {item.command.split('\n')[0]}</strong>
    <small>{item.origin==='observed'?'已观测命令执行':'Agent 上报，未独立执行核验'} · exit {item.exit_code??'未取得'} · {when(item.created_at)}</small>
    {item.step_id&&<small>步骤：{task.steps?.find(step=>step.step_id===item.step_id)?.title||item.step_id}{item.criterion_id?` · 条件 ${item.criterion_id}`:''}</small>}
    <small className="path">{item.cwd}</small>{item.note&&<p>{item.note}</p>}
    <details><summary>对应代码状态</summary><p className="path">{item.code_state.fingerprint}</p></details>
    {item.log_path&&<button onClick={()=>onLog(item.log_path!)}>查看验证日志</button>}
  </article>;
  return <>{primary.map(card)}{secondary.length>0&&<details className="verification-history">
    <summary>历史轮次与辅助检查 · {secondary.length}</summary>{secondary.map(card)}
  </details>}</>;
}

function RollbackAction({task,readOnly,busy,onRollback}:{task:EngineeringTask;readOnly:boolean;busy:boolean;onRollback:()=>void}){
  const [confirming,setConfirming]=useState(false);
  if(task.rolled_back_at)return <span className="tag">已撤销改动</span>;
  if(readOnly||task.status==='running'||task.status==='pending'||!task.end_state||!task.changes.length||
    task.changes_status==='needs_review'||task.changes.some(change=>change.ownership==='preexisting_overlap'))return null;
  return <span className="task-rollback">
    {confirming?<><button disabled={busy} onClick={onRollback}>确认撤销 {task.changes.length} 个文件？</button>
      <button disabled={busy} onClick={()=>setConfirming(false)}>取消</button></>:
      <button disabled={busy} onClick={()=>setConfirming(true)}>撤销本次改动</button>}
  </span>;
}

type InspectDrawerState =
  | null
  | { kind: 'changes'; activePath?: string }
  | { kind: 'log'; title: string; subtitle?: string; text: string; loading?: boolean };

export function EngineeringWorkspace({project,snapshotFiles,page,requestedTask,onTaskOpened,onSettings,defaultEngine,codexModel,onEngineChange,enginePending,focusGoal,onGoalFocused,readingDraft,onClearReadingDraft,featureOptions,back,onArchitecture,onArchitectureOverlay,onRestored,onReading}:{project:Project;snapshotFiles?:SourceFile[];page:'materials'|'records';requestedTask:string;onTaskOpened:()=>void;onSettings:()=>void;defaultEngine:AnalysisMode;codexModel:CodexModelSelection;onEngineChange:(mode:AnalysisMode)=>void;enginePending:boolean;focusGoal:boolean;onGoalFocused:()=>void;readingDraft?:RequirementReadingDraft|null;onClearReadingDraft?:()=>void;featureOptions?:FeatureContextOption[];back:()=>void;onArchitecture:(resultId?:string)=>void;onArchitectureOverlay?:(overlay:TaskArchitectureOverlay)=>void;onRestored:(projectId:string)=>void;onReading:(task:EngineeringTask)=>void}){
  const {context,error:contextError,reload:reloadContext,more,checking}=useContext(project.project_id);
  const {environment}=useProjectEnvironment(context?.workspace);
  const [tasks,setTasks]=useState<EngineeringTask[]>(()=>taskLists.get(project.project_id)??[]),[selectedId,setSelectedId]=useState(()=>requestedTask||selectedTasks.get(project.project_id)||''),[query,setQuery]=useState(''),[filter,setFilter]=useState('');
  const [tasksLoaded,setTasksLoaded]=useState(()=>taskLists.has(project.project_id));
  const goalInput=useRef<HTMLTextAreaElement>(null);
  const [section,setSection]=useState<EngineeringSection>('tasks');
  const [recordMode,setMode]=useState<'new'|'records'>(focusGoal?'new':'records');
  const [goal,setGoal]=useState(''),[continuation,setContinuation]=useState(false),[busy,setBusy]=useState(false),[runningChecks,setRunningChecks]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [dispatches,setDispatches]=useState<Dispatch[]>([]);
  const [taskAttempts,setAttempts]=useState<DevelopmentAttempt[]>([]),[taskEvents,setEvents]=useState<ActivityEvent[]>([]),[history,setHistory]=useState<EngineeringTask[]>([]),[historical,setHistorical]=useState<EngineeringTask|null>(null);
  const [log,setLog]=useState<{taskId:string;text:string}|null>(null),[showContext,setShowContext]=useState(false);
  const [taskDrawerOpen,setTaskDrawerOpen]=useState(false);
  const [inspectDrawer,setInspectDrawer]=useState<InspectDrawerState>(null);
  const [materialCreateTick,setMaterialCreateTick]=useState(0);
  const [showEvolution,setShowEvolution]=useState(false);
  const [showLegacyGraph,setShowLegacyGraph]=useState(false);
  const [refreshingScenarioId,setRefreshingScenarioId]=useState<string|null>(null);
  const [diff,setDiff]=useState<{path:string;before:string;after:string;truncated:boolean}|null>(null);
  useEffect(()=>{selectedTasks.set(project.project_id,selectedId);setShowEvolution(false);setShowLegacyGraph(false);setInspectDrawer(null);},[project.project_id,selectedId]);
  useEffect(()=>{
    if(!inspectDrawer)return;
    const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')setInspectDrawer(null);};
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[inspectDrawer]);
  const current=tasks.find(t=>t.task_id===selectedId),task=historical||current;
  const logText=log?.taskId===task?.task_id?log?.text:undefined;
  const stage=task&&taskDetailStage(task);
  useEffect(()=>{if(stage&&stage!=='analysis'&&notice.includes('只读分析'))setNotice('');},[stage,notice]);
  const mode=page==='materials'?'materials':current?recordMode:'new';
  const {hud,loading:hudLoading,error:hudError,reload:reloadHud}=useTaskHud(task?.task_id,task?.version,!historical&&!!task&&mode==='records');
  const attempts=taskAttempts.filter(item=>item.task_id===task?.task_id&&task.attempt_ids.includes(item.attempt_id));
  const events=taskEvents.filter(event=>attempts.some(item=>item.attempt_id===event.attempt_id));
  const latestAttempt=attempts.find(item=>item.attempt_id===task?.attempt_ids.at(-1));
  const dispatch=dispatches.filter(item=>item.task_id===selectedId).sort((a,b)=>a.created_at.localeCompare(b.created_at)).at(-1);
  const latestDispatch=(!task?.execution_mode||task.execution_mode==='codex_desktop')&&dispatch&&(!latestAttempt||dispatch.attempt_id===latestAttempt.attempt_id||dispatch.created_at>=latestAttempt.started_at)?dispatch:undefined;
  const panelAttempt=task?.status==='pending'?undefined:latestDispatch?attempts.find(item=>item.attempt_id===latestDispatch.attempt_id):latestAttempt;
  const waitingMcp=current?.execution_mode==='mcp'&&current?.status==='pending'&&current.workflow!=='ready';
  const inProgress=!!current&&current.workflow!=='ready'&&(waitingMcp||current.status==='running'||current.status==='pending'&&!!current.workflow||
    ['queued','sending','awaiting_claim','running','unknown'].includes(latestDispatch?.state??'')||!!panelAttempt&&['starting','running'].includes(panelAttempt.status)),alive=useRef(true);
  const requestEngine=continuation ? current?.execution_mode??(current?.analysis_channel==='dsh'?'dsh':defaultEngine) : defaultEngine;
  const latestWriteScope=attempts.findLast(attempt=>task?.attempt_ids.includes(attempt.attempt_id))?.write_scope;
  const reload=useCallback(async()=>{const values=await api.invoke<EngineeringTask[]>('engineering_tasks',{project_id:project.project_id,cached:true});if(alive.current){taskLists.set(project.project_id,values);setTasks(values);setTasksLoaded(true);setSelectedId(id=>values.some(t=>t.task_id===id)?id:values[0]?.task_id??'');}return values;},[project.project_id]);
  const taskSaved=(saved:EngineeringTask)=>setTasks(list=>list.map(item=>item.task_id===saved.task_id&&item.version<=saved.version?{...item,boundaries:saved.boundaries,version:saved.version,updated_at:saved.updated_at}:item));
  const selectTask=(taskId:string,keepSection=false)=>{
    void api.invoke('reading_save',{key:'engineering-selection/'+project.project_id,value:{task_id:taskId,section:keepSection?section:'tasks'}}).catch(e=>setError(e.message));
    setMode('records');if(!keepSection||!taskId)setSection('tasks');
    setSelectedId(taskId);setHistorical(null);setContinuation(false);setDiff(null);
    if(!taskId)setGoal('');
    if(window.innerWidth<900)requestAnimationFrame(()=>document.querySelector(taskId?'.engineering-requirement-header':'.engineering-list')?.scrollIntoView({block:'start'}));
  };
  const newRequirement=(value='')=>{
    setNotice('');setError('');setMode('new');setHistorical(null);setContinuation(false);setGoal(value);setSection('tasks');
    requestAnimationFrame(()=>goalInput.current?.focus());
  };
  const selectSection=(value:EngineeringSection)=>{setSection(value);void api.invoke('reading_save',{key:'engineering-selection/'+project.project_id,value:{task_id:selectedId,section:value}}).catch(e=>setError(e.message));};
  useEffect(()=>{setMode('records');},[page]);
  useEffect(()=>{if(focusGoal){newRequirement(readingDraft?.initialGoal??'');onGoalFocused();}},[focusGoal,readingDraft]);
  useEffect(()=>{if(requestedTask&&tasksLoaded){selectTask(requestedTask);onTaskOpened();}},[requestedTask,tasksLoaded]);
  useEffect(()=>{let valid=true;void api.invoke('reading_get',{key:'engineering-selection/'+project.project_id}).then(value=>{if(valid&&!requestedTask&&!focusGoal&&value?.task_id){setSelectedId(value.task_id);setSection(['plan','architecture','design','tasks','verification_plan'].includes(value.section)?value.section:'tasks');}}).catch(e=>setError(e.message));return()=>{valid=false;};},[project.project_id]);
  async function decide(snapshot:EngineeringTask,revision?:string,notes?:string[]):Promise<boolean>{
    if(busy||!current)return false;
    if(snapshot.task_id!==current.task_id||snapshot.version!==current.version){setError('任务版本已变化，请重新审阅。');return false;}
    const result=await action(()=>api.invoke('development_start',{project_id:project.project_id,task_id:snapshot.task_id,expected_version:snapshot.version,
      phase:revision?'analysis':'execution',goal:revision??'按已审阅的正式需求包和批准范围执行，完成必要验证并回填。',
      scope:revision?[]:[...(snapshot.proposed_scope??snapshot.scope)],...(notes?.length?{notes}:{}),submission_key:crypto.randomUUID()}),revision?'修订意见已提交到原任务':snapshot.execution_mode==='mcp'?'已确认需求包，等待外部 Agent 领取':'已确认需求包并排队执行');
    return result!==undefined;
  }

  useEffect(()=>{
    alive.current=true;
    if(page==='records')void reload().catch(e=>setError(e.message));
    return()=>{alive.current=false;};
  },[reload,page,context]);
  useEffect(()=>{let valid=true,reading=false;setHistorical(null);setLog(null);setHistory([]);setDiff(null);setAttempts([]);setEvents([]);setDispatches([]);const read=async()=>{if(!selectedId||reading)return;reading=true;try{const value=await api.invoke<{attempts:DevelopmentAttempt[];events:ActivityEvent[]}>('development_events',{task_id:selectedId});if(valid){setAttempts(value.attempts);setEvents(value.events);if(current?.execution_mode&&current.execution_mode!=='codex_desktop')return;const external=await api.invoke<{queue:Dispatch[]}>('executor_status',{project_id:project.project_id});if(valid){setDispatches(external.queue??[]);}}}catch(e){if(valid)setError((e as Error).message);}finally{reading=false;}};void read();const off=api.onEvent(e=>{if(e.type==='development_event'||e.type==='engineering_changed'||e.type==='changed')void read();});const timer=setInterval(()=>void read(),8000);return()=>{valid=false;off();clearInterval(timer);};},[selectedId,current?.execution_mode]);
  async function action(fn:()=>Promise<unknown>,message=''){setBusy(true);setError('');setNotice('');try{const result=await fn();if(alive.current){if(message)setNotice(message);await reload();await reloadContext();}return result;}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}}
  const cannotStart=busy||enginePending||inProgress||project.fictional||context?.workspace.status!=='bound'||!goal.trim();
  async function start(submission?:RequirementSubmission){
    if(cannotStart)return;
    const originalTask=continuation?current?.task_id:undefined;
    const fast=submission?.fast_mode===true;
    const result=await action(()=>api.invoke<EngineeringTask>('development_start',{
      project_id:project.project_id,task_id:originalTask,expected_version:originalTask?current?.version:undefined,goal,
      boundaries:submission&&{non_goals:submission.non_goals,revoked:submission.revoked},
      scope:submission?.scope??[],
      ...(submission?.reading&&!originalTask?{reading:submission.reading}:{}),
      ...(fast?{fast_mode:true}:{phase:'analysis'}),submission_key:crypto.randomUUID(),
    }),fast?'已提交快速直改，执行范围已限定':requestEngine==='mcp'?'需求已保存，等待外部 Agent 领取':'已开始分析影响与待决问题');
    if(result&&alive.current){onClearReadingDraft?.();selectTask((result as EngineeringTask).task_id);setGoal('');}
  }
  async function showHistory(){await action(async()=>{const result=await api.invoke<any[]>('engineering_history',{kind:'task',id:selectedId});setHistory(result.map(value=>value.value??value));});}
  const visible=tasks.filter(t=>(!filter||t.status===filter)&&(!query||[t.goal,t.summary,...t.changes.map(c=>c.path),...t.decisions,...t.unresolved].join('\n').toLowerCase().includes(query.toLowerCase())));
  const ended=!!task&&task.status!=='pending'&&task.status!=='running';
  const versionHud=!historical&&hud?.task_id===task?.task_id&&hud?.version===task?.version?hud:null;
  const hasEvolution=stage==='delivery'&&!!versionHud?.evolution;
  const useEvolutionCockpit=hasEvolution&&!showLegacyGraph;
  const reading=task?.reading;
  const readingAnchor=reading?.evidence;
  const blueprint=versionHud?.blueprintEvolution??(versionHud?.evolution?.mode==='task_blueprint'?versionHud.evolution:undefined);
  const beforeReading=reading&&readingAnchor&&['step','call_step'].includes(reading.target.kind)?blueprint?.features.find(feature=>
    feature.before_result_id===reading.result_id&&feature.before_snapshot_id===reading.source_snapshot_id,
  )?.steps.find(step=>step.id===reading.target.id&&step.file===readingAnchor.path&&step.before_line===readingAnchor.line_start)?.before_text:undefined;
  const appendRequirement=(text='')=>{
    if(stage==='approval'){
      const questionIndex=task?.requirement_package?.open_questions?.indexOf(text)??-1;
      if(questionIndex>=0){
        const reply=document.querySelector<HTMLTextAreaElement>(`.engineering-task-detail textarea[aria-label="回答待确认项 ${questionIndex+1}"]`);
        if(reply&&!reply.disabled){reply.focus();return;}
      }
      const revision=document.querySelector<HTMLDetailsElement>('.engineering-task-detail .hud-revise-details');
      if(revision){
        revision.open=true;
        revision.querySelector('textarea')?.focus();
      }
      return;
    }
    setContinuation(true);
    if(text)setGoal(text);
    requestAnimationFrame(()=>goalInput.current?.focus());
  };
  async function refreshImpactedFeature(scenarioId:string){
    if(!task)return;
    setRefreshingScenarioId(scenarioId);
    try{
      await api.invoke('walkthrough_feature_refresh',{task_id:task.task_id,scenario_id:scenarioId,submission_key:`evo-${crypto.randomUUID().slice(0,16)}`});
      await reloadHud();
    }catch(e){setError((e as Error).message);}
    finally{setRefreshingScenarioId(null);}
  }
  async function runHostChecks(kinds?:('typecheck'|'test'|'build')[]){
    if(!current||runningChecks||busy)return;
    setRunningChecks(true);setError('');setNotice('');
    try{
      const res=await api.invoke<{task:EngineeringTask;receipts:VerificationEvidence[];skipped:string[];failed:{command:string}[]}>('development_run_checks',{
        task_id:current.task_id,...(kinds?.length?{kinds}:{}),
      });
      if(alive.current){
        await reload();await reloadHud();await reloadContext();
        const note=res.failed.length
          ? `工程检查完成：${res.failed.length} 项失败，请查看检查日志。`
          : res.receipts.length
            ? `已执行 ${res.receipts.length} 项工程检查并更新记录（不自动标通过业务场景）。`
            : res.skipped[0]??'未发现可执行的工程检查命令。';
        setNotice(note);
      }
    }catch(e){if(alive.current)setError((e as Error).message);}
    finally{if(alive.current)setRunningChecks(false);}
  }
  async function updateBehaviorContract(input:Omit<UpdateBehaviorContractInput,'task_id'|'expected_version'|'submission_key'>):Promise<boolean>{
    if(!current||busy)return false;
    const saved=await action(()=>api.invoke<EngineeringTask>('engineering_task_behavior_update',{
      ...input,task_id:current.task_id,expected_version:current.version,submission_key:crypto.randomUUID(),
    }),'已更新当前行为的约定与场景');
    if(saved&&alive.current)await reloadHud();
    return saved!==undefined;
  }
  async function reviseBehavior(input:Omit<PrepareBehaviorRevisionInput,'task_id'|'expected_version'|'submission_key'>):Promise<boolean>{
    if(!current||busy)return false;
    const saved=await action(()=>api.invoke<EngineeringTask>('development_revise_behavior',{
      ...input,project_id:project.project_id,task_id:current.task_id,expected_version:current.version,submission_key:crypto.randomUUID(),
    }),current.execution_mode==='mcp'?'已保存行为修订，等待外部 Agent 领取处理':'已提交给执行器定向处理此项行为，完成后新结果将回到同一张场景表');
    if(saved&&alive.current)await reloadHud();
    return saved!==undefined;
  }
  async function loadDiffInDrawer(targetPath:string){
    if(!task||historical)return;
    setInspectDrawer({kind:'changes',activePath:targetPath});
    try{
      const nextDiff=await api.invoke<{path:string;before:string;after:string;truncated:boolean}>('engineering_diff',{task_id:task.task_id,path:targetPath});
      if(alive.current)setDiff(nextDiff);
    }catch(e){if(alive.current)setError((e as Error).message);}
  }
  function openChangesDrawer(file?:string){
    if(!task)return;
    const diffable=task.changes_status!=='needs_review'?task.changes.filter(c=>!c.text_diff_unavailable):[];
    const chosen=(file&&diffable.some(c=>c.path===file)?file:undefined)??diffable[0]?.path;
    setInspectDrawer({kind:'changes',activePath:chosen});
    if(chosen&&!historical)void loadDiffInDrawer(chosen);
  }
  function openVerificationLog(path:string,title='验证日志',subtitle?:string){
    if(!task)return;
    const taskId=task.task_id;
    setInspectDrawer({kind:'log',title,subtitle,text:'',loading:true});
    void api.invoke<{text:string}>('engineering_log',{task_id:taskId,path}).then(result=>{
      if(!alive.current)return;
      setLog({taskId,text:result.text});
      setInspectDrawer({kind:'log',title,subtitle,text:result.text,loading:false});
    }).catch(e=>{
      if(!alive.current)return;
      setError((e as Error).message);
      setInspectDrawer(null);
    });
  }
  return <main className="engineering-workspace" aria-label="开发与工程记录">
    <div className={`engineering-toolbar${(mode==='records'&&task)||mode==='materials'?' is-compact':''}`}>
      <div className="eng-toolbar-title-wrap">
        <h2>{mode==='materials'?'工程资料':'需求与开发'}</h2>
        {mode==='materials'&&context&&<span className="bw-version-tag">v{context.version} · {context.total_entries} 条</span>}
        {mode!=='materials'&&!task&&<p>从提出需求，到看清业务变更与证据、拍板推进。</p>}
      </div>
      {mode==='materials'?<div className="row engineering-toolbar-actions">
        <button type="button" disabled={busy||checking||!context} onClick={()=>void reloadContext(true)}>{checking?'正在检查…':'检查来源变化'}</button>
        <button type="button" className="primary" disabled={busy||!context} onClick={()=>setMaterialCreateTick(v=>v+1)}><span aria-hidden="true">＋ </span>新增项目资料</button>
      </div>:<div className="row engineering-toolbar-actions">
        {tasks.length>0&&<button type="button" onClick={()=>setTaskDrawerOpen(true)}>切换任务 ({tasks.length}) ▾</button>}
        <button className="primary" onClick={()=>mode==='new'?goalInput.current?.focus():newRequirement()}><span aria-hidden="true">＋ </span>提出新需求</button>
      </div>}
    </div>

    {(error||contextError)&&<p className="warning engineering-message" role="alert">{error||contextError}</p>}
    {notice&&<div className="engineering-notice-bar" role="status"><span>{notice}</span><button type="button" className="bw-inline-link" aria-label="关闭提示" onClick={()=>setNotice('')}>✕</button></div>}
    {context?.workspace.status==='unbound'&&<p className="warning engineering-message">历史记录已恢复，但源码工作区尚未绑定。请到「连接 Agent → 工程管理与本地数据 → 接入与恢复」选择实际目录；恢复记录不等于恢复工程代码。</p>}
    {(mode==='materials'||showContext)&&!context&&!contextError&&<section className="engineering-context-panel engineering-materials-home"><div className="arc-skeleton-box" role="status"><span className="arc-skeleton-line wide" aria-hidden="true"/><span className="arc-skeleton-line medium" aria-hidden="true"/><span className="arc-skeleton-line short" aria-hidden="true"/><small>正在读取工程资料与当前工作区；大工程可能需要一些时间。</small></div></section>}
    {(mode==='materials'||showContext)&&context&&<section className={`engineering-context-panel ${mode==='materials'?'engineering-materials-home':''}`}><ContextFacts context={context} reload={reloadContext} onMore={more} onRefreshSource={()=>void reloadContext(true)} checking={checking} createTrigger={materialCreateTick}/></section>}

    {mode!=='materials'&&taskDrawerOpen&&<div className="eng-task-drawer-backdrop" onClick={()=>setTaskDrawerOpen(false)}>
      <aside className="eng-task-drawer" aria-label="切换开发记录" onClick={e=>e.stopPropagation()}>
        <div className="engineering-list-heading">
          <div><h3>开发记录</h3><span className="tag">{visible.length}</span></div>
          <button type="button" className="hud-drawer-close" aria-label="关闭任务列表" onClick={()=>setTaskDrawerOpen(false)}>✕</button>
        </div>
        {tasks.length>0?<><div className="engineering-list-filters">
            <input type="search" aria-label="搜索工程记录" placeholder="搜索开发记录" value={query} onChange={e=>setQuery(e.target.value)}/>
            <select aria-label="工程记录状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">所有状态</option>{['pending','running','completed','failed','blocked','cancelled','interrupted'].map(state=><option key={state} value={state}>{stateNames[state]}</option>)}</select>
          </div>
          <div className="engineering-task-list">{visible.map(item=>{
            const selected=mode==='records'&&selectedId===item.task_id;
            const delivery=taskDetailStage(item)==='delivery';
            return <button key={item.task_id} className={`engineering-task-row ${selected?'selected':''}`} data-task-status={item.status} data-verification-status={item.verification_status} aria-pressed={selected} onClick={()=>{selectTask(item.task_id);setTaskDrawerOpen(false);}}>
              <strong title={item.goal}>{item.goal}</strong>
              <span className="engineering-task-meta">
                <i className="task-status-dot" aria-hidden="true"/>
                <span className="engineering-task-status">{workflowLabel(item)}{delivery&&' · '+verificationLabels[item.verification_status]}</span>
                <time dateTime={item.updated_at} title={when(item.updated_at)}>{compactTimestamp(item.updated_at)}</time>
                {delivery&&<span>{item.changes.length} 文件</span>}
              </span>
            </button>;
          })}{!visible.length&&<p className="muted">暂无符合条件的记录。</p>}</div></>:
          tasksLoaded&&<div className="engineering-list-empty"><strong>暂无开发记录</strong><p>提交后，可在这里查看需求、方案、架构与功能变动。</p></div>}
      </aside>
    </div>}

    {mode!=='materials'&&<div className="engineering-columns is-full-width"><section className="engineering-task-detail" key={mode==='new'?'new':selectedId} aria-label="工程任务详情"
      onFocusCapture={mode==='new'?()=>setMode('new'):undefined}>
      {mode==='new'||!task?<RequirementComposer projectId={project.project_id} disabledProject={project.fictional} context={context} snapshotFiles={snapshotFiles}
        readingDraft={readingDraft} onClearReadingDraft={onClearReadingDraft} featureOptions={featureOptions}
        defaultEngine={defaultEngine} codexModel={codexModel} onEngineChange={onEngineChange} enginePending={enginePending}
        onSettings={onSettings} goal={goal} onGoalChange={setGoal} goalInput={goalInput} busy={busy} disabled={cannotStart}
        onSubmit={start} onCancel={tasks.length?()=>selectTask((current??visible[0]??tasks[0]).task_id):undefined}/>:<>
        {waitingMcp&&!historical&&<p className="engineering-message" role="status">等待外部 Agent 领取。在已接入 ARC MCP 的对话中领取任务 <code>{task.task_id}</code>。 <button onClick={onSettings}>连接 Agent</button></p>}
        {section!=='tasks'?<EngineeringSections taskId={selectedId} projectId={project.project_id} section={section} onSection={selectSection} tasks={tasks} onTask={id=>selectTask(id,true)} onArchitecture={onArchitecture} onDevelop={newRequirement}/>:<>
        {continuation&&!historical&&stage!=='approval'&&<form className="development-form continuation-card" onSubmit={e=>{e.preventDefault();void start();}}>
          <div className="row between"><h3>继续当前任务</h3><small>{analysisModes[requestEngine].name} · 只读分析</small></div>
          {inProgress&&<p className="muted">当前执行仍使用已读取的要求。执行结束后可提交此处草稿。</p>}
          <label htmlFor="development-goal">补充要求或修复目标</label>
          <textarea ref={goalInput} id="development-goal" aria-label="开发任务" value={goal} onChange={e=>setGoal(e.target.value)} required
            placeholder="结合下方记录，写下这次要解决的问题和验收条件。" onKeyDown={e=>{if(e.ctrlKey&&e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
          <div className="row"><button className="primary" disabled={cannotStart}>分析需求</button>
            <button type="button" disabled={busy} onClick={()=>newRequirement(goal)}>改为新任务</button>
            <button type="button" disabled={busy} onClick={()=>setContinuation(false)}>取消</button></div>
        </form>}
        {history.length>0&&<label className="engineering-version-picker">查看记录版本<select aria-label="工程任务版本" value={historical?.version??''} onChange={e=>setHistorical(history.find(item=>item.version===Number(e.target.value))||null)}><option value="">当前版本</option>{history.map(item=><option key={item.version} value={item.version}>v{item.version} · {stateNames[item.status]} · {when(item.updated_at)}</option>)}</select></label>}
        {task.origin==='legacy_import'&&<p className="warning">AEC 历史任务 · 待复核。原文与来源已保存，旧验证声明不视为本次真实执行。</p>}
        <TaskBehaviorCockpit
          key={task.task_id}
          task={task}
          environment={environment}
          hud={versionHud}
          liveCodeState={!historical?context?.code_state:undefined}
          beforeReading={beforeReading}
          historical={!!historical}
          busy={busy}
          runningChecks={runningChecks}
          attemptsCount={attempts.length}
          liveActivitySlot={!historical&&stage!=='approval'&&(inProgress||stage==='analysis')&&(stage==='analysis'||latestDispatch||panelAttempt)
            ? <DevelopmentActivity key={`${stage}:${ended}:${latestDispatch?.dispatch_id||panelAttempt?.attempt_id||task.task_id}`} dispatch={latestDispatch} attempt={panelAttempt} task={task} events={events} onSettings={onSettings}/>
            : undefined}
          planSlot={stage==='approval'&&!historical
            ? <PlanDecision key={task.task_id} task={task} hud={hud} hudLoading={hudLoading} hudError={hudError} busy={busy} error={error} onTaskSaved={taskSaved} onOpenArchitectureOverlay={onArchitectureOverlay} onDecision={(snapshot,revision,notes)=>decide(snapshot,revision,notes)}/>
            : undefined}
          onOpenReading={readingAnchor&&!historical?()=>onReading(task):undefined}
          onViewChanges={file=>openChangesDrawer(file)}
          onViewVerification={evidenceId=>{
            const receipt=evidenceId?task.verification.find(item=>item.evidence_id===evidenceId):undefined;
            if(receipt?.log_path){
              openVerificationLog(receipt.log_path,`${verificationEvidenceLabel(receipt)} · ${receipt.command.split('\n')[0]}`,`${receipt.origin==='observed'?'已观测命令执行':'Agent 上报'} · exit ${receipt.exit_code??'未取得'} · ${when(receipt.created_at)}`);
              return;
            }
            revealTaskRecord(evidenceId?`${task.task_id}-receipt-${evidenceId}`:`${task.task_id}-verification`);
          }}
          onOpenEvolution={hasEvolution?()=>{
            setShowEvolution(true);setShowLegacyGraph(false);
            requestAnimationFrame(()=>revealTaskRecord(`${task.task_id}-evolution`));
          }:undefined}
          onOpenLogs={()=>revealTaskRecord(`${task.task_id}-verification`)}
          onOpenHistory={()=>{selectSection('tasks');void showHistory();}}
          onOpenPackage={()=>revealTaskRecord(`${task.task_id}-package`)}
          onApprovePlan={stage==='approval'&&current?()=>void decide(current):undefined}
          onCancelTask={inProgress&&current?()=>void action(()=>api.invoke('development_cancel',{task_id:current.task_id}),'停止请求已发送，实际终态见记录'):undefined}
          onRunHostChecks={!historical&&current?kinds=>runHostChecks(kinds):undefined}
          onUpdateBehaviorContract={!historical&&current?updateBehaviorContract:undefined}
          onReviseBehavior={!historical&&current?reviseBehavior:undefined}
          onAppend={historical||stage==='approval'&&!task.requirement_package?undefined:appendRequirement}
        />
        {stage==='delivery'&&showEvolution&&useEvolutionCockpit&&(
          <section id={`${task.task_id}-evolution`} className="behavior-record-target task-additional-records" tabIndex={-1} aria-label="修改位置、调用与架构演化">
          <div className="row between" style={{marginBottom:8}}>
            <strong>修改位置与调用演化</strong>
            <button type="button" className="hud-mini-btn" onClick={()=>setShowEvolution(false)}>收起视图</button>
          </div>
          <EvolutionCockpit
            evolution={hud!.evolution!}
            blueprintEvolution={hud!.blueprintEvolution}
            revisionKey={`${task.task_id}:${task.version}`}
            foldSummary
            modeLabel={`v${task.version}`}
            loadFileDiff={async req => {
              const beforeSnap = hud!.evolution!.base_snapshot_id ?? (task.diff_baseline ?? task.baseline).snapshot_id;
              const afterSnap = hud!.evolution!.target_snapshot_id ?? task.end_state?.snapshot_id;
              const inTaskChanges = task.changes_status !== 'needs_review' && task.changes.some(c => c.path.replaceAll('\\', '/') === req.path);
              const matchesTaskWindow = !req.snapshotId || req.snapshotId === beforeSnap || req.snapshotId === afterSnap;
              if (inTaskChanges && matchesTaskWindow && req.preferFrozen !== true) {
                return api.invoke<EvolutionFileDiff>('engineering_diff', { task_id: task.task_id, path: req.path });
              }
              const snapId = req.snapshotId ?? (req.side === 'before' ? beforeSnap : afterSnap ?? beforeSnap);
              const src = await api.invoke<{ text: string }>('source', { source_snapshot_id: snapId, path: req.path });
              return { path: req.path, before: src.text, after: src.text, truncated: false };
            }}
            openInEditor={(file,line)=>api.invoke('workspace_open_file',{project_id:project.project_id,path:file,line:line??1,editor:'vscode'})}
            onOpenArchitectureOverlay={
              onArchitectureOverlay && hud!.impact.architecture_nodes.length > 0
                ? resultId => onArchitectureOverlay({
                    taskId: task.task_id,
                    goal: task.goal,
                    resultId: resultId ?? hud!.impact.architecture_result_id,
                    nodes: new Map(hud!.impact.architecture_nodes.map(n => [n.node_id, n.relation])),
                  })
                : undefined
            }
            onRefreshFeature={sid=>void refreshImpactedFeature(sid)}
            refreshingScenarioId={refreshingScenarioId}
            onViewAllFiles={file=>{
              const detailsEl = document.getElementById(`${task.task_id}-changes`) as HTMLDetailsElement | null;
              if (detailsEl) { detailsEl.open = true; detailsEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
              if (file) void action(async()=>setDiff(await api.invoke('engineering_diff',{task_id:task.task_id,path:file})));
            }}
            footerActions={<>
              <RollbackAction key={task.task_id+':'+task.version} task={task} readOnly={!!historical} busy={busy} onRollback={()=>
                void action(()=>api.invoke('engineering_rollback',{task_id:task.task_id}),'已撤销本次改动')
              }/>
              <button type="button" className="hud-mini-btn" onClick={()=>setShowLegacyGraph(true)}>旧版调用图</button>
            </>}
          />
          </section>
        )}
        {stage==='delivery'&&showEvolution&&!useEvolutionCockpit&&(!historical ? (
          <section id={`${task.task_id}-evolution`} className="behavior-record-target task-additional-records" tabIndex={-1}>
            <div className="row between" style={{marginBottom:8}}>
              {hud?.evolution&&<button type="button" className="hud-mini-btn" onClick={()=>setShowLegacyGraph(false)}>← 返回演化视图</button>}
              <button type="button" className="hud-mini-btn" onClick={()=>setShowEvolution(false)}>收起视图</button>
            </div>
            <DeliveryHud task={task} hud={hud} entries={context?.material_sources??context?.entries??[]} onRefreshMaterials={()=>reloadContext(true)} busy={busy} onReloadHud={reloadHud} onOpenArchitectureOverlay={onArchitectureOverlay} onTargetedContinue={prefill=>{selectSection('tasks');setContinuation(true);setGoal(prefill);requestAnimationFrame(()=>goalInput.current?.focus());}}/>
          </section>
        ) : (
          <DeliveryAuditBar key={`audit:${task.task_id}`} task={task} entries={context?.material_sources??context?.entries??[]} onRefresh={()=>reloadContext(true)} busy={true}/>
        ))}
        <details id={`${task.task_id}-changes`} className="task-additional-records behavior-record-target" tabIndex={-1}>
          <summary>修改文件与 Diff · {task.changes.length} 个文件{attempts.length?` · ${attempts.length} 次执行`:''}</summary>
          <div style={{marginTop:10}}>
            <div className="row between" style={{marginBottom:8}}>
              <span className="tag">{task.changes.length} 个文件</span>
              <RollbackAction key={`d:${task.task_id}:${task.version}`} task={task} readOnly={!!historical} busy={busy} onRollback={()=>
                void action(()=>api.invoke('engineering_rollback',{task_id:task.task_id}),'已撤销本次改动')
              }/>
            </div>
            {task.changes_status==='needs_review'&&<p className="warning">差异归属待核查，不能自动把当前全部差异归为本任务成果。</p>}
            {task.changes_status!=='needs_review'&&task.changes.length>0?<><ul className="engineering-changes">{task.changes.map(change=><li key={change.path}><div className="engineering-change-info"><strong>{change.path}</strong>{change.ownership==='preexisting_overlap'&&<span className="warning">含开始前已有改动，不能全部归为本任务</span>}<small>{change.before_sha256?.slice(0,12)||'新增'} → {change.after_sha256?.slice(0,12)||'删除'}</small></div><div className="engineering-change-action">{change.text_diff_unavailable?<small>仅记录内容哈希</small>:<button disabled={!!historical} onClick={()=>void action(async()=>setDiff(await api.invoke('engineering_diff',{task_id:task.task_id,path:change.path})))}>查看 Diff</button>}</div></li>)}</ul>{diff&&<TextDiffView path={diff.path} before={diff.before} after={diff.after} truncated={diff.truncated} onClose={()=>setDiff(null)}/>}</>:!inProgress&&<p className="muted">尚未捕获到可归属于本任务的文件变更。</p>}
            {attempts.length>0&&<details style={{marginTop:10}}><summary>执行与活动 · {attempts.length} 次</summary>{attempts.map(item=><p key={item.attempt_id}>{item.provider_id} · {item.model} · {stateNames[item.status]}{item.error&&<span className="warning"> · {item.error}</span>}{item.log_path&&<button onClick={()=>openVerificationLog(item.log_path!)}>查看执行诊断</button>}</p>)}<ol className="engineering-events">{events.filter(event=>publicActivity(event)).slice(-30).map((event,i)=><li key={i}><small>{when(event.received_at)}</small><p>{publicActivity(event)}</p></li>)}</ol></details>}
          </div>
        </details>
        <details id={`${task.task_id}-verification`} className="task-additional-records behavior-record-target" tabIndex={-1}>
          <summary>验证日志与历史轮次 · {task.verification.length} 条记录{task.unresolved.length?` · ${task.unresolved.length} 项待处理`:''}</summary>
          <div style={{marginTop:10}}>
            {!task.verification.length?<p className="muted">尚未保存验证记录，不能视为通过。</p>:<VerificationList task={task} onLog={openVerificationLog}/>}
            {task.unresolved.length>0?<div className="task-unresolved"><h4>待处理事项 · {task.unresolved.length}</h4><ul>{task.unresolved.map((item,i)=><li key={i}>{item}</li>)}</ul></div>:<p className="task-no-unresolved">没有单独记录的遗留事项；仍以实际验证覆盖范围为准。</p>}
            {logText&&<section id={`${task.task_id}-verification-log`} className="engineering-log behavior-record-target" tabIndex={-1}><div className="row between"><h3>验证日志</h3><button onClick={()=>setLog(null)}>关闭日志</button></div><pre>{logText}</pre></section>}
          </div>
        </details>
        {(stage!=='approval'||historical)&&task.requirement_package&&<div id={`${task.task_id}-package`} className="behavior-record-target" tabIndex={-1}><SavedRequirementPackage key={`pkg:${task.task_id}`} task={task} readOnly={!!historical} onSaved={taskSaved}/></div>}
        {(() => {
          const detailSections = <>
            <details id={`${task.task_id}-goal`} className="task-model-section task-model-goal"><summary>任务边界与原始要求</summary><TaskBoundaries key={`boundaries:${task.task_id}`} task={task} readOnly={!!historical} onSaved={taskSaved}/><details><summary>原始要求与接续记录 · {task.fast_mode?'ARC 快速直改':task.workflow?'从 ARC 发起':'沿用 Agent / 原有任务入口'}</summary>{task.requests?.map(item=><p key={item.submission_key}>{item.text}</p>)}<small>任务 {task.task_id}</small></details></details>
            <details id={`${task.task_id}-context`} className="task-model-section"><summary>现状与依据</summary>{task.summary&&<div className="engineering-summary"><ContextText text={task.summary}/></div>}<details className="task-technical-details"><summary>工作区、代码基线与关联走读</summary><dl className="engineering-metadata"><dt>工作区</dt><dd>{task.workspace_path}</dd><dt>开始基线</dt><dd>{task.baseline.head||'非 Git 工程'}{task.baseline.branch?` · ${task.baseline.branch}`:''}<br/><small>{task.baseline.fingerprint}</small></dd><dt>开始前已有改动</dt><dd>{task.baseline.dirty.length?task.baseline.dirty.join('、'):'无已识别的未提交改动'}</dd><dt>上下文版本</dt><dd>{task.context_version}</dd>{task.reading&&<><dt>功能走读</dt><dd>原说明 {task.reading.result_id}<br/><small>原快照 {task.reading.source_snapshot_id} · 选中 {task.reading.target.kind}:{task.reading.target.id}</small><br/>{task.walkthrough?`走读更新：${({pending:'等待更新',running:'正在更新',completed:'新版已保存',failed:'更新失败'} as const)[task.walkthrough.status]}`:'尚未触发走读更新'}{task.walkthrough?.error&&<p className="warning">{task.walkthrough.error}</p>}</dd></>}<dt>差异覆盖</dt><dd>{task.changes_status==='needs_review'?'差异归属待核查':task.baseline.workspace_fingerprint?'工作区文件内容。二进制和超限文件记录哈希，忽略目录与凭据排除。':'历史基线仅覆盖阅读快照的文本文件。'}</dd></dl></details></details>
            <details id={`${task.task_id}-plan`} className="task-model-section"><summary>影响与方案</summary><div className="task-impact-facts"><span>范围 {(latestWriteScope??task.proposed_scope??task.scope).length} 个文件</span><span>已有改动重叠 {task.changes.filter(change=>change.ownership==='preexisting_overlap').length} 项</span><span>风险与遗留 {task.unresolved.length} 项</span></div>{!!task.steps?.length?<div className="development-steps" aria-label="修改方案与步骤">{task.steps.map(step=><article className={`development-step ${step.status==='superseded'?'superseded':''}`} data-step-id={step.step_id} key={step.step_id}><div className="row between"><strong>{step.title}</strong><span className="tag">{stepStateNames[step.status]}</span></div><p>{step.change}</p><p className="development-step-progress">{step.progress}</p><small>检查：{stateNames[step.verification_status??'not_run']}</small><ul>{step.criteria.map(criterion=><li data-criterion-id={criterion.criterion_id} key={criterion.criterion_id}>{criterion.text}<small>{criterion.evidence_ids.length?` · ${criterion.evidence_ids.length} 条关联证据`:' · 尚无证据'}</small></li>)}</ul>{step.unresolved.length>0&&<ul className="warning">{step.unresolved.map((item,index)=><li key={index}>{item}</li>)}</ul>}</article>)}</div>:<p className="muted">尚未保存实施步骤。</p>}{!!latestWriteScope?.length&&<details><summary>本次允许修改 · {latestWriteScope.length} 个文件</summary><ul>{latestWriteScope.map(file=><li key={file}><code>{file}</code></li>)}</ul></details>}{task.decisions.length>0&&<details><summary>修改依据与关键决定 · {task.decisions.length}</summary><ul>{task.decisions.map((item,i)=><li key={i}>{item}</li>)}</ul></details>}</details>
            <details className="task-additional-records"><summary>补充资料与独立文档</summary><p>简单任务无需单独文档。确有需要时，再补充实施方案、架构变更、详细设计或验证计划。</p><div className="row">{([['plan','实施方案'],['architecture','架构变更'],['design','详细设计'],['verification_plan','验证计划']] as [EngineeringSection,string][]).map(([id,label])=><button key={id} onClick={()=>selectSection(id)}>{label}</button>)}</div></details>
          </>;
          return <details className="task-additional-records"><summary>更多技术记录、工作区基线与独立文档</summary>{detailSections}</details>;
        })()}
        </>}
      </>}
    </section></div>}

    {mode==='records'&&task&&inspectDrawer&&<div className="eng-inspect-backdrop" onClick={()=>setInspectDrawer(null)}>
      <aside className="eng-inspect-drawer" role="dialog" aria-modal="true" aria-label={inspectDrawer.kind==='changes'?'修改文件与代码 Diff':'验证执行日志'} onClick={e=>e.stopPropagation()}>
        <header className="eng-inspect-head">
          <div>
            <h3>{inspectDrawer.kind==='changes'?`修改文件与 Diff（${task.changes.length}）`:inspectDrawer.title}</h3>
            {inspectDrawer.kind==='log'&&inspectDrawer.subtitle&&<small>{inspectDrawer.subtitle}</small>}
          </div>
          <div className="row">
            {inspectDrawer.kind==='changes'&&<RollbackAction key={`drawer:${task.task_id}:${task.version}`} task={task} readOnly={!!historical} busy={busy} onRollback={()=>{setInspectDrawer(null);void action(()=>api.invoke('engineering_rollback',{task_id:task.task_id}),'已撤销本次改动');}}/>}
            <button type="button" className="hud-drawer-close" aria-label="关闭检查抽屉" onClick={()=>setInspectDrawer(null)}>✕</button>
          </div>
        </header>
        <div className="eng-inspect-body">
          {inspectDrawer.kind==='changes'?(
            task.changes_status==='needs_review'?<p className="warning">差异归属待核查，不能自动把当前全部差异归为本任务成果。</p>:
            task.changes.length>0?<>
              <div className="eng-inspect-file-tabs" role="tablist" aria-label="修改的文件">
                {task.changes.map(change=>{
                  const active=inspectDrawer.activePath===change.path;
                  return <button key={change.path} type="button" role="tab" aria-selected={active} className={`eng-inspect-file-tab${active?' is-active':''}`} disabled={!!historical||change.text_diff_unavailable} onClick={()=>void loadDiffInDrawer(change.path)}>
                    <code>{change.path}</code>
                    {change.ownership==='preexisting_overlap'&&<small className="warning">含重叠</small>}
                  </button>;
                })}
              </div>
              {diff&&diff.path===inspectDrawer.activePath
                ? <TextDiffView path={diff.path} before={diff.before} after={diff.after} truncated={diff.truncated} onClose={()=>setInspectDrawer(null)}/>
                : <p className="muted">{historical?'历史版本暂不支持实时 Diff。':'正在加载文件 Diff…'}</p>}
            </>:<p className="muted">尚未捕获到可归属于本任务的文件变更。</p>
          ):(
            inspectDrawer.loading?<p className="muted">正在读取验证日志…</p>:<pre className="eng-inspect-log">{inspectDrawer.text||'(空日志)'}</pre>
          )}
        </div>
      </aside>
    </div>}
  </main>;
}
