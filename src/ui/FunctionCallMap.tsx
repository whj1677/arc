import React,{useId} from 'react';
import type {AnalysisResult} from '../shared';
import {functionCallMap,recursiveCallRoute} from './function-call-map';
import {functionInfo} from './function-chain';
import {Diagram,shortLabel} from './ReadingDiagrams';

export function FunctionCallMap({result,pathId,selected,select,search,zoom}:{result:AnalysisResult;pathId:string;selected:string;select:(id:string)=>void;search:string;zoom:number}){
  const m=functionCallMap(result,pathId),marker='function-map-'+useId().replace(/:/g,''),query=search.toLowerCase();
  if(!m.nodes.length)return <p className="fr-empty">这版分析尚未提供函数入口与调用依据。</p>;
  return <><div className="diagram-caption"><strong>从入口沿箭头走 →</strong><span>连线标传入内容 · 点函数看职责与输入输出</span></div><Diagram key={result.result_id+pathId} width={m.width} height={m.height} zoom={zoom} label="函数调用链与传入参数"><defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="context-stroke"/></marker></defs>
    {m.links.map((link,i)=>{const a=m.boxes.get(link.from),b=m.boxes.get(link.to);if(!a||!b)return null;const self=link.from===link.to,forward=b.x>a.x,sx=a.x+a.w,sy=a.y+a.h/2,tx=forward?b.x:b.x+b.w,ty=b.y+b.h/2;
      const recursive=self?recursiveCallRoute(a):null;
      const d=recursive?recursive.d:forward?`M${sx} ${sy} C${(sx+tx)/2} ${sy} ${(sx+tx)/2} ${ty} ${tx-4} ${ty}`:`M${sx} ${sy} C${sx+55+i*12} ${sy} ${tx+55+i*12} ${ty} ${tx+4} ${ty}`;
      const lx=recursive?recursive.labelX:forward?(sx+tx)/2-66:sx+8,ly=recursive?recursive.labelY:(sy+ty)/2-40;
      return <g key={link.id} className={`function-map-link ${link.kind} ${selected===link.id?'selected':''}`} data-function-call={link.id} role="button" tabIndex={0} aria-label={link.label+'，传入：'+link.input} onClick={()=>select(link.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(link.id);}}}><title>{link.label+'\n传入：'+link.input+(link.condition?'\n条件：'+link.condition:'')}</title><path className="diagram-hit" d={d}/><path className="diagram-link" d={d} markerEnd={`url(#${marker})`}/><foreignObject x={lx} y={ly} width="132" height="82"><div className="function-map-args"><small>{link.kind==='call'?'传入':link.kind==='callback'?'回调内传入':'异步派发'}{link.condition?' · 条件':''}</small><span>{shortLabel(link.input,34)}</span></div></foreignObject></g>;
    })}
    {m.nodes.map(n=>{const b=m.boxes.get(n.node_id)!,info=functionInfo(result,n),symbol=info.details?.symbol||n.label;return <foreignObject key={n.node_id} data-function-node={n.node_id} data-zoom-anchor x={b.x} y={b.y} width={b.w} height={b.h}><button className={`function-map-node ${selected===n.node_id?'selected':''} ${query&&![symbol,n.description,info.definition?.path].join(' ').toLowerCase().includes(query)?'diagram-dim':''}`} onClick={()=>select(n.node_id)} title={symbol+'\n'+n.description}><small>{m.entry===n.node_id?'● 入口函数':symbol.includes('.')?symbol.split('.').slice(0,-1).join('.'):'函数'}</small><strong>{symbol.split('.').at(-1)}</strong><span>{shortLabel(n.description,19)}</span><small>{info.definition?info.definition.path.split('/').at(-1)+':'+info.definition.line_start+'–'+info.definition.line_end:'定义位置待确认'}</small></button></foreignObject>;})}
  </Diagram>{!m.entry&&<p className="muted">这版仅记录了调用关系，工程入口尚未确认。</p>}</>;
}
