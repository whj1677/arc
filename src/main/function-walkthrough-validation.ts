import type {AnalysisResult} from '../shared';

export function validateFunctionWalkthroughs(result:AnalysisResult){
  const errors:string[]=[],paths=new Set<string>(),functions=new Set(result.nodes.filter(n=>n.kind==='function').map(n=>n.node_id)),evidence=new Set(result.evidence.map(e=>e.evidence_id));
  for(const path of result.function_walkthroughs||[]){
    if(paths.has(path.id))errors.push(`调用路径 ID 重复：${path.id}`);paths.add(path.id);
    if(!functions.has(path.entry_node_id))errors.push(`调用路径入口不是本结果的函数：${path.id}`);
    if(path.steps[0]?.kind!=='entry'||path.steps[0]?.to_node_id!==path.entry_node_id)errors.push(`调用路径必须从声明的入口开始：${path.id}`);
    const ids=new Set<string>(),priorCalls=new Set<string>();
    for(const step of path.steps){
      if(ids.has(step.id))errors.push(`调用步骤 ID 重复：${path.id}/${step.id}`);ids.add(step.id);
      if(!functions.has(step.to_node_id)||(step.from_node_id!==null&&!functions.has(step.from_node_id)))errors.push(`调用步骤引用了其他结果或非函数节点：${path.id}/${step.id}`);
      if(!step.evidence_ids.length||step.evidence_ids.some(id=>!evidence.has(id)))errors.push(`调用步骤缺少本结果依据：${path.id}/${step.id}`);
      if(['call','callback','dispatch'].includes(step.kind)){
        const kinds=step.kind==='call'?['sync_call']:['execution_boundary'];
        if(!result.edges.some(e=>kinds.includes(e.kind)&&e.source_node_id===step.from_node_id&&e.target_node_id===step.to_node_id&&e.status==='source_supported'))errors.push(`调用步骤缺少对应来源关系：${path.id}/${step.id}`);
        priorCalls.add(`${step.from_node_id}/${step.to_node_id}`);
      }
      if(step.kind==='return'&&!priorCalls.has(`${step.to_node_id}/${step.from_node_id}`))errors.push(`返回步骤缺少先前调用：${path.id}/${step.id}`);
      if(step.kind==='work'&&step.from_node_id!==step.to_node_id)errors.push(`函数内部处理不能冒充跨函数调用：${path.id}/${step.id}`);
    }
  }
  return errors;
}
