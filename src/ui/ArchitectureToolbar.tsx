import React, { useState } from 'react';
import type { ArchitectureDocument, ArchitectureModule, ArchitectureRelation, CodeBinding } from '../architecture-workspace';
import type { ArchitectureEditor } from './useArchitectureDocument';
import { edgeNames } from './Graph';
import { edgeSelection } from './reading-target';
import { CodeLinkEditor } from './ArchitectureCodeLinks';
import { ArchitectureUpdatePanel, type ArchitectureReviewActions } from './ArchitectureUpdatePanel';

const updateLabels = {
  updating: '更新中', changes_pending: '有变化待分析', up_to_date: '已分析至指定版本',
  needs_review: '需人工复核', update_failed: '更新失败', partial: '部分完成',
};

function AddItem({ kind, doc, editor, finish, cancel }: {
  kind: 'module' | 'relation'; doc: ArchitectureDocument; editor: ArchitectureEditor;
  finish: (id: string) => void; cancel: () => void;
}) {
  const [from, setFrom] = useState(doc.modules[0]?.id ?? '');
  const [to, setTo] = useState(doc.modules[1]?.id ?? from);
  const [links, setLinks] = useState<CodeBinding[]>([]);
  const options = doc.modules.map(m => <option key={m.id} value={m.id}>{m.name}</option>);
  const module = kind === 'module';
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const value = (name: string) => String(data.get(name) ?? '').trim();
    const id = crypto.randomUUID(), updated_at = new Date().toISOString();
    if (module) {
      const item: ArchitectureModule = { id, name: value('name'), summary: value('summary'), notes: value('notes'),
        layer: value('layer') as ArchitectureModule['layer'], parent_id: value('parent') || undefined,
        kind: 'stage', origin: 'manual', implementation_status: value('status') as ArchitectureModule['implementation_status'],
        code_links: links, evidence: [], updated_at };
      editor.updateDraft(d => ({ ...d, modules: [...d.modules, item] }));
      finish(id);
    } else {
      const item: ArchitectureRelation = { id, from, to, kind: value('kind') as ArchitectureRelation['kind'],
        label: value('label') || edgeNames[value('kind')], notes: value('notes'), origin: 'manual', status: 'manual', evidence: [], updated_at };
      editor.updateDraft(d => ({ ...d, relations: [...d.relations, item] }));
      finish(edgeSelection(id));
    }
  }
  return <form className="architecture-quick-form" aria-label={module ? '新增模块' : '新增关系'} onSubmit={submit}>
    {module ? <>
      <label>名称<input aria-label="名称" name="name" required pattern=".*\S.*" autoFocus /></label>
      <label>所属分层<select aria-label="所属分层" name="layer" defaultValue="core"><option value="entry">入口层</option><option value="core">核心层</option><option value="foundation">底层</option></select></label>
      <label>父模块<select aria-label="父模块" name="parent"><option value="">无</option>{options}</select></label>
      <label>实现状态<select aria-label="实现状态" name="status" defaultValue="planned"><option value="planned">规划中</option><option value="implemented">已实现</option><option value="needs_verification">待核实</option></select></label>
      <label>职责<textarea aria-label="职责" name="summary" rows={2}/></label><label>人工说明<textarea aria-label="人工说明" name="notes" rows={2}/></label>
      <div className="architecture-form-wide"><CodeLinkEditor links={links} onChange={setLinks}/></div>
    </> : <>
      <label>起点<select aria-label="起点" value={from} onChange={e => setFrom(e.target.value)} required>{options}</select></label>
      <label>终点<select aria-label="终点" value={to} onChange={e => setTo(e.target.value)} required>{options}</select></label>
      <button type="button" onClick={() => { setFrom(to); setTo(from); }}>反转方向</button>
      <label>关系类型<select aria-label="关系类型" name="kind" defaultValue="dependency">{Object.entries(edgeNames).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
      <label>说明/标签<input aria-label="说明/标签" name="label"/></label><label>人工备注<textarea aria-label="人工备注" name="notes" rows={2}/></label>
    </>}
    <div className="architecture-form-actions"><button type="submit" className="primary">{module ? '添加模块' : '添加关系'}</button><button type="button" onClick={cancel}>关闭</button></div>
  </form>;
}

export function ArchitectureToolbar({ editor, doc, width, select, openExport, openEvidence, onReviewResolved }: ArchitectureReviewActions & {
  editor: ArchitectureEditor; doc: ArchitectureDocument; width: number; select: (id: string) => void;
  openExport: () => void;
}) {
  const [panel, setPanel] = useState<'module' | 'relation' | 'hidden' | 'updates' | null>(null);
  const [version, setVersion] = useState({ head: doc.version, selected: doc.version });
  const selectedVersion = version.head === doc.version ? version.selected : doc.version;
  const hiddenModules = doc.modules.filter(m => m.hidden), hiddenRelations = doc.relations.filter(r => r.hidden);
  const hiddenCount = hiddenModules.length + hiddenRelations.length;
  const saving = editor.saveState === 'saving';
  const busy = editor.updateBusy !== 'idle';
  const saved = editor.savedDoc ?? doc;
  const baseline = saved.last_update?.read_baseline ?? saved.baseline;
  const stale = saved.last_update?.post_check_consistent === false;
  const unreliable = saved.pending_changes_summary?.detection_reliable === false;
  let execution = saved.update_status;
  if (editor.updateBusy === 'updating') execution = 'updating';
  else if (execution === 'up_to_date' && (stale || unreliable)) execution = 'changes_pending';
  const unverified = execution === 'up_to_date' && Boolean(editor.loadError);
  const executionLabel = unverified ? '状态待检查' : execution === 'up_to_date' && !baseline ? '尚无分析基线' : updateLabels[execution];
  const statusTitle = execution === 'up_to_date' && baseline && !unverified
    ? `已完成对应范围分析 · 分支 ${baseline.branch ?? saved.branch_key} · 提交 ${baseline.commit ?? '无'} · 快照 ${baseline.snapshot_id}`
    : execution === 'partial' ? '部分范围已完成分析，仍有失败项或待复核建议。' : executionLabel;
  const remaining = saved.review_items.filter(i => i.status === 'pending' || i.status === 'deferred').length;
  const toggleUpdates = () => setPanel(panel === 'updates' ? null : 'updates');
  const warnings = <>
    {stale && <p className="architecture-update-warning" role="alert">{saved.last_update!.stale_reason ?? '分析期间工作区已变化，请重新检查更新。'}</p>}
    {unreliable && <p className="architecture-update-warning" role="alert">{saved.pending_changes_summary!.detection_error ?? '无法可靠检测工作区变化。'}</p>}
  </>;
  function restoreHidden(kind?: 'module' | 'relation', id?: string) {
    if (!editor.editMode) editor.enterEditMode();
    editor.updateDraft(d => ({ ...d,
      modules: d.modules.map(m => m.hidden && (!kind || (kind === 'module' && id === m.id)) ? { ...m, hidden: false } : m),
      relations: d.relations.map(r => r.hidden && (!kind || (kind === 'relation' && id === r.id)) ? { ...r, hidden: false } : r),
    }));
  }
  const status = saving ? '保存中...' : editor.saveState === 'error' ? '保存失败' : editor.dirty ? '未保存'
    : editor.saveState === 'saved' ? '保存成功' : doc.version ? '已保存 v' + doc.version : '未保存';
  return <div className="architecture-maintenance">
    <fieldset className="architecture-maintenance-tools" disabled={saving} aria-label="架构维护">
      <span className="tag" title="当前分支">{doc.branch_key}</span>
      <button disabled={!editor.savedDoc?.version && !editor.dirty} onClick={openExport}>导出</button>
      {editor.editMode ? <>
        <button disabled={editor.maintenanceBusy} onClick={() => setPanel('module')}>新增模块</button>
        <button disabled={editor.maintenanceBusy || !doc.modules.length} onClick={() => setPanel('relation')}>新增关系</button>
        <button disabled={editor.maintenanceBusy} onClick={() => editor.applyAutoLayout(width)}>自动布局</button>
        <button className="primary" disabled={!editor.dirty || busy} onClick={() => { setPanel(null); void editor.saveDraft(); }}>保存</button>
        <button disabled={editor.maintenanceBusy} onClick={() => { setPanel(null); editor.cancelEdit(); }}>取消</button>
      </> : <button className="primary" disabled={editor.maintenanceBusy} onClick={() => editor.enterEditMode()}>编辑架构</button>}
      <span role="status" className={'architecture-save-status ' + editor.saveState} title={editor.saveError}>{status}</span>
      {editor.versions.length > 0 && <><select aria-label="版本" value={selectedVersion} onChange={e => setVersion({ head: doc.version, selected: Number(e.target.value) })}>
        {editor.versions.map(v => <option key={v.version} value={v.version}>版本 v{v.version}</option>)}
      </select><button disabled={editor.dirty || busy} onClick={() => { setPanel(null); void editor.restoreVersion(selectedVersion); }}>恢复</button></>}
      {hiddenCount > 0 && <button aria-expanded={panel === 'hidden'} onClick={() => setPanel(panel === 'hidden' ? null : 'hidden')}>已隐藏 {hiddenCount}</button>}
      <button disabled={busy} onClick={() => { setPanel('updates'); void editor.checkUpdates(); }}>检查更新</button>
      <button disabled={busy || editor.dirty} title={editor.dirty ? '请先保存或取消草稿，再更新受影响部分。' : undefined}
        onClick={() => { setPanel('updates'); void editor.updateAffected(); }}>更新受影响部分</button>
      <button aria-expanded={panel === 'updates'} onClick={toggleUpdates}>待复核 ({remaining})</button>
      <button className={'architecture-execution-pill ' + execution} title={statusTitle} aria-expanded={panel === 'updates'}
        onClick={toggleUpdates}>{executionLabel}</button>
      {editor.updateBusy === 'checking' && <span role="status">正在检查变化…</span>}
      {editor.updateBusy === 'resolving' && <span role="status">正在保存复核决定…</span>}
    </fieldset>
    {editor.saveError && <p className="architecture-error" role="alert">{editor.saveError}</p>}
    {editor.updateError && <p className="architecture-update-warning" role="alert">{editor.updateError}</p>}
    {panel === 'updates' ? <ArchitectureUpdatePanel editor={editor} doc={saved} openEvidence={openEvidence}
      onReviewResolved={onReviewResolved} warnings={warnings}/> : warnings}
    {panel === 'hidden' && hiddenCount > 0 && <section className="architecture-hidden-panel" aria-label="已隐藏项目">
      {hiddenModules.map(m => <div key={m.id}>{m.name}<button disabled={editor.maintenanceBusy} onClick={() => restoreHidden('module', m.id)}>恢复显示</button></div>)}
      {hiddenRelations.map(r => <div key={r.id}>{r.label}<button disabled={editor.maintenanceBusy} onClick={() => restoreHidden('relation', r.id)}>恢复显示</button></div>)}
      <button disabled={editor.maintenanceBusy} onClick={() => restoreHidden()}>全部恢复显示</button>
    </section>}
    {editor.editMode && (panel === 'module' || panel === 'relation') && <fieldset className="architecture-detail-fields" disabled={editor.maintenanceBusy}>
      <AddItem key={panel} doc={doc} editor={editor} kind={panel} finish={id => { setPanel(null); select(id); }} cancel={() => setPanel(null)}/>
    </fieldset>}
  </div>;
}
