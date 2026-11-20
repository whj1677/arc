import React from 'react';
import type { AnalysisResult, SourceEvidence } from '../shared';
import { componentContext, objectEvidence } from './architecture-context';
import { edgeNames } from './Graph';
import { edgeExplanation } from './presentation';
import { edgeSelection } from './reading-target';

type Node = AnalysisResult['nodes'][number];
type Edge = AnalysisResult['edges'][number];

interface Props {
  result: AnalysisResult;
  selected: string;
  select: (id: string) => void;
  inspect: (id: string) => void;
  openEvidence: (item: SourceEvidence) => void;
  openFeature: (id: string) => void;
}

function Sources({ items, open }: { items: SourceEvidence[]; open: Props['openEvidence'] }) {
  return <section className="system-sources">
    <h3>源码目录与文件</h3>
    {items.length ? <>
      <small>{new Set(items.map(e => e.path)).size} 个文件 · {items.length} 处依据</small>
      {items.map(e => <button className="module-partner" key={e.evidence_id} data-evidence-id={e.evidence_id} onClick={() => open(e)}>
        <strong>{e.path}</strong><small>L{e.line_start}{e.line_end !== e.line_start && '–' + e.line_end} · {e.note}</small>
      </button>)}
    </> : <p className="muted">当前说明未引用源码位置。</p>}
  </section>;
}

function IO({ title, items }: { title: string; items: Node['inputs'] }) {
  return <section><h3>{title}</h3>{items.length ? items.map(item =>
    <div className="step-io-item" key={item.io_id}><strong>{item.name}</strong>
      {item.description !== item.name && <p>{item.description}</p>}
    </div>) : <p className="muted">这份分析尚未说明。</p>}</section>;
}

export function SystemDetail({ result, selected, select, inspect, openEvidence, openFeature }: Props) {
  const node = result.nodes.find(n => n.node_id === selected);
  const edge = result.edges.find(e => edgeSelection(e.edge_id) === selected);
  const endpoint = (id: string) => result.nodes.find(n => n.node_id === id);
  const context = node && componentContext(node, result);
  const owner = node?.parent_node_id && endpoint(node.parent_node_id);
  const active = edge || node;
  const claims = result.claims.filter(c => active?.claim_ids.includes(c.claim_id));

  function relations(title: string, edges: Edge[], partnerId: (e: Edge) => string) {
    return <section className="module-partners"><h3>{title} · {edges.length}</h3>
      {edges.length ? edges.map(e =>
        <button className="module-partner" data-edge-id={e.edge_id} key={e.edge_id} onClick={() => select(edgeSelection(e.edge_id))}>
          <strong>{endpoint(partnerId(e))?.label}</strong>
          <span><small className="tag">{edgeNames[e.kind]}</small> {e.label}</span>
          {e.status !== 'source_supported' && <small className="warning">待核对</small>}
        </button>) : <p className="muted">当前说明未记录此方向的关系。</p>}
    </section>;
  }

  return <div className="system-detail step-detail">
    {edge ? <>
      <span className="tag">{edgeNames[edge.kind]}</span>
      {edge.status !== 'source_supported' && <small className="warning"> 待核对</small>}
      <h2>{edge.label}</h2>
      <div className="system-edge-endpoints">
        <button onClick={() => select(edge.source_node_id)}>{endpoint(edge.source_node_id)?.label}</button>
        <span aria-label="指向">↓</span>
        <button onClick={() => select(edge.target_node_id)}>{endpoint(edge.target_node_id)?.label}</button>
      </div>
      <p>{edgeExplanation(result, edge)}</p>
      <section className="module-transfers"><h3>明确传递的内容</h3>
        {edge.transfers?.length ? edge.transfers.map(t => <article key={t.source_output_id + '/' + t.target_input_id + '/' + t.label}>
          <strong>{t.label}</strong>
          <p>交出：{endpoint(edge.source_node_id)?.outputs.find(io => io.io_id === t.source_output_id)?.name}</p>
          <p>接收：{endpoint(edge.target_node_id)?.inputs.find(io => io.io_id === t.target_input_id)?.name}</p>
        </article>) : <p className="muted">具体输入输出的逐项对应尚未分析。</p>}
      </section>
      <Sources items={objectEvidence(edge, result)} open={openEvidence} />
    </> : node && context ? <>
      {owner ? <button className="quiet" onClick={() => select(owner.node_id)}>所属组件 · {owner.label}</button>
        : <span className="eyebrow">{result.architecture?.node_ids.includes(node.node_id) ? '系统组件' : '模块 / 支持工具'}</span>}
      <h2>{node.label}</h2>
      <section className="module-purpose"><h3>负责什么</h3><p>{node.description}</p></section>
      <Sources items={context.evidence} open={openEvidence} />
      {context.children.length > 0 && <section className="module-partners"><h3>内部子模块 · {context.children.length}</h3>
        {context.children.map(n => <button key={n.node_id} className="module-partner" onClick={() => select(n.node_id)}>{n.label}</button>)}
        <button className="step-next" onClick={() => inspect(node.node_id)}>展开内部模块 →</button>
      </section>}
      {context.features.length > 0 && <section className="module-partners"><h3>关联的业务功能 · {context.features.length}</h3>
        <small>依据同一快照中引用的相同文件或所在目录</small>
        {context.features.map(n => <button key={n.node_id} className="module-partner" onClick={() => openFeature(n.node_id)}>{n.label}</button>)}
      </section>}
      <div className="step-io-grid"><IO title="接收 / 读取" items={node.inputs} /><IO title="产出 / 提供" items={node.outputs} /></div>
      {relations('指向 / 调用', result.edges.filter(e => e.source_node_id === node.node_id), e => e.target_node_id)}
      {relations('来自 / 被调用', result.edges.filter(e => e.target_node_id === node.node_id), e => e.source_node_id)}
    </> : <><h2>选择一个组件或模块</h2><p>选择组件查看职责与来源，选择连线查看协作依据。</p></>}
    {claims.length > 0 && <details className="step-basis"><summary>判断依据与适用边界</summary>{claims.map(c =>
      <article key={c.claim_id}>{c.status !== 'source_supported' && <small className="warning">尚待核对</small>}
        <p>{c.statement}</p>{c.limitations.map((v, i) => <p key={i}>{v}</p>)}
      </article>)}</details>}
  </div>;
}
