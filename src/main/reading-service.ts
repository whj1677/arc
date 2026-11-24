import path from 'node:path';
import { isExecutionMode, type ExecutionMode } from '../shared';
import type {
  Annotation,
  Explanation,
  Feature,
  Project,
  ReadingAsk,
  ReadingQuestion,
  Revision,
  Run,
  Scenario,
  Snapshot,
} from '../shared';
import { Store, id, now } from './store';
import { buildReadingContext, readingTarget } from './prompt-context';

export interface ReadingServiceHost {
  readonly store: Store;
  readonly directory: string;
  isClosing(): boolean;
  overview(projectId: string): Scenario;
  refresh(projectId: string): Promise<Snapshot>;
  event(runId: string, event: any, eventId?: string, sequence?: number): void;
  changed(): void;
  getDispatchRun(): ((run: Run) => void) | undefined;
  launchRun(run: Run): void;
}

const requireText = (value: unknown, max = 20000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`请输入 1–${max} 个字符`);
  }
  return value.trim();
};

export class ReadingService {
  private readonly asking = new Map<string, Promise<ReadingQuestion>>();

  constructor(private readonly host: ReadingServiceHost) {}

  async ask(input: ReadingAsk): Promise<ReadingQuestion> {
    if (!input || !/^[\w-]{8,100}$/.test(input.submission_key)) {
      throw Error('提交幂等键无效');
    }
    const args = structuredClone(input);
    const pending = this.asking.get(args.submission_key);
    if (pending) {
      await pending;
      return this.ask(args);
    }
    const task = this.createQuestion(args);
    this.asking.set(args.submission_key, task);
    try {
      return await task;
    } finally {
      this.asking.delete(args.submission_key);
    }
  }

  private async createQuestion(args: ReadingAsk): Promise<ReadingQuestion> {
    const { store } = this.host;
    if (this.host.isClosing()) throw Error('Arc 正在退出，未派发新任务');
    const question = requireText(args.question, 4000);
    const mode = args.mode ?? 'codex';
    if (!isExecutionMode(mode) || !['bound', 'latest'].includes(args.source_mode ?? 'bound')) {
      throw Error('追问通道或来源模式无效');
    }
    if (mode === 'codex_desktop' && !this.host.getDispatchRun()) throw Error('Codex 桌面会话派发通道不可用');
    const existing = store.all<ReadingQuestion>('reading_question').find(q => q.submission_key === args.submission_key);
    if (existing) {
      if (
        existing.project_id !== args.project_id ||
        existing.question !== question ||
        existing.target.kind !== args.target?.kind ||
        existing.target.id !== args.target?.id ||
        existing.result_id !== (args.result_id || null)
      ) {
        throw Error('幂等键归属冲突');
      }
      return existing;
    }

    const project = store.get<Project>('project', args.project_id);
    if (project.fictional) throw Error('演示工程不调用真实 Agent；请打开实际工程');

    const previous = args.previous_question_id
      ? store.get<ReadingQuestion>('reading_question', args.previous_question_id)
      : undefined;
    const resultId = args.result_id || null;
    const explanation = resultId ? store.get<Explanation>('explanation', resultId) : undefined;
    if (explanation && explanation.result.binding.project_id !== project.project_id) {
      throw Error('原说明不属于此工程');
    }

    const scenarioId = args.scenario_id || explanation?.scenario_id || previous?.scenario_id;
    let scenario = scenarioId ? store.get<Scenario>('scenario', scenarioId) : this.host.overview(project.project_id);
    if (scenario.project_id !== project.project_id || (explanation && explanation.scenario_id !== scenario.scenario_id)) {
      throw Error('阅读场景归属不一致');
    }

    const feature = store.get<Feature>('feature', scenario.feature_id);
    if (feature.archived || scenario.archived) throw Error('请先恢复已归档的阅读功能');
    if (
      previous &&
      (previous.project_id !== project.project_id ||
        previous.scenario_id !== scenario.scenario_id ||
        previous.result_id !== resultId ||
        previous.target.kind !== args.target.kind ||
        previous.target.id !== args.target.id)
    ) {
      throw Error('前次追问不属于此阅读位置');
    }

    const revisionId = previous?.question_revision_id || explanation?.result.binding.question_revision_id || scenario.question_revision_id;
    const revision = store.get<Revision>('revision', revisionId);
    scenario = { ...scenario, question_revision_id: revisionId, question: revision.question };

    const oldSource = previous?.source_snapshot_id || explanation?.result.binding.source_snapshot_id || project.snapshot_id;
    let snapshot = store.get<Snapshot>('snapshot', oldSource);
    if (snapshot.project_id !== project.project_id) throw Error('快照归属不一致');
    readingTarget(explanation?.result, args.target, snapshot, feature);

    // Capture related reading material before refresh/launch yields to the UI.
    const annotations = store.all<Annotation>('annotation');
    const questions = store.all<ReadingQuestion>('reading_question');
    if (args.source_mode === 'latest') snapshot = await this.host.refresh(project.project_id);

    const sourceMode = args.source_mode === 'latest' ? 'latest' : previous?.source_mode ?? 'bound';
    const context = buildReadingContext({
      project,
      feature,
      scenario,
      result: explanation?.result,
      architecture: store.findArchitectureDocForSnapshot(project.project_id, snapshot.source_snapshot_id,
        previous?.context.architecture_document?.branch_key ?? explanation?.branch_key ?? explanation?.architecture_branch),
      target: args.target,
      snapshot,
      annotations,
      questions,
      sourceMode,
      previousSnapshotId: oldSource !== snapshot.source_snapshot_id ? oldSource : previous?.context.source.previous_snapshot_id ?? null,
      replyTo: previous,
    });

    const item: ReadingQuestion = {
      question_id: id('reading-question'),
      project_id: project.project_id,
      feature_id: feature.feature_id,
      scenario_id: scenario.scenario_id,
      question_revision_id: revisionId,
      result_id: resultId,
      target: args.target,
      source_snapshot_id: snapshot.source_snapshot_id,
      source_mode: sourceMode,
      question,
      created_at: now(),
      run_id: '',
      run_ids: [],
      context,
      submission_key: args.submission_key,
      previous_question_id: previous?.question_id,
    };

    let annotation: Annotation | undefined;
    if (args.correction) {
      annotation = {
        annotation_id: id('clue'),
        project_id: item.project_id,
        scenario_id: item.scenario_id,
        result_id: item.result_id,
        object_id: ['node', 'edge'].includes(item.target.kind) ? item.target.id : null,
        target: item.target,
        source_snapshot_id: item.source_snapshot_id,
        text: question,
        created_at: now(),
      };
      context.annotations.push(annotation);
    }

    store.transaction(() => {
      if (annotation) store.put('annotation', annotation.annotation_id, annotation);
      store.put('reading_question', item.question_id, item);
    });
    return this.startRun(item, mode, args.submission_key);
  }

  retry(questionId: string, mode: ExecutionMode = 'codex', submissionKey: string): ReadingQuestion {
    const { store } = this.host;
    if (!/^[\w-]{8,100}$/.test(submissionKey) || !isExecutionMode(mode)) {
      throw Error('重试参数无效');
    }
    const item = store.get<ReadingQuestion>('reading_question', questionId);
    const existing = store.all<Run>('run').find(r => r.submission_key === submissionKey);
    if (existing) {
      if (existing.reading_question_id !== questionId) throw Error('幂等键归属冲突');
      return item;
    }
    const previous = store.get<Run>('run', item.run_id);
    if (!['failed', 'cancelled', 'blocked_external', 'unknown'].includes(previous.status)) {
      throw Error('只可重试已失败、已取消或状态未知的问题');
    }
    return this.startRun(item, mode, submissionKey);
  }

  private startRun(item: ReadingQuestion, mode: ExecutionMode, submissionKey: string): ReadingQuestion {
    if (this.host.isClosing()) throw Error('Arc 正在退出，未派发新任务');
    const dispatch=mode==='codex_desktop'?this.host.getDispatchRun():undefined;
    if(mode==='codex_desktop'&&!dispatch)throw Error('Codex 桌面会话派发通道不可用');
    const runId = id('run');
    const run: Run = {
      binding: {
        project_id: item.project_id,
        feature_id: item.feature_id,
        scenario_id: item.scenario_id,
        question_revision_id: item.question_revision_id,
        source_snapshot_id: item.source_snapshot_id,
        run_id: runId,
      },
      provider_id: mode === 'dsh' ? 'dsh' : 'codex',
      execution_mode: mode,
      status: mode === 'mcp' ? 'waiting_agent' : 'queued',
      origin: mode === 'mcp' ? 'mcp' : undefined,
      question: item.question,
      title: `阅读追问 · ${item.target.id}`,
      created_at: now(),
      submission_key: submissionKey,
      previous_run_id: item.run_id || undefined,
      output_path: path.join(this.host.directory, 'runs', runId, 'result.json'),
      reading_question_id: item.question_id,
      reading_context: item.context,
    };
    item.run_id = runId;
    item.run_ids.push(runId);

    this.host.store.transaction(() => {
      this.host.store.put('run', runId, run);
      this.host.store.put('reading_question', item.question_id, item);
    });
    this.host.event(runId, {
      type: 'local.stage',
      stage: mode === 'mcp' ? 'waiting_agent' : 'queued',
      message: mode === 'mcp'
        ? '问题和源码已固定，等待外部 Agent 通过 MCP 领取；尚未执行分析'
        : '问题和源码已固定，正在准备只读分析',
    });
    this.host.changed();

    if (dispatch) {
      dispatch(run);
    } else if (mode !== 'mcp') {
      this.host.launchRun(run);
    }
    return item;
  }
}
