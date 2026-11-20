import type {Annotation,AnalysisResult} from '../shared';
// Matching a display name is never an identity check. Keep the old annotation
// immutable even when a same-source, same-anchor object can be navigated to.
export function annotationTarget(a:Annotation,old:AnalysisResult|undefined,current:AnalysisResult|undefined){
  if(!a.result_id)return '场景线索';
  if(a.result_id===current?.result_id)return '当前说明批注';
  if(!old||!current||!a.object_id||a.source_snapshot_id!==current.binding.source_snapshot_id)return '待重新定位 · 保留原说明';
  const kind=a.target?.kind??(old.nodes.some(n=>n.node_id===a.object_id)?'node':'edge');
  const find=(r:AnalysisResult)=>kind==='edge'?r.edges.find(e=>e.edge_id===a.object_id):r.nodes.find(n=>n.node_id===a.object_id);
  const before=find(old),after=find(current);
  const anchors=(r:AnalysisResult,ids:readonly string[])=>r.evidence.filter(e=>ids.includes(e.evidence_id)).map(e=>JSON.stringify([e.path,e.symbol_id??null,e.line_start,e.line_end,e.content_sha256])).sort();
  if(!before||!after||before.kind!==after.kind||!before.evidence_ids.length)return '待重新定位 · 保留原说明';
  return JSON.stringify(anchors(old,before.evidence_ids))===JSON.stringify(anchors(current,after.evidence_ids))?'同源同对象可关联 · 原批注未迁移':'待重新定位 · 保留原说明';
}
