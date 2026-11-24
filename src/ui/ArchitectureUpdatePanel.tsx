import React, { useState } from 'react';
import type { ArchitectureDocument, ReviewItem } from '../architecture-workspace';
import type { SourceEvidence } from '../shared';
import { edgeNames, nodeNames } from './Graph';
import type { ArchitectureEditor } from './useArchitectureDocument';

export interface ArchitectureReviewActions {
  openEvidence?: (evidence: SourceEvidence) => void;
  onReviewResolved?: (item: ReviewItem) => void;
}
interface Props extends ArchitectureReviewActions {
  doc: ArchitectureDocument;
  editor: ArchitectureEditor;
  warnings: React.ReactNode;
}

const categories = {
  module_add: '新增模块', module_remove: '移除模块', module_update: '模块更新', hierarchy_change: '层级变化',
  relation_add: '新增关系', relation_remove: '移除关系', relation_update: '关系更新', exclusion_conflict: '排除冲突',
  manual_conflict: '人工编辑冲突', rename_uncertain: '重命名待确认', dataflow_change: '数据流变化', uncertain: '待核实',
};
const statuses = { pending: '待处理', deferred: '已暂缓', accepted: '已接受', rejected: '已拒绝' };
const filters = { pending: '待处理', deferred: '已暂缓', processed: '已处理' };
const fileStatuses = { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' };
const sources = { committed: '已提交', staged: '已暂存', unstaged: '未暂存', untracked: '新增未跟踪', snapshot_diff: '快照对比' };
const fileCategories = { code: '代码', config_or_contract: '配置与接口', rule: '工程规则' };
const modes = { none: '无影响', reference_only: '仅引用位置', local_module: '局部模块', dataflow_only: '仅数据流', cross_module: '跨模块', wide_recheck: '扩大复查' };
const autoKinds = { file_moved: '文件移动', code_link_relocated: '引用位置同步', evidence_refreshed: '代码依据同步', dataflow_refreshed: '数据流同步' };

const fieldLabels: Record<string, string> = {
  name: '名称', summary: '职责', label: '说明', title: '标题', notes: '人工说明', from: '起点', to: '终点',
  parent_id: '父模块', kind: '类型', layer: '所属分层', bind_paths: '关联路径', code_links: '代码关联', evidence: '代码依据',
  reading_guide: '阅读指南', function_walkthroughs: '函数走读', steps: '步骤', roles: '角色', handoffs: '交接', paths: '路径',
  files: '文件', actor: '执行方', text: '内容', outcome: '结果', detail: '详情', path: '路径', description: '说明',
  trigger: '触发条件', input: '输入', output: '输出', boundary: '边界', reason: '原因', origin: '来源', status: '状态',
  implementation_status: '实现状态', updated_at: '更新时间', note: '备注', id: '标识', explanation_id: '走读版本',
};

function ReviewValue({ value, field }: { value: unknown; field?: string }): React.ReactNode {
  if (value == null || value === '') return '无';
  if (Array.isArray(value)) return value.length ? <ol>{value.map((entry, i) => <li key={i}><ReviewValue value={entry}/></li>)}</ol> : '无';
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length ? <dl>{entries.map(([key, entry]) => <div key={key}>
      <dt>{fieldLabels[key] ?? key}</dt><dd><ReviewValue field={key} value={entry}/></dd>
    </div>)}</dl> : '无';
  }
  if (field === 'kind' && typeof value === 'string') return edgeNames[value] ?? nodeNames[value] ?? value;
  if (field === 'layer' && typeof value === 'string') {
    const layers: Record<string, string> = { entry: '入口层', core: '核心层', foundation: '底层' };
    return layers[value] ?? value;
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function ReviewCard({ item, editor, branch, openEvidence, onReviewResolved }: ArchitectureReviewActions & {
  item: ReviewItem; editor: ArchitectureEditor; branch: string;
}) {
  const [note, setNote] = useState(item.decision_note ?? '');
  const actionable = item.status === 'pending' || item.status === 'deferred';
  const disabled = editor.updateBusy !== 'idle' || editor.saveState === 'saving' || editor.dirty;
  const operation = item.operation ?? item.category;
  const removal = operation === 'module_remove' ? '移除该模块' : operation === 'relation_remove' ? '移除该关系' : undefined;
  // Phase 2A stores the full original object and just the proposed fields. Lead with comparable fields.
  const originalFields = item.before && typeof item.before === 'object' && !Array.isArray(item.before) ? Object.entries(item.before) : [];
  const proposedFields = new Set(item.proposed && typeof item.proposed === 'object' && !Array.isArray(item.proposed) ? Object.keys(item.proposed) : []);
  const changedFields = originalFields.filter(([key]) => proposedFields.has(key));
  async function decide(decision: 'accept' | 'reject' | 'defer') {
    if (await editor.resolveReview(item.id, decision, note.trim() || undefined) && decision === 'accept') onReviewResolved?.(item);
  }
  return <article className="architecture-review-card" aria-label={item.title}>
    <div className="architecture-review-badges">
      <span className="tag">{categories[item.category]}</span><span className="tag">{statuses[item.status]}</span>
      <span className="tag" title="所属分支">{item.branch ?? branch}</span>
    </div>
    <h4>{item.title}</h4>
    <p><strong>影响范围</strong> · {item.scope_summary}</p>
    <div className="architecture-review-comparison">
      <div><h5>原内容</h5>{changedFields.length && changedFields.length < originalFields.length ? <>
        <ReviewValue value={Object.fromEntries(changedFields)}/>
        <details><summary>完整原内容</summary><ReviewValue value={item.before}/></details>
      </> : <ReviewValue value={item.before}/>}</div>
      <div><h5>新建议</h5>{removal ?? <ReviewValue value={item.proposed}/>}</div>
    </div>
    <h5>代码依据</h5>
    {item.evidence.length ? <ul className="architecture-review-evidence">{item.evidence.map(ev => <li key={ev.evidence_id}>
      <button type="button" disabled={!openEvidence} title={ev.note} onClick={() => openEvidence?.(ev)}>
        {ev.path}:L{ev.line_start}-L{ev.line_end}
      </button>
    </li>)}</ul> : <p>暂无代码依据</p>}
    {actionable ? <fieldset className="architecture-review-actions" disabled={disabled}
      title={editor.dirty ? '请先保存或取消草稿，再处理复核建议。' : undefined}>
      <label>复核备注<input aria-label="复核备注" value={note} onChange={e => setNote(e.target.value)}/></label>
      <button type="button" onClick={() => void decide('accept')}>接受</button>
      <button type="button" onClick={() => void decide('reject')}>拒绝</button>
      {item.status === 'pending' && <button type="button" onClick={() => void decide('defer')}>暂缓</button>}
    </fieldset> : item.decision_note && <p>复核备注 · {item.decision_note}</p>}
  </article>;
}

function unitName(key: string) {
  // Imported documents may have arbitrary outcome keys. Preserve those identifiers verbatim.
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string')
      return (parsed[0] === 'feature' ? '功能走读 · ' : parsed[0] === 'unmapped' ? '未归属文件 · ' : '分析单元 · ') + parsed[1];
  } catch { return key; }
  return key;
}

export function ArchitectureUpdatePanel({ doc, editor, openEvidence, onReviewResolved, warnings }: Props) {
  const [filter, setFilter] = useState<keyof typeof filters>('pending');
  const run = doc.last_update, pending = doc.pending_changes_summary;
  const baseline = run?.read_baseline ?? doc.baseline;
  // Phase 2A also writes a post-check summary at run completion. Its file list is relative
  // to the just-read snapshot, whereas the run records the files that actually changed.
  const checked = pending && (!run || pending.checked_at !== run.finished_at);
  const detection = checked ? pending : run?.detection_summary;
  const impact = checked ? pending.impact_preview : run?.impact_summary;
  const names = new Map(doc.modules.map(m => [m.id, m.name]));
  const moduleList = (ids: string[]) => ids.map(id => names.get(id) ?? id).join('、');
  const failed = doc.modules.filter(m => m.analysis_status === 'failed' || run?.module_outcomes[m.id]?.status === 'failed');
  const failedModules = new Set(failed.map(m => JSON.stringify(['module', m.id])));
  const otherFailures = Object.entries(run?.unit_outcomes ?? {}).filter(([key, unit]) => unit.status === 'failed' && !failedModules.has(key));
  const disabled = editor.updateBusy !== 'idle' || editor.dirty || editor.saveState === 'saving';
  const groups = {
    pending: doc.review_items.filter(i => i.status === 'pending'), deferred: doc.review_items.filter(i => i.status === 'deferred'),
    processed: doc.review_items.filter(i => i.status === 'accepted' || i.status === 'rejected'),
  };
  return <section className="architecture-update-panel" aria-label="更新与复核">
    <section aria-label="基线与状态">
      <h3>基线与状态</h3>
      {warnings}
      {baseline ? <p className="architecture-baseline">
        <span>分支 {baseline.branch ?? doc.branch_key}</span><span>提交 {baseline.commit?.slice(0, 8) ?? '无'}</span>
        <span className="tag">{baseline.dirty ? '含工作区改动' : '工作区干净'}</span>
        <span>读取快照 <code>{baseline.snapshot_id}</code></span>
      </p> : <p>尚无分析基线</p>}
      <p>文档版本 {run ? `v${run.base_doc_version} → ` : ''}v{doc.version}
        {run && <span> · 上次更新模型调用：{run.model_calls} 次</span>}
        {!run && !checked && <span> · 增量更新模型调用：0 次</span>}
        {checked && <span> · 本次检查模型调用：0 次</span>}
      </p>
    </section>
    {detection && <section aria-label="变化与影响范围"><h3>变化与影响范围</h3>
      {detection.changed_files.length ? <ul>{detection.changed_files.map(f => <li key={f.source + ':' + f.path}>
        <strong>{fileStatuses[f.status]}</strong> <code>{f.old_path && f.old_path + ' → '}{f.path}</code> · {sources[f.source]} · {fileCategories[f.category]}
      </li>)}</ul> : <p>{detection.detection_reliable ? '没有检测到文件变化' : '文件变化尚未确定'}</p>}
      {impact && <>
        <p><strong>{modes[impact.mode]}</strong> · {impact.reason}</p>
        <p>影响 {impact.affected_module_ids.length} 个模块 {moduleList(impact.affected_module_ids)}</p>
        <p>已复用 {impact.reused_module_ids.length} 个未受影响模块 {moduleList(impact.reused_module_ids)}</p>
        <p>受影响功能 · {impact.affected_feature_ids.join('、') || '无'}</p>
        {impact.unmapped_files.length > 0 && <p>未归属文件 · {impact.unmapped_files.join('、')}</p>}
      </>}
    </section>}
    {run && run.auto_updates.length > 0 && <section aria-label="自动更新摘要"><h3>自动更新摘要</h3>
      <ul>{run.auto_updates.map(a => <li key={a.id}><strong>{autoKinds[a.kind]}</strong> · {a.target_name}
        {a.old_path && a.new_path && <div><code>{a.old_path}{a.old_path !== a.new_path && ' → ' + a.new_path}</code></div>}
        <span>{a.description}</span>
      </li>)}</ul>
    </section>}
    {(failed.length > 0 || otherFailures.length > 0) && <section aria-label="失败项与重试">
      <div className="architecture-update-heading"><h3>失败项与重试</h3>
        <button disabled={disabled} onClick={() => void editor.updateAffected({ retryFailedOnly: true })}>重试失败项</button>
      </div>
      <ul>{failed.map(m => <li key={m.id}><strong>{m.name}</strong> · {m.analysis_error ?? run?.module_outcomes[m.id]?.error}
        {' '}<button disabled={disabled} onClick={() => void editor.updateAffected({ moduleIds: [m.id] })}>重试</button>
      </li>)}{otherFailures.map(([key, unit]) => <li key={key}><strong>{unitName(key)}</strong> · {unit.error}</li>)}</ul>
    </section>}
    <section aria-label="集中复核队列"><h3>集中复核队列</h3>
      <p>只有接受的建议会写入已确认架构或功能走读。</p>
      <div className="architecture-view-switch" role="group" aria-label="筛选复核状态">
        {(Object.keys(filters) as Array<keyof typeof filters>).map(key => <button key={key} type="button" aria-pressed={key === filter}
          onClick={() => setFilter(key)}>{filters[key]} ({groups[key].length})</button>)}
      </div>
      {groups[filter].length ? groups[filter].map(item => <ReviewCard key={item.id} item={item} editor={editor}
        branch={doc.branch_key} openEvidence={openEvidence} onReviewResolved={onReviewResolved}/>) : <p>暂无{filters[filter]}建议</p>}
    </section>
  </section>;
}
