import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ArchitectureDocument } from '../architecture-workspace';
import { architectureExportStatus, computeArchitectureScope, computeModuleSubgraph } from '../export/diagram-svg';
import { availableFeatureViews, featurePaths, featureViewNames, type FeatureDiagramView } from '../export/feature-svg';
import type { Explanation, Snapshot } from '../shared';
import { exportSavedDiagram, readExportVersion, type FileFormat, type Resolution } from './diagram-export';
import type { ArchitectureEditor } from './useArchitectureDocument';

type ArchitectureProps = {
  mode: 'architecture'; editor: ArchitectureEditor; projectName: string; selected: string; search: string; columns: number;
};
type FeatureProps = {
  mode: 'feature'; explanation: Explanation; projectName: string; featureName: string; scenarioTitle: string;
  snapshot?: Snapshot; initialView: FeatureDiagramView; initialPath?: string;
};
type Props = (ArchitectureProps | FeatureProps) & { close: () => void };
type Submit = (format: FileFormat, resolution: Resolution) => Promise<{ canceled: boolean }>;

function ExportForm({ children, disabled, submit, close }: {
  children: React.ReactNode; disabled?: boolean; submit: Submit; close: () => void;
}) {
  const [format, setFormat] = useState<FileFormat>('svg');
  const [resolution, setResolution] = useState<Resolution>('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form onSubmit={async e => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (!(await submit(format, resolution)).canceled) close();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }}>
    <fieldset className="diagram-export-fields" disabled={busy}>
      {children}
      <div className="diagram-export-options">
        <label>文件格式<select aria-label="文件格式" value={format} onChange={e => setFormat(e.target.value as FileFormat)}>
          <option value="svg">SVG（独立矢量，无损缩放）</option><option value="png">PNG（高清位图，适合 PPT/Word/汇报）</option>
        </select></label>
        {format === 'png' && <label>分辨率<select aria-label="分辨率" value={resolution} onChange={e => setResolution(e.target.value as Resolution)}>
          <option value="standard">标准 2x</option><option value="hd">高清 3x</option><option value="auto_large">大图自适应</option>
        </select></label>}
      </div>
      {error && <p role="alert" className="error-banner">{error}</p>}
      <div className="row end"><button type="button" onClick={close}>取消</button>
        <button className="primary" type="submit" disabled={disabled}>{busy ? '正在导出…' : '确认导出'}</button></div>
    </fieldset>
  </form>;
}

function ArchitectureExport({ editor, selected, search, columns, projectName, close }: ArchitectureProps & { close: () => void }) {
  // Pin the version shown at open, even if background work publishes a new head.
  const [head, setHead] = useState(editor.savedDoc!);
  const [version, setVersion] = useState(head.version);
  const [dirtyChoice, setDirtyChoice] = useState(editor.dirty);
  const [historical, setHistorical] = useState<ArchitectureDocument>();
  const [error, setError] = useState('');
  const [scope, setScope] = useState('whole');
  const [requestedRoot, setRoot] = useState(selected);
  const [includeChildren, setChildren] = useState(true);
  const [includeNeighbors, setNeighbors] = useState(false);
  useEffect(() => {
    setError('');
    if (version === head.version) return;
    let active = true;
    readExportVersion(window.arc.invoke, { ...head, version }).then(doc => {
      if (active) setHistorical(doc);
    }, e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [head, version]);
  const doc = version === head.version ? head : historical?.version === version ? historical : undefined;
  const roots = doc?.modules.filter(m => !m.hidden) ?? [];
  const rootId = roots.find(m => m.id === requestedRoot)?.id ?? roots[0]?.id;
  const preview = useMemo(() => {
    if (!doc) return;
    if (scope === 'whole') return { ...computeArchitectureScope(doc, search), externalInbound: [], externalOutbound: [] };
    if (rootId) return computeModuleSubgraph(doc, rootId, { includeChildren, includeNeighbors });
  }, [doc, scope, rootId, search, includeChildren, includeNeighbors]);

  if (dirtyChoice) return <div className="settings-body">
    <p role="alert" className="architecture-update-warning">当前架构有未保存的修改。请选择本次导出的版本。</p>
    {error && <p role="alert" className="error-banner">{error}</p>}
    <div className="row end"><button onClick={close} disabled={editor.saveState === 'saving'}>取消</button>
      <button disabled={!head.version || editor.saveState === 'saving'} onClick={() => { setError(''); setDirtyChoice(false); }}>导出已保存版本 (v{head.version})</button>
      <button className="primary" disabled={editor.saveState === 'saving' || editor.updateBusy !== 'idle'} onClick={async () => {
        const saved = await editor.saveDraft();
        if (!saved.document) { setError(saved.error); return; }
        setHead(saved.document); setVersion(saved.document.version); setDirtyChoice(false);
      }}>{editor.saveState === 'saving' ? '正在保存…' : '保存并导出'}</button></div>
  </div>;

  const confirmed = head.last_confirmed_version;
  const boundary = preview
    ? [...preview.externalInbound.map(r => r.from), ...preview.externalOutbound.map(r => r.to)] : [];
  const names = new Map(roots.map(m => [m.id, m.name]));
  return <ExportForm close={close} disabled={!preview?.includedModules.length} submit={(format, resolution) =>
    exportSavedDiagram(window.arc.invoke, { mode: 'architecture', key: { ...head, version }, options: {
      projectName, search, columns, includeHidden: false, selectedModuleId: scope === 'subgraph' ? rootId : undefined,
      subgraphOptions: { includeChildren, includeNeighbors },
    } }, format, resolution)}>
    <label>保存版本<select aria-label="保存版本" value={version} onChange={e => setVersion(Number(e.target.value))}>
      <option value={head.version}>当前已保存版本 (v{head.version}) · {architectureExportStatus(head)}</option>
      {confirmed && confirmed !== head.version && <option value={confirmed}>最近已确认版本 (v{confirmed})</option>}
      {editor.versions.filter(v => v.version !== head.version && v.version !== confirmed).map(v =>
        <option value={v.version} key={v.version}>v{v.version} · {v.title}</option>)}
    </select></label>
    <label>导出范围<select aria-label="导出范围" value={scope} onChange={e => setScope(e.target.value)}>
      <option value="whole">当前图完整范围</option><option value="subgraph">选定模块子图</option>
    </select></label>
    {scope === 'subgraph' && <>
      <label>根模块<select aria-label="根模块" value={rootId ?? ''} onChange={e => setRoot(e.target.value)}>
        {roots.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label>
      <div className="row">
        <label><input type="checkbox" checked={includeChildren} onChange={e => setChildren(e.target.checked)}/>包含内部子模块</label>
        <label><input type="checkbox" checked={includeNeighbors} onChange={e => setNeighbors(e.target.checked)}/>包含直接邻居</label>
      </div>
    </>}
    {error ? <p role="alert" className="error-banner">{error}</p> : !doc ? <p role="status">正在读取保存版本…</p> :
      <div className="scope-box" aria-label="范围预览"><strong>v{version} · {architectureExportStatus(doc)}</strong>
        <p>{preview?.includedModules.length ?? 0} 个模块 · {preview?.internalRelations.length ?? 0} 条内部关系 · 已隐藏 {preview?.hiddenExcludedCount ?? 0} 项</p>
        {scope === 'whole' && search && <p>搜索条件 · {search}</p>}
        {scope === 'subgraph' && <><p>{preview?.includedModules.map(m => m.name).join('、')}</p>
          <p>外部连接 {boundary.length} 条 {boundary.map(id => '[外部] ' + names.get(id)).join('、')}</p></>}
      </div>}
  </ExportForm>;
}

function FeatureExport(props: FeatureProps & { close: () => void }) {
  const [source] = useState(() => ({ ...props, explanation: structuredClone(props.explanation) }));
  const { explanation, projectName, featureName, scenarioTitle, snapshot } = source;
  const views = availableFeatureViews(explanation);
  const [view, setView] = useState(views.includes(source.initialView) ? source.initialView : views[0]);
  const [path, setPath] = useState(source.initialPath);
  const paths = featurePaths(explanation, view);
  const pathId = paths.find(p => p.id === path)?.id ?? paths[0]?.id;
  return <ExportForm close={props.close} disabled={!view} submit={(format, resolution) =>
    exportSavedDiagram(window.arc.invoke, { mode: 'feature', options: { explanation, projectName, featureName,
      scenarioTitle, snapshot, diagramView: view, pathId } }, format, resolution)}>
    <div className="scope-box"><strong>{featureName} · {scenarioTitle}</strong><p>走读版本 {explanation.result_id}</p>
      <p>源码快照 {explanation.result.binding.source_snapshot_id} · 来源状态 {explanation.source_status}</p></div>
    <label>图表视图<select aria-label="图表视图" value={view} onChange={e => setView(e.target.value as FeatureDiagramView)}>
      {views.map(v => <option value={v} key={v}>{featureViewNames[v]}</option>)}</select></label>
    {paths.length > 0 && <label>路径<select aria-label="路径" value={pathId} onChange={e => setPath(e.target.value)}>
      {paths.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
  </ExportForm>;
}

export function DiagramExportDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog className="diagram-export-dialog" ref={dialog} aria-label="导出图表" onCancel={e => {
    e.preventDefault();
    if (!dialog.current?.querySelector('fieldset:disabled') && !(props.mode === 'architecture' && props.editor.saveState === 'saving')) props.close();
  }}>
    <div className="modal-heading"><h2>导出图表</h2></div>
    {props.mode === 'architecture' ? <ArchitectureExport {...props}/> : <FeatureExport {...props}/>}
  </dialog>;
}
