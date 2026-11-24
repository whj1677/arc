import {
  applyModuleDelete, architectureUpdateStatus,
  type ArchitectureDocument, type ArchitectureModule, type ArchitectureRelation, type CodeBinding, type ReviewItem,
} from '../architecture-workspace';
import path from 'node:path';
import type { AnalysisResult, Explanation, Project, Run, Snapshot, SourceEvidence } from '../shared';
import { fields, proposalSignature, reviewedFlow, validateProposalFields, verifyProposalEvidence,
  type FlowPatch, type SemanticProposal } from './architecture-semantic';
import { id, now, type Store } from './store';

type Save = (doc:ArchitectureDocument, expectedVersion:number, companionWrite?:()=>void)=>ArchitectureDocument;
export interface ReviewDecision {reviewId:string;decision:'accept'|'reject'|'defer';note?:string}

function updatedExplanation(store:Store, doc:ArchitectureDocument, item:ReviewItem, snapshot:Snapshot) {
  const patch=item.proposed as FlowPatch;
  const prior=store.get<Explanation>('explanation',patch.explanation_id);
  const project=store.get<Project>('project',doc.project_id);
  if(prior.result.binding.project_id!==doc.project_id || prior.result.binding.feature_id!==item.target_id ||
    prior.scenario_id===project.overview_scenario_id || !store.latestFeatureExplanations(project,doc.branch_key).some(e=>e.result_id===prior.result_id))
    throw Error('该功能走读已变化或不属于本工程，请重新检查更新');
  const result_id=id('result'), created_at=now(), runId=item.analysis_run_id ?? item.id;
  const result:AnalysisResult={...reviewedFlow(prior,patch,item.evidence,snapshot),result_id,
    binding:{...prior.result.binding,run_id:runId,source_snapshot_id:snapshot.source_snapshot_id},
    ...(item.analysis_run_id && {provider:{provider_id:'codex',connection_id:'local-codex',adapter_version:'architecture-incremental-1'}})};
  // Keep the original result for historical reading links and annotations.
  const updated:Explanation={...prior,result_id,result,created_at,architecture_branch:doc.branch_key,
    source_status:project.snapshot_id===snapshot.source_snapshot_id?'current':'needs_review'};
  if(item.analysis_run_id) {
    if(!/^architecture-[\da-f-]{36}$/.test(runId))throw Error('功能走读提案的分析运行 ID 不合法');
    const run:Run={binding:result.binding,provider_id:'codex',question:'分析功能走读的增量变更',title:item.title,
      status:'completed',created_at:item.created_at,ended_at:created_at,submission_key:item.id,
      previous_run_id:prior.result.binding.run_id,output_path:path.join(store.directory,'runs',runId,'result.json')};
    store.put('run',runId,run);
  }
  store.put('explanation',result_id,updated);
}

function applyRename(doc:ArchitectureDocument,item:ReviewItem,snapshot:Snapshot) {
  const target=(item.target_kind==='module'?doc.modules:doc.relations).find(obj=>obj.id===item.target_id);
  if(!target)throw Error('待迁移的架构对象已不存在');
  const patch=fields(item.proposed);
  const evidence=(patch.evidence ?? []) as SourceEvidence[];
  if(evidence.length)verifyProposalEvidence(evidence,snapshot);
  const replacements=new Map(evidence.map(ev=>[ev.evidence_id,ev]));
  if(evidence.some(ev=>!target.evidence.some(old=>old.evidence_id===ev.evidence_id)))throw Error('待迁移依据已变化');
  target.evidence=target.evidence.map(ev=>replacements.get(ev.evidence_id) ?? ev);
  if('code_links' in target && patch.code_links) {
    const links=patch.code_links as CodeBinding[];
    for(const link of links){
      const file=snapshot.files.find(entry=>entry.path===link.path);
      if(!target.code_links.some(old=>old.id===link.id) || !file || link.file_sha256!==file.content_sha256 ||
        link.start_line!==undefined && (!Number.isInteger(link.start_line)||link.start_line<1||link.start_line>file.line_count) ||
        link.end_line!==undefined && (!Number.isInteger(link.end_line)||link.end_line<(link.start_line??1)||link.end_line>file.line_count))
        throw Error('待迁移代码绑定与冻结文件不符');
    }
    const moved=new Map(links.map(link=>[link.id,link]));
    target.code_links=target.code_links.map(link=>moved.get(link.id) ?? link);
  }
  target.updated_at=now();
}

function targetOf(doc:ArchitectureDocument,item:ReviewItem) {
  return (item.target_kind==='module'?doc.modules:doc.relations).find(obj=>obj.id===item.target_id);
}

function applyArchitectureChange(doc:ArchitectureDocument, item:ReviewItem, operation:ReviewItem['category']) {
  const target=targetOf(doc,item), updated_at=now(), patch=fields(item.proposed ?? {});
  if(operation==='uncertain')return;
  if(operation==='module_add') {
    if(target)throw Error('待新增模块的 ID 已存在，请重新检查');
    const mod:ArchitectureModule={...patch as Pick<ArchitectureModule,'name'|'kind'|'summary'|'layer'|'parent_id'>,
      id:item.target_id!,origin:'code_analysis',implementation_status:'implemented',evidence:item.evidence,updated_at,
      code_links:item.evidence.map(ev=>({id:ev.evidence_id,kind:ev.symbol_id?'symbol':'file',path:ev.path,
        symbol_id:ev.symbol_id,start_line:ev.line_start,end_line:ev.line_end,file_sha256:ev.content_sha256,origin:'code_analysis'}))};
    if(mod.parent_id===null)delete mod.parent_id;
    doc.modules.push(mod);
  } else if(operation==='relation_add') {
    const rel:ArchitectureRelation={...patch as Pick<ArchitectureRelation,'label'|'from'|'to'|'kind'>,id:item.target_id!,
      updated_at,origin:'code_analysis',status:'confirmed',evidence:item.evidence};
    if(target || doc.relations.some(r=>r.from===rel.from&&r.to===rel.to&&r.kind===rel.kind))
      throw Error('待新增关系的 ID 或端点关系已存在，请重新检查');
    doc.relations.push(rel);
  } else {
    if(!target)throw Error('审查目标已被移除，请重新检查更新');
    if(operation==='module_remove') {
      const {modules,relations,layout}=applyModuleDelete(doc,target.id,'reparent_children').doc;
      Object.assign(doc,{modules,relations,layout});
    } else if(operation==='relation_remove') {
      doc.relations=doc.relations.filter(r=>r.id!==target.id);
    } else {
      const {bind_paths,...changes}=patch;
      if(bind_paths && 'code_links' in target){
        for(const file of bind_paths as string[]){
          const ev=item.evidence.find(anchor=>anchor.path===file)!;
          if(!target.code_links.some(link=>link.path===file))target.code_links.push({kind:'file',id:id('binding'),
            origin:'code_analysis',path:file,start_line:ev.line_start,end_line:ev.line_end,file_sha256:ev.content_sha256});
        }
      }
      const evidence=new Map(target.evidence.map(ev=>[ev.evidence_id,ev]));
      for(const ev of item.evidence)evidence.set(ev.evidence_id,ev);
      Object.assign(target,changes,{updated_at,evidence:[...evidence.values()]});
      if('parent_id' in target && target.parent_id===null)delete target.parent_id;
    }
  }
}

export function resolveArchitectureReviewDecision(store:Store,current:ArchitectureDocument,opts:ReviewDecision,save:Save) {
  const doc=structuredClone(current);
  const item=doc.review_items.find(entry=>entry.id===opts.reviewId);
  if(!item || item.branch && item.branch!==doc.branch_key)throw Error('当前分支没有此架构审查项');
  if(item.status!=='pending' && item.status!=='deferred')throw Error('该审查项已有最终决定');
  const target=targetOf(doc,item);
  let operation=item.operation ?? item.category;
  // Older saved conflicts only carry their target kind and the proposed fields.
  if(operation==='manual_conflict' || operation==='exclusion_conflict') {
    if(item.target_kind==='module')operation=target?'module_update':'module_add';
    if(item.target_kind==='relation')operation=target?'relation_update':'relation_add';
  }
  let companionWrite:(()=>void)|undefined;
  const acknowledgement=(operation==='uncertain'||operation==='rename_uncertain') && item.proposed===undefined;
  if(acknowledgement && opts.decision!=='defer'){
    item.status=opts.decision==='accept'?'accepted':'rejected';
    item.decided_at=now();
  } else if(opts.decision!=='defer') {
    if(!item.target_id || !item.target_kind)throw Error('审查项缺少目标');
    const snapshot=store.get<Snapshot>('snapshot',item.evidence[0]?.source_snapshot_id ?? '');
    if(snapshot.project_id!==doc.project_id || snapshot.fingerprint!==item.code_baseline_fingerprint)
      throw Error('审查依据与工程或冻结快照不匹配');
    verifyProposalEvidence(item.evidence,snapshot);
    const proposal:SemanticProposal={category:operation,target_kind:item.target_kind,target_id:item.target_id,
      title:item.title,proposed:item.proposed,evidence:item.evidence};
    if(operation!=='rename_uncertain')validateProposalFields(proposal);
    const signature=proposalSignature(item.target_kind,item.target_id,item.proposed,target);
    if(opts.decision==='accept') {
      if(operation==='dataflow_change')companionWrite=()=>updatedExplanation(store,doc,item,snapshot);
      else if(operation==='rename_uncertain')applyRename(doc,item,snapshot);
      else applyArchitectureChange(doc,item,operation);
      if(item.category==='exclusion_conflict')doc.exclusions=doc.exclusions.filter(e=>e.signature!==signature);
      item.status='accepted';
    } else {
      if(item.target_kind!=='feature' && (operation.endsWith('_add') || item.category==='exclusion_conflict' ||
          item.target_kind==='relation' && operation==='relation_update')) {
        const prior=doc.exclusions.find(e=>e.signature===signature);
        const exclusion={id:prior?.id ?? id('exclude'),target_kind:item.target_kind,signature,label:item.title,reason:opts.note,
          evidence_fingerprint:item.evidence_fingerprint,evidence_paths:[...new Set(item.evidence.map(e=>e.path))].sort(),
          excluded_at:now(),excluded_version:doc.version+1};
        doc.exclusions=doc.exclusions.filter(e=>e.signature!==signature).concat(exclusion);
      }
      item.status='rejected';
    }
    item.decided_at=now();
  } else item.status='deferred';
  item.decision_note=opts.note;
  if(target && 'analysis_status' in target && target.analysis_status==='needs_review' &&
    !doc.review_items.some(i=>i.target_id===target.id && (i.status==='pending'||i.status==='deferred')))
    target.analysis_status='current';
  doc.update_status=architectureUpdateStatus(doc);
  if(doc.update_status==='up_to_date' && doc.last_update)doc.baseline=doc.last_update.read_baseline;
  return save(doc,current.version,companionWrite);
}
