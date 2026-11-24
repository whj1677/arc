import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { validateArchitectureDocument, type ArchitectureDocument, type ArchitectureVersionSummary, type CodeBaseline } from '../architecture-workspace';
import { computeAutoLayoutPositions } from './architecture-map';
import type { ArcApi } from '../shared';

export type ArchitectureInvoke = ArcApi['invoke'];
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type UpdateBusy = 'idle' | 'checking' | 'updating' | 'resolving';
interface EditorState {
  savedDoc: ArchitectureDocument | null;
  draftDoc: ArchitectureDocument | null;
  doc: ArchitectureDocument | null;
  editMode: boolean;
  dirty: boolean;
  saveState: SaveState;
  saveError?: string;
  loadError?: string;
  updateBusy: UpdateBusy;
  maintenanceBusy: boolean;
  updateError?: string;
  versions: ArchitectureVersionSummary[];
  activeBranch: string;
  branches: string[];
  branchNotice?: string;
}
interface Saved {
  document: ArchitectureDocument;
  versions: ArchitectureVersionSummary[];
}

function compactBaseline({ file_hashes, ...baseline }: CodeBaseline) { return baseline; }
function savePayload(doc: ArchitectureDocument) {
  return {
    ...doc,
    baseline: doc.baseline && compactBaseline(doc.baseline),
    last_update: doc.last_update && { ...doc.last_update, read_baseline: compactBaseline(doc.last_update.read_baseline) },
  };
}

function withCheckMetadata(draft: ArchitectureDocument, saved: ArchitectureDocument) {
  return { ...draft, pending_changes_summary: saved.pending_changes_summary, update_status: saved.update_status };
}

export class ArchitectureEditorStore {
  private state: EditorState = {
    savedDoc: null, draftDoc: null, doc: null, editMode: false, dirty: false, saveState: 'idle',
    versions: [], activeBranch: '', branches: [], updateBusy: 'idle', maintenanceBusy: false,
  };
  private listeners = new Set<() => void>();
  private request = 0;
  private loading = false;
  private refreshPending = false;
  private checkedOnOpen = false;
  constructor(private projectId: string, private invoke: ArchitectureInvoke,
    private drafts = new Map<string, ArchitectureDocument>()) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private patch(patch: Partial<EditorState>) {
    const next = { ...this.state, ...patch };
    next.doc = next.draftDoc ?? next.savedDoc;
    next.editMode = next.draftDoc !== null;
    next.maintenanceBusy = next.saveState === 'saving' || next.updateBusy === 'updating' || next.updateBusy === 'resolving';
    this.state = next;
    this.listeners.forEach(notify => notify());
  }

  load = async () => {
    if (!this.projectId) return;
    if (this.state.saveState === 'saving' || this.state.updateBusy !== 'idle') { this.refreshPending = true; return; }
    const request = ++this.request;
    this.loading = true;
    try {
      const response = await this.invoke<Saved & { active_branch: string; branches: string[] }>('architecture_get', { project_id: this.projectId });
      if (request !== this.request) return;
      const sameBranch = this.state.savedDoc?.branch_key === response.document.branch_key;
      if (!sameBranch) this.checkedOnOpen = false;
      const dirtyDraft = this.drafts.get(response.document.id);
      const draftDoc = dirtyDraft ?? (sameBranch && this.state.editMode ? response.document : null);
      const previous = this.state.draftDoc;
      this.patch({ savedDoc: response.document, versions: response.versions, branches: response.branches,
        activeBranch: response.active_branch, draftDoc, dirty: !!dirtyDraft, loadError: undefined,
        ...(!sameBranch && { saveState: 'idle', saveError: undefined, updateError: undefined,
          branchNotice: previous && this.state.dirty
            ? `当前分支已切换至 ${response.active_branch}。${previous.branch_key} 的未保存草稿已保留，切回该分支可继续编辑。`
            : dirtyDraft ? `已恢复 ${dirtyDraft.branch_key} 的未保存草稿。` : undefined }) });
    } catch (error) {
      if (request === this.request) this.patch({ loadError: String(error instanceof Error ? error.message : error) });
    } finally {
      if (request === this.request) this.loading = false;
    }
  };

  enterEditMode = () => {
    if (this.state.editMode || this.state.maintenanceBusy) return;
    this.patch({ draftDoc: this.state.savedDoc, dirty: false, saveState: 'idle', saveError: undefined });
  };
  cancelEdit = () => {
    if (this.state.saveState === 'saving') return;
    if (this.state.draftDoc) this.drafts.delete(this.state.draftDoc.id);
    this.patch({ draftDoc: null, dirty: false, saveState: 'idle', saveError: undefined, branchNotice: undefined });
  };
  updateDraft = (update: (doc: ArchitectureDocument) => ArchitectureDocument) => {
    const { savedDoc, draftDoc } = this.state;
    if (!draftDoc || !savedDoc || this.state.maintenanceBusy) return;
    const next = update(draftDoc);
    if (next === draftDoc) return;
    const dirty = JSON.stringify(savePayload(withCheckMetadata(next, savedDoc))) !== JSON.stringify(savePayload(savedDoc));
    if (dirty) this.drafts.set(savedDoc.id, next);
    else this.drafts.delete(savedDoc.id);
    this.patch({ draftDoc: next, dirty, saveState: 'idle', saveError: undefined });
  };
  applyAutoLayout = (width: number) => this.updateDraft(doc => ({ ...doc, layout: {
    ...doc.layout, positions: computeAutoLayoutPositions(doc, width), manual_positions: [],
  } }));

  private async runUpdate(busy: Exclude<UpdateBusy, 'idle'>, operation: string, args: Record<string, unknown> = {}) {
    const { savedDoc, dirty, updateBusy, saveState } = this.state;
    if (!savedDoc || updateBusy !== 'idle' || saveState === 'saving') return false;
    if (dirty && busy !== 'checking') {
      this.patch({ updateError: '请先保存或取消当前架构草稿。' });
      return false;
    }
    if (busy === 'checking') this.checkedOnOpen = true;
    this.invalidateLoad();
    this.patch({ updateBusy: busy, updateError: undefined });
    try {
      const { document, versions } = await this.invoke<{ document: ArchitectureDocument; versions?: ArchitectureVersionSummary[] }>(
        operation, { project_id: this.projectId, branch_key: savedDoc.branch_key, ...args });
      const { draftDoc, dirty } = this.state;
      if (!versions && document.version !== savedDoc.version) this.refreshPending = true;
      this.patch({ savedDoc: document, draftDoc: draftDoc && !dirty ? document : draftDoc, loadError: undefined,
        versions: versions ?? this.state.versions,
        branches: [...new Set([...this.state.branches, document.branch_key])] });
      return true;
    } catch (error) {
      this.patch({ updateError: error instanceof Error ? error.message : String(error) });
      // An unsuccessful update may already have persisted an unreliable detection report.
      if (busy === 'updating') this.refreshPending = true;
      return false;
    } finally {
      this.patch({ updateBusy: 'idle' });
      if (this.refreshPending) { this.refreshPending = false; await this.load(); }
    }
  }

  checkUpdates = async (): Promise<void> => { await this.runUpdate('checking', 'architecture_check_updates'); };
  checkOnOpen = async () => {
    if (!this.checkedOnOpen && this.state.savedDoc && this.state.savedDoc.version > 0 && !this.state.editMode && !this.state.dirty)
      await this.checkUpdates();
  };
  updateAffected = async (opts: { moduleIds?: string[]; retryFailedOnly?: boolean } = {}): Promise<void> => {
    await this.runUpdate('updating', 'architecture_update_affected', { module_ids: opts.moduleIds, retry_failed_only: opts.retryFailedOnly });
  };
  resolveReview = (reviewId: string, decision: 'accept' | 'reject' | 'defer', note?: string): Promise<boolean> =>
    this.runUpdate('resolving', 'architecture_review_resolve', { review_id: reviewId, decision, note });

  private invalidateLoad() {
    if (this.loading) this.refreshPending = true;
    this.loading = false;
    ++this.request;
  }

  private async persist(operation: string, args: Record<string, unknown>) {
    const submitted = this.state.draftDoc;
    this.invalidateLoad();
    this.patch({ saveState: 'saving', saveError: undefined });
    try {
      const { document, versions } = await this.invoke<Saved>(operation, { project_id: this.projectId, ...args });
      if (this.drafts.get(document.id) === submitted) this.drafts.delete(document.id);
      this.patch({ savedDoc: document, draftDoc: null, dirty: false, versions, saveState: 'saved', branchNotice: undefined,
        branches: [...new Set([...this.state.branches, document.branch_key])] });
      return { document };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ saveState: 'error', saveError: message });
      return { error: message };
    } finally {
      if (this.refreshPending) { this.refreshPending = false; await this.load(); }
    }
  }
  saveDraft = async () => {
    const { draftDoc, savedDoc, saveState } = this.state;
    if (!draftDoc || !savedDoc || saveState === 'saving' || this.state.updateBusy !== 'idle')
      return { error: '当前草稿无法保存，请等待架构操作完成。' };
    const errors = validateArchitectureDocument(draftDoc);
    if (!errors.length) {
      for (const module of draftDoc.modules) {
        for (const link of module.code_links) {
          if (!link.path.trim()) errors.push(`${module.name} 的代码关联缺少路径。`);
          if ((link.start_line ?? 1) < 1 || (link.end_line ?? Infinity) < (link.start_line ?? 1))
            errors.push(`${module.name} 的代码关联「${link.path}」行号范围无效。`);
        }
      }
    }
    if (draftDoc.version !== savedDoc.version)
      errors.push('架构版本已变化，请取消草稿并基于最新版本重新编辑。');
    if (errors.length) {
      const error = errors.join('\n');
      this.patch({ saveState: 'error', saveError: error });
      return { error };
    }
    const document = withCheckMetadata(draftDoc, savedDoc);
    return this.persist('architecture_save', { document: savePayload(document), expected_version: savedDoc.version });
  };
  restoreVersion = async (version: number) => {
    const branch = this.state.savedDoc?.branch_key;
    if (branch && this.state.saveState !== 'saving' && this.state.updateBusy === 'idle') {
      const restored = await this.persist('architecture_restore', { branch_key: branch, version });
      if (restored.document && this.state.savedDoc?.branch_key === branch) await this.checkUpdates();
    }
  };
}

export function useArchitectureDocument(projectId: string, refreshKey: string, invoke: ArchitectureInvoke, opened = true) {
  const drafts = useMemo(() => new Map<string, ArchitectureDocument>(), []);
  const store = useMemo(() => new ArchitectureEditorStore(projectId, invoke, drafts), [projectId, invoke, drafts]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { void store.load(); }, [store, refreshKey]);
  useEffect(() => {
    window.addEventListener('focus', store.load);
    return () => window.removeEventListener('focus', store.load);
  }, [store]);
  useEffect(() => {
    if (opened) void store.checkOnOpen();
  }, [store, opened, state.savedDoc, state.editMode, state.updateBusy, state.saveState]);
  const { enterEditMode, cancelEdit, updateDraft, saveDraft, restoreVersion, applyAutoLayout, load, checkUpdates, updateAffected, resolveReview } = store;
  return { ...state, enterEditMode, cancelEdit, updateDraft, saveDraft, restoreVersion,
    applyAutoLayout, load, checkUpdates, updateAffected, resolveReview };
}
export type ArchitectureEditor = ReturnType<typeof useArchitectureDocument>;
