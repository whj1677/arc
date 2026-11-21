import type {AnalysisResult,ReadingGuide,ReadingState} from '../shared';
import {savedReadingGuide} from '../feature-graph-guide';
import {timelineModel} from './timeline-model';

// Every projection uses only the selected explanation. No cross-result file lookup.
export function featureReadingModel(result:AnalysisResult):ReadingGuide {
  const source=savedReadingGuide(result);
  if(source){
    if(source.files.length&&source.paths.every(path=>path.files.length))return source;
    const referenced=new Set(source.steps.flatMap(step=>step.evidence_ids)),relevant=result.evidence.filter(e=>referenced.has(e.evidence_id));
    const files:ReadingGuide['files']=source.files.length?source.files:[...new Set(relevant.map(e=>e.path))].map(file=>{
      const refs=relevant.filter(e=>e.path===file),ids=new Set(refs.map(e=>e.evidence_id)),linked=source.steps.filter(step=>step.evidence_ids.some(id=>ids.has(id)));
      return {path:file,title:file.split('/').at(-1)!,description:'由当前业务步骤的实际引用确定；文件职责尚未单独分析。',detail:'这里只恢复文件入口和步骤关联，不把引用当成完整文件说明。',step_ids:linked.map(step=>step.id),evidence_ids:refs.map(e=>e.evidence_id)};
    });
    const paths=source.paths.map(path=>path.files.length?path:{...path,files:[...new Set(path.step_ids.flatMap(id=>files.filter(file=>file.step_ids.includes(id)).map(file=>file.path)))]});
    return {...source,files,paths};
  }
  const model=timelineModel(result),flow=result.edges.filter(e=>e.kind==='control_flow');
  const exceptionIds=new Set(flow.filter(e=>e.flow_role==='exception').map(e=>e.target_node_id));
  const business=result.nodes.filter(n=>n.kind!=='function'&&!n.source_scope);
  const steps:ReadingGuide['steps']=business.map(n=>({id:n.node_id,title:n.label,actor:n.execution_context.status==='unknown'?'参与者未确认':n.execution_context.label,text:n.description,outcome:n.outputs.map(o=>o.description||o.name).join('；')||'本结果未说明产出',detail:result.claims.filter(c=>n.claim_ids.includes(c.claim_id)).map(c=>[c.statement,...c.limitations].join(' ')).join('\n'),node_ids:[n.node_id],evidence_ids:n.evidence_ids}));
  const calls=result.edges.filter(e=>e.kind!=='control_flow'&&e.kind!=='return');
  const roleNodes=result.nodes.filter(n=>!n.source_scope&&calls.some(e=>e.source_node_id===n.node_id||e.target_node_id===n.node_id));
  const roles:ReadingGuide['roles']=roleNodes.map(n=>({id:n.node_id,title:n.label,duty:n.description,files:[...new Set(result.evidence.filter(e=>n.evidence_ids.includes(e.evidence_id)).map(e=>e.path))],evidence_ids:n.evidence_ids}));
  const handoffs:ReadingGuide['handoffs']=calls.filter(e=>roleNodes.some(n=>n.node_id===e.source_node_id)&&roleNodes.some(n=>n.node_id===e.target_node_id)).map(e=>{const from=result.nodes.find(n=>n.node_id===e.source_node_id)!,to=result.nodes.find(n=>n.node_id===e.target_node_id)!;return {id:e.edge_id,from:e.source_node_id,to:e.target_node_id,label:e.label,kind:e.kind==='sync_call'?'同步调用':e.kind==='dependency'?'依赖关系':'已分析关系',send:e.transfers?.map(t=>from.outputs.find(io=>io.io_id===t.source_output_id)?.name).join('；')||'交接内容尚未明确',receive:e.transfers?.map(t=>to.inputs.find(io=>io.io_id===t.target_input_id)?.name).join('；')||'返回或结果尚未明确',detail:e.condition||result.claims.filter(c=>e.claim_ids.includes(c.claim_id)).map(c=>c.statement).join('\n'),evidence_ids:e.evidence_ids};});
  const files:ReadingGuide['files']=[...new Set(result.evidence.map(e=>e.path))].map(path=>{const refs=result.evidence.filter(e=>e.path===path),ids=new Set(refs.map(e=>e.evidence_id));const purpose=result.nodes.find(n=>n.source_scope?.kind==='file'&&n.source_scope.path===path);const linked=business.filter(n=>n.evidence_ids.some(id=>ids.has(id)));return {path,title:purpose?.label||path.split('/').at(-1)!,description:purpose?.description||(linked.length?`本功能中支撑：${[...new Set(linked.map(n=>n.label))].join('、')}。`:'本结果提供了该文件的引用，具体职责尚未说明。'),detail:purpose?'说明限定在当前功能与当前快照。':refs.map(e=>e.note).filter(Boolean).join('\n'),step_ids:linked.map(n=>n.node_id),evidence_ids:refs.map(e=>e.evidence_id)};});
  const ids=model.ordered?model.ids.filter(id=>steps.some(s=>s.id===id)):business.filter(n=>!exceptionIds.has(n.node_id)).map(n=>n.node_id);
  const failureIds=business.filter(n=>exceptionIds.has(n.node_id)).map(n=>n.node_id);
  return {steps,roles,handoffs,files,paths:[{id:'current',label:'当前功能',entry:model.ordered?'已确认的业务顺序':'先后关系尚未完整确认',intro:model.ordered?'沿已分析的顺序阅读业务过程':'查看已分析的业务环节',boundary:result.coverage.unresolved_scope.join('；'),step_ids:ids,lanes:[],failure_ids:failureIds,role_ids:roles.map(r=>r.id),handoff_ids:handoffs.map(h=>h.id),files:files.map(f=>f.path)}]};
}

export function guideItem(guide:ReadingGuide,key:string){const split=key.indexOf(':'),kind=key.slice(0,split),id=key.slice(split+1);return kind==='step'?guide.steps.find(s=>s.id===id):kind==='role'?guide.roles.find(r=>r.id===id):kind==='handoff'?guide.handoffs.find(h=>h.id===id):kind==='file'?guide.files.find(f=>f.path===id):undefined;}
export function guideEvidenceIds(guide:ReadingGuide,key:string){return guideItem(guide,key)?.evidence_ids||[];}
export function guideItemTitle(guide:ReadingGuide,key:string){const item=guideItem(guide,key);return item?('title' in item?item.title:'label' in item?item.label:''):'';}
export function guidePathForStep(guide:ReadingGuide,id:string){return guide.paths.find(p=>[...p.step_ids,...p.lanes.flatMap(l=>l.step_ids),...p.failure_ids].includes(id));}

export function featureReadingPosition(r:ReadingState):ReadingState {
  if(r.entrance!=='walk'||r.feature_reading_version===1)return r;
  const legacy=['topicmap','flow','sequence'].includes(r.view);
  return {...r,feature_reading_version:1,...(legacy?{view:'collaboration'}:{}),selected:'',file:'',evidence_id:'',reading_path:'',function_path:'',reading_focus:''};
}

export const featureViews=[['timeline','业务流程'],['collaboration','协作关系'],['functions','函数走读'],['files','相关文件']];
export function hasCollaborationRoles(result?:AnalysisResult){
  return !!savedReadingGuide(result)?.roles.length;
}

// Business paths are shared by the three reading pages. Auxiliary function
// paths must not replace that selection when the user returns from a helper.
export function featurePathPosition(r:ReadingState,result:AnalysisResult,pathId:string):ReadingState {
  return {...r,reading_path:pathId,function_path:result.function_walkthroughs?.some(p=>p.id===pathId)?pathId:'',reading_focus:'',selected:'',file:'',evidence_id:'',detail_tab:'details'};
}

export function functionPathPosition(r:ReadingState,result:AnalysisResult,pathId:string,nodeId:string):ReadingState {
  return {...r,function_path:pathId,reading_path:result.reading_guide?.paths.some(p=>p.id===pathId)?pathId:r.reading_path,reading_focus:'',selected:nodeId,file:'',evidence_id:'',detail_tab:'details'};
}

export function featureViewPosition(r:ReadingState,view:string,sourceSnapshotId:string):ReadingState|null {
  if(r.entrance!=='walk'||!featureViews.some(([id])=>id===view))return null;
  // Page-local positions must never restore a different explanation version.
  return {...r,view,selected:'',file:'',evidence_id:'',source_snapshot_id:sourceSnapshotId,detail_tab:'details',mode:'normal',reading_focus:''};
}
