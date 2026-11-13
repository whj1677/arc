import type {AnalysisResult} from '../shared';

// Reading copy cannot introduce files or objects outside its saved explanation.
export function validateReadingGuide(result:AnalysisResult):string[] {
  const g=result.reading_guide;if(!g)return [];
  const errors:string[]=[],evidence=new Map(result.evidence.map(e=>[e.evidence_id,e]));
  const nodes=new Set(result.nodes.map(n=>n.node_id));
  const ids=(items:readonly {id:string}[],label:string)=>{const set=new Set<string>();for(const item of items){if(set.has(item.id))errors.push(`阅读说明${label}重复：${item.id}`);set.add(item.id);}return set;};
  const steps=ids(g.steps,'步骤'),roles=ids(g.roles,'职责'),handoffs=ids(g.handoffs,'交接');ids(g.paths,'路径');
  const files=new Set(g.files.map(f=>f.path));if(files.size!==g.files.length)errors.push('阅读说明文件重复');
  const refs=(values:readonly string[],set:ReadonlySet<string>,label:string)=>{for(const value of values)if(!set.has(value))errors.push(`阅读说明${label}引用不存在：${value}`);};
  const evidenceIds=new Set(evidence.keys());
  for(const item of [...g.steps,...g.roles,...g.handoffs,...g.files]){
    if(!item.evidence_ids.length)errors.push('阅读说明缺少来源依据');
    refs(item.evidence_ids,evidenceIds,'依据');
  }
  for(const s of g.steps){refs(s.node_ids,nodes,'节点');if(!s.node_ids.length)errors.push(`阅读说明步骤缺少节点：${s.id}`);}
  for(const f of g.files){
    refs(f.step_ids,steps,'文件步骤');
    if(!f.evidence_ids.some(id=>evidence.get(id)?.path===f.path))errors.push(`阅读说明文件缺少本文件引用：${f.path}`);
  }
  for(const r of g.roles)refs(r.files,files,'职责文件');
  for(const h of g.handoffs)refs([h.from,h.to],roles,'交接端点');
  for(const p of g.paths){
    refs(p.step_ids,steps,'路径步骤');refs(p.failure_ids,steps,'停止分支');refs(p.role_ids,roles,'路径职责');refs(p.handoff_ids,handoffs,'路径交接');refs(p.files,files,'路径文件');
    if(!p.step_ids.length&&!p.lanes.length)errors.push(`阅读说明路径缺少步骤：${p.id}`);
    for(const lane of p.lanes){refs(lane.step_ids,steps,'时间线步骤');if(lane.link_labels.length!==lane.step_ids.length-1)errors.push(`阅读说明时间线连接数量不匹配：${lane.label}`);}
    for(const h of g.handoffs.filter(h=>p.handoff_ids.includes(h.id)))if(!p.role_ids.includes(h.from)||!p.role_ids.includes(h.to))errors.push(`阅读说明交接端点不在当前路径：${h.id}`);
  }
  return errors;
}
