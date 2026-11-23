import React, { useMemo, useState } from 'react';
import type {
  AnalysisResult,
  Explanation,
  Feature,
  Project,
  ReadingState,
  Run,
  Scenario,
  Snapshot,
  SourceEvidence,
  WorkspaceData,
} from '../shared';
import type { ExplanationFreshness } from '../freshness';
import { FunctionChain } from './FunctionChain';
import { Graph } from './Graph';
import { FeatureCatalog, CatalogFeatureReading } from './FeatureCatalog';
import { Architecture } from './Architecture';
import type { TaskArchitectureOverlay } from './DevelopmentHud';
import { ZoomSurface } from './ZoomSurface';
import { Timeline } from './Timeline';
import { FeatureReading } from './FeatureReading';
import { Composition } from './Composition';
import { FileMap } from './FileMap';
import { analyzedSourcePaths } from './file-map';
import { clampZoom } from './zoom';
import { functionPathPosition } from './feature-reading-model';
import type { AnalysisMode } from './discovery-state';
import { runEngineName } from './activity';
import { ScrollPanel } from './workbench-primitives';

export interface CanvasPaneProps {
  freshness?: ExplanationFreshness;
  refreshAndAnalyze: () => void;
  data: WorkspaceData;
  project?: Project;
  projectId: string;
  scenario?: Scenario;
  snapshot?: Snapshot;
  sourceSnapshot?: Snapshot;
  reading: ReadingState;
  showModeSwitch?: boolean;
  setReading: React.Dispatch<React.SetStateAction<ReadingState>>;
  patch: (value: Partial<ReadingState>) => void;
  loadedKey: string;
  search: string;
  setSearch: (value: string) => void;
  pending: boolean;
  indexes: Record<string, any>;
  expandMode: AnalysisMode;
  catalogReading: boolean;
  catalogExplanation?: Explanation;
  capabilityCount: number;
  featureReading: boolean;
  readingGuide: any;
  featurePurpose?: string;
  explanation?: Explanation;
  result?: AnalysisResult;
  overviewRun?: Run;
  overviewSections?: React.ReactNode;
  discovery?: Feature['discovery'];
  graphCatalog?: Explanation;
  featureSource?: Explanation;
  preview: any;
  graphActions: React.ReactNode;
  selectedFile: string;
  waitingMcp: boolean;
  running?: Run;
  latestRun?: Run;
  savePosition: (name: string, top: number, left: number) => void;
  openCapability: (id: string) => Promise<void>;
  addFeatureFromScope: (item: string) => void;
  fillPending: (nodeIds: string[]) => Promise<void>;
  cancelQueued: (runIds: string[]) => void;
  requestAnalysis: (overview?: boolean, refreshFirst?: boolean) => Promise<void>;
  readingPath: (pathId: string) => void;
  selectReading: (id: string) => void;
  navigateFeature: (view: string) => void;
  readingStep: (stepId: string) => void;
  chooseFile: (file: string, indexSnapshotId?: string) => void;
  select: (id: string) => void;
  switchView: (view: string, overrides?: Partial<ReadingState>) => void;
  navigateView: (view: string) => void;
  inspectComponent: (id: string) => void;
  evidence: (item: SourceEvidence) => void;
  showMcp: () => void;
  taskOverlay?: (TaskArchitectureOverlay & { onClear: () => void; onReturnTask: () => void }) | null;
}

export function CanvasPane({
  data,
  freshness,
  refreshAndAnalyze,
  project,
  projectId,
  scenario,
  snapshot,
  sourceSnapshot,
  reading,
  showModeSwitch,
  setReading,
  patch,
  loadedKey,
  search,
  setSearch,
  pending,
  indexes,
  expandMode,
  catalogReading,
  catalogExplanation,
  capabilityCount,
  featureReading,
  readingGuide,
  featurePurpose,
  explanation,
  result,
  overviewRun,
  overviewSections,
  discovery,
  graphCatalog,
  featureSource,
  preview,
  graphActions,
  selectedFile,
  waitingMcp,
  running,
  latestRun,
  savePosition,
  openCapability,
  addFeatureFromScope,
  fillPending,
  cancelQueued,
  requestAnalysis,
  readingPath,
  selectReading,
  navigateFeature,
  readingStep,
  chooseFile,
  select,
  switchView,
  navigateView,
  inspectComponent,
  evidence,
  showMcp,
  taskOverlay,
}: CanvasPaneProps) {
  const [archZoomable, setArchZoomable] = useState(true);
  const isCatalogDetail = !catalogReading && !!graphCatalog && !!discovery && !!project;
  const archNonZoomable = !featureReading && ['system', 'map'].includes(reading.view) && !archZoomable;
  const featureNonZoomable = featureReading && reading.view !== 'timeline';
  const hasZoomableContent = (featureReading && !!result && !!readingGuide)
    || (!featureReading && reading.view === 'files' && !!sourceSnapshot)
    || (!featureReading && reading.view !== 'files' && !!result);
  const showZoomFloat = !preview && !catalogReading && !isCatalogDetail && hasZoomableContent && !archNonZoomable && !featureNonZoomable;
  const fileSnapshotId = reading.view === 'files' && !featureReading ? sourceSnapshot?.source_snapshot_id : undefined;
  const analyzedPaths = useMemo(
    () => analyzedSourcePaths(data.explanations, projectId, fileSnapshotId, result),
    [data.explanations, projectId, fileSnapshotId, result],
  );
  const filters =
    featureReading || (reading.entrance === 'walk' && reading.view === 'functions') ? (
      <div className="fr-reader-search">
        <input
          type="search"
          aria-label={reading.view === 'files' ? '搜索本功能文件' : '搜索当前走读'}
          placeholder={reading.view === 'files' ? '查找文件名或职责…' : '查找当前走读内容…'}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && <button onClick={() => setSearch('')}>清除</button>}
      </div>
    ) : (
      <details className="canvas-filter" open={!!search || undefined}>
        <summary>搜索与筛选</summary>
        <div className="filter-row">
          <input
            aria-label="搜索节点或文件"
            placeholder={
              reading.view === 'files' ? '搜索真实文件…'
                : ['system', 'map'].includes(reading.view) ? '搜索当前架构视图…' : '搜索节点、职责…'
            }
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button onClick={() => setSearch('')}>清除</button>}
          {result && ['flow', 'sequence'].includes(reading.view) && (
            <select aria-label="阶段筛选" value={reading.stage} onChange={e => patch({ stage: e.target.value })}>
              <option value="">全部阶段 / 上下文</option>
              {result.nodes
                .filter(n => result.nodes.some(c => c.parent_node_id === n.node_id))
                .map(n => (
                  <option key={n.node_id} value={n.node_id}>
                    内部：{n.label}
                  </option>
                ))}
              {[...new Set(result.nodes.map(n => n.execution_context.label))].map(v => (
                <option key={v}>{v}</option>
              ))}
            </select>
          )}
        </div>
      </details>
    );

  const toggleExpanded = (id: string) =>
    patch({ expanded: reading.expanded.includes(id) ? reading.expanded.filter(x => x !== id) : [...reading.expanded, id] });

  return (
    <main className={overviewSections ? 'canvas overview-canvas' : 'canvas'}>
      {freshness?.kind === 'affected' && (
        <div className="freshness-banner affected" role="status">
          <span>外部代码已变更（{freshness.files.slice(0, 3).join('、')}{freshness.files.length > 3 && ` 等 ${freshness.files.length} 个文件`}）· 当前展示为旧快照，非最新代码</span>
          <button disabled={pending || !!indexes[projectId] || !!running || !!project?.fictional || scenario?.archived} onClick={refreshAndAnalyze}>
            {reading.entrance === 'overview' ? '刷新快照并重析工程' : '刷新快照并重析此功能'}
          </button>
        </div>
      )}
      {!preview && !catalogReading && (
        <div className="canvas-tools">
          <div className={'row' + (reading.entrance === 'walk' ? ' fr-toolbar' : '')}>
            <span className="eyebrow">{reading.entrance === 'overview' ? '工程全貌' : '功能走读'}</span>
            {result && (
              <span className="tag">
                {data.runs.find(r => r.binding.run_id === result.binding.run_id)?.origin === 'manual_import'
                  ? '手动导入 · 非联调'
                  : result.fictional
                    ? '演示'
                    : '真实返回'}{' '}
                · {result.gaps.length ? '部分覆盖' : '已返回说明'}
              </span>
            )}
            {filters}
          </div>
        </div>
      )}

      <ScrollPanel positions={reading.scroll} restoreKey={loadedKey + ':' + (result?.result_id || '')} onPosition={savePosition} name={`canvas-${reading.view}`}>
        {catalogReading ? (
          <FeatureCatalog
            explanation={catalogExplanation}
            data={data}
            projectId={projectId}
            busy={pending || !!indexes[projectId] || !!project?.fictional}
            open={id => void openCapability(id)}
            addFeatureFromScope={addFeatureFromScope}
            fillPending={ids => void fillPending(ids)}
            cancelQueued={cancelQueued}
            discover={() => void requestAnalysis(true, true)}
            mode={expandMode}
          />
        ) : graphCatalog && discovery && project ? (
          <CatalogFeatureReading
            key={graphCatalog.result_id + '/' + discovery.node_id}
            explanation={graphCatalog}
            nodeId={discovery.node_id}
            currentSnapshot={project.snapshot_id}
            sourceId={reading.evidence_id}
            onSource={evidence_id => patch({ evidence_id })}
          />
        ) : preview && featureSource ? (
          <CatalogFeatureReading
            functionActions={graphActions}
            key={featureSource.result_id + '/' + preview.node_id}
            explanation={featureSource}
            nodeId={preview.node_id}
            currentSnapshot={project!.snapshot_id}
            sourceId={reading.evidence_id}
            onSource={evidence_id => patch({ evidence_id })}
          />
        ) : featureReading && result && readingGuide ? (
          <ZoomSurface reflow zoom={reading.zoom} change={zoom => patch({ zoom })}>
            <FeatureReading
              zoom={reading.zoom}
              result={result}
              guide={readingGuide}
              view={reading.view}
              pathId={reading.reading_path || ''}
              selected={reading.selected}
              focus={reading.reading_focus || ''}
              search={search}
              onPath={readingPath}
              onSelect={selectReading}
              onNavigate={navigateFeature}
              onStep={readingStep}
            />
          </ZoomSurface>
        ) : featureReading && reading.view === 'files' ? (
          <section className="fr-empty">
            <h2>当前功能尚未有相关文件说明</h2>
            <p>完成分析后，这里只列本功能引用的文件及其用途。</p>
            <button onClick={() => navigateFeature('timeline')}>返回业务流程</button>
          </section>
        ) : reading.view === 'files' && sourceSnapshot ? (
          <ZoomSurface reflow zoom={reading.zoom} change={zoom => patch({ zoom })}>
            <FileMap
              files={sourceSnapshot.files}
              analyzedPaths={analyzedPaths}
              title={project?.name || '当前工程'}
              selected={selectedFile}
              select={chooseFile}
              expanded={reading.expanded}
              toggle={toggleExpanded}
              zoom={reading.zoom}
              search={search}
            />
          </ZoomSurface>
        ) : result ? (
          <ZoomSurface
            reflow={['system', 'map', 'timeline', 'composition', 'topicmap', 'modules', 'dependencies', 'functions'].includes(reading.view)}
            zoom={reading.zoom}
            change={zoom => patch({ zoom })}
          >
            {['topicmap', 'modules', 'dependencies'].includes(reading.view) && (
              <Composition
                result={result}
                variant={reading.view === 'dependencies' ? 'dependencies' : reading.view === 'modules' ? 'modules' : 'analysis'}
                focus={reading.view === 'modules' ? reading.stage : undefined}
                title={
                  reading.view === 'topicmap'
                    ? scenario?.kind === 'feature_overview'
                      ? data.features.find(f => f.feature_id === scenario.feature_id)?.name || scenario.title
                      : scenario?.title || '当前说明'
                    : project?.name || '当前工程'
                }
                selected={reading.selected}
                select={select}
                zoom={reading.zoom}
                search={search}
                expanded={reading.expanded}
                toggle={toggleExpanded}
                architecture={() => switchView('system')}
                dependencies={reading.entrance === 'overview' ? undefined : () => switchView('dependencies')}
              />
            )}
            {reading.view === 'composition' && (
              <Composition
                result={result}
                title={project?.name || '当前工程'}
                selected={reading.selected}
                select={select}
                zoom={reading.zoom}
                search={search}
                expanded={reading.expanded}
                toggle={toggleExpanded}
                architecture={() => switchView('system')}
                dependencies={() => switchView('dependencies')}
              />
            )}
            {['system', 'map'].includes(reading.view) && (
              <>
                <Architecture
                  key={result.result_id}
                  result={result}
                  selected={reading.selected}
                  select={select}
                  zoom={reading.zoom}
                  search={search}
                  modules={() => switchView('modules', { stage: '' })}
                  inspect={inspectComponent}
                  openFile={file => chooseFile(file, result.binding.source_snapshot_id)}
                  taskOverlay={taskOverlay}
                  onZoomableChange={setArchZoomable}
                />
                {!overviewSections && (
                  <div className="overview-feature-entry">
                    <div>
                      <strong>系统有哪些功能</strong>
                      <br />
                      <span>{capabilityCount ? `已发现 ${capabilityCount} 项 · 阅读功能说明` : '在 ARC 内生成目录，再选择功能深入'}</span>
                    </div>
                    <button onClick={() => navigateView('capabilities')}>浏览功能总览</button>
                  </div>
                )}
              </>
            )}
            <details
              className="overview-summary"
              open={!!reading.summary_expanded}
              onToggle={e => {
                if (e.currentTarget.open !== !!reading.summary_expanded) patch({ summary_expanded: e.currentTarget.open });
              }}
              key={reading.view}
            >
              <summary>
                分析说明与覆盖范围
                {explanation?.source_status !== 'current' ? ' · 来源待复核' : ''}
                {result.binding.question_revision_id !== scenario?.question_revision_id ? ' · 历史问题' : ''}
              </summary>
              <div className="summary">
                <span className="eyebrow">当前说明</span>
                <p>{result.summary.text}</p>
                {explanation?.source_status !== 'current' && <span className="warning">来源可能受影响，保留旧解释，需按新来源复核。</span>}
                {result.binding.question_revision_id !== scenario?.question_revision_id && (
                  <p className="warning">这是历史问题的结果；当前新问题尚未由此说明回答。</p>
                )}
              </div>
            </details>
            {reading.view === 'modules' && reading.stage && (
              <button className="architecture-back" onClick={() => switchView('system')}>
                ← 返回系统架构
              </button>
            )}
            {reading.view === 'functions' && (
              <>
                {overviewRun?.validation?.semantic.startsWith('已展示可校验的函数走读。') && (
                  <details className="diagram-scope" aria-label="函数走读校验说明">
                    <summary>部分步骤或引用未通过校验 · 查看详情</summary>
                    <p>{overviewRun.validation.semantic}</p>
                  </details>
                )}
                <FunctionChain
                  graphActions={graphActions}
                  showModeSwitch={showModeSwitch}
                  mode={reading.function_mode || 'calls'}
                  onModeChange={function_mode => patch({ function_mode })}
                  result={result}
                  selected={reading.selected}
                  select={select}
                  zoom={reading.zoom}
                  search={search}
                  pathId={reading.function_path ?? reading.reading_path ?? ''}
                  onPath={(pathId, selected) => {
                    if (reading.entrance === 'walk' && reading.pinned && reading.selected !== selected) {
                      select(selected);
                      return;
                    }
                    setReading(r => functionPathPosition(r, result, pathId, selected));
                  }}
                  evidence={evidence}
                />
              </>
            )}
            {reading.view === 'timeline' && <Timeline result={result} selected={reading.selected} select={select} zoom={reading.zoom} search={search} />}
            {!['system', 'map', 'timeline', 'composition', 'topicmap', 'modules', 'dependencies', 'functions'].includes(reading.view) && (
              <Graph
                result={result}
                selected={reading.selected}
                select={select}
                view={reading.view}
                stage={reading.stage}
                expand={stage => patch({ stage })}
                zoom={reading.zoom}
                search={search}
                scope={reading.graph_scope}
                changeScope={graph_scope => patch({ graph_scope })}
              />
            )}
          </ZoomSurface>
        ) : waitingMcp ? (
          <section className="mcp-waiting" aria-label="等待 Agent 领取">
            <span className="eyebrow">已准备{reading.entrance === 'overview' ? '工程全貌' : '所选功能'} · 尚未开始分析</span>
            <h2>等待 Agent 对话领取</h2>
            <p>{reading.entrance === 'overview' ? `工程：${project?.name}` : `功能：${data.features.find(f => f.feature_id === scenario?.feature_id)?.name || ''}`}</p>
            <ol>
              <li>已绑定当前工程、问题版本和源码快照。</li>
              <li>在接入 ARC MCP 的对话中领取当前分析任务。</li>
              <li>Agent 领取后，这里显示分析进度；结果写回后展示{reading.entrance === 'overview' ? '系统架构' : '流程时间线'}。</li>
            </ol>
            <p className="muted">Arc 不会自动唤醒或切换 Agent 对话，此时还没有模型调用。</p>
            <div className="row">
              <button onClick={showMcp}>查看接入方法</button>
            </div>
          </section>
        ) : (
          <div className="empty">
            <span className="empty-mark">⌘</span>
            <span className="eyebrow">从源码到理解</span>
            <h1>
              {running
                ? running.status === 'waiting_agent'
                  ? '已排队，等待 Codex 领取'
                  : '正在分析工程源码'
                : latestRun?.status === 'failed'
                  ? '这次分析未完成，可重新发起'
                  : reading.entrance === 'overview'
                    ? '工程已就绪，开始分析'
                    : scenario
                      ? '这个问题，等待第一次分析'
                      : '选择一条功能路径'}
            </h1>
            <p>
              {running
                ? (running.status === 'waiting_agent'
                    ? '任务已保存，正在等待绑定会话的实际领取回执。'
                    : running.origin === 'mcp'
                      ? 'Agent 已在外部对话领取任务。'
                      : `${runEngineName(running)} 正在读取冻结源码。`) + '完成后会保存说明与源码依据；你可以继续浏览。'
                : latestRun?.status === 'failed'
                  ? '在右侧“分析进度”查看原因并重试，已有结果和原任务均保留。'
                  : (scenario?.kind === 'breakdown' ? scenario.question : featurePurpose) ||
                    scenario?.title ||
                    (reading.entrance === 'overview'
                      ? '直接在 ARC 内生成系统架构和功能目录，再选择功能深入；不用切换到外部对话。'
                      : '添加你关注的功能和场景问题，再分析关键调用与输入输出。')}
            </p>
            <div className="row">
              <button className="quiet" onClick={() => switchView('files')}>
                先浏览源码目录
              </button>
            </div>
            <div className="facts">
              <div>
                <strong>{snapshot?.files.length || 0}</strong>
                <span>已索引文本文件</span>
              </div>
              <div>
                <strong>{snapshot?.excluded.length || 0}</strong>
                <span>排除或待确认项</span>
              </div>
              <div>
                <strong>只读</strong>
                <span>工程访问模式</span>
              </div>
            </div>
          </div>
        )}
        {overviewSections}
      </ScrollPanel>
      {showZoomFloat && (
        <div className="canvas-zoom-float" role="group" aria-label="画布缩放">
          <small className="zoom-hint">Ctrl＋滚轮</small>
          <button className="icon" aria-label="缩小画布" title="缩小画布" onClick={() => patch({ zoom: clampZoom(reading.zoom - 0.1) })}>
            <svg className="arc-ui-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M3.5 8h9" />
            </svg>
          </button>
          <button className="icon zoom-reset" aria-label="重置画布缩放" title="恢复 100%" onClick={() => patch({ zoom: 1 })}>
            {Math.round(reading.zoom * 100)}%
          </button>
          <button className="icon" aria-label="放大画布" title="放大画布" onClick={() => patch({ zoom: clampZoom(reading.zoom + 0.1) })}>
            <svg className="arc-ui-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </div>
      )}
    </main>
  );
}
