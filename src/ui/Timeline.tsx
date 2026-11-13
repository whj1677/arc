import React from 'react';
import type {AnalysisResult} from '../shared';
import {timelineModel} from './timeline-model';
import {edgeCaption} from './flow-layout';
import {edgeNames} from './Graph';
export function Timeline({result,selected,select,zoom,search}:{result:AnalysisResult;selected:string;select:(id:string)=>void;zoom:number;search:string}){
 const model=timelineModel(result),query=search.trim().toLowerCase();
 const matches=(id:string)=>{const n=result.nodes.find(n=>n.node_id===id);return !query||`${n?.label} ${n?.description}`.toLowerCase().includes(query);};
 const ids=model.ids.filter(matches);
 const remaining=result.edges.filter(e=>!model.ids.includes(e.source_node_id));
 if(!ids.length)return <div className="empty compact"><h2>没有匹配步骤</h2><p>清除搜索，查看完整流程。</p></div>;
 if(model.ordered)return <section className="business-timeline ordered journey" data-zoom-surface style={{fontSize:16*zoom}} aria-label="流程时间线">
  <div className="journey-heading"><h2>业务主线 <small>{model.ids.length} 步</small></h2><p>从上往下读；点一步，看输入、产出和异常处理。</p></div>
  <div className="timeline-stages">{ids.map(id=>{
   const n=result.nodes.find(n=>n.node_id===id)!,index=model.ids.indexOf(id),next=model.links[index];
   const branches=result.edges.filter(e=>e.source_node_id===id&&e.edge_id!==next?.edge_id),caption=next&&edgeCaption(next);
   const active=selected===id||result.edges.some(e=>e.edge_id===selected&&e.source_node_id===id);
   return <article key={id} className={`timeline-stage ${active?'active':''}`} data-node-id={id} data-zoom-anchor>
    <div className="journey-row"><button className="timeline-step" onClick={()=>select(id)} aria-pressed={active}><span className="timeline-number">{String(index+1).padStart(2,'0')}</span><strong>{n.label}</strong><span aria-hidden="true">›</span></button>{branches.length>0&&<button className="journey-exceptions" aria-label={`查看${n.label}的其他去向`} onClick={()=>select(branches[0].edge_id)}>其他去向 {branches.length} ↗</button>}</div>
    {next&&caption&&<div className="timeline-handoff"><button className={`timeline-transfer ${selected===next.edge_id?'selected':''}`} data-edge-id={next.edge_id} onClick={()=>select(next.edge_id)}><span>{caption.data?'传递':'接下来'}</span><strong>{caption.text}</strong><span aria-hidden="true">↓</span></button></div>}
   </article>;
  })}</div>
  <p className="journey-end">主线到这里 · 分支和失败处理随步骤查看</p>
  {(model.omitted.length>0||remaining.length>0)&&<details className="timeline-other"><summary>主线之外的内容</summary>{model.omitted.map(n=><button key={n.node_id} onClick={()=>select(n.node_id)}>{n.label}</button>)}{remaining.map(e=><button key={e.edge_id} data-edge-id={e.edge_id} onClick={()=>select(e.edge_id)}>{e.label}</button>)}</details>}
 </section>;
 return <section className={`business-timeline ${model.ordered?'ordered':'independent'}`} data-zoom-surface style={{fontSize:16*zoom}} aria-label="流程时间线">
  <div className="timeline-intro"><span className="eyebrow">{model.ordered?'点步骤看职责 · 点传递看内容 · 其他去向按需展开':'按起点查看已分析的关系'}</span>{!model.ordered&&<p>本结果不足以确认一条完整先后路径。以下每组独立展示真实调用或分支，不把列表顺序当作执行顺序。</p>}</div>
  <div className="timeline-stages">{ids.map(id=>{
   const n=result.nodes.find(n=>n.node_id===id)!,index=model.ids.indexOf(id),next=model.links[index];
   const branches=result.edges.filter(e=>e.source_node_id===id&&e.edge_id!==next?.edge_id);
   const caption=next&&edgeCaption(next);
   return <article key={id} className={`timeline-stage ${selected===id?'selected':''}`} data-node-id={id} data-zoom-anchor>
    <button className="timeline-step" onClick={()=>select(id)} aria-pressed={selected===id}><span className="timeline-number">{model.ordered?String(index+1).padStart(2,'0'):'◇'}</span><span><strong>{n.label}</strong><span className="timeline-description">{n.description.match(/^.*?[。！？]/)?.[0]||n.description}</span></span><span aria-hidden="true">›</span></button>
    {branches.length>0&&<details className="timeline-branches" open={branches.some(e=>e.edge_id===selected)||undefined} aria-label={`${n.label}的其他去向`}><summary>其他去向 · {branches.length}</summary><div className="timeline-branch-items">{branches.map(e=><button key={e.edge_id} className={`timeline-branch ${selected===e.edge_id?'selected':''}`} data-edge-id={e.edge_id} onClick={()=>select(e.edge_id)}><span>{e.kind==='return'?'返回':model.ordered?'另一去向':edgeNames[e.kind]}{e.status!=='source_supported'?' · 待确认':''}</span><strong>{e.label}</strong><small>→ {result.nodes.find(n=>n.node_id===e.target_node_id)?.label}</small></button>)}</div></details>}
    {next&&caption&&<div className="timeline-handoff"><span className="timeline-down" aria-hidden="true">↓</span><button className={`timeline-transfer ${caption.data?'transfer':''} ${selected===next.edge_id?'selected':''}`} data-edge-id={next.edge_id} onClick={()=>select(next.edge_id)}><span>{caption.data?'传递':'继续条件'}</span><strong>{caption.text}</strong><small>→ {result.nodes.find(n=>n.node_id===next.target_node_id)?.label}</small></button></div>}
   </article>;
  })}</div>
  {model.omitted.length>0&&<details className="timeline-other"><summary>其他已分析节点 · {model.omitted.length}</summary>{model.omitted.map(n=><button key={n.node_id} onClick={()=>select(n.node_id)}>{n.label}</button>)}</details>}
  {remaining.length>0&&<details className="timeline-other"><summary>其他已分析关系 · {remaining.length}</summary>{remaining.map(e=><button key={e.edge_id} data-edge-id={e.edge_id} onClick={()=>select(e.edge_id)}>{result.nodes.find(n=>n.node_id===e.source_node_id)?.label} → {result.nodes.find(n=>n.node_id===e.target_node_id)?.label}：{e.label}</button>)}</details>}
  <p className="timeline-boundary">静态分析的业务关系，不是现场执行记录，也不表示实际耗时。全部 {model.edgeCount} 条关系均保留。</p>
 </section>;
}
