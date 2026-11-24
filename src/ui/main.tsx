import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EngineeringTask } from '../engineering';
import type { CodexPreferences, Project, ReadingState, Run, Scenario, SourceEvidence, WorkspaceData } from '../shared';
import { hasFunctionGraphs } from '../shared';
import { explanationFreshness } from '../freshness';
import { discoveredFeature } from '../discovered-feature';
import { functionCallMap } from './function-call-map';
import { selectedCallStep } from './function-sequence-model';
import { AnalysisModePicker } from './FeatureCatalog';
import './feature-catalog.css';
import { analysisModes, catalogGraphState, waitingForAgent, type AnalysisMode } from './discovery-state';
import { projectLabel } from './project-label';
import { FeatureDevelopment, type FeatureDevelopmentDraft } from './FeatureDevelopment';
import {
  featurePathPosition,
  featureReadingModel,
  featureReadingPosition,
  featureViewPosition,
  featureViews,
  functionPathPosition,
  guideItemTitle,
  guidePathForStep,
  hasCollaborationRoles,
  readingObjectDetail,
  walkthroughSelection,
} from './feature-reading-model';
import { timelineModel } from './timeline-model';
import { savedBusinessPath } from './home-reading';
import { EngineeringOverviewSections, EngineeringWorkspace } from './EngineeringWorkspace';
import type { FeatureContextOption, RequirementReadingDraft } from './RequirementComposer';
import type { TaskArchitectureOverlay } from './DevelopmentHud';
import { WorkbenchNavigation, type WorkbenchView } from './WorkbenchNavigation';
import { edgeSelection, readingQuestionTarget } from './reading-target';
import { compactTitle, isLegacyOverview, modernReading } from './presentation';
import { RunActivity } from './RunActivity';
import { createReloadCoalescer } from './reload-coalescer';
import { useRunEvents } from './useRunEvents';
import {
  Compare,
  Separator,
  closePopovers,
  defaults,
  firstGraphPath,
  initialData,
  short,
  statuses,
  type HomeBookmark,
} from './workbench-primitives';
import { SettingsModal } from './SettingsModal';
import { CodexModelSelect } from './CodexModelSelect';
import { EntityFormModal } from './EntityFormModal';
import { ScenarioBreakdownForm } from './ScenarioBreakdownForm';
import { CatalogSidebar } from './CatalogSidebar';
import { DetailPane } from './DetailPane';
import { CanvasPane } from './CanvasPane';
import { useArchitectureDocument } from './useArchitectureDocument';
import { architectureDocumentToAnalysisResult } from '../architecture-workspace';
import './styles.css';
import './reading-diagrams.css';
import './function-chain.css';
import './reading.css';
import './feature-reading.css';
import './architecture.css';
import './architecture-map.css';
import './code-modules.css';
import './workbench.css';

const api = window.arc;
const overviewTabs = [
  ['system', '系统架构'],
  ['files', '源码目录'],
];
const overviewLanding = {
  entrance: 'overview', view: 'system', catalog_hidden: true, mode: 'normal', detail_tab: 'details',
  result_id: '', source_snapshot_id: '', selected: '', file: '', evidence_id: '', pinned: false,
  scroll: { 'canvas-system': { top: 0, left: 0 } },
} as const;

function applyReadingPosition(reading: ReadingState, position: Partial<ReadingState>): ReadingState {
  return { ...reading, ...position, ...(position.scroll && { scroll: { ...reading.scroll, ...position.scroll } }) };
}

function scrollArchitectureToTop() {
  document.querySelector('.canvas > .panel-scroll')?.scrollTo(0, 0);
}

function App() {
  const [data, setData] = useState(initialData);
  const [projectId, setProjectId] = useState('');
  const [scenarioId, setScenarioId] = useState('');
  const [storedReading, setReading] = useState<ReadingState>(defaults);
  const [loadedKey, setLoadedKey] = useState('');
  const [width, setWidth] = useState(window.innerWidth);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState('');
  const [modal, setModal] = useState('');
  const [pending, setPending] = useState(false);
  const [formName, setFormName] = useState('');
  const [formQuestion, setFormQuestion] = useState('');
  const [search, setSearch] = useState('');
  const [clueDrafts, setClueDrafts] = useState<Record<string, string>>({});
  const [formFeature, setFormFeature] = useState('');
  const [featureDrafts, setFeatureDrafts] = useState<Record<string, FeatureDevelopmentDraft>>({});
  const [bookmark, setBookmark] = useState<HomeBookmark | null>(null);
  const [focusDevelopment, setFocusDevelopment] = useState(false);
  const [composerDraft, setComposerDraft] = useState<RequirementReadingDraft | null>(null);
  const [requestedTask, setRequestedTask] = useState('');
  const [archOverlay, setArchOverlay] = useState<TaskArchitectureOverlay | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => { setArchOverlay(null); setComposerDraft(null); }, [projectId]);
  const [indexes, setIndexes] = useState<Record<string, any>>({});
  const [showDetail, setShowDetail] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [archiveVisible, setArchiveVisible] = useState(false);
  const [renameFeature, setRenameFeature] = useState('');
  const [activityFocus, setActivityFocus] = useState(0);
  const [openDesktop, setOpenDesktop] = useState(false);
  const [mcp, setMcp] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [connectionError, setConnectionError] = useState('');

  const expandMode = data.default_engine ?? 'codex';
  const analysisMode = analysisModes[expandMode];
  const readingScope = useRef('');
  const emptyEntrance = useRef<'overview' | 'walk'>('overview');
  const previousFocus = useRef<HTMLElement | null>(null);
  const revealScenario = useRef('');
  const modalRef = useRef<HTMLDialogElement>(null);
  const starting = useRef(false);
  const projectSwitch = useRef(0);
  const freshnessChecks = useRef(new Map<string, number>());
  const navigation = useRef<{ scope: string; value: Partial<ReadingState> } | null>(null);

  const project = data.projects.find(p => p.project_id === projectId);
  const scenario = data.scenarios.find(s => s.scenario_id === scenarioId);

  const overviewFeature = data.scenarios.find(s => s.scenario_id === project?.overview_scenario_id)?.feature_id;
  const userFeatures = data.features
    .filter(f => f.project_id === projectId && !f.archived && f.feature_id !== overviewFeature)
    .sort((a, b) => a.sort_order - b.sort_order);
  const walkScenes = data.scenarios
    .filter(s => s.project_id === projectId && !s.archived && s.scenario_id !== project?.overview_scenario_id && userFeatures.some(f => f.feature_id === s.feature_id))
    .sort((a, b) => userFeatures.findIndex(f => f.feature_id === a.feature_id) - userFeatures.findIndex(f => f.feature_id === b.feature_id) || a.sort_order - b.sort_order);

  const sceneExplanations = data.explanations.filter(e => e.scenario_id === scenarioId);
  const explanation = sceneExplanations.find(e => e.result_id === storedReading.result_id) || (storedReading.result_id ? undefined : sceneExplanations.at(-1));
  const result = explanation?.result;
  const latestOverview = data.explanations.findLast(item => item.scenario_id === project?.overview_scenario_id && item.result.binding.project_id === projectId);
  const architecture = useArchitectureDocument(projectId, JSON.stringify([project?.snapshot_id, latestOverview?.result_id]), api.invoke);
  const architectureSource = data.explanations.find(item => item.result_id === architecture.doc?.source_explanation_id);
  const maintainedView = storedReading.entrance === 'overview' && ['system', 'map', 'modules'].includes(storedReading.view)
    && !(explanation && latestOverview && explanation.result_id !== latestOverview.result_id);
  const projected = useMemo(() => {
    if (!maintainedView || !architecture.doc) return;
    const view = architectureDocumentToAnalysisResult(architecture.doc, architectureSource?.result);
    // A manual-first document has no analysis baseline. Its code browser uses the project's frozen snapshot.
    return view.binding.source_snapshot_id ? view : { ...view, binding: { ...view.binding, source_snapshot_id: project?.snapshot_id ?? '' } };
  }, [maintainedView, architecture.doc, architectureSource, project?.snapshot_id]);
  const paneResult = projected ?? result;
  // Older reading positions stored a bare edge ID while all IDs were globally unique.
  const reading = useMemo(() => {
    const id = storedReading.selected;
    return id && paneResult?.edges.some(e => e.edge_id === id) && !paneResult.nodes.some(n => n.node_id === id)
      ? { ...storedReading, selected: edgeSelection(id) } : storedReading;
  }, [storedReading, paneResult]);

  const analysisScope =
    (!scenarioId && reading.entrance === 'walk') || reading.view === 'capabilities'
      ? '功能目录'
      : reading.entrance === 'overview'
        ? '工程全貌'
        : scenario?.kind === 'feature_overview'
          ? '功能整体走读'
          : '具体场景';
  const snapshot = data.snapshots.find(s => s.source_snapshot_id === project?.snapshot_id);
  const hasCollaboration = hasCollaborationRoles(result);
  const overviewRun =
    result &&
    data.runs.find(
      run =>
        run.binding.run_id === result.binding.run_id &&
        run.binding.source_snapshot_id === result.binding.source_snapshot_id &&
        run.binding.project_id === projectId &&
        run.binding.scenario_id === scenarioId,
    );
  const overviewReviewGaps = overviewRun?.overview_format && !result?.fictional ? result?.gaps.filter(gap => gap.gap_id.startsWith('overview-review-') && gap.related_node_ids.length) || [] : [];

  const catalogReading = reading.view === 'capabilities' || (reading.entrance === 'walk' && !scenarioId);
  const engineeringReading = ['engineering', 'materials'].includes(reading.view);
  const overview = reading.entrance === 'overview';
  const overviewSectionsVisible = overview && reading.view === 'system' && !project?.fictional;
  const walkNavigation = reading.entrance === 'walk' && !engineeringReading;
  const catalogExplanation = data.explanations.filter(e => e.scenario_id === project?.overview_scenario_id && e.result.feature_catalog).at(-1);
  const lastCheck = data.project_freshness?.[projectId];
  const projectFreshness = lastCheck?.snapshot_id === project?.snapshot_id ? lastCheck : undefined;
  const freshness = !catalogReading && explanation && project ? explanationFreshness(explanation, project.snapshot_id, projectFreshness?.changed_files ?? []) : undefined;
  const capabilityCount = catalogExplanation?.result.feature_catalog?.groups.reduce((n, g) => n + g.node_ids.length, 0) || 0;
  const featureReading = reading.entrance === 'walk' && !!scenarioId && ['timeline', 'collaboration', 'files'].includes(reading.view);
  const walkthroughInspector = featureReading || (reading.entrance === 'walk' && reading.view === 'functions');
  const readingGuide = useMemo(() => featureReading && result ? featureReadingModel(result) : undefined, [featureReading, result]);
  const readingObject = useMemo(() => result && readingGuide ? readingObjectDetail(result, readingGuide, reading.selected, reading.reading_path) : undefined,
    [result, readingGuide, reading.selected, reading.reading_path]);
  const businessReading = reading.view === 'timeline' && !!result && timelineModel(result).ordered;
  const systemReading = overview && ['system', 'map', 'modules'].includes(reading.view);

  const selectedNode = paneResult?.nodes.find(n => n.node_id === reading.selected);
  const selectedEdge = paneResult?.edges.find(n => edgeSelection(n.edge_id) === reading.selected);
  const functionStep = reading.view === 'functions' && result ? selectedCallStep(result, reading.selected) : undefined;
  const selectedCall =
    reading.view === 'functions' && result && selectedEdge && ['sync_call', 'execution_boundary'].includes(selectedEdge.kind)
      ? {
          kind: selectedEdge.kind === 'execution_boundary' ? '异步调度' : '直接调用',
          source: result.nodes.find(n => n.node_id === selectedEdge.source_node_id),
          target: result.nodes.find(n => n.node_id === selectedEdge.target_node_id),
        }
      : null;
  const activeObject = selectedNode || selectedEdge;
  const activeEvidenceIds = functionStep?.step.evidence_ids ?? activeObject?.evidence_ids;
  const readingEvidence = readingObject ? [readingObject.primaryEvidence, ...readingObject.moreEvidence].filter((e): e is SourceEvidence => !!e)
    : walkthroughInspector && activeEvidenceIds ? result?.evidence.filter(e => activeEvidenceIds.includes(e.evidence_id)) : paneResult?.evidence;
  const sceneRuns = data.runs.filter(r => r.binding.scenario_id === scenarioId && !r.reading_question_id);
  const sceneAnnotations = data.annotations.filter(a => a.scenario_id === scenarioId);
  const windowMode = width >= 1280 ? 'desktop' : width >= 900 ? 'medium' : 'narrow';
  const detailDrawer = width < 1280;
  const architectureReading = overview && ['system', 'map'].includes(reading.view);
  const hasDetailSelection = reading.view === 'functions' ? !!(selectedNode?.kind === 'function' || selectedCall || functionStep) : !!reading.selected;
  const detailVisible = (!featureReading && !architectureReading && reading.view !== 'functions') || hasDetailSelection || reading.detail_tab !== 'details' || showDetail;
  const readingKey = `${projectId}/${scenarioId || emptyEntrance.current}/${windowMode}`;
  const activeReadingKey = useRef(readingKey);
  activeReadingKey.current = readingKey;

  const sourceSnapshotId = reading.source_snapshot_id || paneResult?.binding.source_snapshot_id || project?.snapshot_id || '';
  const sourceSnapshot = data.snapshots.find(s => s.source_snapshot_id === sourceSnapshotId);
  const selectedEvidence = paneResult?.evidence.find(e => e.evidence_id === reading.evidence_id);
  const selectedFile = reading.file || selectedEvidence?.path || '';
  const taskEvidence = selectedEvidence?.path === selectedFile ? selectedEvidence
    : readingObject?.primaryEvidence ?? readingEvidence?.find(e => activeEvidenceIds?.includes(e.evidence_id));
  const citedFile = taskEvidence && sourceSnapshot?.files.find(file => file.path === taskEvidence.path);
  const developmentEvidence =
    taskEvidence &&
    taskEvidence.source_snapshot_id === sourceSnapshotId &&
    sourceSnapshotId === result?.binding.source_snapshot_id &&
    citedFile?.content_sha256 === taskEvidence.content_sha256 &&
    taskEvidence.line_start >= 1 &&
    taskEvidence.line_end >= taskEvidence.line_start &&
    taskEvidence.line_end <= citedFile.line_count
      ? { evidence_id: taskEvidence.evidence_id, path: taskEvidence.path, line_start: taskEvidence.line_start, line_end: taskEvidence.line_end }
      : undefined;

  const suggestedPath = useMemo(
    () => (overviewSectionsVisible && project ? savedBusinessPath(project, walkScenes, data.explanations) : undefined),
    [overviewSectionsVisible, project, data.scenarios, data.features, data.explanations],
  );
  const currentFeature = data.features.find(f => f.feature_id === scenario?.feature_id);
  const breakdownFeature = modal === 'breakdown' && data.features.find(f => f.feature_id === formFeature);
  const discovery = currentFeature?.discovery;
  const graphRun = discovery && reading.view === 'timeline' && result && !result.reading_guide?.paths.length ? sceneRuns.find(run => run.binding.run_id === result.binding.run_id && run.dsh_function_format) : undefined;
  const graphCatalog =
    graphRun?.overview_parent_run_id && discovery
      ? data.explanations.find(
          item =>
            item.result_id === discovery.result_id &&
            item.result.binding.run_id === graphRun.overview_parent_run_id &&
            item.result.binding.source_snapshot_id === graphRun.binding.source_snapshot_id &&
            item.result.feature_catalog?.readings?.some(row => row.node_id === discovery.node_id),
        )
      : undefined;
  const requestedCatalog =
    discovery && !result ? data.explanations.find(e => e.result_id === reading.result_id && e.result.feature_catalog && e.result.binding.project_id === projectId) : undefined;
  const featureSource =
    discovery && reading.entrance === 'walk' && scenario?.kind === 'feature_overview' && !result
      ? requestedCatalog && discoveredFeature(data.features, data.explanations, requestedCatalog.result, discovery.node_id, project?.snapshot_id || '')?.feature_id === currentFeature?.feature_id
        ? requestedCatalog
        : data.explanations.find(e => e.result_id === discovery.result_id && e.result.binding.project_id === projectId)
      : undefined;
  const preview = featureSource && !catalogReading && !engineeringReading && project && discovery;
  const functionPreview = !!preview && reading.view === 'functions';
  const previewGraphs = preview ? catalogGraphState(data, featureSource, preview.node_id) : undefined;
  const previewRun = previewGraphs?.run;
  const automaticRun = previewRun?.overview_parent_run_id;
  const previewExplanation = functionPreview ? previewGraphs?.ready ?? (!automaticRun ? previewGraphs?.latest : undefined) : undefined;

  const bookmarkResult =
    bookmark?.projectId === projectId &&
    data.explanations.find(
      e => e.result_id === bookmark.position.result_id && e.result.binding.project_id === projectId && e.result.binding.source_snapshot_id === bookmark.position.source_snapshot_id,
    );
  const bookmarkScene = walkScenes.find(s => s.scenario_id === bookmark?.position.scenario_id);
  const sameBookmarkScope =
    bookmarkResult &&
    (bookmarkResult.scenario_id === bookmark?.position.scenario_id ||
      (!!bookmarkScene &&
        !!bookmark?.catalogNodeId &&
        discoveredFeature(data.features, data.explanations, bookmarkResult.result, bookmark.catalogNodeId, project?.snapshot_id || '')?.feature_id === bookmarkScene.feature_id));
  const canResume = !!sameBookmarkScope && (bookmark?.position.scenario_id === project?.overview_scenario_id || walkScenes.some(s => s.scenario_id === bookmark?.position.scenario_id));
  const objectLabel = featureReading && readingGuide ? guideItemTitle(readingGuide, reading.selected) : activeObject?.label;
  const bookmarkSource = result || (preview ? featureSource?.result : undefined);
  const bookmarkLabel = preview ? currentFeature?.name : architectureReading || featureReading || reading.view === 'functions' ? objectLabel : reading.view === 'files' ? reading.file : '';

  useEffect(() => {
    if (!overviewSectionsVisible || !projectId || bookmarkLabel) return;
    let current = true;
    void api.invoke<HomeBookmark | null>('reading_get', { key: 'home-bookmark/' + projectId }).then(value => {
      if (current) setBookmark(value);
    }).catch(e => setError(e.message));
    return () => {
      current = false;
    };
  }, [overviewSectionsVisible, projectId, bookmarkLabel]);

  useEffect(() => {
    if (
      !bookmarkLabel ||
      !bookmarkSource ||
      !scenario ||
      loadedKey !== readingKey ||
      reading.mode !== 'normal' ||
      bookmarkSource.binding.project_id !== projectId ||
      (!preview && scenario.scenario_id !== bookmarkSource.binding.scenario_id)
    ) {
      return;
    }
    const { view, entrance, selected, file, evidence_id, detail_tab, reading_path, function_path, function_mode, stage } = reading;
    const position = {
      view,
      entrance,
      selected,
      file,
      evidence_id,
      detail_tab,
      reading_path,
      function_path,
      function_mode,
      stage,
      scenario_id: scenario.scenario_id,
      result_id: bookmarkSource.result_id,
      source_snapshot_id: bookmarkSource.binding.source_snapshot_id,
    };
    const value: HomeBookmark = { projectId, label: bookmarkLabel, position, ...(preview ? { catalogNodeId: preview.node_id } : {}) };
    setBookmark(value);
    void api.invoke('reading_save', { key: 'home-bookmark/' + projectId, value }).catch(e => setError(e.message));
  }, [
    bookmarkLabel,
    projectId,
    scenario?.scenario_id,
    bookmarkSource?.result_id,
    loadedKey,
    readingKey,
    reading.mode,
    reading.view,
    reading.entrance,
    reading.selected,
    reading.file,
    reading.evidence_id,
    reading.detail_tab,
    reading.reading_path,
    reading.function_path,
    reading.function_mode,
    reading.stage,
  ]);

  const latestRun = sceneRuns.at(-1);
  const running = sceneRuns.find(r => ['queued', 'waiting_agent', 'running', 'validating', 'cancel_requested'].includes(r.status));
  const activityRun = preview ? previewRun : running || latestRun;
  const completedExplanation = data.explanations.find(e => e.result.binding.run_id === activityRun?.binding.run_id);
  const projectTasks = data.runs.filter(r => !r.reading_question_id && r.binding.project_id === projectId && ['queued', 'waiting_agent', 'running', 'validating', 'cancel_requested'].includes(r.status));
  const otherProjectTasks = projectTasks.filter(r => !r.overview_parent_run_id);
  const pendingScene = data.scenarios.find(s => s.project_id === projectId && waitingForAgent(data, s.scenario_id));
  const featureTask = (data.development_tasks ?? [])
    .filter(task => task.reading?.scenario_id === scenarioId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const questionLocation = readingQuestionTarget(
    result,
    reading,
    currentFeature?.feature_id || projectId,
    data.snapshots.find(s => s.source_snapshot_id === (result?.binding.source_snapshot_id || project?.snapshot_id)),
  );
  if (questionLocation.target.kind === 'feature') {
    questionLocation.label = reading.entrance === 'overview' ? '当前工程整体' : `${currentFeature?.name || scenario?.title || '当前功能'} · 整体`;
  }
  const objectDraftKey = JSON.stringify([scenarioId, result?.result_id, questionLocation.target.kind, questionLocation.target.id]);
  const clueKey = walkthroughInspector ? objectDraftKey : scenarioId;
  const clue = clueDrafts[clueKey] || '';
  const setClue = (value: string) => setClueDrafts(d => ({ ...d, [clueKey]: value }));
  const developmentKey = featureTask?.task_id ?? objectDraftKey;
  const featureDraft = featureDrafts[developmentKey] ?? { editing: false, request: '' };
  function updateFeatureDraft(draftPatch: Partial<FeatureDevelopmentDraft>) {
    setFeatureDrafts(items => ({ ...items, [developmentKey]: { ...(items[developmentKey] ?? { editing: false, request: '' }), ...draftPatch } }));
  }
  const featurePurpose = catalogExplanation?.result.nodes.find(n => n.node_id === currentFeature?.discovery?.node_id)?.description;
  const waitingMcp = waitingForAgent(data, scenarioId);
  const { items: events, error: eventError } = useRunEvents(activityRun);
  const indexTasks = Object.values(indexes);

  const patch = useCallback((value: Partial<ReadingState>) => setReading(r => ({ ...r, ...value })), []);

  useEffect(() => {
    if (reading.entrance === 'walk' && reading.view === 'collaboration' && result && !hasCollaboration && loadedKey === readingKey) {
      setReading(r => featureViewPosition(r, 'timeline', result.binding.source_snapshot_id) ?? r);
    }
  }, [reading.entrance, reading.view, result, hasCollaboration, loadedKey, readingKey]);

  useEffect(() => {
    if (!previewExplanation || loadedKey !== readingKey) return;
    patch({
      result_id: previewExplanation.result_id,
      source_snapshot_id: previewExplanation.result.binding.source_snapshot_id,
      selected: '',
      file: '',
      evidence_id: '',
      reading_path: '',
      function_path: firstGraphPath(previewExplanation.result),
      reading_focus: '',
      detail_tab: 'details',
      mode: 'normal',
    });
    setShowDetail(false);
  }, [previewExplanation?.result_id, loadedKey, readingKey, patch]);

  function switchView(view: string, overrides: Partial<ReadingState> = {}) {
    closePopovers();
    if (view !== 'system') setArchOverlay(null);
    if (view === 'files') overrides = { files_open: false, detail_tab: 'details', ...overrides };
    setReading(r => {
      const featurePosition = featureViewPosition(r, view, result?.binding.source_snapshot_id || '');
      if (featurePosition) return { ...featurePosition, ...overrides };
      if (r.view === view) return { ...r, ...overrides };
      const { selected, file, evidence_id, source_snapshot_id, mode, detail_tab, zoom, stage, result_id } = r;
      const savedState = { selected, file, evidence_id, source_snapshot_id, mode, detail_tab, zoom, stage, result_id };
      const target = r.view_states?.[view] || {
        selected: '',
        file: '',
        evidence_id: '',
        source_snapshot_id: '',
        mode: 'normal' as const,
        detail_tab: 'details',
        zoom: 1,
        stage: '',
        result_id: r.result_id,
      };
      return { ...r, ...target, view, view_states: { ...r.view_states, [r.view]: savedState }, ...overrides };
    });
  }

  const savePosition = useCallback((name: string, top: number, left: number) => setReading(r => ({ ...r, scroll: { ...r.scroll, [name]: { top, left } } })), []);
  const [{ reload, schedule: scheduleReload, cancelScheduled: cancelScheduledReload }] = useState(() =>
    createReloadCoalescer(async () => {
      const d = await api.invoke<WorkspaceData>('data');
      setData(d);
      return d;
    }, 150, reason => setError((reason as Error).message)),
  );

  async function action<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    setError('');
    setNotice('');
    try {
      const r = await fn();
      if (success) setNotice(success);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  }

  useEffect(() => {
    let current = true;
    void (async () => {
      const d = await reload();
      if (!current) return;
      const last = await api.invoke('reading_get', { key: 'last-session' });
      if (!current) return;
      const initialProject = d.projects.find(p => p.project_id === last?.project_id) ?? d.projects[0];
      const savedScene = d.scenarios.some(s => s.scenario_id === last?.scenario_id) ? last.scenario_id : '';
      emptyEntrance.current = last?.entrance === 'walk' ? 'walk' : 'overview';
      setProjectId(initialProject?.project_id || '');
      setScenarioId(savedScene || (emptyEntrance.current === 'walk' ? '' : initialProject?.overview_scenario_id || ''));
    })().catch(reason => { if (current) setError((reason as Error).message); });
    const off = api.onEvent(e => {
      if (e.type === 'changed') scheduleReload();
      if (e.type === 'indexing') {
        setNotice('');
        setIndexes(items => ({ ...items, [e.project_id]: e }));
      }
      if (e.type === 'index_done') {
        setIndexes(items => {
          const next = { ...items };
          delete next[e.project_id];
          return next;
        });
      }
    });
    return () => {
      current = false;
      cancelScheduledReload();
      off();
    };
  }, [reload, scheduleReload, cancelScheduledReload]);

  useEffect(() => {
    const outside = (e: PointerEvent) => closePopovers(e.target as Node);
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const menu = (document.activeElement as Element)?.closest<HTMLDetailsElement>('details[open]');
        closePopovers();
        menu?.querySelector<HTMLElement>('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const listener = () => setWidth(window.innerWidth);
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let current = true;
    setLoadedKey('');
    void api
      .invoke('reading_get', { key: readingKey })
      .then(r => {
        const featureScenario = !!scenarioId && scenarioId !== project?.overview_scenario_id;
        if (r) {
          const savedView = r.view;
          r = featureReadingPosition(modernReading(r));
          if (savedView === 'radar') {
            r = { ...r, view: 'engineering' };
          } else if (featureScenario && ['home', 'engineering', 'materials'].includes(r.view)) {
            r = { ...r, entrance: 'walk', view: 'timeline' };
          }
        }
        if (current) {
          const scope = projectId + '/' + scenarioId;
          const same = readingScope.current === scope;
          const requested = navigation.current?.scope === scope ? navigation.current.value : {};
          navigation.current = null;
          const entrance = scenarioId ? featureScenario ? 'walk' : 'overview' : emptyEntrance.current;
          const initialPosition = {
            entrance,
            view: entrance === 'overview' ? 'system' : featureScenario ? 'timeline' : 'capabilities',
            catalog_hidden: entrance === 'overview',
          } as const;
          setReading(previous => {
            const restored = same ? {
              ...previous,
              left_width: r?.left_width ?? defaults.left_width,
              right_width: r?.right_width ?? defaults.right_width,
              detail_tab: width >= 1280 && previous.detail_tab === 'source' ? 'details' : previous.detail_tab,
            } : {
              ...defaults, ...initialPosition, ...r,
              ...(!scenarioId && r?.entrance !== entrance ? initialPosition : {}),
              scenario_id: scenarioId,
            };
            return applyReadingPosition(restored, requested);
          });
          readingScope.current = scope;
          setLoadedKey(readingKey);
        }
      })
      .catch(e => setError(e.message));
    void api.invoke('reading_save', {
      key: 'last-session',
      value: { project_id: projectId, scenario_id: scenarioId, entrance: scenarioId && scenarioId !== project?.overview_scenario_id ? 'walk' : emptyEntrance.current },
    });
    return () => {
      current = false;
    };
  }, [readingKey, projectId, scenarioId]);

  useEffect(() => {
    if (!projectId || loadedKey !== readingKey) return;
    void api.invoke('reading_save', { key: 'project-session/' + projectId, value: { scenario_id: scenarioId, entrance: reading.entrance } }).catch(e => setError(e.message));
  }, [projectId, scenarioId, reading.entrance, loadedKey, readingKey]);

  useEffect(() => {
    if (loadedKey !== readingKey || !projectId) return;
    setSaved('保存中…');
    const timer = setTimeout(() => {
      void api
        .invoke('reading_save', { key: readingKey, value: reading })
        .then(() => setSaved('阅读位置已保存'))
        .catch(e => {
          setSaved('保存失败');
          setError(e.message);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      if (activeReadingKey.current !== readingKey) {
        void api.invoke('reading_save', { key: readingKey, value: reading }).catch(e => setError(e.message));
      }
    };
  }, [reading, readingKey, loadedKey, projectId]);

  useEffect(() => {
    if (!projectId || project?.fictional !== false) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      if (document.hidden) return;
      clearTimeout(timer);
      const delay = (freshnessChecks.current.get(projectId) ?? 0) + 5000 - Date.now();
      if (delay > 0) {
        timer = setTimeout(check, delay);
        return;
      }
      freshnessChecks.current.set(projectId, Date.now());
      void api.invoke('check_freshness', { project_id: projectId }).catch(error => {
        if (active) setError(error.message);
      });
    }
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const unsubscribe = api.onEvent(event => { if (event.type === 'window_focus') check(); });
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      unsubscribe();
    };
  }, [projectId, project?.fictional, project?.snapshot_id]);

  useEffect(() => {
    if (modal) {
      previousFocus.current = document.activeElement as HTMLElement;
      modalRef.current?.showModal();
      modalRef.current?.querySelector<HTMLInputElement>('input,textarea,button')?.focus();
    } else {
      modalRef.current?.close();
      previousFocus.current?.focus();
    }
  }, [modal]);

  useEffect(() => {
    if (!scenarioId || revealScenario.current !== scenarioId || loadedKey !== readingKey) return;
    const row = document.querySelector<HTMLElement>('.catalog .scene-row[aria-current="page"]');
    if (row) {
      const history = row.closest<HTMLDetailsElement>('details.historical-features');
      if (history) history.open = true;
      row.scrollIntoView({ block: 'nearest' });
      revealScenario.current = '';
    }
  }, [scenarioId, loadedKey, readingKey]);

  useEffect(() => {
    if (!result || reading.selected || featureReading || architectureReading || reading.view === 'functions') return;
    patch({ selected: (reading.view === 'timeline' ? timelineModel(result).ids[0] : result.nodes[0]?.node_id) || '' });
  }, [result?.result_id, reading.view, reading.selected, featureReading, architectureReading, patch]);

  useEffect(() => {
    const path = result?.function_walkthroughs?.find(p => p.id === (reading.function_path ?? reading.reading_path)) || result?.function_walkthroughs?.[0];
    const firstFunction = result?.nodes.find(n => n.node_id === path?.entry_node_id) || result?.nodes.find(n => n.kind === 'function');
    if (
      reading.view === 'functions' &&
      firstFunction &&
      !functionStep &&
      selectedNode?.kind !== 'function' &&
      !['sync_call', 'execution_boundary'].includes(selectedEdge?.kind || '')
    ) {
      patch({ selected: firstFunction.node_id });
    }
  }, [reading.view, result?.result_id, reading.selected, reading.reading_path, reading.function_path]);

  async function chooseProject(p: Project, workspace = data) {
    const request = ++projectSwitch.current;
    const last = await api.invoke('reading_get', { key: 'project-session/' + p.project_id }).catch(e => {
      setError(e.message);
      return null;
    });
    if (projectSwitch.current !== request) return;
    const savedScene = workspace.scenarios.find(s => s.scenario_id === last?.scenario_id && s.project_id === p.project_id && !s.archived);
    emptyEntrance.current = last?.entrance === 'walk' ? 'walk' : 'overview';
    navigation.current = null;
    setProjectId(p.project_id);
    setScenarioId(savedScene?.scenario_id || (last?.scenario_id === '' ? '' : p.overview_scenario_id || ''));
    setSearch('');
    setShowCatalog(false);
    setShowDetail(false);
  }

  async function restoreEngineering() {
    await action(async () => {
      const restored = await api.invoke('engineering_restore');
      if (!restored) return;
      const workspace = await reload();
      const p = workspace.projects.find(item => item.project_id === restored.project_id);
      if (p) {
        await chooseProject(p, workspace);
        navigation.current = { scope: p.project_id + '/' + (p.overview_scenario_id || ''), value: { entrance: 'overview', view: 'engineering' } };
        setModal('');
        setNotice('工程记录与证据已恢复，请绑定实际源码工作区。');
      }
    });
  }

  function chooseScenario(id: string, value?: Partial<ReadingState>) {
    setArchOverlay(null);
    const scene = data.scenarios.find(s => s.scenario_id === id);
    if (!value && (scene?.kind === 'feature_overview' || scene?.kind === 'breakdown')) {
      const graph = data.explanations.findLast(e => e.scenario_id === id && e.result.binding.question_revision_id === scene.question_revision_id && hasFunctionGraphs(e.result));
      if (graph) value = {
        entrance: 'walk', view: 'functions', function_mode: 'calls', function_path: firstGraphPath(graph.result),
        result_id: graph.result_id, source_snapshot_id: graph.result.binding.source_snapshot_id,
        mode: 'normal', detail_tab: 'details', selected: '', file: '', evidence_id: '', pinned: false,
      };
    }
    if (value) {
      if (id !== scenarioId) navigation.current = { scope: projectId + '/' + id, value };
      const position = value;
      if (position.entrance) emptyEntrance.current = position.entrance;
      if (id === scenarioId && reading.view === 'system' && position.scroll?.['canvas-system']?.top === 0) scrollArchitectureToTop();
      setReading(r => applyReadingPosition(r, position));
    }
    setScenarioId(id);
    setSearch('');
    setShowCatalog(false);
    setShowDetail(false);
  }

  function selectFunctionRelation(edgeId: string) {
    if (!result) return;
    if (reading.pinned) {
      setNotice('详情已固定。解除固定后可切换对象。');
      return;
    }
    const paths = result.function_walkthroughs ?? [];
    if (!paths.length) {
      select(edgeSelection(edgeId));
      return;
    }
    const current = reading.function_path ?? reading.reading_path ?? '';
    const find = (map: ReturnType<typeof functionCallMap>) => map.links.find(link => link.edgeIds.includes(edgeId));
    const currentLink = find(functionCallMap(result, current));
    if (currentLink) {
      select(currentLink.id);
      return;
    }
    for (const entry of paths) {
      const link = find(functionCallMap(result, entry.id));
      if (!link) continue;
      setReading(r => functionPathPosition({ ...r, scroll: { ...r.scroll, 'detail-functions-details': { top: 0, left: 0 } } }, result, entry.id, link.id));
      return;
    }
    setNotice('这条调用关系尚未纳入任何已记录入口，当前路径保持原位。');
  }

  function select(id: string) {
    if (!canSelectObject(id)) return;
    setReading(r => ({
      ...r,
      selected: id,
      ...(architectureReading || r.view === 'functions' ? { file: '', evidence_id: '' } : {}),
      ...(r.view === 'timeline' || r.view === 'functions' || systemReading
        ? { detail_tab: 'details', scroll: { ...r.scroll, [`detail-${r.view}-details`]: { top: 0, left: 0 } } }
        : {}),
    }));
    if (!id) {
      setShowDetail(false);
    } else if (detailDrawer || reading.view === 'functions') {
      previousFocus.current = document.activeElement as HTMLElement;
      setShowDetail(true);
    }
  }

  function canSelectObject(id: string) {
    if (!reading.pinned || reading.selected === id) return true;
    setNotice('详情已固定。解除固定后可切换对象。');
    return false;
  }

  function evidence(e: SourceEvidence) {
    patch({ mode: 'normal', file: e.path, evidence_id: e.evidence_id, source_snapshot_id: e.source_snapshot_id, detail_tab: 'evidence' });
    setShowDetail(featureReading || reading.view === 'functions' || detailDrawer);
  }

  function chooseFile(file: string, indexSnapshotId?: string) {
    if (featureReading) {
      readingFile(file);
      return;
    }
    const folders = file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
    if (indexSnapshotId) setSearch('');
    switchView('files', { file, evidence_id: '', selected: '', source_snapshot_id: indexSnapshotId || sourceSnapshotId, mode: 'normal', detail_tab: 'details',
      ...(indexSnapshotId && { files_open: true, expanded: [...new Set([...reading.expanded, ...folders])] }) });
    setShowCatalog(false);
    if (detailDrawer) setShowDetail(true);
  }

  function navigateFeature(view: string, focus = '') {
    setSearch('');
    switchView(view, { pinned: false, reading_focus: focus, scroll: { ...reading.scroll, [`canvas-${view}`]: { top: 0, left: 0 } } });
    setShowDetail(false);
    setShowCatalog(false);
  }

  function selectReading(key: string) {
    if (!canSelectObject(key)) return;
    if (detailDrawer && !showDetail) previousFocus.current = document.activeElement as HTMLElement;
    patch({
      selected: key,
      file: key.startsWith('file:') ? key.slice(5) : '',
      evidence_id: '',
      source_snapshot_id: result?.binding.source_snapshot_id || '',
      detail_tab: 'details',
      scroll: { ...reading.scroll, [`detail-${reading.view}-details`]: { top: 0, left: 0 } },
    });
    setShowDetail(true);
  }

  function readingFile(filePath: string) {
    if (!canSelectObject('file:' + filePath)) return;
    navigateFeature('files', reading.selected);
    patch({ selected: 'file:' + filePath, file: filePath });
    setShowDetail(true);
  }

  function readingStep(id: string) {
    if (!readingGuide || !result || !canSelectObject('step:' + id)) return;
    const stepPath = guidePathForStep(readingGuide, id);
    navigateFeature('timeline');
    setReading(r => ({ ...featurePathPosition(r, result, stepPath?.id || ''), selected: 'step:' + id }));
    setShowDetail(true);
  }

  function readingPath(id: string) {
    if (!result || !canSelectObject('')) return;
    setReading(r => featurePathPosition(r, result, id));
    setSearch('');
    setShowDetail(false);
  }

  function openModal(type: string, featureId?: string) {
    setFormName('');
    setFormQuestion('');
    if (featureId) setFormFeature(featureId);
    else if (type === 'scenario') setFormFeature(userFeatures.some(f => f.feature_id === scenario?.feature_id) ? scenario!.feature_id : userFeatures[0]?.feature_id || '');
    closePopovers();
    setModal(type);
  }

  function addFeatureFromScope(item: string) {
    const scope = item.replace(/^(?:本次未(?:展开|追踪)?|未展开|未追踪)的?[\s：:，,]*/, '');
    const title = scope.split(/[，,。；;：:！？!?\n]|\.\s/, 1)[0].trim();
    setFormName(Array.from(title || item).slice(0, 24).join('').trimEnd());
    setFormQuestion(`补充分析以下未覆盖模块或能力的核心入口、处理流程与函数调用链：${item}`);
    setModal('feature');
  }

  async function openLocalProject(analyze: boolean) {
    const switchVersion = projectSwitch.current;
    const p = await api.invoke<Project>('open_project_path', { path: formName.trim() });
    let target = '';
    let needsConnection = false;
    try {
      const workspace = await reload();
      const hasReading =
        workspace.explanations.some(e => e.result.binding.project_id === p.project_id) ||
        workspace.runs.some(r => r.binding.project_id === p.project_id && !r.reading_question_id) ||
        waitingForAgent(workspace, p.overview_scenario_id || '');
      if (analyze && !hasReading) {
        needsConnection = expandMode === 'codex_desktop' && !(await desktopReady(p.project_id));
        if (!needsConnection) {
          target = (await api.invoke<Scenario>('overview_create', { project_id: p.project_id })).scenario_id;
          await api.invoke('run_start', { scenario_id: target, mode: expandMode, submission_key: crypto.randomUUID() });
        }
      }
    } finally {
      const workspace = await reload();
      if (projectSwitch.current === switchVersion) {
        await chooseProject(workspace.projects.find(item => item.project_id === p.project_id)!, workspace);
        if (target && projectSwitch.current === switchVersion + 1) {
          emptyEntrance.current = 'overview';
          if (p.project_id === projectId && target === scenarioId) {
            chooseScenario(target, overviewLanding);
          } else {
            navigation.current = { scope: p.project_id + '/' + target, value: overviewLanding };
            setScenarioId(target);
          }
        }
      }
      if (needsConnection && projectSwitch.current === switchVersion + 1) showDesktop();
      else setModal('');
    }
  }

  async function submitForm(e: React.FormEvent, analyze = true) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      await action(async () => {
        if (modal === 'feature') {
          const r = await api.invoke('feature_add', { project_id: projectId, name: formName, question: formQuestion });
          await reload();
          setScenarioId(r.scenario.scenario_id);
        }
        if (modal === 'scenario') {
          const r = await api.invoke('scenario_add', { feature_id: formFeature, question: formQuestion });
          await reload();
          setScenarioId(r.scenario_id);
        }
        if (modal === 'revise') await api.invoke('scenario_revise', { scenario_id: scenarioId, question: formQuestion });
        if (modal === 'featureRename') await api.invoke('organize', { kind: 'feature', id: renameFeature, patch: { name: formName } });
        if (modal === 'rename') await api.invoke('organize', { kind: 'scenario', id: scenarioId, patch: { title: formName } });
        if (modal === 'open') {
          await openLocalProject(analyze);
          return;
        }
        if (modal === 'build') await api.invoke('refresh', { project_id: projectId, build_config: formQuestion });
        setModal('');
        setNotice('已保存');
        await reload();
      });
    } finally {
      setPending(false);
    }
  }

  function setAnalysisMode(mode: AnalysisMode) {
    if (pending || mode === expandMode) return;
    setPending(true);
    void action(async () => {
      await api.invoke('default_engine_save', { mode });
      await reload();
    }).finally(() => setPending(false));
  }

  async function saveCodexPreferences(changes: Partial<CodexPreferences>) {
    setPending(true);
    try {
      return !!await action(async () => {
        await api.invoke('codex_preferences_save', { ...data.codex_preferences, ...changes });
        await reload();
        return true;
      });
    } finally {
      setPending(false);
    }
  }
  const codexModel = { catalog: data.codex_models, model: data.codex_preferences.model,
    onModelChange: (model: string) => saveCodexPreferences({ model }) };

  async function desktopReady(id: string) {
    const { binding, authorized, workspace_matches } = await api.invoke('executor_status', { project_id: id });
    return binding && authorized && workspace_matches;
  }

  async function requestAnalysis(overview = false, refreshFirst = false) {
    if (starting.current || pending || running || !project) return;
    starting.current = true;
    setPending(true);
    const readingAtStart = activeReadingKey.current;
    const keepFunctions = !overview && (reading.view === 'functions' || !!preview);
    try {
      await action(async () => {
        if (expandMode === 'codex_desktop' && !(await desktopReady(projectId))) {
          showDesktop();
          return;
        }
        const target = overview ? (await api.invoke<Scenario>('overview_create', { project_id: projectId })).scenario_id : scenarioId;
        if (refreshFirst) await api.invoke('refresh', { project_id: projectId });
        await api.invoke('run_start', { scenario_id: target, mode: expandMode, submission_key: crypto.randomUUID() });
        await reload();
        if (activeReadingKey.current !== readingAtStart) return;
        chooseScenario(target, {
          ...(overview ? overviewLanding : { entrance: 'walk', view: keepFunctions ? 'functions' : 'timeline' }),
          detail_tab: expandMode === 'mcp' || expandMode === 'codex_desktop' ? 'agent' : 'details',
          mode: 'normal',
          ...(refreshFirst ? { result_id: '', source_snapshot_id: '', selected: '', file: '', evidence_id: '', reading_path: '', function_path: '' } : {}),
        });
      });
    } finally {
      starting.current = false;
      setPending(false);
    }
  }

  async function researchOverview() {
    if (starting.current || pending || projectTasks.length || !result || !overviewReviewGaps.length || project?.fictional || indexes[projectId]) return;
    const resultId = result.result_id;
    const key = activeReadingKey.current;
    const switchVersion = projectSwitch.current;
    starting.current = true;
    setPending(true);
    patch({ result_id: resultId });
    showRun();
    try {
      await action(async () => {
        await api.invoke<Run>('overview_research', { result_id: resultId, submission_key: crypto.randomUUID() });
        await reload();
        if (activeReadingKey.current === key && projectSwitch.current === switchVersion) setNotice('已在 ARC 内启动关系补查；当前说明和阅读位置保留。');
      });
    } finally {
      starting.current = false;
      setPending(false);
    }
  }

  function openTask(sceneId: string) {
    const s = data.scenarios.find(item => item.scenario_id === sceneId);
    if (!s) return;
    chooseScenario(sceneId, {
      ...(sceneId === project?.overview_scenario_id ? overviewLanding : { entrance: 'walk', view: 'timeline' }),
      mode: 'normal',
      detail_tab: 'agent',
      result_id: '',
    });
  }

  function viewCompleted() {
    if (!completedExplanation) return;
    patch({
      scroll: { ...reading.scroll, [`canvas-${reading.view}`]: { top: 0, left: 0 }, [`detail-${reading.view}-details`]: { top: 0, left: 0 } },
      result_id: completedExplanation.result_id,
      reading_path: '',
      function_path: '',
      reading_focus: '',
      selected: '',
      file: '',
      evidence_id: '',
      source_snapshot_id: completedExplanation.result.binding.source_snapshot_id,
      detail_tab: 'details',
      mode: 'normal',
      pinned: false,
    });
    if (detailDrawer) setShowDetail(false);
  }

  function viewFeatureResult(resultId: string) {
    const next = sceneExplanations.find(item => item.result_id === resultId);
    if (!next) return;
    patch({
      result_id: next.result_id,
      reading_path: '',
      function_path: '',
      reading_focus: '',
      selected: '',
      file: '',
      evidence_id: '',
      source_snapshot_id: next.result.binding.source_snapshot_id,
      detail_tab: 'details',
      mode: 'normal',
      pinned: false,
    });
    if (detailDrawer) setShowDetail(false);
  }

  function returnToFeature(task: EngineeringTask) {
    const binding = task.reading;
    if (!binding) return;
    const original = data.explanations.find(
      item => item.result_id === binding.result_id && item.scenario_id === binding.scenario_id && item.result.binding.source_snapshot_id === binding.source_snapshot_id,
    );
    const anchor = binding.evidence;
    const source =
      anchor &&
      original?.result.evidence.find(
        item =>
          item.evidence_id === anchor.evidence_id &&
          item.source_snapshot_id === binding.source_snapshot_id &&
          item.path === anchor.path &&
          item.line_start === anchor.line_start &&
          item.line_end === anchor.line_end,
      );
    const latest = data.explanations.find(item => item.result_id === task.walkthrough?.result_id && item.scenario_id === binding.scenario_id);
    const savedExp = anchor || binding.target.kind !== 'feature' ? original : latest ?? original;
    const position: Partial<ReadingState> = {
      entrance: 'walk',
      view: 'timeline',
      mode: 'normal',
      detail_tab: 'details',
      result_id: savedExp?.result_id ?? binding.result_id,
      source_snapshot_id: savedExp?.result.binding.source_snapshot_id ?? binding.source_snapshot_id,
      selected: '',
      reading_path: '',
      function_path: '',
      reading_focus: '',
      file: '',
      evidence_id: '',
      pinned: false,
    };
    if (savedExp) Object.assign(position, walkthroughSelection(savedExp.result, binding.target));
    if (source) Object.assign(position, { detail_tab: 'evidence', file: source.path, evidence_id: source.evidence_id });
    chooseScenario(binding.scenario_id, position);
    if (source || position.selected) setShowDetail(true);
  }

  function openFeatureTask(taskId: string) {
    setRequestedTask(taskId);
    switchView('engineering', { mode: 'normal', catalog_hidden: true });
  }

  function refreshMcp() {
    void api.invoke('mcp_status').then(setMcp).catch(e => setConnectionError('读取 MCP 状态失败：' + (e as Error).message));
  }

  function showMcp() {
    closePopovers();
    setError('');
    setNotice('');
    setConnectionError('');
    setOpenDesktop(false);
    setModal('settings');
    void api.invoke('settings').then(setSettings).catch(e => setConnectionError('读取应用设置失败：' + (e as Error).message));
    refreshMcp();
  }

  function showDesktop() {
    showMcp();
    setOpenDesktop(true);
  }

  function askHere() {
    patch({ detail_tab: 'questions' });
    setShowDetail(true);
    requestAnimationFrame(() => document.getElementById('reading-question-input')?.focus());
  }

  function showRun() {
    setReading(r => ({ ...r, detail_tab: 'agent', scroll: { ...r.scroll, [`detail-${r.view}-agent`]: { top: 0, left: 0 } } }));
    setActivityFocus(n => n + 1);
    setShowDetail(walkthroughInspector || detailDrawer);
  }

  const analysisLabel = pending
    ? '正在提交…'
    : running
      ? `${statuses[running.status]} · 查看任务`
      : waitingMcp
        ? expandMode === 'mcp'
          ? '查看待领取任务'
          : '改用 ' + analysisMode.name + ' 分析'
        : catalogReading
          ? catalogExplanation
            ? '更新工程全貌与目录'
            : '发现工程功能'
          : reading.entrance === 'overview'
            ? result
              ? '重新分析工程'
              : '开始工程分析'
            : scenario?.kind === 'feature_overview'
              ? result
                ? '重新分析功能'
                : preview
                  ? '深入分析功能'
                  : '开始功能分析'
              : scenario?.kind === 'breakdown'
                ? result ? '重新生成场景双图' : '生成场景双图'
              : scenario
                ? result
                  ? '重新分析场景'
                  : '开始场景分析'
                : '添加功能';

  const beginAnalysis = () =>
    running || (waitingMcp && expandMode === 'mcp')
      ? showRun()
      : catalogReading || overview
        ? void requestAnalysis(true, true)
        : reading.entrance === 'walk' && !scenario
          ? openModal('feature')
          : void requestAnalysis();

  async function revalidateFunctionRun(run: Run) {
    if (starting.current || pending || running) return;
    starting.current = true;
    setPending(true);
    try {
      await action(() => api.invoke('run_revalidate', { run_id: run.binding.run_id }));
      await reload();
    } finally {
      starting.current = false;
      setPending(false);
    }
  }

  const canRevalidate =
    previewRun?.status === 'failed' &&
    !previewRun.overview_format &&
    previewRun.provider_id === 'codex' &&
    !previewRun.dsh_overview_format &&
    !previewRun.dsh_function_format;
  const needsFunctionGraphs = (!!preview && !previewGraphs?.ready) ||
    (reading.entrance === 'walk' && reading.view === 'functions' && !!result && !result.function_walkthroughs?.length);
  const generateLabel = expandMode === 'mcp' ? '准备函数双图任务' : '生成函数调用链与时间图';
  const graphPending = activityRun && ['queued', 'waiting_agent', 'running', 'validating', 'cancel_requested'].includes(activityRun.status);
  const graphWaiting = preview ? previewGraphs?.status === '等待领取' : waitingMcp;

  const manualGraphActions = (
    <>
      {canRevalidate && (
        <div>
          <p>上次功能分析未通过校验。</p>
          <button disabled={pending || !!running} onClick={() => void revalidateFunctionRun(previewRun)}>
            重新校验已收原文
          </button>
        </div>
      )}
      {(featureSource?.result || result)?.binding.source_snapshot_id !== project?.snapshot_id && <p>新分析将使用当前工程的冻结快照。</p>}
      <button className="primary analysis-start" disabled={pending || !!running || project?.fictional || !!indexes[projectId]} onClick={() => void requestAnalysis()}>
        {pending ? '正在提交…' : generateLabel}
      </button>
    </>
  );

  const graphActions = needsFunctionGraphs && (
    <section className="catalog-graph-actions" aria-label="当前功能的深入分析">
      {automaticRun ? (
        <p role="status">本轮工程分析已包含此功能 · {previewGraphs?.status || '已结束'}。</p>
      ) : (
        <p>{analysisMode.name} 将沿冻结源码核对函数调用和执行顺序。</p>
      )}
      {graphPending || graphWaiting ? (
        <div className="row">
          {!automaticRun && <span role="status">{graphPending && activityRun ? statuses[activityRun.status] || activityRun.status : '等待 Agent 领取'}</span>}
          <button onClick={showRun}>{activityRun?.status === 'waiting_agent' || !graphPending ? '查看待领取任务' : '查看当前功能分析进度'}</button>
          {!running && waitingMcp && expandMode !== 'mcp' && !automaticRun && (
            <button disabled={pending || project?.fictional || !!indexes[projectId]} onClick={() => void requestAnalysis()}>
              {generateLabel}
            </button>
          )}
        </div>
      ) : automaticRun ? (
        <details>
          <summary>手动补查或重试</summary>
          {manualGraphActions}
        </details>
      ) : (
        manualGraphActions
      )}
      {automaticRun && previewGraphs?.latest && !previewGraphs.ready && (
        <button onClick={() => viewFeatureResult(previewGraphs.latest!.result_id)}>查看已有分析依据</button>
      )}
    </section>
  );

  const analysisButton = !needsFunctionGraphs && (
    <button className="primary analysis-start" disabled={pending || project?.fictional || !!indexes[projectId]} onClick={beginAnalysis}>
      {analysisLabel}
    </button>
  );
  const analysisMenu = (
    <details className="analysis-options">
      <summary>分析方式 · {analysisMode.name}{expandMode === 'codex' && codexModel.model &&
        <small className="analysis-selected-model" title={codexModel.model}>{codexModel.model}</small>}</summary>
      <div className="popover-content">
        <AnalysisModePicker label="分析运行方式" mode={expandMode} setMode={setAnalysisMode} />
        {expandMode === 'codex' && <label>Codex 模型
          <CodexModelSelect {...codexModel} label="Codex 模型" disabled={pending}/>
        </label>}
        <button onClick={showMcp}>连接 Agent</button>
        <p>{analysisMode.description}</p>
      </div>
    </details>
  );

  function setEntrance(entrance: 'overview' | 'walk') {
    emptyEntrance.current = entrance;
    if (entrance === 'overview') {
      chooseScenario(project?.overview_scenario_id || '', overviewLanding);
    } else {
      chooseScenario('', { entrance, view: 'capabilities', mode: 'normal', catalog_hidden: true });
    }
  }

  function openWorkbench(view: WorkbenchView) {
    if (!project) {
      openModal('open');
      return;
    }
    if (view === 'overview' || view === 'walk') {
      setEntrance(view);
      return;
    }
    switchView(view, { mode: 'normal', catalog_hidden: true });
  }

  async function openCapability(nodeId: string, catalog = catalogExplanation) {
    if (starting.current || !catalog) return;
    starting.current = true;
    setPending(true);
    try {
      await action(async () => {
        const requestedProject = projectSwitch.current;
        const opened = await api.invoke('feature_open', { project_id: projectId, result_id: catalog.result_id, node_id: nodeId, request_mcp: false });
        const workspace = await reload();
        if (requestedProject !== projectSwitch.current) return;
        const graph = catalogGraphState(workspace, catalog, nodeId);
        const automatic = !!graph.run?.overview_parent_run_id;
        const report = graph.ready ?? (!automatic ? graph.latest : undefined);
        emptyEntrance.current = 'walk';
        chooseScenario(opened.scenario.scenario_id, {
          entrance: 'walk',
          view: graph.ready || automatic ? 'functions' : 'timeline',
          mode: 'normal',
          result_id: report?.result_id || catalog.result_id,
          selected: '',
          file: '',
          evidence_id: '',
          reading_path: '',
          function_path: graph.ready ? firstGraphPath(graph.ready.result) : '',
          function_mode: 'calls',
          reading_focus: '',
          source_snapshot_id: report?.result.binding.source_snapshot_id || catalog.result.binding.source_snapshot_id,
          detail_tab: 'details',
          catalog_hidden: true,
          pinned: false,
        });
      });
    } finally {
      starting.current = false;
      setPending(false);
    }
  }

  async function fillPending(nodeIds: string[]) {
    if (starting.current || pending || !catalogExplanation || expandMode === 'mcp') return;
    starting.current = true;
    setPending(true);
    try {
      await action(async () => {
        if (expandMode === 'codex_desktop' && !(await desktopReady(projectId))) {
          showDesktop();
          return;
        }
        const failures: string[] = [];
        for (const nodeId of nodeIds) {
          try {
            const { scenario } = await api.invoke<{ scenario: Scenario }>('feature_open', { project_id: projectId, result_id: catalogExplanation.result_id, node_id: nodeId, request_mcp: false });
            await api.invoke('run_start', { scenario_id: scenario.scenario_id, mode: expandMode, submission_key: crypto.randomUUID() });
          } catch (error) {
            const label = catalogExplanation.result.nodes.find(node => node.node_id === nodeId)?.label || nodeId;
            failures.push(`${label}：${(error as Error).message}`);
          }
        }
        await reload();
        if (failures.length) throw Error(`部分双图任务提交失败：${failures.join('；')}`);
      });
    } finally {
      starting.current = false;
      setPending(false);
    }
  }

  async function cancelQueued(runIds: string[]) {
    if (starting.current || pending || !runIds.length) return;
    starting.current = true;
    setPending(true);
    try {
      await action(async () => {
        const failures: string[] = [];
        for (const run_id of runIds) {
          try {
            await api.invoke('run_cancel', { run_id, queued_only: true });
          } catch (error) {
            failures.push(`${run_id}：${(error as Error).message}`);
          }
        }
        await reload();
        if (failures.length) throw Error(`取消排队失败（${failures.length}/${runIds.length}）：${failures.join('；')}`);
      });
    } finally {
      starting.current = false;
      setPending(false);
    }
  }

  const changeWidth = (side: 'left_width' | 'right_width', amount: number) =>
    patch({
      [side]: Math.min(
        side === 'left_width' ? 300 : Math.max(280, width - (reading.mode === 'source' ? 820 : reading.left_width + 480)),
        Math.max(side === 'left_width' ? 200 : 280, reading[side] + amount),
      ),
    });

  const featureOpen = (id: string) => reading.expanded.includes('feature-open/' + id) || (!reading.expanded.includes('feature-closed/' + id) && scenario?.feature_id === id);
  function toggleFeature(id: string) {
    const open = featureOpen(id);
    patch({ expanded: [...reading.expanded.filter(v => v !== 'feature-open/' + id && v !== 'feature-closed/' + id), (open ? 'feature-closed/' : 'feature-open/') + id] });
  }

  const functionViewMode = reading.function_mode ?? 'calls';
  const functionTabs = [['functions:calls', '函数调用链'], ['functions:time', '调用时间图']];
  const previewTab = ['timeline', '功能说明'];
  const availableFeatureViews = featureViews.filter(([view]) => view !== 'collaboration' || hasCollaboration);
  const featureTabs = preview
    ? previewGraphs?.ready ? [...functionTabs, previewTab] : [previewTab, ...functionTabs]
    : reading.entrance === 'walk' && !catalogReading && !engineeringReading && scenario && result && featureViews.some(([view]) => view === reading.view)
      ? [...functionTabs, ...availableFeatureViews.filter(([view]) => view !== 'functions')]
      : undefined;
  const activeFeatureTab = reading.view === 'functions' ? `functions:${functionViewMode}` : reading.view;
  const workspaceTabs = overview && !engineeringReading ? overviewTabs : featureTabs;
  const activeTab = overview && reading.view === 'modules' ? 'system' : activeFeatureTab;
  const currentView = (workspaceTabs ?? featureViews).find(([view]) => view === (workspaceTabs ? activeTab : reading.view))?.[1] || (preview ? '功能说明' : '当前视图');

  function navigateFeatureTab(tab: string) {
    if (tab === activeFeatureTab) return;
    if (tab === 'functions:calls' || tab === 'functions:time') {
      const function_mode = tab === 'functions:time' ? 'time' : 'calls';
      if (preview) patch({ view: 'functions', function_mode });
      else {
        if (reading.view !== 'functions') navigateFeature('functions');
        patch({ function_mode });
      }
    } else if (preview) patch({ view: tab });
    else navigateFeature(tab);
  }

  function navigateView(view: string) {
    if (view === 'capabilities') {
      setEntrance('walk');
      return;
    }
    if (featureReading) {
      navigateFeature(view);
      return;
    }
    switchView(view, { mode: 'normal' });
    setShowCatalog(false);
  }

  function resumeHomeReading() {
    if (!bookmark || !canResume) return;
    if (isLegacyOverview(bookmark.position)) {
      chooseScenario(bookmark.position.scenario_id, {
        ...overviewLanding, result_id: bookmark.position.result_id, source_snapshot_id: bookmark.position.source_snapshot_id,
      });
      return;
    }
    chooseScenario(bookmark.position.scenario_id, {
      ...bookmark.position, mode: 'normal', catalog_hidden: true, pinned: false,
      ...(bookmark.position.view === 'system' && { scroll: overviewLanding.scroll }),
    });
    setShowDetail(!bookmark.catalogNodeId && (detailDrawer || bookmark.position.entrance === 'walk'));
  }

  function openSuggestedStep(last: boolean, showSource = false) {
    if (!suggestedPath) return;
    const { saved: savedExp, path, first, last: finalStep } = suggestedPath;
    const step = last ? finalStep : first;
    const source = showSource ? savedExp.result.evidence.find(e => step.evidence_ids.includes(e.evidence_id)) : undefined;
    chooseScenario(savedExp.scenario_id, {
      entrance: 'walk',
      view: 'timeline',
      result_id: savedExp.result_id,
      source_snapshot_id: savedExp.result.binding.source_snapshot_id,
      reading_path: path.id,
      selected: 'step:' + step.id,
      reading_focus: '',
      function_path: '',
      detail_tab: source ? 'evidence' : 'details',
      file: source?.path || '',
      evidence_id: source?.evidence_id || '',
      mode: 'normal',
      catalog_hidden: true,
      pinned: false,
    });
    setShowDetail(true);
  }

  function openArchitecture(objectId = '') {
    const object = paneResult?.nodes.find(node => node.node_id === objectId) ?? paneResult?.edges.find(edge => edge.edge_id === objectId);
    const firstEvidence = paneResult?.evidence.find(item => object?.evidence_ids.includes(item.evidence_id));
    setSearch('');
    setShowCatalog(false);
    setShowDetail(!!object && detailDrawer);
    scrollArchitectureToTop();
    switchView('system', {
      mode: 'normal',
      catalog_hidden: true,
      selected: objectId,
      pinned: false,
      result_id: result?.result_id || '',
      detail_tab: firstEvidence ? 'evidence' : 'details',
      file: firstEvidence?.path || '',
      evidence_id: firstEvidence?.evidence_id || '',
      source_snapshot_id: paneResult?.binding.source_snapshot_id || '',
      scroll: { ...reading.scroll, 'canvas-system': { top: 0, left: 0 }, 'detail-system-evidence': { top: 0, left: 0 } },
    });
  }

  function inspectComponent(id: string) {
    switchView('modules', {
      stage: id,
      selected: id,
      mode: 'normal',
      detail_tab: 'details',
      expanded: [...new Set([...reading.expanded, 'composition/' + id])],
      scroll: { ...reading.scroll, 'canvas-modules': { top: 0, left: 0 }, 'detail-modules-details': { top: 0, left: 0 } },
    });
  }

  const development =
    project && walkthroughInspector && result && scenario ? {
      open: featureDraft.editing,
      toggle: () => updateFeatureDraft({ editing: !featureDraft.editing }),
      content: <FeatureDevelopment
        key={developmentKey}
        defaultEngine={expandMode}
        project={project}
        scenario={scenario}
        result={result}
        target={questionLocation.target}
        evidence={developmentEvidence}
        task={featureTask}
        draft={featureDraft}
        onDraft={updateFeatureDraft}
        reload={reload}
        onViewResult={viewFeatureResult}
        onOpenTask={openFeatureTask}
        onOpenComposer={draft => {
          setComposerDraft(draft);
          setFocusDevelopment(true);
          switchView('engineering', { mode: 'normal', catalog_hidden: true });
        }}
      />,
    } : undefined;

  const catalog = walkNavigation && (
    <CatalogSidebar
      data={data}
      project={project}
      catalogExplanation={catalogExplanation}
      projectFreshness={projectFreshness}
      projectId={projectId}
      scenarioId={scenarioId}
      reading={reading}
      loadedKey={loadedKey}
      catalogReading={catalogReading}
      preview={preview}
      featureTabs={featureTabs}
      availableViews={availableFeatureViews}
      archiveVisible={archiveVisible}
      setArchiveVisible={setArchiveVisible}
      featureOpen={featureOpen}
      toggleFeature={toggleFeature}
      navigateView={navigateView}
      setEntrance={setEntrance}
      chooseScenario={chooseScenario}
      onHide={() => {
        patch({ catalog_hidden: true });
        setShowCatalog(false);
      }}
      onOpenFeatureModal={() => openModal('feature')}
      onAddScenario={id => openModal('scenario', id)}
      onBreakdown={id => openModal('breakdown', id)}
      onRenameFeature={feature => {
        setRenameFeature(feature.feature_id);
        setFormName(feature.name);
        setModal('featureRename');
      }}
      savePosition={savePosition}
      action={action}
    />
  );

  const detail = (
    <DetailPane
      editor={maintainedView ? architecture : undefined}
      data={data}
      project={project}
      projectId={projectId}
      scenario={scenario}
      scenarioId={scenarioId}
      currentFeature={currentFeature}
      reading={reading}
      loadedKey={loadedKey}
      activityFocus={activityFocus}
      analysisScope={analysisScope}
      analysisLabel={analysisLabel}
      analysisMode={analysisMode}
      featurePurpose={featurePurpose}
      featureReading={featureReading}
      walkthroughInspector={walkthroughInspector}
      businessReading={businessReading}
      systemReading={systemReading}
      architectureReading={architectureReading}
      detailDrawer={detailDrawer}
      needsFunctionGraphs={needsFunctionGraphs}
      waitingMcp={waitingMcp}
      pending={pending}
      indexes={indexes}
      result={paneResult}
      readingGuide={readingGuide}
      readingEvidence={readingEvidence}
      selectedNode={selectedNode}
      selectedEdge={selectedEdge}
      selectedCall={selectedCall}
      functionStep={functionStep}
      activeObject={activeObject}
      sourceSnapshot={sourceSnapshot}
      selectedFile={selectedFile}
      selectedEvidence={selectedEvidence}
      development={development}
      overviewReviewGaps={overviewReviewGaps}
      sceneAnnotations={sceneAnnotations}
      sceneExplanations={sceneExplanations}
      sceneRuns={sceneRuns}
      running={running}
      activityRun={activityRun}
      completedExplanation={completedExplanation}
      events={events}
      eventError={eventError}
      questionLocation={questionLocation}
      clue={clue}
      setClue={setClue}
      patch={patch}
      setShowDetail={setShowDetail}
      savePosition={savePosition}
      select={select}
      selectFunctionRelation={selectFunctionRelation}
      evidence={evidence}
      readingFile={readingFile}
      readingStep={readingStep}
      inspectComponent={inspectComponent}
      openFeature={id => void openCapability(id, projected ? architectureSource : explanation)}
      askHere={askHere}
      showRun={showRun}
      reload={reload}
      showMcp={showMcp}
      showDesktop={showDesktop}
      viewCompleted={viewCompleted}
      requestAnalysis={requestAnalysis}
      action={action}
    />
  );

  function proposeRequirement() {
    setFocusDevelopment(true);
    switchView('engineering', { mode: 'normal', catalog_hidden: true });
  }

  const featureContextOptions: FeatureContextOption[] = project
    ? data.scenarios
        .filter(s => s.project_id === project.project_id && s.scenario_id !== project.overview_scenario_id)
        .flatMap(s => {
          const latest = data.explanations
            .filter(e => e.scenario_id === s.scenario_id)
            .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
            .at(-1);
          if (!latest) return [];
          const firstEvidence = latest.result.evidence[0];
          return [{
            scenarioId: s.scenario_id,
            label: s.title,
            reading: {
              feature_id: s.feature_id,
              scenario_id: s.scenario_id,
              result_id: latest.result_id,
              source_snapshot_id: latest.result.binding.source_snapshot_id,
              target: { kind: 'feature', id: s.feature_id },
              ...(firstEvidence ? { evidence: firstEvidence } : {}),
            },
          }];
        })
    : [];

  const overviewSections = overviewSectionsVisible && project && (
    <EngineeringOverviewSections
      key={project.project_id}
      businessPath={suggestedPath}
      onBusinessStep={openSuggestedStep}
      resumeLabel={
        canResume && bookmark ? bookmark.label + (bookmark.position.source_snapshot_id !== project.snapshot_id ? ' · 历史版本' : '') : ''
      }
      onResume={resumeHomeReading}
      project={project}
      result={paneResult}
      onArchitecture={openArchitecture}
      onWalk={() => setEntrance('walk')}
      onFiles={() => navigateView('files')}
      onMaterials={() => switchView('materials', { mode: 'normal', catalog_hidden: true })}
      onTask={id => {
        setRequestedTask(id);
        switchView('engineering', { mode: 'normal', catalog_hidden: true });
      }}
    />
  );

  const canvas = (
    <CanvasPane
      editor={maintainedView ? architecture : undefined}
      architectureResult={projected}
      overviewSections={overviewSections}
      data={data}
      project={project}
      freshness={freshness}
      refreshAndAnalyze={() => void requestAnalysis(catalogReading || scenarioId === project?.overview_scenario_id, true)}
      projectId={projectId}
      scenario={scenario}
      snapshot={snapshot}
      sourceSnapshot={sourceSnapshot}
      reading={reading}
      setReading={setReading}
      showModeSwitch={!featureTabs}
      patch={patch}
      loadedKey={loadedKey}
      search={search}
      setSearch={setSearch}
      pending={pending}
      indexes={indexes}
      expandMode={expandMode}
      catalogReading={catalogReading}
      catalogExplanation={catalogExplanation}
      capabilityCount={capabilityCount}
      featureReading={featureReading}
      readingGuide={readingGuide}
      featurePurpose={featurePurpose}
      explanation={explanation}
      result={result}
      overviewRun={overviewRun}
      discovery={discovery}
      graphCatalog={graphCatalog}
      featureSource={featureSource}
      preview={preview}
      graphActions={graphActions}
      selectedFile={selectedFile}
      waitingMcp={waitingMcp}
      running={running}
      latestRun={latestRun}
      savePosition={savePosition}
      openCapability={openCapability}
      addFeatureFromScope={addFeatureFromScope}
      fillPending={fillPending}
      cancelQueued={ids => void cancelQueued(ids)}
      requestAnalysis={requestAnalysis}
      readingPath={readingPath}
      selectReading={selectReading}
      navigateFeature={navigateFeature}
      readingStep={readingStep}
      chooseFile={chooseFile}
      select={select}
      switchView={switchView}
      navigateView={navigateView}
      inspectComponent={inspectComponent}
      evidence={evidence}
      showMcp={showMcp}
      taskOverlay={
        archOverlay && scenarioId === project?.overview_scenario_id && (!archOverlay.resultId || result?.result_id === archOverlay.resultId)
          ? {
              ...archOverlay,
              onClear: () => setArchOverlay(null),
              onReturnTask: () => {
                const taskId = archOverlay.taskId;
                setArchOverlay(null);
                setRequestedTask(taskId);
                switchView('engineering', { mode: 'normal', catalog_hidden: true });
              },
            }
          : null
      }
    />
  );

  const modalTitles: Record<string, string> = {
    feature: '添加功能',
    scenario: '添加场景',
    breakdown: '细化拆分子场景',
    revise: '编辑问题 · 新建修订',
    featureRename: '重命名功能',
    rename: '重命名场景',
    open: '打开工程',
    build: '构建条件',
    settings: '连接 Agent',
  };

  const navToggle = (
    <button
      className="icon nav-toggle"
      aria-label={width >= 900 && !reading.catalog_hidden ? '隐藏目录' : '显示目录'}
      aria-expanded={width >= 900 ? !reading.catalog_hidden : showCatalog}
      aria-controls="workspace-navigation"
      title={width >= 900 && !reading.catalog_hidden ? '隐藏导航' : '显示导航'}
      onClick={() => {
        if (width >= 900) patch({ catalog_hidden: !reading.catalog_hidden });
        else {
          patch({ catalog_hidden: false });
          setShowCatalog(!showCatalog);
        }
      }}
    >
      <svg className="arc-ui-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M6 2.5v11" />
      </svg>
    </button>
  );

  const boundSnapshotId = result?.binding.source_snapshot_id || project?.snapshot_id || '';
  const refreshSource = () => void action(() => api.invoke('refresh', { project_id: projectId }), '已冻结新快照；历史说明保留原来源');
  const sourceOptions = (
    <details className="source-options">
      <summary>资料与来源</summary>
      <div className="popover-content">
        <span className="source-badge" title={boundSnapshotId}>
          来源 {short(boundSnapshotId)}
        </span>
        <button onClick={refreshSource}>刷新来源</button>
      </div>
    </details>
  );


  return (
    <div className={`arc-workbench${railCollapsed ? ' is-rail-collapsed' : ''}`}>
      <WorkbenchNavigation
        projects={data.projects}
        projectId={projectId}
        active={reading.view === 'materials' ? 'materials' : engineeringReading ? 'engineering' : reading.entrance === 'walk' ? 'walk' : 'overview'}
        collapsed={railCollapsed}
        onToggleCollapse={() => setRailCollapsed(v => !v)}
        onProject={id => {
          const p = data.projects.find(item => item.project_id === id);
          if (p) void chooseProject(p);
        }}
        onOpen={() => openModal('open')}
        onSettings={showMcp}
        onNavigate={openWorkbench}
      />
      <div
        className={`app reading-shell ${engineeringReading ? 'engineering-active' : ''} ${
          featureReading ? 'feature-reader' : businessReading ? 'business-reader' : systemReading ? 'system-reader' : ''
        }`}
      >
        {indexTasks.map(task => (
          <div key={task.project_id} className="index-status" role="status">
            <span title={task.root_path}>
              正在索引 {task.project_name || task.project_id} · 已读取 {task.count} 个文本文件 · 快照尚未完成
              {projectId && task.project_id !== projectId ? '（另一个工程）' : ''}
            </span>
            <button onClick={() => void api.invoke('index_cancel', { project_id: task.project_id })}>取消索引</button>
          </div>
        ))}
        {error && (
          <div role="alert" className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError('')}>关闭</button>
          </div>
        )}
        {notice && !indexTasks.length && (
          <div role="status" className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice('')}>×</button>
          </div>
        )}

        {!project ? (
          <main className="welcome">
            <span className="eyebrow">ARC / LOCAL WORKSPACE</span>
            <h1>看清工程。读懂一条真实路径。</h1>
            <p>选择工程后，在 ARC 内完成分析、看图和追问。结论可追溯，历史保存在本机。</p>
            <div className="row">
              <button className="primary" onClick={() => openModal('open')}>
                打开并理解工程
              </button>
              <button onClick={() => void restoreEngineering()}>恢复工程记录</button>
              <button
                onClick={() =>
                  void action(async () => {
                    const p = await api.invoke<Project>('demo');
                    await reload();
                    void chooseProject(p);
                    setScenarioId((await reload()).scenarios.find(s => s.project_id === p.project_id)?.scenario_id || '');
                  })
                }
              >
                查看明确标记的演示
              </button>
            </div>
            <div className="welcome-grid">
              <article>
                <b>01 / 工程全貌</b>
                <p>模块地图、文件用途、依赖边界。</p>
              </article>
              <article>
                <b>02 / 功能走读</b>
                <p>关键调用、输入输出、阶段时序。</p>
              </article>
              <article>
                <b>03 / 来源核对</b>
                <p>冻结快照、真实行号、版本比较。</p>
              </article>
            </div>
          </main>
        ) : (
          <>
            {!engineeringReading && (
              <div className={overview ? 'context overview-context' : catalogReading ? 'context catalog-context' : 'context'}>
                <div className="context-heading">
                  {catalogReading && walkNavigation && navToggle}
                  <div>
                  <div className="breadcrumb" title={project.root_path}>
                    {projectLabel(project)} /{' '}
                    {reading.entrance === 'overview' ? '工程全貌' : data.features.find(f => f.feature_id === scenario?.feature_id)?.name || '功能走读'}
                    {!catalogReading && <span className="breadcrumb-kind"> · {currentView}</span>}
                    {project.fictional && <span className="tag amber">演示数据</span>}
                  </div>
                  <h1 title={overview ? project.name : scenario?.title}>
                    {overview ? projectLabel(project) : catalogReading ? '功能总览'
                      : scenario?.kind === 'breakdown' ? scenario.title
                      : featureReading || reading.view === 'functions' ? `${currentFeature?.name || scenario?.title || '当前功能'} · ${currentView}`
                      : compactTitle(scenario?.title || '选择要理解的功能', 40)}
                  </h1>
                  <div className="scope-hint">
                    {!overview && <span className="tag">{analysisScope}</span>}
                    <span title={overview ? result?.summary.text : scenario?.kind === 'breakdown' ? scenario.question : undefined}>
                      {overview ? compactTitle(result?.summary.text || '系统组成、技术栈与组件关系', 100)
                        : scenario?.kind === 'breakdown' ? compactTitle(scenario.question, 100)
                        : scenario?.kind === 'feature_overview' ? '这个功能的职责、关键调用与输入输出'
                        : '围绕当前问题核对调用、阶段和源码依据'}
                    </span>
                  </div>
                  </div>
                </div>
                <div className="context-actions">
                  {catalogReading && (otherProjectTasks.length > 0 || pendingScene) && (
                    <div className="context-tasks" aria-label="本工程进行中的分析">
                      {otherProjectTasks.map(r => (
                        <button key={r.binding.run_id} title={`${r.title} · ${statuses[r.status]} · 查看进度`} onClick={() => openTask(r.binding.scenario_id)}>
                          <span className="context-task-pulse" aria-hidden="true" />
                          {compactTitle(r.title, 18)} · {statuses[r.status]}
                        </button>
                      ))}
                      {pendingScene && !projectTasks.some(r => r.binding.scenario_id === pendingScene.scenario_id) && (
                        <button title={`${pendingScene.title} · 等待 Agent 领取`} onClick={() => openTask(pendingScene.scenario_id)}>
                          <span className="context-task-pulse" aria-hidden="true" />
                          {compactTitle(pendingScene.title, 18)} · 等待领取
                        </button>
                      )}
                    </div>
                  )}
                  <div className="analysis-controls">
                    {reading.view === 'files' && !featureReading ? (
                      <button className="primary" onClick={askHere}>
                        解释当前文件 / 目录
                      </button>
                    ) : (
                      analysisButton
                    )}
                    {analysisMenu}
                  </div>
                  {overview && !project.fictional && <button onClick={proposeRequirement}>提出新需求</button>}
                  <details className="context-edit-actions">
                    <summary>更多操作</summary>
                    <div className="popover-content">
                      <button onClick={() => openModal('feature')}>＋ 功能</button>
                      <button
                        disabled={!userFeatures.length}
                        title={!userFeatures.length ? '先添加一个功能，再建立具体场景' : '选择所属功能并添加一个具体问题'}
                        onClick={() => openModal('scenario')}
                      >
                        ＋ 场景
                      </button>
                      {walkNavigation && !catalogReading && currentFeature && (
                        <button disabled={currentFeature.archived} onClick={() => openModal('breakdown', currentFeature.feature_id)}>细化拆分子场景</button>
                      )}
                      {scenario && (
                        <>
                          <button
                            onClick={() => {
                              setFormName(scenario.title);
                              setModal('rename');
                            }}
                          >
                            改标题
                          </button>
                          <button
                            onClick={() => {
                              setFormQuestion(scenario.question);
                              setModal('revise');
                            }}
                          >
                            编辑问题
                          </button>
                        </>
                      )}
                      {catalogReading && (
                        <>
                          <span className="source-badge" title={boundSnapshotId}>来源 {short(boundSnapshotId)}</span>
                          <button onClick={refreshSource}>刷新来源</button>
                        </>
                      )}
                    </div>
                  </details>
                </div>
              </div>
            )}

            {!catalogReading && (
              <div className="workspace-bar">
                <div className="row">
                  {walkNavigation && navToggle}
                  {walkNavigation && (
                    <button className="back-to-catalog" onClick={() => setEntrance('walk')}>
                      ← 返回功能总览
                    </button>
                  )}
                  {workspaceTabs ? (
                    <nav className="feature-view-tabs" aria-label={overview ? '工程全貌视图' : '功能阅读视图'}>
                      {workspaceTabs.map(([view, label]) => (
                        <button
                          key={view}
                          type="button"
                          className={view.startsWith('functions:') ? 'feature-functions-tab' : undefined}
                          aria-current={activeTab === view ? 'page' : undefined}
                          onClick={() => overview ? navigateView(view) : navigateFeatureTab(view)}
                        >
                          {label}
                        </button>
                      ))}
                    </nav>
                  ) : (
                    <span className="current-view">{currentView}</span>
                  )}
                  {!engineeringReading && freshness && (
                    <button className={`saved-analysis ${freshness.kind}`} onClick={showRun}>
                      {freshness.kind === 'affected' ? '旧版本说明 · 所引源码已变更'
                        : freshness.kind === 'other_changed' ? freshness.count ? '历史快照 · 工作区有其他改动' : '历史快照 · 已保存说明'
                        : '已保存说明 · 查看真实过程'}
                    </button>
                  )}
                </div>
                {!engineeringReading && (
                  <div className="row">
                    {sourceOptions}
                    <button className="primary workspace-question" onClick={askHere}>
                      提问
                    </button>
                    <button
                      className="workspace-detail-toggle"
                      onClick={() => {
                        setShowDetail(true);
                        patch({ detail_tab: 'details' });
                      }}
                    >
                      详情
                    </button>
                  </div>
                )}
              </div>
            )}

            {!engineeringReading && !catalogReading && waitingMcp && result && (
              <div className="result-status">
                新分析等待 Agent 领取；当前仍显示已保存的说明。
                <button onClick={showRun}>查看待领取任务</button>
              </div>
            )}

            {!engineeringReading && !catalogReading && overviewReviewGaps.length > 0 && (
              <div className="result-status" aria-label="关系自动补查">
                <span>
                  {running?.overview_from_result_id === result?.result_id
                    ? '正在补查当前说明的关系，原图保留；完成后可查看新版本。'
                    : `${overviewReviewGaps.length} 条关系尚未确认。ARC 可沿用这份说明的冻结源码继续补查，并保存为新版本。`}
                </span>
                <button
                  disabled={pending || projectTasks.length > 0 || !!indexes[projectId] || !!project?.fictional}
                  onClick={() => void researchOverview()}
                >
                  自动补查关系
                </button>
              </div>
            )}

            {!engineeringReading &&
              !catalogReading &&
              !waitingMcp &&
              !running &&
              completedExplanation &&
              completedExplanation.result_id !== result?.result_id && (
                <div className="result-status">
                  <span>
                    本次分析已保存{result ? '；当前仍在阅读旧版' : ''}
                    {explanation && explanation.source_status !== 'current' ? ' · 来源待核对' : ''}
                  </span>
                  <button onClick={viewCompleted}>查看本次分析结果</button>
                </div>
              )}

            {!engineeringReading &&
              !catalogReading &&
              activityRun &&
              activityRun.status !== 'completed' &&
              !(reading.detail_tab === 'agent' && reading.mode !== 'compare' && (!detailDrawer || showDetail)) && (
                <RunActivity
                  key={activityRun.binding.run_id}
                  collapsible
                  detailed
                  run={activityRun}
                  events={events}
                  error={eventError}
                  open={showRun}
                  stop={() => void action(() => api.invoke('run_cancel', { run_id: activityRun.binding.run_id }))}
                />
              )}

            <div
              className={`workspace ${engineeringReading ? 'engineering-mode' : catalogReading ? 'catalog-workspace' : ''} ${
                reading.mode === 'source' ? 'source-mode' : ''
              } ${!walkNavigation || reading.catalog_hidden ? 'catalog-hidden' : ''}`}
              style={
                {
                  '--left': `${reading.left_width}px`,
                  '--right': `${Math.min(reading.right_width, reading.mode === 'source' ? Math.max(280, width - 800) : 600)}px`,
                } as React.CSSProperties
              }
            >
              {width >= 900 && walkNavigation && !reading.catalog_hidden && (
                <>
                  {catalog}
                  <Separator side="left_width" value={reading.left_width} change={changeWidth} reset={() => patch({ left_width: 220 })} />
                </>
              )}
              {engineeringReading ? (
                <EngineeringWorkspace
                  key={project.project_id}
                  project={project}
                  snapshotFiles={snapshot?.files}
                  page={reading.view === 'materials' ? 'materials' : 'records'}
                  requestedTask={requestedTask}
                  onTaskOpened={() => setRequestedTask('')}
                  onSettings={showMcp}
                  defaultEngine={expandMode}
                  onEngineChange={setAnalysisMode}
                  codexModel={codexModel}
                  enginePending={pending}
                  focusGoal={focusDevelopment}
                  onGoalFocused={() => setFocusDevelopment(false)}
                  readingDraft={composerDraft}
                  onClearReadingDraft={() => setComposerDraft(null)}
                  featureOptions={featureContextOptions}
                  back={() => setEntrance('overview')}
                  onArchitectureOverlay={overlay => {
                    chooseScenario(project.overview_scenario_id || '', {
                      ...overviewLanding,
                      ...(overlay.resultId ? { result_id: overlay.resultId } : {}),
                      source_snapshot_id: project.snapshot_id,
                    });
                    setArchOverlay(overlay);
                  }}
                  onArchitecture={id => {
                    const savedExp = data.explanations.find(e => e.result_id === id);
                    if (savedExp) {
                      chooseScenario(savedExp.scenario_id, {
                        ...overviewLanding,
                        result_id: id,
                        source_snapshot_id: savedExp.result.binding.source_snapshot_id,
                      });
                    } else {
                      chooseScenario(project.overview_scenario_id || '', {
                        ...overviewLanding,
                        source_snapshot_id: project.snapshot_id,
                      });
                    }
                  }}
                  onRestored={id =>
                    void reload().then(workspace => {
                      const restored = workspace.projects.find(p => p.project_id === id);
                      if (restored) void chooseProject(restored, workspace);
                    })
                  }
                  onReading={returnToFeature}
                />
              ) : reading.mode === 'compare' ? (
                <div className="compare-workspace">
                  <div className="compare-toolbar">
                    <label>
                      <input type="checkbox" checked={reading.linked} onChange={e => patch({ linked: e.target.checked })} />
                      稳定身份联动
                    </label>
                    <button onClick={() => patch({ mode: 'normal' })}>返回工作区</button>
                  </div>
                  <Compare
                    explanations={sceneExplanations}
                    oldId={reading.compare_id}
                    newId={result?.result_id || ''}
                    linked={reading.linked}
                    selectOld={v => patch({ compare_id: v })}
                  />
                </div>
              ) : (
                <>
                  {canvas}
                  {!detailDrawer && !catalogReading && detailVisible && (
                    <>
                      <Separator side="right_width" value={reading.right_width} change={changeWidth} reset={() => patch({ right_width: 360 })} />
                      {detail}
                    </>
                  )}
                </>
              )}
            </div>

            {width < 900 && walkNavigation && showCatalog && (
              <div className="drawer catalog-drawer">
                <button className="drawer-back" onClick={() => setShowCatalog(false)}>
                  ← 返回原视图
                </button>
                {catalog}
              </div>
            )}
            {detailDrawer && showDetail && !catalogReading && !engineeringReading && (
              <div className="drawer">
                <button
                  className="drawer-back"
                  onClick={() => {
                    setShowDetail(false);
                    previousFocus.current?.focus();
                  }}
                >
                  ← 返回图与原位置
                </button>
                {detail}
              </div>
            )}

            {!catalogReading && (
              <footer>
                <span>● 本机保存 · {saved}</span>
                <span>
                  {preview
                    ? '来自已保存的工程分析'
                    : scenario
                      ? `${sceneExplanations.length} 个说明版本 · ${sceneAnnotations.length} 条线索`
                      : '用途与关系待真实分析'}
                </span>
                <button onClick={() => patch({ ...defaults, entrance: reading.entrance, view: reading.view, catalog_hidden: overview, scenario_id: scenarioId })}>恢复默认布局</button>
              </footer>
            )}
          </>
        )}

        <dialog
          ref={modalRef}
          onCancel={e => {
            if (pending) e.preventDefault();
            else setModal('');
          }}
          aria-label={modalTitles[modal] || '编辑'}
        >
          <div className="modal-heading">
            <h2>{modalTitles[modal]}</h2>
            <button className="icon" aria-label="关闭对话框" disabled={pending} onClick={() => setModal('')}>
              <svg className="arc-ui-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          {modal === 'settings' ? (
            <SettingsModal
              data={data}
              project={project}
              projectId={projectId}
              scenario={scenario}
              scenarioId={scenarioId}
              mcp={mcp}
              setMcp={setMcp}
              settings={settings}
              error={error}
              connectionError={connectionError}
              notice={notice}
              setNotice={setNotice}
              pending={pending}
              mode={expandMode}
              setMode={setAnalysisMode}
              saveCodexPreferences={saveCodexPreferences}
              openDesktop={openDesktop}
              refreshMcp={refreshMcp}
              action={action}
              reload={reload}
              chooseProject={chooseProject}
              restoreEngineering={restoreEngineering}
              onOpenBuildConfig={config => {
                setFormQuestion(config);
                setModal('build');
              }}
              onOpenRenameScenario={title => {
                setFormName(title);
                setModal('rename');
              }}
            />
          ) : breakdownFeature ? (
            <ScenarioBreakdownForm
              key={breakdownFeature.feature_id}
              feature={breakdownFeature}
              saving={pending}
              setSaving={setPending}
              onClose={() => setModal('')}
              onAdded={async firstId => {
                await reload();
                revealScenario.current = firstId;
                chooseScenario(firstId, { entrance: 'walk', view: 'functions', mode: 'normal', catalog_hidden: false });
                if (width < 900) setShowCatalog(true);
              }}
            />
          ) : (
            <EntityFormModal
              modal={modal}
              error={error}
              pending={pending}
              indexTasks={indexTasks}
              userFeatures={userFeatures}
              formFeature={formFeature}
              setFormFeature={setFormFeature}
              formName={formName}
              setFormName={setFormName}
              formQuestion={formQuestion}
              setFormQuestion={setFormQuestion}
              onCancel={() => setModal('')}
              onSubmit={submitForm}
              action={action}
            />
          )}
        </dialog>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
