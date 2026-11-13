import type {AnalysisResult,ReadingState,ReadingTarget,Snapshot} from '../shared';
import {selectedCallStep} from './function-sequence-model';

export function readingQuestionTarget(result:AnalysisResult|undefined,reading:ReadingState,featureId:string,snapshot:Snapshot|undefined):{target:ReadingTarget;label:string}{
  const selection=reading.selected;
  if(reading.view==='files'||selection.startsWith('file:')){
    const path=selection.startsWith('file:')?selection.slice(5):reading.file;
    if(!path)return {target:{kind:'feature',id:featureId},label:'工程根目录与整体职责'};
    return {target:{kind:snapshot?.files.some(f=>f.path===path)?'file':'directory',id:path},label:path||'工程根目录'};
  }
  const split=selection.indexOf(':'),kind=selection.slice(0,split),key=selection.slice(split+1);
  if(result?.reading_guide){
    const guide=result.reading_guide;
    const item=kind==='step'?guide.steps.find(s=>s.id===key):kind==='role'?guide.roles.find(s=>s.id===key):kind==='handoff'?guide.handoffs.find(s=>s.id===key):undefined;
    if(item)return {target:{kind:kind as 'step'|'role'|'handoff',id:key},label:'title'in item?item.title:item.label};
  }
  const node=result?.nodes.find(n=>n.node_id===selection||(['step','role'].includes(kind)&&n.node_id===key));
  if(node)return {target:{kind:'node',id:node.node_id},label:node.label};
  const edge=result?.edges.find(e=>e.edge_id===selection||(kind==='handoff'&&e.edge_id===key));
  if(edge)return {target:{kind:'edge',id:edge.edge_id},label:edge.label};
  const functionStep=result?selectedCallStep(result,selection):undefined;
  if(functionStep)return {target:{kind:'call_step',id:selection},label:functionStep.step.text};
  return {target:{kind:'feature',id:featureId},label:'当前功能整体'};
}
