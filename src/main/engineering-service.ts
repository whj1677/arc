import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Project,Snapshot,Explanation,Feature,Scenario} from '../shared';
import {engineeringCategories,engineeringSectionCategories,type SaveEngineeringEntry,type EngineeringSectionCategory} from '../engineering';
import type {CodeState,WorkspaceBinding,ContextEntry,ContextSource,EngineeringContext,EngineeringAnalysis,ContextRequest,EngineeringTask,CreateEngineeringTask,UpdateEngineeringTask,FinishEngineeringTask,DevelopmentAttempt,VerificationEvidence,TaskReadingBinding,WalkthroughUpdate,DevelopmentStep} from '../engineering';
import {Store,id,now} from './store';
import {capture,freshness,readSource,sha,relativePath,safeFile,workspaceFiles,workspaceGitDirectory} from './snapshot';
import {exportEngineeringProject,restoreEngineeringProject} from './engineering-transfer';
import {scanAecLegacy,type AecScan,type AecLegacyDocument} from './aec-migration';
import {readingTarget} from './prompt-context';

const exec=promisify(execFile), workspaceKind='engineering_workspace', contextKind='engineering_context', taskKind='engineering_task', attemptKind='development_attempt';
const requireText=(v:unknown,max=20000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error(`请输入 1–${max} 个字符`);return v.trim();};
const samePath=(a:string,b:string)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
async function git(root:string,args:string[]) {return (await exec('git',['-C',root,...args],{windowsHide:true,timeout:10000,maxBuffer:16*1024*1024})).stdout.trim();}
function stateFiles(snapshot:Snapshot,state?:Pick<CodeState,'assets'>) {
  return new Map([...snapshot.files.map(f=>[f.path,f.content_sha256] as const),...(state?.assets??[]).map(f=>[f.path,f.sha256] as const)]);
}
export function sameVerificationState(a:CodeState,b:CodeState) {
  return !!a.workspace_fingerprint&&a.workspace_fingerprint===b.workspace_fingerprint&&a.head===b.head&&a.branch===b.branch&&a.git_common_dir===b.git_common_dir;
}
// Explicit document names only; README/purpose is not a completed plan.
export function engineeringDocumentCategory(file:string):EngineeringSectionCategory|undefined {
  const name=path.posix.basename(file).replace(/\.(?:md|txt|json)$/i,'').toLowerCase().replace(/[_ ]/g,'-').replace(/^\d+-/,'');
  if(/^(?:verification|verification-plan|test-plan|acceptance-plan|验证计划|测试计划|验收计划)$/.test(name))return 'verification_plan';
  if(/^(?:architecture|system-architecture|架构|系统架构)$/.test(name))return 'architecture';
  if(/^(?:design|detailed-design|technical-design|设计|详细设计|技术设计)$/.test(name))return 'design';
  if(/^(?:plan|implementation-plan|development-plan|proposal|方案|实施方案|开发计划)$/.test(name))return 'plan';
  return undefined;
}
export class EngineeringService {
  private readonly capturing=new Map<string,Promise<CodeState>>();
  private readonly scanning=new Map<string,Promise<void>>();
  private readonly initializing=new Map<string,Promise<void>>();
  onTaskFinished:(task:EngineeringTask)=>void=()=>{};
  constructor(readonly store:Store,readonly changed:()=>void=()=>{}) {
    for(const attempt of store.all<DevelopmentAttempt>(attemptKind))if(['starting','running'].includes(attempt.status)) {
      if(attempt.origin==='agent'){attempt.connection_status='unknown';attempt.error='ARC 已重启，外部 Agent 会话可能仍在开发；等待回填确认，不自动重发。';store.put(attemptKind,attempt.attempt_id,attempt);continue;}
      attempt.status='interrupted';attempt.ended_at=now();attempt.error='ARC 重启前未保存终态；请核查原会话，不会自动重放写操作。';store.put(attemptKind,attempt.attempt_id,attempt);
      const task=store.get<EngineeringTask>(taskKind,attempt.task_id);
      if(task.status==='running'){task.status='interrupted';task.unresolved=[...task.unresolved,attempt.error];this.saveTask(task);}
    }
  }
  async connect(projectId:string):Promise<WorkspaceBinding> {
    const project=this.store.get<Project>('project',projectId);
    const prior=this.store.all<WorkspaceBinding>(workspaceKind).find(w=>w.project_id===projectId);
    if(prior)return prior;
    const root=await fs.realpath(project.root_path);
    const common=await workspaceGitDirectory(root);
    const workspace:WorkspaceBinding={workspace_id:id('workspace'),project_id:projectId,root_path:root,status:'bound',git_common_dir:common,created_at:now()};
    this.store.put(workspaceKind,workspace.workspace_id,workspace);
    await this.context({project_id:projectId});return workspace;
  }
  async resolve(input:ContextRequest):Promise<WorkspaceBinding> {
    let workspace:WorkspaceBinding|undefined;
    if(input.workspace_path){const real=await fs.realpath(input.workspace_path);workspace=this.store.all<WorkspaceBinding>(workspaceKind).find(w=>w.status==='bound'&&samePath(w.root_path,real));if(!workspace)throw Error('此工作区尚未绑定 ARC 工程，请先连接工程。');if(input.project_id&&input.project_id!==workspace.project_id)throw Error('工作区与工程归属不一致');}
    else if(input.project_id)workspace=this.store.all<WorkspaceBinding>(workspaceKind).find(w=>w.project_id===input.project_id);
    if(!workspace)throw Error('必须指定已连接工程或真实工作区');
    if(workspace.status!=='bound')throw Error('恢复的工程尚未绑定本机工作区，请先重新绑定');
    return workspace;
  }
  async captureState(projectId:string,workspacePath?:string):Promise<CodeState> {
    await this.resolve({project_id:projectId,workspace_path:workspacePath});
    const pending=this.capturing.get(projectId);if(pending)return pending;
    const capture=this.captureStateActual(projectId,workspacePath);this.capturing.set(projectId,capture);
    try{return await capture;}finally{this.capturing.delete(projectId);}
  }
  private async captureStateActual(projectId:string,workspacePath?:string):Promise<CodeState> {
    const workspace=await this.resolve({project_id:projectId,workspace_path:workspacePath});
    const project=this.store.get<Project>('project',projectId);
    const common=await workspaceGitDirectory(workspace.root_path);
    let head:string|null=null,branch:string|null=null,dirty:string[]=[];
    if(common){branch=await git(workspace.root_path,['symbolic-ref','--short','-q','HEAD']).catch(()=>null);head=await git(workspace.root_path,['rev-parse','HEAD']).catch(()=>null);
      const modified=await git(workspace.root_path,['diff','--name-only','-z','HEAD']).catch(()=>git(workspace.root_path,['diff','--name-only','-z','--cached']));
      const untracked=await git(workspace.root_path,['ls-files','--others','--exclude-standard','-z']);dirty=[...new Set([...modified.split('\0'),...untracked.split('\0')].filter(Boolean))];
    }
    const cached=this.store.maybe<CodeState>('engineering_state',workspace.workspace_id);
    let snapshot=cached?this.store.get<Snapshot>('snapshot',cached.snapshot_id):this.store.get<Snapshot>('snapshot',project.snapshot_id);
    if(!samePath(snapshot.root_path,workspace.root_path)||(await freshness(snapshot)).length){snapshot=await capture(workspace.root_path,projectId,this.store.directory,project.build_config);this.store.put('snapshot',snapshot.source_snapshot_id,snapshot);}
    const identity=await workspaceFiles(workspace.root_path,snapshot);
    if(common){const after=await git(workspace.root_path,['rev-parse','HEAD']).catch(()=>null),afterBranch=await git(workspace.root_path,['symbolic-ref','--short','-q','HEAD']).catch(()=>null);if(after!==head||afterBranch!==branch)throw Error('采集过程中分支或 HEAD 变化，请重试');}
    const state:CodeState={snapshot_id:snapshot.source_snapshot_id,fingerprint:snapshot.fingerprint,head,branch,git_common_dir:common,dirty,captured_at:now(),workspace_fingerprint:identity.fingerprint,assets:identity.assets};
    const currentWorkspace=this.store.get<WorkspaceBinding>(workspaceKind,workspace.workspace_id);if(currentWorkspace.status!=='bound'||!samePath(currentWorkspace.root_path,workspace.root_path))throw Error('采集期间工作区已重新绑定，请重新读取');
    this.store.put('engineering_state',workspace.workspace_id,state);return state;
  }
  async context(input:ContextRequest):Promise<EngineeringContext> {
    if(input.view!==undefined&&!['strict','execution'].includes(input.view))throw Error('上下文读取模式无效');
    const restored=input.project_id&&!input.workspace_path?this.store.all<WorkspaceBinding>(workspaceKind).find(w=>w.project_id===input.project_id&&w.status==='unbound'):undefined;
    const workspace=restored??await this.resolve(input),projectId=workspace.project_id;
    const state=restored?this.store.get<CodeState>('engineering_state',workspace.workspace_id):await this.captureState(projectId);
    const old=this.store.maybe<{fingerprint:string;version:number}>('engineering_context_state',projectId);
    if(!restored&&(input.refresh||!old||old.fingerprint!==state.fingerprint)){
      const pending=this.scanning.get(projectId);if(pending)await pending;else{const scan=this.scanContext(projectId,state);this.scanning.set(projectId,scan);try{await scan;}finally{this.scanning.delete(projectId);}}
    }
    if(input.task_id&&this.task(input.task_id).project_id!==projectId)throw Error('任务不属于当前工程');
    if(!restored)await this.initializeMaterials(projectId,state);
    let reclassified=false;
    for(const entry of this.store.all<ContextEntry>(contextKind))if(entry.project_id===projectId&&entry.legacy_import&&entry.origin==='document'){
      const category=engineeringDocumentCategory(entry.legacy_import.import_key.replace(/^aec:/,''));
      if(category&&category!==entry.category){entry.category=category;entry.version++;entry.updated_at=now();this.store.putVersion(contextKind,entry.entry_id,entry.version,entry);reclassified=true;}
    }
    if(reclassified){const current=this.store.get<any>('engineering_context_state',projectId);current.version++;this.store.put('engineering_context_state',projectId,current);}
    const contextState=this.store.get<{version:number}>('engineering_context_state',projectId);
    if(input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||input.offset<0)||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1))throw Error('上下文分页参数无效');
    const all=this.store.all<ContextEntry>(contextKind).filter(e=>e.project_id===projectId);
    const replaced=new Set(all.filter(e=>e.status!=='superseded'&&e.supersedes).map(e=>e.supersedes));
    // A direct correction of an original source also invalidates an aggregate
    // that still quotes that original. Keep the other uncovered sources visible.
    for(const entry of all.filter(e=>e.status!=='superseded'&&!replaced.has(e.entry_id)))if(entry.covered_entries?.some(source=>replaced.has(source)))replaced.add(entry.entry_id);
    for(const entry of all.filter(e=>e.status!=='superseded'&&!replaced.has(e.entry_id)))for(const covered of entry.covered_entries??[])replaced.add(covered);
    const entries=all.filter(e=>(input.entry_id?e.entry_id===input.entry_id:e.status!=='superseded'&&!replaced.has(e.entry_id))&&(input.view==='execution'?(!e.task_id||e.task_id===input.task_id):(input.task_id===undefined||(e.task_id??'')===input.task_id))&&(!input.category||e.category===input.category)&&(!input.query||`${e.key}\n${e.text}`.toLowerCase().includes(input.query.toLowerCase())));
    const categories:ContextEntry['category'][]=['rule','purpose','build','issue','architecture','module','interface','technology','decision','plan','design','verification_plan'];
    const groups=categories.map(category=>entries.filter(e=>e.category===category).sort((a,b)=>Number(b.origin==='user')-Number(a.origin==='user')||Number(b.key.startsWith('initial:'))-Number(a.key.startsWith('initial:'))||Number(b.status==='current')-Number(a.status==='current')||a.key.localeCompare(b.key)));
    const ordered:ContextEntry[]=[];for(let i=0;i<Math.max(...groups.map(group=>group.length));i++)for(const group of groups)if(group[i])ordered.push(group[i]);
    const offset=input.entry_id?0:input.offset??0,limit=input.entry_id?1:Math.min(input.limit??24,40),maxText=input.entry_id?60000:1500;
    const page=ordered.slice(offset,offset+limit).map(e=>{
      const source=e.supersedes?all.find(s=>s.entry_id===e.supersedes):undefined;
      const changed=source&&(e.source_version?source.version!==e.source_version:source.sources.some(s=>!e.sources.some(old=>old.path===s.path&&old.content_sha256===s.content_sha256)));
      const previous=source&&changed?this.history('context',source.entry_id).find(v=>e.source_version?v.version===e.source_version:v.sources.every((s:ContextSource)=>e.sources.some(old=>old.path===s.path&&old.content_sha256===s.content_sha256))):undefined;
      return {...e,text:e.text.slice(0,maxText),truncated:e.text.length>maxText,...(source&&changed?{update_suggestion:{source_entry_id:source.entry_id,source_version:source.version,previous_text:previous?.text??'原来源见冻结引用',proposed_text:source.text}}:{})};
    });
    const analysis=input.result_id?this.readAnalysis(input.result_id,workspace,state,input):undefined;
    return {project_id:projectId,workspace,version:contextState.version,code_state:state,entries:input.result_id?[]:page,total_entries:ordered.length,next_offset:input.result_id?null:offset+limit<ordered.length?offset+limit:null,analysis_refs:this.store.all<Explanation>('explanation').filter(e=>e.result.binding.project_id===projectId).slice(-10).map(e=>({result_id:e.result_id,source_snapshot_id:e.result.binding.source_snapshot_id,status:this.analysisStatus(e,workspace,state),architecture:!!e.result.architecture?.node_ids.length,summary:e.result.summary.text.slice(0,500)})),...(analysis?{analysis}:{}),recent_tasks:this.tasks({project_id:projectId}).filter(t=>t.workspace_id===workspace.workspace_id&&(input.view!=='execution'||t.task_id===input.task_id)).slice(0,5).map(t=>this.currentVerification(t,restored?undefined:state)).map(t=>({task_id:t.task_id,goal:t.goal.slice(0,1000),status:t.status,summary:t.summary.slice(0,1500),version:t.version,updated_at:t.updated_at,verification_status:t.verification_status,decisions:t.decisions.slice(0,5).map(s=>s.slice(0,500)),unresolved:t.unresolved.slice(0,5).map(s=>s.slice(0,500))}))};
  }
  async executionContext(projectId:string,taskId:string):Promise<EngineeringContext>{
    let context=await this.context({project_id:projectId,task_id:taskId,view:'execution',limit:40});
    const entries=[...context.entries];
    while(context.next_offset!==null){context=await this.context({project_id:projectId,task_id:taskId,view:'execution',limit:40,offset:context.next_offset});entries.push(...context.entries);}
    return {...context,entries:entries.map(e=>({...e,text:this.store.get<ContextEntry>(contextKind,e.entry_id).text,truncated:false})),next_offset:null};
  }
  private analysisStatus(explanation:Explanation,workspace:WorkspaceBinding,state:CodeState):EngineeringAnalysis['status']{if(workspace.status==='unbound')return 'unbound';return explanation.source_status==='current'&&this.store.get<Snapshot>('snapshot',explanation.result.binding.source_snapshot_id).fingerprint===state.fingerprint?'current':'needs_review';}
  private readAnalysis(resultId:string,workspace:WorkspaceBinding,state:CodeState,input:ContextRequest):EngineeringAnalysis {
    const explanation=this.store.get<Explanation>('explanation',resultId),result=explanation.result;
    if(result.binding.project_id!==workspace.project_id)throw Error('工程分析不属于当前授权工作区');
    const source=this.store.get<Snapshot>('snapshot',result.binding.source_snapshot_id);
    if(source.project_id!==workspace.project_id)throw Error('工程分析来源快照归属不一致');
    const query=input.query?.trim().toLowerCase(),matches=(values:unknown[])=>!query||values.join('\n').toLowerCase().includes(query);
    const evidenceById=new Map(result.evidence.map(e=>[e.evidence_id,e])),sourceNames=(ids:readonly string[])=>ids.map(id=>evidenceById.get(id)?.path??'');
    const matchingNodes=result.nodes.filter(n=>matches([n.node_id,n.label,n.description,n.source_scope?.path,...sourceNames(n.evidence_ids)]));
    const nodeIds=new Set(matchingNodes.map(n=>n.node_id));
    const matchingEdges=result.edges.filter(e=>matches([e.edge_id,e.label,e.kind,e.condition,...sourceNames(e.evidence_ids)])||!!query&&(nodeIds.has(e.source_node_id)||nodeIds.has(e.target_node_id)));
    const items=[...matchingNodes.map(node=>({node})),...matchingEdges.map(edge=>({edge}))];
    const offset=input.offset??0,limit=Math.min(input.limit??24,40),selected=items.slice(offset,offset+limit);
    const nodes=selected.flatMap(item=>'node'in item?[{node_id:item.node.node_id,kind:item.node.kind,label:item.node.label.slice(0,500),description:item.node.description.slice(0,1500),parent_node_id:item.node.parent_node_id,source_scope:item.node.source_scope,claim_ids:item.node.claim_ids.slice(0,20),evidence_ids:item.node.evidence_ids.slice(0,20),in_architecture:!!result.architecture?.node_ids.includes(item.node.node_id),truncated:item.node.label.length>500||item.node.description.length>1500||item.node.claim_ids.length>20||item.node.evidence_ids.length>20}]:[]);
    const edges=selected.flatMap(item=>'edge'in item?[{edge_id:item.edge.edge_id,kind:item.edge.kind,source_node_id:item.edge.source_node_id,target_node_id:item.edge.target_node_id,label:item.edge.label.slice(0,500),status:item.edge.status,condition:item.edge.condition?.slice(0,1500),claim_ids:item.edge.claim_ids.slice(0,20),evidence_ids:item.edge.evidence_ids.slice(0,20),in_architecture:!!result.architecture?.edge_ids.includes(item.edge.edge_id),truncated:item.edge.label.length>500||(item.edge.condition?.length??0)>1500||item.edge.claim_ids.length>20||item.edge.evidence_ids.length>20}]:[]);
    const claimIds=new Set([...result.summary.claim_ids.slice(0,20),...nodes.flatMap(n=>n.claim_ids),...edges.flatMap(e=>e.claim_ids)]);
    const matchingClaims=result.claims.filter(c=>claimIds.has(c.claim_id)),claims=matchingClaims.slice(0,80).map(c=>({...c,statement:c.statement.slice(0,1500),rationale:c.rationale.slice(0,1500),limitations:c.limitations.slice(0,10).map(s=>s.slice(0,500)),evidence_ids:c.evidence_ids.slice(0,20),targets:{node_ids:c.targets.node_ids.slice(0,40),edge_ids:c.targets.edge_ids.slice(0,40),io_ids:c.targets.io_ids.slice(0,40)}}));
    const evidenceIds=new Set([...nodes.flatMap(n=>n.evidence_ids),...edges.flatMap(e=>e.evidence_ids),...claims.flatMap(c=>c.evidence_ids)]),matchingEvidence=result.evidence.filter(e=>evidenceIds.has(e.evidence_id));
    const relatedNodeIds=new Set([...edges.flatMap(e=>[e.source_node_id,e.target_node_id]),...nodes.map(n=>n.parent_node_id).filter((id):id is string=>!!id)]);
    return {result_id:explanation.result_id,binding:result.binding,created_at:explanation.created_at,source_snapshot_id:source.source_snapshot_id,source_fingerprint:source.fingerprint,source_status:explanation.source_status,status:this.analysisStatus(explanation,workspace,state),summary:result.summary.text.slice(0,2000),coverage:{covered_scope:result.coverage.covered_scope.slice(0,10).map(s=>s.slice(0,1000)),unresolved_scope:result.coverage.unresolved_scope.slice(0,10).map(s=>s.slice(0,1000))},nodes,edges,node_refs:result.nodes.filter(n=>relatedNodeIds.has(n.node_id)).map(n=>({node_id:n.node_id,label:n.label.slice(0,500),kind:n.kind})),claims,evidence:matchingEvidence.slice(0,160).map(e=>({...e,note:e.note.slice(0,1500)})),total_items:items.length,next_offset:offset+limit<items.length?offset+limit:null,truncated:result.summary.text.length>2000||nodes.some(n=>n.truncated)||edges.some(e=>e.truncated)||matchingClaims.length>80||matchingEvidence.length>160||matchingClaims.some(c=>c.statement.length>1500||c.rationale.length>1500||c.evidence_ids.length>20||c.limitations.length>10)||result.coverage.covered_scope.length>10||result.coverage.unresolved_scope.length>10};
  }
  /** Derive editable reading material from the existing scan and published overview.
   * No model call, source writes, or execution claims are made here. */
  private async initializeMaterials(projectId:string,state:CodeState):Promise<void> {
    const pending=this.initializing.get(projectId);if(pending){await pending;return this.initializeMaterials(projectId,state);}
    const work=this.initializeMaterialsActual(projectId,state);this.initializing.set(projectId,work);
    try{await work;}finally{this.initializing.delete(projectId);}
  }
  private async initializeMaterialsActual(projectId:string,state:CodeState) {
    const project=this.store.get<Project>('project',projectId);
    const explanation=project.overview_scenario_id?this.store.all<Explanation>('explanation').filter(e=>e.result.binding.project_id===projectId&&e.scenario_id===project.overview_scenario_id).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0]:undefined;
    const stamp=state.fingerprint+':'+(explanation?.result_id??'waiting');
    if(this.store.maybe<string>('engineering_materials_state',projectId)===stamp)return;
    const snapshot=this.store.get<Snapshot>('snapshot',state.snapshot_id),entries=this.store.all<ContextEntry>(contextKind).filter(e=>e.project_id===projectId&&!e.task_id);
    const root=entries.filter(e=>e.sources[0]&&!e.sources[0].path.includes('/')&&!e.legacy_import&&!e.key.startsWith('initial:')&&!['user','agent'].includes(e.origin));
    const result=explanation?.result;
    const references=(items:ContextEntry[])=>Array.from(new Map(items.flatMap(e=>e.sources).map(s=>[`${s.snapshot_id}:${s.path}:${s.line_start}`,s])).values()).slice(0,40);
    const quoted=(items:ContextEntry[])=>items.map(e=>`### ${e.sources[0]?.path??e.key}\n\n${e.text.length>10000?e.text.slice(0,10000)+'\n\n（来源节选；完整原文可通过来源引用读取。）':e.text}`).join('\n\n');
    const evidence=(ids:readonly string[])=>result?.evidence.filter(e=>ids.includes(e.evidence_id)).map(e=>({path:e.path,snapshot_id:e.source_snapshot_id,content_sha256:e.content_sha256,line_start:e.line_start,line_end:e.line_end}))??[];
    const sourceRefs=result?evidence(result.evidence.map(e=>e.evidence_id)).slice(0,40):[];
    const missing='尚未取得工程全貌分析。请通过现有“开始工程分析”连接外部 Codex；完成后这里自动归纳已查源码及待确认项。';
    const docs=root.filter(e=>e.category==='purpose');
    const builds=root.filter(e=>e.category==='build');
    const rules=root.filter(e=>e.category==='rule');
    const historyFiles=snapshot.files.filter(f=>/^(?:docs\/)?(?:DECISIONS|KNOWN[-_]ISSUES|CHANGELOG)\.md$/i.test(f.path));
    const history=await Promise.all(historyFiles.map(async f=>({text:(await readSource(this.store.directory,snapshot,f.path)).text,path:f.path,source:{path:f.path,snapshot_id:state.snapshot_id,content_sha256:f.content_sha256,line_start:1,line_end:f.line_count}})));
    const proposals:{category:ContextEntry['category'];title:string;text:string;sources:ContextSource[]}[]=[
      {category:'purpose',title:'工程概述',text:`# ${project.name} · 工程概述\n\n${result?result.summary.text:missing}\n\n## 根工程文档声明\n\n${quoted(docs)||'根目录未发现用途文档；不能仅凭目录名推断业务用途。'}\n\n## 阅读边界\n\n${result?result.coverage.unresolved_scope.map(s=>'- '+s).join('\n')||'当前全貌未列出额外缺口；这不等于已覆盖全部源码或完成全仓审计。':'源码职责尚待外部 Codex 分析，扫描事实不代替语义审查。'}`,sources:[...references(docs),...sourceRefs].slice(0,40)},
      {category:'architecture',title:'当前架构与接口',text:`# 当前架构与接口\n\n${result?'以下来自已保存的源码分析；属于 Agent 归纳，编辑本说明不会修改源码。':missing}\n\n${result?result.nodes.filter(n=>result.architecture?.node_ids.includes(n.node_id)).map(n=>`## ${n.label}\n\n${n.description}`).join('\n\n'):''}\n\n## 协作与接口\n\n${result?result.edges.filter(e=>result.architecture?.edge_ids.includes(e.edge_id)).map(e=>`- ${result.nodes.find(n=>n.node_id===e.source_node_id)?.label??e.source_node_id} → ${result.nodes.find(n=>n.node_id===e.target_node_id)?.label??e.target_node_id}：${e.label}（${e.kind}，${e.status}）`).join('\n')||'尚无有依据的接口关系；需继续读取公开入口。':quoted(root.filter(e=>e.category==='interface'))||'扫描未确认公开接口；需读取入口及调用方。'}`,sources:sourceRefs.length?sourceRefs:references(root.filter(e=>e.category==='interface'))},
      {category:'build',title:'构建运行与验证',text:`# 构建运行与验证\n\n## 根工程配置声明\n\n${quoted(builds)||'未发现可确认的根工程构建配置；请核对 README 中的运行步骤与实际工具环境。'}\n\n## 运行环境\n\n${quoted(root.filter(e=>e.category==='technology'))||'环境版本未由机器配置确认。'}\n\n## 实际验证状态\n\n初始化仅扫描配置与阅读源码，没有执行上述命令。实际执行证据位于开发任务的“验证”，绑定当时的代码状态；历史通过不代表当前版本已通过。`,sources:references([...builds,...root.filter(e=>e.category==='technology')])},
      {category:'rule',title:'工程约束与边界',text:`# 工程约束与边界\n\n${quoted(rules)||'根目录未发现 AGENTS.md / CLAUDE.md。业务限制、硬件条件与发布边界尚待工程负责人确认。'}\n\n## 资料与证据的边界\n\n- 本正文是工程资料，人工编辑不修改源码。\n- 用户约束与源码事实分别标注；发现冲突需核对，不自动覆盖。\n- 构建命令是配置声明；验证结论必须引用实际执行记录及对应代码版本。`,sources:references(rules)},
      {category:'decision',title:'历史决策',text:`# 历史决策\n\n${history.length?history.map(h=>`## ${h.path} · 历史文档声明\n\n${h.text.slice(0,10000)}${h.text.length>10000?'\n\n（节选；完整历史见原始来源。）':''}`).join('\n\n'):'未发现明确的决策记录。不能从当前代码反推当时的决策理由；后续确认后可在 ARC 补充。'}\n\n历史材料保留原始来源，不等于当前实现或当前验证。`,sources:history.map(h=>h.source)},
      {category:'issue',title:'已知问题与待确认项',text:`# 已知问题与待确认项\n\n${result?result.coverage.unresolved_scope.map(s=>'- '+s).join('\n')||'本轮全貌未声明已知问题；不代表工程没有缺陷。':missing}\n\n${quoted(root.filter(e=>e.category==='issue'))}\n\n## 尚未执行\n\n初始化未执行全量测试、真实设备联调或发布验收；需要时按本次任务范围验证。`,sources:[...sourceRefs,...references(root.filter(e=>e.category==='issue'))].slice(0,40)},
    ];
    if(result){
      proposals.push({category:'module',title:'模块职责',text:'# 模块职责 · Agent 源码归纳\n\n'+result.nodes.filter(n=>result.architecture?.node_ids.includes(n.node_id)).map(n=>`## ${n.label}\n\n${n.description}`).join('\n\n'),sources:sourceRefs});
      proposals.push({category:'interface',title:'接口与协作',text:'# 接口与协作 · Agent 源码归纳\n\n'+result.edges.filter(e=>result.architecture?.edge_ids.includes(e.edge_id)).map(e=>`- ${e.label}（${e.kind}，${e.status}）`).join('\n')+'\n\n这里只描述本轮已查证关系；完整接口签名与未覆盖路径仍需按来源读取。',sources:sourceRefs});
    }
    this.store.transaction(()=>{
      for(const proposal of proposals){
        const key='initial:'+proposal.category,old=entries.find(e=>e.key===key);
        if(old&&old.text===proposal.text&&JSON.stringify(old.sources)===JSON.stringify(proposal.sources))continue;
        const entry:ContextEntry={entry_id:old?.entry_id??id('context'),project_id:projectId,version:(old?.version??0)+1,key,category:proposal.category,origin:'agent',text:proposal.text,status:'needs_review',sources:proposal.sources,code_fingerprint:state.fingerprint,updated_at:now(),analysis_result_id:explanation?.result_id,covered_entries:(['module','interface'].includes(proposal.category)?entries:root).filter(e=>e.category===proposal.category&&!e.key.startsWith('initial:')&&!['user','agent'].includes(e.origin)).map(e=>e.entry_id)};
        this.store.putVersion(contextKind,entry.entry_id,entry.version,entry);
      }
      this.store.put('engineering_materials_state',projectId,stamp);
      const current=this.store.get<any>('engineering_context_state',projectId);current.version++;this.store.put('engineering_context_state',projectId,current);
    });
  }
  private async scanContext(projectId:string,state:CodeState) {
    const snapshot=this.store.get<Snapshot>('snapshot',state.snapshot_id),previous=this.store.all<ContextEntry>(contextKind).filter(e=>e.project_id===projectId),found=new Set<string>();
    const proposals:Omit<ContextEntry,'entry_id'|'version'|'updated_at'>[]=[];
    const add=(key:string,category:ContextEntry['category'],origin:ContextEntry['origin'],text:string,file:string,start=1,end?:number,status:ContextEntry['status']='current')=>{const f=snapshot.files.find(f=>f.path===file)!;found.add(key);proposals.push({project_id:projectId,key,category,origin,text,status,sources:[{path:file,snapshot_id:state.snapshot_id,content_sha256:f.content_sha256,line_start:start,line_end:Math.max(start,end??Math.min(f.line_count,80))}],code_fingerprint:state.fingerprint});};
    for(const file of snapshot.files) {
      const name=path.posix.basename(file.path);
      const section=engineeringDocumentCategory(file.path);
      if(section||/^(README(?:\.[^/]+)?|AGENTS\.md|CLAUDE\.md)$/i.test(name)||/(?:^|\/)(?:ai-context|ai_context|ai_engineering|engineering-context|requirements|changes|modules|interfaces)\//i.test(file.path)&&file.path.endsWith('.md')) {
        if(file.path.includes('REQ-0000-template'))continue;
        if(previous.some(e=>e.legacy_import?.sources.some(s=>s.path===file.path)&&e.legacy_import.source_kind!=='rule'))continue;
        const text=(await readSource(this.store.directory,snapshot,file.path)).text;
        const legacy=/(?:ai.context|ai_engineering|engineering.context|requirements|changes|modules|interfaces)/i.test(file.path);
        const category=section??(/^(AGENTS|CLAUDE)\.md$/i.test(name)?'rule':legacy?'decision':'purpose');
        const retained=text.slice(0,60000);add(`document:${file.path}`,category,'document',retained,file.path,1,Math.min(file.line_count,retained.split(/\r?\n/).length),legacy||section?'needs_review':'current');
      }
      if(name==='package.json') {
        try {const packageText=(await readSource(this.store.directory,snapshot,file.path)).text,pkg=JSON.parse(packageText);
          if(pkg.description)add(`purpose:${file.path}`,'purpose','source',String(pkg.description),file.path);
          add(`technology:${file.path}`,'technology','source',`包 ${pkg.name??'未命名'}；运行依赖：${Object.keys(pkg.dependencies??{}).join('、')||'未声明'}`,file.path);
          for(const [key,cmd]of Object.entries(pkg.scripts??{}))add(`build:${file.path}:${key}`,'build','source',`npm run ${key}：${cmd}（发现的命令，尚未执行验证）`,file.path);
          for(const key of ['main','exports','types','bin'])if(pkg[key])add(`interface:${file.path}:${key}`,'interface','source',`${key}: ${JSON.stringify(pkg[key])}`,file.path);
          // JSON permits multiline values; cite the complete small manifest,
          // rather than suggesting every script is within its first 80 lines.
          for(const p of proposals.filter(p=>p.sources[0]?.path===file.path&&p.origin==='source'))p.sources[0].line_end=file.line_count;
        }catch(error){add(`issue:${file.path}`,'issue','source',`无法解析 ${file.path}：${(error as Error).message}`,file.path,1,1,'needs_review');}
      }
      if(/^(?:Makefile|CMakeLists\.txt|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(name))add(`build:${file.path}`,'build','source',`${file.path} 定义构建或依赖；命令尚未执行验证。\n${(await readSource(this.store.directory,snapshot,file.path)).text.slice(0,6000)}`,file.path);
      if(/\.(?:ts|tsx|js|mjs|py|rs|go|h|hpp)$/.test(name)&&/(?:^|\/)(?:shared|types|api|index|main)\./.test(file.path))add(`interface:${file.path}`,'interface','source',`入口或公开类型候选：${file.path}；职责需结合工程分析确认。`,file.path,1,Math.min(file.line_count,20));
    }
    for(const dir of [...new Set(snapshot.files.map(f=>f.path.includes('/')?f.path.split('/')[0]:'').filter(Boolean))]) {
      const members=snapshot.files.filter(f=>f.path.startsWith(`${dir}/`));add(`module:${dir}`,'module','source',`${dir}/：${members.length} 个已索引文本文件。代表文件：${members.slice(0,4).map(f=>f.path).join('、')}；具体职责以有来源的工程全貌为准。`,members[0].path,1,1);
    }
    const rootPackage=snapshot.files.find(f=>f.path==='package.json');
    if(rootPackage){let scripts:Record<string,unknown>|undefined;try{scripts=JSON.parse((await readSource(this.store.directory,snapshot,'package.json')).text).scripts??{};}catch{/* Parse error already has a source-backed issue entry. */}
      if(scripts)for(const proposal of proposals.filter(p=>p.origin==='document'))for(const match of proposal.text.matchAll(/npm\s+run\s+([\w:-]+)/g))if(!(match[1] in scripts)){proposal.status='needs_review';proposal.conflict=`文档声明 npm run ${match[1]}，根 package.json 未定义该脚本；请核查文档与配置。`;proposal.sources.push({path:'package.json',snapshot_id:state.snapshot_id,content_sha256:rootPackage.content_sha256,line_start:1,line_end:rootPackage.line_count});}
    }
    this.store.transaction(()=>{
      let changes=0;
      for(const proposal of proposals) {
        const old=previous.find(e=>e.key===proposal.key&&e.origin!=='user');
        if(old&&old.category===proposal.category&&old.text===proposal.text&&old.status===proposal.status&&old.conflict===proposal.conflict&&old.sources.every(s=>snapshot.files.some(f=>f.path===s.path&&f.content_sha256===s.content_sha256)))continue;
        const item:ContextEntry={...proposal,entry_id:old?.entry_id??id('context'),version:(old?.version??0)+1,updated_at:now()};this.store.putVersion(contextKind,item.entry_id,item.version,item);changes++;
      }
      for(const old of previous)if(old.origin!=='user'&&old.origin!=='agent'&&!old.legacy_import&&!found.has(old.key)&&old.status!=='superseded'){old.status='superseded';old.version++;old.updated_at=now();this.store.putVersion(contextKind,old.entry_id,old.version,old);changes++;}
      const prior=this.store.maybe<{version:number}>('engineering_context_state',projectId);this.store.put('engineering_context_state',projectId,{fingerprint:state.fingerprint,version:(prior?.version??0)+(changes||!prior?1:0)});
    });this.changed();
  }
  reviseContext(input:{entry_id:string;expected_version:number;text:string;submission_key:string}) {
    const key=this.receiptKey('context',input.entry_id,input.submission_key),prior=this.store.maybe<ContextEntry>('engineering_receipt',key);if(prior)return prior;
    const entry=this.store.get<ContextEntry>(contextKind,input.entry_id);if(entry.version!==input.expected_version)throw Error('VERSION_CONFLICT：上下文已更新，请重新读取');
    const revision:ContextEntry={...entry,entry_id:entry.origin==='user'?entry.entry_id:id('context'),key:entry.origin==='user'?entry.key:`user:${entry.entry_id}`,version:entry.origin==='user'?entry.version+1:1,origin:'user',text:requireText(input.text),status:'current',supersedes:entry.origin==='user'?entry.supersedes:entry.entry_id,conflict:'用户修订与原来源并列保留；重新扫描不会覆盖此说明。',updated_at:now()};
    this.store.transaction(()=>{this.store.putVersion(contextKind,revision.entry_id,revision.version,revision);this.store.put('engineering_receipt',key,revision);const state=this.store.get<any>('engineering_context_state',entry.project_id);state.version++;this.store.put('engineering_context_state',entry.project_id,state);});this.changed();return revision;
  }
  async saveEntry(input:SaveEngineeringEntry,origin:'user'|'agent',maySave:()=>boolean=()=>true):Promise<ContextEntry> {
    const workspace=await this.resolve(input),context=await this.context({project_id:workspace.project_id});
    if(!engineeringCategories.includes(input.category)||!['user','agent'].includes(origin))throw Error('工程栏目或来源无效');
    if(!Number.isSafeInteger(input.expected_version)||input.expected_version<0)throw Error('条目版本无效');
    if(input.status!==undefined&&!['current','needs_review'].includes(input.status))throw Error('条目状态无效');
    if(input.task_id&&this.task(input.task_id).project_id!==workspace.project_id)throw Error('条目任务不属于当前工作区');
    const text=requireText(input.text,60000),entryKey=requireText(input.key,300),submission=requireText(input.submission_key,300);
    const receiptKey=this.receiptKey('entry',workspace.project_id,submission),digest=sha(JSON.stringify({...input,origin}));
    return this.store.transaction(()=>{
      if(!maySave())throw Error('执行已停止，拒绝迟到工程条目');
      const receipt=this.store.maybe<{digest:string;entry:ContextEntry}>('engineering_receipt',receiptKey);
      if(receipt){if(receipt.digest!==digest)throw Error('提交标识已用于其他条目内容');return receipt.entry;}
      const binding=this.store.get<WorkspaceBinding>(workspaceKind,workspace.workspace_id);
      if(binding.status!=='bound'||!samePath(binding.root_path,workspace.root_path))throw Error('工作区已改变，请重新读取');
      const old=input.entry_id?this.store.get<ContextEntry>(contextKind,input.entry_id):undefined;
      if(old&&(old.project_id!==workspace.project_id||old.task_id!==input.task_id))throw Error('条目不属于当前工作区');
      if(old&&old.category!==input.category)throw Error('编辑不能改变资料类别，请在目标类别新增');
      if(old&&this.store.all<ContextEntry>(contextKind).some(e=>e.project_id===workspace.project_id&&e.supersedes===old.entry_id&&e.status!=='superseded'))throw Error('VERSION_CONFLICT：已有当前有效修订，请读取后编辑');
      if((old?.version??0)!==input.expected_version)throw Error('VERSION_CONFLICT：条目已更新，请重新读取');
      const sources=input.sources??old?.sources??[];
      if(!Array.isArray(sources)||sources.length>40)throw Error('来源列表无效');
      let sourcesCurrent=true;
      for(const source of sources){const snapshot=this.store.get<Snapshot>('snapshot',source.snapshot_id),file=snapshot.files.find(f=>f.path===source.path);if(snapshot.project_id!==workspace.project_id||!file||file.content_sha256!==source.content_sha256||!Number.isSafeInteger(source.line_start)||!Number.isSafeInteger(source.line_end)||source.line_start<1||source.line_end<source.line_start||source.line_end>file.line_count)throw Error('来源快照、文件或行号不匹配');if(snapshot.fingerprint!==context.code_state.fingerprint)sourcesCurrent=false;}
      const fork=!!old&&(['source','document'].includes(old.origin)||old.key.startsWith('initial:'));
      const key=entryKey.startsWith('entry:')?entryKey:`entry:${entryKey}`;
      if(this.store.all<ContextEntry>(contextKind).some(e=>e.project_id===workspace.project_id&&e.category===input.category&&e.task_id===input.task_id&&e.key===key&&e.status!=='superseded'&&e.entry_id!==old?.entry_id))throw Error('VERSION_CONFLICT：同名条目已存在，请读取后编辑');
      const entry:ContextEntry={entry_id:old&&!fork?old.entry_id:id('context'),project_id:workspace.project_id,...(input.task_id?{task_id:input.task_id}:{}),version:old&&!fork?old.version+1:1,key,category:input.category,origin,text,status:origin==='user'&&sources.length&&sourcesCurrent?(input.status??'needs_review'):'needs_review',sources,code_fingerprint:context.code_state.fingerprint,updated_at:now(),...(fork?{supersedes:old!.entry_id}:old?.supersedes?{supersedes:old.supersedes}:{}),...(fork?{conflict:'修订与原文并列保留；原文来源及历史未覆盖。'}:{})};
      if(old?.covered_entries)entry.covered_entries=old.covered_entries;
      if(old?.analysis_result_id)entry.analysis_result_id=old.analysis_result_id;
      if(fork)entry.source_version=old!.version;else if(old?.source_version)entry.source_version=old.source_version;
      this.store.putVersion(contextKind,entry.entry_id,entry.version,entry);
      this.store.put('engineering_receipt',receiptKey,{project_id:workspace.project_id,digest,entry});
      const state=this.store.get<{version:number}>('engineering_context_state',workspace.project_id);state.version++;this.store.put('engineering_context_state',workspace.project_id,state);
      this.changed();return entry;
    });
  }
  async importAec(projectId:string,providedScan?:AecScan) {
    const workspace=await this.resolve({project_id:projectId}),scan=providedScan??await scanAecLegacy(workspace.root_path);
    const state=await this.captureState(projectId),snapshot=this.store.get<Snapshot>('snapshot',state.snapshot_id);
    const documents:(AecLegacyDocument&{source:ContextSource})[]=[];
    for(const doc of scan.documents){relativePath(doc.path);if(doc.importKey!==`aec:${doc.path}`||doc.revisionKey!==`aec:${doc.path}:${doc.sha256}`)throw Error('AEC 导入身份与来源路径不匹配');const file=snapshot.files.find(f=>f.path===doc.path);if(!file)throw Error(`AEC 来源未进入授权快照，已阻止迁移：${doc.path}`);if(file.content_sha256!==doc.sha256)throw Error(`AEC 来源在扫描后变化，已阻止迁移：${doc.path}`);const frozen=await readSource(this.store.directory,snapshot,doc.path);documents.push({...doc,content:frozen.text,source:{path:doc.path,snapshot_id:state.snapshot_id,content_sha256:file.content_sha256,line_start:1,line_end:Math.max(1,file.line_count)}});}
    const groups=new Map<string,typeof documents>();
    for(const doc of documents){if(!['task','evidence'].includes(doc.kind))continue;const match=doc.path.match(/^(docs\/requirements\/[^/]+)(?:\/|$)/);const group=match?.[1]??doc.path;if(doc.kind==='evidence'&&!match)continue;const list=groups.get(group)??[];list.push(doc);groups.set(group,list);}
    let imported=0,reused=0;const taskIds:string[]=[];
    this.store.transaction(()=>{
      const existing=this.store.all<ContextEntry>(contextKind).filter(e=>e.project_id===projectId),existingTasks=this.tasks({project_id:projectId});
      for(const doc of documents){const old=existing.find(e=>e.legacy_import?.import_key===doc.importKey&&e.origin!=='user');if(old?.legacy_import?.revision_key===doc.revisionKey&&(!engineeringDocumentCategory(doc.path)||old.category===engineeringDocumentCategory(doc.path))){reused++;continue;}
        const entry:ContextEntry={entry_id:old?.entry_id??id('context'),project_id:projectId,key:doc.importKey,version:(old?.version??0)+1,category:doc.kind==='rule'?'rule':engineeringDocumentCategory(doc.path)??(doc.kind==='evidence'?'issue':doc.kind==='task'?'decision':/\/interfaces\//.test(doc.path)?'interface':/\/modules\//.test(doc.path)?'module':'purpose'),origin:'document',text:doc.content.slice(0,60000),status:'needs_review',sources:[doc.source],code_fingerprint:state.fingerprint,updated_at:now(),conflict:'AEC 历史导入，仅供溯源；未确认与当前源码一致，不作为当前有效规则或真实执行证明。',legacy_import:{import_key:doc.importKey,revision_key:doc.revisionKey,source_kind:doc.kind,sources:[doc.source],imported_at:now()}};
        this.store.putVersion(contextKind,entry.entry_id,entry.version,entry);imported++;
        // Replace the automatically discovered view, while retaining its prior
        // versions and user corrections. There is one imported authority view.
        if(doc.kind!=='rule')for(const previous of existing.filter(e=>e.key===`document:${doc.path}`&&e.origin!=='user'&&e.status!=='superseded')){previous.status='superseded';previous.version++;previous.updated_at=now();this.store.putVersion(contextKind,previous.entry_id,previous.version,previous);}
      }
      for(const [group,docs]of groups){const importKey=`aec-task:${group}`,revisionKey=`${importKey}:${sha(docs.map(d=>d.revisionKey).sort().join('\n'))}`,old=existingTasks.find(t=>t.legacy_import?.import_key===importKey);if(old?.legacy_import?.revision_key===revisionKey){taskIds.push(old.task_id);continue;}
        const legacy={import_key:importKey,revision_key:revisionKey,source_kind:'task' as const,sources:docs.map(d=>d.source),imported_at:now()};
        const task:EngineeringTask=old??{task_id:id('task'),project_id:projectId,workspace_id:workspace.workspace_id,workspace_path:workspace.root_path,version:0,submission_key:importKey,goal:`历史导入 · ${group}`,scope:docs.map(d=>d.path),status:'pending',baseline:state,context_version:this.store.get<any>('engineering_context_state',projectId).version,summary:'',decisions:[],unresolved:[],changes:[],verification:[],verification_status:'not_run',attempt_ids:[],created_at:now(),updated_at:now(),saved:'saved',origin:'legacy_import'};
        task.legacy_import=legacy;if(!task.attempt_ids.length&&!task.requests?.length){task.summary=`AEC 历史资料：${docs.map(d=>d.path).join('、')}。原文与历史版本可查看；尚未确认这些文档描述的修改或验证实际发生。`;task.unresolved=['历史来源待复核；文档中的通过声明不计作 ARC 已观察的验证。'];task.scope=docs.map(d=>d.path);}this.saveTask(task);taskIds.push(task.task_id);
      }
      if(imported){const current=this.store.get<any>('engineering_context_state',projectId);current.version++;this.store.put('engineering_context_state',projectId,current);}
    });if(imported)this.changed();return {project_id:projectId,imported,reused,task_ids:taskIds,source_snapshot_id:state.snapshot_id,warnings:scan.warnings};
  }
  tasks(input:{project_id?:string;query?:string;file?:string;status?:string}={}) {return this.store.all<EngineeringTask>(taskKind).filter(t=>(!input.project_id||t.project_id===input.project_id)&&(!input.status||t.status===input.status)&&(!input.file||t.changes.some(c=>c.path===input.file)||t.scope.includes(input.file))&&(!input.query||JSON.stringify([t.goal,t.summary,t.decisions,t.unresolved]).toLowerCase().includes(input.query.toLowerCase()))).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));}
  task(taskId:string){const task=this.store.get<EngineeringTask>(taskKind,taskId);const base=task.diff_baseline??task.baseline,baseline=this.store.get<Snapshot>('snapshot',base.snapshot_id),baselineFiles=stateFiles(baseline,base),files=new Map(base.dirty.map(file=>[file,baselineFiles.get(file)??null]));for(const file of task.rebind_preexisting_files??[])files.set(file.path,file.sha256);task.preexisting_files=[...files].map(([path,sha256])=>({path,sha256}));return task;}
  private currentVerification(task:EngineeringTask,state?:CodeState|null):EngineeringTask {
    const status=state===null?'stale':state?this.verificationStatus(task,state):task.verification_status==='passed'&&task.verification.some(e=>!e.code_state.workspace_fingerprint)?'partial':task.verification_status;
    const steps=task.steps?.map(step=>({...step,verification_status:this.currentStepStatus(task,step,state)}));
    return {...task,verification_status:status,...(steps?{steps}:{})};
  }
  private async verificationState(task:EngineeringTask) {
    const workspace=this.store.get<WorkspaceBinding>(workspaceKind,task.workspace_id);
    if(workspace.status!=='bound')return undefined;
    return this.captureState(task.project_id,task.workspace_path).catch(()=>null);
  }
  async currentTask(taskId:string) {
    const task=this.task(taskId),state=await this.verificationState(task);
    return this.currentVerification(task,state);
  }
  async currentTasks(input:Parameters<EngineeringService['tasks']>[0]) {
    const states=new Map<string,ReturnType<EngineeringService['verificationState']>>();
    return Promise.all(this.tasks(input).map(async task=>{
      if(!states.has(task.workspace_id))states.set(task.workspace_id,this.verificationState(task));
      const state=await states.get(task.workspace_id);
      return this.currentVerification(task,state);
    }));
  }
  history(kind:'task'|'context',objectId:string){return this.store.versions(kind==='task'?taskKind:contextKind,objectId);}
  private receiptKey(operation:string,objectId:string,key:string){return sha(`${operation}\0${objectId}\0${requireText(key,300)}`);}
  private saveTask(task:EngineeringTask){task.version++;task.updated_at=now();task.saved='saved';this.store.putVersion(taskKind,task.task_id,task.version,task);}
  private idList(value:unknown):string[] {
    if(!Array.isArray(value)||value.length>100)throw Error('步骤证据列表无效');
    const values=value.map(item=>requireText(item,300));if(new Set(values).size!==values.length)throw Error('步骤证据引用重复');return values;
  }
  private mergeSteps(task:EngineeringTask,input:DevelopmentStep[]) {
    if(!Array.isArray(input)||input.length>40)throw Error('开发步骤数量无效');
    const steps=[...(task.steps??[])],seen=new Set<string>();
    for(const provided of input){
      const {verification_status:_computed,...value}=provided,stepId=requireText(value.step_id,160);if(seen.has(stepId))throw Error('同次更新的步骤 ID 重复');seen.add(stepId);
      if(!['pending','in_progress','completed','blocked','failed','superseded'].includes(value.status))throw Error('步骤状态无效');
      if(!Array.isArray(value.criteria)||value.criteria.length<1||value.criteria.length>20)throw Error('每个步骤需要 1–20 条验收条件');
      const criteria=value.criteria.map(criterion=>({criterion_id:requireText(criterion.criterion_id,160),text:requireText(criterion.text,4000),evidence_ids:this.idList(criterion.evidence_ids)}));
      if(new Set(criteria.map(c=>c.criterion_id)).size!==criteria.length)throw Error('步骤内验收条件 ID 重复');
      if(typeof value.title!=='string'||!value.title.trim())throw Error('步骤 '+stepId+' 缺少 title（步骤标题）');
      const previous=steps.find(step=>step.step_id===stepId),step:DevelopmentStep={step_id:stepId,title:requireText(value.title,300),change:requireText(value.change,6000),status:value.status,progress:requireText(value.progress,6000),criteria,evidence_ids:this.idList(value.evidence_ids),unresolved:(value.unresolved??[]).map(item=>requireText(item,4000)),created_at:previous?.created_at??now(),updated_at:now()};
      if(previous)steps[steps.indexOf(previous)]=step;else steps.push(step);
    }
    task.steps=steps;
  }
  private checkStepEvidence(task:EngineeringTask) {
    const known=new Set(task.verification.map(item=>item.evidence_id));
    for(const step of task.steps??[]){
      const links=[...step.evidence_ids,...step.criteria.flatMap(criterion=>criterion.evidence_ids)];
      for(const evidenceId of links){const evidence=task.verification.find(item=>item.evidence_id===evidenceId);if(!evidence)throw Error('步骤引用了不存在的验证证据');if(evidence.step_id&&evidence.step_id!==step.step_id)throw Error('验证证据与步骤归属不一致');}
      for(const criterion of step.criteria)for(const evidenceId of criterion.evidence_ids){const evidence=task.verification.find(item=>item.evidence_id===evidenceId)!;if(evidence.criterion_id&&evidence.criterion_id!==criterion.criterion_id)throw Error('验证证据与验收条件归属不一致');}
    }
  }
  private currentStepStatus(task:EngineeringTask,step:DevelopmentStep,state?:CodeState|null):DevelopmentStep['verification_status'] {
    const ids=new Set([...step.evidence_ids,...step.criteria.flatMap(criterion=>criterion.evidence_ids)]),linked=task.verification.filter(item=>item.step_id===step.step_id||ids.has(item.evidence_id));
    if(!linked.length)return 'not_run';if(state===null)return 'stale';if(!state)return 'partial';const current=linked.filter(item=>sameVerificationState(item.code_state,state));if(!current.length)return 'stale';
    const latest=new Map<string,VerificationEvidence>();for(const item of current)latest.set(item.command,item);const checks=[...latest.values()];
    if(checks.some(item=>item.outcome==='failed'))return 'failed';return checks.every(item=>item.outcome==='passed'&&item.origin==='observed'&&!!item.log_path&&item.code_state_verified!==false)?'passed':'partial';
  }
  private validateReading(projectId:string,input?:TaskReadingBinding):TaskReadingBinding|undefined {
    if(!input)return undefined;
    const feature=this.store.get<Feature>('feature',input.feature_id),scenario=this.store.get<Scenario>('scenario',input.scenario_id),explanation=this.store.get<Explanation>('explanation',input.result_id),snapshot=this.store.get<Snapshot>('snapshot',input.source_snapshot_id);
    if(feature.project_id!==projectId||scenario.project_id!==projectId||scenario.feature_id!==feature.feature_id||explanation.scenario_id!==scenario.scenario_id)throw Error('功能、场景与任务归属不一致');
    if(explanation.result.binding.feature_id!==feature.feature_id||explanation.result.binding.scenario_id!==scenario.scenario_id||explanation.result.binding.source_snapshot_id!==snapshot.source_snapshot_id||snapshot.project_id!==projectId)throw Error('走读结果与冻结来源归属不一致');
    readingTarget(explanation.result,input.target,snapshot,feature);
    return {feature_id:feature.feature_id,scenario_id:scenario.scenario_id,result_id:explanation.result_id,source_snapshot_id:snapshot.source_snapshot_id,target:{kind:input.target.kind,id:input.target.id}};
  }
  async createTask(input:CreateEngineeringTask):Promise<EngineeringTask> {
    const workspace=await this.resolve(input),reading=this.validateReading(workspace.project_id,input.reading);
    if(input.task_id){
      const prior=this.task(input.task_id);if(prior.workspace_id!==workspace.workspace_id)throw Error('任务属于另一个工作区');
      if(reading&&prior.reading&&(reading.feature_id!==prior.reading.feature_id||reading.scenario_id!==prior.reading.scenario_id))throw Error('已有任务不能改绑到另一个功能或场景');
      await this.captureState(workspace.project_id,workspace.root_path);const task=this.task(input.task_id),key=this.receiptKey('continue',task.task_id,input.submission_key);if(this.store.maybe('engineering_receipt',key))return task;
      const text=requireText(input.goal);this.store.transaction(()=>{task.requests??=[];task.requests.push({text,submission_key:input.submission_key,created_at:now()});if(!task.reading&&reading)task.reading=reading;this.saveTask(task);this.store.put('engineering_receipt',key,task);});this.changed();return task;
    }
    const key=this.receiptKey('create',workspace.workspace_id,input.submission_key),existing=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(existing)return this.task(existing.task_id);
    const context=await this.context({project_id:workspace.project_id});
    return this.store.transaction(()=>{const retry=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(retry)return this.task(retry.task_id);
      const task:EngineeringTask={task_id:id('task'),project_id:workspace.project_id,workspace_id:workspace.workspace_id,workspace_path:workspace.root_path,...(reading?{reading}:{}),version:0,submission_key:input.submission_key,goal:requireText(input.goal),scope:(input.scope??[]).map(relativePath),status:'pending',baseline:context.code_state,context_version:context.version,summary:'',decisions:[],unresolved:[],changes:[],verification:[],verification_status:'not_run',attempt_ids:[],requests:[],created_at:now(),updated_at:now(),saved:'saved'};
      this.saveTask(task);this.store.put('engineering_receipt',key,task);this.changed();return task;});
  }
  saveWalkthrough(taskId:string,update:WalkthroughUpdate,expectedUpdateId?:string):EngineeringTask {
    return this.store.transaction(()=>{const task=this.task(taskId);if(!task.reading)throw Error('任务没有关联的功能走读');if(expectedUpdateId!==undefined&&task.walkthrough?.update_id!==expectedUpdateId)return task;task.walkthrough=update;this.saveTask(task);this.changed();return task;});
  }
  updateTask(input:UpdateEngineeringTask):EngineeringTask {
    const key=this.receiptKey('update',input.task_id,input.submission_key),prior=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(prior)return prior;
    return this.store.transaction(()=>{const task=this.task(input.task_id);this.checkUpdate(task,input);
      if(input.summary!==undefined)task.summary=requireText(input.summary);
      if(input.decisions)task.decisions=input.decisions.map(s=>requireText(s));if(input.unresolved)task.unresolved=input.unresolved.map(s=>requireText(s));
      if(input.steps)this.mergeSteps(task,input.steps);
      if(input.verification)for(const evidence of input.verification){this.checkEvidence(task,evidence);if(!task.verification.some(e=>e.evidence_id===evidence.evidence_id))task.verification.push(evidence);}
      this.checkStepEvidence(task);
      if(input.status)task.status=input.status;task.verification_status=this.verificationStatus(task,task.end_state??task.baseline);
      this.saveTask(task);this.store.put('engineering_receipt',key,task);this.changed();return task;});
  }
  private checkUpdate(task:EngineeringTask,input:UpdateEngineeringTask) {
    if(task.version!==input.expected_version)throw Error('VERSION_CONFLICT：任务已有新版本，请重新读取');
    if(input.attempt_id){const attempt=this.store.get<DevelopmentAttempt>(attemptKind,input.attempt_id);if(attempt.task_id!==task.task_id||task.attempt_ids.at(-1)!==attempt.attempt_id||['cancelled','interrupted'].includes(attempt.status))throw Error('此执行已取消、被替代或不属于此任务，拒绝迟到结果');}
    if(task.status==='cancelled'&&input.status&&input.status!=='cancelled')throw Error('已取消任务不能由迟到结果恢复，请显式重试执行');
  }
  private checkEvidence(task:EngineeringTask,e:VerificationEvidence) {
    requireText(e.evidence_id,300);requireText(e.command);if(!samePath(e.cwd,task.workspace_path))throw Error('验证工作目录与任务不一致');
    const source=this.store.get<Snapshot>('snapshot',e.code_state.snapshot_id);if(source.project_id!==task.project_id||source.fingerprint!==e.code_state.fingerprint)throw Error('验证代码状态不属于此工程');
    if(!['observed','self_reported'].includes(e.origin)||!['passed','failed','blocked','not_run'].includes(e.outcome))throw Error('验证状态无效');
    if(e.outcome==='passed'&&e.exit_code!==0)throw Error('通过的命令必须有零退出码');if(e.log_path)this.checkLogPath(task,e.log_path);
    if(e.step_id){const step=task.steps?.find(item=>item.step_id===e.step_id);if(!step)throw Error('验证证据引用了不存在的步骤');if(e.criterion_id&&!step.criteria.some(item=>item.criterion_id===e.criterion_id))throw Error('验证证据引用了不存在的验收条件');}
    else if(e.criterion_id)throw Error('验收条件关联必须同时指定步骤');
  }
  private checkLogPath(task:EngineeringTask,filePath:string){relativePath(filePath);if(!filePath.startsWith(`development/${task.task_id}/`)&&!filePath.startsWith(`logs/${task.task_id}/`))throw Error('日志路径不属于此任务的证据目录');}
  private verificationStatus(task:EngineeringTask,state:CodeState):EngineeringTask['verification_status'] {
    if(!task.verification.length)return 'not_run';
    if(task.changes_status==='needs_review')return 'stale';
    const current=task.verification.filter(e=>sameVerificationState(e.code_state,state));
    if(!current.length&&task.verification.some(e=>!e.code_state.workspace_fingerprint&&e.code_state.fingerprint===state.fingerprint&&e.code_state.head===state.head))return 'partial';
    if(!current.length)return 'stale';const latest=new Map<string,VerificationEvidence>();for(const e of current)latest.set(e.command,e);const checks=[...latest.values()];
    if(checks.some(e=>e.outcome==='failed'))return 'failed';if(checks.every(e=>e.outcome==='passed'&&e.origin==='observed'&&!!e.log_path&&e.code_state_verified!==false))return 'passed';return 'partial';
  }
  async finishTask(input:FinishEngineeringTask):Promise<EngineeringTask> {
    const key=this.receiptKey('finish',input.task_id,input.submission_key),prior=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(prior)return prior;
    const task=this.task(input.task_id);this.checkUpdate(task,input);const workspace=await this.resolve({project_id:task.project_id});if(workspace.workspace_id!==task.workspace_id||!samePath(workspace.root_path,task.workspace_path))throw Error('任务绑定工作区已改变，拒绝写回');
    const binding=input.completion_binding;
    const end=await this.captureState(task.project_id,task.workspace_path).catch(error=>{if(binding===undefined)throw error;return null;});
    const attempt=task.attempt_ids.at(-1)?this.store.get<DevelopmentAttempt>(attemptKind,task.attempt_ids.at(-1)!):undefined;
    const workspaceConflict=end&&(end.branch!==(attempt?.baseline??task.baseline).branch||end.git_common_dir!==workspace.git_common_dir);
    if(binding===undefined&&workspaceConflict)throw Error('WORKSPACE_CONFLICT：任务期间分支或仓库归属变化，请核查后接续');
    const ownershipUnknown=!end||(task.changes_status==='needs_review'&&!task.diff_baseline)||binding!==undefined&&(workspaceConflict||!binding||typeof binding.workspace_path!=='string'||!samePath(binding.workspace_path,task.workspace_path)||binding.workspace_fingerprint!==end.workspace_fingerprint||binding.head!==end.head||binding.branch!==end.branch||binding.git_common_dir!==end.git_common_dir);
    const before=this.store.get<Snapshot>('snapshot',task.baseline.snapshot_id),after=end?this.store.get<Snapshot>('snapshot',end.snapshot_id):before;
    const comparison=task.diff_baseline??task.baseline;
    const comparisonSnapshot=comparison===task.baseline?before:this.store.get<Snapshot>('snapshot',comparison.snapshot_id);
    const assetBaseline=comparison.assets??attempt?.baseline?.assets??[];
    const beforeFiles=stateFiles(comparisonSnapshot,{assets:assetBaseline}),afterFiles=stateFiles(after,end??undefined);
    const attemptFiles=attempt?.baseline&&stateFiles(this.store.get<Snapshot>('snapshot',attempt.baseline.snapshot_id),attempt.baseline);
    const previousChanges=new Set(task.changes.map(change=>change.path));
    const assets=new Set([...assetBaseline,...(end?.assets??[])].map(asset=>asset.path));
    const changes=ownershipUnknown?[]:[...new Set([...beforeFiles.keys(),...afterFiles.keys()])]
      .filter(p=>beforeFiles.get(p)!==afterFiles.get(p))
      // Keep known task changes across attempts, but exclude files only changed between attempts.
      .filter(p=>!attemptFiles||previousChanges.has(p)||attemptFiles.get(p)!==afterFiles.get(p))
      .map(p=>({path:p,before_sha256:beforeFiles.get(p)??null,after_sha256:afterFiles.get(p)??null,ownership:comparison.dirty.includes(p)||task.rebind_preexisting_files?.some(f=>f.path===p)?'preexisting_overlap' as const:'task_change' as const,...(assets.has(p)?{text_diff_unavailable:true}:{})}));
    const saved=this.store.transaction(()=>{const retry=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(retry)return retry;const current=this.task(task.task_id);this.checkUpdate(current,input);if(ownershipUnknown){delete current.diff_baseline;current.changes_status='needs_review';}else if(end){current.end_state=end;current.changes=changes;delete current.changes_status;}current.status=input.status;if(input.summary!==undefined)current.summary=requireText(input.summary);if(input.decisions)current.decisions=input.decisions.map(s=>requireText(s));if(input.unresolved)current.unresolved=input.unresolved.map(s=>requireText(s));
      if(ownershipUnknown)current.unresolved=[...new Set([...current.unresolved,'无法确认提交完成时与采集时的代码状态一致。报告已保存，差异归属待核查。'])];
      if(input.steps)this.mergeSteps(current,input.steps);
      for(const evidence of input.verification??[]){this.checkEvidence(current,evidence);if(!current.verification.some(e=>e.evidence_id===evidence.evidence_id))current.verification.push(evidence);}
      this.checkStepEvidence(current);
      if(current.reading&&(input.status==='completed'||current.changes.length>0)){
        const previous=current.walkthrough,result=previous?.result_id?this.store.maybe<Explanation>('explanation',previous.result_id):null,unchanged=attemptFiles?[...new Set([...attemptFiles.keys(),...afterFiles.keys()])].every(file=>attemptFiles.get(file)===afterFiles.get(file)):current.changes.length===0;
        const reusable=unchanged&&current.end_state&&result&&this.store.get<Snapshot>('snapshot',result.result.binding.source_snapshot_id).fingerprint===current.end_state.fingerprint;
        if(reusable)current.walkthrough={...previous!,status:'completed',result_id:result.result_id,source_snapshot_id:result.result.binding.source_snapshot_id,error:undefined,updated_at:now()};
        else current.walkthrough={status:current.end_state?'pending':'failed',previous_result_id:previous?.result_id??current.reading.result_id,source_snapshot_id:current.end_state?.snapshot_id,...(current.end_state?{}:{error:'没有可确认的开发结束代码状态；旧走读保留。'}),updated_at:now()};
      }
      if(current.reading&&input.status!=='completed'&&!current.changes.length&&current.walkthrough?.status==='pending')current.walkthrough={...current.walkthrough,status:'failed',error:'开发未完成且没有源码改动，未触发走读更新；原说明保留。',updated_at:now()};
      current.verification_status=this.verificationStatus(current,end??current.baseline);this.saveTask(current);this.markAffected(current.project_id,changes.map(c=>c.path));this.store.put('engineering_receipt',key,current);this.changed();return current;});
    if(saved.walkthrough?.status==='pending'&&saved.end_state)this.onTaskFinished(saved);return saved;
  }
  private markAffected(projectId:string,files:string[]) {
    if(!files.length)return;let changed=false;
    for(const entry of this.store.all<ContextEntry>(contextKind))if(entry.project_id===projectId&&entry.status==='current'&&entry.sources.some(s=>files.includes(s.path))){entry.status='needs_review';entry.version++;entry.updated_at=now();this.store.putVersion(contextKind,entry.entry_id,entry.version,entry);changed=true;}
    if(changed){const state=this.store.get<any>('engineering_context_state',projectId);state.version++;this.store.put('engineering_context_state',projectId,state);}
  }
  checkWorkspaceAvailable(workspace:WorkspaceBinding) {
    if(this.store.all<DevelopmentAttempt>(attemptKind).some(attempt=>samePath(attempt.workspace_path,workspace.root_path)&&['starting','running'].includes(attempt.status))||
      this.tasks().some(task=>task.status==='running'&&samePath(task.workspace_path,workspace.root_path)))throw Error('此工作区已有开发任务，请等待结束或停止后再继续。');
  }
  startAttempt(taskId:string,input:Pick<DevelopmentAttempt,'provider_id'|'model'|'origin'|'write_scope'>) {
    return this.store.transaction(()=>{const task=this.task(taskId);
      const workspace=this.store.get<WorkspaceBinding>(workspaceKind,task.workspace_id);if(workspace.status!=='bound'||!samePath(workspace.root_path,task.workspace_path))throw Error('任务工作区未绑定或已改变');
      this.checkWorkspaceAvailable(workspace);
      const attempt:DevelopmentAttempt={...input,attempt_id:id('attempt'),task_id:taskId,project_id:task.project_id,workspace_id:task.workspace_id,workspace_path:task.workspace_path,status:'starting',started_at:now(),baseline:this.store.maybe<CodeState>('engineering_state',task.workspace_id)??task.baseline,context_version:this.store.get<any>('engineering_context_state',task.project_id).version};if(task.changes_status==='needs_review')task.diff_baseline=attempt.baseline;if(task.reading)task.walkthrough={status:'pending',previous_result_id:task.walkthrough?.result_id??task.reading.result_id,result_id:task.walkthrough?.result_id,source_snapshot_id:task.walkthrough?.source_snapshot_id,updated_at:now()};task.attempt_ids.push(attempt.attempt_id);task.status='running';this.saveTask(task);this.store.put(attemptKind,attempt.attempt_id,attempt);this.changed();return attempt;});
  }
  updateAttempt(attemptId:string,patch:Partial<DevelopmentAttempt>) {
    const attempt=this.store.get<DevelopmentAttempt>(attemptKind,attemptId);for(const key of ['attempt_id','task_id','project_id','workspace_id','workspace_path'] as const)if(patch[key]!==undefined&&patch[key]!==attempt[key])throw Error('执行归属不可修改');
    if(['completed','failed','cancelled','interrupted'].includes(attempt.status)&&patch.status&&patch.status!==attempt.status)throw Error('执行已结束，拒绝迟到状态');
    if(patch.log_path)this.checkLogPath(this.task(attempt.task_id),patch.log_path);Object.assign(attempt,patch);if(['completed','failed','cancelled','interrupted'].includes(attempt.status))attempt.ended_at??=now();this.store.put(attemptKind,attemptId,attempt);this.changed();return attempt;
  }
  appendAttemptEvent(attemptId:string,event:unknown){this.store.get(attemptKind,attemptId);const sequence=this.store.nextSequence(attemptId);this.store.event(attemptId,id('event'),sequence,{sequence,at:now(),event});this.changed();}
  attemptEvents(attemptId:string){this.store.get(attemptKind,attemptId);return this.store.events(attemptId);}
  async rebindWorkspace(projectId:string,rootPath:string) {
    const root=await fs.realpath(rootPath);if(!(await fs.stat(root)).isDirectory())throw Error('请选择工程目录');
    const other=this.store.all<WorkspaceBinding>(workspaceKind).find(w=>w.status==='bound'&&w.project_id!==projectId&&samePath(w.root_path,root));if(other)throw Error('该工作区已绑定另一个工程');
    const workspace=this.store.all<WorkspaceBinding>(workspaceKind).find(w=>w.project_id===projectId);if(!workspace)throw Error('找不到待绑定工程');
    if(this.tasks({project_id:projectId}).some(t=>t.status==='running'))throw Error('运行中的工程不能重新绑定');
    await this.capturing.get(projectId);await this.scanning.get(projectId);
    const project=this.store.get<Project>('project',projectId),snapshot=await capture(root,projectId,this.store.directory,project.build_config);
    const identity=await workspaceFiles(root,snapshot);
    const common=await workspaceGitDirectory(root);
    this.store.transaction(()=>{workspace.root_path=root;workspace.status='bound';workspace.git_common_dir=common;workspace.rebound_at=now();this.store.put(workspaceKind,workspace.workspace_id,workspace);project.root_path=root;project.snapshot_id=snapshot.source_snapshot_id;this.store.put('snapshot',snapshot.source_snapshot_id,snapshot);this.store.put('project',projectId,project);this.store.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run('engineering_state',workspace.workspace_id);
      for(const task of this.tasks({project_id:projectId})){const beforeState=task.end_state??task.baseline,before=this.store.get<Snapshot>('snapshot',beforeState.snapshot_id),beforeFiles=stateFiles(before,beforeState),afterFiles=stateFiles(snapshot,{assets:identity.assets}),preexisting=new Map((task.rebind_preexisting_files??[]).map(f=>[f.path,f.sha256]));for(const file of new Set([...beforeFiles.keys(),...afterFiles.keys()]))if(beforeFiles.get(file)!==afterFiles.get(file))preexisting.set(file,afterFiles.get(file)??null);task.rebind_preexisting_files=[...preexisting].map(([path,sha256])=>({path,sha256}));task.rebind_source_snapshot_id=snapshot.source_snapshot_id;task.workspace_path=root;this.saveTask(task);}
      for(const explanation of this.store.all<Explanation>('explanation'))if(explanation.result.binding.project_id===projectId){explanation.source_status=this.store.get<Snapshot>('snapshot',explanation.result.binding.source_snapshot_id).fingerprint===snapshot.fingerprint?'current':'needs_review';this.store.put('explanation',explanation.result_id,explanation);}
    });await this.context({project_id:projectId,refresh:true});this.changed();return workspace;
  }
  async exportProject(projectId:string,filePath:string){await this.connect(projectId);return exportEngineeringProject(this.store,projectId,filePath);}
  async readLog(taskId:string,filePath:string){const task=this.task(taskId);this.checkLogPath(task,filePath);const allowed=task.verification.some(e=>e.log_path===filePath)||task.attempt_ids.some(a=>this.store.get<DevelopmentAttempt>(attemptKind,a).log_path===filePath);if(!allowed)throw Error('日志不属于此任务');const file=await safeFile(this.store.directory,filePath),stat=await fs.stat(file);if(stat.size>2*1024*1024)throw Error('日志超过 2 MiB 展示限制，请在数据目录查看');return {path:filePath,text:await fs.readFile(file,'utf8')};}
  async taskDiff(taskId:string,filePath:string){const task=this.task(taskId);relativePath(filePath);const change=task.changes.find(c=>c.path===filePath);if(!change||!task.end_state||task.changes_status==='needs_review')throw Error('文件不属于此任务已保存的差异');if(change.text_diff_unavailable)throw Error('已记录文件内容哈希，此文件没有文本差异');const beforeSnapshot=this.store.get<Snapshot>('snapshot',(task.diff_baseline??task.baseline).snapshot_id),afterSnapshot=this.store.get<Snapshot>('snapshot',task.end_state.snapshot_id);const before=change.before_sha256?(await readSource(this.store.directory,beforeSnapshot,filePath)).text:'',after=change.after_sha256?(await readSource(this.store.directory,afterSnapshot,filePath)).text:'';return {path:filePath,before:before.slice(0,200000),after:after.slice(0,200000),before_snapshot_id:beforeSnapshot.source_snapshot_id,after_snapshot_id:task.end_state.snapshot_id,truncated:before.length>200000||after.length>200000};}
  async restoreProject(filePath:string){const result=await restoreEngineeringProject(this.store,filePath);this.changed();return result;}
}
