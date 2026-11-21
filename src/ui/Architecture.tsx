import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AnalysisResult } from '../shared';
import { architectureColumns, architectureMap } from './architecture-map';
import { componentContext } from './architecture-context';
import { CodeModules } from './CodeModules';
import type { TaskArchitectureOverlay } from './DevelopmentHud';
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
  taskOverlay?: (TaskArchitectureOverlay & { onClear: () => void; onReturnTask: () => void }) | null;
}
type Node = AnalysisResult['nodes'][number];
type Edge = AnalysisResult['edges'][number];

function RelationTable({ edges, byId, search, selected, select }: Pick<Props, 'search' | 'selected' | 'select'> & {
  edges: Edge[]; byId: Map<string, Node>;
}) {
  const query = search.trim().toLowerCase();
  const rows = edges.flatMap(edge => {
    const from = byId.get(edge.source_node_id)!;
    const to = byId.get(edge.target_node_id)!;
    const transfers = edge.transfers?.map(transfer => {
      const output = from.outputs.find(io => io.io_id === transfer.source_output_id)?.name;
      const input = to.inputs.find(io => io.io_id === transfer.target_input_id)?.name;
      return { label: transfer.label, output, input };
    }) ?? [];
    const words = [from.label, to.label, edgeNames[edge.kind], edge.label, ...transfers.flatMap(t => [t.label, t.output, t.input])];
    return !query || words.some(word => word?.toLowerCase().includes(query)) ? [{ edge, from, to, transfers }] : [];
  });
  return <section className="architecture-relations" aria-label="组件协作关系表">
    {rows.length ? <div className="architecture-table-scroll"><table>
      <thead><tr><th scope="col">来源 → 目标</th><th scope="col">关系类型</th><th scope="col">协作与传递内容</th></tr></thead>
      <tbody>{rows.map(({ edge, from, to, transfers }) => {
        const id = edgeSelection(edge.edge_id);
        return <tr key={id} data-edge-id={edge.edge_id} onClick={() => select(id)} className={selected === id ? 'is-selected' : undefined}>
          <td>{from.label} → {to.label}</td>
          <td>{edgeNames[edge.kind]}</td>
          <td><button aria-pressed={selected === id}>{edge.label}</button>
            {transfers.length ? transfers.map((t, index) => <small key={index}>{t.label}
              {t.output && ' · 交出 ' + t.output}{t.input && ' · 接收 ' + t.input}</small>) : <small>传递内容待确认</small>}
          </td>
        </tr>;
      })}</tbody>
    </table></div> : <p>{query ? '没有匹配的协作关系。' : '当前视图没有已分析的组件关系。'}</p>}
  </section>;
}

function RoleIcon({ kind }: { kind: Node['kind'] }) {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'resource' ? <><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></> : kind === 'execution_boundary' ? <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m8 9 3 3-3 3m5 0h3"/></> : <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></>}
  </svg>;
}

export function Architecture({ result, selected, select, inspect, modules, openFile, zoom, search, taskOverlay }: Props) {
  const root = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(820);
  const [view, setView] = useState<'layers' | 'relations' | 'code'>('layers');
  const [hover, setHover] = useState('');
  const [focusOnly, setFocusOnly] = useState(false);
  const marker = 'arch-' + useId().replace(/:/g, '');
  const columns = architectureColumns(width);
  const diagramSearch = view === 'layers' ? search : '';
  const model = useMemo(() => architectureMap(result, diagramSearch, columns), [result, diagramSearch, columns]);
  const contexts = useMemo(() => new Map(model.nodes.map(node => [node.node_id, componentContext(node, result)])), [model.nodes, result]);
  const byId = useMemo(() => new Map(model.nodes.map(node => [node.node_id, node])), [model.nodes]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);

  const scale = Math.min(1.15, (width - 4) / model.width) * zoom;
  const isInDiagram = (id: string) => byId.has(id) || model.edges.some(e => edgeSelection(e.edge_id) === id);
  const focusId = hover && isInDiagram(hover) ? hover : isInDiagram(selected) ? selected : '';
  const focusedNode = byId.get(focusId);
  const activeLinks = model.links.filter(({ edge }) =>
    [edge.source_node_id, edge.target_node_id, edgeSelection(edge.edge_id)].includes(focusId));
  const captions = activeLinks.filter(({ edge, singleEdgeLabel }) => !singleEdgeLabel || focusId === edgeSelection(edge.edge_id));
  const activeNodes = new Set([focusId, ...activeLinks.flatMap(({ edge }) => [edge.source_node_id, edge.target_node_id])]);
  const focusLabel = focusedNode ? focusedNode.label + '（' + activeLinks.length + ' 条关联）' : activeLinks[0]?.edge.label;
  const chooseView = (next: typeof view) => { setView(next); setHover(''); };
  const reset = () => { setHover(''); select(''); };

  return <section ref={root} className="architecture-map" aria-label="系统协作导图">
    {taskOverlay && view === 'layers' && (
      <div className="architecture-task-hud-banner" role="status">
        <span>
          <strong>{taskOverlay.taskId === '__live_radar__' ? '变更雷达影响叠加' : '开发任务影响叠加'}</strong> · {taskOverlay.goal.length > 48 ? taskOverlay.goal.slice(0, 48) + '…' : taskOverlay.goal}
          {' '}（实框直改 / 虚线波及）
        </span>
        <span className="row">
          <button type="button" className="hud-mini-btn" onClick={taskOverlay.onReturnTask}>{taskOverlay.taskId === '__live_radar__' ? '返回变更雷达' : '返回任务'}</button>
          <button type="button" className="hud-mini-btn" onClick={taskOverlay.onClear}>关闭叠加</button>
        </span>
      </div>
    )}
    <header className="architecture-map-heading">
      <div className="architecture-view-switch" role="group" aria-label="架构视图">
        <button aria-pressed={view === 'layers'} onClick={() => chooseView('layers')}>分层架构图</button>
        <button aria-pressed={view === 'relations'} onClick={() => chooseView('relations')}>协作关系表 ({result.architecture?.edge_ids.length ?? 0})</button>
        <button aria-pressed={view === 'code'} onClick={() => chooseView('code')}>代码模块依赖（静态索引）</button>
      </div>
      {view === 'layers' && <div className="architecture-map-status">
        <span className="architecture-map-stat">{model.nodes.length} 个组件 · {model.edges.length} 条关系</span>
        <div className="architecture-edge-switch" role="group" aria-label="连线显示方式">
          <button aria-pressed={!focusOnly} onClick={() => setFocusOnly(false)}>自动连线</button>
          <button aria-pressed={focusOnly} onClick={() => setFocusOnly(true)}>仅聚焦显线</button>
        </div>
        {focusLabel && <span className="architecture-focus-chip"><span>已聚焦：{focusLabel}</span><button onClick={reset}>显示全部</button></span>}
      </div>}
    </header>
    {view === 'code' ? <div data-zoom-surface style={{ zoom }}>
        <CodeModules key={result.binding.source_snapshot_id} snapshotId={result.binding.source_snapshot_id} openFile={openFile} search={search} />
      </div>
      : !result.architecture ? <div className="empty compact">
          <h2>系统协作尚未分析</h2><button onClick={modules}>查看已有模块说明</button>
        </div>
      : view === 'relations' ? <div data-zoom-surface style={{ zoom }}>
          <RelationTable edges={model.edges} byId={byId} search={search} selected={selected} select={select}/>
        </div>
      : !model.nodes.length ? <div className="empty compact"><h2>没有匹配组件</h2><p>清除搜索查看完整系统。</p></div>
      : <>
        <div className={"architecture-viewport" + (focusOnly ? " focus-only" : "")} tabIndex={0} role="region" aria-label="系统架构图，可横向滚动">
          <svg className="architecture-map-canvas" data-zoom-surface width={model.width * scale} height={model.height * scale}
            viewBox={`0 0 ${model.width} ${model.height}`} role="group" aria-label="系统架构图" onClick={event => {
              if ((selected || hover) && !(event.target as Element).closest('[data-component-id], [data-edge-id]')) reset();
            }}>
            <defs><marker id={marker} markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
              <path d="M0 0 L6 3 L0 6 Z" fill="context-stroke" />
            </marker></defs>
            {model.layers.map(layer => <rect key={layer.id} className={'architecture-layer tier-' + layer.id}
              x={layer.x} y={layer.y} width={layer.width} height={layer.height} rx="8"/>)}
            {model.boundaries.map(b => <rect key={b.id} className="architecture-container" x={b.x} y={b.y} width={b.width} height={b.height} rx="8">
              <title>{byId.get(b.id)!.label + '及内部模块'}</title>
            </rect>)}
            {model.links.map(({ edge, path }) => {
              const id = edgeSelection(edge.edge_id);
              const state = !focusId ? '' : id === focusId ? 'selected' : edge.source_node_id === focusId ? 'outgoing'
                : edge.target_node_id === focusId ? 'incoming' : 'dimmed';
              const label = `${byId.get(edge.source_node_id)!.label} → ${byId.get(edge.target_node_id)!.label}：${edge.label}`;
              return <g key={id} className={`architecture-link ${state}${focusOnly && !focusId ? " hidden-resting" : ""}${edge.status === 'source_supported' ? '' : ' uncertain'}`}
                data-edge-id={edge.edge_id} role="button" tabIndex={(focusOnly && !focusId) || state === 'dimmed' ? -1 : 0} aria-hidden={(focusOnly && !focusId) || state === 'dimmed' || undefined} aria-label={label} aria-pressed={selected === id}
                onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover('')} onFocus={() => setHover(id)} onBlur={() => setHover('')}
                onClick={() => select(id)} onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(id); }
                }}>
                <title>{label}</title>
                <path className="architecture-link-hit" d={path}/>
                <path className="architecture-link-line" d={path} markerEnd={`url(#${marker})`}/>
              </g>;
            })}
            {captions.map(({ edge, labelPos, labelAnchor }) => <line key={edge.edge_id}
              className={'architecture-caption-leader' + (edge.target_node_id === focusId ? ' incoming' : '')}
              x1={labelAnchor.x} y1={labelAnchor.y} x2={labelPos.x} y2={labelPos.y}/>)}
            {model.layers.map(layer => <text key={layer.id} className={'architecture-layer-title tier-' + layer.id}
              x={layer.x + 15} y={layer.y + 25}>●  {layer.title}<tspan dx="8">· {layer.roots.length}</tspan></text>)}
            {model.nodes.map(node => {
              const context = contexts.get(node.node_id)!;
              const overlayRole = taskOverlay?.nodes.get(node.node_id);
              return <foreignObject key={node.node_id} {...model.boxes.get(node.node_id)} data-component-id={node.node_id} data-zoom-anchor
                className={focusId && !activeNodes.has(node.node_id) ? 'architecture-node-dimmed' : undefined}>
                <button className={'architecture-card architecture-node kind-' + node.kind + (model.hubs.has(node.node_id) ? ' is-hub' : '') + (overlayRole ? ' hud-' + overlayRole : '')} aria-pressed={selected === node.node_id}
                  onMouseEnter={() => setHover(node.node_id)} onMouseLeave={() => setHover('')}
                  onFocus={() => setHover(node.node_id)} onBlur={() => setHover('')} onClick={() => select(node.node_id)}>
                  <span className="architecture-card-header">
                    <span className="architecture-card-icon" aria-hidden="true"><RoleIcon kind={node.kind}/></span>
                    <strong className="architecture-card-title" title={node.label}>{node.label}</strong>
                    {overlayRole ? <span className={'architecture-hud-tag ' + overlayRole}>{overlayRole === 'direct' ? '直改' : '波及'}</span> : model.hubs.has(node.node_id) && <span className="architecture-hub-badge">核心</span>}
                  </span>
                  <span className="architecture-card-copy">{node.description}</span>
                  <span className="architecture-card-meta"><span>{model.degrees.get(node.node_id) ?? 0} 关系</span>
                    {context.children.length > 0 ? <span>{context.children.length} 子模块</span> : context.features.length > 0 && <span>{context.features.length} 功能</span>}
                  </span>
                </button>
              </foreignObject>;
            })}
            {captions.map(({ edge, labelPos, labelWidth }) => <foreignObject key={edge.edge_id}
              className={'architecture-edge-caption' + (edge.target_node_id === focusId ? ' incoming' : '')} aria-hidden="true"
              x={labelPos.x - labelWidth / 2} y={labelPos.y - 10} width={labelWidth} height={20}>
              <span>{edge.label}</span>
            </foreignObject>)}
          </svg>
        </div>
        <div className="architecture-legend" aria-label="架构图图例"><span className="legend-blue">● 入口交互</span><span className="legend-green">● 核心控制</span><span className="legend-amber">● 存储底层</span><span>· 点击组件聚焦上下游调用链</span><span className="architecture-zoom-hint">点击右下角缩放比例恢复 100%</span></div>
        {!!contexts.get(selected)?.children.length && <button className="architecture-inspect" onClick={() => inspect(selected)}>展开所选组件的内部模块</button>}
      </>}
    <details className="architecture-scope">
      <summary>覆盖边界 · {result.coverage.covered_scope.length} 项已覆盖，{result.coverage.unresolved_scope.length} 项未覆盖</summary>
      <p>{result.summary.text}</p>
      {([['已覆盖', result.coverage.covered_scope], ['待查证', result.coverage.unresolved_scope]] as const).map(([label, items]) =>
        items.length > 0 && <div key={label}><strong>{label}</strong><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>)}
    </details>
  </section>;
}
