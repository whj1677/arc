import type {AnalysisResult,ReadingGuide} from '../shared';

// An exception is connected only where a source-backed control-flow edge
// connects the exact step nodes in this explanation and selected path.
export function readingFailureLinks(result:AnalysisResult,guide:ReadingGuide,path:ReadingGuide['paths'][number]){
  const mainIds=new Set([...path.step_ids,...path.lanes.flatMap(l=>l.step_ids)]);
  const sources=guide.steps.filter(s=>mainIds.has(s.id)),targets=guide.steps.filter(s=>path.failure_ids.includes(s.id));
  return result.edges.filter(e=>e.kind==='control_flow'&&e.flow_role==='exception'&&e.status==='source_supported').flatMap(e=>{
    const from=sources.find(s=>s.node_ids.includes(e.source_node_id)),to=targets.find(s=>s.node_ids.includes(e.target_node_id));
    return from&&to?[{id:e.edge_id,from:from.id,to:to.id,label:e.condition||e.label}]:[];
  });
}

export function readingCollaboration(guide:ReadingGuide,path:ReadingGuide['paths'][number]){
  const roles=guide.roles.filter(r=>path.role_ids.includes(r.id));
  const ids=new Set(roles.map(r=>r.id));
  return {roles,handoffs:guide.handoffs.filter(h=>path.handoff_ids.includes(h.id)&&ids.has(h.from)&&ids.has(h.to))};
}
