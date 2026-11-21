import type {AnalysisResult} from '../shared';
import {functionSequence,callStepKey} from './function-sequence-model';
import {edgeSelection} from './reading-target';
import {functionChain,functionSource,functionFocus} from './function-chain';

const nodeWidth=236, nodeHeight=158, columnPitch=432, rowPitch=204;
export const callLabelWidth=164;
export const callLabelHeight=(expanded:boolean)=>expanded?80:62;
const labelSpacing=84;
const recursiveOffset=86;

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
  const boxes=new Map(nodes.map(n=>{const p=graph.positions.get(n.node_id)!;return [n.node_id,{x:20+columns.indexOf(p.x)*columnPitch,y:0,w:nodeWidth,h:nodeHeight}];}));
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
    edges.map(e=>({id:edgeSelection(e.edge_id),from:e.source_node_id,to:e.target_node_id,kind:e.kind==='execution_boundary'?'dispatch':'call',input:'传入内容待确认',condition:e.condition||'',label:e.label,...sourceLinks(e.source_node_id,e.target_node_id,e.evidence_ids||[],[e])}));
  const grouped=new Map<string,{path:string|null;nodes:typeof nodes}>();
  for(const n of nodes){const path=nodeSources.get(n.node_id)!.path,key=path===null?`unknown:${n.node_id}`:`file:${path}`;const group=grouped.get(key)||{path,nodes:[]};group.nodes.push(n);grouped.set(key,group);}
  const selfCalls=new Map<string,typeof links>();
  for(const link of links)if(link.from===link.to){
    const calls=selfCalls.get(link.from)||[];
    calls.push(link);
    selfCalls.set(link.from,calls);
  }
  let nextY=20;
  const fileGroups=[...grouped].map(([id,{path,nodes}])=>{
    const previousRows=new Map<number,number>();
    const top=nextY;
    // Keep first rows aligned and reserve loop space above recursive nodes.
    const maxSelfCalls=Math.max(0,...nodes.map(n=>selfCalls.get(n.node_id)?.length||0));
    const firstRow=top+(maxSelfCalls?180+(maxSelfCalls-1)*labelSpacing:50);
    for(const n of nodes){
      const box=boxes.get(n.node_id)!,previousY=previousRows.get(box.x);
      const count=selfCalls.get(n.node_id)?.length||0;
      const loopSpace=count?recursiveOffset+callLabelHeight(true)/2+(count-1)*labelSpacing+8:0;
      box.y=previousY===undefined?firstRow:previousY+Math.max(rowPitch,box.h+loopSpace);
      previousRows.set(box.x,box.y);
    }
    const bottom=Math.max(...nodes.map(n=>{const b=boxes.get(n.node_id)!;return b.y+b.h;}))+28;
    nextY=bottom+24;
    return {id,path,nodes,bounds:{x:8,y:top,w:0,h:bottom-top}};
  });
  const routes=new Map<string,ReturnType<typeof recursiveCallRoute>>();
  for(const calls of selfCalls.values()){
    calls.forEach((link,index)=>routes.set(link.id,recursiveCallRoute(boxes.get(link.from)!,index)));
  }
  const channels=new Map<number,{id:string;sx:number;sy:number;tx:number;ty:number;labelY:number}[]>();
  for(const link of links){
    if(link.from===link.to)continue;
    const a=boxes.get(link.from)!,b=boxes.get(link.to)!;
    const sx=a.x+a.w,sy=a.y+a.h/2,tx=b.x>a.x?b.x-4:b.x+b.w+4,ty=b.y+b.h/2;
    const channel=channels.get(sx)||[];
    channel.push({id:link.id,sx,sy,tx,ty,labelY:(sy+ty)/2});
    channels.set(sx,channel);
  }
  for(const [right,channel] of channels){
    // A call can skip columns. Its label stays in the first empty channel.
    const cx=right+(columnPitch-nodeWidth)/2;
    let nextLabelY=0;
    for(const {id,sx,sy,tx,ty,labelY} of channel.sort((a,b)=>a.labelY-b.labelY)){
      const cy=Math.max(labelY,nextLabelY);
      const d=`M${sx} ${sy} C${cx} ${sy} ${cx} ${cy} ${cx} ${cy} S${cx} ${ty} ${tx} ${ty}`;
      routes.set(id,{d,labelX:cx-callLabelWidth/2,labelY:cy});
      nextLabelY=cy+labelSpacing;
    }
  }
  const width=Math.max(660,...[...boxes.values()].map(b=>b.x+b.w+28),...[...routes.values()].map(route=>route.labelX+callLabelWidth+28));
  const height=Math.max(300,nextY,...[...routes.values()].map(route=>route.labelY+callLabelHeight(true)/2+20));
  for(const group of fileGroups)group.bounds.w=width-group.bounds.x*2;
  const focusedNode=links.find(link=>link.id===selectedId||link.edgeIds.some(id=>edgeSelection(id)===selectedId))?.to||selectedId||sequence?.path.entry_node_id||'';
  const focus=functionFocus(nodes,links,sequence?.path.entry_node_id,focusedNode);
  return {nodes,links,boxes,routes,entry:sequence?.path.entry_node_id,nodeSources,fileGroups,focus,width,height};
}

export type FunctionCallMap=ReturnType<typeof functionCallMap>;
export type FunctionCallLink=FunctionCallMap['links'][number];
export type FunctionFileGroup=FunctionCallMap['fileGroups'][number];

export function recursiveCallRoute(box:{x:number;y:number;w:number},index=0) {
  const cx=box.x+box.w/2;
  const controlY=box.y-(recursiveOffset+index*labelSpacing)*4/3;
  return {d:`M${cx+35} ${box.y} C${cx+110} ${controlY} ${cx-110} ${controlY} ${cx-35} ${box.y-4}`,labelX:cx-callLabelWidth/2,labelY:box.y-recursiveOffset-index*labelSpacing};
}
