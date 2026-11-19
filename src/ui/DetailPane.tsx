import React from 'react';
import type {
  AnalysisResult,
  Annotation,
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
import { FunctionDetail, FunctionStepDetail } from './FunctionChain';
import { edgeNames, claimNames, nodeNames } from './Graph';
import { FeatureReadingDetail } from './FeatureReading';
import { SystemDetail } from './SystemDetail';
import { StepDetail } from './StepDetail';
import { FileSummary } from './FileSummary';
import { ReadingQuestions } from './ReadingQuestions';
import { SourceExcerpt } from './SourceExcerpt';
import { RunActivity } from './RunActivity';
import { AnalysisError } from './AnalysisError';
import { annotationTarget } from './annotation';
import { edgeExplanation } from './presentation';
import { EvidenceButton, ScrollPanel, short, statuses } from './workbench-primitives';

const api = window.arc;

export interface DetailPaneProps {
  data: WorkspaceData;
  project?: Project;
  projectId: string;
  scenario?: Scenario;
  scenarioId: string;
  currentFeature?: Feature;
  reading: ReadingState;
  loadedKey: string;
  activityFocus: number;
  analysisScope: string;
  analysisLabel: string;
  analysisMode: { name: string; option: string; start: string; retry: string; description: string };
  featurePurpose?: string;
  featureReading: boolean;
  businessReading: boolean;
  systemReading: boolean;
  architectureReading: boolean;
  detailDrawer: boolean;
  needsFunctionGraphs: boolean;
  waitingMcp: boolean;
  pending: boolean;
  indexes: Record<string, any>;
  result?: AnalysisResult;
  readingGuide: any;
  readingEvidence?: readonly SourceEvidence[];
  selectedNode?: AnalysisResult['nodes'][number];
  selectedEdge?: AnalysisResult['edges'][number];
  selectedCall: { kind: string; source?: AnalysisResult['nodes'][number]; target?: AnalysisResult['nodes'][number] } | null;
  functionStep: any;
  activeObject?: AnalysisResult['nodes'][number] | AnalysisResult['edges'][number];
  sourceSnapshot?: Snapshot;
  selectedFile: string;
  selectedEvidence?: SourceEvidence;
  developmentEvidence: unknown;
  development: React.ReactNode;
  overviewReviewGaps: AnalysisResult['gaps'];
  sceneAnnotations: Annotation[];
  sceneExplanations: Explanation[];
  sceneRuns: Run[];
  running?: Run;
  activityRun?: Run;
  completedExplanation?: Explanation;
  events: any[];
  eventError: string;
  questionLocation: { target: any; label: string };
  clue: string;
  setClue: (value: string) => void;
  patch: (value: Partial<ReadingState>) => void;
  setShowDetail: (value: boolean) => void;
  savePosition: (name: string, top: number, left: number) => void;
  select: (id: string) => void;
  selectFunctionRelation: (id: string) => void;
  evidence: (item: SourceEvidence) => void;
  readingFile: (file: string) => void;
  readingStep: (stepId: string) => void;
  inspectComponent: (id: string) => void;
  askHere: () => void;
  reload: () => Promise<WorkspaceData>;
  showMcp: () => void;
  viewCompleted: () => void;
  requestAnalysis: (overview?: boolean) => Promise<void>;
  action: <T>(fn: () => Promise<T>, message?: string) => Promise<T | undefined>;
}

export function DetailPane({
  data,
  project,
  projectId,
  scenario,
  scenarioId,
  currentFeature,
  reading,
  loadedKey,
  activityFocus,
  analysisScope,
  analysisLabel,
  analysisMode,
  featurePurpose,
  featureReading,
  businessReading,
  systemReading,
  architectureReading,
  detailDrawer,
  needsFunctionGraphs,
  waitingMcp,
  pending,
  indexes,
  result,
  readingGuide,
  readingEvidence,
  selectedNode,
  selectedEdge,
  selectedCall,
  functionStep,
  activeObject,
  sourceSnapshot,
  selectedFile,
  selectedEvidence,
  developmentEvidence,
  development,
  overviewReviewGaps,
  sceneAnnotations,
  sceneExplanations,
  sceneRuns,
  running,
  activityRun,
  completedExplanation,
  events,
  eventError,
  questionLocation,
  clue,
  setClue,
  patch,
  setShowDetail,
  savePosition,
  select,
  selectFunctionRelation,
  evidence,
  readingFile,
  readingStep,
  inspectComponent,
  askHere,
  reload,
  showMcp,
  viewCompleted,
  requestAnalysis,
  action,
}: DetailPaneProps) {
  const paneTitle =
    reading.detail_tab === 'questions'
      ? '当前位置问答'
      : featureReading
        ? '阅读说明'
        : reading.view === 'files'
          ? '文件用途'
          : businessReading && reading.detail_tab === 'details'
            ? '这一步怎么运转'
            : systemReading && reading.detail_tab === 'details'
              ? '职责与协作'
              : reading.detail_tab === 'agent'
                ? `${analysisScope}分析`
                : selectedNode
                  ? nodeNames[selectedNode.kind]
                  : selectedEdge
                    ? selectedEdge.transfers?.length
                      ? '数据传递'
                      : '关系说明'
                    : '当前说明';

  const tabs =
    reading.view === 'files' && !featureReading
      ? [
          ['details', '说明'],
          ['questions', '提问'],
          ['evidence', '依据'],
        ]
      : [
          ['details', '说明'],
          ['questions', '提问'],
          ['evidence', '依据'],
          ['agent', '分析进度'],
          ['history', '历史'],
        ];

  const restoreKey =
    loadedKey +
    ':' +
    (result?.result_id || '') +
    (reading.detail_tab === 'agent'
      ? ':' + activityFocus
      : (featureReading || businessReading || systemReading || reading.view === 'functions') && reading.detail_tab === 'details'
        ? ':' + reading.selected
        : '');

  return (
    <section className="detail">
      <div className="pane-heading">
        <span>{paneTitle}</span>
        <button
          className={`icon ${reading.pinned ? 'selected' : ''}`}
          aria-label={reading.pinned ? '解除固定详情' : '固定详情'}
          onClick={() => patch({ pinned: !reading.pinned })}
        >
          {reading.pinned ? '◆' : '◇'}
        </button>
        {architectureReading && !detailDrawer && (
          <button
            className="icon"
            aria-label="收起详情"
            onClick={() => {
              patch({ selected: '', file: '', evidence_id: '', pinned: false, detail_tab: 'details' });
              setShowDetail(false);
            }}
          >
            收起
          </button>
        )}
      </div>

      <nav className="detail-tabs">
        {tabs.map(([v, l]) => (
          <button key={v} className={reading.detail_tab === v ? 'selected' : ''} onClick={() => patch({ detail_tab: v })}>
            {l}
          </button>
        ))}
      </nav>

      <ScrollPanel positions={reading.scroll} restoreKey={restoreKey} onPosition={savePosition} name={`detail-${reading.view}-${reading.detail_tab}`}>
        {reading.detail_tab === 'details' && (
          <>
            {development}
            {featureReading && readingGuide && result ? (
              <FeatureReadingDetail
                guide={readingGuide}
                result={result}
                selected={reading.selected}
                view={reading.view}
                onFile={readingFile}
                onStep={readingStep}
                onEvidence={evidence}
              />
            ) : featureReading ? (
              <p>当前功能尚未有分析说明，可以直接提问。</p>
            ) : reading.view === 'files' && sourceSnapshot ? (
              <FileSummary data={data} projectId={projectId} snapshot={sourceSnapshot} path={selectedFile} ask={askHere} />
            ) : reading.view === 'functions' && result && functionStep ? (
              <FunctionStepDetail result={result} selection={functionStep} select={select} evidence={evidence} />
            ) : reading.view === 'functions' && result && selectedNode?.kind === 'function' ? (
              <FunctionDetail result={result} node={selectedNode} select={selectFunctionRelation} evidence={evidence} />
            ) : businessReading && result ? (
              <StepDetail result={result} selected={reading.selected} select={select} />
            ) : systemReading && result ? (
              <SystemDetail result={result} selected={reading.selected} select={select} inspect={inspectComponent} />
            ) : (
              <>
                <span className="eyebrow">
                  {selectedCall?.kind ||
                    (selectedEdge
                      ? selectedEdge.transfers?.length
                        ? '数据交接'
                        : edgeNames[selectedEdge.kind]
                      : selectedNode?.execution_context.label || analysisScope)}
                </span>
                <h2>{activeObject?.label || (!result ? '阅读与核对' : scenario?.title) || '工程全貌'}</h2>
                <p>
                  {selectedNode?.description ||
                    (selectedEdge && result ? edgeExplanation(result, selectedEdge) : result?.summary.text) ||
                    `点击上方「${analysisLabel}」，查看${analysisScope}的分析过程与源码依据。模型服务会接收本工程快照，原工程只读。`}
                </p>

                {selectedEdge?.transfers?.map((transfer, index) => {
                  const upstream = result?.nodes
                    .find(n => n.node_id === selectedEdge.source_node_id)
                    ?.outputs.find(io => io.io_id === transfer.source_output_id);
                  const downstream = result?.nodes
                    .find(n => n.node_id === selectedEdge.target_node_id)
                    ?.inputs.find(io => io.io_id === transfer.target_input_id);
                  return (
                    <article className="transfer-pair" key={index}>
                      <strong>传递：{transfer.label}</strong>
                      <p>
                        输出：{upstream?.name} → 输入：{downstream?.name}
                      </p>
                      <small>{claimNames[transfer.status]}</small>
                      <details>
                        <summary>查看传递前后的含义</summary>
                        <p>上一步产出：{upstream?.description}</p>
                        <p>下一步接收：{downstream?.description}</p>
                      </details>
                    </article>
                  );
                })}

                {selectedEdge && !selectedEdge.transfers?.length && (
                  <>
                    <p className="muted">
                      {selectedCall ? '参数与返回值可查看两端函数；此处尚未建立参数逐项传递映射。' : '这是关系说明，尚未建立明确的输入输出传递映射。'}
                    </p>
                    <div className="call-pair">
                      <span>{selectedCall?.source?.function_details?.symbol || result?.nodes.find(n => n.node_id === selectedEdge.source_node_id)?.label}</span>
                      <b>→ {selectedCall?.kind || edgeNames[selectedEdge.kind]} →</b>
                      <span>{selectedCall?.target?.function_details?.symbol || result?.nodes.find(n => n.node_id === selectedEdge.target_node_id)?.label}</span>
                      <small>{claimNames[selectedEdge.status]}</small>
                    </div>
                  </>
                )}

                {selectedNode && (
                  <>
                    <div className="next-steps">
                      <h3>{reading.view === 'dependencies' ? '依赖与关联' : '接下来'}</h3>
                      {result?.edges
                        .filter(e => e.source_node_id === selectedNode.node_id)
                        .map(e => (
                          <button key={e.edge_id} onClick={() => select(e.edge_id)}>
                            <span>{e.label}</span>
                            <small>
                              → {result.nodes.find(n => n.node_id === e.target_node_id)?.label}
                              {e.status !== 'source_supported' && ` · ${claimNames[e.status]}`}
                            </small>
                          </button>
                        ))}
                      {!result?.edges.some(e => e.source_node_id === selectedNode.node_id) && <p className="muted">当前分析没有继续的步骤。</p>}
                    </div>
                    <details className="io-details" key={selectedNode.node_id}>
                      <summary>查看输入与输出</summary>
                      {(
                        [
                          ['输入', selectedNode.inputs],
                          ['输出 / 返回', selectedNode.outputs],
                        ] as const
                      ).map(([label, items]) => (
                        <div key={label}>
                          <h3>{label}</h3>
                          {items.length ? (
                            items.map(io => (
                              <div className="io-row" key={io.io_id}>
                                <strong>{io.name}</strong>
                                <p>{io.description}</p>
                                <details className="technical-detail">
                                  <summary>技术细节</summary>
                                  <code>{io.data_type ?? '类型未知'}</code>
                                  {io.value_or_shape && <small>{io.value_or_shape}</small>}
                                </details>
                              </div>
                            ))
                          ) : (
                            <p className="muted">未说明</p>
                          )}
                        </div>
                      ))}
                    </details>
                  </>
                )}

                {result?.claims
                  .filter(c => activeObject?.claim_ids.includes(c.claim_id) || (!activeObject && result.summary.claim_ids.includes(c.claim_id)))
                  .map(c =>
                    c.status === 'source_supported' ? (
                      <details className="claim supported-detail" key={c.claim_id}>
                        <summary>来源判断与边界</summary>
                        <p>{c.statement}</p>
                        <small>{c.rationale}</small>
                        {c.limitations.map((l, i) => (
                          <p className="muted" key={i}>
                            边界：{l}
                          </p>
                        ))}
                      </details>
                    ) : (
                      <article className={`claim ${c.status}`} key={c.claim_id}>
                        <span className="tag">{claimNames[c.status]}</span>
                        <p>{c.statement}</p>
                        <small>{c.rationale}</small>
                        {c.limitations.map((l, i) => (
                          <p className="muted" key={i}>
                            边界：{l}
                          </p>
                        ))}
                      </article>
                    ),
                  )}
              </>
            )}

            {!featureReading && !functionStep && reading.view !== 'files' && result && (
              <details className="supporting-evidence" key={activeObject?.label || result.result_id}>
                <summary>查看分析依据 · {(activeObject ? activeObject.evidence_ids : result.evidence).length} 处引用</summary>
                {(activeObject ? result.evidence.filter(e => activeObject.evidence_ids.includes(e.evidence_id)) : result.evidence.slice(0, 4)).map(e => (
                  <EvidenceButton key={e.evidence_id} evidence={e} open={evidence} />
                ))}
              </details>
            )}

            {reading.view !== 'files' && scenario && (
              <>
                <details className="user-clue-editor" open={clue ? true : undefined}>
                  <summary>仅保存补充线索</summary>
                  <textarea
                    aria-label="补充线索"
                    placeholder="补充背景或指出问题；保存后仍是用户线索。"
                    value={clue}
                    onChange={e => setClue(e.target.value)}
                  />
                  <button
                    className="secondary full"
                    disabled={!clue.trim()}
                    onClick={() =>
                      void action(async () => {
                        await api.invoke('annotate', {
                          scenario_id: scenarioId,
                          text: clue,
                          result_id: result?.result_id || null,
                          object_id: featureReading
                            ? readingGuide?.steps.find((s: any) => 'step:' + s.id === reading.selected)?.node_ids[0] || null
                            : functionStep?.step.to_node_id || reading.selected || null,
                        });
                        setClue('');
                      }, '线索已保存，下次分析可引用')
                    }
                  >
                    保存线索
                  </button>
                </details>
                {sceneAnnotations.map(a => {
                  const original = sceneExplanations.find(e => e.result_id === a.result_id)?.result;
                  const match = annotationTarget(a, original, result);
                  return (
                    <article className="clue" key={a.annotation_id}>
                      <span className="tag">用户线索</span>
                      <p>{a.text}</p>
                      <small>
                        {match} · {short(a.source_snapshot_id)}
                      </small>
                      {original && a.result_id !== result?.result_id && (
                        <button
                          onClick={() =>
                            patch({
                              result_id: original.result_id,
                              selected: a.object_id || '',
                              file: '',
                              evidence_id: '',
                              source_snapshot_id: original.binding.source_snapshot_id,
                              detail_tab: 'details',
                            })
                          }
                        >
                          查看原批注
                        </button>
                      )}
                      {match.startsWith('同源') && (
                        <button onClick={() => patch({ selected: a.object_id || '', detail_tab: 'details' })}>定位对应对象</button>
                      )}
                    </article>
                  );
                })}
              </>
            )}
          </>
        )}

        {project && (
          <div hidden={reading.detail_tab !== 'questions'}>
            <ReadingQuestions
              data={data}
              projectId={projectId}
              scenarioId={scenarioId}
              resultId={result?.result_id || null}
              target={questionLocation.target}
              targetLabel={questionLocation.label}
              featureId={currentFeature?.feature_id || projectId}
              featureLabel={reading.entrance === 'overview' ? '当前工程整体' : `${currentFeature?.name || scenario?.title || '当前功能'} · 整体`}
              snapshotId={result?.binding.source_snapshot_id || project.snapshot_id}
              disabled={project.fictional}
              reload={reload}
              settings={showMcp}
            />
          </div>
        )}

        {reading.detail_tab === 'evidence' && (
          <>
            <h2>{architectureReading && activeObject ? activeObject.label + ' · 来源依据' : '来源与覆盖'}</h2>
            {selectedEvidence && (
              <article className="scope-box evidence-location" aria-label="所选来源依据">
                <strong>{selectedEvidence.path}</strong>
                <p>{selectedEvidence.note}</p>
                <span>
                  位置：第 {selectedEvidence.line_start}–{selectedEvidence.line_end} 行
                </span>
                <span>版本：{selectedEvidence.source_snapshot_id}</span>
                <small>SHA-256：{selectedEvidence.content_sha256}</small>
                <SourceExcerpt evidence={selectedEvidence} />
              </article>
            )}
            {Boolean(developmentEvidence) && development}
            <p className="warning">结构、引用和哈希校验不等于语义已核实。</p>
            <dl>
              <dt>说明</dt>
              <dd>{result?.result_id || '暂无'}</dd>
              <dt>来源版本</dt>
              <dd>{result?.binding.source_snapshot_id || project?.snapshot_id}</dd>
              <dt>问题修订</dt>
              <dd>{result?.binding.question_revision_id || scenario?.question_revision_id}</dd>
              <dt>构建条件</dt>
              <dd>
                {data.snapshots.find(s => s.source_snapshot_id === (result?.binding.source_snapshot_id || project?.snapshot_id))?.build_config ||
                  '未知；没有指定宏、目标和包含路径'}
              </dd>
            </dl>
            {(architectureReading && activeObject ? result?.evidence.filter(item => activeObject.evidence_ids.includes(item.evidence_id)) : readingEvidence)?.map(
              e => (
                <EvidenceButton key={e.evidence_id} evidence={e} open={evidence} />
              ),
            )}
            <h3>尚未覆盖</h3>
            {result?.gaps.map(g => (
              <article className="gap" key={g.gap_id}>
                <strong>{g.question}</strong>
                <p>{g.impact}</p>
                <small>
                  {overviewReviewGaps.some(gap => gap.gap_id === g.gap_id)
                    ? 'ARC 可自动补查这条关系的原冻结源码，并对修订后的关系再次复核。'
                    : g.suggested_action}
                </small>
              </article>
            ))}
            {!result && <p>尚未有分析结果。</p>}
          </>
        )}

        {reading.detail_tab === 'agent' && (
          <>
            {activityRun && !waitingMcp && (
              <RunActivity
                run={activityRun}
                events={events}
                error={eventError}
                detailed
                stop={() => void action(() => api.invoke('run_cancel', { run_id: activityRun.binding.run_id }))}
              />
            )}
            {completedExplanation && !waitingMcp && (
              <button className="primary full view-completed" onClick={viewCompleted}>
                查看本次分析结果
              </button>
            )}
            {waitingMcp && (
              <div className="waiting-summary">
                <h3>等待 Agent 对话领取</h3>
                <p>所选功能已准备，尚未开始模型调用。请在已接入 Arc 的 Codex 对话中领取。</p>
              </div>
            )}
            <details className="run-start-options" open={(!activityRun && !waitingMcp) || undefined}>
              <summary>{activityRun ? '再次分析' : '分析执行方式'}</summary>
              <button className="secondary full" onClick={showMcp}>
                连接 Agent
              </button>
              <p>{analysisMode.description}</p>
              <h2>分析：{analysisScope}</h2>
              <p>{featurePurpose || scenario?.title || '先添加或选择一个场景。'}</p>
              <details>
                <summary>查看完整分析问题</summary>
                <p>{scenario?.question}</p>
              </details>
              <div className="scope-box">
                <strong>本次来源</strong>
                <span>{short(project?.snapshot_id || '')}</span>
                <small>本地冻结源码；Agent 的模型服务将接收所选工程内容。原工程只读。</small>
              </div>
              {!needsFunctionGraphs && (
                <button
                  className="primary full"
                  disabled={!scenario || project?.fictional || pending || !!running || !!indexes[projectId]}
                  onClick={() => void requestAnalysis(reading.entrance === 'overview')}
                >
                  {running ? '分析进行中' : analysisMode.start}
                </button>
              )}
              {project?.fictional && <p className="warning">当前是演示，不派发真实任务。</p>}
            </details>

            <details className="run-history">
              <summary>历史运行与恢复操作 · {sceneRuns.length}</summary>
              {sceneRuns
                .slice()
                .reverse()
                .map(run => (
                  <article className="run" key={run.binding.run_id}>
                    <div className="row between">
                      <strong>
                        {run.origin === 'manual_import' ? '手动导入 · 非联调' : run.origin === 'mcp' ? 'MCP · Agent 主动写回' : run.provider_id}
                      </strong>
                      <span className="tag">{statuses[run.status] || run.status}</span>
                    </div>
                    <small>{short(run.binding.run_id)}</small>
                    <small>问题 {short(run.binding.question_revision_id)}</small>
                    <small>来源 {short(run.binding.source_snapshot_id)}</small>
                    {run.previous_run_id && (
                      <small className="retry-origin">
                        {run.repair_from_run_id ? '修复来源' : '关联原运行'}：{run.previous_run_id}
                      </small>
                    )}
                    {run.external_id && <p className="path">原生会话：{run.external_id}</p>}
                    {run.error && <AnalysisError error={run.error} />}
                    {run.status === 'failed' && !run.overview_format && run.provider_id === 'codex' && !run.dsh_overview_format && !run.dsh_function_format && (
                      <button onClick={() => void action(() => api.invoke('run_revalidate', { run_id: run.binding.run_id }))}>
                        重新校验已收原文（不调用 Agent）
                      </button>
                    )}
                    {run.validation && (
                      <small>
                        结构 {run.validation.structure} / 锚点 {run.validation.anchors}
                        <br />
                        {run.validation.semantic}
                      </small>
                    )}
                    {run.origin === 'mcp' ? (
                      <small>MCP 任务请在原 Agent 对话继续；撤销只关闭 Arc 的读写权限。</small>
                    ) : ['running', 'queued', 'cancel_requested'].includes(run.status) ? (
                      <button
                        disabled={run.status === 'cancel_requested'}
                        onClick={() => void action(() => api.invoke('run_cancel', { run_id: run.binding.run_id }))}
                      >
                        请求停止
                      </button>
                    ) : (
                      <button
                        onClick={() => void requestAnalysis(reading.entrance === 'overview')}
                        disabled={project?.fictional || pending || !!running}
                      >
                        {analysisMode.retry}
                      </button>
                    )}
                  </article>
                ))}
            </details>
            <details>
              <summary>最近运行的真实事件（{events.length}）</summary>
              <div className="events">
                {events.slice(-60).map((e, i) => (
                  <pre key={i}>{JSON.stringify(e, null, 2)}</pre>
                ))}
              </div>
            </details>
          </>
        )}

        {reading.detail_tab === 'history' && (
          <>
            <h2>解释历史</h2>
            <p>新分析保存为新版本，不覆盖历史源码。当前查看的历史不会被新返回切走。</p>
            {sceneExplanations
              .slice()
              .reverse()
              .map(e => (
                <button
                  key={e.result_id}
                  className={`history-row ${e.result_id === result?.result_id ? 'selected' : ''}`}
                  onClick={() =>
                    patch({
                      result_id: e.result_id,
                      selected: '',
                      file: '',
                      evidence_id: '',
                      reading_path: '',
                      function_path: '',
                      reading_focus: '',
                      source_snapshot_id: e.result.binding.source_snapshot_id,
                    })
                  }
                >
                  <strong>{e.result.summary.text.slice(0, 100)}</strong>
                  <small>
                    {new Date(e.created_at).toLocaleString('zh-CN')} · {e.result.provider.provider_id}
                  </small>
                  <small>{short(e.result.binding.source_snapshot_id)}</small>
                  <small>
                    {e.result.binding.question_revision_id === scenario?.question_revision_id ? '当前问题' : '历史问题'} ·{' '}
                    {e.source_status === 'current' ? '来源可核对' : '来源待复核'}
                  </small>
                </button>
              ))}
            <button
              className="secondary full"
              disabled={sceneExplanations.length < 2}
              onClick={() => patch({ mode: 'compare', compare_id: sceneExplanations.at(-2)?.result_id || '' })}
            >
              旧版｜新版 并排比较
            </button>
          </>
        )}
      </ScrollPanel>
    </section>
  );
}
