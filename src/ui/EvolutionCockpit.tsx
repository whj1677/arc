import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  EvolutionArchEdge,
  EvolutionArchModule,
  EvolutionAssumption,
  EvolutionCallSite,
  EvolutionChangedFile,
  EvolutionFeatureFlow,
  EvolutionFlowStep,
  EvolutionNonCodeChange,
  EvolutionSideEffect,
  EvolutionView,
} from '../evolution-view';
import { TextDiffView } from './TextDiffView';
import { collapseUnifiedContext, computeLineDiff } from './text-diff';
import './evolution-cockpit.css';

export interface EvolutionFileDiff {
  path: string;
  before: string;
  after: string;
  truncated: boolean;
  binary?: boolean;
}

export interface EvolutionDiffRequest {
  path: string;
  snapshotId?: string;
  side?: 'before' | 'after';
  preferFrozen?: boolean;
}

interface DrawerState {
  kind: 'module' | 'edge' | 'step' | 'side_effects' | 'assumption' | 'file';
  id: string;
  kicker: string;
  title: string;
  summary?: string;
  files: string[];
  activeFile?: string;
  focusLine?: number;
  snapshotId?: string;
  side?: 'before' | 'after';
  preferFrozen?: boolean;
  callSites?: EvolutionCallSite[];
  sideEffects: EvolutionSideEffect[];
  originPanel: 'arch' | 'flow';
}

export interface EvolutionCockpitProps {
  evolution: EvolutionView;
  revisionKey?: string;
  blueprintEvolution?: EvolutionView | null;
  modeLabel?: string;
  headerExtra?: React.ReactNode;
  footerActions?: React.ReactNode;
  foldSummary?: boolean;
  loadFileDiff: (req: EvolutionDiffRequest) => Promise<EvolutionFileDiff>;
  openInEditor?: (path: string, line?: number) => Promise<void>;
  onOpenArchitectureOverlay?: (resultId?: string) => void;
  onRefreshFeature?: (scenarioId: string) => void;
  refreshingScenarioId?: string | null;
  onViewAllFiles?: (file?: string) => void;
}

function shortPath(file: string) {
  const i = file.lastIndexOf('/');
  return i >= 0 ? file.slice(i + 1) : file;
}

function shortRef(ref: string) {
  if (ref === 'WORKTREE') return '当前工作区';
  if (ref === 'SNAPSHOT') return '基准快照';
  return /^[0-9a-f]{12,40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

function formatSymbolSummary(mod: EvolutionArchModule): string {
  const parts: string[] = [];
  if (mod.added_symbols > 0) parts.push(`新增 ${mod.added_symbols} 个符号`);
  if (mod.modified_symbols > 0) parts.push(`修改 ${mod.modified_symbols} 处`);
  if (mod.removed_symbols > 0) parts.push(`移除 ${mod.removed_symbols} 个`);
  if (parts.length) return parts.join(' · ');
  if (mod.changed_files.length) return `涉及 ${mod.changed_files.length} 个源码文件`;
  return '模块源码未直接改动';
}

const ROLE_LABELS: Record<NonNullable<EvolutionChangedFile['role']>, string> = {
  code: '源码',
  build: '构建',
  doc: '文档',
  config: '配置',
  other: '其他',
};

const STEP_STATUS_LABELS: Record<EvolutionFlowStep['status'], string> = {
  added: '+ 新增',
  removed: '− 移除',
  modified: '~ 已改',
  description_only: '说明调整',
  planned: '拟改动',
  unchanged: '未改',
};

const APPROACH_STATUS_LABELS: Record<'planned' | 'done' | 'partial' | 'blocked', string> = {
  done: '已完成',
  partial: '进行中',
  blocked: '待补齐',
  planned: '计划中',
};

const EDGE_KIND_LABELS: Record<EvolutionArchEdge['kind'], string> = {
  new_cross_layer: '新增跨层调用',
  new_same_layer: '新增模块调用',
  strengthened: '调用增加',
  removed: '移除调用',
  existing: '已有调用',
};

type DiffDisplayRow = { type: 'same' | 'add' | 'del' | 'gap'; oldLine?: number; newLine?: number; text: string };

function buildFocusedRows(
  before: string,
  after: string,
  focusLine: number | undefined,
  side?: 'before' | 'after',
): DiffDisplayRow[] {
  const computed = computeLineDiff(before, after);
  const full = computed.lines;
  const hasChanges = computed.stats.added > 0 || computed.stats.removed > 0;
  const matchesLine = (l: typeof full[number]) => {
    if (!focusLine) return false;
    if (side === 'before') return l.oldLine === focusLine;
    if (side === 'after') return l.newLine === focusLine;
    return l.newLine === focusLine || l.oldLine === focusLine;
  };
  if (focusLine) {
    const targetIdx = full.findIndex(matchesLine);
    if (targetIdx >= 0) {
      const keepStart = Math.max(0, targetIdx - 12);
      const keepEnd = Math.min(full.length, targetIdx + 13);
      const out: DiffDisplayRow[] = [];
      const prefix = hasChanges ? collapseUnifiedContext(full.slice(0, keepStart), 2) : [];
      const tail = hasChanges ? collapseUnifiedContext(full.slice(keepEnd), 2) : [];
      const pushCollapsed = (items: ReturnType<typeof collapseUnifiedContext>) => {
        for (const item of items) {
          out.push('hidden' in item
            ? { type: 'gap', text: `… 已折叠 ${item.hidden} 行 …` }
            : { type: item.type, oldLine: item.oldLine, newLine: item.newLine, text: item.text });
        }
      };
      if (prefix.length) pushCollapsed(prefix.slice(-10));
      else if (keepStart > 0) out.push({ type: 'gap', text: `… 前方省略 ${keepStart} 行 …` });
      for (let i = keepStart; i < keepEnd; i++) {
        const l = full[i];
        out.push({ type: l.type, oldLine: l.oldLine, newLine: l.newLine, text: l.text });
      }
      if (tail.length) pushCollapsed(tail.slice(0, 10));
      else if (keepEnd < full.length) out.push({ type: 'gap', text: `… 后方省略 ${full.length - keepEnd} 行 …` });
      return out;
    }
  }
  const collapsed = hasChanges ? collapseUnifiedContext(full, 3) : full.slice(0, 60);
  return collapsed.map((item): DiffDisplayRow =>
    'hidden' in item
      ? { type: 'gap', text: `… 已折叠 ${item.hidden} 行 …` }
      : { type: item.type, oldLine: item.oldLine, newLine: item.newLine, text: item.text },
  ).slice(0, 64);
}

type FlowDisplayItem =
  | { kind: 'step'; step: EvolutionFlowStep }
  | { kind: 'fold'; id: string; steps: EvolutionFlowStep[] };

export function EvolutionCockpit({
  evolution,
  revisionKey,
  blueprintEvolution,
  modeLabel,
  headerExtra,
  footerActions,
  foldSummary,
  loadFileDiff,
  openInEditor,
  onOpenArchitectureOverlay,
  onRefreshFeature,
  refreshingScenarioId,
  onViewAllFiles,
}: EvolutionCockpitProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLPreElement | null>(null);
  const [stageWidth, setStageWidth] = useState(1240);
  const [phaseView, setPhaseView] = useState<'actual' | 'blueprint'>('actual');
  const [layoutPref, setLayoutPref] = useState<'dual' | 'arch' | 'flow'>('dual');
  const [flowFilter, setFlowFilter] = useState<'diff' | 'before' | 'after'>('diff');
  const [compactFlow, setCompactFlow] = useState(true);
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());
  const [featureIdx, setFeatureIdx] = useState<number>(evolution.active_feature_index || 0);
  const [showOtherNotes, setShowOtherNotes] = useState(false);
  const [showAllBlockers, setShowAllBlockers] = useState(false);
  const [showAllNonCode, setShowAllNonCode] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [drawerDiff, setDrawerDiff] = useState<EvolutionFileDiff | null>(null);
  const [drawerDiffLoading, setDrawerDiffLoading] = useState(false);
  const [drawerDiffError, setDrawerDiffError] = useState('');
  const [drawerDiffMode, setDrawerDiffMode] = useState<'focused' | 'full'>('focused');
  const [docSelectedFile, setDocSelectedFile] = useState('');
  const [docDiff, setDocDiff] = useState<EvolutionFileDiff | null>(null);
  const [docDiffLoading, setDocDiffLoading] = useState(false);
  const [docDiffError, setDocDiffError] = useState('');
  const [openErr, setOpenErr] = useState('');

  const activeEvo = phaseView === 'blueprint' && blueprintEvolution ? blueprintEvolution : evolution;
  const isBlueprint = activeEvo.mode === 'task_blueprint';
  const showingPlan = isBlueprint && !!blueprintEvolution;
  const evoVersionKey = `${activeEvo.mode}:${revisionKey ?? `${activeEvo.base_label}:${activeEvo.target_label}:${activeEvo.changed_files.map(f => f.path).join('|')}`}`;
  const blueprintSnapshot = isBlueprint ? activeEvo.base_snapshot_id : undefined;

  useEffect(() => {
    setFeatureIdx(activeEvo.active_feature_index || 0);
    setDrawer(null);
    setShowOtherNotes(false);
    setShowAllBlockers(false);
    setShowAllNonCode(false);
    setExpandedFolds(new Set());
    setCompactFlow(true);
    setDocSelectedFile(prev =>
      activeEvo.changed_files.some(f => f.path === prev) ? prev : (activeEvo.changed_files[0]?.path ?? ''),
    );
  }, [evoVersionKey, activeEvo.active_feature_index]);

  useEffect(() => {
    setExpandedFolds(new Set());
  }, [featureIdx, flowFilter]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const drawerFile = drawer?.activeFile;
  const drawerSnap = drawer?.snapshotId;
  const drawerSide = drawer?.side;
  const drawerPreferFrozen = drawer?.preferFrozen;
  useEffect(() => {
    setOpenErr('');
    if (!drawerFile) {
      setDrawerDiff(null);
      setDrawerDiffError('');
      return;
    }
    let alive = true;
    setDrawerDiffLoading(true);
    setDrawerDiffError('');
    loadFileDiff({
      path: drawerFile, snapshotId: drawerSnap ?? blueprintSnapshot,
      side: isBlueprint ? 'before' : drawerSide, preferFrozen: isBlueprint || drawerPreferFrozen,
    })
      .then(res => { if (alive) setDrawerDiff(res); })
      .catch((e: Error) => { if (alive) { setDrawerDiff(null); setDrawerDiffError(e.message); } })
      .finally(() => { if (alive) setDrawerDiffLoading(false); });
    return () => { alive = false; };
  }, [drawerFile, drawerSnap, drawerSide, drawerPreferFrozen, loadFileDiff, evoVersionKey, isBlueprint, blueprintSnapshot]);

  useEffect(() => {
    if (!activeEvo.document_only || !docSelectedFile) {
      setDocDiff(null);
      setDocDiffError('');
      return;
    }
    let alive = true;
    setDocDiffLoading(true);
    setDocDiffError('');
    loadFileDiff({ path: docSelectedFile, snapshotId: blueprintSnapshot, preferFrozen: isBlueprint })
      .then(res => { if (alive) setDocDiff(res); })
      .catch((e: Error) => { if (alive) { setDocDiff(null); setDocDiffError(e.message); } })
      .finally(() => { if (alive) setDocDiffLoading(false); });
    return () => { alive = false; };
  }, [activeEvo.document_only, docSelectedFile, loadFileDiff, evoVersionKey, isBlueprint, blueprintSnapshot]);

  const focusedRows = useMemo(() => {
    if (!drawerDiff || drawerDiff.binary) return null;
    if (!drawerDiff.before && !drawerDiff.after) return [];
    return buildFocusedRows(drawerDiff.before, drawerDiff.after, drawer?.focusLine, drawer?.side);
  }, [drawerDiff, drawer?.focusLine, drawer?.side]);

  useEffect(() => {
    const pre = codeRef.current;
    if (!pre || !focusedRows?.length || !drawer?.focusLine) return;
    const target = pre.querySelector<HTMLElement>('.hud-diff-line.is-focus');
    if (target) {
      const offset = target.getBoundingClientRect().top - pre.getBoundingClientRect().top + pre.scrollTop;
      pre.scrollTop = Math.max(0, offset - pre.clientHeight / 2 + target.clientHeight / 2);
    }
  }, [focusedRows, drawer?.focusLine]);

  const drawerOverlay = !!drawer && (activeEvo.document_only || stageWidth < 1080);
  const effectiveLayout: 'dual' | 'arch' | 'flow' = useMemo(() => {
    if (drawer && !drawerOverlay) return drawer.originPanel;
    if (layoutPref === 'dual' && stageWidth < 1040) return 'flow';
    return layoutPref;
  }, [drawer, drawerOverlay, layoutPref, stageWidth]);

  const activeFeature: EvolutionFeatureFlow | undefined =
    activeEvo.features[featureIdx] ?? activeEvo.features[0];

  const visibleSteps = useMemo(() => {
    if (!activeFeature) return [];
    return activeFeature.steps.filter(s => {
      if (flowFilter === 'before') return s.status !== 'added';
      if (flowFilter === 'after') return s.status !== 'removed';
      return true;
    });
  }, [activeFeature, flowFilter]);

  const hasMixedFlowChanges = useMemo(
    () => visibleSteps.length >= 6
      && visibleSteps.some(s => s.status === 'unchanged')
      && visibleSteps.some(s => s.status !== 'unchanged' && s.status !== 'description_only'),
    [visibleSteps],
  );

  // Auto-collapse consecutive unchanged steps (>= 2) in compact mode so developers see the exact change context immediately
  const displayFlowItems = useMemo<FlowDisplayItem[]>(() => {
    if (!compactFlow || !hasMixedFlowChanges) {
      return visibleSteps.map(step => ({ kind: 'step', step }));
    }
    const items: FlowDisplayItem[] = [];
    let run: EvolutionFlowStep[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const foldId = `fold:${run[0].id}:${run[run.length - 1].id}`;
      if (run.length >= 2 && !expandedFolds.has(foldId)) {
        items.push({ kind: 'fold', id: foldId, steps: run });
      } else {
        for (const step of run) items.push({ kind: 'step', step });
      }
      run = [];
    };
    for (const step of visibleSteps) {
      if (step.status === 'unchanged') {
        run.push(step);
      } else {
        flush();
        items.push({ kind: 'step', step });
      }
    }
    flush();
    return items;
  }, [visibleSteps, compactFlow, hasMixedFlowChanges, expandedFolds]);

  const reviewBlockers = useMemo(
    () => activeEvo.assumptions.filter(a => a.source === 'review_blocker'),
    [activeEvo.assumptions],
  );
  const otherNotes = useMemo(
    () => activeEvo.assumptions.filter(a => a.source !== 'review_blocker'),
    [activeEvo.assumptions],
  );

  // Architecture breakdown: separate directly changed modules, edge-impacted modules, and quiet unchanged modules
  const directModules = useMemo(
    () => activeEvo.architecture.modules.filter(m => m.relation === 'direct'),
    [activeEvo.architecture.modules],
  );
  const impactedModules = useMemo(
    () => activeEvo.architecture.modules.filter(m => m.relation === 'edge_impacted'),
    [activeEvo.architecture.modules],
  );
  const changedEdges = useMemo(
    () => activeEvo.architecture.edges.filter(e => e.kind !== 'existing'),
    [activeEvo.architecture.edges],
  );
  const nonCodeChanges: EvolutionNonCodeChange[] = activeEvo.architecture.non_code_changes ?? [];
  const quietModuleCount = Math.max(0, activeEvo.architecture.all_modules_count - directModules.length - impactedModules.length);

  const linkedFiles = useMemo(() => new Set(drawer?.files ?? []), [drawer]);
  const astSideEffects = useMemo(
    () => activeEvo.side_effects.filter(s => s.evidence_kind === 'ast_proved'),
    [activeEvo.side_effects],
  );
  const aiSideEffects = useMemo(
    () => activeEvo.side_effects.filter(s => s.evidence_kind === 'ai_inferred'),
    [activeEvo.side_effects],
  );
  const hasHighRisk = activeEvo.side_effects.some(s => s.severity === 'high');
  const sourceChangedCount = activeEvo.changed_files.filter(f => f.is_source).length;

  function openModuleDrawer(
    mod: EvolutionArchModule,
    focusFile?: string,
    focusLine?: number,
    focusSymName?: string,
    focusStatus?: 'added' | 'modified' | 'removed',
  ) {
    const files = mod.changed_files.length ? mod.changed_files : mod.files;
    const targetFile = focusFile ?? files[0];
    const relatedSe = activeEvo.side_effects.filter(
      se => se.module_ids?.includes(mod.id) || (se.file && files.includes(se.file)),
    );
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'module',
      id: focusSymName ? `${mod.id}:${focusSymName}` : mod.id,
      kicker: `架构模块 · ${mod.layer}`,
      title: focusSymName ? `${mod.label} · ${focusSymName}` : mod.label,
      summary: mod.summary || formatSymbolSummary(mod),
      files,
      activeFile: targetFile,
      focusLine,
      side: focusStatus === 'removed' ? 'before' : 'after',
      preferFrozen: mod.changed_files.length === 0,
      sideEffects: relatedSe,
      originPanel: 'arch',
    });
  }

  function openEdgeDrawer(edge: EvolutionArchEdge) {
    const files = edge.sample_call ? [edge.sample_call.file] : [];
    const relatedSe = activeEvo.side_effects.filter(
      se => se.module_ids?.includes(edge.from_id) && se.module_ids?.includes(edge.to_id),
    );
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'edge',
      id: edge.id,
      kicker: `模块连线 · ${EDGE_KIND_LABELS[edge.kind]}`,
      title: `${edge.from_label} → ${edge.to_label}`,
      summary: `跨模块调用由 ${edge.before_count} 处变为 ${edge.after_count} 处${edge.sample_call ? `，触发调用为 ${edge.sample_call.caller_symbol} → ${edge.sample_call.callee_symbol}` : ''}。`,
      files,
      activeFile: edge.sample_call?.file,
      focusLine: edge.sample_call?.line,
      side: edge.kind === 'removed' ? 'before' : 'after',
      sideEffects: relatedSe,
      originPanel: 'arch',
    });
  }

  function openFileDrawer(filePath: string, roleLabel: string, originPanel: 'arch' | 'flow' = 'arch') {
    const relatedSe = activeEvo.side_effects.filter(se => se.file === filePath);
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'file',
      id: `file:${filePath}`,
      kicker: `${roleLabel}变动`,
      title: shortPath(filePath),
      summary: filePath,
      files: [filePath],
      activeFile: filePath,
      side: 'after',
      preferFrozen: false,
      sideEffects: relatedSe,
      originPanel,
    });
  }

  function openStepDrawer(step: EvolutionFlowStep, focusCall?: EvolutionCallSite) {
    const isInserted = !!step.inserted || step.status === 'added';
    const isStaleBeforeAnchor = activeFeature?.mode === 'walkthrough_stale' && !isInserted && !step.after_line;
    const isBefore = isBlueprint || !isInserted && (flowFilter === 'before' || focusCall?.status === 'removed' || step.status === 'removed' || isStaleBeforeAnchor);
    const side: 'before' | 'after' = isBefore ? 'before' : 'after';
    const file = focusCall?.file ?? step.file ?? undefined;
    const line = focusCall?.line ?? (isBefore ? (step.before_line ?? step.line) : (step.after_line ?? step.before_line ?? step.line));
    const snapshotId = isBefore
      ? (activeFeature?.before_snapshot_id ?? activeEvo.base_snapshot_id)
      : (activeFeature?.after_snapshot_id ?? activeEvo.target_snapshot_id);
    // Keep untouched stale steps on their frozen walkthrough snapshot; modified/inserted steps open diff when snapshot matches task window
    const preferFrozen = activeFeature?.mode === 'walkthrough_stale' && step.status === 'unchanged';
    const stepCalls = (step.call_sites ?? []).filter(cs =>
      flowFilter === 'before' ? cs.status !== 'added' : flowFilter === 'after' ? cs.status !== 'removed' : true,
    );
    const files = [...new Set([file, ...stepCalls.map(c => c.file)].filter((f): f is string => !!f))];
    const relatedSe = activeEvo.side_effects.filter(se => file && (se.file === file || se.target_file === file));
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'step',
      id: step.id,
      kicker: isInserted ? '新增调用步骤' : `流程步骤 · ${STEP_STATUS_LABELS[step.status]}`,
      title: isInserted ? `+ ${step.title}` : (isBefore ? (step.before_text ?? step.title) : step.title),
      summary: step.sub_calls?.length
        ? `${step.subtitle || ''}${step.subtitle ? ' · ' : ''}内部继续调用：${step.sub_calls.join('、')}`
        : ((isBefore ? step.before_text : step.after_text) || step.before_text || step.subtitle || (step.symbol ? `函数：${step.symbol}` : undefined)),
      files,
      activeFile: file,
      focusLine: line,
      snapshotId,
      side,
      preferFrozen,
      callSites: stepCalls,
      sideEffects: relatedSe,
      originPanel: 'flow',
    });
  }

  function openAssumptionDrawer(a: EvolutionAssumption) {
    const files = a.file ? [a.file] : [];
    const relatedSe: EvolutionSideEffect[] = a.source === 'review_blocker'
      ? [{
          id: a.id,
          evidence_kind: 'ai_inferred',
          severity: 'high',
          category: 'review_blocker',
          title: a.file ? `${shortPath(a.file)} 审查阻断` : '审查阻断',
          detail: a.text,
          file: a.file,
          fix: a.fix,
        }]
      : [];
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'assumption',
      id: a.id,
      kicker: a.source === 'review_blocker' ? '审查阻断项' : '前期约定与待确认',
      title: a.file ? `${shortPath(a.file)} 待处理问题` : '待确认事项',
      summary: a.text,
      files,
      activeFile: a.file,
      side: 'after',
      sideEffects: relatedSe,
      originPanel: 'flow',
    });
  }

  function openAllSideEffectsDrawer() {
    const firstFile = activeEvo.side_effects.find(s => s.file)?.file;
    const firstLine = activeEvo.side_effects.find(s => s.file === firstFile)?.line;
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'side_effects',
      id: 'all-se',
      kicker: '额外提醒与波及汇总',
      title: `代码扫描确认 ${astSideEffects.length} 项 · 审查建议 ${aiSideEffects.length} 项`,
      summary: '实线卡片为本地代码索引直接扫描出的源码事实；虚线卡片为独立审查或历史约束提示。',
      files: [...new Set(activeEvo.side_effects.map(s => s.file).filter((f): f is string => !!f))],
      activeFile: firstFile,
      focusLine: firstLine,
      side: 'after',
      sideEffects: activeEvo.side_effects,
      originPanel: effectiveLayout === 'arch' ? 'arch' : 'flow',
    });
  }

  async function handleOpenEditor(file: string, line?: number) {
    if (!openInEditor) return;
    setOpenErr('');
    try {
      await openInEditor(file, line);
    } catch (e) {
      setOpenErr((e as Error).message);
    }
  }

  function renderDrawerBody(d: DrawerState, maxCodeHeight: number) {
    return (
      <div className="evo-drawer-body">
        {openErr && <small className="warning">{openErr}</small>}
        {d.summary && <p className="evo-drawer-summary">{d.summary}</p>}

        {d.sideEffects.length > 0 && (
          <div className="evo-se-list">
            {d.sideEffects.map(se => (
              <div key={se.id} className={`evo-se-item kind-${se.evidence_kind} sev-${se.severity}`}>
                <div className="evo-se-top">
                  <strong>{se.title}</strong>
                  <span className="evo-se-badge">
                    {se.evidence_kind === 'ast_proved' ? '代码扫描确认' : '审查建议'}
                  </span>
                </div>
                <div className="evo-se-detail">{se.detail}</div>
                {se.fix && <div className="evo-se-fix"><strong>建议补齐：</strong>{se.fix}</div>}
                {se.file && (
                  <button
                    type="button"
                    className="hud-mini-btn"
                    style={{ alignSelf: 'flex-start', marginTop: 2 }}
                    onClick={() => setDrawer(prev => prev ? {
                      ...prev,
                      activeFile: se.file,
                      focusLine: se.line,
                      side: se.category === 'contract_break' ? 'before' : 'after',
                      snapshotId: se.category === 'contract_break' ? activeEvo.base_snapshot_id : undefined,
                      preferFrozen: false,
                    } : prev)}
                  >
                    定位 {shortPath(se.file)}{se.line ? `:${se.line}` : ''}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {d.callSites && d.callSites.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <small className="muted">调用位置（点击定位代码行）</small>
            <div className="evo-step-calls">
              {d.callSites.map((cs, i) => (
                <button
                  key={`${cs.file}:${cs.line}:${i}`}
                  type="button"
                  className={`evo-callsite-chip status-${cs.status}`}
                  onClick={() => setDrawer(prev => prev ? {
                    ...prev,
                    activeFile: cs.file,
                    focusLine: cs.line,
                    side: cs.status === 'removed' ? 'before' : 'after',
                    preferFrozen: false,
                  } : prev)}
                >
                  <span>{shortPath(cs.file)}:L{cs.line}</span>
                  <span>→ {cs.target_symbol}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {d.files.length > 1 && (
          <div className="evo-file-pills">
            {d.files.slice(0, 12).map(file => (
              <button
                key={file}
                type="button"
                className={`evo-file-pill${d.activeFile === file ? ' is-active' : ''}`}
                title={file}
                onClick={() => setDrawer(prev => prev ? { ...prev, activeFile: file, focusLine: undefined, snapshotId: undefined, preferFrozen: false } : prev)}
              >
                {shortPath(file)}
              </button>
            ))}
          </div>
        )}

        {d.activeFile && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <code style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.activeFile}{d.focusLine ? `:${d.focusLine}` : ''}
              </code>
              <div className="hud-segmented" role="group" aria-label="代码展示范围">
                <button type="button" aria-pressed={drawerDiffMode === 'focused'} onClick={() => setDrawerDiffMode('focused')}>聚焦行</button>
                <button type="button" aria-pressed={drawerDiffMode === 'full'} onClick={() => setDrawerDiffMode('full')}>整文件</button>
              </div>
            </div>

            {drawerDiffLoading ? (
              <small className="muted">读取源码对比…</small>
            ) : drawerDiffError ? (
              <small className="warning">{drawerDiffError}</small>
            ) : drawerDiff?.binary ? (
              <small className="muted">二进制文件，暂不支持文本 Diff。</small>
            ) : drawerDiff && drawerDiffMode === 'full' ? (
              <div className="evo-drawer-code">
                <TextDiffView
                  path={drawerDiff.path}
                  before={drawerDiff.before}
                  after={drawerDiff.after}
                  truncated={drawerDiff.truncated}
                  beforeLabel={shortRef(activeEvo.base_label)}
                  afterLabel={shortRef(activeEvo.target_label)}
                />
              </div>
            ) : focusedRows && focusedRows.length > 0 ? (
              <pre ref={codeRef} className="hud-inspector-diff" style={{ maxHeight: maxCodeHeight, fontSize: 12.5 }}>
                {focusedRows.map((row, idx) => {
                  const focused = row.type !== 'gap' && !!d.focusLine &&
                    (d.side === 'before' ? row.oldLine === d.focusLine
                      : d.side === 'after' ? row.newLine === d.focusLine
                        : (row.newLine === d.focusLine || row.oldLine === d.focusLine));
                  return (
                    <span key={idx} className={`hud-diff-line ${row.type}${focused ? ' is-focus' : ''}`}>
                      <b>{row.type === 'gap' ? '…' : (d.side === 'before' ? (row.oldLine ?? row.newLine ?? '') : (row.newLine ?? row.oldLine ?? ''))}</b>
                      <span>{row.type === 'add' ? '+ ' : row.type === 'del' ? '− ' : row.type === 'gap' ? '' : '  '}{row.text}</span>
                    </span>
                  );
                })}
              </pre>
            ) : (
              <small className="muted">该文件在此版本区间无文本差异。</small>
            )}
          </div>
        )}
      </div>
    );
  }

  const footerAlertText = useMemo(() => {
    const parts: string[] = [];
    const newCross = activeEvo.side_effects.filter(s => s.category === 'new_cross_layer_edge').length;
    const breaks = activeEvo.side_effects.filter(s => s.category === 'contract_break').length;
    const cycles = activeEvo.side_effects.filter(s => s.category === 'new_cycle').length;
    const blockers = activeEvo.side_effects.filter(s => s.category === 'review_blocker').length;
    if (breaks) parts.push(`${breaks} 处外部调用未同步`);
    if (cycles) parts.push(`${cycles} 个新增调用环`);
    if (newCross) parts.push(`${newCross} 处新增跨层调用`);
    if (blockers) parts.push(`${blockers} 项审查阻断`);
    if (!parts.length && activeEvo.side_effects.length) {
      parts.push(`${activeEvo.side_effects.length} 条工程提醒`);
    }
    return parts.length ? parts.join(' · ') : '无明显额外波及';
  }, [activeEvo.side_effects]);

  const SummaryContainer = foldSummary ? 'details' : 'div';

  return (
    <div className="evo-cockpit">
      {/* Compact Top Control Bar */}
      <div className="evo-topbar">
        <div className="evo-topbar-left">
          <span className={`evo-mode-chip${isBlueprint ? ' is-blueprint' : ''}`}>
            {showingPlan ? '改前预演' : modeLabel || (isBlueprint ? '改前预演' : activeEvo.mode === 'workspace_radar' ? '工作区改动' : '已落地改动')}
          </span>
          {blueprintEvolution && (
            <div className="hud-segmented" role="group" aria-label="阶段视角">
              <button type="button" aria-pressed={phaseView === 'blueprint'} onClick={() => { setDrawer(null); setFlowFilter('diff'); setPhaseView('blueprint'); }}>
                改前方案
              </button>
              <button type="button" aria-pressed={phaseView === 'actual'} onClick={() => { setDrawer(null); setPhaseView('actual'); }}>
                实际改动
              </button>
            </div>
          )}
          {!activeEvo.document_only && (
            <div className="hud-segmented" role="group" aria-label="图面布局">
              {stageWidth >= 1040 && (
                <button
                  type="button"
                  aria-pressed={effectiveLayout === 'dual'}
                  onClick={() => { setDrawer(null); setLayoutPref('dual'); }}
                >
                  总览
                </button>
              )}
              <button type="button" aria-pressed={effectiveLayout === 'arch'} onClick={() => setLayoutPref('arch')}>
                架构变动
              </button>
              <button type="button" aria-pressed={effectiveLayout === 'flow'} onClick={() => setLayoutPref('flow')}>
                功能流程
              </button>
            </div>
          )}
        </div>

        <div className="evo-topbar-right">
          {activeEvo.verification_badge && (
            <span
              className={`evo-verify-pill tone-${activeEvo.verification_badge.tone}`}
              title={activeEvo.verification_badge.detail}
            >
              {activeEvo.verification_badge.label}
            </span>
          )}
          {onViewAllFiles && activeEvo.changed_files.length > 0 && !activeEvo.document_only && (
            <button type="button" className="hud-mini-btn" onClick={() => onViewAllFiles()}>
              全部 Diff ({activeEvo.changed_files.length})
            </button>
          )}
          {headerExtra}
        </div>
      </div>

      {/* Band 1: Plain-Language Conclusion + What Changed + What's Blocking (NEVER clipped to 1-line ellipsis) */}
      {activeEvo.mode === 'workspace_radar' ? (
        <div className="evo-radar-observe">
          <span>
            <strong>工作区变更</strong> · 基准 <code>{shortRef(activeEvo.base_label)}</code> → <code>{shortRef(activeEvo.target_label)}</code>
          </span>
          <span className="evo-radar-observe-stats">
            <span>{activeEvo.changed_files.length} 个改动文件（{sourceChangedCount} 个源码）</span>
            {activeEvo.architecture.mode !== 'empty' && (
              <span>
                直接改动 {directModules.length} 个{activeEvo.architecture.mode === 'overview' ? '架构模块' : '目录'}
                {impactedModules.length > 0 ? ` · 联动 ${impactedModules.length} 个` : ''}
              </span>
            )}
          </span>
        </div>
      ) : (activeEvo.verdict_summary || activeEvo.approach.length > 0 || activeEvo.assumptions.length > 0) ? (
        <SummaryContainer className={foldSummary ? 'evo-summary-stack behavior-notes behavior-evolution-notes' : 'evo-summary-stack'}>
          {foldSummary && <summary>变更说明与审查记录{reviewBlockers.length > 0 && ` · ${reviewBlockers.length} 项审查阻断`}</summary>}
          {activeEvo.verdict_summary && (
            <div className={`evo-verdict-banner${reviewBlockers.length > 0 ? ' has-blocker' : ''}`}>
              <span className="evo-verdict-label">{reviewBlockers.length > 0 ? '当前卡点' : '本次结论'}</span>
              <p>{activeEvo.verdict_summary}</p>
            </div>
          )}

          {(activeEvo.approach.length > 0 || reviewBlockers.length > 0 || otherNotes.length > 0) && (
            <section className={`evo-band1${!(reviewBlockers.length > 0 || otherNotes.length > 0) || !activeEvo.approach.length ? ' is-single' : ''}`}>
              {activeEvo.approach.length > 0 && (
                <div className="evo-strip-card">
                  <div className="evo-strip-head">
                    <strong>① {isBlueprint ? '准备怎么改' : '这次实际改了什么'}</strong>
                    <small>{activeEvo.changed_files.length ? `已改 ${activeEvo.changed_files.length} 个文件` : `共 ${activeEvo.approach.length} 步`}</small>
                  </div>
                  <div className="evo-approach-list">
                    {activeEvo.approach.slice(0, 4).map((step, i) => (
                      <button
                        key={step.id}
                        type="button"
                        className="evo-approach-item"
                        onClick={() => {
                          const file = step.files[0] ?? activeEvo.changed_files[0]?.path;
                          setDrawerDiffMode('focused');
                          setDrawer({
                            kind: 'step',
                            id: step.id,
                            kicker: `改动说明 · 第 ${i + 1} 步`,
                            title: step.title,
                            summary: step.detail,
                            files: step.files.length ? step.files : activeEvo.changed_files.map(f => f.path),
                            activeFile: file,
                            side: 'after',
                            sideEffects: activeEvo.side_effects.filter(se => se.file && step.files.includes(se.file)),
                            originPanel: effectiveLayout === 'arch' ? 'arch' : 'flow',
                          });
                        }}
                      >
                        <div className="evo-approach-top">
                          <strong>{i + 1}. {step.title}</strong>
                          {step.status && (
                            <span className={`evo-approach-status is-${step.status}`}>
                              {APPROACH_STATUS_LABELS[step.status]}
                            </span>
                          )}
                        </div>
                        <p>{step.detail}</p>
                      </button>
                    ))}
                  </div>
                  {activeEvo.changed_files.length > 0 && (
                    <div className="evo-changed-file-bar">
                      {activeEvo.changed_files.slice(0, 8).map(f => (
                        <button
                          key={f.path}
                          type="button"
                          className={`evo-changed-file-chip role-${f.role ?? 'other'}`}
                          title={f.path}
                          onClick={() => openFileDrawer(f.path, ROLE_LABELS[f.role ?? 'other'])}
                        >
                          <span className="evo-role-tag">{ROLE_LABELS[f.role ?? 'other']}</span>
                          <span>{shortPath(f.path)}</span>
                        </button>
                      ))}
                      {activeEvo.changed_files.length > 8 && (
                        <small className="muted">+{activeEvo.changed_files.length - 8} 个文件</small>
                      )}
                    </div>
                  )}
                </div>
              )}

              {(reviewBlockers.length > 0 || otherNotes.length > 0) && (
                <div className={`evo-strip-card${reviewBlockers.length > 0 ? ' is-blocker-card' : ' is-warn'}`}>
                  <div className="evo-strip-head">
                    <strong>
                      {reviewBlockers.length > 0
                        ? `还差什么未闭环 · ${reviewBlockers.length} 项阻断`
                        : `前期约定与待确认 (${otherNotes.length})`}
                    </strong>
                    {reviewBlockers.length > 3 && (
                      <button type="button" className="hud-mini-btn" onClick={() => setShowAllBlockers(v => !v)}>
                        {showAllBlockers ? '收起' : '展开全部'}
                      </button>
                    )}
                  </div>

                  {reviewBlockers.length > 0 ? (
                    <>
                      <div className="evo-blocker-list">
                        {(showAllBlockers ? reviewBlockers : reviewBlockers.slice(0, 3)).map((b, idx) => (
                          <button
                            key={b.id}
                            type="button"
                            className="evo-blocker-item"
                            onClick={() => openAssumptionDrawer(b)}
                          >
                            <div className="evo-blocker-head">
                              <span className="evo-blocker-idx">{idx + 1}</span>
                              {b.file && <code className="evo-blocker-file">{shortPath(b.file)}</code>}
                              <span className="evo-blocker-action">看详情 →</span>
                            </div>
                            <p className="evo-blocker-text">{b.text}</p>
                          </button>
                        ))}
                      </div>
                      {otherNotes.length > 0 && (
                        <div className="evo-notes-collapse">
                          <button
                            type="button"
                            className="evo-notes-toggle"
                            onClick={() => setShowOtherNotes(v => !v)}
                          >
                            {showOtherNotes ? '收起' : '查看'}前期约定与待确认事项 ({otherNotes.length}) {showOtherNotes ? '▴' : '▾'}
                          </button>
                          {showOtherNotes && (
                            <div className="evo-notes-list">
                              {otherNotes.map(n => (
                                <div key={n.id} className="evo-note-row">• {n.text}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="evo-notes-list">
                      {(showOtherNotes ? otherNotes : otherNotes.slice(0, 2)).map(n => (
                        <div key={n.id} className="evo-note-row">• {n.text}</div>
                      ))}
                      {otherNotes.length > 2 && (
                        <button type="button" className="evo-notes-toggle" onClick={() => setShowOtherNotes(v => !v)}>
                          {showOtherNotes ? '收起' : `展开其余 ${otherNotes.length - 2} 项 ▾`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </SummaryContainer>
      ) : null}

      {/* Document-Only Fast Path */}
      {activeEvo.document_only ? (
        <section className="evo-doc-only">
          <aside className="evo-panel">
            <div className="evo-panel-head">
              <div>
                <h3>文档 / 非源码改动 ({activeEvo.changed_files.length})</h3>
                <p>本次只改了文档或配置文件，直接看文件前后对比</p>
              </div>
            </div>
            <div className="evo-flow-list">
              {activeEvo.changed_files.map(f => (
                <button
                  key={f.path}
                  type="button"
                  className={`evo-step-card${docSelectedFile === f.path ? ' is-selected' : ''}`}
                  onClick={() => setDocSelectedFile(f.path)}
                >
                  <div className="evo-step-top">
                    <span className="evo-step-title">{shortPath(f.path)}</span>
                    <span className="evo-pill-mini">{f.status === 'added' ? '新增' : f.status === 'removed' ? '删除' : '修改'}</span>
                  </div>
                  <span className="evo-step-sub">{f.path}</span>
                </button>
              ))}
            </div>
          </aside>
          <div className="evo-drawer-code">
            {docDiffLoading ? (
              <p className="muted" style={{ padding: 16 }}>读取文件差异…</p>
            ) : docDiffError ? (
              <p className="warning" style={{ padding: 16 }}>{docDiffError}</p>
            ) : docDiff?.binary ? (
              <p className="muted" style={{ padding: 16 }}>二进制文档（{docDiff.path}），暂不支持文本 Diff。</p>
            ) : docDiff ? (
              <TextDiffView
                path={docDiff.path}
                before={docDiff.before}
                after={docDiff.after}
                truncated={docDiff.truncated}
                beforeLabel={shortRef(activeEvo.base_label)}
                afterLabel={shortRef(activeEvo.target_label)}
              />
            ) : (
              <p className="muted" style={{ padding: 16 }}>选择左侧文件查看前后变化。</p>
            )}
          </div>
        </section>
      ) : (
        /* Band 2: Dual Visual Hero (Directed Architecture Graph + Focused Flow Timeline) + Non-Squeezing Drawer */
        <div ref={stageRef} className="evo-stage-wrap">
          <div className={`evo-panels${effectiveLayout !== 'dual' ? ' is-single' : ''}`}>
            {/* LEFT HERO: Directed Architecture Diff */}
            {(effectiveLayout === 'dual' || effectiveLayout === 'arch') && (
              <section className="evo-panel" aria-label="系统架构变动">
                <div className="evo-panel-head">
                  <div>
                    <h3>② 系统架构变动</h3>
                    <p>
                      {activeEvo.architecture.mode === 'overview'
                        ? '只展示直接改动与新增调用连线的模块，未受影响的模块已自动静默'
                        : activeEvo.architecture.mode === 'directory_fallback'
                          ? '尚未生成工程全貌，当前按源码目录展示直接改动与依赖变化'
                          : '本次改动未命中运行时代码模块'}
                    </p>
                  </div>
                  <div className="evo-panel-controls">
                    {onOpenArchitectureOverlay && !showingPlan && activeEvo.architecture.mode === 'overview' && (
                      <button
                        type="button"
                        className="hud-mini-btn"
                        onClick={() => onOpenArchitectureOverlay(activeEvo.architecture.architecture_result_id)}
                      >
                        工程全貌 ↗
                      </button>
                    )}
                  </div>
                </div>

                {directModules.length > 0 || impactedModules.length > 0 ? (
                  <div className="evo-arch-flow">
                    {/* Direct Modified Modules */}
                    {directModules.length > 0 && (
                      <div className="evo-arch-zone">
                        <div className="evo-zone-label">直接改动的运行时模块 ({directModules.length})</div>
                        <div className="evo-direct-grid">
                          {directModules.map(mod => {
                            const isSelected = drawer?.kind === 'module' && drawer.id === mod.id;
                            const isLinked = !isSelected && mod.files.some(f => linkedFiles.has(f));
                            const keySyms = mod.key_symbols ?? [];
                            return (
                              <div
                                key={mod.id}
                                className={`evo-direct-card${isBlueprint ? ' is-blueprint' : ''}${isSelected ? ' is-selected' : ''}${isLinked ? ' is-linked' : ''}`}
                              >
                                <button
                                  type="button"
                                  className="evo-direct-card-head"
                                  onClick={() => openModuleDrawer(mod)}
                                >
                                  <div className="evo-mod-top">
                                    <span className="evo-layer-pill">{mod.layer}</span>
                                    <span className="evo-mod-badge is-direct">{isBlueprint ? '拟改动' : '核心改动'}</span>
                                  </div>
                                  <div className="evo-direct-title">{mod.label}</div>
                                  <div className="evo-direct-meta">
                                    <code>{mod.changed_files.map(shortPath).join('、') || shortPath(mod.files[0] ?? '')}</code>
                                    <span>{formatSymbolSummary(mod)}</span>
                                  </div>
                                </button>
                                {keySyms.length > 0 && (
                                  <div className="evo-key-sym-row">
                                    {keySyms.slice(0, 8).map((ks, ki) => (
                                      <button
                                        key={`${ks.file}:${ks.name}:${ki}`}
                                        type="button"
                                        className={`evo-key-sym-chip is-${ks.status}`}
                                        title={`${ks.file}${ks.line ? `:${ks.line}` : ''}${ks.doc ? ` · ${ks.doc}` : ''}`}
                                        onClick={() => openModuleDrawer(mod, ks.file, ks.line, ks.name, ks.status)}
                                      >
                                        <span>{ks.status === 'added' ? '+' : ks.status === 'removed' ? '−' : '~'} {ks.name}</span>
                                        {ks.doc && <small>{ks.doc}</small>}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Visual Directed Arrows -> Edge-Impacted Modules */}
                    {impactedModules.length > 0 && (
                      <div className="evo-arch-connectors">
                        <div className="evo-connector-rail" aria-hidden="true">
                          <span className="evo-connector-stem" />
                          <span className="evo-connector-caption">新增 / 变化调用关系</span>
                          <span className="evo-connector-stem" />
                        </div>
                        <div className="evo-impacted-grid">
                          {impactedModules.map(target => {
                            const relEdges = changedEdges.filter(e => e.to_id === target.id || e.from_id === target.id);
                            const primaryEdge = relEdges[0];
                            const isSelected = drawer?.kind === 'module' && drawer.id === target.id;
                            return (
                              <div key={target.id} className="evo-impacted-branch">
                                {primaryEdge && (
                                  <button
                                    type="button"
                                    className={`evo-branch-edge kind-${primaryEdge.kind}`}
                                    onClick={() => openEdgeDrawer(primaryEdge)}
                                  >
                                    <span className="evo-branch-arrow" aria-hidden="true">↓</span>
                                    <div className="evo-branch-edge-body">
                                      <div className="evo-branch-edge-top">
                                        <strong>{EDGE_KIND_LABELS[primaryEdge.kind]}</strong>
                                        <span>{primaryEdge.before_count} → {primaryEdge.after_count}</span>
                                      </div>
                                      {primaryEdge.sample_call && (
                                        <code>
                                          {primaryEdge.sample_call.caller_symbol} → {primaryEdge.sample_call.callee_symbol}
                                          {' '}:{primaryEdge.sample_call.line}
                                        </code>
                                      )}
                                    </div>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className={`evo-impacted-card${isSelected ? ' is-selected' : ''}`}
                                  onClick={() => openModuleDrawer(target)}
                                >
                                  <div className="evo-mod-top">
                                    <span className="evo-layer-pill">{target.layer}</span>
                                    <span className="evo-mod-badge is-impacted">
                                      {primaryEdge?.kind === 'new_cross_layer' || primaryEdge?.kind === 'new_same_layer' ? '被新调用' : '联动模块'}
                                    </span>
                                  </div>
                                  <div className="evo-impacted-title">{target.label}</div>
                                  <div className="evo-impacted-sub">模块源码未改动 · 点击核对源码</div>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Direct-to-direct changed edges (if any not already shown under impacted branches) */}
                    {(() => {
                      const shownIds = new Set(impactedModules.map(m => m.id));
                      const extraEdges = changedEdges.filter(e => !shownIds.has(e.to_id) && !shownIds.has(e.from_id));
                      if (!extraEdges.length && !activeEvo.architecture.new_cycles.length) return null;
                      return (
                        <div className="evo-edge-deltas">
                          {activeEvo.architecture.new_cycles.map((cycle, idx) => (
                            <div key={`cyc-${idx}`} className="evo-edge-pill kind-cycle">
                              <span className="evo-edge-badge">⚠ 新增循环依赖</span>
                              <span className="evo-edge-label">{cycle.join(' → ')}</span>
                            </div>
                          ))}
                          {extraEdges.slice(0, 5).map(edge => (
                            <button
                              key={edge.id}
                              type="button"
                              className={`evo-edge-pill kind-${edge.kind}`}
                              onClick={() => openEdgeDrawer(edge)}
                            >
                              <span className="evo-edge-badge">{EDGE_KIND_LABELS[edge.kind]}</span>
                              <span className="evo-edge-label">
                                <strong>{edge.from_label}</strong> → <strong>{edge.to_label}</strong>
                                {' '}（{edge.before_count} → {edge.after_count}）
                              </span>
                            </button>
                          ))}
                        </div>
                      );
                    })()}

                    {/* Non-code build/doc/config changes separated cleanly from runtime architecture */}
                    {nonCodeChanges.length > 0 && (
                      <div className="evo-noncode-strip">
                        <div className="evo-strip-head">
                          <span className="evo-zone-label">构建 / 文档 / 配置改动（非运行时代码模块 · {nonCodeChanges.length}）</span>
                          {nonCodeChanges.length > 6 && (
                            <button type="button" className="hud-mini-btn" onClick={() => setShowAllNonCode(v => !v)}>
                              {showAllNonCode ? '收起' : `展开其余 ${nonCodeChanges.length - 6} 个`}
                            </button>
                          )}
                        </div>
                        <div className="evo-noncode-pills">
                          {(showAllNonCode ? nonCodeChanges : nonCodeChanges.slice(0, 6)).map(item => (
                            <button
                              key={item.path}
                              type="button"
                              className={`evo-changed-file-chip role-${item.role}`}
                              title={item.path}
                              onClick={() => openFileDrawer(item.path, ROLE_LABELS[item.role], 'arch')}
                            >
                              <span className="evo-role-tag">{ROLE_LABELS[item.role]}</span>
                              <span>{shortPath(item.path)}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {quietModuleCount > 0 && (
                      <div className="evo-arch-quiet-note">
                        其余 <strong>{quietModuleCount}</strong> 个架构模块未受本次改动影响（共 {activeEvo.architecture.all_modules_count} 个）
                      </div>
                    )}
                  </div>
                ) : nonCodeChanges.length > 0 ? (
                  <div className="evo-noncode-strip" style={{ marginTop: 8 }}>
                    <div className="evo-zone-label">本次仅修改构建 / 文档 / 配置文件</div>
                    <div className="evo-noncode-pills">
                      {nonCodeChanges.map(item => (
                        <button
                          key={item.path}
                          type="button"
                          className={`evo-changed-file-chip role-${item.role}`}
                          onClick={() => openFileDrawer(item.path, ROLE_LABELS[item.role], 'arch')}
                        >
                          <span className="evo-role-tag">{ROLE_LABELS[item.role]}</span>
                          <span>{shortPath(item.path)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="muted" style={{ margin: '12px 0' }}>本次改动未影响架构模块与依赖结构。</p>
                )}
              </section>
            )}

            {/* RIGHT HERO: Feature Flow Diff with Auto-Folded Unchanged Runs & Inserted New Call Steps */}
            {(effectiveLayout === 'dual' || effectiveLayout === 'flow') && (
              <section className="evo-panel" aria-label="功能流程变动">
                <div className="evo-panel-head">
                  <div>
                    <h3>③ 功能流程变动</h3>
                    <p>
                      {activeFeature?.mode === 'walkthrough_diff'
                        ? '已对齐改前与改后功能流程 · 点击步骤直接定位源码'
                        : activeFeature?.mode === 'walkthrough_stale'
                          ? '已按函数与行号精确标出改动与新增调用位置 · 未改步骤自动折叠'
                          : '按变动函数展示调用演化 · 点击行号直接看 Diff'}
                    </p>
                  </div>
                  <div className="evo-panel-controls">
                    {activeEvo.features.length > 1 && (
                      <select
                        className="evo-feature-select"
                        aria-label="切换关联功能流程"
                        value={featureIdx}
                        onChange={e => setFeatureIdx(Number(e.target.value))}
                      >
                        {activeEvo.features.map((f, i) => (
                          <option key={f.id} value={i}>
                            {f.feature_label}
                          </option>
                        ))}
                      </select>
                    )}
                    {hasMixedFlowChanges && (
                      <button
                        type="button"
                        className="hud-mini-btn"
                        onClick={() => setCompactFlow(v => !v)}
                      >
                        {compactFlow ? `展开全部 (${visibleSteps.length})` : '只看变动'}
                      </button>
                    )}
                    {!showingPlan && <div className="hud-segmented" role="group" aria-label="步骤对比过滤">
                      <button type="button" aria-pressed={flowFilter === 'diff'} onClick={() => setFlowFilter('diff')}>对比</button>
                      <button type="button" aria-pressed={flowFilter === 'before'} onClick={() => setFlowFilter('before')}>改前</button>
                      <button type="button" aria-pressed={flowFilter === 'after'} onClick={() => setFlowFilter('after')}>改后</button>
                    </div>}
                  </div>
                </div>

                {activeFeature?.mode === 'walkthrough_stale' && (
                  <div className="evo-stale-bar">
                    <span>
                      {showingPlan ? activeFeature.stale_notice : activeFeature.steps.some(s => s.inserted)
                        ? '已从源码变更中自动标出新增调用点；如需同步更新中文流程说明，可点击右侧刷新。'
                        : '已按源码改动精确过滤未变步骤；如需重新生成文字流程说明，可点击右侧刷新。'}
                    </span>
                    {onRefreshFeature && !showingPlan && activeFeature.scenario_id && (
                      <button
                        type="button"
                        className="hud-mini-btn"
                        disabled={refreshingScenarioId === activeFeature.scenario_id}
                        onClick={() => onRefreshFeature(activeFeature.scenario_id!)}
                      >
                        {refreshingScenarioId === activeFeature.scenario_id ? '刷新中…' : '刷新文字走读'}
                      </button>
                    )}
                  </div>
                )}

                {displayFlowItems.length > 0 ? (
                  <div className="evo-flow-list">
                    {displayFlowItems.map((item, idx) => {
                      if (item.kind === 'fold') {
                        const first = item.steps[0];
                        const last = item.steps[item.steps.length - 1];
                        return (
                          <React.Fragment key={item.id}>
                            {idx > 0 && <div className="evo-flow-arrow" aria-hidden="true">↓</div>}
                            <button
                              type="button"
                              className="evo-fold-pill"
                              onClick={() => setExpandedFolds(prev => new Set([...prev, item.id]))}
                            >
                              <span>
                                跳过 {item.steps.length} 个未改动步骤（{first.title}
                                {last.title !== first.title ? ` → ${last.title}` : ''}）
                              </span>
                              <strong>展开 ▾</strong>
                            </button>
                          </React.Fragment>
                        );
                      }

                      const step = item.step;
                      const isInserted = !!step.inserted;
                      const isSelected = drawer?.kind === 'step' && drawer.id === step.id;
                      const isLinked = !isSelected && !!step.file && linkedFiles.has(step.file);
                      const pillTone = step.status === 'added'
                        ? 'tone-add'
                        : step.status === 'removed'
                          ? 'tone-del'
                          : step.status === 'modified'
                            ? 'tone-mod'
                            : step.status === 'description_only' || step.status === 'planned'
                              ? 'tone-info'
                              : '';
                      const stepTitle = isInserted
                        ? step.title
                        : flowFilter === 'before'
                          ? (step.before_text ?? step.title)
                          : flowFilter === 'after'
                            ? (step.after_text ?? step.title)
                            : step.title;
                      const sideCalls = (step.call_sites ?? []).filter(cs =>
                        flowFilter === 'before' ? cs.status !== 'added' : flowFilter === 'after' ? cs.status !== 'removed' : true,
                      );
                      const changedCalls = sideCalls.filter(cs => cs.status !== 'unchanged');
                      const shownCalls = changedCalls.length > 0 ? changedCalls.slice(0, 4) : sideCalls.slice(0, 3);

                      return (
                        <React.Fragment key={step.id}>
                          {idx > 0 && <div className="evo-flow-arrow" aria-hidden="true">{isInserted ? '↳' : '↓'}</div>}
                          <div
                            role="button"
                            tabIndex={0}
                            className={`evo-step-card status-${step.status}${isInserted ? ' is-inserted' : ''}${isSelected ? ' is-selected' : ''}${isLinked ? ' is-linked' : ''}`}
                            onClick={() => openStepDrawer(step)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStepDrawer(step); } }}
                          >
                            <div className="evo-step-top">
                              <span className="evo-step-title">
                                {isInserted ? `+ ${stepTitle}` : `${step.order}. ${stepTitle}`}
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                {isInserted && step.line && <code className="evo-line-badge">L{step.line}</code>}
                                <span className={`evo-pill-mini ${pillTone}`}>
                                  {isInserted ? '+ 新增插入' : STEP_STATUS_LABELS[step.status]}
                                </span>
                              </div>
                            </div>
                            {step.subtitle && <div className="evo-step-sub">{step.subtitle}</div>}
                            {step.sub_calls && step.sub_calls.length > 0 && (
                              <div className="evo-subcalls">
                                <span className="evo-subcalls-label">内部调用：</span>
                                {step.sub_calls.map((sc, si) => (
                                  <code key={`${sc}:${si}`} className="evo-subcall-chip">{sc}</code>
                                ))}
                              </div>
                            )}
                            {step.before_signature && step.after_signature && step.before_signature !== step.after_signature && (
                              <div className="evo-step-sig">
                                {flowFilter !== 'after' && <span style={{ textDecoration: flowFilter === 'diff' ? 'line-through' : 'none', color: flowFilter === 'diff' ? 'var(--danger)' : 'var(--ink)' }}>{step.before_signature}</span>}
                                {flowFilter !== 'before' && <span style={{ color: 'var(--accent-hover)' }}>{step.after_signature}</span>}
                              </div>
                            )}
                            {!isInserted && shownCalls.length > 0 && (
                              <div className="evo-step-calls">
                                {shownCalls.map((cs, ci) => (
                                  <button
                                    key={`${cs.file}:${cs.line}:${cs.target_symbol}:${ci}`}
                                    type="button"
                                    className={`evo-callsite-chip status-${cs.status}`}
                                    title={`${cs.file}:${cs.line} → ${cs.target_symbol} (${cs.target_file})`}
                                    onClick={e => {
                                      e.stopPropagation();
                                      openStepDrawer(step, cs);
                                    }}
                                  >
                                    <span>L{cs.line}</span>
                                    <span>{cs.status === 'added' ? '+' : cs.status === 'removed' ? '−' : '·'} {shortPath(cs.target_symbol)}</span>
                                    {cs.ambiguous && <span>[候选]</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </React.Fragment>
                      );
                    })}
                    {activeFeature && activeFeature.omitted_steps > 0 && (
                      <small className="muted" style={{ paddingTop: 4 }}>
                        另有 {activeFeature.omitted_steps} 个步骤未展开
                        {onViewAllFiles ? '（可点右上角「全部 Diff」查看）' : ''}
                      </small>
                    )}
                  </div>
                ) : (
                  <p className="muted" style={{ margin: '12px 0' }}>当前过滤条件下暂无可展示的功能步骤。</p>
                )}
              </section>
            )}
          </div>

          {/* Inline desktop drawer (never squeezes dual columns) */}
          {drawer && !drawerOverlay && (
            <aside className="evo-drawer" aria-label="源码与证据详情抽屉">
              <div className="evo-drawer-head">
                <div style={{ minWidth: 0 }}>
                  <span className="evo-drawer-kicker">{drawer.kicker}</span>
                  <strong>{drawer.title}</strong>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {openInEditor && drawer.activeFile && (
                    <button
                      type="button"
                      className="hud-mini-btn"
                      onClick={() => void handleOpenEditor(drawer.activeFile!, drawer.focusLine)}
                    >
                      VS Code ↗
                    </button>
                  )}
                  <button
                    type="button"
                    className="hud-drawer-close"
                    aria-label="关闭源码抽屉"
                    onClick={() => setDrawer(null)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {renderDrawerBody(drawer, 360)}
            </aside>
          )}
        </div>
      )}

      {/* Slide-over overlay drawer (narrow screens & document-only mode) */}
      {drawer && drawerOverlay && (
        <>
          <div className="evo-drawer-backdrop" onClick={() => setDrawer(null)} />
          <aside className="evo-drawer is-overlay" aria-label="源码与证据详情抽屉">
            <div className="evo-drawer-head">
              <div style={{ minWidth: 0 }}>
                <span className="evo-drawer-kicker">{drawer.kicker}</span>
                <strong>{drawer.title}</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {openInEditor && drawer.activeFile && (
                  <button type="button" className="hud-mini-btn" onClick={() => void handleOpenEditor(drawer.activeFile!, drawer.focusLine)}>
                    VS Code ↗
                  </button>
                )}
                <button type="button" className="hud-drawer-close" aria-label="关闭源码抽屉" onClick={() => setDrawer(null)}>✕</button>
              </div>
            </div>
            {renderDrawerBody(drawer, 380)}
          </aside>
        </>
      )}

      {/* Band 3: Quiet Side-Effect & Reconciliation Footer */}
      <footer className="evo-footer">
        <div className="evo-footer-left">
          <button
            type="button"
            className={`evo-se-trigger${hasHighRisk ? ' has-high' : activeEvo.side_effects.length ? ' has-warn' : ''}`}
            onClick={openAllSideEffectsDrawer}
          >
            <span>⚡ 额外提醒</span>
            <span>{footerAlertText}</span>
          </button>

          {activeEvo.drift && (
            <span className="evo-drift-pill" title="批准范围与实际改动文件的对账">
              {activeEvo.drift.attribution_pending
                ? '归属待核（工作区存在未归属差异）'
                : `范围对账：命中 ${activeEvo.drift.matched_files.length} 个 · 未改计划 ${activeEvo.drift.untouched_planned_files.length} 个${activeEvo.drift.out_of_scope_files.length ? ` · 额外改动 ${activeEvo.drift.out_of_scope_files.length} 个` : ''}`}
            </span>
          )}
        </div>

        <div className="evo-footer-right">
          {footerActions}
        </div>
      </footer>
    </div>
  );
}
