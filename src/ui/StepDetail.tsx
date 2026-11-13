import React from 'react';
import type {AnalysisResult} from '../shared';
import {timelineModel} from './timeline-model';
import {edgeExplanation} from './presentation';

// Present only the bound result. Missing I/O or recovery information stays missing.
export function StepDetail({result,selected,select}:{result:AnalysisResult;selected:string;select:(id:string)=>void}){
 const model=timelineModel(result),edge=result.edges.find(e=>e.edge_id===selected);
 const node=result.nodes.find(n=>n.node_id===(edge?.source_node_id||selected));
 if(!node)return <p>选择左边的一步，查看需要什么、产出什么和其他去向。</p>;
 const index=model.ids.indexOf(node.node_id),next=model.links[index];
 const branches=result.edges.filter(e=>e.source_node_id===node.node_id&&e.edge_id!==next?.edge_id);
 const io=(items:typeof node.inputs)=>items.length?items.map(item=><div className="step-io-item" key={item.io_id}><strong>{item.name}</strong>{item.description!==item.name&&<p>{item.description}</p>}</div>):<p className="muted">当前分析没有说明，不能据此判断没有。</p>;
 const claims=result.claims.filter(c=>(edge||node).claim_ids.includes(c.claim_id));
 return <div className="step-detail">
  <div className="step-detail-heading"><span className="eyebrow">{index>=0?`步骤 ${index+1} / ${model.ids.length}`:'关联步骤'}</span><h2>{node.label}</h2></div>
  {edge?<article className={`step-edge ${edge.transfers?.length?'transfer-pair':'branch-explanation'}`} data-edge-id={edge.edge_id}>
   <span className="eyebrow">{edge.flow_role==='exception'?(edge.transfers?.length?'异常时返回什么':'异常去向'):edge.flow_role==='alternative'&&!edge.transfers?.length?'其他条件去向':edge.transfers?.length?'这次交接传什么':model.links.some(e=>e.edge_id===edge.edge_id)?'继续条件 / 顺序':'其他去向 / 异常'}{edge.status!=='source_supported'?' · 推断，待核对':''}</span><h3>{edge.label}</h3><p>{edgeExplanation(result,edge)}</p>
   {edge.transfers?.map((t,i)=>{const source=node.outputs.find(io=>io.io_id===t.source_output_id),target=result.nodes.find(n=>n.node_id===edge.target_node_id)?.inputs.find(io=>io.io_id===t.target_input_id);return <div className="step-transfer" key={i}><strong>{t.label}</strong><dl><dt>上一步交出</dt><dd>{source?.name||'未说明'}</dd><dt>下一步接收</dt><dd>{target?.name||'未说明'}</dd></dl></div>;})}
   <button className="quiet" onClick={()=>select(edge.target_node_id)}>去向：{result.nodes.find(n=>n.node_id===edge.target_node_id)?.label} →</button><button className="quiet" onClick={()=>select(node.node_id)}>返回这一步的完整说明</button>
   {branches.some(e=>e.edge_id!==edge.edge_id)&&<details className="related-branches" open><summary>这一步的其他去向</summary>{branches.filter(e=>e.edge_id!==edge.edge_id).map(e=><button key={e.edge_id} className="quiet" data-edge-id={e.edge_id} onClick={()=>select(e.edge_id)}>{e.label}{e.status!=='source_supported'?' · 待核对':''}</button>)}</details>}
  </article>:<>
   <p className="step-purpose">{node.description}</p>
   <div className="step-io-grid"><section className="step-inputs"><h3>需要什么</h3>{io(node.inputs)}</section>
   <section className="step-outputs"><h3>可能返回什么</h3>{io(node.outputs)}{next&&<button className="step-next" data-edge-id={next.edge_id} onClick={()=>select(next.edge_id)}>交给「{result.nodes.find(n=>n.node_id===next.target_node_id)?.label}」 →</button>}</section></div>
   <section className="step-failures"><h3>失败或出现其他情况</h3>{branches.length?branches.map(e=><article key={e.edge_id} data-edge-id={e.edge_id}><button className="failure-link" onClick={()=>select(e.edge_id)}>{e.label}<span> ↗</span></button>{e.status!=='source_supported'&&<small className="warning">推断，尚未实测</small>}<p>{edgeExplanation(result,e)}</p></article>):<p className="muted">这一步尚未建立异常去向关系；返回内容中可能已有错误说明，不代表不会失败。</p>}</section>
  </>}
  {claims.length>0&&<details className="step-basis"><summary>判断依据与适用边界</summary>{claims.map(c=><article key={c.claim_id}>{c.status!=='source_supported'&&<small className="warning">尚待核对</small>}<p>{c.statement}</p>{c.limitations.map((l,i)=><p key={i}>{l}</p>)}</article>)}</details>}
 </div>;
}
