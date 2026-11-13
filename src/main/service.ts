import fs from 'node:fs/promises';
import path from 'node:path';
import type { Project, Scenario, Feature, Revision, Annotation, Snapshot, Run, Explanation, ProviderProfile, WorkspaceData, ReadingState, AnalysisResult } from '../shared';
import { Store, id, now } from './store';
import { capture, readSource, freshness, sha } from './snapshot';
import { probeProviders, runCodex, makePrompt, redact, stopTree, type ActiveProcess } from './providers';
import { normalizeTransport, validateResult } from './validation';
import {probeDsh,runDsh,dshFinalMessage,parseProviderText} from './dsh';
import {runDshWeb,dshWebSessionUrl,closeDshWebHosts} from './dsh-web';
import {discoveredFeature} from '../discovered-feature';
export const terminal=new Set(['completed','failed','cancelled','blocked_external']);
const oldOverviewQuestion='分析整个授权快照的工程全貌：主要职责与模块边界用 stage 节点，内部函数使用 parent_node_id 关联，目录/文件用途必须有依据。列出模块、外部依赖组件及使用位置；依赖使用 dependency，不能当作运行时调用。版本仅引用清单或锁文件。明确未分析范围、构建条件、缺失实现；不根据目录名猜职责。';
const architectureOverviewQuestion='分析授权快照的系统架构，先说明系统由哪些实际组件组成、如何通信和存储数据。返回 architecture.node_ids 与 architecture.edge_ids，引用 nodes/edges 中的高层组件和连接；不预设一定有前端、后端或数据库。组件标签注明已证实的语言/技术，关系标签注明 HTTP/HTTPS、SQL、文件读写等有依据的协议或访问方式；未知写未知，不能把 SQLite 猜成 MySQL，也不能把库依赖当网络服务。内部模块用 parent_node_id 归属组件，支持点击组件再深入；模块目录用途、外部依赖、版本及每条关系均给出准确源码依据。架构关系不是调用时序，保留关键调用、输入输出与未分析范围。';
export const overviewQuestion=architectureOverviewQuestion+' 首次分析采用轻量发现：查阅页面导航、入口、路由、说明等，列出当前能确认的全部业务功能，按业务区域放入 feature_catalog.groups；scope 写明已查范围和未覆盖部分。功能目录引用独立 kind=stage 节点，仅名称、一句话用途及源码依据，inputs/outputs 可为空；不要展开每个功能的内部调用、完整流程或所有异常。后续用户点击功能时再单独深入。不能只列出用户已手动创建的功能，不能把文件或技术模块冒充业务功能。';
const text=(value:unknown,max=20000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`请输入 1–${max} 个字符`);return value.trim();};
export class ArcService {
  readonly store:Store;
  readonly active=new Map<string,ActiveProcess>();
  readonly indexing=new Map<string,AbortController>();
  readonly executing=new Map<string,Promise<void>>();
  private closing=false;
  constructor(readonly directory:string,readonly resources:string,readonly emit:(e:any)=>void=()=>{}) {
    this.store=new Store(directory);
    for(const run of this.store.all<Run>('run'))if(!terminal.has(run.status)&&run.status!=='unknown'){run.status='unknown';run.error='Arc 上次退出前未记录终态；不会自动重发。请核查原会话，或明确新建关联重试。';this.store.put('run',run.binding.run_id,run);}
  }
  data():WorkspaceData {
    return {projects:this.store.all('project'),features:this.store.all('feature'),scenarios:this.store.all('scenario'),revisions:this.store.all('revision'),annotations:this.store.all('annotation'),runs:this.store.all('run'),explanations:this.store.all('explanation'),providers:this.store.all('provider'),snapshots:this.store.all('snapshot'),requested_analysis:this.store.maybe('setting','mcp-requested-analysis')??undefined};
  }
  changed(){this.emit({type:'changed'});}
  async openProject(rootPath:string,fictional=false,buildConfig='') {
    const real=await fs.realpath(rootPath);
    const exists=this.store.all<Project>('project').find(p=>p.root_path.toLowerCase()===real.toLowerCase()&&p.fictional===fictional);
    if(exists){await this.checkFreshness(exists.project_id);return exists;}
    const projectId=id('project'),controller=new AbortController();this.indexing.set(projectId,controller);
    this.emit({type:'indexing',project_id:projectId,project_name:path.basename(real),root_path:real,count:0});
    try {
      const snapshot=await capture(real,projectId,this.directory,buildConfig,controller.signal,n=>this.emit({type:'indexing',project_id:projectId,project_name:path.basename(real),root_path:real,count:n}));
      const project:Project={project_id:projectId,name:path.basename(real),root_path:real,snapshot_id:snapshot.source_snapshot_id,fictional,build_config:buildConfig,created_at:now()};
      this.store.transaction(()=>{this.store.put('project',projectId,project);this.store.put('snapshot',snapshot.source_snapshot_id,snapshot);});
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
      if((scene.question===oldOverviewQuestion||scene.question===architectureOverviewQuestion)){
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
    const active=this.store.all<Run>('run').find(r=>r.binding.scenario_id===scene!.scenario_id&&!terminal.has(r.status)&&r.status!=='unknown');
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
  prepareAnalysis(scenarioId:string){
    const scene=this.store.get<Scenario>('scenario',scenarioId),project=this.store.get<Project>('project',scene.project_id),feature=this.store.get<Feature>('feature',scene.feature_id);
    if(project.fictional)throw Error('演示工程不派发真实分析');
    if(scene.archived||feature.archived)throw Error('请先恢复已归档功能或场景');
    const source=this.analysisSnapshot(scene);
    const active=this.store.all<Run>('run').find(r=>r.binding.scenario_id===scenarioId&&['queued','running','validating','cancel_requested'].includes(r.status));
    if(active)return {run_id:active.binding.run_id};
    this.store.put('setting','mcp-requested-analysis',{project_id:scene.project_id,scenario_id:scenarioId,source_snapshot_id:source,question_revision_id:scene.question_revision_id,created_at:now()});
    this.changed();return {scenario_id:scenarioId};
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
  async probe(config?:Record<string,string>) {
    if(config){for(const [key,value]of Object.entries(config))if(!['codex_path','dsh_path'].includes(key)||typeof value!=='string')throw new Error('不支持的连接配置');this.store.put('settings','providers',config);}
    const profiles=await probeProviders(config||this.store.maybe('settings','providers')||{});
    const dsh=profiles.find(p=>p.provider_id==='dsh');
    if(dsh?.path&&dsh.version)Object.assign(dsh,await probeDsh(this.directory,dsh.path,dsh.version));
    for(const p of profiles)this.store.put('provider',p.provider_id,p);this.changed();return profiles;
  }
  async startRun(scenarioId:string,providerId:string,submissionKey:string,previousRunId?:string) {
    if(this.closing)throw new Error('Arc 正在退出，未派发新任务');
    if(!['codex','dsh','workbuddy'].includes(providerId))throw new Error('请选择真实 Provider；演示单独装载');
    if(!/^[\w-]{8,100}$/.test(submissionKey))throw new Error('提交幂等键无效');
    const existing=this.store.all<Run>('run').find(r=>r.submission_key===submissionKey);
    if(existing){if(existing.binding.scenario_id!==scenarioId||existing.provider_id!==providerId)throw new Error('幂等键归属冲突');return existing;}
    const scenario=this.store.get<Scenario>('scenario',scenarioId),project=this.store.get<Project>('project',scenario.project_id);
    if(project.fictional)throw new Error('演示工程不调用真实 Provider；请打开实际工程或测试源码目录');
    const busy=this.store.all<Run>('run').find(r=>r.binding.scenario_id===scenarioId&&r.provider_id===providerId&&!terminal.has(r.status)&&r.status!=='unknown');
    if(busy)throw new Error('该场景同一 Provider 已有进行中的运行；请先等待或停止');
    if(previousRunId){const previous=this.store.get<Run>('run',previousRunId);if(previous.binding.scenario_id!==scenarioId)throw new Error('前次运行不属于此场景');}
    // Freeze synchronously before yielding; UI changes cannot change this envelope.
    const runId=id('run');
    const run:Run={binding:{project_id:project.project_id,feature_id:scenario.feature_id,scenario_id:scenarioId,question_revision_id:scenario.question_revision_id,source_snapshot_id:this.analysisSnapshot(scenario),run_id:runId},provider_id:providerId as Run['provider_id'],status:'queued',question:scenario.question,title:scenario.title,created_at:now(),submission_key:submissionKey,previous_run_id:previousRunId,output_path:path.join(this.directory,'runs',runId,'result.json')};
    this.store.put('run',runId,run);this.changed();
    this.event(runId,{type:'local.stage',stage:'queued',message:'任务与源码快照已绑定，正在准备 Agent 连接'});
    const task=this.execute(run).catch(error=>this.fail(runId,error)).finally(()=>this.executing.delete(runId));
    this.executing.set(runId,task);
    return run;
  }
  private fail(runId:string,error:unknown) {
    this.active.delete(runId);
    const run=this.store.get<Run>('run',runId);
    if(terminal.has(run.status))return;
    run.status=(error as any)?.remoteUnknown?'unknown':'failed';run.error=redact((error as Error).message);run.ended_at=now();this.store.put('run',runId,run);this.changed();
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
    if(!profile){await this.probe();profile=this.store.get('provider',initial.provider_id);}
    const freshRun=this.store.get<Run>('run',runId);
    if(freshRun.status==='cancelled'||this.closing)return;
    if(!profile||profile.status!=='available'||!['codex','dsh'].includes(initial.provider_id)){
      freshRun.status='blocked_external';freshRun.error=profile?.reason||'缺少受支持的真实适配通道';freshRun.ended_at=now();this.store.put('run',runId,freshRun);this.changed();return;
    }
    const snapshot=this.store.get<Snapshot>('snapshot',initial.binding.source_snapshot_id);
    const annotations=this.store.all<Annotation>('annotation').filter(a=>a.scenario_id===initial.binding.scenario_id);
    const previous=this.store.all<Explanation>('explanation').filter(e=>e.scenario_id===initial.binding.scenario_id).at(-1);
    const prompt=await makePrompt(initial,snapshot,this.directory,annotations,previous?{result_id:previous.result_id,binding:previous.result.binding,summary:previous.result.summary}:undefined);
    this.event(runId,{type:'local.stage',stage:'launching',message:`只读任务已准备，正在启动 ${initial.provider_id} 官方后端`});
    if(this.store.get<Run>('run',runId).status==='cancelled'||this.closing)return;
    const result=await (initial.provider_id==='dsh'?runDshWeb:runCodex)({run:initial,snapshot,storage:this.directory,resources:this.resources,profile,prompt,
      event:event=>this.event(runId,event),
      started:active=>{this.active.set(runId,active);const run=this.store.get<Run>('run',runId);run.status='running';run.pid=active.child.pid;run.runtime_version=profile!.version;this.store.put('run',runId,run);this.changed();}
    });
    this.active.delete(runId);
    const run=this.store.get<Run>('run',runId);
    if(run.status==='cancel_requested'){
      if(initial.provider_id==='dsh'&&(!('cancelled'in result)||!result.cancelled)){run.status='unknown';run.error='已发出停止请求，但未得到 ACP 取消终态；请核查原生会话。';}
      else{run.status='cancelled';run.ended_at=now();run.error='已确认本地进程退出或 ACP 取消终态；保留此前事件及原始部分。';}
      this.store.put('run',runId,run);this.changed();return;
    }
    const protocolError='protocol_error'in result?result.protocol_error:undefined;
    if(result.code!==0||protocolError)throw new Error(`${initial.provider_id} 未成功完成（exit=${result.code}）：${protocolError||result.stderr.slice(-2500)}`);
    let value:unknown;
    try{const audit:string[]=[];value=normalizeTransport(parseProviderText(result.raw,initial.provider_id),audit);if(audit.length)this.event(runId,{type:'local.format_normalization',changes:audit});}catch{throw new Error('真实返回不是合法 JSON，原始文件已保留；未生成正式关系图。');}
    await this.acceptResult(runId,value);
  }
  async acceptResult(runId:string,value:unknown) {
    const run=this.store.get<Run>('run',runId),snapshot=this.store.get<Snapshot>('snapshot',run.binding.source_snapshot_id);
    if(['cancel_requested','cancelled','failed'].includes(run.status))throw new Error('终止后的迟到结果保留为原始材料，不发布为新说明');
    if(run.status==='completed')return run;
    run.status='validating';this.store.put('run',runId,run);
    this.event(runId,{type:'local.stage',stage:'validating',message:'完整结果已收到，正在校验结构、任务绑定和源码行号'});this.changed();
    const report=await validateResult(value,run,snapshot,this.directory);
    if(['cancel_requested','cancelled','failed'].includes(this.store.get<Run>('run',runId).status))throw new Error('校验期间收到停止请求，迟到结果不发布');
    run.validation=report;
    if(report.errors.length){run.status='failed';run.error=`结果校验失败：${report.errors.slice(0,5).join('；')}`;run.ended_at=now();this.store.put('run',runId,run);this.changed();return run;}
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
    if(run.origin==='mcp'){run.status='cancelled';run.ended_at=now();run.error='Arc 已撤销本次任务的读取和结果写回权限；Agent 对话不会被远程停止，请在 Agent 中停止生成。';this.store.put('run',runId,run);this.changed();return run;}
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
    const bundle={format:'arc-export-v1',exported_at:now(),project,features:data.features.filter(x=>x.project_id===projectId),scenarios:data.scenarios.filter(x=>x.project_id===projectId),revisions:data.revisions.filter(x=>data.scenarios.some(s=>s.project_id===projectId&&s.scenario_id===x.scenario_id)),annotations:data.annotations.filter(x=>x.project_id===projectId),explanations:data.explanations.filter(x=>x.result.binding.project_id===projectId),runs,snapshots,contents};
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
    for(const controller of this.indexing.values())controller.abort();
    await Promise.allSettled([...this.executing.keys()].map(k=>this.cancel(k)));
    // Wait for real terminal events before the SQLite connection is closed.
    const pending=Promise.allSettled([...this.executing.values()]);
    const timer=setTimeout(()=>{for(const [runId,active]of this.active){
      this.event(runId,{type:'shutdown.local_disconnect',reason:'退出等待超过 12 秒；关闭自有子进程，远端终态以协议记录为准'});
      void stopTree(active.child).catch(()=>{});
    }},12000);
    await pending;clearTimeout(timer);
    await closeDshWebHosts();
    while(this.indexing.size)await new Promise(resolve=>setTimeout(resolve,20));
  }
  async providerSessionUrl(runId:string){
    const run=this.store.get<Run>('run',runId);if(run.provider_id!=='dsh'||run.native_ui!=='dsh-web')throw Error('该运行不支持原生图形会话');
    const profile=this.store.get<ProviderProfile>('provider','dsh');return dshWebSessionUrl({run,profile,storage:this.directory,resources:this.resources});
  }
}

