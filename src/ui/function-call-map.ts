import type {AnalysisResult} from '../shared';
import {functionSequence,callStepKey} from './function-sequence-model';
import {functionChain,functionSource,functionFocus} from './function-chain';

export function functionCallMap(result:AnalysisResult,pathId:string,selectedId=''){
  // An obsolete selection must not silently switch to a different entry.
  const invalidPath=!!pathId&&!!result.function_walkthroughs?.length&&!result.function_walkthroughs.some(p=>p.id===pathId);
  const sequence=invalidPath?undefined:functionSequence(result,pathId);
  const steps=sequence?.path.steps.filter(s=>['call','callback','dispatch'].includes(s.kind))||[];
  const nodes=invalidPath?[]:sequence?.participants||result.nodes.filter(n=>n.kind==='function');
  const ids=new Set(nodes.map(n=>n.node_id));
  const edges=result.edges.filter(e=>['sync_call','execution_boundary'].includes(e.kind)&&ids.has(e.source_node_id)&&ids.has(e.target_node_id)&&(!sequence||steps.some(s=>s.from_node_id===e.source_node_id&&s.to_node_id===e.target_node_id&&(s.kind==='call'?e.kind==='sync_call':e.kind==='execution_boundary'))));
  const graph=functionChain({...result,nodes,edges},'',nodes.length);
  const columns=[...new Set([...graph.positions.values()].map(p=>p.x))].sort((a,b)=>a-b);
  const origin=nodes.length?Math.min(...[...graph.positions.values()].map(p=>p.y)):0;
  const boxes=new Map(nodes.map(n=>{const p=graph.positions.get(n.node_id)!;return [n.node_id,{x:20+columns.indexOf(p.x)*336,y:40+(p.y-origin)*1.6,w:190,h:140}];}));
  const nodeSources=new Map(nodes.map(n=>[n.node_id,functionSource(result,n)]));
  function sourceLinks(from:string,to:string,evidenceIds:readonly string[],matching:typeof edges){
    const caller=nodeSources.get(from),callee=nodeSources.get(to);
    return {edgeIds:matching.map(e=>e.edge_id),status:matching.length&&matching.every(e=>e.status==='source_supported')?'source_supported' as const:'unknown' as const,
      callerDefinition:caller?.definition,callerDeclaration:caller?.declaration,calleeDefinition:callee?.definition,calleeDeclaration:callee?.declaration,
      callsites:result.evidence.filter(e=>e.role==='callsite'&&evidenceIds.includes(e.evidence_id)),
      fileRelation:caller?.path&&callee?.path?(caller.path===callee.path?'same-file' as const:'cross-file' as const):'unknown' as const};
  }
  const links=sequence?steps.filter(s=>s.from_node_id&&ids.has(s.from_node_id)&&ids.has(s.to_node_id)).map(s=>({id:callStepKey(sequence.path.id,s.id),from:s.from_node_id!,to:s.to_node_id,kind:s.kind,input:s.input,condition:s.condition,label:s.text,
    ...sourceLinks(s.from_node_id!,s.to_node_id,s.evidence_ids,edges.filter(e=>e.source_node_id===s.from_node_id&&e.target_node_id===s.to_node_id&&e.kind===(s.kind==='call'?'sync_call':'execution_boundary')))})):
    edges.map(e=>({id:e.edge_id,from:e.source_node_id,to:e.target_node_id,kind:e.kind==='execution_boundary'?'dispatch':'call',input:'传入内容待确认',condition:e.condition||'',label:e.label,...sourceLinks(e.source_node_id,e.target_node_id,e.evidence_ids||[],[e])}));
  const grouped=new Map<string,{path:string|null;nodes:typeof nodes}>();
  for(const n of nodes){const path=nodeSources.get(n.node_id)!.path,key=path===null?`unknown:${n.node_id}`:`file:${path}`;const group=grouped.get(key)||{path,nodes:[]};group.nodes.push(n);grouped.set(key,group);}
  let nextY=20;
  const fileGroups=[...grouped].map(([id,{path,nodes}])=>{
    const rows=new Map<number,number>();
    const recursive=links.some(l=>l.from===l.to&&nodes.some(n=>n.node_id===l.from));
    const top=nextY,padding=recursive?180:50;
    for(const n of nodes){const box=boxes.get(n.node_id)!;const row=rows.get(box.x)||0;box.y=top+padding+row*180;rows.set(box.x,row+1);}
    const bottom=Math.max(...nodes.map(n=>{const b=boxes.get(n.node_id)!;return b.y+b.h;}))+20;
    nextY=bottom+24;
    return {id,path,nodes,bounds:{x:8,y:top,w:Math.max(644,columns.length*336-122),h:bottom-top}};
  });
  const focusedNode=links.find(link=>link.id===selectedId||link.edgeIds.includes(selectedId))?.to||selectedId||sequence?.path.entry_node_id||'';
  const focus=functionFocus(nodes,links,sequence?.path.entry_node_id,focusedNode);
  // A recursive call uses the space above its own node, away from the next
  // callee's parameter label. Reserve that space inside the SVG bounds.
  return {nodes,links,boxes,entry:sequence?.path.entry_node_id,nodeSources,fileGroups,focus,width:Math.max(660,columns.length*336-106),height:Math.max(300,...[...boxes.values()].map(b=>b.y+b.h+40))};
}

export type FunctionCallMap=ReturnType<typeof functionCallMap>;
export type FunctionCallLink=FunctionCallMap['links'][number];
export type FunctionFileGroup=FunctionCallMap['fileGroups'][number];

export function recursiveCallRoute(box:{x:number;y:number;w:number}) {
  const cx=box.x+box.w/2;
  return {d:`M${cx+35} ${box.y} C${cx+145} ${box.y-110} ${cx-145} ${box.y-110} ${cx-35} ${box.y-4}`,labelX:cx-66,labelY:box.y-126};
}
