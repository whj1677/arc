import { useId, useRef, useState, type ReactNode } from 'react';
import type { EngineeringTask } from '../engineering';
import { projectTaskBehavior, type BehaviorAcceptance, type BehaviorPhase, type BehaviorVerification, type ImplementationState, type TaskBehavior } from './task-behavior-model';
import './task-behavior-cockpit.css';

const phases: Record<BehaviorPhase, string> = {plan: '改前方案', developing: '开发中', acceptance: '验收'};
const implementations: Record<ImplementationState, string> = {
  not_started: '未开始', planned: '方案中', in_progress: '开发中', implemented: '已有实现', blocked: '受阻',
};
const verifications: Record<BehaviorVerification, string> = {
  verified: '已观测通过', failed: '失败', partial: '部分验证', stale: '待复验', agent_claimed: '仅 Agent 声明', unverified: '未验证',
};

export function InlineCodeText({text}: {text: string}) {
  return <>{text.split(/`([^`]+)`/g).map((part, index) =>
    index % 2 ? <code className="inline-code" key={index}>{part}</code> : part
  )}</>;
}

function BehaviorNotes({label, items}: {label: string; items: string[]}) {
  if (!items.length) return null;
  return <details className="behavior-notes">
    <summary>{label}</summary>
    <ul>{items.map((item, index) => <li key={index}><InlineCodeText text={item}/></li>)}</ul>
  </details>;
}

interface TaskBehaviorCockpitProps {
  task: EngineeringTask;
  beforeReading?: string;
  visualSlot?: ReactNode;
  onOpenReading?: () => void;
  onViewChanges: (file?: string) => void;
  onViewVerification: (evidenceId?: string) => void;
  onAppend?: (text?: string) => void;
}

export function TaskBehaviorCockpit({task, beforeReading, visualSlot, onOpenReading, onViewChanges, onViewVerification, onAppend}: TaskBehaviorCockpitProps) {
  const model = projectTaskBehavior(task);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const cockpitRef = useRef<HTMLElement>(null);
  const acceptanceRef = useRef<HTMLElement>(null);
  const acceptanceDetails = useRef<HTMLDetailsElement>(null);
  const attentionList = useRef<HTMLOListElement>(null);
  const acceptanceId = useId();
  const attentionId = useId();
  const phaseIndex = Object.keys(phases).indexOf(model.phase);
  const isPlan = model.phase === 'plan';
  const planWithVisual = isPlan && !!visualSlot;
  const selected = model.behaviors.find(behavior => behavior.id === selectedId);
  const rowsById = new Map<string, {row: BehaviorAcceptance; owners: Set<TaskBehavior>}>();
  for (const behavior of model.behaviors) {
    for (const row of behavior.acceptance) {
      const group = rowsById.get(row.id);
      if (group) group.owners.add(behavior);
      else rowsById.set(row.id, {row, owners: new Set([behavior])});
    }
  }
  const groups = [...rowsById.values()];
  const criteria = groups.filter(({row}) => row.criterionId);
  const passed = criteria.filter(({row}) => row.verification === 'verified').length;
  const visibleRows = groups.filter(({owners}) => !selected || owners.has(selected));
  const attention = [
    ...model.attention.decisions.map(text => ({text, ownership: false})),
    ...model.attention.ownership.map(text => ({text, ownership: true})),
  ];
  const anchor = task.reading?.evidence;
  const source = anchor ? `${anchor.path}:L${anchor.line_start}–L${anchor.line_end}` : '';

  function openAttention() {
    if (planWithVisual) {
      const replies = cockpitRef.current?.querySelectorAll<HTMLTextAreaElement>('textarea.hud-question-input');
      const firstReply = replies?.[0];
      if (firstReply && !firstReply.disabled && replies.length === attention.length) {
        firstReply.focus();
        return;
      }
      if (!attentionOpen) {
        requestAnimationFrame(() => {
          attentionList.current?.focus({preventScroll: true});
          attentionList.current?.scrollIntoView({block: 'start'});
        });
      }
    }
    setAttentionOpen(open => !open);
  }

  const attentionPanel = !!attention.length && (!planWithVisual || attentionOpen) &&
    <section className="behavior-attention" aria-label="待拍板 / 待核对">
      {!planWithVisual && <div className="behavior-attention-bar">
        <strong>待确认 {attention.length} 项</strong>
        <span className="behavior-attention-preview"><InlineCodeText text={attention[0].text}/></span>
        <button type="button" className="behavior-link" aria-controls={attentionId} aria-expanded={attentionOpen}
          onClick={openAttention}>{attentionOpen ? '收起 ▴' : `展开处理 ${attention.length} 项 ▾`}</button>
        {onAppend && <button type="button" onClick={() => onAppend()}>补充要求</button>}
      </div>}
      <ol ref={attentionList} id={attentionId} tabIndex={-1} className="behavior-attention-list" hidden={!attentionOpen}>
        {attention.map(({text, ownership}, index) => <li className="behavior-attention-row" key={`${ownership}:${text}`}>
          <span className="behavior-number" aria-hidden="true">{index + 1}</span>
          <details className="behavior-disclosure">
            <summary><span className="behavior-excerpt"><InlineCodeText text={text}/></span>
              <span className="behavior-more" aria-hidden="true"><span>展开</span><span>收起</span></span>
            </summary>
          </details>
          <div className="behavior-row-actions">
            {ownership && <button type="button" className="behavior-link" onClick={() => onViewChanges()}>核对 Diff</button>}
            {onAppend && <button type="button" onClick={() => onAppend(text)}>{ownership ? '补充' : '回复'}</button>}
          </div>
        </li>)}
      </ol>
    </section>;

  function renderRow({row, owners}: (typeof groups)[number]) {
    const behaviors = selected ? [selected] : [...owners];
    const changes = new Map(behaviors.flatMap(behavior => behavior.changes.map(change => [change.path, change] as const)));
    const onlyChange = changes.size === 1 ? changes.values().next().value : undefined;
    const changedFile = task.changes_status !== 'needs_review' && !onlyChange?.text_diff_unavailable ? onlyChange?.path : undefined;
    const relatedFiles = [...new Set(behaviors.flatMap(behavior => behavior.files))];
    const files = relatedFiles.length ? relatedFiles : model.taskFiles;
    const logs = row.evidence.filter(item => item.log_path);
    const evidence = (logs.length ? logs : row.evidence).at(-1);
    const dotState = row.verification === 'failed' || row.implementation !== 'blocked' ? row.verification : 'blocked';
    return <li className="behavior-check" key={row.id} data-criterion-id={row.criterionId}>
      <span className="behavior-dot" data-state={dotState} aria-hidden="true"/>
      <details className="behavior-disclosure">
        <summary><span className="behavior-excerpt"><InlineCodeText text={row.text}/></span>
          <span className="behavior-more" aria-hidden="true"><span>展开</span><span>收起</span></span>
        </summary>
        <div className="behavior-check-detail">
          {behaviors.map(behavior => <div key={behavior.id}>
            {(behaviors.length > 1 || behavior.title !== row.text) && <p><strong>所属行为</strong> <InlineCodeText text={behavior.title}/></p>}
            {behavior.design && <p><strong>计划实现</strong> <InlineCodeText text={behavior.design}/></p>}
            {behavior.before && beforeReading && model.behaviors.length === 1 &&
              <p><strong>改前说明</strong> <InlineCodeText text={beforeReading}/></p>}
          </div>)}
          {!!files.length && <details className="behavior-notes">
            <summary>{relatedFiles.length ? '关联模块 / 文件' : '任务级文件范围'}</summary>
            <ul>{files.map(file => <li key={file}><code className="inline-code">{file}</code></li>)}</ul>
          </details>}
          <BehaviorNotes label="步骤进展" items={[...new Set(behaviors.flatMap(behavior => behavior.progress))]}/>
          <BehaviorNotes label="本次范围之外" items={model.constraints.non_goals}/>
          <BehaviorNotes label="已撤回要求" items={model.constraints.revoked}/>
        </div>
      </details>
      <div className="behavior-check-meta">
        {!isPlan && <>
          <span className="behavior-state" data-state={row.implementation}>实现：{implementations[row.implementation]}</span>
          <span className="behavior-state" data-state={row.verification}>验证：{verifications[row.verification]}</span>
        </>}
        <div className="behavior-row-actions">
          {!!changes.size && <button type="button" className="behavior-link" onClick={() => onViewChanges(changedFile)}>Diff</button>}
          {evidence && <button type="button" className="behavior-link" onClick={() => onViewVerification(evidence.evidence_id)}>
            {logs.length ? `日志 · ${logs.length}` : `记录 · ${row.evidence.length}`}
          </button>}
        </div>
      </div>
    </li>;
  }

  const visibleCriteria = visibleRows.filter(({row}) => row.criterionId);
  const visibleFallbacks = visibleRows.filter(({row}) => !row.criterionId);
  const acceptanceContent = <>
    <div className="behavior-acceptance-header">
      {!isPlan && <h3>行为与验收清单</h3>}
      <button type="button" className="behavior-link" onClick={() => onViewVerification()}>验证记录</button>
    </div>
    <div className="behavior-filters" role="group" aria-label="筛选行为">
      <button type="button" aria-pressed={!selected} onClick={() => setSelectedId(null)}>全部行为 ({model.behaviors.length})</button>
      {model.behaviors.map((behavior, index) => <button type="button" key={behavior.id}
        aria-pressed={selected?.id === behavior.id} title={behavior.title.replaceAll('`', '')} onClick={() => setSelectedId(behavior.id)}>
        {index + 1}. <InlineCodeText text={behavior.title}/>
      </button>)}
    </div>
    {visibleCriteria.length ? <ul className="behavior-check-list">{visibleCriteria.map(renderRow)}</ul>
      : <p className="behavior-empty muted">尚未记录结构化验收条件。</p>}
    {!!visibleFallbacks.length && <ul className="behavior-fallback-list" aria-label="行为验证说明">{visibleFallbacks.map(renderRow)}</ul>}
    <BehaviorNotes label="已记录决定" items={model.decisions}/>
  </>;

  return <section ref={cockpitRef} className="task-behavior-cockpit" aria-label="任务行为与验收">
    <div className="behavior-signal-bar">
      <ol className="behavior-phases" aria-label="开发阶段">
        {Object.entries(phases).map(([id, label], index) => <li key={id}
          data-complete={index < phaseIndex || undefined}
          aria-current={model.phase === id ? 'step' : undefined}>{label}</li>)}
      </ol>
      <div className="behavior-signals">
        <p className="behavior-progress" data-tone={model.tone} role="status" title={model.progress}>{model.progress}</p>
        <div className="behavior-kpis">
          <button type="button" className="behavior-kpi" onClick={() => onViewChanges()}>
            {task.changes_status === 'needs_review' ? '改动归属待核' : <>改动 <strong>{task.changes.length}</strong> 文件</>}
          </button>
          <button type="button" className="behavior-kpi" aria-controls={acceptanceId} onClick={() => {
            setSelectedId(null);
            if (acceptanceDetails.current) acceptanceDetails.current.open = true;
            acceptanceRef.current?.focus({preventScroll: true});
            acceptanceRef.current?.scrollIntoView({block: 'start'});
          }}>验收 <strong>{passed}/{criteria.length}</strong> 已通过</button>
          {!!attention.length && <button type="button" className="behavior-kpi behavior-kpi-warning"
            aria-controls={!planWithVisual || attentionOpen ? attentionId : undefined} aria-expanded={attentionOpen} onClick={openAttention}>
            待确认 <strong>{attention.length}</strong> 项
          </button>}
        </div>
      </div>
      {anchor && <div className="behavior-source" role="group" aria-label="关联源码位置">
        <span>改前来源：</span><code className="inline-code" title={source}>{source}</code>
        {onOpenReading && <button type="button" className="behavior-link" onClick={onOpenReading}>查看走读 ↗</button>}
      </div>}
    </div>

    {!planWithVisual && attentionPanel}
    {visualSlot}
    {planWithVisual && attentionPanel}

    <section ref={acceptanceRef} id={acceptanceId} tabIndex={-1} className="behavior-acceptance behavior-record-target" aria-label="行为与验收清单">
      {isPlan ? <details ref={acceptanceDetails} className="behavior-plan-acceptance">
        <summary>预设验收清单 · {criteria.length} 条（开发后逐项核验）</summary>
        {acceptanceContent}
      </details> : acceptanceContent}
    </section>
  </section>;
}
