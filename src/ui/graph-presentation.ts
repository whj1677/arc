import type {AnalysisResult} from '../shared';
type Edge=AnalysisResult['edges'][number];
export function focusRelations(nodes:AnalysisResult['nodes'],edges:readonly Edge[],selected:string){
  const chosen=edges.find(e=>e.edge_id===selected);
  const id=nodes.some(n=>n.node_id===selected)?selected:chosen?.source_node_id||nodes[0]?.node_id;
  const outgoing=edges.filter(e=>e.source_node_id===id&&e.kind!=='return');
  const main=outgoing.length?outgoing:edges.filter(e=>e.target_node_id===id&&e.kind!=='return');
  const returns=edges.filter(e=>e.kind==='return'&&(e.source_node_id===id||e.target_node_id===id));
  return {id,main:chosen?.kind==='return'?[chosen]:main,returns};
}
export function canShowSequence(nodes:AnalysisResult['nodes']){
  return nodes.every(n=>n.execution_context.kind!=='unknown'&&n.execution_context.status==='source_supported'&&!!n.execution_context.identity)&&new Set(nodes.map(n=>n.execution_context.identity)).size>1;
}
export function architectureOnlyDependencies(result:AnalysisResult,edges:readonly Edge[]){
  return edges.length>0&&!!result.architecture&&edges.every(e=>result.architecture!.edge_ids.includes(e.edge_id));
}
