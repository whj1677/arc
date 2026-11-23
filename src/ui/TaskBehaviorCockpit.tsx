import { useId, useRef, useState, type ReactNode } from 'react';
import type { EngineeringTask } from '../engineering';
import { projectTaskBehavior, type BehaviorPhase, type BehaviorVerification, type ImplementationState } from './task-behavior-model';
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
  const acceptanceRef = useRef<HTMLElement>(null);
  const acceptanceId = useId();
  const attentionId = useId();
  const phaseIndex = Object.keys(phases).indexOf(model.phase);
  const selected = model.behaviors.find(behavior => behavior.id === selectedId);
  const visibleBehaviors = selected ? [selected] : model.behaviors;
  const criteria = new Map(model.behaviors.flatMap(behavior => behavior.acceptance
    .filter(row => row.criterionId).map(row => [row.id, row] as const)));
  const passed = [...criteria.values()].filter(row => row.verification === 'verified').length;
  const attention = [
    ...model.attention.decisions.map(text => ({text, ownership: false})),
    ...model.attention.ownership.map(text => ({text, ownership: true})),
  ];
  const anchor = task.reading?.evidence;
  const source = anchor ? `${anchor.path}:L${anchor.line_start}–L${anchor.line_end}` : '';

  return <section className="task-behavior-cockpit" aria-label="任务行为与验收">
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
            acceptanceRef.current?.focus({preventScroll: true});
            acceptanceRef.current?.scrollIntoView({block: 'start'});
          }}>验收 <strong>{passed}/{criteria.size}</strong> 已通过</button>
          {!!attention.length && <button type="button" className="behavior-kpi behavior-kpi-warning"
            aria-controls={attentionId} aria-expanded={attentionOpen} onClick={() => setAttentionOpen(open => !open)}>
            待确认 <strong>{attention.length}</strong> 项
          </button>}
        </div>
      </div>
      {anchor && <div className="behavior-source" role="group" aria-label="关联源码位置">
        <span>改前来源：</span><code className="inline-code" title={source}>{source}</code>
        {onOpenReading && <button type="button" className="behavior-link" onClick={onOpenReading}>查看走读 ↗</button>}
      </div>}
    </div>

    {!!attention.length && <section className="behavior-attention" aria-label="待拍板 / 待核对">
      <div className="behavior-attention-bar">
        <strong>待确认 {attention.length} 项</strong>
        <span className="behavior-attention-preview"><InlineCodeText text={attention[0].text}/></span>
        <button type="button" className="behavior-link" aria-controls={attentionId} aria-expanded={attentionOpen}
          onClick={() => setAttentionOpen(open => !open)}>{attentionOpen ? '收起 ▴' : `展开处理 ${attention.length} 项 ▾`}</button>
        {onAppend && <button type="button" onClick={() => onAppend()}>补充要求</button>}
      </div>
      <ol id={attentionId} className="behavior-attention-list" hidden={!attentionOpen}>
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
    </section>}

    {visualSlot}

    <section ref={acceptanceRef} id={acceptanceId} tabIndex={-1} className="behavior-acceptance behavior-record-target" aria-label="行为与验收清单">
      <div className="behavior-acceptance-header">
        <h3>行为与验收清单</h3>
        <button type="button" className="behavior-link" onClick={() => onViewVerification()}>验证记录</button>
      </div>
      <div className="behavior-filters" role="group" aria-label="筛选行为">
        <button type="button" aria-pressed={!selected} onClick={() => setSelectedId(null)}>全部行为 ({model.behaviors.length})</button>
        {model.behaviors.map((behavior, index) => <button type="button" key={behavior.id}
          aria-pressed={selected?.id === behavior.id} title={behavior.title.replaceAll('`', '')} onClick={() => setSelectedId(behavior.id)}>
          {index + 1}. <InlineCodeText text={behavior.title}/>
        </button>)}
      </div>
      {!visibleBehaviors.some(behavior => behavior.acceptance.some(row => row.criterionId)) &&
        <p className="behavior-empty muted">尚未记录结构化验收条件。</p>}
      <ul className="behavior-check-list">
        {visibleBehaviors.flatMap(behavior => {
          const changedFile = task.changes_status !== 'needs_review' && behavior.changes.length === 1 && !behavior.changes[0].text_diff_unavailable
            ? behavior.changes[0].path : undefined;
          const files = behavior.files.length ? behavior.files : model.taskFiles;
          return behavior.acceptance.map(row => {
            const logs = row.evidence.filter(item => item.log_path);
            const evidence = (logs.length ? logs : row.evidence).at(-1);
            const dotState = row.verification === 'failed' || row.implementation !== 'blocked' ? row.verification : 'blocked';
            return <li className="behavior-check" key={JSON.stringify([behavior.id, row.id])} data-criterion-id={row.criterionId}>
              <span className="behavior-dot" data-state={dotState} aria-hidden="true"/>
              <details className="behavior-disclosure">
                <summary><span className="behavior-excerpt"><InlineCodeText text={row.text}/></span>
                  <span className="behavior-more" aria-hidden="true"><span>展开</span><span>收起</span></span>
                </summary>
                <div className="behavior-check-detail">
                  {behavior.title !== row.text && <p><strong>所属行为</strong> <InlineCodeText text={behavior.title}/></p>}
                  {behavior.design && <p><strong>计划实现</strong> <InlineCodeText text={behavior.design}/></p>}
                  {behavior.before && beforeReading && model.behaviors.length === 1 &&
                    <p><strong>改前说明</strong> <InlineCodeText text={beforeReading}/></p>}
                  {!!files.length && <details className="behavior-notes">
                    <summary>{behavior.files.length ? '关联模块 / 文件' : '任务级文件范围'}</summary>
                    <ul>{files.map(file => <li key={file}><code className="inline-code">{file}</code></li>)}</ul>
                  </details>}
                  <BehaviorNotes label="步骤进展" items={behavior.progress}/>
                  <BehaviorNotes label="本次范围之外" items={model.constraints.non_goals}/>
                  <BehaviorNotes label="已撤回要求" items={model.constraints.revoked}/>
                </div>
              </details>
              <div className="behavior-check-meta">
                <span className="behavior-state" data-state={row.implementation}>实现：{implementations[row.implementation]}</span>
                <span className="behavior-state" data-state={row.verification}>验证：{verifications[row.verification]}</span>
                <div className="behavior-row-actions">
                  {!!behavior.changes.length && <button type="button" className="behavior-link" onClick={() => onViewChanges(changedFile)}>Diff</button>}
                  {evidence && <button type="button" className="behavior-link" onClick={() => onViewVerification(evidence.evidence_id)}>
                    {logs.length ? `日志 · ${logs.length}` : `记录 · ${row.evidence.length}`}
                  </button>}
                </div>
              </div>
            </li>;
          });
        })}
      </ul>
      <BehaviorNotes label="已记录决定" items={model.decisions}/>
    </section>
  </section>;
}
