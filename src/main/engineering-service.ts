import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Project,Snapshot,Explanation} from '../shared';
import {engineeringSectionCategories,type SaveEngineeringEntry,type EngineeringSectionCategory} from '../engineering';
import type {CodeState,WorkspaceBinding,ContextEntry,ContextSource,EngineeringContext,EngineeringAnalysis,ContextRequest,EngineeringTask,CreateEngineeringTask,UpdateEngineeringTask,FinishEngineeringTask,DevelopmentAttempt,VerificationEvidence} from '../engineering';
import {Store,id,now} from './store';
import {capture,freshness,readSource,sha,relativePath,safeFile} from './snapshot';
import {exportEngineeringProject,restoreEngineeringProject} from './engineering-transfer';
import {scanAecLegacy,type AecScan,type AecLegacyDocument} from './aec-migration';

const exec=promisify(execFile), workspaceKind='engineering_workspace', contextKind='engineering_context', taskKind='engineering_task', attemptKind='development_attempt';
const requireText=(v:unknown,max=20000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error(`请输入 1–${max} 个字符`);return v.trim();};
const samePath=(a:string,b:string)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
async function git(root:string,args:string[]) {return (await exec('git',['-C',root,...args],{windowsHide:true,timeout:10000,maxBuffer:16*1024*1024})).stdout.trim();}
// Explicit document names only; README/purpose is not a completed plan.
export function engineeringDocumentCategory(file:string):EngineeringSectionCategory|undefined {
  const name=path.posix.basename(file).replace(/\.(?:md|txt|json)$/i,'').toLowerCase().replace(/[_ ]/g,'-');
  if(/^(?:verification-plan|test-plan|acceptance-plan|验证计划|测试计划|验收计划)$/.test(name))return 'verification_plan';
  if(/^(?:architecture|system-architecture|架构|系统架构)$/.test(name))return 'architecture';
  if(/^(?:design|detailed-design|technical-design|设计|详细设计|技术设计)$/.test(name))return 'design';
  if(/^(?:plan|implementation-plan|development-plan|proposal|方案|实施方案|开发计划)$/.test(name))return 'plan';
  return undefined;
}
export class EngineeringService {
  private readonly capturing=new Map<string,Promise<CodeState>>();
  private readonly scanning=new Map<string,Promise<void>>();
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
    let common:string|null=null;try{common=path.resolve(root,await git(root,['rev-parse','--git-common-dir']));}catch{/* Non-Git engineering projects are supported. */}
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
    let head:string|null=null,branch:string|null=null,common:string|null=null,dirty:string[]=[];
    try {common=path.resolve(workspace.root_path,await git(workspace.root_path,['rev-parse','--git-common-dir']));branch=await git(workspace.root_path,['symbolic-ref','--short','-q','HEAD']).catch(()=>null);head=await git(workspace.root_path,['rev-parse','HEAD']).catch(()=>null);
      const modified=await git(workspace.root_path,['diff','--name-only','-z','HEAD']).catch(()=>git(workspace.root_path,['diff','--name-only','-z','--cached']));
      const untracked=await git(workspace.root_path,['ls-files','--others','--exclude-standard','-z']);dirty=[...new Set([...modified.split('\0'),...untracked.split('\0')].filter(Boolean))];
    }catch(error){if(common)throw error;}
    const cached=this.store.maybe<CodeState>('engineering_state',workspace.workspace_id);
    let snapshot=cached?this.store.get<Snapshot>('snapshot',cached.snapshot_id):this.store.get<Snapshot>('snapshot',project.snapshot_id);
    if(!samePath(snapshot.root_path,workspace.root_path)||(await freshness(snapshot)).length){snapshot=await capture(workspace.root_path,projectId,this.store.directory,project.build_config);this.store.put('snapshot',snapshot.source_snapshot_id,snapshot);}
    if(common){const after=await git(workspace.root_path,['rev-parse','HEAD']).catch(()=>null),afterBranch=await git(workspace.root_path,['symbolic-ref','--short','-q','HEAD']).catch(()=>null);if(after!==head||afterBranch!==branch)throw Error('采集过程中分支或 HEAD 变化，请重试');}
    const state:CodeState={snapshot_id:snapshot.source_snapshot_id,fingerprint:snapshot.fingerprint,head,branch,git_common_dir:common,dirty,captured_at:now()};
    const currentWorkspace=this.store.get<WorkspaceBinding>(workspaceKind,workspace.workspace_id);if(currentWorkspace.status!=='bound'||!samePath(currentWorkspace.root_path,workspace.root_path))throw Error('采集期间工作区已重新绑定，请重新读取');
    this.store.put('engineering_state',workspace.workspace_id,state);return state;
  }
  async context(input:ContextRequest):Promise<EngineeringContext> {
    const restored=input.project_id&&!input.workspace_path?this.store.all<WorkspaceBinding>(workspaceKind).find(w=>w.project_id===input.project_id&&w.status==='unbound'):undefined;
    const workspace=restored??await this.resolve(input),projectId=workspace.project_id;
    const state=restored?this.store.get<CodeState>('engineering_state',workspace.workspace_id):await this.captureState(projectId);
    const old=this.store.maybe<{fingerprint:string;version:number}>('engineering_context_state',projectId);
    if(!restored&&(input.refresh||!old||old.fingerprint!==state.fingerprint)){
      const pending=this.scanning.get(projectId);if(pending)await pending;else{const scan=this.scanContext(projectId,state);this.scanning.set(projectId,scan);try{await scan;}finally{this.scanning.delete(projectId);}}
    }
    const contextState=this.store.get<{version:number}>('engineering_context_state',projectId);
    if(input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||input.offset<0)||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1))throw Error('上下文分页参数无效');
    const entries=this.store.all<ContextEntry>(contextKind).filter(e=>e.project_id===projectId&&e.status!=='superseded'&&(!input.category||e.category===input.category)&&(!input.entry_id||e.entry_id===input.entry_id)&&(!input.query||`${e.key}\n${e.text}`.toLowerCase().includes(input.query.toLowerCase())));
    const categories:ContextEntry['category'][]=[...engineeringSectionCategories,'purpose','rule','build','technology','module','interface','decision','issue'];
    const groups=categories.map(category=>entries.filter(e=>e.category===category).sort((a,b)=>Number(b.origin==='user')-Number(a.origin==='user')||Number(b.status==='current')-Number(a.status==='current')||a.key.localeCompare(b.key)));
    const ordered:ContextEntry[]=[];for(let i=0;i<Math.max(...groups.map(group=>group.length));i++)for(const group of groups)if(group[i])ordered.push(group[i]);
    const offset=input.entry_id?0:input.offset??0,limit=input.entry_id?1:Math.min(input.limit??24,40),maxText=input.entry_id?60000:1500;
    const page=ordered.slice(offset,offset+limit).map(e=>({...e,text:e.text.slice(0,maxText),truncated:e.text.length>maxText}));
    const analysis=input.result_id?this.readAnalysis(input.result_id,workspace,state,input):undefined;
    return {project_id:projectId,workspace,version:contextState.version,code_state:state,entries:input.result_id?[]:page,total_entries:ordered.length,next_offset:input.result_id?null:offset+limit<ordered.length?offset+limit:null,analysis_refs:this.store.all<Explanation>('explanation').filter(e=>e.result.binding.project_id===projectId).slice(-10).map(e=>({result_id:e.result_id,source_snapshot_id:e.result.binding.source_snapshot_id,status:this.analysisStatus(e,workspace,state),summary:e.result.summary.text.slice(0,500)})),...(analysis?{analysis}:{}),recent_tasks:this.tasks({project_id:projectId}).slice(0,5).map(t=>({task_id:t.task_id,goal:t.goal.slice(0,1000),status:t.status,summary:t.summary.slice(0,1500),version:t.version,updated_at:t.updated_at,verification_status:t.verification_status,decisions:t.decisions.slice(0,5).map(s=>s.slice(0,500)),unresolved:t.unresolved.slice(0,5).map(s=>s.slice(0,500))}))};
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
    if(!engineeringSectionCategories.includes(input.category)||!['user','agent'].includes(origin))throw Error('工程栏目或来源无效');
    if(!Number.isSafeInteger(input.expected_version)||input.expected_version<0)throw Error('条目版本无效');
    if(input.status!==undefined&&!['current','needs_review'].includes(input.status))throw Error('条目状态无效');
    const text=requireText(input.text,60000),entryKey=requireText(input.key,300),submission=requireText(input.submission_key,300);
    const receiptKey=this.receiptKey('entry',workspace.project_id,submission),digest=sha(JSON.stringify({...input,origin}));
    return this.store.transaction(()=>{
      if(!maySave())throw Error('执行已停止，拒绝迟到工程条目');
      const receipt=this.store.maybe<{digest:string;entry:ContextEntry}>('engineering_receipt',receiptKey);
      if(receipt){if(receipt.digest!==digest)throw Error('提交标识已用于其他条目内容');return receipt.entry;}
      const binding=this.store.get<WorkspaceBinding>(workspaceKind,workspace.workspace_id);
      if(binding.status!=='bound'||!samePath(binding.root_path,workspace.root_path))throw Error('工作区已改变，请重新读取');
      const old=input.entry_id?this.store.get<ContextEntry>(contextKind,input.entry_id):undefined;
      if(old&&old.project_id!==workspace.project_id)throw Error('条目不属于当前工作区');
      if((old?.version??0)!==input.expected_version)throw Error('VERSION_CONFLICT：条目已更新，请重新读取');
      const sources=input.sources??old?.sources??[];
      if(!Array.isArray(sources)||sources.length>40)throw Error('来源列表无效');
      let sourcesCurrent=true;
      for(const source of sources){const snapshot=this.store.get<Snapshot>('snapshot',source.snapshot_id),file=snapshot.files.find(f=>f.path===source.path);if(snapshot.project_id!==workspace.project_id||!file||file.content_sha256!==source.content_sha256||!Number.isSafeInteger(source.line_start)||!Number.isSafeInteger(source.line_end)||source.line_start<1||source.line_end<source.line_start||source.line_end>file.line_count)throw Error('来源快照、文件或行号不匹配');if(snapshot.fingerprint!==context.code_state.fingerprint)sourcesCurrent=false;}
      const fork=!!old&&['source','document'].includes(old.origin);
      const key=entryKey.startsWith('entry:')?entryKey:`entry:${entryKey}`;
      if(this.store.all<ContextEntry>(contextKind).some(e=>e.project_id===workspace.project_id&&e.category===input.category&&e.key===key&&e.status!=='superseded'&&e.entry_id!==old?.entry_id))throw Error('VERSION_CONFLICT：同名条目已存在，请读取后编辑');
      const entry:ContextEntry={entry_id:old&&!fork?old.entry_id:id('context'),project_id:workspace.project_id,version:old&&!fork?old.version+1:1,key,category:input.category,origin,text,status:origin==='user'&&sources.length&&sourcesCurrent?(input.status??'needs_review'):'needs_review',sources,code_fingerprint:context.code_state.fingerprint,updated_at:now(),...(fork?{supersedes:old!.entry_id}:old?.supersedes?{supersedes:old.supersedes}:{}),...(fork?{conflict:'修订与原文并列保留；原文来源及历史未覆盖。'}:{})};
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
  task(taskId:string){const task=this.store.get<EngineeringTask>(taskKind,taskId);const baseline=this.store.get<Snapshot>('snapshot',task.baseline.snapshot_id),files=new Map(task.baseline.dirty.map(file=>[file,baseline.files.find(f=>f.path===file)?.content_sha256??null]));for(const file of task.rebind_preexisting_files??[])files.set(file.path,file.sha256);task.preexisting_files=[...files].map(([path,sha256])=>({path,sha256}));return task;}
  history(kind:'task'|'context',objectId:string){return this.store.versions(kind==='task'?taskKind:contextKind,objectId);}
  private receiptKey(operation:string,objectId:string,key:string){return sha(`${operation}\0${objectId}\0${requireText(key,300)}`);}
  private saveTask(task:EngineeringTask){task.version++;task.updated_at=now();task.saved='saved';this.store.putVersion(taskKind,task.task_id,task.version,task);}
  async createTask(input:CreateEngineeringTask):Promise<EngineeringTask> {
    const workspace=await this.resolve(input);
    if(input.task_id){const task=this.task(input.task_id);if(task.workspace_id!==workspace.workspace_id)throw Error('任务属于另一个工作区');const key=this.receiptKey('continue',task.task_id,input.submission_key);if(this.store.maybe('engineering_receipt',key))return task;const text=requireText(input.goal);this.store.transaction(()=>{task.requests??=[];task.requests.push({text,submission_key:input.submission_key,created_at:now()});this.saveTask(task);this.store.put('engineering_receipt',key,task);});this.changed();return task;}
    const key=this.receiptKey('create',workspace.workspace_id,input.submission_key),existing=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(existing)return this.task(existing.task_id);
    const context=await this.context({project_id:workspace.project_id});
    return this.store.transaction(()=>{const retry=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(retry)return this.task(retry.task_id);
      const task:EngineeringTask={task_id:id('task'),project_id:workspace.project_id,workspace_id:workspace.workspace_id,workspace_path:workspace.root_path,version:0,submission_key:input.submission_key,goal:requireText(input.goal),scope:(input.scope??[]).map(relativePath),status:'pending',baseline:context.code_state,context_version:context.version,summary:'',decisions:[],unresolved:[],changes:[],verification:[],verification_status:'not_run',attempt_ids:[],requests:[],created_at:now(),updated_at:now(),saved:'saved'};
      this.saveTask(task);this.store.put('engineering_receipt',key,task);this.changed();return task;});
  }
  updateTask(input:UpdateEngineeringTask):EngineeringTask {
    const key=this.receiptKey('update',input.task_id,input.submission_key),prior=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(prior)return prior;
    return this.store.transaction(()=>{const task=this.task(input.task_id);this.checkUpdate(task,input);
      if(input.summary!==undefined)task.summary=requireText(input.summary);
      if(input.decisions)task.decisions=input.decisions.map(s=>requireText(s));if(input.unresolved)task.unresolved=input.unresolved.map(s=>requireText(s));
      if(input.verification)for(const evidence of input.verification){this.checkEvidence(task,evidence);if(!task.verification.some(e=>e.evidence_id===evidence.evidence_id))task.verification.push(evidence);}
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
  }
  private checkLogPath(task:EngineeringTask,filePath:string){relativePath(filePath);if(!filePath.startsWith(`development/${task.task_id}/`)&&!filePath.startsWith(`logs/${task.task_id}/`))throw Error('日志路径不属于此任务的证据目录');}
  private verificationStatus(task:EngineeringTask,state:CodeState):EngineeringTask['verification_status'] {
    if(!task.verification.length)return 'not_run';const current=task.verification.filter(e=>e.code_state.fingerprint===state.fingerprint&&e.code_state.head===state.head);
    if(!current.length)return 'stale';const latest=new Map<string,VerificationEvidence>();for(const e of current)latest.set(e.command,e);const checks=[...latest.values()];
    if(checks.some(e=>e.outcome==='failed'))return 'failed';if(checks.every(e=>e.outcome==='passed'&&e.origin==='observed'&&e.code_state_verified!==false))return 'passed';return 'partial';
  }
  async finishTask(input:FinishEngineeringTask):Promise<EngineeringTask> {
    const key=this.receiptKey('finish',input.task_id,input.submission_key),prior=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(prior)return prior;
    const task=this.task(input.task_id);this.checkUpdate(task,input);const workspace=await this.resolve({project_id:task.project_id});if(workspace.workspace_id!==task.workspace_id||!samePath(workspace.root_path,task.workspace_path))throw Error('任务绑定工作区已改变，拒绝写回');
    const end=await this.captureState(task.project_id,task.workspace_path);
    const attempt=task.attempt_ids.at(-1)?this.store.get<DevelopmentAttempt>(attemptKind,task.attempt_ids.at(-1)!):undefined;
    if(end.branch!==(attempt?.baseline??task.baseline).branch||end.git_common_dir!==workspace.git_common_dir)throw Error('WORKSPACE_CONFLICT：任务期间分支或仓库归属变化，请核查后接续');
    const before=this.store.get<Snapshot>('snapshot',task.baseline.snapshot_id),after=this.store.get<Snapshot>('snapshot',end.snapshot_id),beforeFiles=new Map(before.files.map(f=>[f.path,f.content_sha256])),afterFiles=new Map(after.files.map(f=>[f.path,f.content_sha256]));
    const changes=[...new Set([...beforeFiles.keys(),...afterFiles.keys()])].filter(p=>beforeFiles.get(p)!==afterFiles.get(p)).map(p=>({path:p,before_sha256:beforeFiles.get(p)??null,after_sha256:afterFiles.get(p)??null,ownership:task.baseline.dirty.includes(p)||task.rebind_preexisting_files?.some(f=>f.path===p)?'preexisting_overlap' as const:'task_change' as const}));
    return this.store.transaction(()=>{const retry=this.store.maybe<EngineeringTask>('engineering_receipt',key);if(retry)return retry;const current=this.task(task.task_id);this.checkUpdate(current,input);current.end_state=end;current.changes=changes;current.status=input.status;if(input.summary!==undefined)current.summary=requireText(input.summary);if(input.decisions)current.decisions=input.decisions.map(s=>requireText(s));if(input.unresolved)current.unresolved=input.unresolved.map(s=>requireText(s));
      for(const evidence of input.verification??[]){this.checkEvidence(current,evidence);if(!current.verification.some(e=>e.evidence_id===evidence.evidence_id))current.verification.push(evidence);}
      current.verification_status=this.verificationStatus(current,end);this.saveTask(current);this.markAffected(current.project_id,changes.map(c=>c.path));this.store.put('engineering_receipt',key,current);this.changed();return current;});
  }
  private markAffected(projectId:string,files:string[]) {
    if(!files.length)return;let changed=false;
    for(const entry of this.store.all<ContextEntry>(contextKind))if(entry.project_id===projectId&&entry.status==='current'&&entry.sources.some(s=>files.includes(s.path))){entry.status='needs_review';entry.version++;entry.updated_at=now();this.store.putVersion(contextKind,entry.entry_id,entry.version,entry);changed=true;}
    if(changed){const state=this.store.get<any>('engineering_context_state',projectId);state.version++;this.store.put('engineering_context_state',projectId,state);}
  }
  startAttempt(taskId:string,input:Pick<DevelopmentAttempt,'provider_id'|'model'|'origin'>) {
    return this.store.transaction(()=>{const task=this.task(taskId);if(task.attempt_ids.some(a=>['starting','running'].includes(this.store.get<DevelopmentAttempt>(attemptKind,a).status)))throw Error('本任务已有正在执行的会话');
      const workspace=this.store.get<WorkspaceBinding>(workspaceKind,task.workspace_id);if(workspace.status!=='bound'||!samePath(workspace.root_path,task.workspace_path))throw Error('任务工作区未绑定或已改变');
      const attempt:DevelopmentAttempt={...input,attempt_id:id('attempt'),task_id:taskId,project_id:task.project_id,workspace_id:task.workspace_id,workspace_path:task.workspace_path,status:'starting',started_at:now(),baseline:this.store.maybe<CodeState>('engineering_state',task.workspace_id)??task.baseline,context_version:this.store.get<any>('engineering_context_state',task.project_id).version};task.attempt_ids.push(attempt.attempt_id);task.status='running';this.saveTask(task);this.store.put(attemptKind,attempt.attempt_id,attempt);this.changed();return attempt;});
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
    let common:string|null=null;try{common=path.resolve(root,await git(root,['rev-parse','--git-common-dir']));}catch{/* Non-Git is supported. */}
    this.store.transaction(()=>{workspace.root_path=root;workspace.status='bound';workspace.git_common_dir=common;workspace.rebound_at=now();this.store.put(workspaceKind,workspace.workspace_id,workspace);project.root_path=root;project.snapshot_id=snapshot.source_snapshot_id;this.store.put('snapshot',snapshot.source_snapshot_id,snapshot);this.store.put('project',projectId,project);this.store.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run('engineering_state',workspace.workspace_id);
      for(const task of this.tasks({project_id:projectId})){const before=this.store.get<Snapshot>('snapshot',task.end_state?.snapshot_id??task.baseline.snapshot_id),beforeFiles=new Map(before.files.map(f=>[f.path,f.content_sha256])),afterFiles=new Map(snapshot.files.map(f=>[f.path,f.content_sha256])),preexisting=new Map((task.rebind_preexisting_files??[]).map(f=>[f.path,f.sha256]));for(const file of new Set([...beforeFiles.keys(),...afterFiles.keys()]))if(beforeFiles.get(file)!==afterFiles.get(file))preexisting.set(file,afterFiles.get(file)??null);task.rebind_preexisting_files=[...preexisting].map(([path,sha256])=>({path,sha256}));task.rebind_source_snapshot_id=snapshot.source_snapshot_id;task.workspace_path=root;this.saveTask(task);}
      for(const explanation of this.store.all<Explanation>('explanation'))if(explanation.result.binding.project_id===projectId){explanation.source_status=this.store.get<Snapshot>('snapshot',explanation.result.binding.source_snapshot_id).fingerprint===snapshot.fingerprint?'current':'needs_review';this.store.put('explanation',explanation.result_id,explanation);}
    });await this.context({project_id:projectId,refresh:true});this.changed();return workspace;
  }
  async exportProject(projectId:string,filePath:string){await this.connect(projectId);return exportEngineeringProject(this.store,projectId,filePath);}
  async readLog(taskId:string,filePath:string){const task=this.task(taskId);this.checkLogPath(task,filePath);const allowed=task.verification.some(e=>e.log_path===filePath)||task.attempt_ids.some(a=>this.store.get<DevelopmentAttempt>(attemptKind,a).log_path===filePath);if(!allowed)throw Error('日志不属于此任务');const file=await safeFile(this.store.directory,filePath),stat=await fs.stat(file);if(stat.size>2*1024*1024)throw Error('日志超过 2 MiB 展示限制，请在数据目录查看');return {path:filePath,text:await fs.readFile(file,'utf8')};}
  async taskDiff(taskId:string,filePath:string){const task=this.task(taskId);relativePath(filePath);const change=task.changes.find(c=>c.path===filePath);if(!change||!task.end_state)throw Error('文件不属于此任务已保存的差异');const beforeSnapshot=this.store.get<Snapshot>('snapshot',task.baseline.snapshot_id),afterSnapshot=this.store.get<Snapshot>('snapshot',task.end_state.snapshot_id);const before=change.before_sha256?(await readSource(this.store.directory,beforeSnapshot,filePath)).text:'',after=change.after_sha256?(await readSource(this.store.directory,afterSnapshot,filePath)).text:'';return {path:filePath,before:before.slice(0,200000),after:after.slice(0,200000),before_snapshot_id:task.baseline.snapshot_id,after_snapshot_id:task.end_state.snapshot_id,truncated:before.length>200000||after.length>200000};}
  async restoreProject(filePath:string){const result=await restoreEngineeringProject(this.store,filePath);this.changed();return result;}
}
