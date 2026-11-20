import React, { useEffect, useRef, useState, useId } from 'react';
import type { AnalysisResult, ReadingGuide } from '../shared';
import { readingFailureLinks, readingCollaboration } from './reading-diagram-model';

export const shortLabel = (text: string, length = 24) => (text.length > length ? text.slice(0, length - 1) + '…' : text);

export function Diagram({
  width,
  height,
  zoom,
  label,
  children,
  header,
  headerHeight = 98,
}: {
  width: number;
  height: number;
  zoom: number;
  label: string;
  children: React.ReactNode;
  header?: React.ReactNode;
  headerHeight?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(800);
  useEffect(() => {
    if (!root.current) return;
    const o = new ResizeObserver(es => setAvailable(es[0].contentRect.width));
    o.observe(root.current);
    return () => o.disconnect();
  }, []);
  const scale = Math.max(0.85, Math.min(1, available / width)) * zoom;
  const bodyTop = header ? headerHeight : 0;
  return (
    <div className={'reading-diagram-frame' + (header ? ' function-time-scroll' : '')} ref={root}>
      {header && (
        <svg className="function-time-header" data-zoom-surface width={width * scale} height={headerHeight * scale} viewBox={`0 0 ${width} ${headerHeight}`} role="group" aria-label="函数节点">
          {header}
        </svg>
      )}
      <svg
        data-zoom-surface
        className="reading-diagram"
        width={width * scale}
        height={(height - bodyTop) * scale}
        viewBox={`0 ${bodyTop} ${width} ${height - bodyTop}`}
        role="group"
        aria-label={label}
      >
        {children}
      </svg>
    </div>
  );
}

type Common = {
  guide: ReadingGuide;
  path: ReadingGuide['paths'][number];
  selected: string;
  search: string;
  zoom: number;
  onSelect: (key: string) => void;
};

function Arrow({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
        <path d="M0 0 L7 3.5 L0 7" fill="context-stroke" />
      </marker>
    </defs>
  );
}

export function BusinessDiagram({ result, guide: g, path, selected, search, zoom, onSelect, ordered }: Common & { result: AnalysisResult; ordered: boolean }) {
  const marker = 'business-' + useId().replace(/:/g, '');
  const query = search.toLowerCase();
  const rows = [...(path.step_ids.length ? [{ label: path.lanes.length ? '共同起点' : '', step_ids: path.step_ids, link_labels: [] as readonly string[] }] : []), ...path.lanes];
  const width = Math.max(680, ...rows.map(r => r.step_ids.length * 176 + 16));
  const failureTop = rows.length * 214 + 78;
  const failures = g.steps.filter(s => path.failure_ids.includes(s.id));
  const links = readingFailureLinks(result, g, path);
  const height = failures.length ? failureTop + Math.ceil(failures.length / 3) * 160 : rows.length * 214 + 12;
  const box = (row: number, col: number) => ({ x: 16 + col * 176, y: 28 + row * 214, width: 148, height: 148 });
  const positions = new Map<string, ReturnType<typeof box>>();
  rows.forEach((r, ri) =>
    r.step_ids.forEach((id, ci) => {
      if (!positions.has(id)) positions.set(id, box(ri, ci));
    }),
  );
  const failureBox = (i: number) => ({ x: 20 + (i % 3) * (width / 3), y: failureTop + Math.floor(i / 3) * 160, width: Math.min(220, width / 3 - 28), height: 108 });

  return (
    <Diagram width={width} height={height} zoom={zoom} label="业务时间图与失败分支">
      <Arrow id={marker} />
      {rows.map((row, ri) => (
        <g key={ri}>
          {row.label && (
            <text className="diagram-row-title" x="16" y={18 + ri * 214}>
              {row.label}
            </text>
          )}
          {row.step_ids.map((id, ci) => {
            const s = g.steps.find(item => item.id === id);
            if (!s) return null;
            const b = box(ri, ci);
            const dim = query && ![s.title, s.text, s.detail, s.outcome].join(' ').toLowerCase().includes(query);
            return (
              <g key={id}>
                {ordered && ci < row.step_ids.length - 1 && (
                  <g>
                    <path className="diagram-link" d={`M${b.x + b.width} ${b.y + 72} H${b.x + 176 - 4}`} markerEnd={`url(#${marker})`} />
                    {row.link_labels[ci] && (
                      <text className="diagram-edge-label" x={b.x + b.width + 14} y={b.y + 166} textAnchor="middle">
                        <title>{row.link_labels[ci]}</title>
                        {shortLabel(row.link_labels[ci], 12)}
                      </text>
                    )}
                  </g>
                )}
                <foreignObject data-zoom-anchor x={b.x} y={b.y} width={b.width} height={b.height}>
                  <button
                    className={`diagram-node business-node ${selected === 'step:' + id ? 'selected' : ''} ${dim ? 'diagram-dim' : ''}`}
                    data-reading-step={id}
                    onClick={() => onSelect('step:' + id)}
                    title={s.text}
                  >
                    <small>
                      {ordered ? String(ci + 1).padStart(2, '0') + ' · ' : ''}
                      {s.actor}
                    </small>
                    <strong>{s.title}</strong>
                    <span title={s.outcome}>{shortLabel(s.outcome, 20)}</span>
                  </button>
                </foreignObject>
              </g>
            );
          })}
        </g>
      ))}
      {links.map((link, i) => {
        const a = positions.get(link.from);
        const bi = failures.findIndex(s => s.id === link.to);
        if (!a || bi < 0) return null;
        const b = failureBox(bi);
        const sx = a.x + a.width / 2;
        const sy = a.y + a.height;
        const tx = b.x + b.width / 2;
        const ty = b.y;
        return (
          <g key={link.id} className="business-exception">
            <path className="diagram-link" d={`M${sx} ${sy} V${sy + 25 + i * 12} H${tx} V${ty - 4}`} markerEnd={`url(#${marker})`} />
            <foreignObject x={tx - b.width / 2} y={ty - 35 - i * 3} width={b.width} height="28">
              <button className="diagram-condition" onClick={() => onSelect('step:' + link.to)} title={link.label}>
                {shortLabel(link.label, 19)}
              </button>
            </foreignObject>
          </g>
        );
      })}
      {failures.map((s, i) => {
        const b = failureBox(i);
        return (
          <foreignObject key={s.id} data-zoom-anchor x={b.x} y={b.y} width={b.width} height={b.height}>
            <button className={`diagram-node failure-node ${selected === 'step:' + s.id ? 'selected' : ''}`} onClick={() => onSelect('step:' + s.id)} title={s.text}>
              <small>分支 · {links.some(l => l.to === s.id) ? s.actor : '触发位置尚未明确'}</small>
              <strong>{s.title}</strong>
              <span>{shortLabel(s.outcome, 24)}</span>
            </button>
          </foreignObject>
        );
      })}
    </Diagram>
  );
}

export function CollaborationDiagram({ guide: g, path, selected, search, zoom, onSelect }: Common) {
  const { roles, handoffs } = readingCollaboration(g, path);
  if (!roles.length) return <p className="fr-empty">本分析尚未明确参与方。</p>;
  const query = search.trim().toLowerCase();
  const roleById = new Map(roles.map(role => [role.id, role]));
  const connected = new Set(handoffs.flatMap(handoff => [handoff.from, handoff.to]));
  const roleCard = (role: ReadingGuide['roles'][number]) => (
    <button
      key={role.id}
      type="button"
      data-zoom-anchor
      className={`diagram-node role-node ${selected === 'role:' + role.id ? 'selected' : ''} ${query && !(role.title + role.duty).toLowerCase().includes(query) ? 'diagram-dim' : ''}`}
      onClick={() => onSelect('role:' + role.id)}
      aria-pressed={selected === 'role:' + role.id}
    >
      <small>参与方</small>
      <strong>{role.title}</strong>
      <span>{role.duty}</span>
    </button>
  );
  return (
    <div data-zoom-surface className="collaboration-map" style={{ zoom }} role="group" aria-label="参与方职责与交接图">
      {handoffs.map(h => {
        const from = roleById.get(h.from)!;
        const to = roleById.get(h.to)!;
        const dim = query && ![h.label, h.send, h.receive, h.detail].join(' ').toLowerCase().includes(query);
        return (
          <div className="collaboration-route" key={h.id}>
            {roleCard(from)}
            <span className="handoff-arrow" aria-hidden="true" />
            <button
              type="button"
              data-zoom-anchor
              className={`handoff-connection handoff-label ${dim ? 'diagram-dim' : ''}`}
              aria-label={`${from.title} → ${to.title}：${h.label}`}
              aria-pressed={selected === 'handoff:' + h.id}
              onClick={() => onSelect('handoff:' + h.id)}
            >
              <strong>{h.label}</strong>
              <small>{h.send}</small>
            </button>
            <span className="handoff-arrow" aria-hidden="true" />
            {roleCard(to)}
          </div>
        );
      })}
      {roles.some(role => !connected.has(role.id)) && <div className="collaboration-roles">{roles.filter(role => !connected.has(role.id)).map(roleCard)}</div>}
    </div>
  );
}

export function FilesDiagram({
  files,
  label,
  selected,
  zoom,
  onSelect,
}: {
  files: ReadingGuide['files'];
  label: string;
  selected: string;
  zoom: number;
  onSelect: (key: string) => void;
}) {
  if (!files.length) return <p className="fr-empty">当前路径没有匹配文件。</p>;
  const rowStep = 132;
  const height = Math.max(150, files.length * rowStep + 10);
  const rootY = Math.min(240, height / 2);
  const width = 760;
  return (
    <Diagram width={width} height={height} zoom={zoom} label="本功能相关文件与职责导图">
      {files.map((f, i) => {
        const targetY = i * rowStep + 62;
        const fileName = f.path.split('/').at(-1) || '';
        const showFileName = !!fileName && fileName !== f.title;
        const dirPath = f.path.split('/').slice(0, -1).join('/');
        return (
          <g key={f.path}>
            <path
              className={`file-trunk ${selected === 'file:' + f.path ? 'active' : ''}`}
              d={`M224 ${rootY} C268 ${rootY} 266 ${targetY} 310 ${targetY}`}
            />
            <foreignObject data-zoom-anchor x="310" y={i * rowStep + 6} width="434" height="114">
              <button
                className={`diagram-node file-node ${selected === 'file:' + f.path ? 'selected' : ''}`}
                data-file-path={f.path}
                onClick={() => onSelect('file:' + f.path)}
                title={f.path + '\n' + f.description}
              >
                <div>
                  <strong>{f.title}</strong>
                  {showFileName && <small>{fileName}</small>}
                </div>
                <span>{shortLabel(f.description, 72)}</span>
                {dirPath && <small className="file-directory">{dirPath}</small>}
              </button>
            </foreignObject>
          </g>
        );
      })}
      <foreignObject x="10" y={rootY - 48} width="214" height="96">
        <div className="file-map-root">
          <small>相关文件 · {files.length}</small>
          <strong>{label}</strong>
          <span>连线表示本路径引用</span>
        </div>
      </foreignObject>
    </Diagram>
  );
}
