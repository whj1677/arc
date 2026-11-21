import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { satisfies } from 'semver';
import { loadCodexModelCatalog } from './codex-models';
import type { GoalRefinement } from '../engineering';
import type {
  AnalysisResult,
  Annotation,
  CodeIndexSummary,
  Explanation,
  ExecutionMode,
  Feature,
  ProgramPathKey,
  Project,
  ProjectFreshness,
  ProviderPathConfig,
  ProviderProfile,
  ReadingAnswer,
  ReadingAsk,
  ReadingQuestion,
  ReadingState,
  Revision,
  Run,
  RuntimeToolStatus,
  Scenario,
  ScenarioBreakdownResult,
  Snapshot,
  SourceEditor,
  WorkspaceData,
} from '../shared';
import { activeRunStatuses, hasFunctionGraphs, readingLimits, terminalRunStatuses } from '../shared';
import { explanationFreshness } from '../freshness';
import { Store, id, now } from './store';
import { capture, freshness, readSource, sha } from './snapshot';
import { getCodeIndex } from './code-index';
import { codeIndexSummary } from './code-index-query';
import { locate, setDefaultExecutableOverrides } from './executables';
import { makePrompt, probeProviders, redact, runCodex, runCodexPromptRefinement, stopTree, type ActiveProcess } from './providers';
import { buildRefinementContext, goalRefinementSchema, parseGoalRefinement, refinementPrompt } from './prompt-refiner';
import { normalizeTransport, schema, validateResult } from './validation';
import { discoveredFeature } from '../discovered-feature';
import { catalogFeatureClues, promptContext } from './prompt-context';
import { proposeScenarios, scenarioTitleKey } from './scenario-breakdown';
import { readingAnswerSchema, validateReadingAnswer } from './reading-question';
import { isCatalogOverview, overviewDiscoveryQuestion, previousCatalogQuestion, shallowOverviewQuestion } from './architecture-analysis';
import { maxCompactEvidenceLines, overviewSchema, OverviewValidationError, prepareOverview } from './overview-result';
import { featureGraphSchema, prepareFeatureGraph } from './feature-graph-result';
import { parseDshReply } from './dsh';
import { runDshWeb } from './dsh-web';
import { EngineeringService } from './engineering-service';
import { buildTaskHud, previousFeatureResultId } from './development-hud';
import type { RadarMode } from '../live-radar';
import { buildLiveWorkspaceRadar, liveWorkspaceImpact, openLiveWorkspaceFile, readLiveFileDiff, type FileDiffOptions } from './live-radar';
import { DevelopmentService } from './development-service';
import { ReadingService } from './reading-service';
import { WalkthroughRefreshCoordinator } from './walkthrough-refresh';
import { OverviewOrchestrator } from './overview-orchestrator';
import { exportProjectBundle, importAnalysisResult, loadDemoProject } from './project-io';

const exec = promisify(execFile);
const parseJsonReply = (raw: string) => JSON.parse(raw.trim());

const oldOverviewQuestion =
  '分析整个授权快照的工程全貌：主要职责与模块边界用 stage 节点，内部函数使用 parent_node_id 关联，目录/文件用途必须有依据。列出模块、外部依赖组件及使用位置；依赖使用 dependency，不能当作运行时调用。版本仅引用清单或锁文件。明确未分析范围、构建条件、缺失实现；不根据目录名猜职责。';
const architectureOverviewQuestion =
  '分析授权快照的系统架构，先说明系统由哪些实际组件组成、如何通信和存储数据。返回 architecture.node_ids 与 architecture.edge_ids，引用 nodes/edges 中的高层组件和连接；不预设一定有前端、后端或数据库。组件标签注明已证实的语言/技术，关系标签注明 HTTP/HTTPS、SQL、文件读写等有依据的协议或访问方式；未知写未知，不能把 SQLite 猜成 MySQL，也不能把库依赖当网络服务。内部模块用 parent_node_id 归属组件，支持点击组件再深入；模块目录用途、外部依赖、版本及每条关系均给出准确源码依据。架构关系不是调用时序，保留关键调用、输入输出与未分析范围。';
const previousOverviewQuestion =
  architectureOverviewQuestion +
  ' 首次分析采用轻量发现：查阅页面导航、入口、路由、说明等，列出当前能确认的全部业务功能，按业务区域放入 feature_catalog.groups；scope 写明已查范围和未覆盖部分。功能目录引用独立 kind=stage 节点，仅名称、一句话用途及源码依据，inputs/outputs 可为空；不要展开每个功能的内部调用、完整流程或所有异常。后续用户点击功能时再单独深入。不能只列出用户已手动创建的功能，不能把文件或技术模块冒充业务功能。';

export const overviewQuestion = overviewDiscoveryQuestion;

const text = (value: unknown, max = 20000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`请输入 1–${max} 个字符`);
  }
  return value.trim();
};

export function isSupportedNodeVersion(version: string) {
  return satisfies(version.trim(), '>=22.13.0');
}

export class ArcService {
  readonly store: Store;
  readonly engineering: EngineeringService;
  readonly development: DevelopmentService;
  dispatchRun?: (run: Run) => void;
  readonly active = new Map<string, ActiveProcess>();
  readonly indexing = new Map<string, AbortController>();
  readonly executing = new Map<string, Promise<void>>();
  private closing = false;
  private localSlotsInUse = 0;
  private readonly localWaiters = new Map<string, { priority: boolean; resume: (acquired: boolean) => void }>();
  private checkingProviders = new Map<'codex' | 'dsh', Promise<ProviderProfile[]>>();
  private recentCodeSummary?: { snapshotId: string; fingerprint: string; request: Promise<CodeIndexSummary> };
  private codexModels = loadCodexModelCatalog();
  private readonly freshnessState = new Map<string, ProjectFreshness>();
  private readonly checkingFreshness = new Map<string, Promise<ProjectFreshness>>();
  private readonly readingService: ReadingService;
  private readonly breakdowns = new Map<Promise<ScenarioBreakdownResult>, AbortController>();
  private readonly walkthroughs: WalkthroughRefreshCoordinator;
  private readonly featureRefreshes = new Map<string, {refreshing: boolean; error?: string}>();
  private readonly overviews: OverviewOrchestrator;

  constructor(
    readonly directory: string,
    readonly resources: string,
    readonly emit: (e: any) => void = () => {},
    private readonly codexRunner: typeof runCodex = runCodex,
    private readonly dshRunner: typeof runDshWeb = runDshWeb,
  ) {
    this.store = new Store(directory);
    this.syncToolPathOverrides();
    this.engineering = new EngineeringService(this.store, type => this.emit({type:type??'changed'}));
    this.engineering.onTaskFinished = task => {
      void this.refreshTaskWalkthrough(task.task_id);
    };
    this.development = new DevelopmentService(this.engineering, this.store, resources, event => this.emit(event));

    const launchRun = (run: Run) => {
      const runId = run.binding.run_id;
      const task = this.execute(run)
        .catch(error => this.fail(runId, error))
        .finally(() => this.executing.delete(runId));
      this.executing.set(runId, task);
      return task;
    };

    this.readingService = new ReadingService({
      store: this.store,
      directory: this.directory,
      isClosing: () => this.closing,
      overview: projectId => this.overview(projectId),
      refresh: projectId => this.refresh(projectId),
      event: (runId, event, eventId, sequence) => this.event(runId, event, eventId, sequence),
      changed: () => this.changed(),
      getDispatchRun: () => this.dispatchRun,
      launchRun: run => {
        void launchRun(run);
      },
    });

    this.walkthroughs = new WalkthroughRefreshCoordinator({
      store: this.store,
      engineering: this.engineering,
      executing: this.executing,
      isClosing: () => this.closing,
      refresh: projectId => this.refresh(projectId),
      startRun: (scenarioId, providerId, submissionKey, previousRunId, options) =>
        this.startRun(scenarioId, providerId, submissionKey, previousRunId, options),
      cancel: runId => this.cancel(runId),
      prepareManual: (scenarioId, taskId) => this.prepareAnalysis(scenarioId, taskId),
    });

    this.overviews = new OverviewOrchestrator({
      store: this.store,
      directory: this.directory,
      resources: this.resources,
      active: this.active,
      codexRunner: this.codexRunner,
      dshRunner: this.dshRunner,
      isClosing: () => this.closing,
      changed: () => this.changed(),
      event: (runId, event, eventId, sequence) => this.event(runId, event, eventId, sequence),
      fail: (runId, error) => this.fail(runId, error),
      getDispatchRun: () => this.dispatchRun,
      launchRun,
      discoveredTarget: (project, result, node, features, explanations, scenes) =>
        this.discoveredTarget(project, result, node, features, explanations, scenes),
    });

    for (const run of this.store.all<Run>('run')) {
      if (!terminalRunStatuses.has(run.status) && !['unknown', 'waiting_agent'].includes(run.status)) {
        if (this.overviews.cancelUnstartedChild(run)) continue;
        run.status = 'unknown';
        run.error = 'Arc 上次退出前未记录终态；不会自动重发。请核查原会话，或明确新建关联重试。';
        this.store.put('run', run.binding.run_id, run);
      }
    }
    for (const task of this.store.all<import('../engineering').EngineeringTask>('engineering_task')) {
      if (task.walkthrough?.status === 'running') {
        const update = task.walkthrough;
        const run = update.run_id ? this.store.maybe<Run>('run', update.run_id) : null;
        const explanation = run && this.store.all<Explanation>('explanation').find(e => e.result.binding.run_id === run.binding.run_id);
        this.engineering.saveWalkthrough(
          task.task_id,
          run?.status === 'completed' && explanation
            ? { ...update, status: 'completed', result_id: explanation.result_id, updated_at: now() }
            : { ...update, status: 'failed', error: 'ARC 重启前走读更新未保存终态；旧说明和开发成果保留，可重试。', updated_at: now() },
          update.update_id,
        );
      }
    }
  }

  data(): WorkspaceData {
    return {
      codex_preferences: this.store.codexPreferences(),
      codex_models: this.codexModels,
      projects: this.store.all('project'),
      features: this.store.all('feature'),
      scenarios: this.store.all('scenario'),
      revisions: this.store.all('revision'),
      annotations: this.store.all('annotation'),
      runs: this.store.all('run'),
      explanations: this.store.all('explanation'),
      providers: this.store.all('provider'),
      snapshots: this.store.all('snapshot'),
      project_freshness: Object.fromEntries(this.freshnessState),
      questions: this.store.all('reading_question'),
      development_tasks: this.engineering.tasks(),
      requested_analysis: this.store.maybe('setting', 'mcp-requested-analysis') ?? undefined,
    };
  }

  changed() {
    this.emit({ type: 'changed' });
  }

  async refineDevelopmentGoal(projectId: string, goal: string, nonGoals: string[], engine: GoalRefinement['engine']): Promise<GoalRefinement> {
    const started = Date.now();
    if (engine !== 'codex' && engine !== 'dsh') throw Error('提示词优化引擎无效。');
    if (!Array.isArray(nonGoals) || nonGoals.length > 40) throw Error('不改范围最多可选择 40 项。');
    const boundaries = nonGoals.map(item => text(item, 6000));
    const prompt = refinementPrompt(text(goal), buildRefinementContext(this.store, projectId, boundaries));
    const config = this.store.maybe<Record<string, string>>('settings', 'providers') ?? {};
    let raw: string;
    if (engine === 'codex') {
      raw = await runCodexPromptRefinement(prompt, goalRefinementSchema, config.codex_path, this.store.codexPreferences());
    } else {
      const [profile] = await probeProviders(config, 'dsh');
      if (profile.status !== 'available') throw Error('本机 DSH 不可用：' + profile.reason);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-dsh-goal-'));
      try {
        const result = await this.dshRunner({
          toolFree: true, profile, prompt, outputSchema: goalRefinementSchema,
          run: { title: '优化提示词', output_path: path.join(directory, 'answer.json') },
          timeoutMs: Math.max(0, 60000 - (Date.now() - started)), event: () => {}, started: () => {},
        });
        if (result.code !== 0) throw Error(result.stderr || 'DSH 提示词优化未完成。');
        raw = result.raw;
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
    return { ...parseGoalRefinement(raw, boundaries, engine), engine, duration_ms: Date.now() - started };
  }

  async openProject(rootPath: string, fictional = false, buildConfig = '') {
    const real = await fs.realpath(rootPath);
    const exists = this.store.all<Project>('project').find(p => p.root_path.toLowerCase() === real.toLowerCase() && p.fictional === fictional);
    if (exists) {
      await this.checkFreshness(exists.project_id);
      if (!fictional) await this.engineering.connect(exists.project_id);
      return exists;
    }
    const projectId = id('project');
    const controller = new AbortController();
    this.indexing.set(projectId, controller);
    this.emit({ type: 'indexing', project_id: projectId, project_name: path.basename(real), root_path: real, count: 0 });
    try {
      const snapshot = await capture(real, projectId, this.directory, buildConfig, controller.signal, n =>
        this.emit({ type: 'indexing', project_id: projectId, project_name: path.basename(real), root_path: real, count: n }),
      );
      const project: Project = {
        project_id: projectId,
        name: path.basename(real),
        root_path: real,
        snapshot_id: snapshot.source_snapshot_id,
        fictional,
        build_config: buildConfig,
        created_at: now(),
      };
      this.store.transaction(() => {
        this.store.put('project', projectId, project);
        this.store.put('snapshot', snapshot.source_snapshot_id, snapshot);
      });
      this.freshnessState.set(projectId, { snapshot_id: project.snapshot_id, changed_files: [], checked_at: now() });
      if (!fictional) await this.engineering.connect(projectId);
      this.changed();
      return project;
    } finally {
      this.indexing.delete(projectId);
      this.emit({ type: 'index_done', project_id: projectId });
    }
  }

  cancelIndex(projectId: string) {
    this.indexing.get(projectId)?.abort();
  }

  overview(projectId: string) {
    const project = this.store.get<Project>('project', projectId);
    if (project.overview_scenario_id) {
      let scene = this.store.get<Scenario>('scenario', project.overview_scenario_id);
      // Upgrade only our untouched default when a new overview is explicitly requested.
      if ([oldOverviewQuestion, architectureOverviewQuestion, previousOverviewQuestion, shallowOverviewQuestion, previousCatalogQuestion].includes(scene.question)) {
        scene = this.reviseScenario(scene.scenario_id, overviewQuestion);
        if (scene.title === '工程全貌 · 模块、目录用途与依赖') scene.title = '工程全貌 · 系统架构';
        this.store.put('scenario', scene.scenario_id, scene);
        this.changed();
      }
      return scene;
    }
    const { scenario } = this.addFeature(projectId, '工程全貌', overviewQuestion);
    scenario.title = '工程全貌 · 系统架构';
    this.store.transaction(() => {
      this.store.put('scenario', scenario.scenario_id, scenario);
      project.overview_scenario_id = scenario.scenario_id;
      this.store.put('project', projectId, project);
    });
    this.changed();
    return scenario;
  }

  addFeature(projectId: string, name: string, question?: string, discovery?: Feature['discovery']) {
    const created = this.store.transaction(() => this.insertFeature(projectId, name, question, discovery));
    this.changed();
    return created;
  }

  private insertFeature(projectId: string, name: string, question?: string, discovery?: Feature['discovery']) {
    this.store.get('project', projectId);
    const feature: Feature = {
      feature_id: id('feature'),
      project_id: projectId,
      name: text(name, 300),
      archived: false,
      sort_order: this.store.all('feature').length,
    };
    if (discovery) feature.discovery = discovery;
    this.store.put('feature', feature.feature_id, feature);
    const scenario = this.insertScenario(feature.feature_id, question?.trim() || `整体走读「${feature.name}」：关键职责、调用、输入输出、依据和未确认范围。`);
    if (discovery || !question?.trim()) {
      scenario.kind = 'feature_overview';
      scenario.title = `${feature.name} · 整体走读`;
      this.store.put('scenario', scenario.scenario_id, scenario);
    }
    return { feature, scenario };
  }

  openDiscoveredFeature(projectId: string, resultId: string, nodeId: string, requestMcp = false) {
    const project = this.store.get<Project>('project', projectId);
    const explanation = this.store.get<Explanation>('explanation', resultId);
    if (explanation.scenario_id !== project.overview_scenario_id || explanation.result.binding.project_id !== projectId) {
      throw Error('功能目录不属于本工程全貌');
    }
    const result = explanation.result;
    const node = result.nodes.find(n => n.node_id === nodeId);
    if (!node || !result.feature_catalog?.groups.some(g => g.node_ids.includes(nodeId))) {
      throw Error('此功能不在已发现目录中');
    }
    const target = this.store.transaction(() => this.discoveredTarget(project, result, node));
    if (!target) throw Error('功能已归档，请先恢复后再展开');
    const { feature, scenario: scene } = target;
    const matches = this.store
      .all<Explanation>('explanation')
      .filter(
        e =>
          e.scenario_id === scene.scenario_id &&
          e.result.binding.question_revision_id === scene.question_revision_id &&
          e.result.binding.source_snapshot_id === project.snapshot_id,
      );
    const cached = matches.findLast(e => e.source_status === 'current' && hasFunctionGraphs(e.result)) ?? matches.at(-1);
    const active = this.store
      .all<Run>('run')
      .find(r => !r.reading_question_id && r.binding.scenario_id === scene.scenario_id && !terminalRunStatuses.has(r.status) && r.status !== 'unknown');
    if (requestMcp && !cached && !active) {
      this.store.put('setting', 'mcp-requested-analysis', {
        project_id: projectId,
        scenario_id: scene.scenario_id,
        source_snapshot_id: this.analysisSnapshot(scene),
        question_revision_id: scene.question_revision_id,
        created_at: now(),
      });
    } else if (requestMcp) {
      this.store.put('setting', 'mcp-requested-analysis', null);
    }
    this.changed();
    return { feature, scenario: scene, result_id: cached?.result_id, run_id: active?.binding.run_id };
  }

  private discoveredTarget(
    project: Project,
    result: AnalysisResult,
    node: AnalysisResult['nodes'][number],
    features = this.store.all<Feature>('feature'),
    explanations = this.store.all<Explanation>('explanation'),
    scenes = this.store.all<Scenario>('scenario'),
  ) {
    const projectId = project.project_id;
    const resultId = result.result_id;
    const nodeId = node.node_id;
    // Identity comes from the bound discovery, never from a possibly edited name.
    let feature = discoveredFeature(features, explanations, result, nodeId, project.snapshot_id);
    let scene = feature && scenes.find(s => s.feature_id === feature!.feature_id && s.kind === 'feature_overview');
    if (feature?.archived || scene?.archived) return;
    if (feature && scene && feature.discovery?.result_id !== resultId && result.binding.source_snapshot_id === project.snapshot_id) {
      feature.discovery = { result_id: resultId, node_id: nodeId, source_snapshot_id: project.snapshot_id };
      this.store.put('feature', feature.feature_id, feature);
    }
    if (!feature || !scene) {
      if (result.binding.source_snapshot_id !== project.snapshot_id) {
        throw Error('功能目录来自旧快照，请更新工程功能目录后再展开');
      }
      const refs = result.evidence
        .filter(e => node.evidence_ids.includes(e.evidence_id))
        .map(e => `${e.path}:${e.line_start}-${e.line_end}`)
        .join('，');
      const question = `只深入功能「${node.label}」：${node.description}。功能发现依据：${refs}。目录来源 ${resultId} / ${nodeId}。先检查该功能的真实入口和实现，再以业务时间线说明触发条件、主要步骤、输入输出和失败处理；不分析其他功能的内部细节。清楚区分来源事实与未知，不根据目录标题编造流程。`;
      const created = this.insertFeature(projectId, node.label.slice(0, 300), question.slice(0, 20000), {
        result_id: resultId,
        node_id: nodeId,
        source_snapshot_id: result.binding.source_snapshot_id,
      });
      feature = created.feature;
      scene = created.scenario;
    }
    return { feature, scenario: scene };
  }

  analysisSnapshot(scene: Scenario) {
    const project = this.store.get<Project>('project', scene.project_id);
    const feature = this.store.get<Feature>('feature', scene.feature_id);
    if (feature.discovery && feature.discovery.source_snapshot_id !== project.snapshot_id) {
      const reviewed = this.store
        .all<Explanation>('explanation')
        .some(
          e =>
            e.scenario_id === scene.scenario_id &&
            e.result.binding.project_id === project.project_id &&
            e.result.binding.feature_id === feature.feature_id &&
            e.result.binding.scenario_id === scene.scenario_id,
        );
      if (!reviewed) throw Error('此功能发现绑定旧快照，请更新功能目录后再分析；历史说明仍可查看');
    }
    return project.snapshot_id;
  }

  prepareAnalysis(scenarioId: string, developmentTaskId?: string, projectAnalysis = false) {
    const scene = this.store.get<Scenario>('scenario', scenarioId);
    const project = this.store.get<Project>('project', scene.project_id);
    const feature = this.store.get<Feature>('feature', scene.feature_id);
    if (project.fictional) throw Error('演示工程不派发真实分析');
    if (scene.archived || feature.archived) throw Error('请先恢复已归档功能或场景');
    if (developmentTaskId) {
      const task = this.engineering.task(developmentTaskId);
      if (task.project_id !== scene.project_id || task.reading?.scenario_id !== scenarioId) {
        throw Error('开发任务与待领取场景归属不一致');
      }
    }
    const source = this.analysisSnapshot(scene);
    const active = this.store
      .all<Run>('run')
      .find(r => !r.reading_question_id && r.binding.scenario_id === scenarioId && activeRunStatuses.has(r.status));
    if (active) return { run_id: active.binding.run_id };
    this.store.put('setting', 'mcp-requested-analysis', {
      project_id: scene.project_id,
      scenario_id: scenarioId,
      source_snapshot_id: source,
      question_revision_id: scene.question_revision_id,
      created_at: now(),
      ...(projectAnalysis && !developmentTaskId && project.overview_scenario_id === scenarioId ? { project_analysis: true } : {}),
      ...(developmentTaskId ? { development_task_id: developmentTaskId } : {}),
    });
    this.changed();
    return { scenario_id: scenarioId, ...(developmentTaskId ? { development_task_id: developmentTaskId } : {}) };
  }

  async breakdownFeature(featureId: string): Promise<ScenarioBreakdownResult> {
    const feature = this.store.get<Feature>('feature', featureId);
    const project = this.store.get<Project>('project', feature.project_id);
    if (project.fictional) throw Error('演示工程不派发真实分析');
    if (feature.archived) throw Error('请先恢复已归档功能');
    const scenes = this.store.all<Scenario>('scenario').filter(s => s.feature_id === featureId);
    if (scenes.some(s => s.scenario_id === project.overview_scenario_id)) throw Error('请选择要细化的业务功能');
    const scene = scenes.find(s => s.kind === 'feature_overview') ?? scenes[0];
    const snapshot = this.store.get<Snapshot>('snapshot', this.analysisSnapshot(scene));
    const controller = new AbortController();
    const task = proposeScenarios(this.store, this.resources, feature, scenes, snapshot, this.codexRunner, this.dshRunner, controller.signal);
    this.breakdowns.set(task, controller);
    try { return await task; } finally { this.breakdowns.delete(task); }
  }

  addScenario(featureId: string, question: string, title?: string, kind?: 'breakdown') {
    const scene = this.insertScenario(featureId, question, title, kind);
    this.changed();
    return scene;
  }

  private insertScenario(featureId: string, question: string, title?: string, kind?: 'breakdown') {
    const feature = this.store.get<Feature>('feature', featureId);
    const q = text(question);
    if (feature.archived) throw new Error('请先恢复已归档功能，再添加场景');
    const project = this.store.get<Project>('project', feature.project_id);
    if (project.overview_scenario_id && this.store.get<Scenario>('scenario', project.overview_scenario_id).feature_id === featureId) {
      throw new Error('工程全貌不接收业务场景，请选择一个用户功能');
    }
    const scenarioTitle = title === undefined ? q.slice(0, 100) : text(title, 300);
    if (kind === 'breakdown' && this.store.all<Scenario>('scenario').some(s =>
      s.feature_id === featureId && scenarioTitleKey(s.title) === scenarioTitleKey(scenarioTitle))) {
      throw Error('该功能已包含同名子场景：' + scenarioTitle);
    }
    const scenario: Scenario = {
      scenario_id: id('scenario'),
      feature_id: featureId,
      project_id: feature.project_id,
      title: scenarioTitle,
      ...(kind === 'breakdown' && { kind }),
      question: q,
      question_revision_id: id('question'),
      archived: false,
      sort_order: this.store.all('scenario').length,
    };
    this.store.put('scenario', scenario.scenario_id, scenario);
    this.store.put('revision', scenario.question_revision_id, {
      question_revision_id: scenario.question_revision_id,
      scenario_id: scenario.scenario_id,
      question: q,
      created_at: now(),
    } satisfies Revision);
    return scenario;
  }

  reviseScenario(scenarioId: string, question: string) {
    const s = this.store.get<Scenario>('scenario', scenarioId);
    const q = text(question);
    if (q === s.question) return s;
    s.question = q;
    s.question_revision_id = id('question');
    this.store.transaction(() => {
      this.store.put('revision', s.question_revision_id, {
        question_revision_id: s.question_revision_id,
        scenario_id: s.scenario_id,
        question: q,
        created_at: now(),
      });
      this.store.put('scenario', s.scenario_id, s);
    });
    this.changed();
    return s;
  }

  organize(kind: 'feature' | 'scenario', objectId: string, patch: { name?: string; title?: string; archived?: boolean; sort_order?: number }) {
    if (!['feature', 'scenario'].includes(kind)) throw new Error('对象类型不允许');
    const object = this.store.get(kind, objectId);
    if (patch.name !== undefined && kind === 'feature') object.name = text(patch.name, 300);
    if (patch.title !== undefined && kind === 'scenario') object.title = text(patch.title, 300);
    if (typeof patch.archived === 'boolean') object.archived = patch.archived;
    if (Number.isSafeInteger(patch.sort_order)) object.sort_order = patch.sort_order;
    this.store.put(kind, objectId, object);
    this.changed();
  }

  annotate(scenarioId: string, body: string, resultId: string | null, objectId: string | null, objectKind?: 'node' | 'edge') {
    const scenario = this.store.get<Scenario>('scenario', scenarioId);
    const project = this.store.get<Project>('project', scenario.project_id);
    const result = resultId ? this.store.get<Explanation>('explanation', resultId) : null;
    if (result && result.scenario_id !== scenarioId) throw new Error('批注归属不匹配');
    const kind = objectKind ?? (result?.result.nodes.some(n => n.node_id === objectId) ? 'node' : 'edge');
    if (objectId && !(kind === 'node' && result?.result.nodes.some(n => n.node_id === objectId) ||
      kind === 'edge' && result?.result.edges.some(e => e.edge_id === objectId))) {
      throw new Error('批注对象不属于原说明');
    }
    const annotation: Annotation = {
      annotation_id: id('clue'),
      project_id: project.project_id,
      scenario_id: scenarioId,
      result_id: resultId,
      object_id: objectId,
      ...(objectId && { target: { kind, id: objectId } }),
      source_snapshot_id: result?.result.binding.source_snapshot_id || project.snapshot_id,
      text: text(body),
      created_at: now(),
    };
    this.store.put('annotation', annotation.annotation_id, annotation);
    this.changed();
    return annotation;
  }

  async refresh(projectId: string, buildConfig?: string) {
    const project = this.store.get<Project>('project', projectId);
    const controller = new AbortController();
    if (this.indexing.has(projectId)) throw new Error('工程索引尚未结束');
    this.indexing.set(projectId, controller);
    this.emit({ type: 'indexing', project_id: projectId, project_name: project.name, root_path: project.root_path, count: 0 });
    try {
      const snapshot = await capture(project.root_path, projectId, this.directory, buildConfig ?? project.build_config, controller.signal, n =>
        this.emit({ type: 'indexing', project_id: projectId, project_name: project.name, root_path: project.root_path, count: n }),
      );
      this.store.transaction(() => {
        this.store.put('snapshot', snapshot.source_snapshot_id, snapshot);
        project.snapshot_id = snapshot.source_snapshot_id;
        project.build_config = snapshot.build_config;
        this.store.put('project', projectId, project);
        this.updateExplanationSources(snapshot, []);
      });
      this.freshnessState.set(projectId, { snapshot_id: snapshot.source_snapshot_id, changed_files: [], checked_at: now() });
      this.changed();
      return snapshot;
    } finally {
      this.indexing.delete(projectId);
      this.emit({ type: 'index_done', project_id: projectId });
    }
  }

  private explanationSourceStatus(explanation: Explanation, snapshot: Snapshot, changes: string[] | undefined) {
    if (!changes) return 'needs_review';
    const boundId = explanation.result.binding.source_snapshot_id;
    if (boundId !== snapshot.source_snapshot_id &&
        this.store.get<Snapshot>('snapshot', boundId).fingerprint !== snapshot.fingerprint) return 'needs_review';
    return changes.length && explanationFreshness(explanation, snapshot.source_snapshot_id, changes).kind === 'affected'
      ? 'needs_review' : 'current';
  }

  private updateExplanationSources(snapshot: Snapshot, changes: string[] | undefined) {
    for (const explanation of this.store.all<Explanation>('explanation')) {
      if (explanation.result.binding.project_id !== snapshot.project_id) continue;
      const status = this.explanationSourceStatus(explanation, snapshot, changes);
      if (explanation.source_status !== status) {
        this.store.put('explanation', explanation.result_id, { ...explanation, source_status: status });
      }
    }
  }

  checkFreshness(projectId: string): Promise<ProjectFreshness> {
    const pending = this.checkingFreshness.get(projectId);
    if (pending) return pending;
    const check = this.scanFreshness(projectId).finally(() => this.checkingFreshness.delete(projectId));
    this.checkingFreshness.set(projectId, check);
    return check;
  }

  private async scanFreshness(projectId: string): Promise<ProjectFreshness> {
    const project = this.store.get<Project>('project', projectId);
    const snapshot = this.store.get<Snapshot>('snapshot', project.snapshot_id);
    let changes: string[];
    try {
      changes = await freshness(snapshot);
    } catch (error) {
      if (this.store.get<Project>('project', projectId).snapshot_id === snapshot.source_snapshot_id) {
        this.store.transaction(() => this.updateExplanationSources(snapshot, undefined));
        this.freshnessState.delete(projectId);
        this.changed();
      }
      throw error;
    }
    const currentId = this.store.get<Project>('project', projectId).snapshot_id;
    if (currentId !== snapshot.source_snapshot_id) {
      const updated = this.freshnessState.get(projectId);
      if (updated?.snapshot_id === currentId) return updated;
      throw new Error('检查期间工程快照已更新，请重新检查');
    }
    this.store.transaction(() => this.updateExplanationSources(snapshot, changes));
    const state = { snapshot_id: currentId, changed_files: changes, checked_at: now() };
    this.freshnessState.set(projectId, state);
    this.changed();
    return state;
  }

  async source(snapshotId: string, file: string) {
    return readSource(this.directory, this.store.get('snapshot', snapshotId), file);
  }

  async codeIndexSummary(snapshotId: string) {
    const snapshot = this.store.get<Snapshot>('snapshot', snapshotId);
    const recent = this.recentCodeSummary;
    if (recent?.snapshotId === snapshotId && recent.fingerprint === snapshot.fingerprint) return recent.request;
    const request = getCodeIndex(this.directory, snapshot).then(codeIndexSummary);
    this.recentCodeSummary = {snapshotId, fingerprint: snapshot.fingerprint, request};
    try {
      return await request;
    } catch (error) {
      if (this.recentCodeSummary?.request === request) this.recentCodeSummary = undefined;
      throw error;
    }
  }

  reading(key: string, value?: ReadingState) {
    if (typeof key !== 'string' || key.length > 500) throw new Error('阅读状态键无效');
    if (value !== undefined) {
      if (JSON.stringify(value).length > 100000) throw new Error('阅读状态过大');
      this.store.put('reading', key, value);
      return value;
    }
    return this.store.maybe('reading', key);
  }

  providerPathConfig(): ProviderPathConfig {
    return this.store.maybe<ProviderPathConfig>('settings', 'providers') ?? {};
  }

  private syncToolPathOverrides(config = this.providerPathConfig()) {
    setDefaultExecutableOverrides({ node: config.node_path, git: config.git_path });
  }

  async probe(config?: Record<string, string>, only?: 'codex' | 'dsh') {
    const saved = this.providerPathConfig();
    if (config) {
      for (const [key, value] of Object.entries(config)) {
        if (!['codex_path', 'dsh_path', 'node_path', 'git_path'].includes(key) || typeof value !== 'string') throw new Error('不支持的连接配置');
        const pathKey = key as ProgramPathKey;
        const file = value.trim();
        if (file) saved[pathKey] = file;
        else delete saved[pathKey];
      }
      this.store.put('settings', 'providers', saved);
      this.syncToolPathOverrides(saved);
    }
    const profiles = await probeProviders(saved, only);
    if (only !== 'dsh') this.codexModels = loadCodexModelCatalog();
    for (const p of profiles) this.store.put('provider', p.provider_id, p);
    this.changed();
    return profiles;
  }

  async probeRuntimeTools(): Promise<RuntimeToolStatus[]> {
    const saved = this.providerPathConfig();
    return Promise.all((['node', 'git'] as const).map(async (id): Promise<RuntimeToolStatus> => {
      const label = id === 'node' ? 'Node.js' : 'Git';
      let file = saved[`${id}_path`];
      try {
        file = await locate(id, file);
        const { stdout } = await exec(file, ['--version'], { windowsHide: true, timeout: 4000 });
        const version = stdout.trim();
        if (id === 'node' && !isSupportedNodeVersion(version)) {
          return {
            id,
            label,
            status: 'missing',
            path: file,
            version,
            reason: '当前 Node.js 版本低于最低要求（≥ v22.13.0，内置 MCP 工具依赖 node:sqlite），请升级或指定 v22+ 的 node.exe。',
          };
        }
        return { id, label, status: 'available', path: file, version };
      } catch (error) {
        return { id, label, status: 'missing', path: file, reason: redact((error as Error).message) };
      }
    }));
  }

  askReading(input: ReadingAsk): Promise<ReadingQuestion> {
    return this.readingService.ask(input);
  }

  retryReading(questionId: string, mode: ExecutionMode = 'codex', submissionKey: string): ReadingQuestion {
    return this.readingService.retry(questionId, mode, submissionKey);
  }

  private analysisHistory(run: Run) {
    const annotations = this.store.all<Annotation>('annotation').filter(a => a.scenario_id === run.binding.scenario_id);
    const explanations = this.store.all<Explanation>('explanation');
    const last = run.feature_refresh_task_id && run.refresh_from_result_id
      ? explanations.find(e => e.result_id === run.refresh_from_result_id && e.scenario_id === run.binding.scenario_id)
      : explanations.findLast(e => e.scenario_id === run.binding.scenario_id);
    const discovery = this.store.get<Feature>('feature', run.binding.feature_id).discovery;
    const overview = discovery && explanations.find(e => run.overview_parent_run_id
      ? e.result.binding.run_id === run.overview_parent_run_id : e.result_id === discovery.result_id)?.result;
    return {
      annotations,
      previous: last ? { result_id: last.result_id, binding: last.result.binding, summary: last.result.summary } : undefined,
      catalogFeature: overview && discovery && overview.binding.project_id === run.binding.project_id &&
        overview.binding.source_snapshot_id === run.binding.source_snapshot_id ? catalogFeatureClues(overview, discovery.node_id) : undefined,
    };
  }

  analysisContext(run: Run) {
    if (run.reading_context) return run.reading_context;
    const snapshot = this.store.get<Snapshot>('snapshot', run.binding.source_snapshot_id);
    const { annotations, previous, catalogFeature } = this.analysisHistory(run);
    return promptContext(snapshot, annotations, previous, catalogFeature);
  }

  async startRun(
    scenarioId: string,
    mode: ExecutionMode,
    submissionKey: string,
    previousRunId?: string,
    options: { sourceSnapshotId?: string; developmentTaskId?: string; refreshFromResultId?: string; featureRefreshTaskId?: string; projectAnalysis?: boolean } = {},
  ) {
    if (this.closing) throw new Error('Arc 正在退出，未派发新任务');
    if (!['codex', 'dsh', 'codex_desktop'].includes(mode) && !(mode === 'mcp' && options.featureRefreshTaskId)) throw new Error('请选择支持的执行通道');
    const providerId = mode === 'dsh' ? 'dsh' : 'codex';
    const dispatch = mode === 'codex_desktop' ? this.dispatchRun : undefined;
    if (mode === 'codex_desktop' && !dispatch) throw new Error('Codex 桌面会话派发通道不可用');
    if (!/^[\w-]{8,100}$/.test(submissionKey)) throw new Error('提交幂等键无效');
    const existing = this.store.all<Run>('run').find(r => r.submission_key === submissionKey);
    if (existing) {
      if (existing.binding.scenario_id !== scenarioId || (existing.execution_mode ?? existing.provider_id) !== mode ||
          existing.development_task_id !== options.developmentTaskId || existing.feature_refresh_task_id !== options.featureRefreshTaskId) {
        throw new Error('幂等键归属冲突');
      }
      return existing;
    }

    const scenario = this.store.get<Scenario>('scenario', scenarioId);
    const project = this.store.get<Project>('project', scenario.project_id);
    if (project.fictional) throw new Error('演示工程不调用真实 Provider；请打开实际工程或测试源码目录');
    const busy = this.store
      .all<Run>('run')
      .find(
        r =>
          !r.reading_question_id &&
          r.binding.scenario_id === scenarioId &&
          (r.provider_id === providerId ||
            (r.overview_parent_run_id && r.binding.source_snapshot_id === project.snapshot_id && r.binding.question_revision_id === scenario.question_revision_id)) &&
          !terminalRunStatuses.has(r.status) &&
          r.status !== 'unknown',
      );
    if (busy) throw new Error('该场景同一 Provider 已有进行中的运行；请先等待或停止');
    if (previousRunId) {
      const previous = this.store.get<Run>('run', previousRunId);
      if (previous.binding.scenario_id !== scenarioId) throw new Error('前次运行不属于此场景');
    }

    const sourceSnapshotId = options.sourceSnapshotId ?? this.analysisSnapshot(scenario);
    const source = this.store.get<Snapshot>('snapshot', sourceSnapshotId);
    if (source.project_id !== project.project_id) throw Error('复核来源不属于当前工程');
    if (options.developmentTaskId) {
      const task = this.engineering.task(options.developmentTaskId);
      if (task.project_id !== project.project_id || task.reading?.scenario_id !== scenarioId) {
        throw Error('开发任务与功能走读归属不一致');
      }
    }

    // Freeze synchronously before yielding; UI changes cannot change this envelope.
    const runId = id('run');
    const run: Run = {
      binding: {
        project_id: project.project_id,
        feature_id: scenario.feature_id,
        scenario_id: scenarioId,
        question_revision_id: scenario.question_revision_id,
        source_snapshot_id: sourceSnapshotId,
        run_id: runId,
      },
      provider_id: providerId,
      execution_mode: mode,
      status: 'queued',
      question: scenario.question,
      title: options.developmentTaskId ? `${scenario.title} · 开发后复核` : scenario.title,
      created_at: now(),
      submission_key: submissionKey,
      previous_run_id: previousRunId,
      output_path: path.join(this.directory, 'runs', runId, 'result.json'),
      ...(options.developmentTaskId ? { development_task_id: options.developmentTaskId } : {}),
      ...(options.featureRefreshTaskId ? { feature_refresh_task_id: options.featureRefreshTaskId } : {}),
      ...(options.refreshFromResultId ? { refresh_from_result_id: options.refreshFromResultId } : {}),
    };
    if (options.projectAnalysis && !options.developmentTaskId && project.overview_scenario_id === scenarioId) {
      run.overview_followup_mode = dispatch ? 'dispatch' : 'direct';
    }
    if (isCatalogOverview(scenario.question)) run.overview_format = 'overview-1';

    if (mode === 'mcp') {
      run.status = 'waiting_agent';
      run.origin = 'mcp';
      this.store.transaction(() => {
        this.store.put('run', runId, run);
        const requested = this.store.maybe<{feature_refresh_run_id?: string}>('setting', 'mcp-requested-analysis');
        const waiting = requested?.feature_refresh_run_id
          ? this.store.maybe<Run>('run', requested.feature_refresh_run_id) : undefined;
        if (waiting?.status !== 'waiting_agent' || !waiting.feature_refresh_task_id ||
            waiting.binding.project_id !== project.project_id) {
          this.store.put('setting', 'mcp-requested-analysis', {
            ...run.binding, created_at: run.created_at, feature_refresh_run_id: runId,
          });
        }
      });
      this.changed();
      return run;
    }

    this.store.put('run', runId, run);
    this.changed();
    this.event(runId, {
      type: 'local.stage',
      stage: 'queued',
      message: options.developmentTaskId ? '开发结果已保存；正在按新代码重新核对同一功能，旧说明保留' : '任务与源码快照已绑定，正在准备执行',
    });
    if (dispatch) {
      dispatch(run);
      return run;
    }
    const task = this.execute(run)
      .catch(error => this.fail(runId, error))
      .finally(() => this.executing.delete(runId));
    this.executing.set(runId, task);
    return run;
  }

  refreshTaskWalkthrough(taskId: string, submissionKey?: string): Promise<void> {
    return this.walkthroughs.refreshTask(taskId, submissionKey);
  }

  private latestFeatureRefreshRun(taskId: string, scenarioId: string): Run | undefined {
    const row = this.store.db.prepare(`SELECT json FROM objects WHERE kind='run'
      AND json_extract(json,'$.feature_refresh_task_id')=?
      AND json_extract(json,'$.binding.scenario_id')=?
      ORDER BY json_extract(json,'$.created_at') DESC, rowid DESC LIMIT 1`).get(taskId, scenarioId);
    return row ? JSON.parse(String(row.json)) : undefined;
  }

  private featureRefreshState(taskId: string, scenarioId: string) {
    const run = this.latestFeatureRefreshRun(taskId, scenarioId);
    if (run && activeRunStatuses.has(run.status)) return {refreshing: true};
    const transient = this.featureRefreshes.get(`${taskId}/${scenarioId}`);
    if (transient || !run) return transient;
    return run.status === 'completed'
      ? {refreshing: false}
      : {refreshing: false, error: run.error || `走读更新未完成（${run.status}）`};
  }

  taskHud(taskId: string) {
    return buildTaskHud(this.store, this.directory, taskId,
      (task, scenario) => this.featureRefreshState(task, scenario));
  }

  liveRadar(projectId: string, options?: { mode?: RadarMode; commit?: string; previousFingerprint?: string }) {
    return buildLiveWorkspaceRadar(this.store, projectId, options);
  }

  liveFileDiff(projectId: string, options: FileDiffOptions) {
    return readLiveFileDiff(this.store, projectId, options);
  }

  openLiveFile(projectId: string, file: string, line: number | undefined, editor: SourceEditor,
      openPath: (file: string) => Promise<string>) {
    return openLiveWorkspaceFile(this.store, projectId, file, line, editor, openPath);
  }

  liveImpact(projectId: string, files: string[]) {
    return liveWorkspaceImpact(this.store, this.store.get<Project>('project', projectId), files);
  }

  async refreshFeatureWalkthrough(taskId: string, scenarioId: string, submissionKey: string,
      enableExternal?: (mode: ExecutionMode, projectId: string) => Promise<void>): Promise<void> {
    const task = this.engineering.task(taskId);
    const scene = this.store.get<Scenario>('scenario', scenarioId);
    if (task.project_id !== scene.project_id) throw Error('开发任务与功能走读不属于同一工程');
    if (scene.archived || this.store.get<Feature>('feature', scene.feature_id).archived) throw Error('请先恢复已归档功能或场景');
    if (typeof submissionKey !== 'string' || !/^[\w-]{8,100}$/.test(submissionKey)) throw Error('提交幂等键无效');
    const mode = task.execution_mode ?? (task.analysis_channel === 'dsh' ? 'dsh' : 'codex');
    if (enableExternal) await enableExternal(mode, task.project_id);
    if (task.reading?.scenario_id === scenarioId) return this.refreshTaskWalkthrough(taskId, submissionKey);
    const key = `${taskId}/${scenarioId}`;
    if (this.featureRefreshState(taskId, scenarioId)?.refreshing) return;
    this.featureRefreshes.set(key, {refreshing: true});
    this.changed();
    try {
      const previous = previousFeatureResultId(this.store, task, scenarioId);
      const sourceSnapshotId = task.end_state?.snapshot_id ?? (await this.refresh(task.project_id)).source_snapshot_id;
      const run = await this.startRun(scenarioId, mode, submissionKey, undefined, {
        sourceSnapshotId, refreshFromResultId: previous, featureRefreshTaskId: taskId,
      });
      this.featureRefreshes.delete(key);
      void this.executing.get(run.binding.run_id)?.finally(() => this.changed());
    } catch (error) {
      if (this.latestFeatureRefreshRun(taskId, scenarioId)?.submission_key === submissionKey) this.featureRefreshes.delete(key);
      else this.featureRefreshes.set(key, {refreshing: false, error: redact((error as Error).message)});
      throw error;
    } finally {
      this.changed();
    }
  }

  trackExternalWalkthrough(runId: string) {
    this.walkthroughs.trackExternal(runId);
  }

  finishExternalWalkthrough(runId: string) {
    this.walkthroughs.finishExternal(runId);
  }

  researchOverview(resultId: string, submissionKey: string): Promise<Run> {
    return this.overviews.researchOverview(resultId, submissionKey);
  }

  checkOverviewChild(run: Run) {
    this.overviews.checkChild(run);
  }

  private fail(runId: string, error: unknown) {
    this.active.delete(runId);
    const run = this.store.get<Run>('run', runId);
    if (terminalRunStatuses.has(run.status)) return;
    run.status = (error as any)?.remoteUnknown ? 'unknown' : 'failed';
    run.error = redact((error as Error).message);
    run.ended_at = now();
    this.store.put('run', runId, run);
    this.changed();
  }

  event(runId: string, event: any, eventId?: string, sequence?: number) {
    const run = this.store.get<Run>('run', runId);
    const seq = sequence ?? this.store.nextSequence(runId);
    const clean = JSON.parse(redact(JSON.stringify(event)));
    if (!this.store.event(runId, eventId || `${runId}:${seq}`, seq, { sequence: seq, received_at: now(), ...clean })) return;
    if (terminalRunStatuses.has(run.status)) return;
    if (typeof event.thread_id === 'string') run.external_id = event.thread_id;
    this.store.put('run', runId, run);
    this.emit({ type: 'run_event', run_id: runId, event: clean });
  }

  private localResultStopped(run: Run) {
    if (run.status === 'unknown') throw Object.assign(Error('分析停止状态未确认，迟到结果不发布'), { remoteUnknown: true });
    if (run.status === 'cancel_requested' || (this.closing && !terminalRunStatuses.has(run.status))) {
      run.status = 'cancelled';
      run.ended_at = now();
      run.error = '已确认本地进程退出；保留此前事件及原始部分。';
      this.store.put('run', run.binding.run_id, run);
      this.changed();
    }
    return terminalRunStatuses.has(run.status);
  }

  private async acquireLocalSlot(run: Run): Promise<boolean> {
    if (this.localSlotsInUse < 2) {
      this.localSlotsInUse++;
      return true;
    }
    return new Promise(resolve => {
      this.localWaiters.set(run.binding.run_id, {
        priority: !!(run.overview_format || run.reading_question_id),
        resume: resolve,
      });
    });
  }

  private releaseLocalSlot() {
    const next = [...this.localWaiters].find(([, waiter]) => waiter.priority) ?? this.localWaiters.entries().next().value;
    if (next && !this.closing) {
      const [runId, waiter] = next;
      this.localWaiters.delete(runId);
      waiter.resume(true);
    } else {
      this.localSlotsInUse--;
    }
  }

  private async execute(initial: Run) {
    if (!await this.acquireLocalSlot(initial)) return;
    const runId = initial.binding.run_id;
    try {
      if (this.closing) {
        await this.cancel(runId);
        return;
      }
      if (this.store.get<Run>('run', runId).status !== 'queued') return;
      if (!initial.reading_question_id) {
        initial.execution_started_at = now();
        this.store.put('run', runId, initial);
      }
      await this.executeLocal(initial);
    } finally {
      this.releaseLocalSlot();
    }
  }

  private async executeLocal(initial: Run) {
    this.checkOverviewChild(initial);
    const runId = initial.binding.run_id;
    const provider = initial.provider_id;
    if (provider !== 'codex' && provider !== 'dsh') throw Error('本机执行引擎不受支持');
    const product = provider === 'dsh' ? 'DSH Web' : 'Codex';
    let profile = this.store.maybe<ProviderProfile>('provider', provider);
    const profileAge = Date.now() - Date.parse(profile?.checked_at || '');
    if (!Number.isFinite(profileAge) || profileAge < 0 || profileAge > 5 * 60 * 1000 || provider === 'dsh' && profile?.transport !== 'dsh web') {
      this.event(runId, { type: 'local.stage', stage: 'checking_provider', message: `正在检测 ${product} 程序与登录状态` });
      let probe = this.checkingProviders.get(provider);
      if (!probe) {
        probe = this.probe(undefined, provider).finally(() => this.checkingProviders.delete(provider));
        this.checkingProviders.set(provider, probe);
      }
      await probe;
      profile = this.store.get('provider', provider);
    }

    const freshRun = this.store.get<Run>('run', runId);
    if (freshRun.status === 'cancelled' || this.closing) return;
    if (!profile || profile.status !== 'available') {
      freshRun.status = 'blocked_external';
      freshRun.error = profile?.reason || `缺少受支持的 ${product} 执行通道`;
      freshRun.ended_at = now();
      this.store.put('run', runId, freshRun);
      this.changed();
      return;
    }

    const snapshot = this.store.get<Snapshot>('snapshot', initial.binding.source_snapshot_id);
    const limits = readingLimits(initial, snapshot);
    this.event(runId, { type: 'local.stage', stage: 'analysis_budget', message:
      `${limits.label}总时限 ${limits.total} 分钟` +
      (limits.discovery && !initial.overview_from_result_id ? `，首次源码取证最多 ${limits.discovery} 分钟` : '') +
      (limits.idle ? `，连续 ${limits.idle} 分钟无工作进度会停止。` : '。') });
    if (initial.overview_from_result_id) {
      const inherited = await this.overviews.savedOverviewDraft(initial, snapshot);
      const checked = await this.overviews.finishOverview(initial, snapshot, profile, inherited.draft, inherited.review);
      await this.acceptResult(runId, checked.result, checked.semantic);
      return;
    }

    const { annotations, previous, catalogFeature } = this.analysisHistory(initial);
    const scenario = this.store.get<Scenario>('scenario', initial.binding.scenario_id);
    const featureDetail = !initial.overview_format && !initial.reading_question_id &&
      (scenario.kind === 'feature_overview' || scenario.kind === 'breakdown');
    if (featureDetail) {
      freshRun.feature_graph_format = 'feature-graph-1';
      this.store.put('run', runId, freshRun);
    }
    let prompt = await makePrompt(initial, snapshot, this.directory, annotations, previous, featureDetail, catalogFeature);
    const retry = provider === 'codex' && initial.overview_format ? this.overviews.retrySource(initial) : undefined;
    let savedCandidate: string | undefined;
    let inheritedEvidence = false;
    if (retry) {
      freshRun.previous_run_id = retry.binding.run_id;
      this.store.put('run', runId, freshRun);
      if (retry.overview_candidate_ready) {
        savedCandidate = await fs.readFile(retry.output_path, 'utf8');
        await fs.mkdir(path.dirname(initial.output_path), { recursive: true });
        await fs.writeFile(initial.output_path, savedCandidate);
        this.event(runId, { type: 'local.stage', stage: 'overview_resume', message: '已恢复同一冻结快照的草稿，正在重新校验并独立复核。' });
      } else {
        const excerpts = await this.overviews.readExcerpts(retry.binding.run_id, snapshot);
        if (excerpts.length) {
          inheritedEvidence = true;
          prompt += '\n上次在同一快照已读的源码节选，可直接引用，按需补查。start 为首行号，长行及末尾可能截短：' + JSON.stringify(excerpts);
          this.event(runId, { type: 'local.stage', stage: 'overview_resume', message: `已恢复上次读取的 ${excerpts.length} 个文件的冻结源码节选。` });
        }
      }
    }
    this.event(runId, { type: 'local.stage', stage: 'launching', message: `只读任务已准备，正在启动 ${product}` });
    if (this.store.get<Run>('run', runId).status === 'cancelled' || this.closing) return;
    this.checkOverviewChild(initial);
    if (this.closing || this.store.get<Run>('run', runId).status !== 'queued') return;

    const canStart = (status: 'queued' | 'validating') =>
      !this.closing && this.store.get<Run>('run', runId).status === status;
    const started = (active: ActiveProcess, status: 'queued' | 'validating') => {
      this.active.set(runId, active);
      if (!canStart(status)) {
        void active.cancel().catch(error => {
          const latest = this.store.get<Run>('run', runId);
          latest.status = 'unknown';
          latest.error = `启动期间收到停止请求，但未能确认进程退出：${redact((error as Error).message)}`;
          this.store.put('run', runId, latest);
          this.changed();
        });
        return;
      }
      const run = this.store.get<Run>('run', runId);
      if (status === 'queued') run.status = 'running';
      run.pid = active.child.pid;
      run.runtime_version = profile!.version;
      this.store.put('run', runId, run);
      this.changed();
    };
    const options: Parameters<typeof runCodex>[0] = {
      run: initial,
      preferences: this.store.codexPreferences(),
      snapshot,
      storage: this.directory,
      resources: this.resources,
      profile,
      prompt,
      ...(featureDetail ? { outputSchema: featureGraphSchema } : {}),
      event: event => this.event(runId, event),
      shouldStart: () => canStart('queued'),
      started: active => started(active, 'queued'),
    };
    let candidatePath = initial.output_path;
    let result = savedCandidate !== undefined ? { code: 0, raw: savedCandidate, stderr: '' } : provider === 'dsh'
      ? await this.dshRunner({ ...options, discovery: !!initial.overview_format, outputSchema: options.outputSchema ?? (initial.reading_question_id ? readingAnswerSchema : initial.overview_format ? overviewSchema : schema) })
      : await this.codexRunner(options);
    this.active.delete(runId);

    let run = this.store.get<Run>('run', runId);
    if (this.localResultStopped(run)) return;
    if (initial.overview_format && 'timeout' in result && (result.timeout === 'idle' || result.timeout === 'discovery') &&
        Date.now() < Date.parse(initial.execution_started_at!) + (limits.total - 1) * 60000) {
      const excerpts = await this.overviews.readExcerpts(runId, snapshot);
      if (excerpts.length || inheritedEvidence) {
        run = this.store.get<Run>('run', runId);
        if (this.localResultStopped(run)) return;
        run.status = 'validating';
        this.store.put('run', runId, run);
        this.event(runId, { type: 'local.stage', stage: 'overview_synthesis', message: '取证阶段已停止，正在用已读源码生成首轮草稿，随后独立复核。' });
        const directory = path.join(path.dirname(initial.output_path), 'synthesis');
        candidatePath = path.join(directory, 'result.json');
        result = await this.codexRunner({
          ...options, overviewSynthesis: true, outputDirectory: directory, outputPath: candidatePath,
          prompt: prompt + '\n取证已结束，工具已关闭。仅用本任务提供的已读冻结源码生成完整 JSON，缺口写入 unresolved。start 为首行号，长行及末尾可能截短。\n' + JSON.stringify(excerpts),
          shouldStart: () => canStart('validating'), started: active => started(active, 'validating'),
        });
        this.active.delete(runId);
        run = this.store.get<Run>('run', runId);
        if (this.localResultStopped(run)) return;
      }
    }
    const protocolError = 'protocol_error' in result ? result.protocol_error : undefined;
    if (result.code !== 0 || protocolError) {
      throw new Error(`${initial.provider_id} 未成功完成（exit=${result.code}）：${protocolError || result.stderr.slice(-2500)}`);
    }

    const normalizeReply = (reply: unknown) => {
      // The compact graph requires literal nulls (e.g. unconditional calls).
      if (featureDetail) return reply;
      const audit: string[] = [];
      const value = normalizeTransport(reply, audit);
      if (audit.length) this.event(runId, { type: 'local.format_normalization', changes: audit });
      return value;
    };
    let value: unknown;
    try {
      value = normalizeReply(provider === 'dsh' ? parseDshReply(result.raw) : parseJsonReply(result.raw));
    } catch {
      throw new Error('真实返回不是合法 JSON，原始文件已保留；未生成正式关系图。');
    }

    const repairValidation = async (repairPrompt: string, outputSchema?: object) => {
      const outputDirectory = path.join(this.directory, 'runs', runId, 'repair');
      try {
        const repair = await this.codexRunner({
          ...options,
          prompt: repairPrompt,
          reasoningEffort: 'low',
          outputDirectory,
          outputPath: path.join(outputDirectory, 'result.json'),
          ...(outputSchema ? { outputSchema } : {}),
          shouldStart: () => canStart('validating'),
          started: active => started(active, 'validating'),
        });
        if (repair.code !== 0 || repair.protocol_error) {
          throw Error(`Codex 未成功完成修正（exit=${repair.code}）：${repair.protocol_error || repair.stderr.slice(-2500)}`);
        }
        return normalizeReply(parseJsonReply(repair.raw));
      } finally {
        this.active.delete(runId);
      }
    };

    let semanticReview: string | undefined;
    if (initial.overview_format || featureDetail) {
      run.status = 'validating';
      this.store.put('run', runId, run);
      this.changed();
      const prepare = async (raw: unknown) => {
        const audit: string[] = [];
        const draft = featureDetail
          ? await prepareFeatureGraph(raw, run, snapshot, this.directory, audit)
          : await prepareOverview(raw, initial, snapshot, this.directory, audit);
        if (audit.length) this.event(runId, { type: 'local.format_normalization', changes: audit });
        return draft;
      };
      let draft: AnalysisResult;
      try {
        draft = await prepare(value);
      } catch (error) {
        if (provider !== 'codex' || !(error instanceof OverviewValidationError)) throw error;
        if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
        const format = featureDetail ? 'feature-graph-1' : '工程全貌';
        this.event(runId, { type: 'local.stage', stage: 'repairing_validation', message: `${format} 校验发现偏差，正在让 Codex 定向修正（最多 1 轮）` });
        if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
        const repairPrompt = [
          `只修正以下 ARC 校验错误，输出完整、符合 ${format} Schema 的 JSON。`,
          error.message,
          `每条 evidence 的 start..end（对应 line_start..line_end）必须是有效源码行，含首尾最多 ${maxCompactEvidenceLines} 行。可只给行号或提供该范围内的单行短锚点 quote。用 arc_read_source / arc_list_files 核对源码。`,
          '上一轮草稿 JSON：',
          JSON.stringify(value),
        ].join('\n');
        let repairedValue: unknown;
        try {
          repairedValue = await repairValidation(repairPrompt, featureDetail ? featureGraphSchema : overviewSchema);
        } catch (repairError) {
          if ((repairError as { remoteUnknown?: boolean })?.remoteUnknown) throw repairError;
          if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
          throw repairError;
        }
        if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
        draft = await prepare(repairedValue);
        candidatePath = path.join(this.directory, 'runs', runId, 'repair', 'result.json');
      }
      if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
      if (initial.overview_format) {
        if (provider === 'codex') {
          const current = this.store.get<Run>('run', runId);
          current.overview_candidate_ready = true;
          current.output_path = candidatePath;
          this.store.put('run', runId, current);
        }
        const checked = await this.overviews.finishOverview(initial, snapshot, profile, draft);
        value = checked.result;
        semanticReview = checked.semantic;
      } else {
        value = draft;
      }
    } else if (provider === 'codex') {
      const report = await this.validateRunResult(run, value, snapshot);
      if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
      if (report.errors.length) {
        this.event(runId, { type: 'local.stage', stage: 'repairing_validation', message: `校验发现 ${report.errors.length} 处偏差，正在让 Codex 定向修正（最多 1 轮）` });
        if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
        const repairPrompt = [
          '只修正以下 ARC 校验错误，保留草稿中的其他内容。需要核对文件路径、行号或 SHA-256 时，使用 arc_read_source / arc_list_files。',
          '不要把同一函数内的步骤编造为跨函数调用。输出完整、符合当前 Schema 的 JSON。',
          ...report.errors.slice(0, 15).map(error => `- ${error}`),
          '上一轮草稿 JSON：',
          JSON.stringify(value),
        ].join('\n');
        let repairedValue: unknown;
        try {
          repairedValue = await repairValidation(repairPrompt);
        } catch (error) {
          if ((error as { remoteUnknown?: boolean })?.remoteUnknown) throw error;
          if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
          this.event(runId, { type: 'local.stage', stage: 'repair_failed', message: `Codex 定向修正失败：${(error as Error).message}` });
        }
        if (this.localResultStopped(this.store.get<Run>('run', runId))) return;
        if (repairedValue !== undefined) {
          await this.acceptResult(runId, repairedValue);
          return;
        }
      }
      await this.acceptValidatedResult(runId, value, report, true);
      return;
    }
    await this.acceptResult(runId, value, semanticReview);
  }

  async acceptResult(runId: string, value: unknown, semanticReview?: string, allowFollowups = true) {
    const run = this.store.get<Run>('run', runId);
    const snapshot = this.store.get<Snapshot>('snapshot', run.binding.source_snapshot_id);
    if (run.overview_format && !semanticReview) throw new Error('首轮工程图尚未完成独立关系复核，不能发布');
    if (['cancel_requested', 'cancelled', 'failed'].includes(run.status)) throw new Error('终止后的迟到结果保留为原始材料，不发布为新说明');
    if (run.status === 'completed') return run;

    const report = await this.validateRunResult(run, value, snapshot);
    if (semanticReview) report.semantic = semanticReview;
    return this.acceptValidatedResult(runId, value, report, allowFollowups);
  }

  private async validateRunResult(run: Run, value: unknown, snapshot: Snapshot) {
    const runId = run.binding.run_id;
    run.status = 'validating';
    this.store.put('run', runId, run);
    this.event(runId, { type: 'local.stage', stage: 'validating', message: '完整结果已收到，正在校验结构、任务绑定和源码行号' });
    this.changed();

    return run.reading_question_id
      ? validateReadingAnswer(value, run, snapshot, this.directory)
      : validateResult(value, run, snapshot, this.directory);
  }

  private async acceptValidatedResult(runId: string, value: unknown, report: Awaited<ReturnType<typeof validateResult>>, allowFollowups: boolean) {
    const run = this.store.get<Run>('run', runId);
    if (run.status === 'completed') return run;
    if (['cancel_requested', 'cancelled', 'failed'].includes(run.status)) throw new Error('校验期间收到停止请求，迟到结果不发布');
    run.validation = report;
    if (report.errors.length) {
      run.status = 'failed';
      run.error = `结果校验失败：${report.errors.slice(0, 5).join('；')}`;
      run.ended_at = now();
      this.store.put('run', runId, run);
      this.changed();
      return run;
    }

    if (run.reading_question_id) {
      const question = this.store.get<ReadingQuestion>('reading_question', run.reading_question_id);
      if (question.run_id !== runId) throw Error('此运行已被新的重试替代，结果保留为历史材料');
      question.answer = value as ReadingAnswer;
      this.store.transaction(() => {
        run.status = 'completed';
        run.ended_at = now();
        this.store.put('reading_question', question.question_id, question);
        this.store.put('run', runId, run);
      });
      this.changed();
      return run;
    }

    const result = value as AnalysisResult;
    const existing = this.store.maybe<Explanation>('explanation', result.result_id);
    if (existing) {
      if (existing.result.binding.run_id === runId) return this.store.get<Run>('run', runId);
      throw new Error('结果 ID 与另一个运行冲突');
    }

    let checked: ProjectFreshness | undefined;
    try {
      checked = await this.checkFreshness(run.binding.project_id);
    } catch (error) {
      this.event(runId, { type: 'source.check_failed', reason: (error as Error).message });
    }
    const latest = this.store.get<Run>('run', runId);
    if (latest.status === 'completed') return latest;
    if (['cancel_requested', 'cancelled', 'failed'].includes(latest.status)) throw new Error('来源复核期间收到停止请求，迟到结果不发布');

    const project = this.store.get<Project>('project', run.binding.project_id);
    const current = this.store.get<Snapshot>('snapshot', project.snapshot_id);
    const explanation: Explanation = {
      result_id: result.result_id,
      scenario_id: run.binding.scenario_id,
      created_at: now(),
      source_status: 'needs_review',
      result,
    };
    explanation.source_status = this.explanationSourceStatus(explanation, current,
      checked?.snapshot_id === project.snapshot_id ? checked.changed_files : undefined);
    const children = this.store.transaction(() => {
      run.status = 'completed';
      run.ended_at = now();
      this.store.put('explanation', result.result_id, explanation);
      this.store.put('run', runId, run);
      return allowFollowups ? this.overviews.prepareChildren(run, explanation, project) : [];
    });
    this.overviews.launchChildren(run, children);
    this.changed();
    return run;
  }

  async revalidate(runId: string) {
    const run = this.store.get<Run>('run', runId);
    if (run.overview_format) throw new Error('首轮分析需要完成源码校验和独立关系复核；请重新分析，不能将未复核的原始草稿直接发布。');
    if ((run.provider_id !== 'codex' && run.execution_mode !== 'dsh') || run.dsh_overview_format || run.dsh_function_format) {
      throw new Error('历史运行格式仅作只读保留，请重新分析。');
    }
    if (run.status !== 'failed' || this.active.has(runId)) throw new Error('仅可重新校验已失败且已停止的原始返回');
    const raw = await fs.readFile(run.output_path, 'utf8');
    const audit: string[] = [];
    const reply = run.execution_mode === 'dsh' ? parseDshReply(raw) : parseJsonReply(raw);
    const parsed = run.feature_graph_format ? reply : normalizeTransport(reply, audit);
    this.event(runId, {
      type: 'local.revalidation',
      reason: '重新校验首轮已保存原文，未派发外部请求',
      attempt: 0,
      reply_sha256: sha(raw),
      previous_error: run.error,
      format_normalization: audit,
    });
    run.status = 'validating';
    run.error = undefined;
    this.store.put('run', runId, run);
    try {
      const value = run.feature_graph_format
        ? await prepareFeatureGraph(parsed, run, this.store.get('snapshot', run.binding.source_snapshot_id), this.directory, audit)
        : parsed;
      if (run.feature_graph_format && audit.length) this.event(runId, { type: 'local.format_normalization', changes: audit });
      return await this.acceptResult(runId, value, undefined, false);
    } catch (e) {
      this.fail(runId, e);
      throw e;
    }
  }

  async cancel(runId: string) {
    const run = this.store.get<Run>('run', runId);
    const waiter = this.localWaiters.get(runId);
    if (waiter) {
      this.localWaiters.delete(runId);
      waiter.resume(false);
    }
    if (terminalRunStatuses.has(run.status)) return run;
    const active = this.active.get(runId);
    if (run.origin === 'mcp') {
      if (run.feature_refresh_task_id && this.store.maybe('setting', 'mcp-requested-analysis')?.feature_refresh_run_id === runId) {
        this.store.put('setting', 'mcp-requested-analysis', null);
      }
      run.status = 'cancelled';
      run.ended_at = now();
      run.error = 'Arc 已撤销本次任务的读取和结果写回权限；Agent 对话不会被远程停止，请在 Agent 中停止生成。';
      this.store.put('run', runId, run);
      this.finishExternalWalkthrough(runId);
      this.changed();
      return run;
    }
    if (run.status === 'validating' && !active) {
      run.status = 'cancelled';
      run.ended_at = now();
      run.error = '本地结果校验已取消，未发布正式说明';
      this.store.put('run', runId, run);
      this.changed();
      return run;
    }
    if (run.status === 'queued' && !active) {
      run.status = 'cancelled';
      run.ended_at = now();
      run.error = '任务尚未启动，已取消';
      this.store.put('run', runId, run);
      this.changed();
      return run;
    }
    if (!active) throw new Error('无法确认此运行的本地进程；状态未知，不冒充远端停止。');
    run.status = 'cancel_requested';
    this.store.put('run', runId, run);
    this.changed();
    try {
      await active.cancel();
    } catch (e) {
      run.status = 'unknown';
      run.error = redact((e as Error).message);
      this.store.put('run', runId, run);
      this.changed();
    }
    return run;
  }

  loadDemo() {
    return loadDemoProject(this);
  }

  exportProject(projectId: string, file: string) {
    return exportProjectBundle(this, projectId, file);
  }

  importResult(scenarioId: string, file: string) {
    return importAnalysisResult(this, scenarioId, file);
  }

  async shutdown() {
    this.closing = true;
    for (const controller of this.breakdowns.values()) controller.abort();
    for (const run of this.store.all<Run>('run')) this.overviews.cancelUnstartedChild(run);
    await this.development.shutdown();
    for (const controller of this.indexing.values()) controller.abort();
    await Promise.allSettled([...this.executing.keys()].map(k => this.cancel(k)));
    // Wait for real terminal events before the SQLite connection is closed.
    const pending = Promise.allSettled([...this.executing.values(), ...this.breakdowns.keys()]);
    const timer = setTimeout(() => {
      for (const [runId, active] of this.active) {
        this.event(runId, { type: 'shutdown.local_disconnect', reason: '退出等待超过 12 秒；关闭自有子进程，远端终态以协议记录为准' });
        void stopTree(active.child).catch(() => {});
      }
    }, 12000);
    await pending;
    await this.overviews.waitQueue();
    clearTimeout(timer);
    await this.walkthroughs.shutdown();
    await Promise.allSettled(this.checkingFreshness.values());
    while (this.indexing.size) await new Promise(resolve => setTimeout(resolve, 20));
    setDefaultExecutableOverrides({});
  }
}
