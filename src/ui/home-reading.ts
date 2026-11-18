import type {AnalysisResult,Explanation,Project,Scenario} from '../shared';

export function savedBusinessPath(project:Project,scenarios:readonly Scenario[],explanations:readonly Explanation[]){
  const available=scenarios.filter(s=>s.project_id===project.project_id&&!s.archived&&s.scenario_id!==project.overview_scenario_id);
  for(const scene of available){
    const saved=explanations.findLast(e=>e.scenario_id===scene.scenario_id&&e.result.binding.project_id===project.project_id);
    if(!saved||saved.result.binding.source_snapshot_id!==project.snapshot_id||saved.result.binding.question_revision_id!==scene.question_revision_id)continue;
    const guide=saved.result.reading_guide;
    if(!guide)continue;
    const supported=(id:string)=>saved.result.evidence.some(e=>e.evidence_id===id&&e.source_snapshot_id===project.snapshot_id);
    for(const path of guide.paths){
      const first=guide.steps.find(s=>s.id===path.step_ids[0]);
      const last=guide.steps.find(s=>s.id===path.step_ids.at(-1));
      if(first&&last&&path.entry.trim()&&first.evidence_ids.some(supported)&&last.evidence_ids.some(supported)){
        return {saved,path,first,last};
      }
    }
  }
}

export function componentReading(result?:AnalysisResult){
  if(!result?.architecture)return;
  const refs=new Set(result.evidence.filter(e=>e.source_snapshot_id===result.binding.source_snapshot_id).map(e=>e.evidence_id));
  const usable=(ids:readonly string[])=>ids.some(id=>refs.has(id));
  const capabilities=new Set(result.feature_catalog?.groups.flatMap(group=>group.node_ids));
  const featureRefs=new Set(result.nodes.filter(n=>capabilities.has(n.node_id)).flatMap(n=>n.evidence_ids));
  const members=new Set(result.architecture.node_ids);
  const edges=result.edges.filter(e=>result.architecture!.edge_ids.includes(e.edge_id)&&members.has(e.source_node_id)&&members.has(e.target_node_id)&&e.status==='source_supported'&&usable(e.evidence_ids));
  const choices=result.nodes.filter(n=>members.has(n.node_id)&&usable(n.evidence_ids)).map(node=>{
    const inputs=node.inputs.filter(io=>io.availability!=='unknown'&&usable(io.evidence_ids));
    const outputs=node.outputs.filter(io=>io.availability!=='unknown'&&usable(io.evidence_ids));
    const sharesFeatureSource=node.evidence_ids.some(id=>featureRefs.has(id));
    return {node,inputs,outputs,sharesFeatureSource};
  });
  // Prefer a component with a documented input and result. Within that group,
  // a shared feature reference makes a better starting point than array order.
  const priority=(item:typeof choices[number])=>[Number(!!item.inputs.length&&!!item.outputs.length),Number(item.sharesFeatureSource),Number(!!item.outputs.length),Number(!!item.inputs.length)];
  choices.sort((a,b)=>{const left=priority(a),right=priority(b);for(let i=0;i<left.length;i++)if(left[i]!==right[i])return right[i]-left[i];return 0;});
  const focus=choices[0];
  if(!focus)return;
  const edge=edges.find(e=>e.target_node_id===focus.node.node_id&&e.source_node_id!==e.target_node_id)??edges.find(e=>e.source_node_id===focus.node.node_id&&e.source_node_id!==e.target_node_id);
  const source=result.evidence.find(e=>focus.node.evidence_ids.includes(e.evidence_id)&&refs.has(e.evidence_id))!;
  return {...focus,source,edge,from:edge&&result.nodes.find(n=>n.node_id===edge.source_node_id),to:edge&&result.nodes.find(n=>n.node_id===edge.target_node_id)};
}
