import Ajv2020 from 'ajv/dist/2020';
import schema from '../../contracts/analysis-result.schema.json';
import type { AnalysisResult, Run, Snapshot, SourceEvidence } from '../shared';
import { readSource, relativePath } from './snapshot';
import {validateReadingGuide} from './reading-guide-validation';
import {validateFunctionWalkthroughs} from './function-walkthrough-validation';
const ajv = new Ajv2020({allErrors:true,strict:false});
const validate = ajv.compile(schema);
export { schema };
export async function validateResult(value: unknown, run: Run, snapshot: Snapshot, storage: string) {
  const errors: string[] = [];
  if (!validate(value)) return {structure:'failed',anchors:'not_run',semantic:'未进行语义审计',errors:(validate.errors||[]).map(e=>`${e.instancePath}: ${e.message}`).slice(0,50)};
  const result = value as unknown as AnalysisResult;
  for (const key of Object.keys(run.binding) as (keyof typeof run.binding)[]) if(result.binding[key]!==run.binding[key]) errors.push(`冻结绑定不匹配：${key}`);
  if(result.provider.provider_id!==run.provider_id || result.provider.connection_id!==`local-${run.provider_id}`) errors.push('Provider 身份/连接不匹配');
  if (run.provider_id !== 'demo' && result.fictional) errors.push('真实通道不能返回演示身份');
  const allIds = new Set<string>();
  const groups: Record<string,Map<string,any>> = {};
  for(const [key,list,idKey] of [
    ['node_ids',result.nodes,'node_id'],['edge_ids',result.edges,'edge_id'],['claim_ids',result.claims,'claim_id'],
    ['evidence_ids',result.evidence,'evidence_id'],['gap_ids',result.gaps,'gap_id'],
    ['io_ids',result.nodes.flatMap(n=>[...n.inputs,...n.outputs]),'io_id']
  ] as const) {
    const map = new Map<string,any>();
    for(const item of list) { const itemId=(item as any)[idKey]; if(allIds.has(itemId))errors.push(`重复 ID：${itemId}`);allIds.add(itemId);map.set(itemId,item); }
    groups[key]=map;
  }
  groups.related_node_ids=groups.node_ids;
  function refs(obj: any) {
    if(!obj||typeof obj!=='object')return;
    for(const [key,values] of Object.entries(obj)) {
      if(groups[key] && Array.isArray(values)) for(const v of values) if(!groups[key].has(v))errors.push(`缺失引用 ${key}: ${v}`);
      if(values&&typeof values==='object')refs(values);
    }
  }
  refs(result);
  errors.push(...validateReadingGuide(result));
  errors.push(...validateFunctionWalkthroughs(result));
  if(result.feature_catalog){
    const seen=new Set<string>();
    for(const group of result.feature_catalog.groups)for(const id of group.node_ids){
      const node=groups.node_ids.get(id);
      if(seen.has(id))errors.push(`功能目录重复节点：${id}`);seen.add(id);
      if(!node||node.kind!=='stage'||node.source_scope||result.architecture?.node_ids.includes(id))errors.push(`功能目录必须引用独立的业务功能节点：${id}`);
      if(!node?.evidence_ids.length||!node?.claim_ids.some((c:string)=>{const claim=groups.claim_ids.get(c);return claim?.status==='source_supported'&&claim.evidence_ids.length&&claim.targets.node_ids.includes(id);}))errors.push(`功能目录缺少对应功能的来源断言：${id}`);
    }
  }
  if(result.architecture) {
    const components=new Set(result.architecture.node_ids);
    for(const nodeId of components) {
      const node=groups.node_ids.get(nodeId);
      if(node&&!['stage','resource','execution_boundary'].includes(node.kind))errors.push(`架构组件不能引用内部函数或条件：${nodeId}`);
    }
    for(const edgeId of result.architecture.edge_ids) {
      const edge=groups.edge_ids.get(edgeId);
      if(edge&&(!components.has(edge.source_node_id)||!components.has(edge.target_node_id)))errors.push(`架构关系端点必须属于架构组件：${edgeId}`);
    }
  }
  for(const node of result.nodes) {
    if(node.function_details){
      const info=node.function_details,definition=groups.evidence_ids.get(info.definition_evidence_id);
      if(node.kind!=='function')errors.push(`函数详情只能用于函数节点：${node.node_id}`);
      if(!definition||!node.evidence_ids.includes(info.definition_evidence_id)||!['definition','declaration'].includes(definition.role)||definition.symbol_id!==info.symbol)errors.push(`函数定义依据与符号不匹配：${node.node_id}`);
      if(!node.claim_ids.some(id=>{const c=groups.claim_ids.get(id);return c?.status==='source_supported'&&c.targets.node_ids.includes(node.node_id)&&c.evidence_ids.includes(info.definition_evidence_id);}))errors.push(`函数定义缺对应来源断言：${node.node_id}`);
      for(const [ids,items,label]of [[info.parameter_io_ids,node.inputs,'参数'],[info.return_io_ids,node.outputs,'返回值']] as const){
        for(const ioId of ids||[])if(!items.some(io=>io.io_id===ioId))errors.push(`函数${label}引用不属于本节点：${node.node_id}/${ioId}`);
      }
    }
    if(node.source_scope){
      const scope=node.source_scope;
      try{relativePath(scope.path);if(node.kind!=='resource')throw new Error('文件用途必须是 resource 节点');
        if(!snapshot.files.some(f=>scope.kind==='file'?f.path===scope.path:f.path.startsWith(scope.path+'/')))throw new Error('范围不在冻结快照中');
        const supports=(id:string)=>{const e=groups.evidence_ids.get(id);return e&&(scope.kind==='file'?e.path===scope.path:e.path.startsWith(scope.path+'/'));};
        if(node.claim_ids.some(id=>groups.claim_ids.get(id)?.status==='source_supported')&&(!node.evidence_ids.some(supports)||!node.claim_ids.some(id=>{const c=groups.claim_ids.get(id);return c?.status==='source_supported'&&c.targets.node_ids.includes(node.node_id)&&c.evidence_ids.some(supports);})))throw new Error('文件用途缺对应范围的来源断言');
      }catch(e){errors.push(`${node.node_id}: 文件用途范围错误：${(e as Error).message}`);}
    }
    const ancestors=new Set([node.node_id]); let parent=node.parent_node_id;
    while(parent) { if(ancestors.has(parent)){errors.push(`父子循环：${node.node_id}`);break;} ancestors.add(parent);const p=groups.node_ids.get(parent);if(!p){errors.push(`父节点不存在：${parent}`);break;}parent=p.parent_node_id; }
    if(node.execution_context.status==='source_supported'&&!node.execution_context.claim_ids.some(c=>groups.claim_ids.get(c)?.status==='source_supported')) errors.push(`执行上下文缺依据断言：${node.node_id}`);
  }
  const mainEdges=result.edges.filter(e=>e.flow_role==='main');
  if(mainEdges.length){
    const sources=new Set(mainEdges.map(e=>e.source_node_id)),targets=new Set(mainEdges.map(e=>e.target_node_id));
    const roots=[...sources].filter(id=>!targets.has(id));
    let visited=0,current=roots[0];const seen=new Set<string>();
    while(current&&!seen.has(current)){seen.add(current);const next=mainEdges.find(e=>e.source_node_id===current);if(!next)break;visited++;current=next.target_node_id;}
    if(sources.size!==mainEdges.length||targets.size!==mainEdges.length||roots.length!==1||visited!==mainEdges.length)errors.push('主线必须是一条无分叉、无循环且连续的路径');
  }
  for(const edge of result.edges) {
    if(edge.flow_role&&edge.kind!=='control_flow')errors.push(`业务关系角色只能用于 control_flow：${edge.edge_id}`);
    if(!groups.node_ids.has(edge.source_node_id)||!groups.node_ids.has(edge.target_node_id))errors.push(`关系端点不存在：${edge.edge_id}`);
    if(edge.status==='source_supported'&&!edge.claim_ids.some(c=>groups.claim_ids.get(c)?.status==='source_supported'&&groups.claim_ids.get(c).evidence_ids.length))errors.push(`关系缺来源断言：${edge.edge_id}`);
    if(edge.related_call_edge_id) { const call=groups.edge_ids.get(edge.related_call_edge_id); if(edge.kind!=='return'||call?.kind!=='sync_call'||call.source_node_id!==edge.target_node_id||call.target_node_id!==edge.source_node_id)errors.push(`调用/返回配对错误：${edge.edge_id}`); }
    for(const transfer of edge.transfers||[]){
      const source=groups.node_ids.get(edge.source_node_id),target=groups.node_ids.get(edge.target_node_id);
      if(!source?.outputs.some((io:any)=>io.io_id===transfer.source_output_id))errors.push(`传递输出不属于关系源节点：${edge.edge_id}`);
      if(!target?.inputs.some((io:any)=>io.io_id===transfer.target_input_id))errors.push(`传递输入不属于关系目标节点：${edge.edge_id}`);
      if(transfer.status==='source_supported'&&(!transfer.evidence_ids.length||!transfer.claim_ids.some(id=>{
        const claim=groups.claim_ids.get(id);return claim?.status==='source_supported'&&claim.evidence_ids.length&&claim.targets.edge_ids.includes(edge.edge_id)&&claim.targets.io_ids.includes(transfer.source_output_id)&&claim.targets.io_ids.includes(transfer.target_input_id);
      })))errors.push(`传递映射缺少对应关系及输入输出的来源断言：${edge.edge_id}`);
    }
  }
  errors.push(...await validateEvidence(result.evidence,snapshot,storage));
  return {structure:'passed',anchors:errors.length?'failed':'passed',semantic:'待核对：引用位置已检查，结论是否由该片段支持尚未人工确认',errors};
}
export async function validateEvidence(evidenceList:readonly SourceEvidence[],snapshot:Snapshot,storage:string) {
  const errors:string[]=[],cache=new Map<string,any>();
  for(const evidence of evidenceList) {
    try {
      relativePath(evidence.path);
      if(evidence.source_snapshot_id!==snapshot.source_snapshot_id)throw new Error('快照身份错误');
      let file=cache.get(evidence.path);if(!file){file=await readSource(storage,snapshot,evidence.path);cache.set(evidence.path,file);}
      if(file.content_sha256!==evidence.content_sha256)throw new Error('完整文件哈希错误');
      if(!Number.isInteger(evidence.line_start)||!Number.isInteger(evidence.line_end)||evidence.line_start<1||evidence.line_end<evidence.line_start||evidence.line_end>file.line_count)throw new Error('行范围错误');
    }catch(e){errors.push(`${evidence.evidence_id}: ${(e as Error).message}`);}
  }
  return errors;
}
// Codex's constrained output subset has no if/then and requires every property.
// Optional contract properties become nullable in the transport view, then nulls
// on optional properties are removed before complete Arc validation.
export function transportSchema(base:object=schema) {
  const copy=structuredClone(base) as any;
  // Codex's schema subset has no if/then. Preserve this execution-context
  // invariant with explicit alternatives instead of dropping it on transport.
  const context=copy.$defs?.execution_context;
  if(context){
    const unknown=structuredClone(context),supported=structuredClone(context),other=structuredClone(context);
    unknown.properties.kind.enum=['unknown'];unknown.properties.identity={type:'null'};unknown.properties.status.enum=['unknown'];
    for(const variant of [supported,other])variant.properties.kind.enum=variant.properties.kind.enum.filter((kind:string)=>kind!=='unknown');
    supported.properties.status.enum=['source_supported'];supported.properties.claim_ids.minItems=1;
    other.properties.status.enum=other.properties.status.enum.filter((status:string)=>status!=='source_supported');
    copy.$defs.execution_context={anyOf:[unknown,supported,other]};
  }
  function visit(s:any) {
    if(!s||typeof s!=='object')return;
    delete s.allOf; delete s.uniqueItems; delete s.$comment; delete s.pattern;
    // The response-format subset rejects annotations beside $ref. Keep the
    // canonical contract intact; this description is transport-only metadata.
    if(s.$ref)delete s.description;
    if(Object.hasOwn(s,'const')){s.enum=[s.const];delete s.const;}
    if(s.enum&&!s.type){
      const types=[...new Set(s.enum.map((v:any)=>v===null?'null':typeof v))];
      s.type=types.length===1?types[0]:types;
    }
    if(s.properties) {
      const required=new Set(s.required||[]);
      for(const [key,value]of Object.entries(s.properties))if(!required.has(key))s.properties[key]={anyOf:[value,{type:'null'}]};
      s.required=Object.keys(s.properties);s.additionalProperties=false;
    }
    Object.values(s).forEach(v=>{if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);});
  }
  visit(copy);return copy;
}
export function normalizeTransport(value:any,audit:string[]=[] ) {
  const optional=new Set(['function_walkthroughs','reading_guide','function_details','flow_role','feature_catalog','source_scope','architecture','transfers','parent_node_id','execution_episode_id','related_call_edge_id','condition','symbol_id','runtime_version','external_provider_id','external_session_id','external_thread_id','external_task_id','external_run_id']);
  const referenceSets=new Set(['node_ids','edge_ids','io_ids','claim_ids','evidence_ids','related_node_ids']);
  function visit(v:any,where=''){if(!v||typeof v!=='object')return;for(const k of Object.keys(v)){
    if(v[k]===null&&optional.has(k)){delete v[k];audit.push(`${where}/${k}: removed optional null`);}
    else if(referenceSets.has(k)&&Array.isArray(v[k])&&v[k].every((x:unknown)=>typeof x==='string')){
      const unique=[...new Set(v[k])];if(unique.length!==v[k].length){v[k]=unique;audit.push(`${where}/${k}: removed identical duplicate references (no definitions or evidence added)`);}
    }else visit(v[k],`${where}/${k}`);
  }}
  visit(value);return value;
}
