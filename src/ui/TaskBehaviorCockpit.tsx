import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  BehaviorScenario,
  EngineeringTask,
  PrepareBehaviorRevisionInput,
  UpdateBehaviorContractInput,
} from '../engineering';
import type { TaskHudSnapshot } from '../development-hud';
import type { ProjectEnvironment } from '../main/env-probe';
import {
  projectTaskBehavior,
  type BehaviorScenarioView,
  type BehaviorSummaryState,
  type EngineeringCheckStatus,
  type PrimaryAction,
  type RuleDecisionView,
  type TaskBehavior,
} from './task-behavior-model';
import './task-behavior-cockpit.css';

const behaviorStateLabels: Record<BehaviorSummaryState, string> = {
  needs_decision: '待决定规则',
  failed: '结果未通过',
  blocked: '执行受阻',
  stale: '待重新验证',
  verified: '已有验证记录',
  unverified: '已改 · 待验证',
  planned: '待确认方案',
  in_progress: '处理中',
};

const scenarioStatusLabels: Record<BehaviorScenarioView['status'], string> = {
  passed: '已通过',
  failed: '未通过',
  stale: '待复验',
  unverified: '未验证',
};

const checkStatusLabels: Record<EngineeringCheckStatus, string> = {
  not_run: '未执行',
  passed: '通过',
  failed: '失败',
  stale: '待复跑',
  agent_claimed: '仅 Agent 自述',
};

export function InlineCodeText({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/g).map((part, index) =>
        index % 2 ? (
          <code className="inline-code" key={index}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

export interface TaskBehaviorCockpitProps {
  task: EngineeringTask;
  environment?: ProjectEnvironment | null;
  hud?: TaskHudSnapshot | null;
  liveCodeState?: EngineeringTask['baseline'];
  beforeReading?: string;
  historical?: boolean;
  busy?: boolean;
  runningChecks?: boolean;
  attemptsCount?: number;
  liveActivitySlot?: ReactNode;
  planSlot?: ReactNode;
  onOpenReading?: () => void;
  onViewChanges: (file?: string) => void;
  onViewVerification: (evidenceId?: string) => void;
  onOpenEvolution?: () => void;
  onOpenLogs?: () => void;
  onOpenHistory?: () => void;
  onOpenPackage?: () => void;
  onApprovePlan?: () => void;
  onCancelTask?: () => void;
  onRunHostChecks?: (kinds?: ('typecheck' | 'test' | 'build')[]) => Promise<void> | void;
  onUpdateBehaviorContract?: (input: Omit<UpdateBehaviorContractInput, 'task_id' | 'expected_version' | 'submission_key'>) => Promise<boolean>;
  onReviseBehavior?: (input: Omit<PrepareBehaviorRevisionInput, 'task_id' | 'expected_version' | 'submission_key'>) => Promise<boolean>;
  onAppend?: (text?: string) => void;
}

type ActivePanel = null | 'adjust_rule' | 'fix_implementation' | 'add_verification' | 'add_scenario';

function suggestScenarioReplacement(expected: string, prevOutcome?: string, nextOutcome?: string) {
  if (!prevOutcome || !nextOutcome || prevOutcome === nextOutcome) return expected;
  if (expected.includes(prevOutcome)) return expected.replace(prevOutcome, nextOutcome);
  const prevNum = prevOutcome.match(/\d+(?:\.\d+)?/)?.[0];
  const nextNum = nextOutcome.match(/\d+(?:\.\d+)?/)?.[0];
  if (prevNum && nextNum && prevNum !== nextNum && expected.includes(prevNum)) {
    return expected.replace(prevNum, nextNum);
  }
  return expected;
}

function toEditableScenarios(behavior: TaskBehavior): BehaviorScenario[] {
  return behavior.scenarios.map(row => ({
    id: row.id,
    input: row.input,
    expected: row.expected,
    ...(row.actual !== undefined ? { actual: row.actual } : {}),
    ...(row.criterionId ? { criterion_id: row.criterionId } : {}),
    ...(row.evidenceId ? { evidence_id: row.evidenceId } : {}),
    status: row.status,
  }));
}

export function TaskBehaviorCockpit({
  task,
  environment,
  hud,
  liveCodeState,
  beforeReading,
  historical = false,
  busy = false,
  runningChecks = false,
  attemptsCount = 0,
  liveActivitySlot,
  planSlot,
  onOpenReading,
  onViewChanges,
  onViewVerification,
  onOpenEvolution,
  onOpenLogs,
  onOpenHistory,
  onOpenPackage,
  onApprovePlan,
  onCancelTask,
  onRunHostChecks,
  onUpdateBehaviorContract,
  onReviseBehavior,
  onAppend,
}: TaskBehaviorCockpitProps) {
  const model = useMemo(
    () => projectTaskBehavior(task, { environment, hud, beforeReading, liveCodeState }),
    [task, environment, hud, beforeReading, liveCodeState],
  );
  const canExecuteScenarioVerify = task.execution_mode === 'codex' || (!task.execution_mode && task.analysis_channel !== 'dsh');

  const defaultBehaviorId = useMemo(() => {
    const priority = model.behaviors.find(
      b =>
        b.summaryState === 'needs_decision' ||
        b.summaryState === 'failed' ||
        b.summaryState === 'blocked' ||
        b.summaryState === 'stale' ||
        b.summaryState === 'unverified',
    );
    return priority?.id ?? model.behaviors[0]?.id ?? '';
  }, [model.behaviors]);

  const [selectedId, setSelectedId] = useState(defaultBehaviorId);
  const [goalOpen, setGoalOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [expandedDecisions, setExpandedDecisions] = useState<Set<string>>(() => new Set());
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  // Rule adjustment / impact preview draft state
  const [draftRule, setDraftRule] = useState('');
  const [draftDecisionId, setDraftDecisionId] = useState<string | undefined>(undefined);
  const [draftOptionId, setDraftOptionId] = useState<string | undefined>(undefined);
  const [draftScenarios, setDraftScenarios] = useState<BehaviorScenario[]>([]);
  const [draftInstruction, setDraftInstruction] = useState('');

  // Inline scenario addition state
  const [newInput, setNewInput] = useState('');
  const [newExpected, setNewExpected] = useState('');
  const [focusScenarioId, setFocusScenarioId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const decisionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const adjustPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!model.behaviors.some(b => b.id === selectedId)) {
      setSelectedId(defaultBehaviorId);
    }
  }, [model.behaviors, selectedId, defaultBehaviorId]);

  useEffect(() => {
    setActivePanel(null);
    setFocusScenarioId(null);
    setPanelError('');
  }, [selectedId, task.task_id, task.version]);

  useEffect(() => {
    if (!activePanel) return;
    requestAnimationFrame(() => {
      adjustPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (activePanel === 'adjust_rule' && focusScenarioId) {
        const input = adjustPanelRef.current?.querySelector<HTMLInputElement>(`input[data-edit-scenario-id="${CSS.escape(focusScenarioId)}"]`);
        if (input) {
          input.focus();
          input.select();
        }
      }
    });
  }, [activePanel, focusScenarioId]);

  const selected = model.behaviors.find(b => b.id === selectedId) ?? model.behaviors[0];
  const isPlan = model.phase === 'plan';
  const isDeveloping = model.phase === 'developing' || (isPlan && task.status === 'running');
  const readOnly = historical || isDeveloping || busy || submitting;
  const canMutateBehavior = !readOnly && !!task.requirement_package && !!selected;

  const anchor = task.reading?.evidence;
  const sourceLabel = anchor ? `${anchor.path}:L${anchor.line_start}–L${anchor.line_end}` : '';
  const hasBlockers = model.attention.decisions.length > 0 || model.attention.ownership.length > 0 || task.diff_review?.verdict === 'needs_fix';

  function openAdjustRule(behavior: TaskBehavior, decision?: RuleDecisionView, preselectOptionId?: string, targetScenarioId?: string) {
    const activeDec = decision ?? behavior.decisions[0];
    const currentOptId = preselectOptionId ?? activeDec?.chosen_option_id;
    const prevOpt = activeDec?.chosen_option_id ? activeDec.options.find(o => o.id === activeDec.chosen_option_id) : undefined;
    const nextOpt = currentOptId ? activeDec?.options.find(o => o.id === currentOptId) : undefined;
    const baseScenarios = toEditableScenarios(behavior);
    const updatedScenarios =
      preselectOptionId && prevOpt?.example_outcome && nextOpt?.example_outcome
        ? baseScenarios.map(row => ({
            ...row,
            expected: suggestScenarioReplacement(row.expected, prevOpt.example_outcome, nextOpt.example_outcome),
          }))
        : baseScenarios;

    setDraftDecisionId(activeDec?.id);
    setDraftOptionId(currentOptId);
    setDraftRule(nextOpt?.label ?? behavior.ruleSummary);
    setDraftScenarios(updatedScenarios);
    setDraftInstruction('');
    setFocusScenarioId(targetScenarioId ?? null);
    setPanelError('');
    setActivePanel('adjust_rule');
  }

  function openFixPanel(behavior: TaskBehavior, mode: 'fix_implementation' | 'add_verification') {
    setDraftScenarios(toEditableScenarios(behavior));
    setDraftRule(behavior.ruleSummary);
    if (mode === 'fix_implementation') {
      const failedRow = behavior.scenarios.find(s => s.status === 'failed');
      setDraftInstruction(
        failedRow
          ? `修正「${behavior.shortTitle}」实现：输入「${failedRow.input}」应满足「${failedRow.expected}」（当前实际：${failedRow.actual || '未通过'}）。`
          : `按当前约定修正「${behavior.shortTitle}」的实现，并运行相关测试核对场景结果。`,
      );
    } else {
      const unverified = behavior.scenarios.filter(s => s.status !== 'passed');
      setDraftInstruction(
        unverified.length
          ? `为「${behavior.shortTitle}」补齐并执行自动化测试，覆盖 ${unverified.map(s => s.input).join('、')} 等待验证场景。`
          : `为「${behavior.shortTitle}」重新执行验证测试并采集最新结果。`,
      );
    }
    setPanelError('');
    setActivePanel(mode);
  }

  function selectDraftOption(decision: RuleDecisionView, nextOptId: string) {
    const prevOpt = draftOptionId ? decision.options.find(o => o.id === draftOptionId) : decision.options[0];
    const nextOpt = decision.options.find(o => o.id === nextOptId);
    setDraftOptionId(nextOptId);
    if (nextOpt) {
      setDraftRule(nextOpt.label);
      if (prevOpt?.example_outcome && nextOpt.example_outcome) {
        setDraftScenarios(rows =>
          rows.map(row => ({
            ...row,
            expected: suggestScenarioReplacement(row.expected, prevOpt.example_outcome, nextOpt.example_outcome),
          })),
        );
      }
    }
  }

  async function saveDecisionQuick(behavior: TaskBehavior, decision: RuleDecisionView, optionId: string) {
    if (!onUpdateBehaviorContract || readOnly) return;
    const opt = decision.options.find(o => o.id === optionId);
    if (!opt) return;
    if (!isPlan) {
      openAdjustRule(behavior, decision, optionId);
      return;
    }
    setSubmitting(true);
    setPanelError('');
    try {
      const prevOpt = decision.chosen_option_id ? decision.options.find(o => o.id === decision.chosen_option_id) : undefined;
      const baseScenarios = toEditableScenarios(behavior);
      const nextScenarios =
        prevOpt?.example_outcome && opt.example_outcome
          ? baseScenarios.map(row => ({
              ...row,
              expected: suggestScenarioReplacement(row.expected, prevOpt.example_outcome, opt.example_outcome),
            }))
          : undefined;
      await onUpdateBehaviorContract({
        behavior_id: behavior.id,
        decision_id: decision.id,
        chosen_option_id: optionId,
        rule_summary: opt.label,
        ...(nextScenarios?.length ? { scenarios: nextScenarios } : {}),
      });
    } catch (e) {
      setPanelError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRuleAdjustment(runExecutor: boolean) {
    if (!selected) return;
    const cleanedRule = draftRule.trim();
    if (!cleanedRule) {
      setPanelError('请填写明确的规则约定。');
      return;
    }
    const validScenarios = draftScenarios
      .map(row => ({ ...row, input: row.input.trim(), expected: row.expected.trim() }))
      .filter(row => row.input && row.expected);
    const activeDec = draftDecisionId ? selected.decisions.find(d => d.id === draftDecisionId) : undefined;
    const matchedOpt = draftOptionId ? activeDec?.options.find(o => o.id === draftOptionId) : undefined;
    const isCustom = !!activeDec && (!matchedOpt || matchedOpt.label.trim() !== cleanedRule);
    const payload = {
      behavior_id: selected.id,
      rule_summary: cleanedRule,
      ...(activeDec
        ? isCustom
          ? { decision_id: activeDec.id, custom_rule: cleanedRule }
          : { decision_id: activeDec.id, chosen_option_id: matchedOpt!.id }
        : {}),
      ...(validScenarios.length ? { scenarios: validScenarios } : {}),
    };
    setSubmitting(true);
    setPanelError('');
    try {
      let ok = false;
      if (runExecutor && !isPlan && onReviseBehavior) {
        const scenarioChanges = validScenarios
          .filter(row => {
            const orig = selected.scenarios.find(s => s.id === row.id);
            return !orig || orig.expected !== row.expected || orig.input !== row.input;
          })
          .map(row => `「${row.input}」期望改为「${row.expected}」`);
        const instruction =
          draftInstruction.trim() ||
          `调整「${selected.shortTitle}」规则为：${cleanedRule}${scenarioChanges.length ? `；更新验收场景：${scenarioChanges.join('；')}` : ''}。请按新约定修改实现并运行测试核验。`;
        ok = await onReviseBehavior({ ...payload, action: 'adjust_rule', instruction });
      } else if (onUpdateBehaviorContract) {
        ok = await onUpdateBehaviorContract(payload);
      }
      if (ok) setActivePanel(null);
    } catch (e) {
      setPanelError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitTargetedAction(actionKind: 'fix_implementation' | 'add_verification') {
    if (!selected || !onReviseBehavior) return;
    const instruction = draftInstruction.trim();
    if (!instruction) {
      setPanelError('请简要说明需要处理的具体问题或验证目标。');
      return;
    }
    setSubmitting(true);
    setPanelError('');
    try {
      const ok = await onReviseBehavior({
        behavior_id: selected.id,
        action: actionKind,
        instruction,
      });
      if (ok) setActivePanel(null);
    } catch (e) {
      setPanelError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitNewScenario(runVerify: boolean) {
    if (!selected) return;
    const input = newInput.trim();
    const expected = newExpected.trim();
    if (!input || !expected) {
      setPanelError('请填写验收场景的「输入」与「期望结果」。');
      return;
    }
    const existing = toEditableScenarios(selected);
    const nextScenario: BehaviorScenario = {
      id: `sc-${Date.now().toString(36)}`,
      input,
      expected,
      status: 'unverified',
    };
    const nextList = [...existing, nextScenario];
    setSubmitting(true);
    setPanelError('');
    try {
      let ok = false;
      if (runVerify && !isPlan && onReviseBehavior) {
        ok = await onReviseBehavior({
          behavior_id: selected.id,
          action: 'add_verification',
          scenarios: nextList,
          instruction: `为「${selected.shortTitle}」补充并验证新场景：输入「${input}」，期望「${expected}」。`,
        });
      } else if (onUpdateBehaviorContract) {
        ok = await onUpdateBehaviorContract({
          behavior_id: selected.id,
          scenarios: nextList,
        });
      }
      if (ok) {
        setNewInput('');
        setNewExpected('');
        setActivePanel(null);
      }
    } catch (e) {
      setPanelError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handlePrimaryAction(action: PrimaryAction) {
    if (action.behaviorId) setSelectedId(action.behaviorId);
    switch (action.kind) {
      case 'confirm_rules':
        requestAnimationFrame(() => decisionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        break;
      case 'approve_plan':
        onApprovePlan?.();
        break;
      case 'run_checks':
        void onRunHostChecks?.(action.checkKinds);
        break;
      case 'fix_behavior': {
        const target = model.behaviors.find(b => b.id === action.behaviorId) ?? selected;
        if (target && task.requirement_package && onReviseBehavior) {
          openFixPanel(target, 'fix_implementation');
          requestAnimationFrame(() => stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        } else {
          onAppend?.(target ? `修正「${target.shortTitle}」的实现并重新验证。` : undefined);
        }
        break;
      }
      case 'complete_verification': {
        const target = model.behaviors.find(b => b.id === action.behaviorId) ?? selected;
        if (target && task.requirement_package && onReviseBehavior) {
          openFixPanel(target, 'add_verification');
          requestAnimationFrame(() => stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        } else {
          onAppend?.(target ? `为「${target.shortTitle}」补齐验收场景验证。` : undefined);
        }
        break;
      }
      case 'handle_blocker':
        setAttentionOpen(true);
        if (!hasBlockers) onAppend?.('处理当前阻塞或检查失败项，并重新验证。');
        break;
      case 'cancel':
        onCancelTask?.();
        break;
      case 'continue':
        onAppend?.();
        break;
    }
  }

  const changedScenarioPreviews = useMemo(() => {
    if (!selected || activePanel !== 'adjust_rule') return [];
    return draftScenarios.flatMap(row => {
      const orig = selected.scenarios.find(s => s.id === row.id);
      if (!orig) return [{ input: row.input, before: '（新增）', after: row.expected }];
      if (orig.expected !== row.expected || orig.input !== row.input) {
        return [{ input: row.input, before: orig.expected, after: row.expected }];
      }
      return [];
    });
  }, [selected, activePanel, draftScenarios]);

  const ruleTextChanged = !!selected && activePanel === 'adjust_rule' && draftRule.trim() !== selected.ruleSummary.trim();
  const pendingCheckCount = model.engineeringChecks.filter(
    c => c.status === 'not_run' || c.status === 'stale' || c.status === 'agent_claimed',
  ).length;
  const runnableCheckKinds = model.engineeringChecks
    .filter(c => c.kind === 'test' || c.kind === 'typecheck' || c.kind === 'build')
    .map(c => c.kind as 'test' | 'typecheck' | 'build');

  return (
    <section className="task-behavior-cockpit" aria-label="任务结论与业务行为工作区">
      {/* ==================== 1. 顶部：一句当前结论 + 一个此刻有用的动作 ==================== */}
      <header className="bw-verdict-card" data-tone={model.verdict.tone}>
        <div className="bw-verdict-top">
          <div className="bw-title-row">
            <h2 className="bw-short-title" title={task.goal.replaceAll('`', '')}>
              {model.shortTitle}
            </h2>
            <span className="bw-version-tag">v{task.version}{historical ? ' · 历史版本' : ''}</span>
            <button type="button" className="bw-inline-link" aria-expanded={goalOpen} onClick={() => setGoalOpen(v => !v)}>
              {goalOpen ? '收起原始需求' : '查看原始需求'}
            </button>
            {anchor && onOpenReading && !historical && (
              <button type="button" className="bw-inline-link" onClick={onOpenReading} title={sourceLabel}>
                关联走读 ↗
              </button>
            )}
          </div>
          <div className="bw-verdict-body">
            <div className="bw-verdict-copy" role="status">
              <strong className="bw-verdict-headline">{model.verdict.headline}</strong>
              <p className="bw-verdict-detail">{model.verdict.detail}</p>
            </div>
            {!historical && (
              <div className="bw-verdict-cta">
                <button
                  type="button"
                  className={model.verdict.primaryAction.kind === 'cancel' ? 'bw-cta-danger' : 'primary'}
                  disabled={
                    (model.verdict.primaryAction.kind === 'cancel' ? busy : readOnly || runningChecks) ||
                    (model.verdict.primaryAction.kind === 'run_checks' && !onRunHostChecks)
                  }
                  onClick={() => handlePrimaryAction(model.verdict.primaryAction)}
                >
                  {runningChecks && model.verdict.primaryAction.kind === 'run_checks'
                    ? '正在运行检查…'
                    : model.verdict.primaryAction.label}
                </button>
              </div>
            )}
          </div>
          {goalOpen && (
            <div className="bw-original-goal">
              <span className="bw-kicker">原始需求描述</span>
              <p>
                <InlineCodeText text={task.goal} />
              </p>
            </div>
          )}
        </div>
        {liveActivitySlot && <div className="bw-live-slot">{liveActivitySlot}</div>}
      </header>

      {/* 阻塞 / 归属异常 / 独立审查待处理折叠提醒（仅在确有问题时出现） */}
      {hasBlockers && (
        <section className="bw-blocker-strip" aria-label="需要处理的阻塞或待核对事项">
          <div className="bw-blocker-head">
            <strong>需要处理</strong>
            <span>
              {task.diff_review?.verdict === 'needs_fix'
                ? task.diff_review.summary
                : model.attention.ownership[0] ?? model.attention.decisions[0]}
            </span>
            <button type="button" className="bw-inline-link" aria-expanded={attentionOpen} onClick={() => setAttentionOpen(v => !v)}>
              {attentionOpen ? '收起' : `查看全部 (${model.attention.decisions.length + model.attention.ownership.length + (task.diff_review?.verdict === 'needs_fix' ? 1 : 0)})`}
            </button>
          </div>
          {attentionOpen && (
            <ul className="bw-blocker-list">
              {task.diff_review?.verdict === 'needs_fix' && (
                <li>
                  <span>独立审查：{task.diff_review.summary}</span>
                  {onAppend && !historical && (
                    <button type="button" className="bw-mini-btn" onClick={() => onAppend(`处理独立审查问题：${task.diff_review!.summary}`)}>
                      去处理
                    </button>
                  )}
                </li>
              )}
              {model.attention.ownership.map(text => (
                <li key={`own:${text}`}>
                  <span>
                    <InlineCodeText text={text} />
                  </span>
                  <button type="button" className="bw-mini-btn" onClick={() => onViewChanges()}>
                    核对 Diff
                  </button>
                </li>
              ))}
              {model.attention.decisions.map(text => (
                <li key={`dec:${text}`}>
                  <span>
                    <InlineCodeText text={text} />
                  </span>
                  {onAppend && !historical && (
                    <button type="button" className="bw-mini-btn" onClick={() => onAppend(text)}>
                      回复 / 补充
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ==================== 2. 主体：左边选行为，右边看清并处理这一项 ==================== */}
      <div className="bw-main-grid">
        <nav className="bw-behavior-rail" aria-label="本次业务变更列表">
          <div className="bw-rail-heading">
            <span>业务变更</span>
            <small>{model.behaviors.length} 项</small>
          </div>
          <ol
            className="bw-behavior-list"
            onKeyDown={e => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              const idx = model.behaviors.findIndex(b => b.id === selected?.id);
              if (idx < 0) return;
              const nextIdx = e.key === 'ArrowDown' ? (idx + 1) % model.behaviors.length : (idx - 1 + model.behaviors.length) % model.behaviors.length;
              e.preventDefault();
              setSelectedId(model.behaviors[nextIdx].id);
            }}
          >
            {model.behaviors.map((item, idx) => {
              const active = item.id === selected?.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`bw-behavior-item${active ? ' is-selected' : ''}`}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="bw-behavior-index">{idx + 1}</span>
                    <span className="bw-behavior-copy">
                      <strong>{item.shortTitle}</strong>
                      <small className="bw-state-pill" data-state={item.summaryState}>
                        {behaviorStateLabels[item.summaryState]}
                      </small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {selected && (
          <article ref={stageRef} className="bw-behavior-stage" aria-label={`业务行为详情：${selected.shortTitle}`}>
            <header className="bw-stage-header">
              <div>
                <div className="bw-stage-title-row">
                  <h3>{selected.shortTitle}</h3>
                  <span className="bw-state-pill" data-state={selected.summaryState}>
                    {behaviorStateLabels[selected.summaryState]}
                  </span>
                </div>
                {selected.title !== selected.shortTitle && (
                  <p className="bw-stage-subtitle">
                    <InlineCodeText text={selected.title} />
                  </p>
                )}
              </div>
              <div className="bw-stage-links">
                {selected.files.length > 0 && (
                  <button
                    type="button"
                    className="bw-stage-chip"
                    onClick={() => onViewChanges(selected.changes.length === 1 ? selected.changes[0].path : selected.files[0])}
                  >
                    修改位置 · {selected.files.length} 文件
                  </button>
                )}
                {model.evolutionSignal.available && onOpenEvolution && (
                  <button type="button" className="bw-stage-chip" onClick={onOpenEvolution}>
                    {model.evolutionSignal.shouldHighlight ? '相关调用与架构变化' : '相关调用与代码差异'}
                  </button>
                )}
              </div>
            </header>

            {/* 显式待决规则对比卡（未决规则默认全展开对比表；交付阶段已确认规则默认一行摘要，按需展开对比） */}
            {selected.decisions.length > 0 && (
              <section ref={decisionRef} className="bw-decision-stack" aria-label="关键规则决定">
                {selected.decisions.map(decision => {
                  const showTable = !decision.resolved || isPlan || expandedDecisions.has(decision.id);
                  const toggleTable = () =>
                    setExpandedDecisions(prev => {
                      const next = new Set(prev);
                      if (next.has(decision.id)) next.delete(decision.id);
                      else next.add(decision.id);
                      return next;
                    });
                  return (
                    <div key={decision.id} className={`bw-decision-card${decision.resolved ? ' is-resolved' : ''}${showTable ? '' : ' is-compact'}`}>
                      <div className="bw-decision-head">
                        <span className="bw-decision-badge">{decision.resolved ? '已确认规则' : '待决定规则'}</span>
                        <strong>{decision.title}</strong>
                        {!showTable && decision.chosenLabel && (
                          <span className="bw-decision-summary">
                            {decision.chosenLabel}
                            {decision.chosenOutcome ? `（${decision.example_label ? `${decision.example_label}：` : ''}${decision.chosenOutcome}）` : ''}
                          </span>
                        )}
                        <span className="bw-decision-head-actions">
                          {decision.resolved && !isPlan && (
                            <button type="button" className="bw-inline-link" onClick={toggleTable}>
                              {showTable ? '收起对比' : '对比选项'}
                            </button>
                          )}
                          {decision.resolved && canMutateBehavior && (
                            <button type="button" className="bw-inline-link" onClick={() => openAdjustRule(selected, decision)}>
                              切换规则
                            </button>
                          )}
                        </span>
                      </div>
                      {showTable && (
                        <>
                          <p className="bw-decision-question">{decision.question}</p>
                          <table className="bw-decision-table">
                            <thead>
                              <tr>
                                <th scope="col">可选规则</th>
                                <th scope="col">{decision.example_label || '示例结果'}</th>
                                <th scope="col" className="bw-col-action">选择</th>
                              </tr>
                            </thead>
                            <tbody>
                              {decision.options.map(option => {
                                const chosen = decision.chosen_option_id === option.id && !decision.custom_rule;
                                return (
                                  <tr key={option.id} className={chosen ? 'is-chosen' : undefined}>
                                    <td>
                                      <strong>{option.label}</strong>
                                      {option.impact && <small className="bw-option-impact">{option.impact}</small>}
                                    </td>
                                    <td>{option.example_outcome || '—'}</td>
                                    <td className="bw-col-action">
                                      {chosen ? (
                                        <span className="bw-chosen-mark">当前采用</span>
                                      ) : (
                                        <button
                                          type="button"
                                          className="bw-mini-btn"
                                          disabled={!canMutateBehavior}
                                          onClick={() => void saveDecisionQuick(selected, decision, option.id)}
                                        >
                                          {isPlan ? '采用此规则' : '切到此规则'}
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                              {decision.custom_rule && (
                                <tr className="is-chosen">
                                  <td colSpan={2}>
                                    <strong>自定义约定：{decision.custom_rule}</strong>
                                  </td>
                                  <td className="bw-col-action">
                                    <span className="bw-chosen-mark">当前采用</span>
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </>
                      )}
                    </div>
                  );
                })}
              </section>
            )}

            {/* 当前约定 & 相对原行为的变化 */}
            <dl className="bw-contract-facts">
              <div>
                <dt>当前约定</dt>
                <dd>
                  <InlineCodeText text={selected.ruleSummary} />
                </dd>
              </div>
              {(selected.beforeBehavior || (selected.design && selected.design !== selected.ruleSummary)) && (
                <div>
                  <dt>相对原行为的变化</dt>
                  <dd>
                    {selected.beforeBehavior && (
                      <span className="bw-delta-before">
                        原行为：<InlineCodeText text={selected.beforeBehavior} />
                      </span>
                    )}
                    {selected.design && selected.design !== selected.ruleSummary && (
                      <span className="bw-delta-after">
                        {selected.beforeBehavior ? '改后：' : ''}
                        <InlineCodeText text={selected.design} />
                      </span>
                    )}
                  </dd>
                </div>
              )}
            </dl>

            {/* 验收场景表：输入 / 期望 / 实际 / 状态与证据 */}
            <section className="bw-scenarios-section" aria-label="验收场景">
              <div className="bw-section-head">
                <h4>验收场景</h4>
                {canMutateBehavior && (
                  <button
                    type="button"
                    className="bw-inline-link"
                    onClick={() => {
                      setPanelError('');
                      setActivePanel(prev => (prev === 'add_scenario' ? null : 'add_scenario'));
                    }}
                  >
                    + 追加验收场景
                  </button>
                )}
              </div>

              {selected.scenarios.length > 0 ? (
                <div className="bw-table-wrap">
                  <table className="bw-scenario-table">
                    <thead>
                      <tr>
                        <th scope="col">输入 / 条件</th>
                        <th scope="col">期望结果</th>
                        <th scope="col">实际结果</th>
                        <th scope="col">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.scenarios.map(row => (
                        <tr key={row.id} data-scenario-id={row.id} data-criterion-id={row.criterionId}>
                          <td>
                            <InlineCodeText text={row.input} />
                          </td>
                          <td>
                            <InlineCodeText text={row.expected} />
                          </td>
                          <td className={row.actual ? undefined : 'bw-empty-cell'}>
                            {row.actual ? <InlineCodeText text={row.actual} /> : '未运行'}
                          </td>
                          <td className="bw-scenario-status-cell">
                            <span className="bw-scenario-badge" data-status={row.status}>
                              {scenarioStatusLabels[row.status]}
                            </span>
                            {row.evidenceId && (
                              <button
                                type="button"
                                className="bw-inline-link"
                                onClick={() => onViewVerification(row.evidenceId)}
                              >
                                {row.logPath ? '记录' : '证据'}
                              </button>
                            )}
                            {canMutateBehavior && row.editable && (
                              <button
                                type="button"
                                className="bw-inline-link bw-row-edit-btn"
                                onClick={() => openAdjustRule(selected, undefined, undefined, row.id)}
                                title="直接调整该场景的期望或规则"
                              >
                                改期望
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted bw-empty-note">尚未补充具体边界场景；可点击右上角“追加验收场景”添加输入与期望结果。</p>
              )}

              {/* 行内追加验收场景 */}
              {activePanel === 'add_scenario' && canMutateBehavior && (
                <div
                  ref={adjustPanelRef as React.RefObject<HTMLDivElement>}
                  className="bw-closed-loop-panel"
                  role="region"
                  aria-label="追加验收场景"
                  onKeyDown={e => {
                    if (e.key === 'Escape' && !e.nativeEvent.isComposing) setActivePanel(null);
                  }}
                >
                  <div className="bw-panel-head">
                    <strong>为「{selected.shortTitle}」追加验收场景</strong>
                    <button type="button" className="bw-inline-link" onClick={() => setActivePanel(null)}>
                      取消
                    </button>
                  </div>
                  <div className="bw-scenario-add-grid">
                    <label>
                      输入 / 条件
                      <input
                        value={newInput}
                        placeholder="例如：订单小计 1500 元"
                        onChange={e => setNewInput(e.target.value)}
                      />
                    </label>
                    <label>
                      期望结果
                      <input
                        value={newExpected}
                        placeholder="例如：满减 150 元，总额 1350 元"
                        onChange={e => setNewExpected(e.target.value)}
                      />
                    </label>
                  </div>
                  {panelError && (
                    <p className="warning" role="alert">
                      {panelError}
                    </p>
                  )}
                  <div className="bw-panel-actions">
                    {!isPlan && canExecuteScenarioVerify && onReviseBehavior && (
                      <button type="button" className="primary" disabled={submitting} onClick={() => void submitNewScenario(true)}>
                        {submitting ? '提交中…' : '保存并补跑这项验证'}
                      </button>
                    )}
                    <button type="button" disabled={submitting} onClick={() => void submitNewScenario(false)}>
                      仅保存到场景表
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* 针对当前行为的直接操作栏 */}
            {!historical && (
              <div className="bw-behavior-actions" role="group" aria-label={`处理「${selected.shortTitle}」`}>
                <button
                  type="button"
                  disabled={!canMutateBehavior}
                  aria-pressed={activePanel === 'adjust_rule'}
                  onClick={() => (activePanel === 'adjust_rule' ? setActivePanel(null) : openAdjustRule(selected))}
                >
                  调整此项要求
                </button>
                {!isPlan && (
                  <>
                    <button
                      type="button"
                      disabled={readOnly}
                      aria-pressed={activePanel === 'fix_implementation'}
                      onClick={() =>
                        activePanel === 'fix_implementation'
                          ? setActivePanel(null)
                          : task.requirement_package && onReviseBehavior
                            ? openFixPanel(selected, 'fix_implementation')
                            : onAppend?.(`修正「${selected.shortTitle}」实现：`)
                      }
                    >
                      要求修正实现
                    </button>
                    {canExecuteScenarioVerify && (
                      <button
                        type="button"
                        disabled={readOnly}
                        aria-pressed={activePanel === 'add_verification'}
                        onClick={() =>
                          activePanel === 'add_verification'
                            ? setActivePanel(null)
                            : task.requirement_package && onReviseBehavior
                              ? openFixPanel(selected, 'add_verification')
                              : onAppend?.(`补齐「${selected.shortTitle}」验证测试：`)
                        }
                      >
                        补齐这项验证
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* 闭环面板 A：调整此项要求 + 场景期望影响预览 + 交由执行器处理 */}
            {activePanel === 'adjust_rule' && canMutateBehavior && (
              <section
                ref={adjustPanelRef}
                className="bw-closed-loop-panel"
                aria-label="调整此项要求与影响预览"
                onKeyDown={e => {
                  if (e.key === 'Escape' && !e.nativeEvent.isComposing) setActivePanel(null);
                }}
              >
                <div className="bw-panel-head">
                  <strong>调整「{selected.shortTitle}」规则与场景期望</strong>
                  <button type="button" className="bw-inline-link" onClick={() => setActivePanel(null)}>
                    取消
                  </button>
                </div>

                {selected.decisions.map(decision => (
                  <div key={decision.id} className="bw-adjust-options">
                    <span className="bw-kicker">快速切换规则选项（{decision.title}）</span>
                    <div className="bw-option-pills">
                      {decision.options.map(option => (
                        <button
                          key={option.id}
                          type="button"
                          className="bw-option-pill"
                          aria-pressed={draftDecisionId === decision.id && draftOptionId === option.id}
                          onClick={() => {
                            setDraftDecisionId(decision.id);
                            selectDraftOption(decision, option.id);
                          }}
                        >
                          <span>{option.label}</span>
                          {option.example_outcome && <small>{decision.example_label ? `${decision.example_label}：${option.example_outcome}` : option.example_outcome}</small>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="bw-adjust-split">
                  <label className="bw-field">
                    新的规则约定
                    <textarea
                      rows={2}
                      value={draftRule}
                      onChange={e => setDraftRule(e.target.value)}
                      placeholder="明确写出改后的业务规则，例如：每满 500 减 50，可累计"
                    />
                  </label>
                  {!isPlan && (
                    <label className="bw-field">
                      给执行器的补充说明（可选）
                      <textarea
                        rows={2}
                        value={draftInstruction}
                        onChange={e => setDraftInstruction(e.target.value)}
                        placeholder="自动携带当前行为约定、期望差异与关联文件"
                      />
                    </label>
                  )}
                </div>

                {draftScenarios.length > 0 && (
                  <div className="bw-adjust-scenarios">
                    <span className="bw-kicker">同步核对受影响场景的期望结果</span>
                    {draftScenarios.map((row, idx) => (
                      <div key={row.id} className={`bw-adjust-scenario-row${focusScenarioId === row.id ? ' is-focused' : ''}`}>
                        <span className="bw-adjust-input">{row.input}</span>
                        <input
                          data-edit-scenario-id={row.id}
                          aria-label={`场景 ${row.input} 的期望结果`}
                          value={row.expected}
                          onChange={e => {
                            const next = e.target.value;
                            setDraftScenarios(list => list.map((item, i) => (i === idx ? { ...item, expected: next } : item)));
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* 明确展示本次调整对场景、实现文件与原有证据的影响 */}
                <div className="bw-impact-preview" role="status">
                  <strong>本次调整影响预览</strong>
                  <ul>
                    {changedScenarioPreviews.length > 0 ? (
                      changedScenarioPreviews.map((diff, i) => (
                        <li key={i}>
                          场景「{diff.input}」期望：<del>{diff.before}</del> → <ins>{diff.after}</ins>
                        </li>
                      ))
                    ) : ruleTextChanged ? (
                      <li>规则约定已变更，请核对上方场景期望是否同步更新。</li>
                    ) : (
                      <li>尚未修改规则或场景期望。</li>
                    )}
                    {selected.files.length > 0 && (
                      <li>
                        需要重新处理的实现：
                        {selected.files.map(file => (
                          <code className="inline-code" key={file}>
                            {file}
                          </code>
                        ))}
                      </li>
                    )}
                    {!isPlan && <li>原有验证证据将标记为「待复验」；执行器处理完成后，新实际结果会回到上方同一张场景表。</li>}
                  </ul>
                </div>

                {panelError && (
                  <p className="warning" role="alert">
                    {panelError}
                  </p>
                )}

                <div className="bw-panel-actions">
                  {!isPlan && onReviseBehavior ? (
                    <>
                      <button type="button" className="primary" disabled={submitting} onClick={() => void submitRuleAdjustment(true)}>
                        {submitting ? '正在派发处理…' : '确认并让执行器处理这一项'}
                      </button>
                      <button type="button" disabled={submitting} onClick={() => void submitRuleAdjustment(false)}>
                        仅保存约定修改
                      </button>
                    </>
                  ) : (
                    <button type="button" className="primary" disabled={submitting} onClick={() => void submitRuleAdjustment(false)}>
                      {submitting ? '保存中…' : '保存规则约定'}
                    </button>
                  )}
                </div>
              </section>
            )}

            {/* 闭环面板 B：要求修正实现 / 补齐这项验证 */}
            {(activePanel === 'fix_implementation' || activePanel === 'add_verification') && canMutateBehavior && (
              <section
                ref={adjustPanelRef}
                className="bw-closed-loop-panel"
                aria-label={activePanel === 'fix_implementation' ? '要求修正实现' : '补齐这项验证'}
                onKeyDown={e => {
                  if (e.key === 'Escape' && !e.nativeEvent.isComposing) setActivePanel(null);
                }}
              >
                <div className="bw-panel-head">
                  <strong>{activePanel === 'fix_implementation' ? `要求修正「${selected.shortTitle}」实现` : `补齐「${selected.shortTitle}」验证`}</strong>
                  <button type="button" className="bw-inline-link" onClick={() => setActivePanel(null)}>
                    取消
                  </button>
                </div>
                <p className="bw-panel-context">
                  自动携带：当前约定「{selected.ruleSummary}」、{selected.scenarios.length} 条场景与 {selected.files.length} 个关联文件。
                </p>
                <label className="bw-field">
                  具体处理要求
                  <textarea rows={3} value={draftInstruction} onChange={e => setDraftInstruction(e.target.value)} />
                </label>
                {panelError && (
                  <p className="warning" role="alert">
                    {panelError}
                  </p>
                )}
                <div className="bw-panel-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={submitting}
                    onClick={() => void submitTargetedAction(activePanel)}
                  >
                    {submitting ? '正在提交…' : activePanel === 'fix_implementation' ? '交给执行器修正这一项' : '交给执行器补齐验证'}
                  </button>
                </div>
              </section>
            )}
          </article>
        )}
      </div>

      {/* 方案确认辅助槽位（审阅修改范围与红线，仅 ready 阶段呈现） */}
      {isPlan && planSlot && <div className="bw-plan-slot">{planSlot}</div>}

      {/* ==================== 3. 底部：工程检查单独归组 + 代码与记录按需打开 ==================== */}
      <section className="bw-engineering-checks" aria-label="工程检查">
        <header className="bw-checks-head">
          <div>
            <h4>工程检查</h4>
            <small>与业务场景分属不同层次；命令通过仅代表检查本身通过，不会自动将业务行为标为通过。</small>
          </div>
          {!historical && onRunHostChecks && runnableCheckKinds.length > 0 && !isPlan && (
            <button
              type="button"
              className="bw-mini-btn"
              disabled={readOnly || runningChecks}
              onClick={() => void onRunHostChecks(pendingCheckCount > 0 ? model.verdict.primaryAction.checkKinds : runnableCheckKinds)}
            >
              {runningChecks ? '正在运行…' : pendingCheckCount > 0 ? '运行待执行的检查' : '重新运行工程检查'}
            </button>
          )}
        </header>

        {model.engineeringChecks.length > 0 ? (
          <ul className="bw-check-list">
            {model.engineeringChecks.map(check => (
              <li key={check.id} className="bw-check-row">
                <span className="bw-check-kind">{check.label}</span>
                <code className="bw-check-cmd">{check.command}</code>
                <span className="bw-check-status" data-status={check.status}>
                  {checkStatusLabels[check.status]}
                  {check.status === 'passed' && check.metrics?.passed ? ` · ${check.metrics.passed} 项` : ''}
                  {check.status === 'failed' && check.exitCode !== null ? ` · exit ${check.exitCode}` : ''}
                </span>
                {check.evidenceId && (
                  <button type="button" className="bw-inline-link" onClick={() => onViewVerification(check.evidenceId)}>
                    查看日志
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted bw-empty-note">当前工程未配置自动检查命令（test / typecheck / build），也尚无已观测命令记录。</p>
        )}
      </section>

      <footer className="bw-records-footer" aria-label="按需查看代码与记录">
        <button type="button" className="bw-record-chip" onClick={() => onViewChanges()}>
          修改文件与 Diff <span>{task.changes.length}</span>
        </button>
        {model.evolutionSignal.available && onOpenEvolution && (
          <button
            type="button"
            className={`bw-record-chip${model.evolutionSignal.shouldHighlight ? ' is-highlighted' : ''}`}
            onClick={onOpenEvolution}
          >
            {model.evolutionSignal.label}
            {model.evolutionSignal.summary && <span>{model.evolutionSignal.summary}</span>}
          </button>
        )}
        {onOpenLogs && (
          <button type="button" className="bw-record-chip" onClick={onOpenLogs}>
            执行记录与验证日志 {attemptsCount > 0 && <span>{attemptsCount} 次</span>}
          </button>
        )}
        {onOpenPackage && task.requirement_package && (
          <button type="button" className="bw-record-chip" onClick={onOpenPackage}>
            正式需求包与红线
          </button>
        )}
        {onOpenHistory && (
          <button type="button" className="bw-record-chip" onClick={onOpenHistory}>
            版本记录 <span>v{task.version}</span>
          </button>
        )}
      </footer>
    </section>
  );
}
