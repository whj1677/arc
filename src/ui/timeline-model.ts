import type {AnalysisResult} from '../shared';
type Edge=AnalysisResult['edges'][number];
// Only an unambiguous acyclic control-flow path can be drawn as a continuous
// business timeline. Calls, array positions and matching labels are insufficient.
export function timelineModel(result:AnalysisResult){
 const edges=result.edges.filter(e=>e.kind==='control_flow'&&e.status==='source_supported');
 const findPath=(edges:readonly Edge[])=>{
 const outgoing=(id:string)=>edges.filter(e=>e.source_node_id===id);
 const participating=result.nodes.filter(n=>edges.some(e=>e.source_node_id===n.node_id||e.target_node_id===n.node_id));
 const roots=participating.filter(n=>!edges.some(e=>e.target_node_id===n.node_id));
 let visits=0,exhausted=false;const paths:{ids:string[];links:Edge[]}[]=[];
 function visit(id:string,ids:string[],links:Edge[]){
  if(++visits>2000){exhausted=true;return;}
  if(ids.includes(id))return;
  const next=outgoing(id),path=[...ids,id];
  if(!next.length){paths.push({ids:path,links});return;}
  for(const e of next)visit(e.target_node_id,path,[...links,e]);
 }
 roots.forEach(n=>visit(n.node_id,[],[]));
 const longest=Math.max(0,...paths.map(p=>p.ids.length));
 const candidates=paths.filter(p=>p.ids.length===longest);
 return !exhausted&&roots.length===1&&candidates.length===1&&longest>=3?candidates[0]:null;
 };
 // Explicit I/O handoffs can disambiguate the reading path from an equally
 // long rejection branch. The control-flow evidence still provides direction.
 const declared=result.edges.some(e=>e.flow_role);
 const path=declared?findPath(edges.filter(e=>e.flow_role==='main')):findPath(edges.filter(e=>e.transfers?.length))||findPath(edges);
 const ids=path?.ids||result.nodes.filter(n=>result.edges.some(e=>e.source_node_id===n.node_id)).map(n=>n.node_id);
 const shown=ids.length?ids:result.nodes.map(n=>n.node_id);
 const omitted=result.nodes.filter(n=>!shown.includes(n.node_id)&&!result.edges.some(e=>shown.includes(e.source_node_id)&&e.target_node_id===n.node_id));
 return {ordered:!!path,ids:shown,links:path?.links||[],omitted,edgeCount:result.edges.length};
}
