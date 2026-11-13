import type {AnalysisResult} from '../shared';

export type CallPath=NonNullable<AnalysisResult['function_walkthroughs']>[number];
export const callStepKey=(pathId:string,stepId:string)=>`call-step:${encodeURIComponent(pathId)}:${encodeURIComponent(stepId)}`;
export function selectedCallStep(result:AnalysisResult,key:string){
  for(const path of result.function_walkthroughs||[]){
    const index=path.steps.findIndex(step=>callStepKey(path.id,step.id)===key);
    if(index>=0)return {path,step:path.steps[index],index};
  }
  return undefined;
}

// Participants are unique functions. Time comes only from the explicit,
// source-reviewed walkthrough, never from the order of graph edges.
export function functionSequence(result:AnalysisResult,pathId:string){
  const path=result.function_walkthroughs?.find(p=>p.id===pathId)||result.function_walkthroughs?.[0];
  if(!path)return undefined;
  const ids=[...new Set([path.entry_node_id,...path.steps.flatMap(s=>[s.from_node_id,s.to_node_id].filter((id):id is string=>!!id))])];
  const participants=ids.flatMap(id=>{const node=result.nodes.find(n=>n.node_id===id&&n.kind==='function');return node?[node]:[];});
  return {path,participants};
}
