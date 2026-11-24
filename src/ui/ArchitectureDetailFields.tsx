import React, { useState } from 'react';
import {
  applyRelationDelete, wouldCreateHierarchyCycle,
  type ArchitectureModule, type ArchitectureRelation, type CodeBinding,
} from '../architecture-workspace';
import type { Snapshot, SourceEvidence } from '../shared';
import { CodeLinkEditor } from './ArchitectureCodeLinks';
import { ArchitectureDeleteDialog } from './ArchitectureDeleteDialog';
import { edgeNames } from './Graph';
import { SourceExcerpt } from './SourceExcerpt';
import type { ArchitectureEditor } from './useArchitectureDocument';

const origins = { code_analysis: '代码分析', manual: '人工补充', manual_override: '人工修订', needs_verification: '待核实' };
const statuses = { implemented: '已实现', planned: '规划中', needs_verification: '待核实' };
const layers = { entry: '入口层', core: '核心层', foundation: '底层' };
const relationStatuses = { confirmed: '已确认', inferred: '推断', needs_verification: '待核实', manual: '人工确认' };
const options = (labels: Record<string, string>) => Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>);
function revised(origin: ArchitectureModule['origin']) { return origin === 'manual' ? origin : 'manual_override'; }

function BindingPreview({ link, snapshot }: { link: CodeBinding; snapshot?: Snapshot }) {
  const [expanded, setExpanded] = useState(false);
  const [path, setPath] = useState('');
  const directory = link.kind === 'directory';
  const prefix = link.path.replace(/\/$/, '');
  const files = expanded && directory ? snapshot?.files.filter(file => prefix === '.' || file.path.startsWith(prefix + '/')) ?? [] : [];
  const file = expanded && snapshot?.files.find(item => item.path === (directory ? path : link.path));
  const first = link.start_line ?? 1;
  const evidence: SourceEvidence | undefined = file && snapshot ? {
    evidence_id: link.id, source_snapshot_id: snapshot.source_snapshot_id, path: file.path,
    line_start: first, line_end: link.end_line ?? first, content_sha256: link.file_sha256 ?? file.content_sha256,
    role: 'context', note: '代码关联',
  } : undefined;
  return <div><button className="module-partner" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
    {link.path}{link.symbol_name && ' · ' + link.symbol_name}{link.start_line && ' · L' + link.start_line}
  </button>
    {expanded && directory && files.length > 0 && <label>目录内文件<select aria-label="目录内文件" value={path} onChange={e => setPath(e.target.value)}>
      <option value="">选择冻结文件</option>{files.map(f => <option key={f.path}>{f.path}</option>)}</select></label>}
    {evidence ? <SourceExcerpt key={evidence.path} evidence={evidence} /> : expanded && (!directory || !files.length) &&
      <p role="status">冻结快照中找不到此关联位置。</p>}
  </div>;
}

interface DetailProps { editor: ArchitectureEditor; select: (id: string) => void }
export function ModuleMaintenance({ module: m, editor, snapshot, select }: DetailProps & { module: ArchitectureModule; snapshot?: Snapshot }) {
  const [parentError, setParentError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const doc = editor.doc!;
  const update = (changes: Partial<ArchitectureModule>) => editor.updateDraft(d => ({ ...d, modules: d.modules.map(item =>
    item.id === m.id ? { ...item, ...changes, origin: revised(item.origin), updated_at: new Date().toISOString() } : item) }));
  function parent(id: string) {
    if (wouldCreateHierarchyCycle(doc.modules, m.id, id || undefined)) {
      setParentError('父模块不能是模块自身或其子孙模块。'); return;
    }
    setParentError('');
    update({ parent_id: id || undefined });
  }
  return <>
    <div className="row"><span className="tag">{origins[m.origin]}</span><span className="tag">{statuses[m.implementation_status]}</span></div>
    {editor.editMode ? <fieldset className="architecture-detail-fields" disabled={editor.saveState === 'saving'}>
      <label>名称<input value={m.name} onChange={e => update({ name: e.target.value })} /></label>
      <label>职责<textarea aria-label="职责" value={m.summary} onChange={e => update({ summary: e.target.value })} /></label>
      <label>人工说明<textarea aria-label="人工说明" value={m.notes ?? ''} onChange={e => update({ notes: e.target.value })} /></label>
      <label>所属分层<select aria-label="所属分层" value={m.layer} onChange={e => update({ layer: e.target.value as ArchitectureModule['layer'] })}>{options(layers)}</select></label>
      <label>父模块<select aria-label="父模块" value={m.parent_id ?? ''} onChange={e => parent(e.target.value)}>
        <option value="">无父模块</option>{doc.modules.filter(candidate => !wouldCreateHierarchyCycle(doc.modules, m.id, candidate.id))
          .map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select></label>
      {parentError && <p role="alert">{parentError}</p>}
      <label>实现状态<select aria-label="实现状态" value={m.implementation_status} onChange={e => update({ implementation_status: e.target.value as ArchitectureModule['implementation_status'] })}>{options(statuses)}</select></label>
      <CodeLinkEditor links={m.code_links} onChange={links => update({ code_links: links })} />
      <div className="row"><button onClick={() => { editor.updateDraft(d => ({ ...d, modules: d.modules.map(item => item.id === m.id ? { ...item, hidden: true } : item) })); select(''); }}>隐藏模块</button>
        <button onClick={() => setDeleting(true)}>删除模块</button></div>
      {deleting && <ArchitectureDeleteDialog editor={editor} moduleId={m.id} close={() => setDeleting(false)} deleted={() => select('')} />}
    </fieldset> : <>
      <div className="row"><span>所属分层 · {layers[m.layer]}</span><span>父模块 · {doc.modules.find(item => item.id === m.parent_id)?.name ?? '无'}</span></div>
      <section><h3>人工说明</h3><p>{m.notes || '暂无人工说明'}</p></section>
    </>}
    <section className="system-sources"><h3>代码关联</h3>{m.code_links.length ? m.code_links.map(link =>
      <BindingPreview key={link.id + '/' + link.path} link={link} snapshot={snapshot} />) : <p className="muted">尚未关联源码位置。</p>}</section>
  </>;
}

export function reviseRelation(item: ArchitectureRelation, changes: Partial<ArchitectureRelation>): ArchitectureRelation {
  const moved = (changes.from !== undefined && changes.from !== item.from) || (changes.to !== undefined && changes.to !== item.to);
  return { ...item, ...changes, ...(moved && { transfers: undefined }), origin: revised(item.origin), status: 'manual',
    updated_at: new Date().toISOString() };
}

export function RelationMaintenance({ relation: r, editor, select }: DetailProps & { relation: ArchitectureRelation }) {
  const doc = editor.doc!;
  const update = (changes: Partial<ArchitectureRelation>) => editor.updateDraft(d => ({ ...d, relations: d.relations.map(item =>
    item.id === r.id ? reviseRelation(item, changes) : item) }));
  const endpoints = doc.modules.map(module => <option key={module.id} value={module.id}>{module.name}</option>);
  return <>
    <div className="row"><span className="tag">{origins[r.origin]}</span><span className="tag">{relationStatuses[r.status]}</span></div>
    {editor.editMode ? <fieldset className="architecture-detail-fields" disabled={editor.saveState === 'saving'}>
      <label>起点<select aria-label="起点" value={r.from} onChange={e => update({ from: e.target.value })}>{endpoints}</select></label>
      <label>终点<select aria-label="终点" value={r.to} onChange={e => update({ to: e.target.value })}>{endpoints}</select></label>
      <button onClick={() => update({ from: r.to, to: r.from })}>反转方向</button>
      <label>关系类型<select aria-label="关系类型" value={r.kind} onChange={e => update({ kind: e.target.value as ArchitectureRelation['kind'] })}>{options(edgeNames)}</select></label>
      <label>说明/标签<input value={r.label} onChange={e => update({ label: e.target.value })} /></label>
      <label>人工备注<textarea aria-label="人工备注" value={r.notes ?? ''} onChange={e => update({ notes: e.target.value })} /></label>
      <div className="row"><button onClick={() => { editor.updateDraft(d => ({ ...d, relations: d.relations.map(item => item.id === r.id ? { ...item, hidden: true } : item) })); select(''); }}>隐藏关系</button>
        <button onClick={() => { editor.updateDraft(d => applyRelationDelete(d, r.id)); select(''); }}>删除关系</button></div>
    </fieldset> : <section><h3>人工备注</h3><p>{r.notes || '暂无人工备注'}</p></section>}
  </>;
}
