import React, { useState } from 'react';
import type { ArchitectureDocument, ArchitectureModule, ArchitectureRelation, CodeBinding } from '../architecture-workspace';
import type { ArchitectureEditor } from './useArchitectureDocument';
import { edgeNames } from './Graph';
import { edgeSelection } from './reading-target';
import { CodeLinkEditor } from './ArchitectureCodeLinks';

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
      <label>名称<input name="name" required pattern=".*\S.*" autoFocus /></label>
      <label>所属分层<select name="layer" defaultValue="core"><option value="entry">入口层</option><option value="core">核心层</option><option value="foundation">底层</option></select></label>
      <label>父模块<select name="parent"><option value="">无</option>{options}</select></label>
      <label>实现状态<select name="status" defaultValue="planned"><option value="planned">规划中</option><option value="implemented">已实现</option><option value="needs_verification">待核实</option></select></label>
      <label>职责<textarea name="summary" rows={2}/></label><label>人工说明<textarea name="notes" rows={2}/></label>
      <div className="architecture-form-wide"><CodeLinkEditor links={links} onChange={setLinks}/></div>
    </> : <>
      <label>起点<select value={from} onChange={e => setFrom(e.target.value)} required>{options}</select></label>
      <label>终点<select value={to} onChange={e => setTo(e.target.value)} required>{options}</select></label>
      <button type="button" onClick={() => { setFrom(to); setTo(from); }}>反转方向</button>
      <label>关系类型<select name="kind" defaultValue="dependency">{Object.entries(edgeNames).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
      <label>说明/标签<input name="label"/></label><label>人工备注<textarea name="notes" rows={2}/></label>
    </>}
    <div className="architecture-form-actions"><button type="submit" className="primary">{module ? '添加模块' : '添加关系'}</button><button type="button" onClick={cancel}>关闭</button></div>
  </form>;
}

export function ArchitectureToolbar({ editor, doc, width, select }: {
  editor: ArchitectureEditor; doc: ArchitectureDocument; width: number; select: (id: string) => void;
}) {
  const [panel, setPanel] = useState<'module' | 'relation' | 'hidden' | null>(null);
  const [version, setVersion] = useState({ head: doc.version, selected: doc.version });
  const selectedVersion = version.head === doc.version ? version.selected : doc.version;
  const hiddenModules = doc.modules.filter(m => m.hidden), hiddenRelations = doc.relations.filter(r => r.hidden);
  const hiddenCount = hiddenModules.length + hiddenRelations.length;
  const saving = editor.saveState === 'saving';
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
      {editor.editMode ? <>
        <button onClick={() => setPanel('module')}>新增模块</button>
        <button disabled={!doc.modules.length} onClick={() => setPanel('relation')}>新增关系</button>
        <button onClick={() => editor.applyAutoLayout(width)}>自动布局</button>
        <button className="primary" disabled={!editor.dirty} onClick={() => { setPanel(null); void editor.saveDraft(); }}>保存</button>
        <button onClick={() => { setPanel(null); editor.cancelEdit(); }}>取消</button>
      </> : <button className="primary" onClick={() => editor.enterEditMode()}>编辑架构</button>}
      <span role="status" className={'architecture-save-status ' + editor.saveState} title={editor.saveError}>{status}</span>
      {editor.versions.length > 0 && <><select aria-label="版本" value={selectedVersion} onChange={e => setVersion({ head: doc.version, selected: Number(e.target.value) })}>
        {editor.versions.map(v => <option key={v.version} value={v.version}>版本 v{v.version}</option>)}
      </select><button disabled={editor.dirty} onClick={() => { setPanel(null); void editor.restoreVersion(selectedVersion); }}>恢复</button></>}
      {hiddenCount > 0 && <button aria-expanded={panel === 'hidden'} onClick={() => setPanel(panel === 'hidden' ? null : 'hidden')}>已隐藏 {hiddenCount}</button>}
    </fieldset>
    {editor.saveError && <p className="architecture-error" role="alert">{editor.saveError}</p>}
    {panel === 'hidden' && hiddenCount > 0 && <section className="architecture-hidden-panel" aria-label="已隐藏项目">
      {hiddenModules.map(m => <div key={m.id}>{m.name}<button disabled={saving} onClick={() => restoreHidden('module', m.id)}>恢复显示</button></div>)}
      {hiddenRelations.map(r => <div key={r.id}>{r.label}<button disabled={saving} onClick={() => restoreHidden('relation', r.id)}>恢复显示</button></div>)}
      <button disabled={saving} onClick={() => restoreHidden()}>全部恢复显示</button>
    </section>}
    {editor.editMode && (panel === 'module' || panel === 'relation') && <AddItem key={panel} doc={doc} editor={editor} kind={panel}
      finish={id => { setPanel(null); select(id); }} cancel={() => setPanel(null)}/>}
  </div>;
}
