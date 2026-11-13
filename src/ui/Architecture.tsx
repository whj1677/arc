import React,{useRef,useEffect,useState,useId} from 'react';
import type {AnalysisResult} from '../shared';
import {architectureMap} from './architecture-map';
import './architecture.css';
import './architecture-map.css';
interface Props {result:AnalysisResult;selected:string;select:(id:string)=>void;inspect:(id:string)=>void;modules:()=>void;zoom:number;search:string}
export function Architecture({result,selected,select,inspect,modules,zoom,search}:Props){
 const root=useRef<HTMLElement>(null),[width,setWidth]=useState(880),marker='arch-'+useId().replace(/:/g,'');
 const model=architectureMap(result,search);
 useEffect(()=>{if(!root.current)return;const observer=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width));observer.observe(root.current);return()=>observer.disconnect();},[result.result_id,model.nodes.length>0]);
 if(!result.architecture)return <div className="empty compact"><h2>系统协作尚未分析</h2><p>需要 Agent 明确系统组件和通信关系，不能按文件名猜测架构。</p><button onClick={modules}>查看已有模块说明</button></div>;
 if(!model.nodes.length)return <div className="empty compact"><h2>没有匹配组件</h2><p>清除搜索查看完整系统。</p></div>;
 const scale=Math.min(1,Math.max(360,width)/model.width)*zoom;
 const selectedPair=model.pairs.find(pair=>pair.some(e=>e.edge_id===selected));
 return <section ref={root} className="architecture-map" aria-label="系统协作导图">
  <header className="architecture-map-heading"><div><span className="eyebrow">SYSTEM MAP</span><h2>一张图，看清系统</h2></div><p>点组件看职责<br/>点连线看传递</p></header>
  <svg className="architecture-map-canvas" data-zoom-surface width={model.width*scale} height={model.height*scale} viewBox={`0 0 ${model.width} ${model.height}`} role="group" aria-label="系统架构图">
   <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto-start-reverse"><path d="M0 0 L7 3.5 L0 7" fill="context-stroke"/></marker></defs>
   {model.boundaries.map(b=><rect key={b.id} className="architecture-container" x={b.x} y={b.y} width={b.width} height={b.height} rx="24"><title>包含明确归属的内部模块</title></rect>)}
   {model.pairs.map(pair=>{
    const e=pair[0],a=model.boxes.get(e.source_node_id)!,b=model.boxes.get(e.target_node_id)!,vertical=Math.abs(a.x-b.x)<100;
    const forward=a.x<b.x,down=a.y<b.y,sx=vertical?a.x+a.width/2:forward?a.x+a.width:a.x,sy=vertical?(down?a.y+a.height:a.y):a.y+a.height/2,tx=vertical?b.x+b.width/2:forward?b.x:b.x+b.width,ty=vertical?(down?b.y:b.y+b.height):b.y+b.height/2;
    const self=e.source_node_id===e.target_node_id;
    const d=self?`M${sx} ${sy} C${sx+80} ${sy-95} ${sx-80} ${sy-95} ${sx} ${sy}`:vertical?`M${sx} ${sy} C${sx} ${(sy+ty)/2} ${tx} ${(sy+ty)/2} ${tx} ${ty}`:`M${sx} ${sy} C${(sx+tx)/2} ${sy} ${(sx+tx)/2} ${ty} ${tx} ${ty}`;
    const label=e.label.split(' · ')[0],short=label.length>15?label.slice(0,14)+'…':label,active=pair.some(e=>e.edge_id===selected),both=pair.some(v=>v.source_node_id===e.target_node_id&&v.target_node_id===e.source_node_id);
    const lx=vertical?sx+16:(sx+tx)/2,ly=vertical?(sy+ty)/2:(sy+ty)/2-12;
    const source=model.nodes.find(n=>n.node_id===e.source_node_id)!,target=model.nodes.find(n=>n.node_id===e.target_node_id)!;
    return <g key={e.edge_id} className={`architecture-link ${active?'selected':''} ${pair.some(e=>e.status!=='source_supported')?'uncertain':''}`} data-edge-id={e.edge_id} role="button" tabIndex={0} aria-label={`${source.label} → ${target.label}：${e.label}${pair.length>1?'，共 '+pair.length+' 条关系':''}`} onClick={()=>select(e.edge_id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(e.edge_id);}}}>
      <title>{pair.map(e=>e.label).join('\n')}</title><path className="architecture-link-hit" d={d}/><path className="architecture-link-line" d={d} markerEnd={`url(#${marker})`} markerStart={both?`url(#${marker})`:undefined}/>
      <text x={lx} y={ly} textAnchor={vertical?'start':'middle'} className="architecture-link-label">{short}{pair.length>1?' · '+pair.length:''}</text>
    </g>;
   })}
   {model.nodes.map(n=>{const b=model.boxes.get(n.node_id)!,parent=model.nodes.find(p=>p.node_id===n.parent_node_id);const parts=n.label.split(' · ');return <foreignObject key={n.node_id} x={b.x} y={b.y} width={b.width} height={b.height} data-component-id={n.node_id} data-zoom-anchor>
     <button className={`architecture-map-node architecture-node ${model.hub===n.node_id?'hub':''} ${parent?'internal':''} ${n.kind==='execution_boundary'?'external':''}`} aria-pressed={selected===n.node_id} onClick={()=>select(n.node_id)} title={n.description}><span className="architecture-node-dot" aria-hidden="true"/><strong>{parts[0]}</strong><small>{parts.slice(1).join(' · ')||'组件'}{parent&&!parts.slice(1).join('').includes('内部')?' · 内部模块':''}</small></button>
    </foreignObject>;})}
  </svg>
  <div className="architecture-map-footer"><span>↗ 箭头表示关系方向　·　边框表示所属模块</span><span>{model.nodes.length} 个组件 · {model.edges.length} 条关系</span></div>
  {selectedPair&&<div className="architecture-selected-links" aria-label="当前连线的关系"><span>查看这条连线</span>{selectedPair.map(e=><button key={e.edge_id} aria-pressed={selected===e.edge_id} onClick={()=>select(e.edge_id)}>{e.label}</button>)}</div>}
  {model.nodes.some(n=>n.node_id===selected&&result.nodes.some(child=>child.parent_node_id===n.node_id))&&<button className="architecture-deeper" onClick={()=>inspect(selected)}>展开所选组件的内部模块 →</button>}
  <p className="architecture-map-note">只画已分析的关系；布局不代表执行先后。完整说明在右侧。</p>
 </section>;
}
