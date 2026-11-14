import type {AnalysisResult} from '../shared';

// A call graph is never inferred from the order of business steps. Condense
// recursive components before assigning columns so recursion cannot loop layout.
export function functionChain(result:AnalysisResult,search='',limit=80){
  const all=result.nodes.filter(n=>n.kind==='function');
  const matched=all.filter(n=>!search||`${n.label} ${n.description} ${n.function_details?.symbol||''}`.toLowerCase().includes(search.toLowerCase()));
  const nodes=matched.slice(0,limit),ids=new Set(nodes.map(n=>n.node_id));
  const edges=result.edges.filter(e=>['sync_call','execution_boundary'].includes(e.kind)&&ids.has(e.source_node_id)&&ids.has(e.target_node_id));
  const adjacency=new Map(nodes.map(n=>[n.node_id,edges.filter(e=>e.source_node_id===n.node_id).map(e=>e.target_node_id)]));
  const indices=new Map<string,number>(),low=new Map<string,number>(),stack:string[]=[],active=new Set<string>(),components:string[][]=[];
  function visit(id:string){
    indices.set(id,indices.size);low.set(id,indices.get(id)!);stack.push(id);active.add(id);
    for(const to of adjacency.get(id)||[]){if(!indices.has(to)){visit(to);low.set(id,Math.min(low.get(id)!,low.get(to)!));}else if(active.has(to))low.set(id,Math.min(low.get(id)!,indices.get(to)!));}
    if(low.get(id)===indices.get(id)){const group:string[]=[];let next:string;do{next=stack.pop()!;active.delete(next);group.push(next);}while(next!==id);components.push(group);}
  }
  for(const n of nodes)if(!indices.has(n.node_id))visit(n.node_id);
  const group=new Map(components.flatMap((c,i)=>c.map(id=>[id,i] as const))),rank=new Map<number,number>();
  function column(i:number):number{if(rank.has(i))return rank.get(i)!;const parents=edges.filter(e=>group.get(e.target_node_id)===i&&group.get(e.source_node_id)!==i).map(e=>group.get(e.source_node_id)!);const value=parents.length?Math.max(...parents.map(p=>column(p)+1)):0;rank.set(i,value);return value;}
  components.forEach((_,i)=>column(i));
  const columns=new Map<number,string[]>();for(const n of nodes){const c=rank.get(group.get(n.node_id)!)!;columns.set(c,[...(columns.get(c)||[]),n.node_id]);}
  const rows=Math.max(1,...[...columns.values()].map(v=>v.length));
  const jumps=edges.filter(e=>Math.abs(rank.get(group.get(e.target_node_id)!)!-rank.get(group.get(e.source_node_id)!)!)>1).map(e=>e.edge_id);
  const positions=new Map<string,{x:number;y:number}>();
  for(const [c,list]of columns)list.forEach((id,r)=>positions.set(id,{x:110+c*220,y:65+jumps.length*18+(rows-list.length)*55+r*110}));
  return {nodes,edges,positions,jumps,width:Math.max(530,columns.size*220),height:Math.max(300,rows*110+80+jumps.length*18),total:all.length,matched:matched.length,truncated:matched.length>nodes.length};
}

export function functionInfo(result:AnalysisResult,node:AnalysisResult['nodes'][number]){
  const details=node.function_details,definition=details?result.evidence.find(e=>e.evidence_id===details.definition_evidence_id):undefined;
  return {details,definition,parameters:details?.parameter_io_ids==null?null:node.inputs.filter(io=>details.parameter_io_ids!.includes(io.io_id)),
    returns:details?.return_io_ids==null?null:node.outputs.filter(io=>details.return_io_ids!.includes(io.io_id)),
    otherOutputs:details?.return_io_ids==null?node.outputs:node.outputs.filter(io=>!details.return_io_ids!.includes(io.io_id))};
}

// Only an explicit function reference establishes a file or a definition.
// Declarations remain navigable but never stand in for an implementation.
export function functionSource(result:AnalysisResult,node:AnalysisResult['nodes'][number]){
  const reference=node.function_details?result.evidence.find(e=>e.evidence_id===node.function_details!.definition_evidence_id):undefined;
  const definition=reference?.role==='definition'?reference:undefined;
  const declaration=reference?.role==='declaration'?reference:undefined;
  return {definition,declaration,path:definition?.path||declaration?.path||null};
}

// A representative shortest route through recorded relations, not a runtime trace.
// Visited sets bound both traversal and recursion; other possible routes remain valid.
export function functionFocus(nodes:readonly {node_id:string}[],links:readonly {from:string;to:string}[],entry:string|undefined,selected:string){
  const ids=new Set(nodes.map(n=>n.node_id));
  const valid=links.filter(l=>ids.has(l.from)&&ids.has(l.to));
  function reachable(start:string,reverse=false){
    const seen=new Set<string>(),queue=ids.has(start)?[start]:[];
    for(let i=0;i<queue.length;i++){
      const current=queue[i];if(seen.has(current))continue;seen.add(current);
      for(const link of valid)if((reverse?link.to:link.from)===current&&!seen.has(reverse?link.from:link.to))queue.push(reverse?link.from:link.to);
    }
    seen.delete(start);return [...seen];
  }
  const previous=new Map<string,string|null>();
  const queue=entry&&ids.has(entry)?[entry]:[];if(queue.length)previous.set(queue[0],null);
  for(let i=0;i<queue.length&&!previous.has(selected);i++)for(const l of valid)if(l.from===queue[i]&&!previous.has(l.to)){previous.set(l.to,l.from);queue.push(l.to);}
  const entryPath:string[]=[];
  if(previous.has(selected)){let cursor:string|null=selected;while(cursor!==null){entryPath.unshift(cursor);cursor=previous.get(cursor)??null;}}
  return {selected,entryPath,upstream:reachable(selected,true),downstream:reachable(selected),reachable:entryPath.length>0,pathKind:entryPath.length?'representative' as const:'unknown' as const};
}
