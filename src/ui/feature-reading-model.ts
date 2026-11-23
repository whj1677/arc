import type {AnalysisResult,ReadingGuide,ReadingState,ReadingTarget} from '../shared';
import {savedReadingGuide} from '../feature-graph-guide';
import {timelineModel} from './timeline-model';
import {selectedCallStep} from './function-sequence-model';
import {edgeSelection} from './reading-target';

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
  const steps:ReadingGuide['steps']=business.map(n=>({id:n.node_id,title:n.label,actor:n.execution_context.status==='unknown'?'参与者未确认':n.execution_context.label,text:n.description,outcome:n.outputs.filter(o=>o.availability!=='unknown').map(o=>o.description||o.name).join('；'),detail:result.claims.filter(c=>n.claim_ids.includes(c.claim_id)&&c.status==='source_supported').map(c=>[c.statement,...c.limitations].join(' ')).join('\n'),node_ids:[n.node_id],evidence_ids:n.evidence_ids}));
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
export function guideItemTitle(guide:ReadingGuide,key:string){const item=guideItem(guide,key);return item?('title' in item?item.title:'label' in item?item.label:''):'';}
export function guidePathForStep(guide:ReadingGuide,id:string){return guide.paths.find(p=>[...p.step_ids,...p.lanes.flatMap(l=>l.step_ids),...p.failure_ids].includes(id));}

const unique = (values: readonly string[]) => [...new Set(values.filter(value => value.trim()))];

export function guideObjectType(item: ReturnType<typeof guideItem>) {
  return item && ('node_ids' in item ? '处理步骤' : 'duty' in item ? '参与模块' : 'from' in item ? '交接' : '文件');
}

export function walkthroughSelection(result: AnalysisResult, target: ReadingTarget): Partial<ReadingState> {
  const { kind, id } = target;
  const guide = featureReadingModel(result);
  const call = kind === 'call_step' ? selectedCallStep(result, id) : undefined;
  if (call) return { view: 'functions', selected: id, function_path: call.path.id };
  if (kind === 'file' || kind === 'directory') return { view: 'files', selected: 'file:' + id, file: id };
  if (kind === 'role' || kind === 'handoff') return {
    view: 'collaboration', selected: kind + ':' + id,
    reading_path: guide.paths.find(path => (kind === 'role' ? path.role_ids : path.handoff_ids).includes(id))?.id ?? '',
  };
  if (kind === 'edge') {
    const edge = result.edges.find(edge => edge.edge_id === id);
    if (edge && ['sync_call', 'execution_boundary'].includes(edge.kind)) return { view: 'functions', selected: edgeSelection(id) };
    if (guide.handoffs.some(item => item.id === id)) return { view: 'collaboration', selected: 'handoff:' + id };
    return { view: 'timeline', selected: edgeSelection(id) };
  }
  if (kind === 'node' && result.nodes.some(node => node.node_id === id && node.kind === 'function')) {
    return { view: 'functions', selected: id };
  }
  if (kind === 'step' || kind === 'node') {
    const step = guide.steps.find(step => step.id === id) ?? guide.steps.find(step => step.node_ids.includes(id));
    return { view: 'timeline', selected: step ? 'step:' + step.id : id, reading_path: step ? guidePathForStep(guide, step.id)?.id ?? '' : '' };
  }
  return {};
}

export function readingObjectDetail(result: AnalysisResult, guide: ReadingGuide, selected: string, pathId?: string) {
  const item = guideItem(guide, selected);
  if (!item) return;
  const step = 'node_ids' in item ? item : undefined;
  const nodeIds = new Set(step?.node_ids);
  const nodes = result.nodes.filter(node => nodeIds.has(node.node_id));
  const incoming = result.edges.filter(edge => nodeIds.has(edge.target_node_id) && !nodeIds.has(edge.source_node_id));
  const outgoing = result.edges.filter(edge => nodeIds.has(edge.source_node_id) && !nodeIds.has(edge.target_node_id));
  const io = nodes.flatMap(node => [...node.inputs, ...node.outputs]);
  const contexts = nodes.map(node => node.execution_context);
  const conditions = [
    ...contexts.filter(context => context.kind !== 'unknown' && context.status !== 'unknown' && context.label.trim())
      .map(context => ({ text: context.label, status: context.status })),
    ...incoming.flatMap(edge => edge.condition?.trim() ? [{ text: edge.condition, status: edge.status }] : []),
  ].filter((condition, index, all) => all.findIndex(other => other.text === condition.text && other.status === condition.status) === index);
  const references = new Map(result.evidence.map(evidence => [evidence.evidence_id, evidence]));
  const directEvidenceIds = unique([
    ...item.evidence_ids,
    ...[...nodes, ...io, ...contexts].flatMap(object => object.evidence_ids),
  ]);
  const anchors = unique([...directEvidenceIds, ...incoming.filter(edge => edge.condition?.trim()).flatMap(edge => edge.evidence_ids)]).flatMap(id => {
    const evidence = references.get(id);
    return evidence ? [evidence] : [];
  });
  const primaryEvidence = ('path' in item ? anchors.find(evidence => evidence.path === item.path) : anchors[0]);
  const readWrite = (field: 'inputs' | 'outputs', role: 'read' | 'write') => unique([
    ...nodes.flatMap(node => node[field]).filter(value => value.availability !== 'unknown')
      .map(value => [value.name, value.description !== value.name && value.description].filter(Boolean).join(' · ')),
    ...anchors.filter(evidence => directEvidenceIds.includes(evidence.evidence_id) && evidence.role === role)
      .map(evidence => evidence.note || `${evidence.path}:${evidence.line_start}`),
  ]);
  const ioIds = new Set(io.map(value => value.io_id));
  const directClaimIds = new Set([...nodes, ...io, ...contexts].flatMap(object => object.claim_ids));
  const claims = result.claims.filter(claim => directClaimIds.has(claim.claim_id)
    || claim.targets.node_ids.some(id => nodeIds.has(id)) || claim.targets.io_ids.some(id => ioIds.has(id)));
  const claimIds = new Set(claims.map(claim => claim.claim_id));
  const edgeIds = new Set([...incoming, ...outgoing].map(edge => edge.edge_id));
  const gaps = result.gaps.filter(gap => gap.related_node_ids.some(id => nodeIds.has(id))
    || gap.related_edge_ids?.some(id => edgeIds.has(id)) || gap.claim_ids.some(id => claimIds.has(id)));

  const path = guide.paths.find(path => path.id === pathId) ?? (step && guidePathForStep(guide, step.id));
  const paths = path ? [path.step_ids, ...path.lanes.map(lane => lane.step_ids), path.failure_ids] : [];
  const pathSteps = new Set(paths.flat());
  const next = outgoing.map(edge => {
    const matches = guide.steps.filter(candidate => pathSteps.has(candidate.id) && candidate.node_ids.includes(edge.target_node_id));
    return { edge, stepId: matches.length === 1 ? matches[0].id : undefined };
  });
  const savedGuide = savedReadingGuide(result);
  const orderedNext = step && savedGuide ? unique(paths.slice(0, -1).flatMap(ids => {
    const index = ids.indexOf(step.id);
    return index >= 0 && ids[index + 1] ? [ids[index + 1]] : [];
  })).filter(id => !next.some(link => link.stepId === id)) : [];
  const files = 'path' in item ? [] : unique([
    ...('files' in item ? item.files : 'from' in item
      ? guide.roles.filter(role => role.id === item.from || role.id === item.to).flatMap(role => role.files)
      : guide.files.filter(file => file.step_ids.includes(item.id)).map(file => file.path)),
    ...anchors.map(evidence => evidence.path).filter(path => guide.files.some(file => file.path === path)),
  ]);
  return {
    item, conditions, reads: step ? readWrite('inputs', 'read') : [], writes: step ? readWrite('outputs', 'write') : [],
    next, orderedNext, gaps, unresolvedClaims: claims.filter(claim => claim.status !== 'source_supported'),
    primaryEvidence, moreEvidence: anchors.filter(evidence => evidence !== primaryEvidence), files,
  };
}

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
