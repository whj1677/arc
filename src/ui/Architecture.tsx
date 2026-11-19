import React, { useRef, useEffect, useState, useId } from 'react';
import type { AnalysisResult } from '../shared';
import { architectureMap } from './architecture-map';
import './architecture.css';
import './architecture-map.css';

interface Props {
  result: AnalysisResult;
  selected: string;
  select: (id: string) => void;
  inspect: (id: string) => void;
  modules: () => void;
  zoom: number;
  search: string;
}

export function Architecture({ result, selected, select, inspect, modules, zoom, search }: Props) {
  const root = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(880);
  const [hoveredNode, setHoveredNode] = useState('');
  const [hoveredEdge, setHoveredEdge] = useState('');
  const marker = 'arch-' + useId().replace(/:/g, '');
  const model = architectureMap(result, search);

  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [result.result_id, model.nodes.length > 0]);

  if (!result.architecture) {
    return (
      <div className="empty compact">
        <h2>系统协作尚未分析</h2>
        <p>需要 Agent 明确系统组件和通信关系，不能按文件名猜测架构。</p>
        <button onClick={modules}>查看已有模块说明</button>
      </div>
    );
  }
  if (!model.nodes.length) {
    return (
      <div className="empty compact">
        <h2>没有匹配组件</h2>
        <p>清除搜索查看完整系统。</p>
      </div>
    );
  }

  const scale = Math.min(1, Math.max(760, width) / model.width) * zoom;
  const selectedPair = model.pairs.find(pair => pair.some(e => e.edge_id === selected));

  const hasHover = !!(hoveredNode || hoveredEdge);
  const relatedNodes = new Set<string>();
  const relatedEdges = new Set<string>();
  if (hoveredNode) {
    relatedNodes.add(hoveredNode);
    for (const pair of model.pairs) {
      if (pair.some(e => e.source_node_id === hoveredNode || e.target_node_id === hoveredNode)) {
        for (const e of pair) {
          relatedEdges.add(e.edge_id);
          relatedNodes.add(e.source_node_id);
          relatedNodes.add(e.target_node_id);
        }
      }
    }
  } else if (hoveredEdge) {
    const pair = model.pairs.find(p => p.some(e => e.edge_id === hoveredEdge));
    if (pair) {
      for (const e of pair) {
        relatedEdges.add(e.edge_id);
        relatedNodes.add(e.source_node_id);
        relatedNodes.add(e.target_node_id);
      }
    }
  }

  return (
    <section ref={root} className="architecture-map" aria-label="系统协作导图">
      <header className="architecture-map-heading">
        <div>
          <h2>组件协作关系</h2>
        </div>
        <span className="architecture-map-stat">
          {model.nodes.length} 个组件 · {model.edges.length} 条关系
        </span>
      </header>
      <div className="architecture-viewport" tabIndex={0} role="region" aria-label="系统架构图，可横向滚动">
        <svg
          className="architecture-map-canvas"
          data-zoom-surface
          width={model.width * scale}
          height={model.height * scale}
          viewBox={`0 0 ${model.width} ${model.height}`}
          role="group"
          aria-label="系统架构图"
        >
          <defs>
            <marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto-start-reverse">
              <path d="M0 0 L7 3.5 L0 7" fill="context-stroke" />
            </marker>
          </defs>
          {model.boundaries.map(b => (
            <rect key={b.id} className="architecture-container" x={b.x} y={b.y} width={b.width} height={b.height} rx="20">
              <title>包含明确归属的内部模块</title>
            </rect>
          ))}
          {model.pairs.map(pair => {
            const e = pair[0];
            const a = model.boxes.get(e.source_node_id)!;
            const b = model.boxes.get(e.target_node_id)!;
            const vertical = Math.abs(a.x - b.x) < 100;
            const forward = a.x < b.x;
            const down = a.y < b.y;
            const sx = vertical ? a.x + a.width / 2 : forward ? a.x + a.width : a.x;
            const sy = vertical ? (down ? a.y + a.height : a.y) : a.y + a.height / 2;
            const tx = vertical ? b.x + b.width / 2 : forward ? b.x : b.x + b.width;
            const ty = vertical ? (down ? b.y : b.y + b.height) : b.y + b.height / 2;
            const self = e.source_node_id === e.target_node_id;
            const d = self
              ? `M${sx} ${sy} C${sx + 80} ${sy - 95} ${sx - 80} ${sy - 95} ${sx} ${sy}`
              : vertical
                ? `M${sx} ${sy} C${sx} ${(sy + ty) / 2} ${tx} ${(sy + ty) / 2} ${tx} ${ty}`
                : `M${sx} ${sy} C${(sx + tx) / 2} ${sy} ${(sx + tx) / 2} ${ty} ${tx} ${ty}`;
            const label = e.label.split(' · ')[0];
            const active = pair.some(item => item.edge_id === selected);
            const both = pair.some(v => v.source_node_id === e.target_node_id && v.target_node_id === e.source_node_id);
            const pillW = vertical ? 124 : 112;
            const pillH = 24;
            const mx = (sx + tx) / 2;
            const my = (sy + ty) / 2;
            const px = self
              ? Math.max(4, Math.min(model.width - pillW - 4, sx - pillW / 2))
              : Math.max(4, Math.min(model.width - pillW - 4, mx - pillW / 2));
            const py = self ? Math.max(4, sy - 86) : my - pillH / 2;
            const source = model.nodes.find(n => n.node_id === e.source_node_id)!;
            const target = model.nodes.find(n => n.node_id === e.target_node_id)!;
            const dimmed = hasHover && !pair.some(item => relatedEdges.has(item.edge_id));
            const highlighted = hasHover && pair.some(item => relatedEdges.has(item.edge_id));

            return (
              <g
                key={e.edge_id}
                className={`architecture-link ${active ? 'selected' : ''} ${highlighted ? 'hovered' : ''} ${dimmed ? 'dimmed' : ''} ${
                  pair.some(item => item.status !== 'source_supported') ? 'uncertain' : ''
                }`}
                data-edge-id={e.edge_id}
                role="button"
                tabIndex={0}
                aria-label={`${source.label} → ${target.label}：${e.label}${pair.length > 1 ? '，共 ' + pair.length + ' 条关系' : ''}`}
                onClick={() => select(e.edge_id)}
                onMouseEnter={() => setHoveredEdge(e.edge_id)}
                onMouseLeave={() => setHoveredEdge(current => (current === e.edge_id ? '' : current))}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    select(e.edge_id);
                  }
                }}
              >
                <title>{pair.map(item => item.label).join('\n')}</title>
                <path className="architecture-link-hit" d={d} />
                <path className="architecture-link-line" d={d} markerEnd={`url(#${marker})`} markerStart={both ? `url(#${marker})` : undefined} />
                <foreignObject x={px} y={py} width={pillW} height={pillH} className="architecture-link-pill-box">
                  <div className="architecture-link-pill" title={pair.map(item => item.label).join(' / ')}>
                    <span>{label}</span>
                    {pair.length > 1 && <b>·{pair.length}</b>}
                  </div>
                </foreignObject>
              </g>
            );
          })}
          {model.nodes.map(n => {
            const b = model.boxes.get(n.node_id)!;
            const parent = model.nodes.find(p => p.node_id === n.parent_node_id);
            const parts = n.label.split(' · ');
            const dimmed = hasHover && !relatedNodes.has(n.node_id);
            return (
              <foreignObject
                key={n.node_id}
                x={b.x}
                y={b.y}
                width={b.width}
                height={b.height}
                data-component-id={n.node_id}
                data-zoom-anchor
                className={dimmed ? 'architecture-node-dimmed' : undefined}
              >
                <button
                  className={`architecture-map-node architecture-node ${model.hub === n.node_id ? 'hub' : ''} ${parent ? 'internal' : ''} ${
                    n.kind === 'execution_boundary' ? 'external' : ''
                  }`}
                  aria-pressed={selected === n.node_id}
                  onClick={() => select(n.node_id)}
                  onMouseEnter={() => setHoveredNode(n.node_id)}
                  onMouseLeave={() => setHoveredNode(current => (current === n.node_id ? '' : current))}
                  title={n.description}
                >
                  <span className="architecture-node-dot" aria-hidden="true" />
                  <strong>{parts[0]}</strong>
                  <small>
                    {parts.slice(1).join(' · ') || '组件'}
                    {parent && !parts.slice(1).join('').includes('内部') ? ' · 内部模块' : ''}
                  </small>
                </button>
              </foreignObject>
            );
          })}
        </svg>
      </div>
      <div className="architecture-map-footer">
        <span>↗ 箭头表示关系方向 · 虚线框表示归属模块</span>
        <span>悬停高亮关联 · 点击组件或连线查看详情</span>
      </div>
      {selectedPair && (
        <div className="architecture-selected-links" aria-label="当前连线的关系">
          <span>查看这条连线</span>
          {selectedPair.map(e => (
            <button key={e.edge_id} aria-pressed={selected === e.edge_id} onClick={() => select(e.edge_id)}>
              {e.label}
            </button>
          ))}
        </div>
      )}
      {model.nodes.some(n => n.node_id === selected && result.nodes.some(child => child.parent_node_id === n.node_id)) && (
        <button className="architecture-deeper" onClick={() => inspect(selected)}>
          展开所选组件的内部模块 →
        </button>
      )}
      <details className="architecture-scope">
        <summary>
          覆盖边界 · {result.coverage.covered_scope.length} 项已覆盖，{result.coverage.unresolved_scope.length} 项未覆盖
        </summary>
        <p>关系图仅显示已分析的连接，节点位置不表示执行顺序。</p>
        {result.coverage.unresolved_scope.map((item, index) => (
          <p key={index}>{item}</p>
        ))}
      </details>
    </section>
  );
}
