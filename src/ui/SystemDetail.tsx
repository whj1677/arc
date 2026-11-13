import React from 'react';
import type {AnalysisResult} from '../shared';
import {edgeExplanation} from './presentation';
import {edgeNames} from './Graph';
export function SystemDetail({result,selected,select,inspect}:{result:AnalysisResult;selected:string;select:(id:string)=>void;inspect:(id:string)=>void}){
 const node=result.nodes.find(n=>n.node_id===selected),edge=result.edges.find(e=>e.edge_id===selected);
 const endpoint=(id:string)=>result.nodes.find(n=>n.node_id===id);
 const io=(items:AnalysisResult['nodes'][number]['inputs'])=>items.length?items.map(item=><div className="step-io-item" key={item.io_id}><strong>{item.name}</strong>{item.description!==item.name&&<p>{item.description}</p>}</div>):<p className="muted">这份分析尚未说明。</p>;
 const owner=node?.parent_node_id&&endpoint(node.parent_node_id);
 const relations=node?result.edges.filter(e=>e.source_node_id===node.node_id||e.target_node_id===node.node_id):[];
 const related=(e:AnalysisResult['edges'][number])=><button className="module-partner" data-edge-id={e.edge_id} key={e.edge_id} onClick={()=>select(e.edge_id)}><small>{e.source_node_id===node?.node_id?'指向':'来自'} · {edgeNames[e.kind]}</small><strong>{endpoint(e.source_node_id===node?.node_id?e.target_node_id:e.source_node_id)?.label}</strong><span>{e.label}</span>{e.status!=='source_supported'&&<small className="warning">待核对</small>}</button>;
 const active=edge||node,claims=result.claims.filter(c=>active?.claim_ids.includes(c.claim_id));
 return <div className="system-detail step-detail">
  {edge?<><span className="eyebrow">{edgeNames[edge.kind]}{edge.status!=='source_supported'?' · 待核对':''}</span><h2>{edge.label}</h2><p>{edgeExplanation(result,edge)}</p><div className="system-edge-endpoints"><button onClick={()=>select(edge.source_node_id)}>{endpoint(edge.source_node_id)?.label}</button><span>↓</span><button onClick={()=>select(edge.target_node_id)}>{endpoint(edge.target_node_id)?.label}</button></div>
    {edge.transfers?.length?<section className="module-transfers"><h3>明确传递的内容</h3>{edge.transfers.map((t,i)=><article key={i}><strong>{t.label}</strong><p>交出：{endpoint(edge.source_node_id)?.outputs.find(io=>io.io_id===t.source_output_id)?.name}</p><p>接收：{endpoint(edge.target_node_id)?.inputs.find(io=>io.io_id===t.target_input_id)?.name}</p></article>)}</section>:<p className="muted">已说明双方关系；具体输入输出的逐项对应尚未分析。</p>}
  </>:node?<><span className="eyebrow">{owner?`属于 ${owner.label.split(' · ')[0]}`:result.architecture?.node_ids.includes(node.node_id)?'系统组件':'模块 / 支持工具'}</span><h2>{node.label}</h2><section className="module-purpose"><h3>负责什么</h3><p>{node.description}</p></section><div className="step-io-grid"><section className="module-inputs"><h3>接收 / 读取</h3>{io(node.inputs)}</section><section className="module-outputs"><h3>产出 / 提供</h3>{io(node.outputs)}</section></div>
   <section className="module-partners"><h3>跟谁协作 · {relations.length}</h3>{relations.length?relations.map(related):<p className="muted">协作对象尚未覆盖，不代表这个模块没有依赖。</p>}</section>
   {result.nodes.some(n=>n.parent_node_id===node.node_id)&&<button className="step-next" onClick={()=>inspect(node.node_id)}>展开内部模块 →</button>}
  </>:<><h2>选择一个组件或模块</h2><p>查看它负责什么、接收和产出什么，以及已经分析的协作对象。</p></>}
  {claims.length>0&&<details className="step-basis"><summary>判断依据与适用边界</summary>{claims.map(c=><article key={c.claim_id}>{c.status!=='source_supported'&&<small className="warning">尚待核对</small>}<p>{c.statement}</p>{c.limitations.map((v,i)=><p key={i}>{v}</p>)}</article>)}</details>}
 </div>;
}
