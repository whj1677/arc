import React from 'react';
import type {AnalysisResult} from '../shared';
import {edgeCaption} from './flow-layout';
import {edgeNames} from './Graph';

export function RelationRows({result,edges,selected,select,zoom,label}:{result:AnalysisResult;edges:AnalysisResult['edges'];selected:string;select:(id:string)=>void;zoom:number;label:string}){
  const height=edges.length*118+12;
  return <svg className="relation-diagram" data-zoom-surface width={650*zoom} height={height*zoom} viewBox={`0 0 650 ${height}`} role="group" aria-label={label}>
    <defs><marker id="row-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L7,4 L0,8" fill="#acd0ff"/></marker></defs>
    {edges.map((edge,i)=>{
      const a=result.nodes.find(n=>n.node_id===edge.source_node_id),b=result.nodes.find(n=>n.node_id===edge.target_node_id),caption=edgeCaption(edge),y=12+i*118;
      if(!a||!b)return null;
      return <g key={edge.edge_id}>
        <path className={`wire-line ${edge.kind}`} d={`M220,${y+40} H426`} markerEnd="url(#row-arrow)"/>
        {[{node:a,x:12,role:'使用方 / 起点'},{node:b,x:434,role:'依赖项 / 终点'}].map(({node,x,role})=><foreignObject key={x} x={x} y={y} width="200" height="80"><button className={`graph-node ${selected===node.node_id?'selected':''}`} onClick={()=>select(node.node_id)}><span className="node-meta">{edge.kind==='dependency'?role:x===12?'起点':'终点'}</span><strong title={node.label}>{node.label}</strong></button></foreignObject>)}
        <foreignObject x="230" y={y+8} width="190" height="64"><button data-edge-id={edge.edge_id} data-label-kind={caption.data?'transfer':'relation'} className={`edge-label row-label ${caption.data?'transfer':''} ${selected===edge.edge_id?'selected':''}`} aria-label={`${caption.data?'传递内容':'关系'}：${caption.text}`} title={caption.text} onClick={()=>select(edge.edge_id)}><small>{edgeNames[edge.kind]}{caption.uncertain?' · 待确认':''}</small><span>{caption.text}</span></button></foreignObject>
      </g>;
    })}
  </svg>;
}
