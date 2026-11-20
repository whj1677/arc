import type {AnalysisResult, Explanation, Feature} from './shared';

// A refreshed explanation can retain the exact same source-bound catalog.
// Match its original evidence, never an editable feature name or a node ID alone.
export function discoveredFeature(features:Feature[], explanations:Explanation[], result:AnalysisResult, nodeId:string, currentSnapshot:string):Feature|undefined {
  const exact=features.find(f=>f.project_id===result.binding.project_id&&f.discovery?.result_id===result.result_id&&f.discovery.node_id===nodeId);
  if(exact)return exact;
  const signature=(value:AnalysisResult,hash=true)=>{
    const node=value.nodes.find(n=>n.node_id===nodeId);
    if(!node||!value.feature_catalog?.groups.some(g=>g.node_ids.includes(nodeId)))return '';
    const refs=node.evidence_ids.map(id=>value.evidence.find(e=>e.evidence_id===id));
    if(!refs.length||refs.some(e=>!e))return '';
    return JSON.stringify([node.kind,node.label,node.description,refs.map(e=>[e!.path,e!.line_start,e!.line_end,...(hash?[e!.content_sha256]:[])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  };
  const key=signature(result);
  return features.find(feature=>{
    const origin=feature.discovery;
    if(feature.project_id!==result.binding.project_id||origin?.node_id!==nodeId)return false;
    if(!key||result.binding.source_snapshot_id!==currentSnapshot)return false;
    const previous=explanations.find(e=>e.result_id===origin.result_id)?.result;
    if(!previous||previous.binding.project_id!==result.binding.project_id||previous.binding.scenario_id!==result.binding.scenario_id||previous.binding.source_snapshot_id!==origin.source_snapshot_id)return false;
    // A source edit invalidates the saved explanation, not the identity of an
    // unchanged catalog entry. Across snapshots compare the same anchor location;
    // within one snapshot retain the stronger full-content identity check.
    return previous.binding.source_snapshot_id===currentSnapshot?signature(previous)===key:signature(previous,false)===signature(result,false);
  });
}
