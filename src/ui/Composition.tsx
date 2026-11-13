import React,{useLayoutEffect,useRef,useState} from 'react';
import type {AnalysisResult} from '../shared';
import {edgeCaption} from './flow-layout';
import {edgeNames} from './Graph';
import {architectureOnlyDependencies} from './graph-presentation';
import './composition.css';
interface Props {result:AnalysisResult;title:string;selected:string;select:(id:string)=>void;zoom:number;search:string;expanded:readonly string[];toggle:(id:string)=>void;architecture:()=>void;dependencies:()=>void;variant?:'system'|'analysis'|'modules'|'dependencies';focus?:string}
export function Composition({result,title,selected,select,zoom,search,expanded,toggle,architecture,dependencies,variant='system',focus}:Props){
 const ref=useRef<HTMLDivElement>(null),[lines,setLines]=useState<{id:string;d:string;color:string;relation:boolean}[]>([]);
 const colors=['#8dcbbb','#c0b0e8','#ddbf8f','#98bedb'];
 const links=variant==='dependencies'?result.edges.filter(e=>e.kind==='dependency'):['system','modules'].includes(variant)?[]:result.edges;
 const catalogNodes=new Set(result.feature_catalog?.groups.flatMap(g=>g.node_ids)||[]);
 const members=focus?[focus]:variant==='system'?result.architecture?.node_ids||[]:variant==='dependencies'?[...new Set(links.map(e=>e.source_node_id))]:result.nodes.filter(n=>!n.parent_node_id&&!n.source_scope&&!catalogNodes.has(n.node_id)).map(n=>n.node_id);
 const query=search.trim().toLowerCase();
 const matches=(id:string,seen=new Set<string>()):boolean=>{if(seen.has(id))return false;seen.add(id);const n=result.nodes.find(n=>n.node_id===id);return !!n&&(!query||`${n.label} ${n.description}`.toLowerCase().includes(query)||links.some(e=>e.source_node_id===id&&`${e.label} ${result.nodes.find(n=>n.node_id===e.target_node_id)?.label}`.toLowerCase().includes(query))||result.nodes.some(c=>c.parent_node_id===id&&matches(c.node_id,seen)));};
 const roots=members.filter(id=>matches(id));
 useLayoutEffect(()=>{
  const board=ref.current;if(!board)return;
  let frame=0;
  const measure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
   const box=board.getBoundingClientRect();
   const elements=[...board.querySelectorAll<HTMLElement>('[data-topic]')];
   const topic=(id:string)=>elements.find(e=>e.dataset.topic===id);
   const next:typeof lines=[];
   for(const el of elements){const parent=el.dataset.owner;if(!parent)continue;const from=topic(parent);if(!from)continue;const a=from.getBoundingClientRect(),b=el.getBoundingClientRect();
    if(!a.width||!a.height||!b.width||!b.height)continue;
    let d:string;
    if(b.top>=a.bottom+12){const x1=a.left+a.width/2-box.left,x2=b.left+b.width/2-box.left,y1=a.bottom-box.top,y2=b.top-box.top,m=(y1+y2)/2;d=`M${x1},${y1} C${x1},${m} ${x2},${m} ${x2},${y2}`;}
    else {const x1=a.right-box.left,x2=b.left-box.left,y1=a.top+a.height/2-box.top,y2=b.top+b.height/2-box.top,m=(x1+x2)/2;d=`M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`;}
    next.push({id:el.dataset.topic!,d,color:el.dataset.color||colors[0],relation:!!el.dataset.edgeId});
   }
   setLines(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
  });};
  const observer=new ResizeObserver(measure);observer.observe(board);for(const el of board.querySelectorAll('[data-topic]'))observer.observe(el);measure();
  return()=>{cancelAnimationFrame(frame);observer.disconnect();};
 },[result,zoom,search,expanded.join('|'),variant,focus]);
 if(variant==='system'&&!result.architecture)return <div className="empty compact"><h2>这份结果还没有组成导图</h2><p>需要 Agent 明确返回系统组件和模块归属；不能按目录名称猜出组成。</p><button onClick={architecture}>查看已有架构说明</button></div>;
 if(!roots.length)return <div className="empty compact"><h2>{variant==='dependencies'&&!query?'依赖关系尚未分析':'没有匹配主题'}</h2><p>{variant==='dependencies'&&!query?'未分析不代表没有依赖，需要 Agent 补充具体使用方、依赖项与用途。':'清除搜索，返回完整说明。'}</p></div>;
 const render=(id:string,color:string,owner:string,depth=0):React.ReactNode=>{
  const node=result.nodes.find(n=>n.node_id===id);if(!node)return null;
  const children=variant==='dependencies'?[]:result.nodes.filter(n=>n.parent_node_id===id&&matches(n.node_id));
  const outgoing=links.filter(e=>e.source_node_id===id),relationsOpen=!!query||expanded.includes('composition-links/'+id);
  const open=!!query||expanded.includes('composition/'+id);
  return <div className="composition-branch" key={id} style={{'--branch-color':color} as React.CSSProperties}>
   <div className="composition-topic-group"><button className={`composition-topic ${selected===id?'selected':''}`} data-topic={id} data-owner={owner} data-color={color} data-zoom-anchor onClick={()=>select(id)}><strong>{node.label}</strong></button><div className="composition-topic-actions">{children.length>0&&depth<10&&<button className="composition-fold" aria-expanded={open} aria-label={`${open?'收起':'展开'} ${node.label} 的模块`} onClick={()=>toggle('composition/'+id)}>{open?'−':`+${children.length}`}</button>}{outgoing.length>0&&<button className="composition-fold composition-relations-toggle" aria-expanded={relationsOpen} aria-label={`${relationsOpen?'收起':'展开'} ${node.label} 的${variant==='dependencies'?'依赖':'关系'}`} onClick={()=>toggle('composition-links/'+id)}>↗{outgoing.length}</button>}</div></div>
   {(children.length>0&&depth<10&&open||relationsOpen&&outgoing.length>0)&&<div className="composition-children">{open&&children.map(n=>render(n.node_id,color,id,depth+1))}{relationsOpen&&outgoing.map(e=>{const caption=edgeCaption(e);return <button key={e.edge_id} className={`composition-relation ${selected===e.edge_id?'selected':''} ${caption.data?'transfer':''}`} data-topic={'relation/'+e.edge_id} data-owner={id} data-edge-id={e.edge_id} data-color={color} data-zoom-anchor onClick={()=>select(e.edge_id)}><small>{caption.data?'数据传递':edgeNames[e.kind]}{caption.uncertain?' · 待确认':''}</small><strong>{caption.text}</strong><span>→ {result.nodes.find(n=>n.node_id===e.target_node_id)?.label}</span></button>;})}</div>}
  </div>;
 };
 const heading={system:'工程组成',analysis:'功能与问题导图',modules:'模块导图',dependencies:'依赖导图'}[variant];
 return <section className={`composition ${variant==='modules'?'module-map':''}`} style={{fontSize:16*zoom}} data-zoom-surface aria-label={variant==='system'?'工程组成导图':heading}>
  <div className="composition-intro"><h2>{heading}</h2><p>{variant==='modules'?'点模块在右侧看职责、输入输出和协作对象；＋展开子模块。':<>点击主题看职责，＋展开模块，↗展开{variant==='dependencies'?'依赖用途':'关联与传递'}。主题排列不表示先后。</>}</p></div>{variant==='dependencies'&&architectureOnlyDependencies(result,links)&&<p className="warning dependency-gap">本版本只有系统组件之间的依赖，内部模块和软件包尚未覆盖；不能把未分析当作没有依赖。</p>}
  <div className="composition-board" ref={ref}>
   <svg className="composition-connectors" aria-hidden="true">{lines.map(line=><path key={line.id} data-topic-link={line.id} data-link-kind={line.relation?'relation':'membership'} d={line.d} stroke={line.color} strokeDasharray={line.relation?'5 4':undefined}/>)}</svg>
   <div className="composition-layout"><div className="composition-root" data-topic="__project_index__" data-zoom-anchor><small>{variant==='system'?'当前工程':'当前说明 · 阅读索引'}</small><strong>{title}</strong></div><div className="composition-roots">{roots.map((id,index)=>render(id,colors[index%colors.length],'__project_index__'))}</div></div>
  </div>
  <div className="composition-navigation"><button onClick={architecture}>查看系统通信 →</button>{variant!=='dependencies'&&<button onClick={dependencies}>查看依赖用途 →</button>}</div>
  <p className="composition-boundary">中心是阅读索引。主题及模块归属来自当前说明；实线表示索引/归属，虚线只连接已分析关系，方向与传递请看标签。没有实际执行时间记录。</p>
 </section>;
}
