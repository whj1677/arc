import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AnalysisResult } from '../shared';
import { architectureMap } from './architecture-map';
import { componentContext } from './architecture-context';
import { CodeModules } from './CodeModules';
import { edgeNames } from './Graph';
import { edgeSelection } from './reading-target';

interface Props {
  result: AnalysisResult;
  selected: string;
  select: (id: string) => void;
  inspect: (id: string) => void;
  modules: () => void;
  openFile?: (path: string) => void;
  zoom: number;
  search: string;
}
type Node = AnalysisResult['nodes'][number];

const kindNames: Record<Node['kind'], string> = {
  stage: '控制/业务', resource: '资源/存储', execution_boundary: '执行边界', function: '函数', decision: '条件判断',
};

function CardContent({ node, context, degree }: { node: Node; context: ReturnType<typeof componentContext>; degree: number }) {
  return <>
    <span className="architecture-card-meta">
      <span className={'architecture-kind kind-' + node.kind}>{kindNames[node.kind]}</span>
      <span className="architecture-degree">{degree} 条关系</span>
      {context.children.length > 0 ? <span>{context.children.length} 个子模块</span>
        : context.features.length > 0 && <span>{context.features.length} 项功能</span>}
    </span>
    <strong className="architecture-card-title">{node.label}</strong>
    <span className="architecture-card-copy">{node.description}</span>
    {context.files.length > 0 && <span className="architecture-card-files" title={context.files.join('\n')}>
      <code>{context.files[0]}</code>{context.files.length > 1 && <span>+{context.files.length - 1}</span>}
    </span>}
    {([['输入', node.inputs], ['输出', node.outputs]] as const).map(([label, items]) => {
      if (!items.length) return null;
      return <span className="architecture-card-io" key={label}>
        <span>{label} {items.length}</span><span>{items[0].name}</span>
      </span>;
    })}
  </>;
}

export function Architecture({ result, selected, select, inspect, modules, openFile, zoom, search }: Props) {
  const root = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(820);
  const [view, setView] = useState<'layers' | 'code'>('layers');
  const [hover, setHover] = useState('');
  const marker = 'arch-' + useId().replace(/:/g, '');
  const columns = Math.max(1, Math.min(3, Math.floor(width / 316)));
  const model = useMemo(() => architectureMap(result, search, columns), [result, search, columns]);
  const contexts = useMemo(() => new Map(model.nodes.map(node => [node.node_id, componentContext(node, result)])), [model.nodes, result]);
  const byId = useMemo(() => new Map(model.nodes.map(node => [node.node_id, node])), [model.nodes]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);

  const scale = Math.max(0.9, Math.min(1, (width - 4) / model.width)) * zoom;
  const activeEdges = model.edges.filter(edge => [edge.source_node_id, edge.target_node_id, edgeSelection(edge.edge_id)].includes(hover));
  const activeNodes = new Set([hover, ...activeEdges.flatMap(edge => [edge.source_node_id, edge.target_node_id])]);
  const focusedLink = model.links.find(({ edge }) => edgeSelection(edge.edge_id) === (hover || selected));
  const labelWidth = Math.min(220, model.width - 12);
  const chooseView = (next: typeof view) => { setView(next); setHover(''); };

  return <section ref={root} className="architecture-map" aria-label="系统协作导图">
    <header className="architecture-map-heading">
      <div className="architecture-view-switch" role="group" aria-label="架构视图">
        <button aria-pressed={view === 'layers'} onClick={() => chooseView('layers')}>架构分层视图</button>
        <button aria-pressed={view === 'code'} onClick={() => chooseView('code')}>代码模块依赖（静态索引）</button>
      </div>
      {view === 'layers' && <span className="architecture-map-stat">{model.nodes.length} 个组件 · {model.edges.length} 条关系</span>}
    </header>
    {view === 'code' ? <div data-zoom-surface style={{ zoom }}>
        <CodeModules key={result.binding.source_snapshot_id} snapshotId={result.binding.source_snapshot_id} openFile={openFile} search={search} />
      </div>
      : !result.architecture ? <div className="empty compact">
          <h2>系统协作尚未分析</h2><button onClick={modules}>查看已有模块说明</button>
        </div>
      : !model.nodes.length ? <div className="empty compact"><h2>没有匹配组件</h2><p>清除搜索查看完整系统。</p></div>
      : <>
        <div className="architecture-viewport" tabIndex={0} role="region" aria-label="系统架构图，可横向滚动">
          <svg className="architecture-map-canvas" data-zoom-surface width={model.width * scale} height={model.height * scale}
            viewBox={`0 0 ${model.width} ${model.height}`} role="group" aria-label="系统架构图">
            <defs><marker id={marker} markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
              <path d="M0 0 L6 3 L0 6 Z" fill="context-stroke" />
            </marker></defs>
            {model.layers.map(layer => <g key={layer.id} className={'architecture-layer tier-' + layer.id}>
              <rect x={layer.x} y={layer.y} width={layer.width} height={layer.height} rx="7" />
              <text x={layer.x + 15} y={layer.y + 27}>{layer.title} <tspan> / {layer.roots.length}</tspan></text>
            </g>)}
            {model.boundaries.map(b => <rect key={b.id} className="architecture-container" x={b.x} y={b.y} width={b.width} height={b.height} rx="8">
              <title>{byId.get(b.id)?.label}及内部模块</title>
            </rect>)}
            {model.links.map(({ edge, points }) => {
              const id = edgeSelection(edge.edge_id);
              const d = 'M' + points.map(p => p.join(' ')).join(' L');
              const state = hover ? (activeEdges.includes(edge) ? ' hovered' : ' dimmed') : '';
              const label = `${byId.get(edge.source_node_id)!.label} → ${byId.get(edge.target_node_id)!.label}：${edge.label}`;
              return <g key={id} className={'architecture-link' + state + (selected === id ? ' selected' : '') + (edge.status === 'source_supported' ? '' : ' uncertain')}
                data-edge-id={edge.edge_id} role="button" tabIndex={0} aria-label={label} aria-pressed={selected === id}
                onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover('')} onFocus={() => setHover(id)} onBlur={() => setHover('')}
                onClick={() => select(id)} onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(id); }
                }}>
                <title>{label}</title>
                <path className="architecture-link-hit" d={d} />
                <path className="architecture-link-line" d={d} markerEnd={`url(#${marker})`} />
              </g>;
            })}
            {model.nodes.map(node => {
              const box = model.boxes.get(node.node_id)!;
              return <foreignObject key={node.node_id} {...box} data-component-id={node.node_id} data-zoom-anchor
                className={hover && !activeNodes.has(node.node_id) ? 'architecture-node-dimmed' : undefined}>
                <button className="architecture-card architecture-node" aria-pressed={selected === node.node_id}
                  onMouseEnter={() => setHover(node.node_id)} onMouseLeave={() => setHover('')}
                  onFocus={() => setHover(node.node_id)} onBlur={() => setHover('')} onClick={() => select(node.node_id)}>
                  <CardContent node={node} context={contexts.get(node.node_id)!} degree={model.degrees.get(node.node_id) ?? 0} />
                </button>
              </foreignObject>;
            })}
            {focusedLink && <foreignObject className="architecture-edge-caption" aria-hidden="true" width={labelWidth} height="30"
              x={Math.max(6, Math.min(model.width - labelWidth - 6, focusedLink.points[1][0] - labelWidth))}
              y={Math.max(4, focusedLink.points[1][1] - 32)}>
              <span>{focusedLink.edge.label}</span>
            </foreignObject>}
          </svg>
        </div>
        <div className="architecture-map-footer">
          <span>箭头表示协作方向，虚线框标明内部模块的归属。</span>
          {contexts.get(selected)?.children.length ? <button onClick={() => inspect(selected)}>展开所选组件的内部模块</button> : null}
        </div>
        <section className="architecture-relations" aria-label="组件协作关系表">
          <h3>组件协作关系表</h3>
          {model.edges.length ? <div className="architecture-table-scroll"><table>
            <thead><tr><th scope="col">来源 → 目标</th><th scope="col">关系类型</th><th scope="col">协作与传递内容</th></tr></thead>
            <tbody>{model.edges.map(edge => {
              const id = edgeSelection(edge.edge_id);
              return <tr key={id} onClick={() => select(id)} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover('')}
                className={selected === id ? 'is-selected' : undefined}>
                <td>{byId.get(edge.source_node_id)?.label} → {byId.get(edge.target_node_id)?.label}</td>
                <td>{edgeNames[edge.kind]}</td>
                <td><button aria-pressed={selected === id} onFocus={() => setHover(id)} onBlur={() => setHover('')}>{edge.label}</button>
                  <small>{edge.transfers?.length ? edge.transfers.map(t => t.label).join('、') : '传递内容待确认'}</small></td>
              </tr>;
            })}</tbody>
          </table></div> : <p>当前视图没有已分析的组件关系。</p>}
        </section>
      </>}
    <details className="architecture-scope">
      <summary>覆盖边界 · {result.coverage.covered_scope.length} 项已覆盖，{result.coverage.unresolved_scope.length} 项未覆盖</summary>
      <p>{result.summary.text}</p>
      {([['已覆盖', result.coverage.covered_scope], ['待查证', result.coverage.unresolved_scope]] as const).map(([label, items]) =>
        items.length > 0 && <div key={label}><strong>{label}</strong><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>)}
    </details>
  </section>;
}
