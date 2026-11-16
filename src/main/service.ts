import fs from 'node:fs/promises';
import path from 'node:path';
import type { Project, Scenario, Feature, Revision, Annotation, Snapshot, Run, Explanation, ProviderProfile, WorkspaceData, ReadingState, AnalysisResult, ReadingAsk, ReadingQuestion, ReadingAnswer } from '../shared';
import { Store, id, now } from './store';
import { capture, readSource, freshness, sha } from './snapshot';
import { probeProviders, runCodex, makePrompt, redact, stopTree, overviewPhaseDirectory, type OverviewPhase, type ActiveProcess } from './providers';
import { normalizeTransport, validateResult } from './validation';
import {probeDsh,runDsh,dshFinalMessage,parseProviderText} from './dsh';
import {runDshWeb,dshWebSessionUrl,closeDshWebHosts} from './dsh-web';
import {discoveredFeature} from '../discovered-feature';
import {buildReadingContext,readingTarget,promptContext} from './prompt-context';
import {validateReadingAnswer} from './reading-question';
import {overviewDiscoveryQuestion} from './architecture-analysis';
import {prepareOverview} from './overview-result';
import {makeOverviewReviewPrompt,applyOverviewReview,parseOverviewReview,type OverviewReview} from './overview-review';
import {makeOverviewResearchPrompt,applyOverviewResearch} from './overview-research';
import {EngineeringService} from './engineering-service';
import {DevelopmentService} from './development-service';
export const terminal=new Set(['completed','failed','cancelled','blocked_external']);
const oldOverviewQuestion='分析整个授权快照的工程全貌：主要职责与模块边界用 stage 节点，内部函数使用 parent_node_id 关联，目录/文件用途必须有依据。列出模块、外部依赖组件及使用位置；依赖使用 dependency，不能当作运行时调用。版本仅引用清单或锁文件。明确未分析范围、构建条件、缺失实现；不根据目录名猜职责。';
const architectureOverviewQuestion='分析授权快照的系统架构，先说明系统由哪些实际组件组成、如何通信和存储数据。返回 architecture.node_ids 与 architecture.edge_ids，引用 nodes/edges 中的高层组件和连接；不预设一定有前端、后端或数据库。组件标签注明已证实的语言/技术，关系标签注明 HTTP/HTTPS、SQL、文件读写等有依据的协议或访问方式；未知写未知，不能把 SQLite 猜成 MySQL，也不能把库依赖当网络服务。内部模块用 parent_node_id 归属组件，支持点击组件再深入；模块目录用途、外部依赖、版本及每条关系均给出准确源码依据。架构关系不是调用时序，保留关键调用、输入输出与未分析范围。';
const previousOverviewQuestion=architectureOverviewQuestion+' 首次分析采用轻量发现：查阅页面导航、入口、路由、说明等，列出当前能确认的全部业务功能，按业务区域放入 feature_catalog.groups；scope 写明已查范围和未覆盖部分。功能目录引用独立 kind=stage 节点，仅名称、一句话用途及源码依据，inputs/outputs 可为空；不要展开每个功能的内部调用、完整流程或所有异常。后续用户点击功能时再单独深入。不能只列出用户已手动创建的功能，不能把文件或技术模块冒充业务功能。';
export const overviewQuestion=overviewDiscoveryQuestion;
const text=(value:unknown,max=20000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`请输入 1–${max} 个字符`);return value.trim();};
export class ArcService {
  readonly store:Store;
  readonly engineering:EngineeringService;
  readonly development:DevelopmentService;
  dispatchRun?: (run:Run)=>void;
  readonly active=new Map<string,ActiveProcess>();
  readonly indexing=new Map<string,AbortController>();
  readonly executing=new Map<string,Promise<void>>();
  private closing=false;
  private asking=new Map<string,Promise<ReadingQuestion>>();
  private checkingCodex?:Promise<ProviderProfile[]>;
  private readonly refreshingTasks=new Map<string,Promise<void>>();
  private readonly refreshGenerations=new Map<string,string>();
  private readonly externalWalkthroughs=new Map<string,{taskId:string;resolve:()=>void}>();
  private readonly queuedWalkthroughs=new Map<string,{submissionKey?:string;promise:Promise<void>;resolve:()=>void}>();
  constructor(readonly directory:string,readonly resources:string,readonly emit:(e:any)=>void=()=>{},private readonly codexRunner:typeof runCodex=runCodex) {
    this.store=new Store(directory);
    this.engineering=new EngineeringService(this.store,()=>this.changed());
    this.engineering.onTaskFinished=task=>{void this.refreshTaskWalkthrough(task.task_id);};
    this.development=new DevelopmentService(this.engineering,this.store,resources,event=>this.emit(event));
    for(const run of this.store.all<Run>('run'))if(!terminal.has(run.status)&&!['unknown','waiting_agent'].includes(run.status)){run.status='unknown';run.error='Arc 上次退出前未记录终态；不会自动重发。请核查原会话，或明确新建关联重试。';this.store.put('run',run.binding.run_id,run);}
    for(const task of this.store.all<import('../engineering').EngineeringTask>('engineering_task'))if(task.walkthrough?.status==='running'){
      const update=task.walkthrough,run=update.run_id?this.store.maybe<Run>('run',update.run_id):null,explanation=run&&this.store.all<Explanation>('explanation').find(e=>e.result.binding.run_id===run.binding.run_id);
      this.engineering.saveWalkthrough(task.task_id,run?.status==='completed'&&explanation?{...update,status:'completed',result_id:explanation.result_id,updated_at:now()}:{...update,status:'failed',error:'ARC 重启前走读更新未保存终态；旧说明和开发成果保留，可重试。',updated_at:now()},update.update_id);
    }
  }
  data():WorkspaceData {
    return {projects:this.store.all('project'),features:this.store.all('feature'),scenarios:this.store.all('scenario'),revisions:this.store.all('revision'),annotations:this.store.all('annotation'),runs:this.store.all('run'),explanations:this.store.all('explanation'),providers:this.store.all('provider'),snapshots:this.store.all('snapshot'),questions:this.store.all('reading_question'),development_tasks:this.engineering.tasks(),requested_analysis:this.store.maybe('setting','mcp-requested-analysis')??undefined};
  }
  changed(){this.emit({type:'changed'});}
  async openProject(rootPath:string,fictional=false,buildConfig='') {
    const real=await fs.realpath(rootPath);
    const exists=this.store.all<Project>('project').find(p=>p.root_path.toLowerCase()===real.toLowerCase()&&p.fictional===fictional);
    if(exists){await this.checkFreshness(exists.project_id);if(!fictional)await this.engineering.connect(exists.project_id);return exists;}
    const projectId=id('project'),controller=new AbortController();this.indexing.set(projectId,controller);
    this.emit({type:'indexing',project_id:projectId,project_name:path.basename(real),root_path:real,count:0});
    try {
      const snapshot=await capture(real,projectId,this.directory,buildConfig,controller.signal,n=>this.emit({type:'indexing',project_id:projectId,project_name:path.basename(real),root_path:real,count:n}));
      const project:Project={project_id:projectId,name:path.basename(real),root_path:real,snapshot_id:snapshot.source_snapshot_id,fictional,build_config:buildConfig,created_at:now()};
      this.store.transaction(()=>{this.store.put('project',projectId,project);this.store.put('snapshot',snapshot.source_snapshot_id,snapshot);});
      if(!fictional)await this.engineering.connect(projectId);
      this.changed();return project;
    }finally{this.indexing.delete(projectId);this.emit({type:'index_done',project_id:projectId});}
  }
  cancelIndex(projectId:string){this.indexing.get(projectId)?.abort();}
  overview(projectId:string){
    const project=this.store.get<Project>('project',projectId);
    if(project.overview_scenario_id){
      let scene=this.store.get<Scenario>('scenario',project.overview_scenario_id);
      // Upgrade only our untouched default when a new overview is explicitly requested.
      // Existing results retain their original question revision.
      if([oldOverviewQuestion,architectureOverviewQuestion,previousOverviewQuestion].includes(scene.question)){
        scene=this.reviseScenario(scene.scenario_id,overviewQuestion);
        if(scene.title==='工程全貌 · 模块、目录用途与依赖')scene.title='工程全貌 · 系统架构';
        this.store.put('scenario',scene.scenario_id,scene);this.changed();
      }
      return scene;
    }
    const {scenario}=this.addFeature(projectId,'工程全貌',overviewQuestion);
    scenario.title='工程全貌 · 系统架构';
    this.store.transaction(()=>{this.store.put('scenario',scenario.scenario_id,scenario);project.overview_scenario_id=scenario.scenario_id;this.store.put('project',projectId,project);});
    this.changed();return scenario;
  }
  addFeature(projectId:string,name:string,question?:string,discovery?:Feature['discovery']) {
    this.store.get('project',projectId);
    const feature:Feature={feature_id:id('feature'),project_id:projectId,name:text(name,300),archived:false,sort_order:this.store.all('feature').length};
    return this.store.transaction(()=>{
      if(discovery)feature.discovery=discovery;
      this.store.put('feature',feature.feature_id,feature);
      const scenario=this.addScenario(feature.feature_id,question?.trim()||`整体走读「${feature.name}」：关键职责、调用、输入输出、依据和未确认范围。`);
      if(discovery||!question?.trim()){scenario.kind='feature_overview';scenario.title=`${feature.name} · 整体走读`;this.store.put('scenario',scenario.scenario_id,scenario);}
      this.changed();return {feature,scenario};
    });
  }
  openDiscoveredFeature(projectId:string,resultId:string,nodeId:string,requestMcp=false) {
    const project=this.store.get<Project>('project',projectId),explanation=this.store.get<Explanation>('explanation',resultId);
    if(explanation.scenario_id!==project.overview_scenario_id||explanation.result.binding.project_id!==projectId)throw Error('功能目录不属于本工程全貌');
    const result=explanation.result,node=result.nodes.find(n=>n.node_id===nodeId);
    if(!node||!result.feature_catalog?.groups.some(g=>g.node_ids.includes(nodeId)))throw Error('此功能不在已发现目录中');
    // Identity comes from the bound discovery, never from a possibly edited name.
    let feature=discoveredFeature(this.store.all<Feature>('feature'),this.store.all<Explanation>('explanation'),result,nodeId,project.snapshot_id);
    let scene=feature&&this.store.all<Scenario>('scenario').find(s=>s.feature_id===feature!.feature_id&&s.kind==='feature_overview');
    if(feature?.archived||scene?.archived)throw Error('功能已归档，请先恢复后再展开');
    if(feature&&scene&&feature.discovery?.source_snapshot_id!==project.snapshot_id&&result.binding.source_snapshot_id===project.snapshot_id){
      feature.discovery={result_id:resultId,node_id:nodeId,source_snapshot_id:project.snapshot_id};
      this.store.put('feature',feature.feature_id,feature);
    }
    if(!feature||!scene){
      if(result.binding.source_snapshot_id!==project.snapshot_id)throw Error('功能目录来自旧快照，请更新工程功能目录后再展开');
      const refs=result.evidence.filter(e=>node.evidence_ids.includes(e.evidence_id)).map(e=>`${e.path}:${e.line_start}-${e.line_end}`).join('，');
      const question=`只深入功能「${node.label}」：${node.description}。功能发现依据：${refs}。目录来源 ${resultId} / ${nodeId}。先检查该功能的真实入口和实现，再以业务时间线说明触发条件、主要步骤、输入输出和失败处理；不分析其他功能的内部细节。清楚区分来源事实与未知，不根据目录标题编造流程。`;
      const created=this.addFeature(projectId,node.label,question,{result_id:resultId,node_id:nodeId,source_snapshot_id:result.binding.source_snapshot_id});
      feature=created.feature;scene=created.scenario;
    }
    const cached=this.store.all<Explanation>('explanation').filter(e=>e.scenario_id===scene!.scenario_id&&e.result.binding.question_revision_id===scene!.question_revision_id&&e.result.binding.source_snapshot_id===project.snapshot_id).at(-1);
    const active=this.store.all<Run>('run').find(r=>!r.reading_question_id&&r.binding.scenario_id===scene!.scenario_id&&!terminal.has(r.status)&&r.status!=='unknown');
    if(requestMcp&&!cached&&!active)this.store.put('setting','mcp-requested-analysis',{project_id:projectId,scenario_id:scene!.scenario_id,source_snapshot_id:this.analysisSnapshot(scene!),question_revision_id:scene!.question_revision_id,created_at:now()});
    else if(requestMcp)this.store.put('setting','mcp-requested-analysis',null); // Opening saved/running work must not leave another feature as the requested target.
    this.changed();return {feature:feature!,scenario:scene!,result_id:cached?.result_id,run_id:active?.binding.run_id};
  }
  analysisSnapshot(scene:Scenario) {
    const project=this.store.get<Project>('project',scene.project_id),feature=this.store.get<Feature>('feature',scene.feature_id);
    if(feature.discovery&&feature.discovery.source_snapshot_id!==project.snapshot_id){
      // A saved walkthrough is an existing understanding task: explicit reanalysis
      // must follow the refreshed source without rewriting its discovery/history.
      // A merely discovered, never analyzed feature still needs a current catalog.
      const reviewed=this.store.all<Explanation>('explanation').some(e=>e.scenario_id===scene.scenario_id&&e.result.binding.project_id===project.project_id&&e.result.binding.feature_id===feature.feature_id&&e.result.binding.scenario_id===scene.scenario_id);
      if(!reviewed)throw Error('此功能发现绑定旧快照，请更新功能目录后再分析；历史说明仍可查看');
    }
    return project.snapshot_id;
  }
  prepareAnalysis(scenarioId:string,developmentTaskId?:string){
    const scene=this.store.get<Scenario>('scenario',scenarioId),project=this.store.get<Project>('project',scene.project_id),feature=this.store.get<Feature>('feature',scene.feature_id);
    if(project.fictional)throw Error('演示工程不派发真实分析');
    if(scene.archived||feature.archived)throw Error('请先恢复已归档功能或场景');
    if(developmentTaskId){const task=this.engineering.task(developmentTaskId);if(task.project_id!==scene.project_id||task.reading?.scenario_id!==scenarioId)throw Error('开发任务与待领取场景归属不一致');}
    const source=this.analysisSnapshot(scene);
    const active=this.store.all<Run>('run').find(r=>!r.reading_question_id&&r.binding.scenario_id===scenarioId&&['queued','running','validating','cancel_requested'].includes(r.status));
    if(active)return {run_id:active.binding.run_id};
    this.store.put('setting','mcp-requested-analysis',{project_id:scene.project_id,scenario_id:scenarioId,source_snapshot_id:source,question_revision_id:scene.question_revision_id,created_at:now(),...(developmentTaskId?{development_task_id:developmentTaskId}:{})});
    this.changed();return {scenario_id:scenarioId,...(developmentTaskId?{development_task_id:developmentTaskId}:{})};
  }
  addScenario(featureId:string,question:string) {
    const feature=this.store.get<Feature>('feature',featureId),q=text(question);
    if(feature.archived)throw new Error('请先恢复已归档功能，再添加场景');
    const project=this.store.get<Project>('project',feature.project_id);
    if(project.overview_scenario_id&&this.store.get<Scenario>('scenario',project.overview_scenario_id).feature_id===featureId)throw new Error('工程全貌不接收业务场景，请选择一个用户功能');
    const scenario:Scenario={scenario_id:id('scenario'),feature_id:featureId,project_id:feature.project_id,title:q.slice(0,100),question:q,question_revision_id:id('question'),archived:false,sort_order:this.store.all('scenario').length};
    this.store.put('scenario',scenario.scenario_id,scenario);
    this.store.put('revision',scenario.question_revision_id,{question_revision_id:scenario.question_revision_id,scenario_id:scenario.scenario_id,question:q,created_at:now()} satisfies Revision);
    this.changed();return scenario;
  }
  reviseScenario(scenarioId:string,question:string) {
    const s=this.store.get<Scenario>('scenario',scenarioId),q=text(question);
    if(q===s.question)return s;
    s.question=q;s.question_revision_id=id('question');
    this.store.transaction(()=>{this.store.put('revision',s.question_revision_id,{question_revision_id:s.question_revision_id,scenario_id:s.scenario_id,question:q,created_at:now()});this.store.put('scenario',s.scenario_id,s);});
    this.changed();return s;
  }
  organize(kind:'feature'|'scenario',objectId:string,patch:{name?:string;title?:string;archived?:boolean;sort_order?:number}) {
    if(!['feature','scenario'].includes(kind))throw new Error('对象类型不允许');
    const object=this.store.get(kind,objectId);
    if(patch.name!==undefined&&kind==='feature')object.name=text(patch.name,300);
    if(patch.title!==undefined&&kind==='scenario')object.title=text(patch.title,300);
    if(typeof patch.archived==='boolean')object.archived=patch.archived;
    if(Number.isSafeInteger(patch.sort_order))object.sort_order=patch.sort_order;
    this.store.put(kind,objectId,object);this.changed();
  }
  annotate(scenarioId:string,body:string,resultId:string|null,objectId:string|null) {
    const scenario=this.store.get<Scenario>('scenario',scenarioId),project=this.store.get<Project>('project',scenario.project_id);
    const result=resultId?this.store.get<Explanation>('explanation',resultId):null;
    if(result&&result.scenario_id!==scenarioId)throw new Error('批注归属不匹配');
    if(objectId&&(!result||![...result.result.nodes,...result.result.edges].some(n=>('node_id'in n?n.node_id:n.edge_id)===objectId)))throw new Error('批注对象不属于原说明');
    const annotation:Annotation={annotation_id:id('clue'),project_id:project.project_id,scenario_id:scenarioId,result_id:resultId,object_id:objectId,source_snapshot_id:result?.result.binding.source_snapshot_id||project.snapshot_id,text:text(body),created_at:now()};
    this.store.put('annotation',annotation.annotation_id,annotation);this.changed();return annotation;
  }
  async refresh(projectId:string,buildConfig?:string) {
    const project=this.store.get<Project>('project',projectId),controller=new AbortController();
    if(this.indexing.has(projectId))throw new Error('工程索引尚未结束');
    this.indexing.set(projectId,controller);this.emit({type:'indexing',project_id:projectId,project_name:project.name,root_path:project.root_path,count:0});
    try {
      const snapshot=await capture(project.root_path,projectId,this.directory,buildConfig??project.build_config,controller.signal,n=>this.emit({type:'indexing',project_id:projectId,project_name:project.name,root_path:project.root_path,count:n}));
      this.store.transaction(()=>{
        this.store.put('snapshot',snapshot.source_snapshot_id,snapshot);
        project.snapshot_id=snapshot.source_snapshot_id;project.build_config=snapshot.build_config;this.store.put('project',projectId,project);
        for(const e of this.store.all<Explanation>('explanation'))if(e.result.binding.project_id===projectId){
          const old=this.store.get<Snapshot>('snapshot',e.result.binding.source_snapshot_id);
          e.source_status=old.fingerprint===snapshot.fingerprint?'current':'needs_review';this.store.put('explanation',e.result_id,e);
        }
      });this.changed();return snapshot;
    }finally{this.indexing.delete(projectId);this.emit({type:'index_done',project_id:projectId});}
  }
  async checkFreshness(projectId:string) {
    const project=this.store.get<Project>('project',projectId),snapshot=this.store.get<Snapshot>('snapshot',project.snapshot_id);
    let changes:string[];
    try {await fs.access(project.root_path);changes=await freshness(snapshot);}catch{changes=['来源无法检查'];}
    if(changes.length)for(const e of this.store.all<Explanation>('explanation'))if(e.result.binding.project_id===projectId){e.source_status='needs_review';this.store.put('explanation',e.result_id,e);}
    this.changed();return changes;
  }
  async source(snapshotId:string,file:string){return readSource(this.directory,this.store.get('snapshot',snapshotId),file);}
  reading(key:string,value?:ReadingState) {
    if(typeof key!=='string'||key.length>500)throw new Error('阅读状态键无效');
    if(value!==undefined){if(JSON.stringify(value).length>100000)throw new Error('阅读状态过大');this.store.put('reading',key,value);return value;}
    return this.store.maybe('reading',key);
  }
  async probe(config?:Record<string,string>,only?:'codex') {
    if(config){for(const [key,value]of Object.entries(config))if(!['codex_path','dsh_path'].includes(key)||typeof value!=='string')throw new Error('不支持的连接配置');config={...this.store.maybe('settings','providers'),...config};this.store.put('settings','providers',config);}
    const profiles=await probeProviders(config||this.store.maybe('settings','providers')||{},only);
    const dsh=profiles.find(p=>p.provider_id==='dsh');
    if(dsh?.path&&dsh.version)Object.assign(dsh,await probeDsh(this.directory,dsh.path,dsh.version));
    for(const p of profiles)this.store.put('provider',p.provider_id,p);this.changed();return profiles;
  }
  async askReading(input:ReadingAsk):Promise<ReadingQuestion> {
    if(!input||!/^[\w-]{8,100}$/.test(input.submission_key))throw Error('提交幂等键无效');
    const args=structuredClone(input),pending=this.asking.get(args.submission_key);
    if(pending){await pending;return this.askReading(args);}
    const task=this.createReadingQuestion(args);this.asking.set(args.submission_key,task);
    try{return await task;}finally{this.asking.delete(args.submission_key);}
  }
  private async createReadingQuestion(args:ReadingAsk) {
    if(this.closing)throw Error('Arc 正在退出，未派发新任务');
    const question=text(args.question,4000),mode=args.mode??'codex';
    if(!['codex','mcp'].includes(mode)||!['bound','latest'].includes(args.source_mode??'bound'))throw Error('追问通道或来源模式无效');
    const existing=this.store.all<ReadingQuestion>('reading_question').find(q=>q.submission_key===args.submission_key);
    if(existing){if(existing.project_id!==args.project_id||existing.question!==question||existing.target.kind!==args.target?.kind||existing.target.id!==args.target?.id||existing.result_id!==(args.result_id||null))throw Error('幂等键归属冲突');return existing;}
    const project=this.store.get<Project>('project',args.project_id);
    if(project.fictional)throw Error('演示工程不调用真实 Agent；请打开实际工程');
    const previous=args.previous_question_id?this.store.get<ReadingQuestion>('reading_question',args.previous_question_id):undefined;
    const resultId=args.result_id||null,explanation=resultId?this.store.get<Explanation>('explanation',resultId):undefined;
    if(explanation&&explanation.result.binding.project_id!==project.project_id)throw Error('原说明不属于此工程');
    const scenarioId=args.scenario_id||explanation?.scenario_id||previous?.scenario_id;
    let scenario=scenarioId?this.store.get<Scenario>('scenario',scenarioId):this.overview(project.project_id);
    if(scenario.project_id!==project.project_id||explanation&&explanation.scenario_id!==scenario.scenario_id)throw Error('阅读场景归属不一致');
    const feature=this.store.get<Feature>('feature',scenario.feature_id);
    if(feature.archived||scenario.archived)throw Error('请先恢复已归档的阅读功能');
    if(previous&&(previous.project_id!==project.project_id||previous.scenario_id!==scenario.scenario_id||previous.result_id!==resultId||previous.target.kind!==args.target.kind||previous.target.id!==args.target.id))throw Error('前次追问不属于此阅读位置');
    const revisionId=previous?.question_revision_id||explanation?.result.binding.question_revision_id||scenario.question_revision_id;
    const revision=this.store.get<Revision>('revision',revisionId);
    scenario={...scenario,question_revision_id:revisionId,question:revision.question};
    const oldSource=previous?.source_snapshot_id||explanation?.result.binding.source_snapshot_id||project.snapshot_id;
    let snapshot=this.store.get<Snapshot>('snapshot',oldSource);
    if(snapshot.project_id!==project.project_id)throw Error('快照归属不一致');
    readingTarget(explanation?.result,args.target,snapshot,feature);
    // Capture related reading material before refresh/launch yields to the UI.
    const annotations=this.store.all<Annotation>('annotation'),questions=this.store.all<ReadingQuestion>('reading_question');
    if(args.source_mode==='latest')snapshot=await this.refresh(project.project_id);
    const sourceMode=args.source_mode==='latest'?'latest':previous?.source_mode??'bound';
    const context=buildReadingContext({project,feature,scenario,result:explanation?.result,target:args.target,snapshot,annotations,questions,sourceMode,previousSnapshotId:oldSource!==snapshot.source_snapshot_id?oldSource:previous?.context.source.previous_snapshot_id??null,replyTo:previous});
    const item:ReadingQuestion={question_id:id('reading-question'),project_id:project.project_id,feature_id:feature.feature_id,scenario_id:scenario.scenario_id,question_revision_id:revisionId,result_id:resultId,target:args.target,source_snapshot_id:snapshot.source_snapshot_id,source_mode:sourceMode,question,created_at:now(),run_id:'',run_ids:[],context,submission_key:args.submission_key,previous_question_id:previous?.question_id};
    let annotation:Annotation|undefined;
    if(args.correction){annotation={annotation_id:id('clue'),project_id:item.project_id,scenario_id:item.scenario_id,result_id:item.result_id,object_id:['node','edge'].includes(item.target.kind)?item.target.id:null,target:item.target,source_snapshot_id:item.source_snapshot_id,text:question,created_at:now()};context.annotations.push(annotation);}
    this.store.transaction(()=>{if(annotation)this.store.put('annotation',annotation.annotation_id,annotation);this.store.put('reading_question',item.question_id,item);});
    return this.startReadingRun(item,mode,args.submission_key);
  }
  retryReading(questionId:string,mode:'codex'|'mcp'='codex',submissionKey:string) {
    if(!/^[\w-]{8,100}$/.test(submissionKey)||!['codex','mcp'].includes(mode))throw Error('重试参数无效');
    const item=this.store.get<ReadingQuestion>('reading_question',questionId),existing=this.store.all<Run>('run').find(r=>r.submission_key===submissionKey);
    if(existing){if(existing.reading_question_id!==questionId)throw Error('幂等键归属冲突');return item;}
    const previous=this.store.get<Run>('run',item.run_id);
    if(!['failed','cancelled','blocked_external','unknown'].includes(previous.status))throw Error('只可重试已失败、已取消或状态未知的问题');
    return this.startReadingRun(item,mode,submissionKey);
  }
  private startReadingRun(item:ReadingQuestion,mode:'codex'|'mcp',submissionKey:string) {
    if(this.closing)throw Error('Arc 正在退出，未派发新任务');
    const runId=id('run'),run:Run={binding:{project_id:item.project_id,feature_id:item.feature_id,scenario_id:item.scenario_id,question_revision_id:item.question_revision_id,source_snapshot_id:item.source_snapshot_id,run_id:runId},provider_id:'codex',status:mode==='mcp'?'waiting_agent':'queued',origin:mode==='mcp'?'mcp':undefined,question:item.question,title:`阅读追问 · ${item.target.id}`,created_at:now(),submission_key:submissionKey,previous_run_id:item.run_id||undefined,output_path:path.join(this.directory,'runs',runId,'result.json'),reading_question_id:item.question_id,reading_context:item.context};
    item.run_id=runId;item.run_ids.push(runId);
    this.store.transaction(()=>{this.store.put('run',runId,run);this.store.put('reading_question',item.question_id,item);});
    this.event(runId,{type:'local.stage',stage:mode==='mcp'?'waiting_agent':'queued',message:mode==='mcp'?'问题和源码已固定，等待外部 Agent 通过 MCP 领取；尚未执行分析':'问题和源码已固定，正在准备 Codex 只读分析'});this.changed();
    if(this.dispatchRun){this.dispatchRun(run);return item;}
    if(mode==='codex'){const task=this.execute(run).catch(error=>this.fail(runId,error)).finally(()=>this.executing.delete(runId));this.executing.set(runId,task);}
    return item;
  }
  analysisContext(run:Run) {
    if(run.reading_context)return run.reading_context;
    const snapshot=this.store.get<Snapshot>('snapshot',run.binding.source_snapshot_id);
    const annotations=this.store.all<Annotation>('annotation').filter(a=>a.scenario_id===run.binding.scenario_id);
    const previous=this.store.all<Explanation>('explanation').filter(e=>e.scenario_id===run.binding.scenario_id).at(-1);
    return promptContext(snapshot,annotations,previous?{result_id:previous.result_id,binding:previous.result.binding,summary:previous.result.summary}:undefined);
  }
  async startRun(scenarioId:string,providerId:string,submissionKey:string,previousRunId?:string,options:{sourceSnapshotId?:string;developmentTaskId?:string;refreshFromResultId?:string}={}) {
    if(this.closing)throw new Error('Arc 正在退出，未派发新任务');
    if(!['codex','dsh','workbuddy'].includes(providerId))throw new Error('请选择真实 Provider；演示单独装载');
    if(!/^[\w-]{8,100}$/.test(submissionKey))throw new Error('提交幂等键无效');
    const existing=this.store.all<Run>('run').find(r=>r.submission_key===submissionKey);
    if(existing){if(existing.binding.scenario_id!==scenarioId||existing.provider_id!==providerId||existing.development_task_id!==options.developmentTaskId)throw new Error('幂等键归属冲突');return existing;}
    const scenario=this.store.get<Scenario>('scenario',scenarioId),project=this.store.get<Project>('project',scenario.project_id);
    if(project.fictional)throw new Error('演示工程不调用真实 Provider；请打开实际工程或测试源码目录');
    const busy=this.store.all<Run>('run').find(r=>!r.reading_question_id&&r.binding.scenario_id===scenarioId&&r.provider_id===providerId&&!terminal.has(r.status)&&r.status!=='unknown');
    if(busy)throw new Error('该场景同一 Provider 已有进行中的运行；请先等待或停止');
    if(previousRunId){const previous=this.store.get<Run>('run',previousRunId);if(previous.binding.scenario_id!==scenarioId)throw new Error('前次运行不属于此场景');}
    const sourceSnapshotId=options.sourceSnapshotId??this.analysisSnapshot(scenario),source=this.store.get<Snapshot>('snapshot',sourceSnapshotId);
    if(source.project_id!==project.project_id)throw Error('复核来源不属于当前工程');
    if(options.developmentTaskId){const task=this.engineering.task(options.developmentTaskId);if(task.project_id!==project.project_id||task.reading?.scenario_id!==scenarioId)throw Error('开发任务与功能走读归属不一致');}
    // Freeze synchronously before yielding; UI changes cannot change this envelope.
    const runId=id('run');
    const run:Run={binding:{project_id:project.project_id,feature_id:scenario.feature_id,scenario_id:scenarioId,question_revision_id:scenario.question_revision_id,source_snapshot_id:sourceSnapshotId,run_id:runId},provider_id:providerId as Run['provider_id'],status:'queued',question:scenario.question,title:options.developmentTaskId?`${scenario.title} · 开发后复核`:scenario.title,created_at:now(),submission_key:submissionKey,previous_run_id:previousRunId,output_path:path.join(this.directory,'runs',runId,'result.json'),...(options.developmentTaskId?{development_task_id:options.developmentTaskId,refresh_from_result_id:options.refreshFromResultId}:{})};
    if(providerId==='codex'&&scenario.question===overviewQuestion)run.overview_format='overview-1';
    this.store.put('run',runId,run);this.changed();
    this.event(runId,{type:'local.stage',stage:'queued',message:options.developmentTaskId?'开发结果已保存；正在按新代码重新核对同一功能，旧说明保留':'任务与源码快照已绑定，正在准备 Agent 连接'});
    if(this.dispatchRun&&run.provider_id==='codex'){this.dispatchRun(run);return run;}
    const task=this.execute(run).catch(error=>this.fail(runId,error)).finally(()=>this.executing.delete(runId));
    this.executing.set(runId,task);
    return run;
  }
  refreshTaskWalkthrough(taskId:string,submissionKey?:string):Promise<void> {
    const active=this.refreshingTasks.get(taskId);
    if(active){
      if(this.engineering.task(taskId).walkthrough?.update_id===this.refreshGenerations.get(taskId))return active;
      let queued=this.queuedWalkthroughs.get(taskId);
      if(!queued){let resolve!:()=>void;queued={submissionKey,promise:new Promise<void>(done=>resolve=done),resolve};this.queuedWalkthroughs.set(taskId,queued);}
      else if(submissionKey)queued.submissionKey=submissionKey;
      return queued.promise;
    }
    const task=this.engineering.task(taskId);if(!task.reading||!task.end_state||!['completed','failed','blocked','cancelled'].includes(task.status))return Promise.resolve();
    const updateId=id('walkthrough'),previous=task.walkthrough??{status:'pending' as const,previous_result_id:task.reading.result_id,updated_at:now()};
    this.engineering.saveWalkthrough(taskId,{...previous,status:'pending',update_id:updateId,error:undefined,updated_at:now()});
    return this.watchRefresh(taskId,updateId,this.updateTaskWalkthrough(taskId,updateId,submissionKey??`walkthrough-${updateId}`));
  }
  private watchRefresh(taskId:string,updateId:string,work:Promise<void>):Promise<void> {
    this.refreshGenerations.set(taskId,updateId);
    const pending=work.finally(()=>{
      if(this.refreshingTasks.get(taskId)===pending){this.refreshingTasks.delete(taskId);this.refreshGenerations.delete(taskId);}
      const queued=this.queuedWalkthroughs.get(taskId);if(queued){this.queuedWalkthroughs.delete(taskId);if(this.closing)queued.resolve();else void this.refreshTaskWalkthrough(taskId,queued.submissionKey).then(queued.resolve,queued.resolve);}
    });this.refreshingTasks.set(taskId,pending);return pending;
  }
  trackExternalWalkthrough(runId:string) {
    if(this.externalWalkthroughs.has(runId))return;const run=this.store.get<Run>('run',runId);if(!run.development_task_id)return;
    const task=this.engineering.task(run.development_task_id);if(!task.walkthrough||task.walkthrough.run_id!==runId)return;
    const updateId=task.walkthrough.update_id??id('walkthrough');if(!task.walkthrough.update_id)this.engineering.saveWalkthrough(task.task_id,{...task.walkthrough,update_id:updateId,updated_at:now()});
    let resolve!:()=>void;const work=new Promise<void>(done=>resolve=done);this.externalWalkthroughs.set(runId,{taskId:task.task_id,resolve});this.watchRefresh(task.task_id,updateId,work);
  }
  finishExternalWalkthrough(runId:string) {
    const active=this.externalWalkthroughs.get(runId);if(active){this.externalWalkthroughs.delete(runId);active.resolve();}
  }
  private async updateTaskWalkthrough(taskId:string,updateId:string,submissionKey:string) {
    let runId:string|undefined;
    try{
      const initial=this.engineering.task(taskId),reading=initial.reading!;
      const snapshot=await this.refresh(initial.project_id),current=this.engineering.task(taskId);
      if(current.walkthrough?.update_id!==updateId||!['completed','failed','blocked','cancelled'].includes(current.status))return;
      const attempt=current.attempt_ids.at(-1)?this.store.get<import('../engineering').DevelopmentAttempt>('development_attempt',current.attempt_ids.at(-1)!):undefined;
      if(attempt?.origin==='agent'&&attempt.provider_id==='kimi'){
        this.engineering.saveWalkthrough(taskId,{...current.walkthrough!,status:'pending',source_snapshot_id:snapshot.source_snapshot_id,updated_at:now()},updateId);
        this.prepareAnalysis(reading.scenario_id,taskId);return;
      }
      const run=await this.startRun(reading.scenario_id,'codex',submissionKey,undefined,{sourceSnapshotId:snapshot.source_snapshot_id,developmentTaskId:taskId,refreshFromResultId:current.walkthrough!.previous_result_id});runId=run.binding.run_id;
      this.engineering.saveWalkthrough(taskId,{...current.walkthrough!,status:this.dispatchRun?'pending':'running',run_id:runId,source_snapshot_id:snapshot.source_snapshot_id,updated_at:now()},updateId);
      if(this.dispatchRun)return;
      const executing=this.executing.get(runId);if(executing)await executing;
      const finalRun=this.store.get<Run>('run',runId),explanation=this.store.all<Explanation>('explanation').find(e=>e.result.binding.run_id===runId),latest=this.engineering.task(taskId);
      if(finalRun.status==='completed'&&explanation)this.engineering.saveWalkthrough(taskId,{...latest.walkthrough!,status:'completed',result_id:explanation.result_id,source_snapshot_id:explanation.result.binding.source_snapshot_id,error:undefined,updated_at:now()},updateId);
      else this.engineering.saveWalkthrough(taskId,{...latest.walkthrough!,status:'failed',error:finalRun.error||`走读更新未完成（${finalRun.status}）；旧说明和开发成果保留。`,updated_at:now()},updateId);
    }catch(error){const latest=this.engineering.task(taskId);if(latest.walkthrough?.update_id===updateId)this.engineering.saveWalkthrough(taskId,{...latest.walkthrough,status:'failed',...(runId?{run_id:runId}:{}),error:redact((error as Error).message||String(error)),updated_at:now()},updateId);}
  }
  private fail(runId:string,error:unknown) {
    this.active.delete(runId);
    const run=this.store.get<Run>('run',runId);
    if(terminal.has(run.status))return;
    run.status=(error as any)?.remoteUnknown?'unknown':'failed';run.error=redact((error as Error).message);run.ended_at=now();this.store.put('run',runId,run);this.changed();
  }
  async researchOverview(resultId:string,submissionKey:string) {
    if(this.closing)throw Error('Arc 正在退出，未派发补查');
    if(!/^[\w-]{8,100}$/.test(submissionKey))throw Error('提交幂等键无效');
    const existing=this.store.all<Run>('run').find(run=>run.submission_key===submissionKey);
    if(existing){if(existing.overview_from_result_id!==resultId)throw Error('幂等键归属冲突');return existing;}
    const explanation=this.store.get<Explanation>('explanation',resultId),previous=this.store.get<Run>('run',explanation.result.binding.run_id);
    if(previous.provider_id!=='codex'||!previous.overview_format||previous.status!=='completed'||explanation.result.fictional||!explanation.result.gaps.some(g=>g.gap_id.startsWith('overview-review-')))throw Error('这份说明没有可自动补查的首轮关系');
    if(this.store.all<Run>('run').some(r=>r.binding.scenario_id===previous.binding.scenario_id&&!r.reading_question_id&&!terminal.has(r.status)&&r.status!=='unknown'))throw Error('该场景已有进行中的分析，请等待或停止后补查');
    const runId=id('run'),run:Run={binding:{...previous.binding,run_id:runId},provider_id:'codex',status:'queued',question:previous.question,title:'自动补查工程关系',created_at:now(),submission_key:submissionKey,previous_run_id:previous.binding.run_id,output_path:path.join(this.directory,'runs',runId,'result.json'),overview_format:'overview-1',overview_from_result_id:resultId};
    this.store.put('run',runId,run);this.event(runId,{type:'local.stage',stage:'overview_resume',message:'沿用这份说明的冻结源码与候选关系，自动补查缺口；完成后保存新版本，原说明保留。'});this.changed();
    if(this.dispatchRun&&run.provider_id==='codex'){this.dispatchRun(run);return run;}
    const task=this.execute(run).catch(error=>this.fail(runId,error)).finally(()=>this.executing.delete(runId));this.executing.set(runId,task);return run;
  }
  event(runId:string,event:any,eventId?:string,sequence?:number) {
    const run=this.store.get<Run>('run',runId);
    const seq=sequence??this.store.nextSequence(runId);
    const clean=JSON.parse(redact(JSON.stringify(event)));
    if(!this.store.event(runId,eventId||`${runId}:${seq}`,seq,{sequence:seq,received_at:now(),...clean}))return;
    if(terminal.has(run.status))return;
    if(typeof event.thread_id==='string')run.external_id=event.thread_id;
    if(event.native_ui==='dsh-web')run.native_ui='dsh-web';
    this.store.put('run',runId,run);this.emit({type:'run_event',run_id:runId,event:clean});
  }
  private async execute(initial:Run) {
    const runId=initial.binding.run_id;
    let profile=this.store.maybe<ProviderProfile>('provider',initial.provider_id);
    const profileAge=Date.now()-Date.parse(profile?.checked_at||'');
    if(initial.provider_id==='codex'&&(!Number.isFinite(profileAge)||profileAge<0||profileAge>5*60*1000)){
      this.event(runId,{type:'local.stage',stage:'checking_provider',message:'正在检测当前 Codex 程序与登录状态，更新过期的连接记录'});
      this.checkingCodex??=this.probe(undefined,'codex').finally(()=>{this.checkingCodex=undefined;});
      await this.checkingCodex;profile=this.store.get('provider','codex');
    }else if(!profile){await this.probe();profile=this.store.get('provider',initial.provider_id);}
    const freshRun=this.store.get<Run>('run',runId);
    if(freshRun.status==='cancelled'||this.closing)return;
    if(!profile||profile.status!=='available'||!['codex','dsh'].includes(initial.provider_id)){
      freshRun.status='blocked_external';freshRun.error=profile?.reason||'缺少受支持的真实适配通道';freshRun.ended_at=now();this.store.put('run',runId,freshRun);this.changed();return;
    }
    const snapshot=this.store.get<Snapshot>('snapshot',initial.binding.source_snapshot_id);
    if(initial.overview_from_result_id){
      const inherited=await this.savedOverviewDraft(initial,snapshot);
      const checked=await this.finishOverview(initial,snapshot,profile,inherited.draft,inherited.review);
      await this.acceptResult(runId,checked.result,checked.semantic);return;
    }
    const annotations=this.store.all<Annotation>('annotation').filter(a=>a.scenario_id===initial.binding.scenario_id);
    const previous=this.store.all<Explanation>('explanation').filter(e=>e.scenario_id===initial.binding.scenario_id).at(-1);
    const prompt=await makePrompt(initial,snapshot,this.directory,annotations,previous?{result_id:previous.result_id,binding:previous.result.binding,summary:previous.result.summary}:undefined);
    this.event(runId,{type:'local.stage',stage:'launching',message:`只读任务已准备，正在启动 ${initial.provider_id} 官方后端`});
    if(this.store.get<Run>('run',runId).status==='cancelled'||this.closing)return;
    const result=await (initial.provider_id==='dsh'?runDshWeb:this.codexRunner)({run:initial,snapshot,storage:this.directory,resources:this.resources,profile,prompt,
      event:event=>this.event(runId,event),
      shouldStart:()=>!this.closing&&this.store.get<Run>('run',runId).status==='queued',
      started:active=>{
        this.active.set(runId,active);const run=this.store.get<Run>('run',runId);
        if(this.closing||run.status!=='queued'){
          void active.cancel().catch(error=>{const latest=this.store.get<Run>('run',runId);latest.status='unknown';latest.error=`启动期间收到停止请求，但未能确认进程退出：${redact((error as Error).message)}`;this.store.put('run',runId,latest);this.changed();});
          return;
        }
        run.status='running';run.pid=active.child.pid;run.runtime_version=profile!.version;this.store.put('run',runId,run);this.changed();
      }
    });
    this.active.delete(runId);
    const run=this.store.get<Run>('run',runId);
    if(run.status==='cancelled')return;
    if(run.status==='cancel_requested'){
      if(initial.provider_id==='dsh'&&(!('cancelled'in result)||!result.cancelled)){run.status='unknown';run.error='已发出停止请求，但未得到 ACP 取消终态；请核查原生会话。';}
      else{run.status='cancelled';run.ended_at=now();run.error='已确认本地进程退出或 ACP 取消终态；保留此前事件及原始部分。';}
      this.store.put('run',runId,run);this.changed();return;
    }
    if(run.status==='unknown')throw Object.assign(Error('分析停止状态未确认，迟到结果不发布'),{remoteUnknown:true});
    const protocolError='protocol_error'in result?result.protocol_error:undefined;
    if(result.code!==0||protocolError)throw new Error(`${initial.provider_id} 未成功完成（exit=${result.code}）：${protocolError||result.stderr.slice(-2500)}`);
    let value:unknown;
    try{const audit:string[]=[];value=normalizeTransport(parseProviderText(result.raw,initial.provider_id),audit);if(audit.length)this.event(runId,{type:'local.format_normalization',changes:audit});}catch{throw new Error('真实返回不是合法 JSON，原始文件已保留；未生成正式关系图。');}
    let semanticReview:string|undefined;
    if(initial.overview_format){
      run.status='validating';this.store.put('run',runId,run);this.changed();
      const draft=await prepareOverview(value,initial,snapshot,this.directory);
      const checked=await this.finishOverview(initial,snapshot,profile,draft);
      value=checked.result;semanticReview=checked.semantic;
    }
    await this.acceptResult(runId,value,semanticReview);
  }
  private async savedOverviewDraft(run:Run,snapshot:Snapshot) {
    const explanation=this.store.get<Explanation>('explanation',run.overview_from_result_id!);
    const previous=this.store.get<Run>('run',explanation.result.binding.run_id),directory=path.dirname(previous.output_path);
    const readOptional=async(file:string)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
    const raw=await fs.readFile(previous.output_path,'utf8');
    // Legacy compact runs expanded the draft from the initial envelope, before
    // the detected runtime version was stored on the run. Recreate that exact
    // representation, then require its original review hash to match.
    const draft:AnalysisResult=await readOptional(path.join(directory,'overview-draft.json'))??await prepareOverview(JSON.parse(raw),{...previous,runtime_version:undefined},snapshot,this.directory);
    const validation=await validateResult(draft,previous,snapshot,this.directory);
    if(validation.errors.length)throw Error('先前草稿来源校验失败：'+validation.errors.join('；'));
    const review=parseOverviewReview(await readOptional(path.join(directory,'overview-review.json'))??JSON.parse(await fs.readFile(path.join(directory,'review','result.json'),'utf8')),draft);
    if(!review.relations.some(item=>item.verdict!=='supported'))throw Error('先前记录已没有待补查关系');
    // A new task retains the exact source and facts; only task/result identity is
    // rebound. Prior source, raw responses and published explanation are intact.
    const boundDraft={...draft,binding:{...run.binding},result_id:`overview-result-${sha(run.binding.run_id).slice(0,32)}`};
    const boundReview={...review,run_id:run.binding.run_id,draft_sha256:sha(JSON.stringify(boundDraft))};
    await fs.mkdir(path.dirname(run.output_path),{recursive:true});await fs.writeFile(run.output_path,raw);
    return {draft:boundDraft,review:boundReview};
  }
  private async overviewPhase(initial:Run,snapshot:Snapshot,profile:ProviderProfile,phase:OverviewPhase,prompt:string) {
    const runId=initial.binding.run_id,current=this.store.get<Run>('run',runId);
    if(this.closing||terminal.has(current.status)||['cancel_requested','unknown'].includes(current.status))throw Error('补查或复核已经停止，未启动新的 Agent 任务');
    current.status='validating';this.store.put('run',runId,current);
    const messages={overview_review:'正在独立核对关系的方向、通信方式和源码依据；发现疑点后会自动补查。',overview_research:'正在沿有疑点的关系补查调用点、装配位置和接收方源码，无需手工核对。',overview_recheck:'补查已取得源码，正在独立复核修订关系；尚未发布新说明。'};
    this.event(runId,{type:'local.stage',stage:phase,message:messages[phase]});this.changed();
    const phaseRun={...initial,output_path:path.join(this.directory,'runs',runId,overviewPhaseDirectory[phase],'result.json')};
    const result=await this.codexRunner({run:phaseRun,snapshot,storage:this.directory,resources:this.resources,profile,prompt,phase,
      event:event=>this.event(runId,{...event,phase}),
      shouldStart:()=>!this.closing&&this.store.get<Run>('run',runId).status==='validating',
      started:active=>{
        this.active.set(runId,active);const latest=this.store.get<Run>('run',runId);
        if(this.closing||latest.status!=='validating'){
          void active.cancel().catch(error=>{const stopped=this.store.get<Run>('run',runId);stopped.status='unknown';stopped.error=`补查或复核启动时收到停止请求，但未能确认进程退出：${redact((error as Error).message)}`;this.store.put('run',runId,stopped);this.changed();});return;
        }
        latest.status='running';latest.pid=active.child.pid;latest.runtime_version=profile.version;this.store.put('run',runId,latest);this.changed();
      }
    });
    this.active.delete(runId);
    const latest=this.store.get<Run>('run',runId);
    if(latest.status==='cancel_requested'){latest.status='cancelled';latest.ended_at=now();latest.error='已停止自动补查或复核；原说明和已取得原文保留，未发布新说明。';this.store.put('run',runId,latest);this.changed();}
    if(latest.status==='cancelled'||this.closing)throw Error('补查或复核已取消，未发布新说明');
    if(latest.status==='unknown')throw Object.assign(Error('补查或复核停止状态未确认，迟到结果不发布'),{remoteUnknown:true});
    if(result.code!==0||result.protocol_error)throw Error(`自动补查或复核未完成，不能据此断言源码不存在：${result.protocol_error||result.stderr.slice(-2500)}`);
    // Source validation and review preparation still await local I/O after the
    // child exits. Keep that interval cancellable without a live process.
    latest.status='validating';this.store.put('run',runId,latest);this.changed();
    return parseProviderText(result.raw,'codex');
  }
  private async finishOverview(run:Run,snapshot:Snapshot,profile:ProviderProfile,draft:AnalysisResult,inherited?:OverviewReview) {
    const runId=run.binding.run_id;
    let review=inherited??parseOverviewReview(await this.overviewPhase(run,snapshot,profile,'overview_review',await makeOverviewReviewPrompt(draft,snapshot,this.directory)),draft);
    const rejected=review.relations.filter(item=>item.verdict!=='supported');let resolved=0;
    if(rejected.length){
      const response=await this.overviewPhase(run,snapshot,profile,'overview_research',makeOverviewResearchPrompt(draft,review));
      const research=await applyOverviewResearch(response,draft,review,run,snapshot,this.directory,this.store.events(runId));
      draft=research.draft;
      const recheck=research.resolved.length?parseOverviewReview(await this.overviewPhase(run,snapshot,profile,'overview_recheck',await makeOverviewReviewPrompt(draft,snapshot,this.directory,research.resolved)),draft,research.resolved):undefined;
      resolved=recheck?.relations.filter(item=>item.verdict==='supported').length??0;
      review={...review,draft_sha256:sha(JSON.stringify(draft)),relations:review.relations.map(item=>{
        const remaining=research.unresolved.get(item.edge_id);
        if(remaining)return {...item,verdict:'uncertain',reason:remaining,evidence_ids:[...draft.edges.find(edge=>edge.edge_id===item.edge_id)!.evidence_ids]};
        const checked=recheck?.relations.find(edge=>edge.edge_id===item.edge_id);
        return checked??item;
      })};
    }
    const checked=applyOverviewReview(review,draft),directory=path.join(this.directory,'runs',runId);
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,'overview-draft.json'),JSON.stringify(draft));
    await fs.writeFile(path.join(directory,'overview-review.json'),JSON.stringify(review));
    const semantic=`独立 Agent 已按冻结源码复核摘要及 ${checked.checked} 条候选关系；自动补查 ${rejected.length} 条，其中 ${resolved} 条补查后通过复核，${checked.excluded} 条仍未确认，已保存所查位置和具体原因。模型复核不等于运行验证或完整语义证明。`;
    this.event(runId,{type:'local.stage',stage:'overview_reviewed',message:semantic});
    return {result:checked.result,semantic};
  }

  async acceptResult(runId:string,value:unknown,semanticReview?:string) {
    const run=this.store.get<Run>('run',runId),snapshot=this.store.get<Snapshot>('snapshot',run.binding.source_snapshot_id);
    if(run.overview_format&&!semanticReview)throw new Error('首轮工程图尚未完成独立关系复核，不能发布');
    if(['cancel_requested','cancelled','failed'].includes(run.status))throw new Error('终止后的迟到结果保留为原始材料，不发布为新说明');
    if(run.status==='completed')return run;
    run.status='validating';this.store.put('run',runId,run);
    this.event(runId,{type:'local.stage',stage:'validating',message:'完整结果已收到，正在校验结构、任务绑定和源码行号'});this.changed();
    const report=run.reading_question_id?await validateReadingAnswer(value,run,snapshot,this.directory):await validateResult(value,run,snapshot,this.directory);
    if(semanticReview)report.semantic=semanticReview;
    if(['cancel_requested','cancelled','failed'].includes(this.store.get<Run>('run',runId).status))throw new Error('校验期间收到停止请求，迟到结果不发布');
    run.validation=report;
    if(report.errors.length){run.status='failed';run.error=`结果校验失败：${report.errors.slice(0,5).join('；')}`;run.ended_at=now();this.store.put('run',runId,run);this.changed();return run;}
    if(run.reading_question_id){
      const question=this.store.get<ReadingQuestion>('reading_question',run.reading_question_id);
      if(question.run_id!==runId)throw Error('此运行已被新的重试替代，结果保留为历史材料');
      question.answer=value as ReadingAnswer;
      this.store.transaction(()=>{run.status='completed';run.ended_at=now();this.store.put('reading_question',question.question_id,question);this.store.put('run',runId,run);});
      this.changed();return run;
    }
    const result=value as AnalysisResult;
    const existing=this.store.maybe<Explanation>('explanation',result.result_id);
    if(existing){if(existing.result.binding.run_id===runId)return run;throw new Error('结果 ID 与另一个运行冲突');}
    const project=this.store.get<Project>('project',run.binding.project_id);
    const current=this.store.get<Snapshot>('snapshot',project.snapshot_id);
    let changed=true;try{changed=(await freshness(snapshot)).length>0;}catch{/* Missing workspace remains reviewable only as history. */}
    if(['cancel_requested','cancelled','failed'].includes(this.store.get<Run>('run',runId).status))throw new Error('来源复核期间收到停止请求，迟到结果不发布');
    const explanation:Explanation={result_id:result.result_id,scenario_id:run.binding.scenario_id,created_at:now(),source_status:!changed&&current.fingerprint===snapshot.fingerprint?'current':'needs_review',result};
    this.store.transaction(()=>{run.status='completed';run.ended_at=now();this.store.put('explanation',result.result_id,explanation);this.store.put('run',runId,run);});
    this.changed();return run;
  }
  async revalidate(runId:string){
    const run=this.store.get<Run>('run',runId);
    if(run.overview_format)throw new Error('首轮分析需要完成源码校验和独立关系复核；请重新分析，不能将未复核的原始草稿直接发布。');
    if(run.status!=='failed'||this.active.has(runId))throw new Error('仅可重新校验已失败且已停止的原始返回');
    const raw=run.provider_id==='dsh'&&!run.native_ui?dshFinalMessage(this.store.events(runId)):await fs.readFile(run.output_path,'utf8');
    const audit:string[]=[],parsed=normalizeTransport(parseProviderText(raw,run.provider_id),audit);
    this.event(runId,{type:'local.revalidation',reason:'只重新解析已保存原文，未派发外部请求',previous_error:run.error,format_normalization:audit});
    run.status='validating';run.error=undefined;this.store.put('run',runId,run);
    try{return await this.acceptResult(runId,parsed);}catch(e){this.fail(runId,e);throw e;}
  }
  async cancel(runId:string) {
    const run=this.store.get<Run>('run',runId);
    if(terminal.has(run.status))return run;
    const active=this.active.get(runId);
    if(run.origin==='mcp'){run.status='cancelled';run.ended_at=now();run.error='Arc 已撤销本次任务的读取和结果写回权限；Agent 对话不会被远程停止，请在 Agent 中停止生成。';this.store.put('run',runId,run);this.finishExternalWalkthrough(runId);this.changed();return run;}
    if(run.status==='validating'&&!active){run.status='cancelled';run.ended_at=now();run.error='本地结果校验已取消，未发布正式说明';this.store.put('run',runId,run);this.changed();return run;}
    if(run.status==='queued'&&!active){run.status='cancelled';run.ended_at=now();this.store.put('run',runId,run);this.changed();return run;}
    if(!active)throw new Error('无法确认此运行的本地进程；状态未知，不冒充远端停止。');
    run.status='cancel_requested';this.store.put('run',runId,run);this.changed();
    try{await active.cancel();}catch(e){run.status='unknown';run.error=redact((e as Error).message);this.store.put('run',runId,run);this.changed();}
    return run;
  }
  async loadDemo() {
    const root=path.join(this.resources,'examples','source-fixture');
    let project=await this.openProject(root,true);
    const already=this.store.all<Explanation>('explanation').find(e=>e.result.binding.project_id===project.project_id);
    if(already)return project;
    project.name='演示 · 配置应答与持久化';this.store.put('project',project.project_id,project);
    const {scenario}=this.addFeature(project.project_id,'配置更新','ACK_OK 是否代表参数已持久化？');
    const result=JSON.parse(await fs.readFile(path.join(this.resources,'examples','analysis-result.json'),'utf8')) as AnalysisResult;
    const runId=id('demo-run');
    const run:Run={binding:{project_id:project.project_id,feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,question_revision_id:scenario.question_revision_id,source_snapshot_id:project.snapshot_id,run_id:runId},provider_id:'demo',status:'running',question:scenario.question,title:scenario.title,created_at:now(),submission_key:runId,output_path:''};
    const rebound={...result,result_id:id('demo-result'),binding:run.binding,provider:{provider_id:'demo',connection_id:'local-demo',adapter_version:'0.1.0'},evidence:result.evidence.map(e=>({...e,source_snapshot_id:project.snapshot_id}))};
    this.store.put('run',runId,run);await this.acceptResult(runId,rebound);return project;
  }
  async exportProject(projectId:string,file:string) {
    const data=this.data(),project=this.store.get<Project>('project',projectId);
    const snapshots=data.snapshots.filter(s=>s.project_id===projectId);
    const contents:Record<string,Record<string,string>>={};
    for(const snapshot of snapshots){contents[snapshot.source_snapshot_id]={};for(const f of snapshot.files){const source=await readSource(this.directory,snapshot,f.path);contents[snapshot.source_snapshot_id][f.path]=source.text;}}
    const runs=data.runs.filter(r=>r.binding.project_id===projectId).map(r=>({...r,output_path:'',pid:undefined}));
    const bundle={format:'arc-export-v1',exported_at:now(),project,features:data.features.filter(x=>x.project_id===projectId),scenarios:data.scenarios.filter(x=>x.project_id===projectId),revisions:data.revisions.filter(x=>data.scenarios.some(s=>s.project_id===projectId&&s.scenario_id===x.scenario_id)),annotations:data.annotations.filter(x=>x.project_id===projectId),explanations:data.explanations.filter(x=>x.result.binding.project_id===projectId),questions:(data.questions||[]).filter(x=>x.project_id===projectId),runs,snapshots,contents};
    await fs.writeFile(file,JSON.stringify(bundle,null,2),{flag:'wx'});return file;
  }
  async importResult(scenarioId:string,file:string){
    const stat=await fs.stat(file);if(stat.size>2*1024*1024)throw new Error('导入结果超过 2 MiB');
    const raw=await fs.readFile(file,'utf8'),value=JSON.parse(raw) as AnalysisResult;
    const scene=this.store.get<Scenario>('scenario',scenarioId),project=this.store.get<Project>('project',scene.project_id);
    const binding=value.binding;
    if(!binding||binding.project_id!==project.project_id||binding.feature_id!==scene.feature_id||binding.scenario_id!==scene.scenario_id)throw new Error('导入结果不属于所选工程与场景，未按名称猜测或重绑');
    const revision=this.store.get<Revision>('revision',binding.question_revision_id),snapshot=this.store.get<Snapshot>('snapshot',binding.source_snapshot_id);
    if(revision.scenario_id!==scenarioId||snapshot.project_id!==project.project_id)throw new Error('导入问题/来源归属不一致');
    const original:Run={binding,provider_id:value.provider?.provider_id,status:'running',question:revision.question,title:scene.title,created_at:now(),submission_key:id('import'),output_path:'',origin:'manual_import'};
    const report=await validateResult(value,original,snapshot,this.directory);
    if(report.errors.length)throw new Error(`导入校验失败：${report.errors.slice(0,5).join('；')}`);
    const runId=id('import-run'),run:Run={...original,binding:{...binding,run_id:runId},imported_binding:binding,output_path:path.join(this.directory,'runs',runId,'imported-original.json')};
    await fs.mkdir(path.dirname(run.output_path),{recursive:true});await fs.writeFile(run.output_path,raw,{flag:'wx'});
    const rebound={...value,result_id:id('import-result'),binding:run.binding};
    this.store.put('run',runId,run);
    await this.acceptResult(runId,rebound);
    return this.store.get<Run>('run',runId);
  }
  async shutdown(){
    this.closing=true;
    await this.development.shutdown();
    for(const controller of this.indexing.values())controller.abort();
    await Promise.allSettled([...this.executing.keys()].map(k=>this.cancel(k)));
    // Wait for real terminal events before the SQLite connection is closed.
    const pending=Promise.allSettled([...this.executing.values()]);
    const timer=setTimeout(()=>{for(const [runId,active]of this.active){
      this.event(runId,{type:'shutdown.local_disconnect',reason:'退出等待超过 12 秒；关闭自有子进程，远端终态以协议记录为准'});
      void stopTree(active.child).catch(()=>{});
    }},12000);
    await pending;clearTimeout(timer);
    await Promise.allSettled([...this.externalWalkthroughs.keys()].map(runId=>this.cancel(runId)));
    await Promise.allSettled([...this.refreshingTasks.values()]);
    await closeDshWebHosts();
    while(this.indexing.size)await new Promise(resolve=>setTimeout(resolve,20));
  }
  async providerSessionUrl(runId:string){
    const run=this.store.get<Run>('run',runId);if(run.provider_id!=='dsh'||run.native_ui!=='dsh-web')throw Error('该运行不支持原生图形会话');
    const profile=this.store.get<ProviderProfile>('provider','dsh');return dshWebSessionUrl({run,profile,storage:this.directory,resources:this.resources});
  }
}

