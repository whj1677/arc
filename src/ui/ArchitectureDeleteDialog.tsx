import React, { useEffect, useRef, useState } from 'react';
import { applyModuleDelete, moduleReferencePaths, type ArchitectureDocument, type ModuleDeleteImpact } from '../architecture-workspace';
import type { ArchitectureEditor } from './useArchitectureDocument';

type Strategy = 'reparent_children' | 'delete_subtree';
export function draftDeleteImpact(doc: ArchitectureDocument, moduleId: string, strategy: Strategy | '') {
  const childrenByParent = new Map<string, ArchitectureDocument['modules']>();
  for (const m of doc.modules) {
    if (!m.parent_id) continue;
    const siblings = childrenByParent.get(m.parent_id);
    if (siblings) siblings.push(m);
    else childrenByParent.set(m.parent_id, [m]);
  }
  const children = childrenByParent.get(moduleId) ?? [];
  const descendants = new Set([moduleId]);
  for (const id of descendants) for (const m of childrenByParent.get(id) ?? []) descendants.add(m.id);
  const removedIds = strategy === 'delete_subtree' ? descendants : new Set([moduleId]);
  const relations = doc.relations.filter(r => removedIds.has(r.from) || removedIds.has(r.to));
  return { children, descendantCount: descendants.size - 1, removedIds, relations };
}

export function DeleteImpactDetails({ doc, moduleId, strategy, choose, features }: {
  doc: ArchitectureDocument; moduleId: string; strategy: Strategy | ''; choose: (value: Strategy) => void;
  features?: ModuleDeleteImpact['referenced_features'];
}) {
  const { children, descendantCount, relations } = draftDeleteImpact(doc, moduleId, strategy);
  const moduleName = (id: string) => doc.modules.find(m => m.id === id)!.name;
  return <>
    <p>直接子模块（{children.length}） · 全部后代（{descendantCount}）</p>
    {children.length > 0 && <><ul>{children.map(m => <li key={m.id}>{m.name}</li>)}</ul>
      <fieldset><legend>删除范围</legend>
        <label className="row"><input aria-label="仅删除此分组，子模块移至上层" type="radio" name="delete-strategy" checked={strategy === 'reparent_children'} onChange={() => choose('reparent_children')} />仅删除此分组，子模块移至上层</label>
        <label className="row"><input aria-label="一并移除此分组及其子模块" type="radio" name="delete-strategy" checked={strategy === 'delete_subtree'} onChange={() => choose('delete_subtree')} />一并移除此分组及其子模块</label>
      </fieldset></>}
    <h3>{!strategy && children.length ? '分组直接关联' : '将移除的关系'}（{relations.length}）</h3>
    <ul>{relations.map(r => <li key={r.id}>{moduleName(r.from)} → {moduleName(r.to)} · {r.label}</li>)}</ul>
    <h3>关联功能与走读{features && '（' + features.length + '）'}</h3>
    {features && <ul>{features.map(f => <li key={f.id}>{f.title}</li>)}</ul>}
    <p>源码和功能走读数据不会被删除。</p>
  </>;
}

export function ArchitectureDeleteDialog({ editor, moduleId, close, deleted }: {
  editor: ArchitectureEditor; moduleId: string; close: () => void; deleted: () => void;
}) {
  const doc = editor.draftDoc!;
  const saved = editor.savedDoc!;
  const dialog = useRef<HTMLDialogElement>(null);
  const [strategy, choose] = useState<Strategy | ''>('');
  const [review, setReview] = useState<{ scope: Strategy | ''; features?: ModuleDeleteImpact['referenced_features']; error?: string }>();
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  useEffect(() => {
    let current = true;
    const { removedIds } = draftDeleteImpact(doc, moduleId, strategy);
    const paths = doc.modules.filter(m => removedIds.has(m.id)).map(moduleReferencePaths);
    const draftPaths = { files: [...new Set(paths.flatMap(p => p.files))], directories: [...new Set(paths.flatMap(p => p.directories))] };
    const savedModule = saved.modules.find(m => m.id === moduleId);
    if (!savedModule && !draftPaths.files.length && !draftPaths.directories.length) {
      setReview({ scope: strategy, features: [] });
      return;
    }
    // The persisted service owns walkthrough lookup. A subtree can be matched in one query by unioning its current paths.
    void window.arc.invoke<ModuleDeleteImpact>('architecture_delete_impact', {
      project_id: saved.project_id, branch_key: saved.branch_key, module_id: moduleId, draft_paths: draftPaths,
    }).then(impact => { if (current) setReview({ scope: strategy, features: impact.referenced_features }); })
      .catch(e => { if (current) setReview({ scope: strategy, error: String(e) }); });
    return () => { current = false; };
  }, [saved, doc, moduleId, strategy]);
  const features = review?.scope === strategy ? review.features : undefined;
  const error = review?.scope === strategy && review.error;
  const hasChildren = doc.modules.some(m => m.parent_id === moduleId);
  const canDelete = !!features && (!hasChildren || !!strategy);
  return <dialog ref={dialog} aria-label="确认删除模块" onCancel={close}>
    <div className="modal-heading"><h2>删除模块 · {doc.modules.find(m => m.id === moduleId)!.name}</h2></div>
    <div className="settings-body">
      <DeleteImpactDetails doc={doc} moduleId={moduleId} strategy={strategy} choose={choose} features={features} />
      {error ? <p role="alert">删除影响查询失败 · {error}</p> : !features && <p role="status">正在查询关联功能与走读…</p>}
      <div className="row end"><button onClick={close}>取消</button>
        <button disabled={!canDelete} onClick={() => {
          editor.updateDraft(d => applyModuleDelete(d, moduleId, strategy || 'reparent_children').doc);
          close(); deleted();
        }}>确认删除</button></div>
    </div>
  </dialog>;
}
