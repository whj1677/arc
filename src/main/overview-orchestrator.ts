import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { AnalysisResult, Explanation, Feature, Project, ProviderProfile, Run, Scenario, Snapshot } from '../shared';
import { hasFunctionGraphs } from '../shared';
import { Store, id, now } from './store';
import { linesOf, readSource, sha } from './snapshot';
import { overviewPhaseDirectory, redact, type ActiveProcess, type OverviewPhase, type runCodex } from './providers';
import { validateResult } from './validation';
import { deferredCatalogDeclarationBoundary, deferredCatalogReadingBoundary, prepareOverview } from './overview-result';
import { applyOverviewReview, makeOverviewReviewInput, makeOverviewReviewPrompt, overviewReviewSchema, parseOverviewReview, type OverviewReview } from './overview-review';
import { applyOverviewResearch, makeOverviewResearchPrompt, overviewResearchSchema } from './overview-research';
import { parseDshReply } from './dsh';
import type { runDshWeb } from './dsh-web';

const terminal = new Set(['completed', 'failed', 'cancelled', 'blocked_external']);
const parseJsonReply = (raw: string) => JSON.parse(raw.trim());

const summaryRepairSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary_text', 'claims'],
  properties: {
    summary_text: { type: 'string', minLength: 1, maxLength: 2000 },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim_id', 'statement'],
        properties: {
          claim_id: { type: 'string', minLength: 1 },
          statement: { type: 'string', minLength: 1, maxLength: 1500 },
        },
      },
    },
  },
};
const validateSummaryRepair = new Ajv2020().compile<{ summary_text: string; claims: { claim_id: string; statement: string }[] }>(summaryRepairSchema);

export interface OverviewOrchestratorHost {
  readonly store: Store;
  readonly directory: string;
  readonly resources: string;
  readonly active: Map<string, ActiveProcess>;
  readonly codexRunner: typeof runCodex;
  readonly dshRunner: typeof runDshWeb;
  isClosing(): boolean;
  changed(): void;
  event(runId: string, event: any, eventId?: string, sequence?: number): void;
  fail(runId: string, error: unknown): void;
  getDispatchRun(): ((run: Run) => void) | undefined;
  launchRun(run: Run): Promise<void>;
  discoveredTarget(
    project: Project,
    result: AnalysisResult,
    node: AnalysisResult['nodes'][number],
    features?: Feature[],
    explanations?: Explanation[],
    scenes?: Scenario[],
  ): { feature: Feature; scenario: Scenario } | undefined;
}

export class OverviewOrchestrator {
  private overviewQueue: Promise<void> = Promise.resolve();

  constructor(private readonly host: OverviewOrchestratorHost) {}

  async waitQueue(): Promise<void> {
    await this.overviewQueue;
  }

  retrySource(run: Run): Run | undefined {
    const history = this.host.store.all<Run>('run').filter(candidate =>
      candidate.binding.run_id !== run.binding.run_id && candidate.overview_format && !candidate.overview_from_result_id && !candidate.origin &&
      (candidate.execution_mode ?? candidate.provider_id) === 'codex' &&
      candidate.binding.scenario_id === run.binding.scenario_id &&
      candidate.binding.source_snapshot_id === run.binding.source_snapshot_id &&
      candidate.binding.question_revision_id === run.binding.question_revision_id
    );
    let parentId = run.previous_run_id ?? history.at(-1)?.binding.run_id;
    for (const previous of history.reverse()) {
      if (previous.binding.run_id !== parentId) continue;
      if (previous.status !== 'failed') break;
      if (previous.overview_candidate_ready || this.host.store.overviewReadLocations(previous.binding.run_id).length) return previous;
      parentId = previous.previous_run_id;
    }
  }

  async readExcerpts(runId: string, snapshot: Snapshot) {
    const excerpts = [];
    for (const location of this.host.store.overviewReadLocations(runId)) {
      const file = await readSource(this.host.directory, snapshot, location.path);
      const start = location.start - 1;
      const lines = linesOf(file.text).slice(start, start + Math.min(location.count, 24));
      if (lines.length) excerpts.push({ path: file.path, start: location.start, lines: lines.map(line => line.slice(0, 200)).join('\n').slice(0, 1600) });
    }
    return excerpts;
  }

  async researchOverview(resultId: string, submissionKey: string): Promise<Run> {
    const { store } = this.host;
    if (this.host.isClosing()) throw Error('Arc 正在退出，未派发补查');
    if (!/^[\w-]{8,100}$/.test(submissionKey)) throw Error('提交幂等键无效');
    const existing = store.all<Run>('run').find(run => run.submission_key === submissionKey);
    if (existing) {
      if (existing.overview_from_result_id !== resultId) throw Error('幂等键归属冲突');
      return existing;
    }

    const explanation = store.get<Explanation>('explanation', resultId);
    const previous = store.get<Run>('run', explanation.result.binding.run_id);
    if (
      (previous.provider_id !== 'codex' && previous.provider_id !== 'dsh') ||
      !previous.overview_format ||
      previous.status !== 'completed' ||
      explanation.result.fictional ||
      !explanation.result.gaps.some(g => g.gap_id.startsWith('overview-review-'))
    ) {
      throw Error('这份说明没有可自动补查的首轮关系');
    }
    if (
      store
        .all<Run>('run')
        .some(r => r.binding.scenario_id === previous.binding.scenario_id && !r.reading_question_id && !terminal.has(r.status) && r.status !== 'unknown')
    ) {
      throw Error('该场景已有进行中的分析，请等待或停止后补查');
    }

    const runId = id('run');
    const run: Run = {
      binding: { ...previous.binding, run_id: runId },
      provider_id: previous.provider_id,
      execution_mode: previous.provider_id,
      status: 'queued',
      question: previous.question,
      title: '自动补查工程关系',
      created_at: now(),
      submission_key: submissionKey,
      previous_run_id: previous.binding.run_id,
      output_path: path.join(this.host.directory, 'runs', runId, 'result.json'),
      overview_format: 'overview-1',
      overview_from_result_id: resultId,
    };
    store.put('run', runId, run);
    this.host.event(runId, {
      type: 'local.stage',
      stage: 'overview_resume',
      message: '沿用这份说明的冻结源码与候选关系，自动补查缺口；完成后保存新版本，原说明保留。',
    });
    this.host.changed();

    void this.host.launchRun(run);
    return run;
  }

  prepareChildren(parent: Run, explanation: Explanation, project: Project): Run[] {
    const { store } = this.host;
    const mode = parent.overview_followup_mode;
    const result = explanation.result;
    if (
      !mode ||
      this.host.isClosing() ||
      project.fictional ||
      result.fictional ||
      parent.origin === 'manual_import' ||
      parent.development_task_id ||
      parent.overview_from_result_id ||
      parent.overview_parent_run_id ||
      !result.feature_catalog ||
      project.snapshot_id !== parent.binding.source_snapshot_id ||
      explanation.source_status !== 'current' ||
      project.overview_scenario_id !== parent.binding.scenario_id
    ) {
      return [];
    }

    const scene = store.get<Scenario>('scenario', parent.binding.scenario_id);
    if (
      scene.archived ||
      scene.question_revision_id !== parent.binding.question_revision_id ||
      store.get<Feature>('feature', scene.feature_id).archived
    ) {
      return [];
    }

    const features = store.all<Feature>('feature');
    const scenes = store.all<Scenario>('scenario');
    const explanations = store.all<Explanation>('explanation');
    const runs = store.all<Run>('run');
    const children: Run[] = [];
    const ids = new Set(result.feature_catalog.groups.flatMap(group => group.node_ids));
    const deferred = new Set(result.feature_catalog.readings?.filter(reading =>
      !reading.steps.length && (reading.boundary === deferredCatalogReadingBoundary || reading.boundary === deferredCatalogDeclarationBoundary)
    ).map(reading => reading.node_id));

    for (const node of result.nodes) {
      if (!ids.has(node.node_id) || deferred.has(node.node_id) || !node.label.trim()) continue;
      const target = this.host.discoveredTarget(project, result, node, features, explanations, scenes);
      if (!target) continue;
      const { feature, scenario } = target;
      const sameBinding = (binding: Run['binding']) =>
        binding.project_id === project.project_id &&
        binding.feature_id === feature.feature_id &&
        binding.scenario_id === scenario.scenario_id &&
        binding.question_revision_id === scenario.question_revision_id &&
        binding.source_snapshot_id === project.snapshot_id;

      if (explanations.some(item => item.source_status === 'current' && !item.result.fictional && sameBinding(item.result.binding) && hasFunctionGraphs(item.result))) {
        continue;
      }
      if (runs.some(run => !run.reading_question_id && sameBinding(run.binding) && !terminal.has(run.status) && run.status !== 'unknown')) {
        continue;
      }

      const runId = id('run');
      const child: Run = {
        binding: {
          ...parent.binding,
          feature_id: feature.feature_id,
          scenario_id: scenario.scenario_id,
          question_revision_id: scenario.question_revision_id,
          run_id: runId,
        },
        provider_id: parent.provider_id,
        execution_mode: parent.execution_mode,
        overview_parent_run_id: parent.binding.run_id,
        status: mode === 'manual' ? 'waiting_agent' : 'queued',
        question: scenario.question,
        title: scenario.title,
        created_at: now(),
        submission_key: 'overview-child-' + sha([parent.binding.run_id, scenario.scenario_id, scenario.question_revision_id].join('/')).slice(0, 40),
        output_path: path.join(this.host.directory, 'runs', runId, 'result.json'),
        ...(mode === 'manual' ? { origin: 'mcp' as const, mcp_connection_id: parent.mcp_connection_id } : {}),
      };
      store.put('run', runId, child);
      children.push(child);
    }
    return children;
  }

  cancelUnstartedChild(run: Run): boolean {
    const { store } = this.host;
    if (
      run.status !== 'queued' ||
      !run.overview_parent_run_id ||
      store.maybe<Run>('run', run.overview_parent_run_id)?.overview_followup_mode !== 'direct'
    ) {
      return false;
    }
    if (store.events(run.binding.run_id).some(event => event.type === 'local.stage' && event.stage === 'launching')) {
      return false;
    }
    run.status = 'cancelled';
    run.ended_at = now();
    run.error = 'ARC 已退出，此项走读尚未启动模型。重新分析工程可继续补齐。';
    store.put('run', run.binding.run_id, run);
    return true;
  }

  checkChild(run: Run): void {
    if (!run.overview_parent_run_id) return;
    const { store } = this.host;
    const project = store.get<Project>('project', run.binding.project_id);
    const scene = store.get<Scenario>('scenario', run.binding.scenario_id);
    const parent = store.get<Run>('run', run.overview_parent_run_id);
    const parentScene = store.get<Scenario>('scenario', parent.binding.scenario_id);
    if (
      project.fictional ||
      project.snapshot_id !== run.binding.source_snapshot_id ||
      parent.binding.project_id !== project.project_id ||
      parent.binding.source_snapshot_id !== run.binding.source_snapshot_id ||
      scene.project_id !== project.project_id ||
      scene.feature_id !== run.binding.feature_id ||
      parent.status !== 'completed' ||
      project.overview_scenario_id !== parent.binding.scenario_id ||
      parentScene.archived ||
      parentScene.question_revision_id !== parent.binding.question_revision_id ||
      store.get<Feature>('feature', parentScene.feature_id).archived ||
      scene.archived ||
      scene.question_revision_id !== run.binding.question_revision_id ||
      store.get<Feature>('feature', scene.feature_id).archived
    ) {
      throw Error('工程快照、问题版本或功能状态已变化，本次自动走读已停止。');
    }
  }

  launchChildren(parent: Run, children: Run[]): void {
    if (!children.length || parent.overview_followup_mode === 'manual') return;
    if (parent.overview_followup_mode === 'dispatch') {
      const dispatch = this.host.getDispatchRun();
      for (const child of children) {
        if (this.host.store.get<Run>('run', child.binding.run_id).status !== 'queued') continue;
        try {
          this.checkChild(child);
          if (!dispatch) throw Error('原外部派发通道不可用。');
          dispatch(child);
        } catch (error) {
          this.host.fail(child.binding.run_id, error);
        }
      }
      return;
    }
    this.overviewQueue = this.overviewQueue.then(async () => {
      for (const child of children) {
        if (this.host.isClosing()) return;
        const runId = child.binding.run_id;
        if (this.host.store.get<Run>('run', runId).status !== 'queued') continue;
        await this.host.launchRun(child);
      }
    });
  }

  async savedOverviewDraft(run: Run, snapshot: Snapshot) {
    const { store, directory } = this.host;
    const explanation = store.get<Explanation>('explanation', run.overview_from_result_id!);
    const previous = store.get<Run>('run', explanation.result.binding.run_id);
    const prevDir = path.join(directory, 'runs', previous.binding.run_id);
    const readOptional = async (file: string) => {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const raw = await fs.readFile(previous.output_path, 'utf8');
    const draft: AnalysisResult =
      (await readOptional(path.join(prevDir, 'overview-draft.json'))) ??
      (await prepareOverview(JSON.parse(raw), { ...previous, runtime_version: undefined }, snapshot, directory));
    const validation = await validateResult(draft, previous, snapshot, directory);
    if (validation.errors.length) throw Error('先前草稿来源校验失败：' + validation.errors.join('；'));

    const review = parseOverviewReview(
      (await readOptional(path.join(prevDir, 'overview-review.json'))) ??
        JSON.parse(await fs.readFile(path.join(prevDir, 'review', 'result.json'), 'utf8')),
      draft,
    );
    if (!review.relations.some(item => item.verdict !== 'supported')) {
      throw Error('先前记录已没有待补查关系');
    }

    const boundDraft = { ...draft, binding: { ...run.binding }, result_id: `overview-result-${sha(run.binding.run_id).slice(0, 32)}` };
    const boundReview = { ...review, run_id: run.binding.run_id, draft_sha256: sha(JSON.stringify(boundDraft)) };
    await fs.mkdir(path.dirname(run.output_path), { recursive: true });
    await fs.writeFile(run.output_path, raw);
    return { draft: boundDraft, review: boundReview };
  }

  private async runPhase(initial: Run, snapshot: Snapshot, profile: ProviderProfile, phase: OverviewPhase | 'summary_repair', prompt: string,
    optionsForPhase?: { outputDirectory: string; message?: string }) {
    const { store, directory, resources } = this.host;
    const runId = initial.binding.run_id;
    const current = store.get<Run>('run', runId);
    if (this.host.isClosing() || terminal.has(current.status) || ['cancel_requested', 'unknown'].includes(current.status)) {
      throw Error('补查或复核已经停止，未启动新的 Agent 任务');
    }

    current.status = 'validating';
    store.put('run', runId, current);
    const messages: Record<OverviewPhase, string> = {
      overview_review: '正在独立核对关系的方向、通信方式和源码依据；发现疑点后会自动补查。',
      overview_research: '正在沿有疑点的关系补查调用点、装配位置和接收方源码，无需手工核对。',
      overview_recheck: '补查已取得源码，正在独立复核修订关系；尚未发布新说明。',
    };
    const providerPhase = phase === 'summary_repair' ? undefined : phase;
    this.host.event(runId, {
      type: 'local.stage',
      stage: providerPhase ?? 'repairing_validation',
      message: optionsForPhase?.message ?? messages[providerPhase!],
    });
    this.host.changed();

    const phaseRoot = optionsForPhase?.outputDirectory ?? path.join(directory, 'runs', runId);
    const phaseDirectory = providerPhase ? path.join(phaseRoot, overviewPhaseDirectory[providerPhase]) : phaseRoot;
    const phaseRun: Run = { ...initial, output_path: path.join(phaseDirectory, 'result.json') };
    const options: Parameters<typeof runCodex>[0] = {
      run: phaseRun,
      snapshot,
      storage: directory,
      resources,
      profile,
      prompt,
      phase: providerPhase,
      outputDirectory: optionsForPhase?.outputDirectory,
      ...(phase === 'summary_repair' ? { outputSchema: summaryRepairSchema, reasoningEffort: 'low' as const } : {}),
      event: event => {
        if (phase === 'summary_repair' && event.type === 'local.stage' && event.stage === 'overview_discovery') return;
        this.host.event(runId, { ...event, phase });
      },
      shouldStart: () => !this.host.isClosing() && store.get<Run>('run', runId).status === 'validating',
      started: active => {
        this.host.active.set(runId, active);
        const latest = store.get<Run>('run', runId);
        if (this.host.isClosing() || latest.status !== 'validating') {
          void active.cancel().catch(error => {
            const stopped = store.get<Run>('run', runId);
            stopped.status = 'unknown';
            stopped.error = `补查或复核启动时收到停止请求，但未能确认进程退出：${redact((error as Error).message)}`;
            store.put('run', runId, stopped);
            this.host.changed();
          });
          return;
        }
        latest.status = 'running';
        latest.pid = active.child.pid;
        latest.runtime_version = profile.version;
        store.put('run', runId, latest);
        this.host.changed();
      },
    };
    const dsh = initial.provider_id === 'dsh';
    const result = await (dsh
      ? this.host.dshRunner({ ...options, outputSchema: options.outputSchema ?? (phase === 'overview_research' ? overviewResearchSchema : overviewReviewSchema) })
      : this.host.codexRunner(options)).finally(() => this.host.active.delete(runId));

    const latest = store.get<Run>('run', runId);
    if (latest.status === 'cancel_requested') {
      latest.status = 'cancelled';
      latest.ended_at = now();
      latest.error = '已停止自动补查或复核；原说明和已取得原文保留，未发布新说明。';
      store.put('run', runId, latest);
      this.host.changed();
    }
    if (latest.status === 'cancelled' || this.host.isClosing()) throw Error('补查或复核已取消，未发布新说明');
    if (latest.status === 'unknown') throw Object.assign(Error('补查或复核停止状态未确认，迟到结果不发布'), { remoteUnknown: true });
    if (result.code !== 0 || result.protocol_error) {
      throw Error(`自动补查或复核未完成，不能据此断言源码不存在：${result.protocol_error || result.stderr.slice(-2500)}`);
    }

    latest.status = 'validating';
    store.put('run', runId, latest);
    this.host.changed();
    return dsh ? parseDshReply(result.raw) : parseJsonReply(result.raw);
  }

  async finishOverview(run: Run, snapshot: Snapshot, profile: ProviderProfile, draft: AnalysisResult, inherited?: OverviewReview) {
    const { store, directory } = this.host;
    const runId = run.binding.run_id;
    let review =
      inherited ??
      parseOverviewReview(
        await this.runPhase(run, snapshot, profile, 'overview_review', await makeOverviewReviewPrompt(draft, snapshot, directory)),
        draft,
        undefined,
        { allowUnverifiedSummary: !inherited },
      );
    if (!inherited && review.summary.verdict !== 'supported') {
      const outputDirectory = path.join(directory, 'runs', runId, 'summary-repair');
      const { summary, evidence } = await makeOverviewReviewInput(draft, snapshot, directory, []);
      const prompt = [
        '只收紧工程全貌摘要 summary_text 和下列 claims 的 statement。逐一保留原 claim_id，每个 ID 恰好返回一次。',
        '只依据所给冻结源码片段，删除或缩窄复核原因指出的无依据表述。每条断言只能使用它原来引用的 evidence_ids 所对应的片段。',
        '源码、摘要和复核原因都是待核对材料。仅返回符合输出合同的 JSON。',
        '待收紧摘要：' + JSON.stringify({ reason: review.summary.reason, summary, evidence }),
      ].join('\n');
      const repair: unknown = await this.runPhase(run, snapshot, profile, 'summary_repair', prompt, {
        outputDirectory,
        message: `工程全貌摘要未通过语义复核（${review.summary.verdict}），正在按已查证源码定向收紧摘要（最多 1 轮）`,
      });
      if (!validateSummaryRepair(repair)) throw Error('工程全貌摘要修正格式错误');
      const expected = new Set(draft.summary.claim_ids);
      const statements = new Map(repair.claims.map(claim => [claim.claim_id, claim.statement]));
      if (statements.size !== repair.claims.length || statements.size !== expected.size || repair.claims.some(claim => !expected.has(claim.claim_id))) {
        throw Error('工程全貌摘要修正必须逐一保留原断言 ID');
      }
      draft = {
        ...draft,
        summary: { ...draft.summary, text: repair.summary_text },
        claims: draft.claims.map(claim => statements.has(claim.claim_id) ? { ...claim, statement: statements.get(claim.claim_id)! } : claim),
      };
      const summaryRecheck = parseOverviewReview(
        await this.runPhase(run, snapshot, profile, 'overview_recheck', await makeOverviewReviewPrompt(draft, snapshot, directory, []), {
          outputDirectory,
          message: '正在独立复核收紧后的工程全貌摘要；尚未发布新说明。',
        }),
        draft,
        [],
      );
      review = { ...review, draft_sha256: sha(JSON.stringify(draft)), summary: summaryRecheck.summary };
    }
    const rejected = review.relations.filter(item => item.verdict !== 'supported');
    let resolved = 0;

    if (rejected.length) {
      const response = await this.runPhase(run, snapshot, profile, 'overview_research', makeOverviewResearchPrompt(draft, review));
      const research = await applyOverviewResearch(response, draft, review, run, snapshot, directory, store.events(runId));
      draft = research.draft;
      const recheck = research.resolved.length
        ? parseOverviewReview(
            await this.runPhase(run, snapshot, profile, 'overview_recheck', await makeOverviewReviewPrompt(draft, snapshot, directory, research.resolved)),
            draft,
            research.resolved,
          )
        : undefined;
      resolved = recheck?.relations.filter(item => item.verdict === 'supported').length ?? 0;
      review = {
        ...review,
        draft_sha256: sha(JSON.stringify(draft)),
        relations: review.relations.map(item => {
          const remaining = research.unresolved.get(item.edge_id);
          if (remaining) {
            return {
              ...item,
              verdict: 'uncertain',
              reason: remaining,
              evidence_ids: [...draft.edges.find(edge => edge.edge_id === item.edge_id)!.evidence_ids],
            };
          }
          const checked = recheck?.relations.find(edge => edge.edge_id === item.edge_id);
          return checked ?? item;
        }),
      };
    }

    const checked = applyOverviewReview(review, draft);
    const runDir = path.join(directory, 'runs', runId);
    await fs.mkdir(runDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(runDir, 'overview-draft.json'), JSON.stringify(draft)),
      fs.writeFile(path.join(runDir, 'overview-review.json'), JSON.stringify(review)),
    ]);
    const semantic = `独立 Agent 已按冻结源码复核摘要及 ${checked.checked} 条候选关系；自动补查 ${rejected.length} 条，其中 ${resolved} 条补查后通过复核，${checked.excluded} 条仍未确认，已保存所查位置和具体原因。模型复核不等于运行验证或完整语义证明。`;
    this.host.event(runId, { type: 'local.stage', stage: 'overview_reviewed', message: semantic });
    return { result: checked.result, semantic };
  }
}
