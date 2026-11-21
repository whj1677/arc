import React, { useEffect, useRef, useState } from 'react';
import type { AnalysisResult, ReadingGuide } from '../shared';
import { readingFailureLinks, readingCollaboration } from './reading-diagram-model';

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

export function BusinessDiagram({ result, guide, path, selected, search, zoom, onSelect, ordered }: Common & { result: AnalysisResult; ordered: boolean }) {
  const steps = new Map(guide.steps.map(step => [step.id, step]));
  const query = search.trim().toLowerCase();
  const lanes = [...(path.step_ids.length ? [{ label: path.lanes.length ? '共同起点' : '', step_ids: path.step_ids, link_labels: [] as readonly string[] }] : []), ...path.lanes];
  const links = readingFailureLinks(result, guide, path);
  const failures = path.failure_ids.filter(id => steps.has(id));
  function stepCard(id: string, index?: number) {
    const step = steps.get(id)!;
    const dim = query && ![step.title, step.actor, step.text, step.detail, step.outcome].join(' ').toLowerCase().includes(query);
    return <button type="button" className={'fr-step' + (dim ? ' diagram-dim' : '')} data-reading-step={id} data-zoom-anchor
      aria-pressed={selected === 'step:' + id} onClick={() => onSelect('step:' + id)}>
      <span className="fr-step-heading">
        {index !== undefined && <span className="fr-step-number">{index + 1}</span>}
        <strong>{step.title}</strong><small>{step.actor}</small>
      </span>
      {step.text && step.text !== step.title && <span className="fr-step-action">{step.text}</span>}
      {step.outcome && <span className="fr-outcome"><b>结果</b>{step.outcome}</span>}
    </button>;
  }
  return <div data-zoom-surface style={{ zoom }} className="fr-timeline" role="group" aria-label="业务时间图与失败分支">
    {lanes.map((lane, i) => <section key={i} className="fr-lane">
      {lane.label && <h3>{lane.label}</h3>}
      {lane.step_ids.map((id, index) => <React.Fragment key={id}>
        {ordered && index > 0 && <div className="fr-step-connector"><i aria-hidden="true"/>{lane.link_labels[index - 1]}</div>}
        {stepCard(id, ordered ? index : undefined)}
      </React.Fragment>)}
    </section>)}
    {failures.length > 0 && <section className="fr-failures"><h3>异常分支</h3>
      {failures.map(id => {
        const triggers = links.filter(link => link.to === id && steps.has(link.from));
        return <div key={id} className="fr-failure">
          {triggers.length ? triggers.map(link => <button className="fr-branch-trigger" key={link.id} onClick={() => onSelect('step:' + link.from)}>
            {steps.get(link.from)!.title} → {link.label}
          </button>) : <small>触发位置尚未明确</small>}
          {stepCard(id)}
        </div>;
      })}
    </section>}
  </div>;
}

export function CollaborationDiagram({ guide, path, selected, search, zoom, onSelect }: Common) {
  const { roles, handoffs } = readingCollaboration(guide, path);
  if (!roles.length) return <p className="fr-empty">这条路径尚未确认参与方。</p>;
  const query = search.trim().toLowerCase();
  const roleById = new Map(roles.map(role => [role.id, role]));
  return <div data-zoom-surface className="collaboration-map" style={{ zoom }} role="group" aria-label="参与方职责与交接图">
    <div className="fr-roles">{roles.map(role => <button key={role.id} data-zoom-anchor
      className={query && !(role.title + role.duty).toLowerCase().includes(query) ? 'diagram-dim' : ''}
      aria-pressed={selected === 'role:' + role.id} onClick={() => onSelect('role:' + role.id)}>
      <strong>{role.title}</strong><span>{role.duty}</span>
    </button>)}</div>
    {handoffs.length > 0 && <section className="fr-handoffs"><h3>调用与交接</h3>
      {handoffs.map(h => {
        const from = roleById.get(h.from)!.title, to = roleById.get(h.to)!.title;
        const dim = query && ![from, to, h.label, h.send, h.receive, h.detail].join(' ').toLowerCase().includes(query);
        return <button key={h.id} className={'fr-handoff' + (dim ? ' diagram-dim' : '')} data-zoom-anchor
          aria-pressed={selected === 'handoff:' + h.id} onClick={() => onSelect('handoff:' + h.id)}>
          <span className="fr-route">{from}<i aria-label="交接给">→</i>{to}</span>
          <strong>{h.label}</strong><span>{h.send}</span>{h.receive && h.receive !== h.send && <span>{h.receive}</span>}
        </button>;
      })}
    </section>}
  </div>;
}

export function FilesDiagram({ files, label, selected, zoom, onSelect }: {
  files: ReadingGuide['files']; label: string; selected: string; zoom: number; onSelect: (key: string) => void;
}) {
  if (!files.length) return <p className="fr-empty">当前路径没有匹配文件。</p>;
  return <section data-zoom-surface className="fr-files" style={{ zoom }} aria-label={label + '相关文件'}>
    <h3>{label}<small>{files.length} 个文件</small></h3>
    {files.map(file => <button key={file.path} className="fr-file" data-file-path={file.path} data-zoom-anchor
      aria-pressed={selected === 'file:' + file.path} onClick={() => onSelect('file:' + file.path)}>
      <span><strong>{file.title}</strong><code>{file.path}</code></span>
      <span>{file.description}</span>
    </button>)}
  </section>;
}
