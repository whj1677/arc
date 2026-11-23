import { useState } from 'react';
import type { EngineeringTask } from '../engineering';
import { projectTaskBehavior, type BehaviorPhase, type BehaviorVerification, type ImplementationState } from './task-behavior-model';
import './task-behavior-cockpit.css';

const phases: Record<BehaviorPhase, string> = {plan: '改前方案', developing: '开发中', acceptance: '验收'};
const implementations: Record<ImplementationState, string> = {
  not_started: '未开始', planned: '方案中', in_progress: '开发中', implemented: '已有实现', blocked: '受阻',
};
const verifications: Record<BehaviorVerification, string> = {
  verified: '已观测验证通过', failed: '失败', partial: '部分验证', stale: '待复验', agent_claimed: '仅 Agent 声明', unverified: '未验证',
};

interface TaskBehaviorCockpitProps {
  task: EngineeringTask;
  beforeReading?: string;
  onViewChanges: (file?: string) => void;
  onViewVerification: (evidenceId?: string) => void;
  onAppend?: (text?: string) => void;
}

export function TaskBehaviorCockpit({task, beforeReading, onViewChanges, onViewVerification, onAppend}: TaskBehaviorCockpitProps) {
  const model = projectTaskBehavior(task);
  const [selectedId, setSelectedId] = useState(model.behaviors[0].id);
  const behavior = model.behaviors.find(item => item.id === selectedId) ?? model.behaviors[0];
  const files = behavior.files.length ? behavior.files : model.taskFiles;
  const hasDecisions = model.attention.decisions.length > 0 || model.attention.ownership.length > 0;
  const changedFile = task.changes_status !== 'needs_review' && behavior.changes.length === 1 && !behavior.changes[0].text_diff_unavailable
    ? behavior.changes[0].path : undefined;

  return <section className="task-behavior-cockpit" aria-label="任务行为与验收">
    <ol className="behavior-phases" aria-label="开发阶段">
      {Object.entries(phases).map(([id, label]) => <li key={id} aria-current={model.phase === id ? 'step' : undefined}>{label}</li>)}
    </ol>
    <p className="behavior-progress" data-tone={model.tone} role="status">{model.progress}</p>

    <div className="behavior-layout" data-attention={model.hasAttention}>
      <aside className="behavior-panel behavior-navigation">
        <h3>本次涉及的行为</h3>
        <ul className="behavior-list">
          {model.behaviors.map(item => <li key={item.id}>
            <button type="button" aria-pressed={item.id === behavior.id} onClick={() => setSelectedId(item.id)}>
              <strong>{item.title}</strong>
              <small>{implementations[item.implementation]} · {verifications[item.verification]}</small>
            </button>
          </li>)}
        </ul>
        <h4>关联模块 / 文件</h4>
        {files.length ? <>
          {!behavior.files.length && <small className="muted">任务级文件范围</small>}
          <ul className="behavior-file-list">{files.map(file => <li key={file}><code>{file}</code></li>)}</ul>
        </> : <p className="muted">尚未记录关联文件。</p>}
      </aside>

      <section className="behavior-main" aria-label={behavior.title}>
        <div className="behavior-comparison">
          <article className="behavior-panel">
            <h3>改前行为</h3>
            {behavior.before && beforeReading && model.behaviors.length === 1 ? <p>{beforeReading}</p> : <p className="muted">尚未记录该行为的改前说明。</p>}
            {behavior.before && <p>关联走读的冻结来源 <code>{behavior.before.path}:{behavior.before.line_start}–{behavior.before.line_end}</code></p>}
          </article>
          <article className="behavior-panel">
            <h3>目标行为与约束</h3>
            <p>{behavior.title}</p>
            {!!model.constraints.non_goals.length && <><h4>本次范围之外</h4><ul>{model.constraints.non_goals.map(item => <li key={item}>{item}</li>)}</ul></>}
            {!!model.constraints.revoked.length && <><h4>已撤回要求</h4><ul>{model.constraints.revoked.map(item => <li key={item}>{item}</li>)}</ul></>}
            {behavior.design && <><h4>计划实现</h4><p>{behavior.design}</p></>}
          </article>
        </div>

        <section className="behavior-panel behavior-acceptance">
          <h3>目标落实与验证情况</h3>
          {!behavior.acceptance.some(row => row.criterionId) && <p className="muted">尚未记录结构化验收条件。</p>}
          <table aria-label="目标落实与验证情况">
            <thead><tr><th scope="col">行为 / 验收条件</th><th scope="col">实现</th><th scope="col">验证</th></tr></thead>
            <tbody>{behavior.acceptance.map(row => <tr key={row.id} data-criterion-id={row.criterionId}>
              <th scope="row">{row.text}</th>
              <td>
                <span className="behavior-state" data-state={row.implementation}>{implementations[row.implementation]}</span>
                {!!behavior.changes.length && <button type="button" className="behavior-link" onClick={() => onViewChanges(changedFile)}>代码差异</button>}
              </td>
              <td>
                <span className="behavior-state" data-state={row.verification}>{verifications[row.verification]}</span>
                {!!row.evidence.length && <button type="button" className="behavior-link" onClick={() => onViewVerification(row.evidence.at(-1)?.evidence_id)}>关联记录 · {row.evidence.length}</button>}
              </td>
            </tr>)}</tbody>
          </table>
          {!!behavior.progress.length && <details><summary>步骤进展</summary><ul>{behavior.progress.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
          {!!model.decisions.length && <details><summary>已记录决定</summary><ul>{model.decisions.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
          <div className="behavior-actions">
            <button type="button" onClick={() => onViewChanges()}>查看代码差异 / 演化图</button>
            <button type="button" onClick={() => onViewVerification()}>查看验证记录</button>
          </div>
        </section>
      </section>

      {model.hasAttention && <aside className="behavior-panel behavior-attention" aria-label="待处理事项">
        {hasDecisions && <>
          <h3>需要你决定 / 待核对</h3>
          <ul>
            {model.attention.decisions.map(item => <li key={item}>{onAppend ? <button type="button" className="behavior-link" onClick={() => onAppend(item)}>{item}</button> : item}</li>)}
            {model.attention.ownership.map(item => <li key={item}><button type="button" className="behavior-link" onClick={() => onViewChanges()}>{item}</button></li>)}
          </ul>
        </>}
        {!!model.attention.verification.length && <>
          <h3>尚未验证</h3>
          <ul>{model.attention.verification.map(row => <li key={JSON.stringify([row.behaviorId, row.id])}>
            <button type="button" className="behavior-link" onClick={() => {
              setSelectedId(row.behaviorId);
              onViewVerification(row.evidence.at(-1)?.evidence_id);
            }}>{row.text}<small>{verifications[row.verification]}</small></button>
          </li>)}</ul>
        </>}
        {onAppend && <button type="button" onClick={() => onAppend()}>补充要求</button>}
      </aside>}
    </div>
  </section>;
}
