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

/** Only presentation references can be omitted. Nodes, edges, claims, evidence
 * and the run binding stay intact for a second full source validation. */
export function partialFunctionReading(result:AnalysisResult){
  if(!result.function_walkthroughs?.length)return;
  const kinds=new Map(result.nodes.map(node=>[node.node_id,node.kind]));
  const omissions:string[]=[];
  const paths=result.function_walkthroughs.map(path=>{
    const skipped=path.steps.filter(step=>step.kind==='work'&&step.from_node_id!==null&&
      kinds.get(step.from_node_id)==='function'&&kinds.get(step.to_node_id)==='stage');
    if(!skipped.length)return path;
    const labels=skipped.map(step=>`第 ${path.steps.indexOf(step)+1} 步`).join('、');
    const note=`${path.label}的原文${labels}指向业务阶段，未列入函数图。`;
    omissions.push(note);
    return {...path,steps:path.steps.filter(step=>!skipped.includes(step)),boundary:path.boundary+' '+note};
  });
  // A reading that lost all substantive function steps is not a recovery.
  if(!paths.some(path=>path.steps.some(step=>['call','callback','dispatch'].includes(step.kind))))return;
  let guide=result.reading_guide;
  if(guide){
    const files=new Set(guide.files.map(file=>file.path));
    const steps=new Set(guide.steps.map(step=>step.id));
    const roles=guide.roles.map(role=>{
      const missing=role.files.filter(file=>!files.has(file));
      if(!missing.length)return role;
      omissions.push(`「${role.title}」未登记的文件链接：${missing.join('、')}。`);
      return {...role,files:role.files.filter(file=>files.has(file))};
    });
    const guidePaths=guide.paths.map(path=>{
      const missing=path.failure_ids.filter(id=>!steps.has(id));
      if(!missing.length)return path;
      const note=`「${path.label}」的停止分支尚未关联到阅读步骤（${missing.join('、')}）。`;
      omissions.push(note);
      return {...path,failure_ids:path.failure_ids.filter(id=>steps.has(id)),boundary:path.boundary+' '+note};
    });
    guide={...guide,roles,paths:guidePaths};
  }
  const candidate={...result,function_walkthroughs:paths,reading_guide:guide};
  const catalog=result.feature_catalog;
  const catalogIds=catalog?.groups.flatMap(group=>group.node_ids)??[];
  if(!catalog?.readings?.length&&catalogIds.length&&catalogIds.every(id=>result.architecture?.node_ids.includes(id))){
    delete candidate.feature_catalog;
    omissions.push('原文把架构组件重复列为功能，本次未采用这份附加目录。');
  }
  if(!omissions.length)return;
  return {result:{...candidate,coverage:{...result.coverage,unresolved_scope:[...result.coverage.unresolved_scope,...omissions]}},omissions};
}
