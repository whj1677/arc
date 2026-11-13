import type {AnalysisResult} from '../shared';
import {functionSequence,callStepKey} from './function-sequence-model';
import {functionChain} from './function-chain';

export function functionCallMap(result:AnalysisResult,pathId:string){
  const sequence=functionSequence(result,pathId);
  const steps=sequence?.path.steps.filter(s=>['call','callback','dispatch'].includes(s.kind))||[];
  const nodes=sequence?.participants||result.nodes.filter(n=>n.kind==='function');
  const ids=new Set(nodes.map(n=>n.node_id));
  const edges=result.edges.filter(e=>['sync_call','execution_boundary'].includes(e.kind)&&ids.has(e.source_node_id)&&ids.has(e.target_node_id)&&(!sequence||steps.some(s=>s.from_node_id===e.source_node_id&&s.to_node_id===e.target_node_id&&(s.kind==='call'?e.kind==='sync_call':e.kind==='execution_boundary'))));
  const graph=functionChain({...result,nodes,edges},'',nodes.length);
  const columns=[...new Set([...graph.positions.values()].map(p=>p.x))].sort((a,b)=>a-b);
  const origin=nodes.length?Math.min(...[...graph.positions.values()].map(p=>p.y)):0;
  const boxes=new Map(nodes.map(n=>{const p=graph.positions.get(n.node_id)!;return [n.node_id,{x:20+columns.indexOf(p.x)*336,y:40+(p.y-origin)*1.6,w:190,h:140}];}));
  const links=sequence?steps.map(s=>({id:callStepKey(sequence.path.id,s.id),from:s.from_node_id!,to:s.to_node_id,kind:s.kind,input:s.input,condition:s.condition,label:s.text})):edges.map(e=>({id:e.edge_id,from:e.source_node_id,to:e.target_node_id,kind:e.kind==='execution_boundary'?'dispatch':'call',input:'传入内容待确认',condition:e.condition||'',label:e.label}));
  // A recursive call uses the space above its own node, away from the next
  // callee's parameter label. Reserve that space inside the SVG bounds.
  if(links.some(l=>l.from===l.to))for(const box of boxes.values())box.y+=140;
  return {nodes,links,boxes,entry:sequence?.path.entry_node_id,width:Math.max(660,columns.length*336-106),height:Math.max(300,...[...boxes.values()].map(b=>b.y+b.h+40))};
}

export function recursiveCallRoute(box:{x:number;y:number;w:number}) {
  const cx=box.x+box.w/2;
  return {d:`M${cx+35} ${box.y} C${cx+145} ${box.y-110} ${cx-145} ${box.y-110} ${cx-35} ${box.y-4}`,labelX:cx-66,labelY:box.y-126};
}
