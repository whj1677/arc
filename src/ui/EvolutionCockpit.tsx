import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  EvolutionArchEdge,
  EvolutionArchModule,
  EvolutionAssumption,
  EvolutionCallSite,
  EvolutionFeatureFlow,
  EvolutionFlowStep,
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
  kind: 'module' | 'edge' | 'step' | 'side_effects' | 'assumption';
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
      // Preserve an uncollapsed window around the target line BEFORE collapsing distant context
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

const STEP_STATUS_LABELS: Record<EvolutionFlowStep['status'], string> = {
  added: '+ 新增',
  removed: '− 移除',
  modified: '~ 改动',
  description_only: '描述变化',
  planned: '拟改动',
  unchanged: '未变',
};

const EDGE_KIND_LABELS: Record<EvolutionArchEdge['kind'], string> = {
  new_cross_layer: '+ 新增跨层依赖',
  new_same_layer: '+ 新增同层依赖',
  strengthened: '依赖增重',
  removed: '− 移除依赖',
  existing: '已有依赖',
};

export function EvolutionCockpit({
  evolution,
  revisionKey,
  blueprintEvolution,
  modeLabel,
  headerExtra,
  footerActions,
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
  const [featureIdx, setFeatureIdx] = useState<number>(evolution.active_feature_index || 0);
  const [expandAllAssumptions, setExpandAllAssumptions] = useState(false);
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
  const evoVersionKey = revisionKey ?? `${activeEvo.base_label}:${activeEvo.target_label}:${activeEvo.mode}:${activeEvo.changed_files.map(f => f.path).join('|')}`;

  useEffect(() => {
    setFeatureIdx(activeEvo.active_feature_index || 0);
    setDrawer(null);
    setExpandAllAssumptions(false);
    setDocSelectedFile(prev =>
      activeEvo.changed_files.some(f => f.path === prev) ? prev : (activeEvo.changed_files[0]?.path ?? ''),
    );
  }, [evoVersionKey, activeEvo.active_feature_index]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load diff/source for drawer activeFile
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
    loadFileDiff({ path: drawerFile, snapshotId: drawerSnap, side: drawerSide, preferFrozen: drawerPreferFrozen })
      .then(res => { if (alive) setDrawerDiff(res); })
      .catch((e: Error) => { if (alive) { setDrawerDiff(null); setDrawerDiffError(e.message); } })
      .finally(() => { if (alive) setDrawerDiffLoading(false); });
    return () => { alive = false; };
  }, [drawerFile, drawerSnap, drawerSide, drawerPreferFrozen, loadFileDiff, evoVersionKey]);

  // Load diff for document-only mode
  useEffect(() => {
    if (!activeEvo.document_only || !docSelectedFile) {
      setDocDiff(null);
      setDocDiffError('');
      return;
    }
    let alive = true;
    setDocDiffLoading(true);
    setDocDiffError('');
    loadFileDiff({ path: docSelectedFile })
      .then(res => { if (alive) setDocDiff(res); })
      .catch((e: Error) => { if (alive) { setDocDiff(null); setDocDiffError(e.message); } })
      .finally(() => { if (alive) setDocDiffLoading(false); });
    return () => { alive = false; };
  }, [activeEvo.document_only, docSelectedFile, loadFileDiff, evoVersionKey]);

  const focusedRows = useMemo(() => {
    if (!drawerDiff || drawerDiff.binary) return null;
    if (!drawerDiff.before && !drawerDiff.after) return [];
    return buildFocusedRows(drawerDiff.before, drawerDiff.after, drawer?.focusLine, drawer?.side);
  }, [drawerDiff, drawer?.focusLine, drawer?.side]);

  useEffect(() => {
    const pre = codeRef.current;
    if (!pre || !focusedRows?.length || !drawer?.focusLine) return;
    const target = pre.querySelector<HTMLElement>('.hud-diff-line.is-focus');
    if (target) pre.scrollTop = Math.max(0, target.offsetTop - pre.clientHeight / 2 + target.clientHeight / 2);
  }, [focusedRows, drawer?.focusLine]);

  // Responsive layout math: each diagram needs >= 520px when dual; drawer never squeezes dual columns!
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

  // Sort review blockers before general design assumptions so critical items appear at top of Band 1
  const orderedAssumptions = useMemo(
    () => [...activeEvo.assumptions].sort((a, b) => Number(b.source === 'review_blocker') - Number(a.source === 'review_blocker')),
    [activeEvo.assumptions],
  );

  // Group architecture modules by layer
  const archLayers = useMemo(() => {
    const groups = new Map<string, { layer: string; order: number; items: EvolutionArchModule[] }>();
    for (const m of activeEvo.architecture.modules) {
      const existing = groups.get(m.layer);
      if (existing) existing.items.push(m);
      else groups.set(m.layer, { layer: m.layer, order: m.layer_order, items: [m] });
    }
    return [...groups.values()].sort((a, b) => a.order - b.order);
  }, [activeEvo.architecture.modules]);

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

  function openModuleDrawer(mod: EvolutionArchModule) {
    const files = mod.changed_files.length ? mod.changed_files : mod.files;
    const relatedSe = activeEvo.side_effects.filter(
      se => se.module_ids?.includes(mod.id) || (se.file && files.includes(se.file)),
    );
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'module',
      id: mod.id,
      kicker: `架构模块 · ${mod.layer}`,
      title: mod.label,
      summary: mod.summary || (mod.changed_files.length
        ? `本轮涉及 ${mod.changed_files.length} 个改动文件（符号 +${mod.added_symbols}/−${mod.removed_symbols}/~${mod.modified_symbols}）。`
        : `关联 ${mod.files.length} 个源码文件（本轮未直接修改）。`),
      files,
      activeFile: files[0],
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
      kicker: `架构依赖 · ${EDGE_KIND_LABELS[edge.kind]}`,
      title: `${edge.from_label} → ${edge.to_label}`,
      summary: `跨模块调用次数由 ${edge.before_count} 变为 ${edge.after_count}${edge.sample_call ? `，示例调用点位于 ${edge.sample_call.caller_symbol} → ${edge.sample_call.callee_symbol}` : ''}。`,
      files,
      activeFile: edge.sample_call?.file,
      focusLine: edge.sample_call?.line,
      sideEffects: relatedSe,
      originPanel: 'arch',
    });
  }

  function openStepDrawer(step: EvolutionFlowStep, focusCall?: EvolutionCallSite) {
    const isBefore = flowFilter === 'before' || focusCall?.status === 'removed' || step.status === 'removed' || activeFeature?.mode === 'walkthrough_stale';
    const side: 'before' | 'after' = isBefore ? 'before' : 'after';
    const file = focusCall?.file ?? step.file ?? undefined;
    const line = focusCall?.line ?? (isBefore ? (step.before_line ?? step.line) : (step.after_line ?? step.before_line ?? step.line));
    const snapshotId = isBefore ? activeFeature?.before_snapshot_id : (activeFeature?.after_snapshot_id ?? activeFeature?.before_snapshot_id);
    const preferFrozen = activeFeature?.mode === 'walkthrough_stale' && !!activeFeature.before_snapshot_id && activeFeature.before_snapshot_id !== activeEvo.base_snapshot_id;
    const stepCalls = (step.call_sites ?? []).filter(cs =>
      flowFilter === 'before' ? cs.status !== 'added' : flowFilter === 'after' ? cs.status !== 'removed' : true,
    );
    const files = [...new Set([file, ...stepCalls.map(c => c.file)].filter((f): f is string => !!f))];
    const relatedSe = activeEvo.side_effects.filter(se => file && (se.file === file || se.target_file === file));
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'step',
      id: step.id,
      kicker: `功能步骤 · ${STEP_STATUS_LABELS[step.status]}`,
      title: isBefore ? (step.before_text ?? step.title) : step.title,
      summary: (isBefore ? step.before_text : step.after_text) || step.before_text || step.subtitle || (step.symbol ? `聚焦符号：${step.symbol}` : undefined),
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
          title: a.file ? `${shortPath(a.file)} 审查提示` : '审查提示',
          detail: a.text,
          file: a.file,
          fix: a.fix,
        }]
      : [];
    setDrawerDiffMode('focused');
    setDrawer({
      kind: 'assumption',
      id: a.id,
      kicker: a.source === 'review_blocker' ? '待处理事项（AI 推断）' : '关键假设与设计取舍',
      title: a.file ? `${shortPath(a.file)} · ${a.text.slice(0, 46)}` : a.text.slice(0, 56),
      summary: a.text,
      files,
      activeFile: a.file,
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
      kicker: '隐性波及与工程风险汇总',
      title: `AST 实证 ${astSideEffects.length} 项 · AI 推断 ${aiSideEffects.length} 项`,
      summary: '实线卡片为本地 AST 静态索引直接证实的源码事实；虚线卡片为基于需求/约束/独立审查的推理提示。',
      files: [...new Set(activeEvo.side_effects.map(s => s.file).filter((f): f is string => !!f))],
      activeFile: firstFile,
      focusLine: firstLine,
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

  return (
    <div className="evo-cockpit">
      {/* Compact Cockpit Control Bar */}
      <div className="evo-topbar">
        <div className="evo-topbar-left">
          <span className={`evo-mode-chip${isBlueprint ? ' is-blueprint' : ''}`}>
            {modeLabel || (isBlueprint ? '改前蓝图预演' : activeEvo.mode === 'workspace_radar' ? '工作区实时比对' : '改后实景对照')}
          </span>
          {blueprintEvolution && (
            <div className="hud-segmented" role="group" aria-label="阶段视角">
              <button type="button" aria-pressed={phaseView === 'blueprint'} onClick={() => setPhaseView('blueprint')}>
                蓝图预演
              </button>
              <button type="button" aria-pressed={phaseView === 'actual'} onClick={() => setPhaseView('actual')}>
                实景对照
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
                  双图同屏
                </button>
              )}
              <button type="button" aria-pressed={effectiveLayout === 'arch'} onClick={() => setLayoutPref('arch')}>
                架构变动
              </button>
              <button type="button" aria-pressed={effectiveLayout === 'flow'} onClick={() => setLayoutPref('flow')}>
                功能变动
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

      {/* Band 1: Compact Approach & Key Trade-offs (or quiet Workspace Observation in zero-task radar) */}
      {activeEvo.mode === 'workspace_radar' ? (
        <div className="evo-radar-observe">
          <span>
            <strong>工作区观察</strong> · 基准 <code>{shortRef(activeEvo.base_label)}</code> → <code>{shortRef(activeEvo.target_label)}</code>
          </span>
          <span className="evo-radar-observe-stats">
            <span>{activeEvo.changed_files.length} 改动文件（{sourceChangedCount} 源码）</span>
            {activeEvo.architecture.mode !== 'empty' && (
              <span>
                {activeEvo.architecture.mode === 'overview' ? '架构命中' : '目录命中'}{' '}
                {activeEvo.architecture.modules.filter(m => m.relation === 'direct').length}
              </span>
            )}
          </span>
        </div>
      ) : (activeEvo.approach.length > 0 || orderedAssumptions.length > 0) ? (
        <section className={`evo-band1${!orderedAssumptions.length || !activeEvo.approach.length ? ' is-single' : ''}`}>
          {activeEvo.approach.length > 0 && (
            <div className="evo-strip-card">
              <div className="evo-strip-head">
                <strong>① 这次怎么改</strong>
                <small>{activeEvo.changed_files.length ? `落地 ${activeEvo.changed_files.length} 文件` : `计划 ${activeEvo.approach.length} 步`}</small>
              </div>
              <div className="evo-approach-row">
                {activeEvo.approach.slice(0, 4).map((step, i) => (
                  <button
                    key={step.id}
                    type="button"
                    className="evo-approach-chip"
                    title={`${step.title}\n${step.detail}`}
                    onClick={() => {
                      const file = step.files[0];
                      setDrawerDiffMode('focused');
                      setDrawer({
                        kind: 'step',
                        id: step.id,
                        kicker: `改动思路 · 第 ${i + 1} 步`,
                        title: step.title,
                        summary: step.detail,
                        files: step.files,
                        activeFile: file,
                        sideEffects: activeEvo.side_effects.filter(se => se.file && step.files.includes(se.file)),
                        originPanel: effectiveLayout === 'arch' ? 'arch' : 'flow',
                      });
                    }}
                  >
                    <strong>{i + 1}. {step.title}</strong>
                    <span>{step.detail}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {orderedAssumptions.length > 0 && (
            <div className="evo-strip-card is-warn">
              <div className="evo-strip-head">
                <strong>⚠ 关键取舍与待决 ({orderedAssumptions.length})</strong>
                {orderedAssumptions.length > 2 && (
                  <button type="button" className="hud-mini-btn" onClick={() => setExpandAllAssumptions(v => !v)}>
                    {expandAllAssumptions ? '收起' : `展开全部`}
                  </button>
                )}
              </div>
              <div className="evo-assumption-list">
                {(expandAllAssumptions ? orderedAssumptions : orderedAssumptions.slice(0, 2)).map(a => (
                  <button
                    key={a.id}
                    type="button"
                    className={`evo-assumption-row${a.source === 'review_blocker' ? ' is-blocker' : ''}`}
                    title={a.text}
                    onClick={() => openAssumptionDrawer(a)}
                  >
                    <span className="evo-assumption-text">
                      {a.file ? `${shortPath(a.file)}：` : ''}{a.text}
                    </span>
                    <span className="evo-assumption-tag">
                      {a.source === 'review_blocker' ? '待处理' : '取舍'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : null}

      {/* Document-Only Fast Path (e.g. 需求agent重构) */}
      {activeEvo.document_only ? (
        <section className="evo-doc-only">
          <aside className="evo-panel">
            <div className="evo-panel-head">
              <div>
                <h3>文档 / 非源码改动 ({activeEvo.changed_files.length})</h3>
                <p>本次不含可解析源码，已自动收起双图直给文件对比</p>
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
                    <span className="evo-pill-mini">{f.status}</span>
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
        /* Band 2: Dual Visual Hero + Non-Squeezing Evidence Drawer */
        <div ref={stageRef} className="evo-stage-wrap">
          <div className={`evo-panels${effectiveLayout !== 'dual' ? ' is-single' : ''}`}>
            {/* LEFT HERO: Architecture Diff */}
            {(effectiveLayout === 'dual' || effectiveLayout === 'arch') && (
              <section className="evo-panel" aria-label="系统架构变动">
                <div className="evo-panel-head">
                  <div>
                    <h3>② 系统架构变动</h3>
                    <p>
                      {activeEvo.architecture.mode === 'overview'
                        ? '叠加在「工程全貌」模块图上 · 点击模块查看源码与波及'
                        : activeEvo.architecture.mode === 'directory_fallback'
                          ? '尚未生成工程全貌，已降级展示源码目录依赖'
                          : '暂无可映射的源码模块'}
                    </p>
                  </div>
                  <div className="evo-panel-controls">
                    <div className="evo-legend">
                      <span className="evo-pill-mini tone-mod">~ 改动</span>
                      <span className="evo-pill-mini tone-add">⚡ 波及</span>
                    </div>
                    {onOpenArchitectureOverlay && activeEvo.architecture.mode === 'overview' && (
                      <button
                        type="button"
                        className="hud-mini-btn"
                        onClick={() => onOpenArchitectureOverlay(activeEvo.architecture.architecture_result_id)}
                      >
                        全貌大图 ↗
                      </button>
                    )}
                  </div>
                </div>

                {archLayers.length > 0 ? (
                  <div className="evo-arch-layers">
                    {archLayers.map(group => (
                      <div key={group.layer} className="evo-layer-box">
                        <div className="evo-layer-title">{group.layer}</div>
                        <div className="evo-layer-grid">
                          {group.items.map(mod => {
                            const addedOnly = mod.relation === 'direct' && mod.added_symbols > 0 && mod.modified_symbols === 0 && mod.removed_symbols === 0;
                            const isSelected = drawer?.kind === 'module' && drawer.id === mod.id;
                            const isLinked = !isSelected && mod.files.some(f => linkedFiles.has(f));
                            const badgeText = mod.relation === 'direct'
                              ? (isBlueprint ? '拟改动' : addedOnly ? '+ 新增' : '~ 核心改动')
                              : mod.relation === 'neighbor'
                                ? '⚡ 邻接波及'
                                : mod.relation === 'gap'
                                  ? '✕ 待接入'
                                  : '未动';
                            const deltaText = mod.added_symbols || mod.removed_symbols || mod.modified_symbols
                              ? `+${mod.added_symbols}/−${mod.removed_symbols}/~${mod.modified_symbols}`
                              : mod.changed_files.length
                                ? `${mod.changed_files.length} 文件`
                                : '';
                            return (
                              <button
                                key={mod.id}
                                type="button"
                                className={`evo-mod-card is-${mod.relation}${addedOnly ? ' is-added-only' : ''}${isBlueprint && mod.relation !== 'unchanged' ? ' is-blueprint' : ''}${isSelected ? ' is-selected' : ''}${isLinked ? ' is-linked' : ''}`}
                                onClick={() => openModuleDrawer(mod)}
                              >
                                <div className="evo-mod-top">
                                  <span>{badgeText}</span>
                                  {deltaText && <span style={{ fontFamily: 'var(--font-mono)' }}>{deltaText}</span>}
                                </div>
                                <div className="evo-mod-name" title={mod.label}>{mod.label}</div>
                                <div className="evo-mod-sub" title={mod.changed_files[0] || mod.files[0] || ''}>
                                  {mod.changed_files[0] ? shortPath(mod.changed_files[0]) : mod.files[0] ? shortPath(mod.files[0]) : `${mod.files.length} 关联文件`}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    {activeEvo.architecture.omitted_modules > 0 && (
                      <small className="muted">
                        首屏优先聚焦直接命中与邻接模块，另有 {activeEvo.architecture.omitted_modules} 个其余模块（共 {activeEvo.architecture.all_modules_count} 个）
                      </small>
                    )}

                    {/* Explicit Dependency Deltas & Cycles */}
                    {(() => {
                      const deltaEdges = activeEvo.architecture.edges.filter(e => e.kind !== 'existing');
                      if (!deltaEdges.length && !activeEvo.architecture.new_cycles.length) return null;
                      return (
                        <div className="evo-edge-deltas">
                          {activeEvo.architecture.new_cycles.map((cycle, idx) => (
                            <div key={`cyc-${idx}`} className="evo-edge-pill kind-cycle">
                              <span className="evo-edge-badge">⚠ 新增环</span>
                              <span className="evo-edge-label">{cycle.join(' → ')}</span>
                            </div>
                          ))}
                          {deltaEdges.slice(0, 6).map(edge => (
                            <button
                              key={edge.id}
                              type="button"
                              className={`evo-edge-pill kind-${edge.kind}`}
                              onClick={() => openEdgeDrawer(edge)}
                            >
                              <span className="evo-edge-badge">{EDGE_KIND_LABELS[edge.kind]}</span>
                              <span className="evo-edge-label">
                                <strong>{edge.from_label}</strong> → <strong>{edge.to_label}</strong>
                                {edge.kind === 'strengthened' ? `（${edge.before_count} → ${edge.after_count}）` : ''}
                              </span>
                              {edge.sample_call && (
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
                                  :{edge.sample_call.line}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <p className="muted" style={{ margin: '12px 0' }}>本次变动未命中可投影的源码模块。</p>
                )}
              </section>
            )}

            {/* RIGHT HERO: Feature Flow Diff */}
            {(effectiveLayout === 'dual' || effectiveLayout === 'flow') && (
              <section className="evo-panel" aria-label="功能图变动">
                <div className="evo-panel-head">
                  <div>
                    <h3>③ 功能图变动</h3>
                    <p>
                      {activeFeature?.mode === 'walkthrough_diff'
                        ? '基于改前/改后双版走读对齐 · 点击步骤核对精确源码'
                        : activeFeature?.mode === 'walkthrough_stale'
                          ? '基于已有功能走读投影 · 点击高亮步骤下钻代码'
                          : '本地 AST 实时变动符号流（零 LLM 等待）· 保留精确调用行'}
                    </p>
                  </div>
                  <div className="evo-panel-controls">
                    {activeEvo.features.length > 1 && (
                      <select
                        className="evo-feature-select"
                        aria-label="切换关联功能图"
                        value={featureIdx}
                        onChange={e => setFeatureIdx(Number(e.target.value))}
                      >
                        {activeEvo.features.map((f, i) => (
                          <option key={f.id} value={i}>
                            {f.feature_label} ({f.mode === 'walkthrough_diff' ? '双版' : f.mode === 'walkthrough_stale' ? '旧走读' : 'AST'})
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="hud-segmented" role="group" aria-label="步骤对比过滤">
                      <button type="button" aria-pressed={flowFilter === 'diff'} onClick={() => setFlowFilter('diff')}>对比</button>
                      <button type="button" aria-pressed={flowFilter === 'before'} onClick={() => setFlowFilter('before')}>改前</button>
                      <button type="button" aria-pressed={flowFilter === 'after'} onClick={() => setFlowFilter('after')}>改后</button>
                    </div>
                  </div>
                </div>

                {activeFeature?.stale_notice && (
                  <div className="evo-stale-bar">
                    <span>{activeFeature.stale_notice}</span>
                    {onRefreshFeature && activeFeature.scenario_id && (
                      <button
                        type="button"
                        className="hud-mini-btn"
                        disabled={refreshingScenarioId === activeFeature.scenario_id}
                        onClick={() => onRefreshFeature(activeFeature.scenario_id!)}
                      >
                        {refreshingScenarioId === activeFeature.scenario_id ? '刷新中…' : '刷新走读'}
                      </button>
                    )}
                  </div>
                )}

                {visibleSteps.length > 0 ? (
                  <div className="evo-flow-list">
                    {visibleSteps.map((step, idx) => {
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
                      const stepTitle = flowFilter === 'before'
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
                          {idx > 0 && <div className="evo-flow-arrow" aria-hidden="true">↓</div>}
                          <div
                            role="button"
                            tabIndex={0}
                            className={`evo-step-card status-${step.status}${isSelected ? ' is-selected' : ''}${isLinked ? ' is-linked' : ''}`}
                            onClick={() => openStepDrawer(step)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStepDrawer(step); } }}
                          >
                            <div className="evo-step-top">
                              <span className="evo-step-title">
                                {step.order}. {stepTitle}
                              </span>
                              <span className={`evo-pill-mini ${pillTone}`}>{STEP_STATUS_LABELS[step.status]}</span>
                            </div>
                            {step.subtitle && <div className="evo-step-sub">{step.subtitle}</div>}
                            {step.before_signature && step.after_signature && step.before_signature !== step.after_signature && (
                              <div className="evo-step-sig">
                                {flowFilter !== 'after' && <span style={{ textDecoration: flowFilter === 'diff' ? 'line-through' : 'none', color: flowFilter === 'diff' ? 'var(--danger)' : 'var(--ink)' }}>{step.before_signature}</span>}
                                {flowFilter !== 'before' && <span style={{ color: 'var(--accent-hover)' }}>{step.after_signature}</span>}
                              </div>
                            )}
                            {shownCalls.length > 0 && (
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
                        另有 {activeFeature.omitted_steps} 个低优先级变动符号未展开
                        {onViewAllFiles ? '（可点右上角「全部 Diff」浏览）' : ''}
                      </small>
                    )}
                  </div>
                ) : (
                  <p className="muted" style={{ margin: '12px 0' }}>当前过滤条件下暂无可展示的功能步骤。</p>
                )}
              </section>
            )}
          </div>

          {/* Inline desktop drawer (when NOT document_only and NOT overlay) */}
          {drawer && !drawerOverlay && (
            <aside className="evo-drawer" aria-label="模块与源码下钻抽屉">
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

              <div className="evo-drawer-body">
                {openErr && <small className="warning">{openErr}</small>}
                {drawer.summary && <p className="evo-drawer-summary">{drawer.summary}</p>}

                {drawer.sideEffects.length > 0 && (
                  <div className="evo-se-list">
                    {drawer.sideEffects.map(se => (
                      <div key={se.id} className={`evo-se-item kind-${se.evidence_kind} sev-${se.severity}`}>
                        <div className="evo-se-top">
                          <strong>{se.title}</strong>
                          <span className="evo-se-badge">
                            {se.evidence_kind === 'ast_proved' ? 'AST 实证' : 'AI 推断'}
                          </span>
                        </div>
                        <div className="evo-se-detail">{se.detail}</div>
                        {se.fix && <div className="evo-se-fix"><strong>建议：</strong>{se.fix}</div>}
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

                {drawer.callSites && drawer.callSites.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <small className="muted">精确调用点（点击定位源码行）</small>
                    <div className="evo-step-calls">
                      {drawer.callSites.map((cs, i) => (
                        <button
                          key={`${cs.file}:${cs.line}:${i}`}
                          type="button"
                          className={`evo-callsite-chip status-${cs.status}`}
                          onClick={() => setDrawer(prev => prev ? {
                            ...prev,
                            activeFile: cs.file,
                            focusLine: cs.line,
                            side: cs.status === 'removed' ? 'before' : 'after',
                          } : prev)}
                        >
                          <span>{shortPath(cs.file)}:L{cs.line}</span>
                          <span>→ {cs.target_symbol}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {drawer.files.length > 1 && (
                  <div className="evo-file-pills">
                    {drawer.files.slice(0, 12).map(file => (
                      <button
                        key={file}
                        type="button"
                        className={`evo-file-pill${drawer.activeFile === file ? ' is-active' : ''}`}
                        title={file}
                        onClick={() => setDrawer(prev => prev ? { ...prev, activeFile: file, focusLine: undefined, snapshotId: undefined, preferFrozen: false } : prev)}
                      >
                        {shortPath(file)}
                      </button>
                    ))}
                  </div>
                )}

                {drawer.activeFile && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <code style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {drawer.activeFile}{drawer.focusLine ? `:${drawer.focusLine}` : ''}
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
                      <pre ref={codeRef} className="hud-inspector-diff" style={{ maxHeight: 360, fontSize: 12.5 }}>
                        {focusedRows.map((row, idx) => {
                          const focused = row.type !== 'gap' && !!drawer.focusLine &&
                            (drawer.side === 'before' ? row.oldLine === drawer.focusLine
                              : drawer.side === 'after' ? row.newLine === drawer.focusLine
                                : (row.newLine === drawer.focusLine || row.oldLine === drawer.focusLine));
                          return (
                            <span key={idx} className={`hud-diff-line ${row.type}${focused ? ' is-focus' : ''}`}>
                              <b>{row.type === 'gap' ? '…' : (drawer.side === 'before' ? (row.oldLine ?? row.newLine ?? '') : (row.newLine ?? row.oldLine ?? ''))}</b>
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
            </aside>
          )}
        </div>
      )}

      {/* Shared slide-over overlay drawer (works in BOTH narrow viewports AND document_only mode!) */}
      {drawer && drawerOverlay && (
        <>
          <div className="evo-drawer-backdrop" onClick={() => setDrawer(null)} />
          <aside className="evo-drawer is-overlay" aria-label="模块与源码下钻抽屉">
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
            <div className="evo-drawer-body">
              {openErr && <small className="warning">{openErr}</small>}
              {drawer.summary && <p className="evo-drawer-summary">{drawer.summary}</p>}
              {drawer.sideEffects.length > 0 && (
                <div className="evo-se-list">
                  {drawer.sideEffects.map(se => (
                    <div key={se.id} className={`evo-se-item kind-${se.evidence_kind} sev-${se.severity}`}>
                      <div className="evo-se-top">
                        <strong>{se.title}</strong>
                        <span className="evo-se-badge">{se.evidence_kind === 'ast_proved' ? 'AST 实证' : 'AI 推断'}</span>
                      </div>
                      <div className="evo-se-detail">{se.detail}</div>
                      {se.fix && <div className="evo-se-fix"><strong>建议：</strong>{se.fix}</div>}
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
              {drawer.activeFile && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <code style={{ fontSize: 11.5, color: 'var(--muted)' }}>{drawer.activeFile}{drawer.focusLine ? `:${drawer.focusLine}` : ''}</code>
                  {drawerDiffLoading ? (
                    <small className="muted">读取源码对比…</small>
                  ) : drawerDiffError ? (
                    <small className="warning">{drawerDiffError}</small>
                  ) : drawerDiff?.binary ? (
                    <small className="muted">二进制文件，暂不支持文本 Diff。</small>
                  ) : focusedRows && focusedRows.length > 0 ? (
                    <pre ref={codeRef} className="hud-inspector-diff" style={{ maxHeight: 380, fontSize: 12.5 }}>
                      {focusedRows.map((row, idx) => {
                        const focused = row.type !== 'gap' && !!drawer.focusLine &&
                          (drawer.side === 'before' ? row.oldLine === drawer.focusLine
                            : drawer.side === 'after' ? row.newLine === drawer.focusLine
                              : (row.newLine === drawer.focusLine || row.oldLine === drawer.focusLine));
                        return (
                          <span key={idx} className={`hud-diff-line ${row.type}${focused ? ' is-focus' : ''}`}>
                            <b>{row.type === 'gap' ? '…' : (drawer.side === 'before' ? (row.oldLine ?? row.newLine ?? '') : (row.newLine ?? row.oldLine ?? ''))}</b>
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
            <span>⚡ 隐性波及</span>
            <span>
              {activeEvo.side_effects.length === 0
                ? '未检出明显副作用'
                : `${astSideEffects.length} AST实证${aiSideEffects.length ? ` · ${aiSideEffects.length} AI推断` : ''}`}
            </span>
          </button>

          {activeEvo.drift && (
            <span className="evo-drift-pill" title="蓝图批准范围与实际变更文件的精确对账">
              {activeEvo.drift.attribution_pending
                ? '归属待核（存在混改或未归属差异）'
                : `范围对账：命中 ${activeEvo.drift.matched_files.length} · 未触及 ${activeEvo.drift.untouched_planned_files.length}${activeEvo.drift.out_of_scope_files.length ? ` · 超范围 ${activeEvo.drift.out_of_scope_files.length}` : ''}${activeEvo.drift.overlap_files.length ? ` · 重叠 ${activeEvo.drift.overlap_files.length}` : ''}`}
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
