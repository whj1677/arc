import { commandBody, evidenceFailed, evidenceSupportsPass, sameVerificationState } from '../delivery-audit';
import type { DevelopmentCriterion, DevelopmentStep, EngineeringTask, FileChange, VerificationEvidence } from '../engineering';
import { effectiveTaskBoundaries } from '../task-boundaries';

export type BehaviorPhase = 'plan' | 'developing' | 'acceptance';
export type ImplementationState = 'not_started' | 'planned' | 'in_progress' | 'implemented' | 'blocked';
export type BehaviorVerification = 'verified' | 'failed' | 'partial' | 'stale' | 'agent_claimed' | 'unverified';

export interface BehaviorAcceptance {
  id: string;
  criterionId?: string;
  text: string;
  implementation: ImplementationState;
  verification: BehaviorVerification;
  evidence: VerificationEvidence[];
}

export interface TaskBehavior {
  id: string;
  title: string;
  design?: string;
  progress: string[];
  files: string[];
  changes: FileChange[];
  before?: NonNullable<EngineeringTask['reading']>['evidence'];
  implementation: ImplementationState;
  verification: BehaviorVerification;
  acceptance: BehaviorAcceptance[];
}

function phaseOf(task: EngineeringTask): BehaviorPhase {
  if (task.workflow === 'analysis' || task.workflow === 'ready') return 'plan';
  if (task.status === 'running' || task.status === 'pending' && task.workflow === 'execution') return 'developing';
  return task.status === 'pending' ? 'plan' : 'acceptance';
}

function implementationOf(task: EngineeringTask, steps: DevelopmentStep[], planned: boolean, captured: boolean): ImplementationState {
  if (task.rolled_back_at) return 'not_started';
  if (steps.some(step => step.status === 'failed' || step.status === 'blocked')) return 'blocked';
  if (steps.length && steps.every(step => step.status === 'completed')) return 'implemented';
  if (steps.some(step => step.status === 'in_progress') ||
      steps.some(step => step.status === 'completed') && phaseOf(task) === 'developing') return 'in_progress';
  if (task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted') return 'blocked';
  if (captured && !steps.length) return 'implemented';
  return planned ? 'planned' : 'not_started';
}

// These commands can be attached to criteria by the host's generic delivery checks.
const structuralCheck = /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:(?:run|run-script)\s+)?(?:build|typecheck|lint)\b|(?:npx\s+)?tsc\b|git\s+diff\s+--check\b|cmake\s+(?:--build|-S\s)|(?:\.\x2f|\.\\)?(?:go|cargo|gradle|gradlew|dotnet)(?:\.cmd|\.bat)?\s+(?:build|check|assemble)\b|(?:\.\x2f|\.\\)?mvnw?(?:\.cmd)?\s+(?:compile|package)\b|make(?:\s+(?:build|all))?\s*$)/i;

function evidenceFor(task: EngineeringTask, step: DevelopmentStep, criterion?: DevelopmentCriterion) {
  return task.verification.filter(item => {
    if (item.step_id && item.step_id !== step.step_id) return false;
    if (!criterion) return item.step_id === step.step_id || step.evidence_ids.includes(item.evidence_id);
    if (item.criterion_id && item.criterion_id !== criterion.criterion_id) return false;
    return criterion.evidence_ids.includes(item.evidence_id) ||
      item.step_id === step.step_id && item.criterion_id === criterion.criterion_id;
  });
}

function verificationOf(task: EngineeringTask, evidence: VerificationEvidence[], criterion: boolean, step?: DevelopmentStep): BehaviorVerification {
  const reported = evidence.some(item => item.origin === 'self_reported' && item.outcome !== 'not_run');
  const observed = evidence.filter(item => item.origin === 'observed' && item.outcome !== 'not_run');
  if (!observed.length) return reported ? 'agent_claimed' : 'unverified';
  if (task.rolled_back_at || step?.verification_status === 'stale' ||
    task.verification_status === 'stale' && !step?.verification_status) return 'stale';

  if (!task.end_state && phaseOf(task) === 'developing') return observed.some(evidenceFailed) ? 'failed' : 'partial';
  const comparable = observed.filter(item => !!item.code_state.workspace_fingerprint);
  const current = observed.filter(item => sameVerificationState(item.code_state, task.end_state ?? task.baseline));
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
  if (criterion && behaviorChecks.length &&
    behaviorChecks.every(item => evidenceSupportsPass(item) && !item.metrics?.skipped)) return 'verified';
  return 'partial';
}

function aggregateVerification(rows: BehaviorAcceptance[]): BehaviorVerification {
  if (rows.some(row => row.verification === 'failed')) return 'failed';
  if (rows.every(row => row.verification === 'verified')) return 'verified';
  if (rows.some(row => row.verification === 'stale')) return 'stale';
  if (rows.some(row => row.verification === 'partial' || row.verification === 'verified')) return 'partial';
  return rows.some(row => row.verification === 'agent_claimed') ? 'agent_claimed' : 'unverified';
}

export function projectTaskBehavior(task: EngineeringTask) {
  const phase = phaseOf(task);
  const pkg = task.requirement_package;
  const steps = (task.steps ?? []).filter(step => step.status !== 'superseded');
  const taskFiles = [...new Set([
    ...(task.approval?.scope ?? task.proposed_scope ?? task.scope),
    ...task.changes.map(change => change.path),
    ...(task.reading?.evidence ? [task.reading.evidence.path] : []),
  ])];
  const inputs = pkg?.behaviors.length
    ? pkg.behaviors.map(behavior => ({
        id: behavior.id, title: behavior.behavior, design: behavior.design, files: behavior.files,
        steps: behavior.step_ids.flatMap(id => steps.filter(step => step.step_id === id)),
        verificationPlan: behavior.verification, taskWide: false,
      }))
    : steps.length
      ? steps.map(step => ({
          id: step.step_id, title: step.title, design: step.change, files: [] as string[],
          steps: [step], verificationPlan: '', taskWide: steps.length === 1,
        }))
      : [{ id: task.task_id, title: task.goal, design: '', files: [], steps: [], verificationPlan: '', taskWide: true }];

  const behaviors = inputs.map<TaskBehavior>(input => {
    const relatedChanges = task.changes.filter(change => input.taskWide || input.files.includes(change.path));
    const captured = task.changes_status !== 'needs_review' && relatedChanges.some(change => change.ownership === 'task_change');
    const implementation = implementationOf(task, input.steps, !!input.design || input.steps.length > 0, captured);
    const acceptance = input.steps.flatMap(step => step.criteria.map<BehaviorAcceptance>(criterion => {
      const evidence = evidenceFor(task, step, criterion);
      return {
        id: JSON.stringify([step.step_id, criterion.criterion_id]), criterionId: criterion.criterion_id,
        text: criterion.text, implementation: implementationOf(task, [step], true, false), evidence,
        verification: verificationOf(task, evidence, true, step),
      };
    }));
    if (!acceptance.length) {
      const evidence = [...new Set(input.taskWide ? task.verification : input.steps.flatMap(step => evidenceFor(task, step)))];
      acceptance.push({
        id: input.id, text: input.verificationPlan || input.title,
        implementation, evidence, verification: verificationOf(task, evidence, false, input.steps.length === 1 ? input.steps[0] : undefined),
      });
    }
    const anchor = task.reading?.evidence;
    return {
      id: input.id, title: input.title, design: input.design, progress: input.steps.map(step => step.progress).filter(Boolean),
      files: input.taskWide ? taskFiles : input.files, changes: relatedChanges, implementation,
      before: anchor && (input.taskWide || input.files.includes(anchor.path)) ? anchor : undefined,
      acceptance, verification: aggregateVerification(acceptance),
    };
  });

  const decisions = [...new Set([
    ...(pkg?.open_questions ?? []), ...(pkg?.risks ?? []), ...task.unresolved,
    ...steps.flatMap(step => step.unresolved),
  ])];
  const ownership = [
    ...(task.changes_status === 'needs_review' ? ['差异归属待核查'] : []),
    ...task.changes.filter(change => change.ownership === 'preexisting_overlap').map(change => `${change.path} · 含开始前已有改动`),
  ];
  const verification = behaviors.flatMap(behavior => behavior.acceptance
    .filter(row => row.verification !== 'verified').map(row => ({...row, behaviorId: behavior.id})));
  const hasAttention = !!(decisions.length || ownership.length || verification.length);
  const failed = task.status === 'failed' || behaviors.some(behavior => behavior.verification === 'failed');
  const allVerified = !verification.length;
  const needsReview = hasAttention || task.status === 'blocked' || task.status === 'interrupted' || task.status === 'cancelled';
  const tone = failed ? 'danger' : needsReview ? 'warning' : phase === 'acceptance' && allVerified ? 'success' : 'neutral';
  const progress = phase === 'plan'
    ? task.workflow === 'ready' ? '已保存改前方案，等待确认。'
      : task.status === 'running' ? '正在只读分析，已保存的目标可查看。'
      : task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted'
        ? '改前分析未完成，请查看待处理事项与执行记录。' : '已保存任务目标，等待改前分析。'
    : phase === 'developing'
      ? task.status === 'pending' ? '开发已排队，等待执行。' : '任务正在执行，验证状态随证据记录更新。'
      : task.rolled_back_at ? '本次改动已撤销，原有验证记录可查阅。'
      : failed ? task.status === 'failed' ? '任务执行失败，请查看执行与验证记录。' : '存在验证失败项，请查看关联记录。'
      : task.status === 'blocked' ? '任务受阻，请查看待处理事项与执行记录。'
      : task.status === 'interrupted' ? '上次执行已中断。' : task.status === 'cancelled' ? '任务已取消。'
      : allVerified ? '所有验收条件均有已观测的通过证据。'
      : `还有 ${verification.length} 项需要核对验证证据。`;
  return {
    phase, progress, tone, behaviors, taskFiles, hasAttention, attention: { decisions, ownership, verification },
    constraints: effectiveTaskBoundaries(task), decisions: task.decisions,
  };
}
