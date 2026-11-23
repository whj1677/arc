import { commandBody, evidenceFailed, evidenceSupportsPass, sameVerificationState } from '../delivery-audit';
import type {
  BehaviorScenario,
  DevelopmentCriterion,
  DevelopmentStep,
  EngineeringTask,
  FileChange,
  RuleDecision,
  VerificationEvidence,
} from '../engineering';
import type { TaskHudSnapshot } from '../development-hud';
import type { ProjectEnvironment } from '../main/env-probe';
import { effectiveTaskBoundaries } from '../task-boundaries';

export type BehaviorPhase = 'plan' | 'developing' | 'acceptance';
export type ImplementationState = 'not_started' | 'planned' | 'in_progress' | 'implemented' | 'blocked';
export type BehaviorVerification = 'verified' | 'failed' | 'partial' | 'stale' | 'agent_claimed' | 'unverified';
export type BehaviorSummaryState =
  | 'needs_decision'
  | 'failed'
  | 'blocked'
  | 'stale'
  | 'verified'
  | 'unverified'
  | 'planned'
  | 'in_progress';
export type EngineeringCheckKind = 'test' | 'typecheck' | 'build' | 'other';
export type EngineeringCheckStatus = 'not_run' | 'passed' | 'failed' | 'stale' | 'agent_claimed';

export interface BehaviorAcceptance {
  id: string;
  criterionId?: string;
  text: string;
  implementation: ImplementationState;
  verification: BehaviorVerification;
  evidence: VerificationEvidence[];
  isEngineeringCheck?: boolean;
}

export interface BehaviorScenarioView {
  id: string;
  input: string;
  expected: string;
  actual?: string;
  status: 'unverified' | 'passed' | 'failed' | 'stale';
  evidenceId?: string;
  logPath?: string;
  criterionId?: string;
  editable: boolean;
}

export interface RuleDecisionView extends RuleDecision {
  resolved: boolean;
  chosenLabel?: string;
  chosenOutcome?: string;
}

export interface EngineeringCheckView {
  id: string;
  kind: EngineeringCheckKind;
  label: string;
  command: string;
  status: EngineeringCheckStatus;
  exitCode: number | null;
  metrics?: VerificationEvidence['metrics'];
  createdAt?: string;
  evidenceId?: string;
  logPath?: string;
  note?: string;
}

export interface TaskBehavior {
  id: string;
  shortTitle: string;
  title: string;
  beforeBehavior?: string;
  ruleSummary: string;
  design?: string;
  progress: string[];
  files: string[];
  stepIds: string[];
  changes: FileChange[];
  before?: NonNullable<EngineeringTask['reading']>['evidence'];
  implementation: ImplementationState;
  verification: BehaviorVerification;
  summaryState: BehaviorSummaryState;
  acceptance: BehaviorAcceptance[];
  scenarios: BehaviorScenarioView[];
  decisions: RuleDecisionView[];
  hasStructuredScenarios: boolean;
}

export interface PrimaryAction {
  kind:
    | 'confirm_rules'
    | 'approve_plan'
    | 'handle_blocker'
    | 'fix_behavior'
    | 'run_checks'
    | 'complete_verification'
    | 'cancel'
    | 'continue';
  label: string;
  behaviorId?: string;
  checkKinds?: ('typecheck' | 'test' | 'build')[];
}

export interface TaskVerdict {
  headline: string;
  detail: string;
  tone: 'neutral' | 'warning' | 'danger' | 'success';
  primaryAction: PrimaryAction;
}

export interface EvolutionSignal {
  available: boolean;
  hasRealArchitectureShift: boolean;
  hasRealFlowShift: boolean;
  shouldHighlight: boolean;
  label: string;
  summary?: string;
}

function phaseOf(task: EngineeringTask): BehaviorPhase {
  if (task.workflow === 'analysis' || task.workflow === 'ready') return 'plan';
  if (task.status === 'running' || (task.status === 'pending' && task.workflow === 'execution')) return 'developing';
  return task.status === 'pending' ? 'plan' : 'acceptance';
}

function implementationOf(task: EngineeringTask, steps: DevelopmentStep[], planned: boolean, captured: boolean): ImplementationState {
  if (task.rolled_back_at) return 'not_started';
  if (steps.some(step => step.status === 'failed' || step.status === 'blocked')) return 'blocked';
  if (steps.length && steps.every(step => step.status === 'completed')) return 'implemented';
  if (steps.some(step => step.status === 'in_progress') || (steps.some(step => step.status === 'completed') && phaseOf(task) === 'developing')) {
    return 'in_progress';
  }
  if (task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted') return 'blocked';
  if (captured && !steps.length) return 'implemented';
  return planned ? 'planned' : 'not_started';
}

// These commands can be attached to criteria by the host's generic delivery checks.
const structuralCheck =
  /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:(?:run|run-script)\s+)?(?:build|typecheck|lint)\b|(?:npx\s+)?tsc\b|git\s+diff\s+--check\b|cmake\s+(?:--build|-S\s)|(?:\.\x2f|\.\\)?(?:go|cargo|gradle|gradlew|dotnet)(?:\.cmd|\.bat)?\s+(?:build|check|assemble)\b|(?:\.\x2f|\.\\)?mvnw?(?:\.cmd)?\s+(?:compile|package)\b|make(?:\s+(?:build|all))?\s*$)/i;

const pureCheckCriterion =
  /^(?:运行|执行|确保|通过)?\s*`?(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|typecheck|build|lint)|(?:npx\s+)?tsc(?:\s+--noEmit)?|pytest|vitest|jest|cargo\s+(?:test|check|build)|go\s+(?:test|build)|(?:单元测试|全部测试|现有测试|类型检查|编译构建|构建与测试))`?\s*(?:全部)?(?:通过|成功|无报错|无错误|0\s*错误|零错误)?[。.;；]*$/i;

function isEngineeringCheckText(text: string) {
  return pureCheckCriterion.test(text.trim());
}

function classifyCommandKind(cmd: string, explicitKind?: VerificationEvidence['verification_kind']): EngineeringCheckKind {
  if (explicitKind === 'test' || explicitKind === 'typecheck' || explicitKind === 'build') return explicitKind;
  const body = commandBody(cmd);
  if (/\b(typecheck|tsc)\b/i.test(body)) return 'typecheck';
  if (/\b(test|pytest|vitest|jest|mocha|ctest|unittest)\b/i.test(body)) return 'test';
  if (/\b(build|compile|package|assemble)\b/i.test(body)) return 'build';
  return 'other';
}

const checkKindLabels: Record<EngineeringCheckKind, string> = {
  test: '测试',
  typecheck: '类型检查',
  build: '构建',
  other: '命令检查',
};

function shortLabel(raw: string, maxLen = 22) {
  const cleaned = raw
    .trim()
    .replace(/^对\s+\S+\s+进行\s*ARC\s*只读需求分析[，,:：\s]*/i, '')
    .replace(/`([^`]+)`/g, '$1')
    .split(/[\r\n。！？；;]/)[0]
    .trim();
  if (!cleaned) return raw.trim().slice(0, maxLen);
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

function evidenceFor(task: EngineeringTask, step: DevelopmentStep, criterion?: DevelopmentCriterion) {
  return task.verification.filter(item => {
    if (item.step_id && item.step_id !== step.step_id) return false;
    if (!criterion) return item.step_id === step.step_id || step.evidence_ids.includes(item.evidence_id);
    if (item.criterion_id && item.criterion_id !== criterion.criterion_id) return false;
    return criterion.evidence_ids.includes(item.evidence_id) || (item.step_id === step.step_id && item.criterion_id === criterion.criterion_id);
  });
}

function verificationOf(
  task: EngineeringTask,
  evidence: VerificationEvidence[],
  criterion: boolean,
  step?: DevelopmentStep,
  liveState?: EngineeringTask['baseline'],
): BehaviorVerification {
  const reported = evidence.some(item => item.origin === 'self_reported' && item.outcome !== 'not_run');
  const observed = evidence.filter(item => item.origin === 'observed' && item.outcome !== 'not_run');
  if (!observed.length) return reported ? 'agent_claimed' : 'unverified';
  if (task.rolled_back_at || step?.verification_status === 'stale' || (task.verification_status === 'stale' && !step?.verification_status)) {
    return 'stale';
  }

  if (!task.end_state && phaseOf(task) === 'developing') return observed.some(evidenceFailed) ? 'failed' : 'partial';
  const comparable = observed.filter(item => !!item.code_state.workspace_fingerprint);
  const expectedState = liveState ?? task.end_state ?? task.baseline;
  const current = observed.filter(item => sameVerificationState(item.code_state, expectedState));
  if (!current.length) return comparable.length ? 'stale' : 'partial';
  const latest = new Map<string, VerificationEvidence>();
  for (const item of current) {
    const command = commandBody(item.command);
    const prior = latest.get(command);
    if (!prior || prior.created_at <= item.created_at) latest.set(command, item);
  }
  const checks = [...latest.values()];
  if (checks.some(evidenceFailed)) return 'failed';
  const behaviorChecks = checks.filter(item => !structuralCheck.test(commandBody(item.command)));
  if (criterion && behaviorChecks.length && behaviorChecks.every(item => evidenceSupportsPass(item) && !item.metrics?.skipped)) {
    return 'verified';
  }
  return 'partial';
}

function aggregateVerification(rows: BehaviorAcceptance[]): BehaviorVerification {
  if (!rows.length) return 'unverified';
  if (rows.some(row => row.verification === 'failed')) return 'failed';
  if (rows.every(row => row.verification === 'verified')) return 'verified';
  if (rows.some(row => row.verification === 'stale')) return 'stale';
  if (rows.some(row => row.verification === 'partial' || row.verification === 'verified')) return 'partial';
  return rows.some(row => row.verification === 'agent_claimed') ? 'agent_claimed' : 'unverified';
}

function resolveScenarioRow(
  task: EngineeringTask,
  row: BehaviorScenario,
  evidenceMap: Map<string, VerificationEvidence>,
  behaviorSteps: DevelopmentStep[],
  liveState?: EngineeringTask['baseline'],
): BehaviorScenarioView {
  const linked = row.evidence_id ? evidenceMap.get(row.evidence_id) : undefined;
  let status: BehaviorScenarioView['status'] = row.status ?? 'unverified';
  if (status === 'passed') {
    if (!linked || linked.origin !== 'observed' || !evidenceSupportsPass(linked)) {
      status = linked && evidenceFailed(linked) ? 'failed' : 'unverified';
    } else if (
      task.rolled_back_at ||
      task.changes_status === 'needs_review' ||
      behaviorSteps.some(step => step.verification_status === 'stale') ||
      (task.end_state && !sameVerificationState(linked.code_state, task.end_state)) ||
      (liveState && !sameVerificationState(linked.code_state, liveState))
    ) {
      status = 'stale';
    }
  }
  return {
    id: row.id,
    input: row.input,
    expected: row.expected,
    actual: row.actual,
    status,
    evidenceId: linked?.evidence_id ?? row.evidence_id,
    logPath: linked?.log_path,
    criterionId: row.criterion_id,
    editable: true,
  };
}

function scenarioFromAcceptance(row: BehaviorAcceptance): BehaviorScenarioView {
  const evidence = row.evidence.filter(e => e.origin === 'observed').at(-1) ?? row.evidence.at(-1);
  const status: BehaviorScenarioView['status'] =
    row.verification === 'verified'
      ? 'passed'
      : row.verification === 'failed'
        ? 'failed'
        : row.verification === 'stale'
          ? 'stale'
          : 'unverified';
  const actual =
    status === 'passed'
      ? evidence?.metrics?.passed
        ? `已观测通过（${evidence.metrics.passed} 项）`
        : '已观测通过'
      : status === 'failed'
        ? `失败（exit ${evidence?.exit_code ?? '未知'}）`
        : status === 'stale'
          ? '旧版本验证记录，代码或约定已变更'
          : undefined;
  return {
    id: row.criterionId ?? row.id,
    input: '验收条件',
    expected: row.text,
    actual,
    status,
    evidenceId: evidence?.evidence_id,
    logPath: evidence?.log_path,
    criterionId: row.criterionId,
    editable: false,
  };
}

function deriveEngineeringChecks(task: EngineeringTask, environment?: ProjectEnvironment | null, liveCodeState?: EngineeringTask['baseline']): EngineeringCheckView[] {
  const currentState = liveCodeState ?? task.end_state ?? task.baseline;
  const byCommand = new Map<string, { kind: EngineeringCheckKind; command: string; receipts: VerificationEvidence[] }>();

  for (const kind of ['test', 'typecheck', 'build'] as const) {
    const cmd = environment?.effective_commands[kind]?.trim();
    if (!cmd) continue;
    const key = commandBody(cmd);
    byCommand.set(key, { kind, command: cmd, receipts: [] });
  }

  for (const item of task.verification) {
    const cmd = commandBody(item.command);
    if (!cmd || cmd.includes('\n')) continue;
    const kind = classifyCommandKind(cmd, item.verification_kind);
    const existing = byCommand.get(cmd);
    if (existing) {
      existing.receipts.push(item);
      continue;
    }
    if (kind === 'test') {
      const configuredTest = [...byCommand.values()].find(entry => entry.kind === 'test' && !entry.receipts.length);
      if (configuredTest && cmd.startsWith(commandBody(configuredTest.command))) {
        configuredTest.command = cmd;
        configuredTest.receipts.push(item);
        continue;
      }
    }
    if (item.criterion_id && !item.verification_kind && !item.note?.includes('ARC 宿主')) continue;
    if (kind === 'other' && !item.note?.includes('ARC 宿主')) continue;
    byCommand.set(cmd, { kind, command: cmd, receipts: [item] });
  }

  const order: Record<EngineeringCheckKind, number> = { test: 0, typecheck: 1, build: 2, other: 3 };
  return [...byCommand.entries()]
    .sort(([, a], [, b]) => order[a.kind] - order[b.kind])
    .map(([key, entry]) => {
      const sorted = [...entry.receipts].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const observed = sorted.filter(item => item.origin === 'observed' && item.outcome !== 'not_run');
      const latestObserved = observed.at(-1);
      const latestAny = sorted.at(-1);
      let status: EngineeringCheckStatus = 'not_run';
      let chosen: VerificationEvidence | undefined = latestObserved;
      if (!latestObserved) {
        status = latestAny && latestAny.outcome !== 'not_run' ? 'agent_claimed' : 'not_run';
        chosen = latestAny;
      } else if (task.rolled_back_at) {
        status = 'stale';
      } else {
        const currentObserved = observed.filter(item => sameVerificationState(item.code_state, currentState));
        const active = currentObserved.at(-1);
        if (!active) {
          status = 'stale';
          chosen = latestObserved;
        } else {
          chosen = active;
          if (evidenceFailed(active)) status = 'failed';
          else if (evidenceSupportsPass(active)) status = 'passed';
          else status = 'stale';
        }
      }
      return {
        id: `${entry.kind}:${key}`,
        kind: entry.kind,
        label: checkKindLabels[entry.kind],
        command: entry.command,
        status,
        exitCode: chosen?.exit_code ?? null,
        metrics: chosen?.metrics,
        createdAt: chosen?.created_at,
        evidenceId: chosen?.evidence_id,
        logPath: chosen?.log_path,
        note: chosen?.note,
      };
    });
}

function summarizeBehaviorState(
  phase: BehaviorPhase,
  implementation: ImplementationState,
  verification: BehaviorVerification,
  decisions: RuleDecisionView[],
  scenarios: BehaviorScenarioView[],
): BehaviorSummaryState {
  if (decisions.some(d => !d.resolved)) return 'needs_decision';
  if (scenarios.some(s => s.status === 'failed') || verification === 'failed') return 'failed';
  if (implementation === 'blocked') return 'blocked';
  if (phase === 'plan') return 'planned';
  if (phase === 'developing' && implementation === 'in_progress') return 'in_progress';
  if (scenarios.some(s => s.status === 'stale') || verification === 'stale') return 'stale';
  const allScenariosPassed = scenarios.length > 0 && scenarios.every(s => s.status === 'passed');
  if (allScenariosPassed || (!scenarios.length && verification === 'verified')) return 'verified';
  return 'unverified';
}

export function computeEvolutionSignal(hud?: TaskHudSnapshot | null): EvolutionSignal {
  const evo = hud?.evolution;
  if (!evo) {
    return {
      available: false,
      hasRealArchitectureShift: false,
      hasRealFlowShift: false,
      shouldHighlight: false,
      label: '修改位置与代码差异',
    };
  }
  const hasRealArchitectureShift =
    evo.architecture.edges.some(edge => edge.kind !== 'existing') ||
    evo.architecture.modules.filter(mod => mod.changed_files.some(file => !/(?:^|\/)(?:tests?|__tests__)\//i.test(file))).length >= 2;
  const hasRealFlowShift = evo.features.some(feature => feature.steps.some(step => step.status !== 'unchanged'));
  const shouldHighlight = hasRealArchitectureShift || hasRealFlowShift;
  const parts: string[] = [];
  if (hasRealArchitectureShift) parts.push(`${evo.architecture.modules.filter(m => m.changed_files.length > 0).length} 个模块结构变动`);
  if (hasRealFlowShift) parts.push(`${evo.features.filter(f => f.steps.some(s => s.status !== 'unchanged')).length} 条业务调用路径变化`);
  return {
    available: true,
    hasRealArchitectureShift,
    hasRealFlowShift,
    shouldHighlight,
    label: shouldHighlight ? '架构与调用变化' : '修改位置与代码差异',
    summary: parts.length ? parts.join(' · ') : undefined,
  };
}

export function projectTaskBehavior(
  task: EngineeringTask,
  options?: { environment?: ProjectEnvironment | null; hud?: TaskHudSnapshot | null; beforeReading?: string; liveCodeState?: EngineeringTask['baseline'] },
) {
  const phase = phaseOf(task);
  const pkg = task.requirement_package;
  const steps = (task.steps ?? []).filter(step => step.status !== 'superseded');
  const evidenceMap = new Map(task.verification.map(item => [item.evidence_id, item] as const));
  const taskFiles = [
    ...new Set([
      ...(task.approval?.scope ?? task.proposed_scope ?? task.scope),
      ...task.changes.map(change => change.path),
      ...(task.reading?.evidence ? [task.reading.evidence.path] : []),
    ]),
  ];

  const allDecisions: RuleDecisionView[] = (pkg?.rule_decisions ?? []).map(decision => {
    const chosen = decision.chosen_option_id ? decision.options.find(opt => opt.id === decision.chosen_option_id) : undefined;
    const resolved = Boolean(chosen || decision.custom_rule?.trim());
    return {
      ...decision,
      resolved,
      chosenLabel: decision.custom_rule?.trim() || chosen?.label,
      chosenOutcome: chosen?.example_outcome,
    };
  });

  const inputs = pkg?.behaviors.length
    ? pkg.behaviors.map(behavior => ({
        id: behavior.id,
        shortTitle: behavior.short_title?.trim() || shortLabel(behavior.behavior, 18),
        title: behavior.behavior,
        beforeBehavior: behavior.before_behavior?.trim() || undefined,
        ruleSummary: behavior.rule_summary?.trim() || behavior.behavior,
        design: behavior.design,
        files: behavior.files,
        stepIds: behavior.step_ids,
        steps: behavior.step_ids.flatMap(id => steps.filter(step => step.step_id === id)),
        verificationPlan: behavior.verification,
        structuredScenarios: behavior.scenarios ?? [],
        taskWide: false,
      }))
    : steps.length
      ? steps.map(step => ({
          id: step.step_id,
          shortTitle: shortLabel(step.title, 18),
          title: step.title,
          beforeBehavior: undefined,
          ruleSummary: step.change || step.title,
          design: step.change,
          files: [] as string[],
          stepIds: [step.step_id],
          steps: [step],
          verificationPlan: '',
          structuredScenarios: [] as BehaviorScenario[],
          taskWide: steps.length === 1,
        }))
      : [
          {
            id: task.task_id,
            shortTitle: shortLabel(task.title || task.goal, 18),
            title: task.goal,
            beforeBehavior: undefined,
            ruleSummary: task.goal,
            design: '',
            files: [],
            stepIds: [],
            steps: [],
            verificationPlan: '',
            structuredScenarios: [] as BehaviorScenario[],
            taskWide: true,
          },
        ];

  const behaviors = inputs.map<TaskBehavior>((input, index) => {
    const relatedChanges = task.changes.filter(change => input.taskWide || input.files.includes(change.path));
    const captured = task.changes_status !== 'needs_review' && relatedChanges.some(change => change.ownership === 'task_change');
    const implementation = implementationOf(task, input.steps, !!input.design || input.steps.length > 0, captured);
    const acceptance = input.steps.flatMap(step =>
      step.criteria.map<BehaviorAcceptance>(criterion => {
        const evidence = evidenceFor(task, step, criterion);
        return {
          id: JSON.stringify([step.step_id, criterion.criterion_id]),
          criterionId: criterion.criterion_id,
          text: criterion.text,
          implementation: implementationOf(task, [step], true, false),
          evidence,
          verification: verificationOf(task, evidence, true, step, options?.liveCodeState),
          isEngineeringCheck: isEngineeringCheckText(criterion.text),
        };
      }),
    );
    if (!acceptance.length) {
      const evidence = [...new Set(input.taskWide ? task.verification : input.steps.flatMap(step => evidenceFor(task, step)))];
      acceptance.push({
        id: input.id,
        text: input.verificationPlan || input.title,
        implementation,
        evidence,
        verification: verificationOf(task, evidence, false, input.steps.length === 1 ? input.steps[0] : undefined, options?.liveCodeState),
        isEngineeringCheck: isEngineeringCheckText(input.verificationPlan || input.title),
      });
    }

    const behaviorDecisions = allDecisions.filter(
      decision => decision.behavior_id === input.id || (!decision.behavior_id && index === 0),
    );
    const hasStructuredScenarios = input.structuredScenarios.length > 0;
    const businessAcceptance = acceptance.filter(row => !row.isEngineeringCheck);
    const scenarios = hasStructuredScenarios
      ? input.structuredScenarios.map(row => resolveScenarioRow(task, row, evidenceMap, input.steps, options?.liveCodeState))
      : (businessAcceptance.length ? businessAcceptance : acceptance).map(scenarioFromAcceptance);

    const anchor = task.reading?.evidence;
    const before = anchor && (input.taskWide || input.files.includes(anchor.path)) ? anchor : undefined;
    const beforeBehavior = input.beforeBehavior ?? (before && inputs.length === 1 ? options?.beforeReading : undefined);

    const effectiveVerification: BehaviorVerification = hasStructuredScenarios
      ? scenarios.some(s => s.status === 'failed')
        ? 'failed'
        : scenarios.every(s => s.status === 'passed')
          ? 'verified'
          : scenarios.some(s => s.status === 'stale')
            ? 'stale'
            : scenarios.some(s => s.status === 'passed')
              ? 'partial'
              : aggregateVerification(acceptance)
      : aggregateVerification(acceptance);

    const summaryState = summarizeBehaviorState(phase, implementation, effectiveVerification, behaviorDecisions, scenarios);

    return {
      id: input.id,
      shortTitle: input.shortTitle,
      title: input.title,
      beforeBehavior,
      ruleSummary: input.ruleSummary,
      design: input.design,
      progress: input.steps.map(step => step.progress).filter(Boolean),
      files: input.taskWide ? taskFiles : input.files,
      stepIds: input.stepIds,
      changes: relatedChanges,
      before,
      implementation,
      verification: effectiveVerification,
      summaryState,
      acceptance,
      scenarios,
      decisions: behaviorDecisions,
      hasStructuredScenarios,
    };
  });

  const engineeringChecks = deriveEngineeringChecks(task, options?.environment, options?.liveCodeState);
  const evolutionSignal = computeEvolutionSignal(options?.hud);

  const decisions = [
    ...new Set([
      ...(pkg?.open_questions ?? []),
      ...(pkg?.risks ?? []),
      ...task.unresolved,
      ...steps.flatMap(step => step.unresolved),
    ]),
  ];
  const ownership = [
    ...(task.changes_status === 'needs_review' ? ['差异归属待核查'] : []),
    ...task.changes
      .filter(change => change.ownership === 'preexisting_overlap')
      .map(change => `${change.path} · 含开始前已有改动`),
  ];
  const verification = behaviors.flatMap(behavior =>
    behavior.acceptance.filter(row => row.verification !== 'verified').map(row => ({ ...row, behaviorId: behavior.id })),
  );
  const unresolvedDecisions = allDecisions.filter(d => !d.resolved);
  const hasAttention = !!(decisions.length || ownership.length || verification.length || unresolvedDecisions.length);
  const failed = task.status === 'failed' || behaviors.some(behavior => behavior.verification === 'failed');
  const allVerified = !verification.length && behaviors.every(b => b.summaryState === 'verified');
  const needsReview = hasAttention || task.status === 'blocked' || task.status === 'interrupted' || task.status === 'cancelled';
  const tone = failed ? 'danger' : needsReview ? 'warning' : phase === 'acceptance' && allVerified ? 'success' : 'neutral';

  const progress =
    phase === 'plan'
      ? task.workflow === 'ready'
        ? unresolvedDecisions.length
          ? `方案已生成，有 ${unresolvedDecisions.length} 项关键规则待确认。`
          : '已保存改前方案，等待确认。'
        : task.status === 'running'
          ? '正在只读分析，已保存的目标可查看。'
          : task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted'
            ? '改前分析未完成，请查看待处理事项与执行记录。'
            : '已保存任务目标，等待改前分析。'
      : phase === 'developing'
        ? task.status === 'pending'
          ? '开发已排队，等待执行。'
          : '任务正在执行，验证状态随证据记录更新。'
        : task.rolled_back_at
          ? '本次改动已撤销，原有验证记录可查阅。'
          : failed
            ? task.status === 'failed'
              ? '任务执行失败，请查看执行与验证记录。'
              : '存在验证失败项，请查看关联记录。'
            : task.status === 'blocked'
              ? '任务受阻，请查看待处理事项与执行记录。'
              : task.status === 'interrupted'
                ? '上次执行已中断。'
                : task.status === 'cancelled'
                  ? '任务已取消。'
                  : allVerified
                    ? '所有验收条件均有已观测的通过证据。'
                    : `还有 ${verification.length} 项需要核对验证证据。`;

  const verifiedBehaviorsCount = behaviors.filter(b => b.summaryState === 'verified').length;
  const failedBehavior = behaviors.find(b => b.summaryState === 'failed');
  const staleBehavior = behaviors.find(b => b.summaryState === 'stale');
  const unverifiedBehavior = behaviors.find(b => b.summaryState === 'unverified');
  const pendingHostChecks = engineeringChecks.filter(
    c => (c.kind === 'test' || c.kind === 'typecheck' || c.kind === 'build') && (c.status === 'not_run' || c.status === 'stale' || c.status === 'agent_claimed'),
  );
  const failedChecks = engineeringChecks.filter(c => c.status === 'failed');
  const passedChecks = engineeringChecks.filter(c => c.status === 'passed');
  const hasCodeChanges = !task.rolled_back_at && (task.changes.length > 0 || behaviors.some(b => b.implementation === 'implemented'));
  const scopeCount = (task.approval?.scope ?? task.proposed_scope ?? task.scope).length;

  let verdict: TaskVerdict;
  if (phase === 'developing' || (phase === 'plan' && task.status === 'running')) {
    verdict = {
      headline: phase === 'plan' ? '正在只读分析需求与影响范围。' : '正在按当前约定修改代码。',
      detail:
        task.active_behavior_focus
          ? `当前聚焦处理「${behaviors.find(b => b.id === task.active_behavior_focus?.behavior_id)?.shortTitle ?? task.active_behavior_focus.behavior_id}」，完成后结果将回到同一张场景表。`
          : '执行完成后将自动更新变更文件、工程检查与场景证据。',
      tone: 'neutral',
      primaryAction: { kind: 'cancel', label: '停止开发' },
    };
  } else if (unresolvedDecisions.length > 0) {
    const first = unresolvedDecisions[0];
    verdict = {
      headline: phase === 'plan' ? '方案有关键规则待你决定。' : '规则约定有待确认项，尚未执行修正。',
      detail: `${behaviors.length} 项业务变更中，有 ${unresolvedDecisions.length} 项关键规则需明确（如「${first.title}」）。`,
      tone: 'warning',
      primaryAction: { kind: 'confirm_rules', label: '确认待决定的规则', behaviorId: first.behavior_id ?? behaviors[0]?.id },
    };
  } else if (phase === 'plan' && task.workflow === 'ready') {
    verdict = {
      headline: '方案已就绪，确认后开始改码。',
      detail: `共 ${behaviors.length} 项业务变更，计划修改 ${scopeCount} 个文件${decisions.length ? `；另有 ${decisions.length} 项补充说明可核对` : ''}。`,
      tone: decisions.length ? 'warning' : 'neutral',
      primaryAction: { kind: 'approve_plan', label: '批准并开始开发' },
    };
  } else if (task.rolled_back_at) {
    verdict = {
      headline: '本次代码改动已撤销。',
      detail: '原有方案、规则约定与历史验证记录均保留，可调整要求后重新执行。',
      tone: 'neutral',
      primaryAction: { kind: 'continue', label: '重新发起或调整要求' },
    };
  } else if (
    task.status === 'blocked' ||
    task.status === 'failed' ||
    task.status === 'interrupted' ||
    task.diff_review?.verdict === 'needs_fix' ||
    ownership.length > 0
  ) {
    const blockerText =
      task.diff_review?.verdict === 'needs_fix'
        ? task.diff_review.summary
        : ownership[0] ?? task.unresolved[0] ?? '执行过程中出现阻塞或偏离，请核对下方原因后处理。';
    verdict = {
      headline: '执行发生阻塞或偏离，需要处理。',
      detail: blockerText,
      tone: 'danger',
      primaryAction: { kind: 'handle_blocker', label: '处理这次阻塞或偏离', behaviorId: failedBehavior?.id ?? behaviors[0]?.id },
    };
  } else if (failedBehavior) {
    verdict = {
      headline: `「${failedBehavior.shortTitle}」存在不符合约定的结果。`,
      detail: `${behaviors.length} 项业务变更中，${verifiedBehaviorsCount} 项有通过记录，当前项需修正实现或调整规则。`,
      tone: 'danger',
      primaryAction: { kind: 'fix_behavior', label: '修正这一项', behaviorId: failedBehavior.id },
    };
  } else if (failedChecks.length > 0) {
    verdict = {
      headline: '代码已修改，工程检查未通过。',
      detail: `${failedChecks.map(c => c.label).join('、')}执行失败；请先查看日志并修正问题。`,
      tone: 'danger',
      primaryAction: { kind: 'handle_blocker', label: '修正检查失败项', behaviorId: behaviors[0]?.id },
    };
  } else if (hasCodeChanges && staleBehavior) {
    verdict = {
      headline: '规则约定或代码已更新，需按新约定同步处理。',
      detail: `「${staleBehavior.shortTitle}」的约定或代码状态已变化，原有验证需重新确认。`,
      tone: 'warning',
      primaryAction: { kind: 'fix_behavior', label: '按新约定处理这一项', behaviorId: staleBehavior.id },
    };
  } else if (hasCodeChanges && pendingHostChecks.length > 0) {
    const pendingNames = pendingHostChecks.map(c => c.label).join('与');
    const checkKinds = pendingHostChecks
      .map(c => c.kind)
      .filter((k): k is 'typecheck' | 'test' | 'build' => k === 'typecheck' || k === 'test' || k === 'build');
    verdict = {
      headline: '代码已修改，验收未完成。',
      detail: `${behaviors.length} 项业务变更中，${verifiedBehaviorsCount} 项有验证记录；${pendingNames}待执行。`,
      tone: 'warning',
      primaryAction: { kind: 'run_checks', label: `运行${pendingNames}`, checkKinds },
    };
  } else if (hasCodeChanges && unverifiedBehavior) {
    verdict = {
      headline: passedChecks.length ? '工程检查已通过，业务场景待补齐验证。' : '代码已修改，业务验收尚未完成。',
      detail: `${behaviors.length} 项业务变更中，${verifiedBehaviorsCount} 项有验证记录；「${unverifiedBehavior.shortTitle}」还缺少场景验证证据。`,
      tone: 'warning',
      primaryAction: { kind: 'complete_verification', label: '补齐这项验证', behaviorId: unverifiedBehavior.id },
    };
  } else if (phase === 'acceptance' && allVerified) {
    verdict = {
      headline: '代码已修改，已记录的业务与工程检查均通过。',
      detail: `${behaviors.length} 项业务变更均有已观测验证记录${passedChecks.length ? `；${passedChecks.length} 项工程检查通过` : ''}。`,
      tone: 'success',
      primaryAction: { kind: 'continue', label: '继续完善或追加需求' },
    };
  } else {
    verdict = {
      headline: progress,
      detail: `${behaviors.length} 项业务变更，当前涉及 ${taskFiles.length} 个文件。`,
      tone,
      primaryAction: { kind: 'continue', label: '补充要求或继续' },
    };
  }

  const shortTitle = pkg?.short_title?.trim() || task.title?.trim() || shortLabel(task.goal, 26);

  return {
    phase,
    shortTitle,
    progress,
    tone,
    verdict,
    behaviors,
    ruleDecisions: allDecisions,
    engineeringChecks,
    evolutionSignal,
    taskFiles,
    hasAttention,
    attention: { decisions, ownership, verification },
    constraints: effectiveTaskBoundaries(task),
    decisions: task.decisions,
  };
}
