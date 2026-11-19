import type { ExecutionMode, Explanation, Run, Snapshot } from '../shared';
import type { EngineeringService } from './engineering-service';
import { Store, id, now } from './store';
import { redact } from './providers';

export interface WalkthroughRefreshHost {
  readonly store: Store;
  readonly engineering: EngineeringService;
  readonly executing: Map<string, Promise<void>>;
  isClosing(): boolean;
  refresh(projectId: string): Promise<Snapshot>;
  startRun(
    scenarioId: string,
    mode: Exclude<ExecutionMode, 'mcp'>,
    submissionKey: string,
    previousRunId?: string,
    options?: { sourceSnapshotId?: string; developmentTaskId?: string; refreshFromResultId?: string; projectAnalysis?: boolean },
  ): Promise<Run>;
  cancel(runId: string): Promise<Run>;
  prepareManual(scenarioId: string, taskId: string): unknown;
}

export class WalkthroughRefreshCoordinator {
  private readonly refreshingTasks = new Map<string, Promise<void>>();
  private readonly refreshGenerations = new Map<string, string>();
  private readonly externalWalkthroughs = new Map<string, { taskId: string; resolve: () => void }>();
  private readonly queuedWalkthroughs = new Map<string, { submissionKey?: string; promise: Promise<void>; resolve: () => void }>();

  constructor(private readonly host: WalkthroughRefreshHost) {}

  refreshTask(taskId: string, submissionKey?: string): Promise<void> {
    const active = this.refreshingTasks.get(taskId);
    if (active) {
      if (this.host.engineering.task(taskId).walkthrough?.update_id === this.refreshGenerations.get(taskId)) {
        return active;
      }
      let queued = this.queuedWalkthroughs.get(taskId);
      if (!queued) {
        let resolve!: () => void;
        queued = { submissionKey, promise: new Promise<void>(done => { resolve = done; }), resolve };
        this.queuedWalkthroughs.set(taskId, queued);
      } else if (submissionKey) {
        queued.submissionKey = submissionKey;
      }
      return queued.promise;
    }

    const task = this.host.engineering.task(taskId);
    if (!task.reading || !task.end_state || !['completed', 'failed', 'blocked', 'cancelled'].includes(task.status)) {
      return Promise.resolve();
    }
    const updateId = id('walkthrough');
    const previous = task.walkthrough ?? { status: 'pending' as const, previous_result_id: task.reading.result_id, updated_at: now() };
    this.host.engineering.saveWalkthrough(taskId, {
      ...previous,
      status: 'pending',
      update_id: updateId,
      error: undefined,
      updated_at: now(),
    });
    return this.watch(taskId, updateId, this.update(taskId, updateId, submissionKey ?? `walkthrough-${updateId}`));
  }

  trackExternal(runId: string): void {
    if (this.externalWalkthroughs.has(runId)) return;
    const run = this.host.store.get<Run>('run', runId);
    if (!run.development_task_id) return;
    const task = this.host.engineering.task(run.development_task_id);
    if (!task.walkthrough || task.walkthrough.run_id !== runId) return;
    const updateId = task.walkthrough.update_id ?? id('walkthrough');
    if (!task.walkthrough.update_id) {
      this.host.engineering.saveWalkthrough(task.task_id, { ...task.walkthrough, update_id: updateId, updated_at: now() });
    }
    let resolve!: () => void;
    const work = new Promise<void>(done => { resolve = done; });
    this.externalWalkthroughs.set(runId, { taskId: task.task_id, resolve });
    this.watch(task.task_id, updateId, work);
  }

  finishExternal(runId: string): void {
    const active = this.externalWalkthroughs.get(runId);
    if (active) {
      this.externalWalkthroughs.delete(runId);
      active.resolve();
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.externalWalkthroughs.keys()].map(runId => this.host.cancel(runId)));
    await Promise.allSettled([...this.refreshingTasks.values()]);
  }

  private watch(taskId: string, updateId: string, work: Promise<void>): Promise<void> {
    this.refreshGenerations.set(taskId, updateId);
    const pending = work.finally(() => {
      if (this.refreshingTasks.get(taskId) === pending) {
        this.refreshingTasks.delete(taskId);
        this.refreshGenerations.delete(taskId);
      }
      const queued = this.queuedWalkthroughs.get(taskId);
      if (queued) {
        this.queuedWalkthroughs.delete(taskId);
        if (this.host.isClosing()) queued.resolve();
        else void this.refreshTask(taskId, queued.submissionKey).then(queued.resolve, queued.resolve);
      }
    });
    this.refreshingTasks.set(taskId, pending);
    return pending;
  }

  private async update(taskId: string, updateId: string, submissionKey: string): Promise<void> {
    let runId: string | undefined;
    try {
      const initial = this.host.engineering.task(taskId);
      const reading = initial.reading!;
      const snapshot = await this.host.refresh(initial.project_id);
      const current = this.host.engineering.task(taskId);
      if (current.walkthrough?.update_id !== updateId || !['completed', 'failed', 'blocked', 'cancelled'].includes(current.status)) {
        return;
      }
      const mode = current.execution_mode ?? (current.analysis_channel === 'dsh' ? 'dsh' : 'codex');
      if (mode === 'mcp') {
        this.host.prepareManual(reading.scenario_id, taskId);
        return;
      }
      const run = await this.host.startRun(reading.scenario_id, mode, submissionKey, undefined, {
        sourceSnapshotId: snapshot.source_snapshot_id,
        developmentTaskId: taskId,
        refreshFromResultId: current.walkthrough!.previous_result_id,
      });
      runId = run.binding.run_id;
      const dispatched = mode === 'codex_desktop';
      this.host.engineering.saveWalkthrough(
        taskId,
        {
          ...current.walkthrough!,
          status: dispatched ? 'pending' : 'running',
          run_id: runId,
          source_snapshot_id: snapshot.source_snapshot_id,
          updated_at: now(),
        },
        updateId,
      );
      if (dispatched) return;
      const executing = this.host.executing.get(runId);
      if (executing) await executing;

      const finalRun = this.host.store.get<Run>('run', runId);
      const explanation = this.host.store.all<Explanation>('explanation').find(e => e.result.binding.run_id === runId);
      const latest = this.host.engineering.task(taskId);
      if (finalRun.status === 'completed' && explanation) {
        this.host.engineering.saveWalkthrough(
          taskId,
          {
            ...latest.walkthrough!,
            status: 'completed',
            result_id: explanation.result_id,
            source_snapshot_id: explanation.result.binding.source_snapshot_id,
            error: undefined,
            updated_at: now(),
          },
          updateId,
        );
      } else {
        this.host.engineering.saveWalkthrough(
          taskId,
          {
            ...latest.walkthrough!,
            status: 'failed',
            error: finalRun.error || `走读更新未完成（${finalRun.status}）；旧说明和开发成果保留。`,
            updated_at: now(),
          },
          updateId,
        );
      }
    } catch (error) {
      const latest = this.host.engineering.task(taskId);
      if (latest.walkthrough?.update_id === updateId) {
        this.host.engineering.saveWalkthrough(
          taskId,
          {
            ...latest.walkthrough,
            status: 'failed',
            ...(runId ? { run_id: runId } : {}),
            error: redact((error as Error).message || String(error)),
            updated_at: now(),
          },
          updateId,
        );
      }
    }
  }
}
