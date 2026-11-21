import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  HudArchitectureEdge,
  HudArchitectureNode,
  HudExternalCaller,
  TaskHudSnapshot,
  TaskHudStructureDiff,
  WalkthroughDiff,
  WalkthroughDiffNode,
  WalkthroughDiffStep,
  WalkthroughPathDiff,
} from '../development-hud';
import type { DevelopmentAttempt, EngineeringTask } from '../engineering';
import type { ReadingQuestion, WorkspaceData } from '../shared';
import type { Dispatch } from '../main/external-dispatch';
import { effectiveTaskBoundaries, taskBoundaryKey } from '../task-boundaries';
import { collapseUnifiedContext, computeLineDiff } from './text-diff';
import { TaskBoundaries } from './TaskBoundaries';
import './development-hud.css';

const arc = () => window.arc;

export interface TaskArchitectureOverlay {
  taskId: string;
  goal: string;
  resultId?: string;
  nodes: ReadonlyMap<string, 'direct' | 'neighbor'>;
}

export function useTaskHud(taskId: string | undefined, taskVersion: number | undefined, enabled = true) {
  const [hud, setHud] = useState<TaskHudSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const activeTask = useRef(taskId);
  activeTask.current = taskId;

  const reload = useCallback(async () => {
    const targetId = taskId;
    if (!targetId || !enabled) {
      seq.current++;
      setHud(null);
      setError('');
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    try {
      const value = await arc().invoke<TaskHudSnapshot>('engineering_task_hud', { task_id: targetId });
      if (mine === seq.current && activeTask.current === targetId) {
        setHud(value);
        setError('');
      }
    } catch (e) {
      if (mine === seq.current && activeTask.current === targetId) {
        setHud(null);
        setError((e as Error).message);
      }
    } finally {
      if (mine === seq.current && activeTask.current === targetId) setLoading(false);
    }
  }, [taskId, enabled]);

  useEffect(() => {
    setHud(prev => (prev?.task_id === taskId ? prev : null));
    setError('');
    void reload();
  }, [reload, taskId, taskVersion]);

  useEffect(() => {
    if (!taskId || !enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const off = arc().onEvent(e => {
      if (e.type !== 'changed' && e.type !== 'engineering_changed') return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 350);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [taskId, enabled, reload]);

  return { hud: hud?.task_id === taskId ? hud : null, loading, error, reload };
}

function shortFile(file: string | null | undefined) {
  return file ? file.split('/').at(-1) || file : '未定位文件';
}

function shortSymbol(symbol: string) {
  return symbol.split(/[.:]/).filter(Boolean).at(-1) || symbol;
}

const stepKindLabels: Record<WalkthroughDiffStep['kind'], string> = {
  entry: '入口',
  call: '同步调用',
  callback: '回调',
  dispatch: '异步派发',
  return: '返回',
  work: '处理',
};

/* ==========================================================================
   Mini Architecture Overlay SVG (Warm Alabaster + Deep Forest)
   ========================================================================== */
function MiniArchitectureOverlay({
  nodes,
  edges,
  onOpenFull,
}: {
  nodes: HudArchitectureNode[];
  edges: HudArchitectureEdge[];
  onOpenFull?: () => void;
}) {
  const markerId = 'hud-arch-' + useId().replace(/:/g, '');
  const direct = nodes.filter(n => n.relation === 'direct');
  const neighbors = nodes.filter(n => n.relation === 'neighbor');
  const cardW = 192;
  const cardH = 54;
  const gapY = 14;
  const leftX = 18;
  const rightX = neighbors.length ? 306 : 18;
  const rows = Math.max(direct.length, neighbors.length, 1);
  const width = neighbors.length ? 520 : 230;
  const height = Math.max(108, 28 + rows * (cardH + gapY));

  const pos = new Map<string, { x: number; y: number }>();
  direct.forEach((n, i) => {
    const startY = (height - (direct.length * cardH + Math.max(0, direct.length - 1) * gapY)) / 2;
    pos.set(n.node_id, { x: leftX, y: startY + i * (cardH + gapY) });
  });
  neighbors.forEach((n, i) => {
    const startY = (height - (neighbors.length * cardH + Math.max(0, neighbors.length - 1) * gapY)) / 2;
    pos.set(n.node_id, { x: rightX, y: startY + i * (cardH + gapY) });
  });

  return (
    <>
      <svg className="hud-arch-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="本次任务架构影响叠加图">
        <defs>
          <marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
          </marker>
        </defs>
        {edges.map(edge => {
          const a = pos.get(edge.from_node_id);
          const b = pos.get(edge.to_node_id);
          if (!a || !b) return null;
          const forward = a.x <= b.x;
          const sx = forward ? a.x + cardW : a.x;
          const sy = a.y + cardH / 2;
          const tx = forward ? b.x - 4 : b.x + cardW + 4;
          const ty = b.y + cardH / 2;
          const cx = (sx + tx) / 2;
          const isInternal = a.x === b.x;
          const d = isInternal
            ? `M${a.x + cardW / 2} ${a.y + (a.y < b.y ? cardH : 0)} L${b.x + cardW / 2} ${b.y + (a.y < b.y ? -4 : cardH + 4)}`
            : `M${sx} ${sy} C${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`;
          return (
            <path
              key={edge.edge_id}
              d={d}
              fill="none"
              stroke={isInternal ? 'var(--accent)' : 'var(--amber)'}
              strokeWidth={isInternal ? 1.8 : 1.4}
              strokeDasharray={isInternal ? undefined : '4 3'}
              markerEnd={`url(#${markerId})`}
            >
              <title>{`${edge.from_label} → ${edge.to_label}：${edge.label}`}</title>
            </path>
          );
        })}
        {nodes.map(node => {
          const p = pos.get(node.node_id)!;
          const isDirect = node.relation === 'direct';
          return (
            <g key={node.node_id}>
              <rect
                x={p.x}
                y={p.y}
                width={cardW}
                height={cardH}
                rx="8"
                fill={isDirect ? '#edf7f1' : '#fffcf5'}
                stroke={isDirect ? 'var(--accent)' : 'var(--amber)'}
                strokeWidth={isDirect ? 1.8 : 1.4}
                strokeDasharray={isDirect ? undefined : '4 3'}
              />
              <text
                x={p.x + 12}
                y={p.y + 23}
                fill="var(--ink)"
                fontSize="12"
                fontWeight="600"
              >
                {node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label}
              </text>
              <text
                x={p.x + 12}
                y={p.y + 40}
                fill={isDirect ? 'var(--accent)' : 'var(--amber)'}
                fontSize="10.5"
              >
                {isDirect ? '● 本次直接修改' : '○ 波及邻接组件'}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="hud-arch-legend">
        <span className="hud-arch-legend-items">
          <span><i className="hud-dot ok" /> 直接修改 ({direct.length})</span>
          <span><i className="hud-dot warn" /> 波及邻接 ({neighbors.length})</span>
        </span>
        {onOpenFull && (
          <button type="button" className="hud-mini-btn" onClick={onOpenFull}>
            在工程全貌中查看 ↗
          </button>
        )}
      </div>
    </>
  );
}

/* ==========================================================================
   1. Pre-Dev Minimal HUD (Translation + Inline Edit + Glanceable Impact Strip)
   ========================================================================== */
const callerGuardRule = (caller: HudExternalCaller) =>
  `保持 ${caller.target_symbol} 兼容（范围外 ${caller.caller_file}:${caller.caller_line} 正在调用）`;

export function PreDevHud({
  task,
  hud,
  hudLoading = false,
  hudError = '',
  busy,
  error,
  onApprove,
  onRevise,
  onTaskSaved,
  onOpenArchitectureOverlay,
  renderFullPackage,
}: {
  task: EngineeringTask;
  hud: TaskHudSnapshot | null;
  hudLoading?: boolean;
  hudError?: string;
  busy: boolean;
  error: string;
  onApprove: (snapshot: EngineeringTask, notes?: string[]) => void;
  onRevise: (snapshot: EngineeringTask, revision: string) => Promise<boolean> | boolean | void;
  onTaskSaved?: (task: EngineeringTask) => void;
  onOpenArchitectureOverlay?: (overlay: TaskArchitectureOverlay) => void;
  renderFullPackage?: (snapshot: EngineeringTask) => React.ReactNode;
}) {
  const [snapshot, setSnapshot] = useState(task);
  const [assumptionEdits, setAssumptionEdits] = useState<Record<number, string>>({});
  const [questionReplies, setQuestionReplies] = useState<Record<number, string>>({});
  const [openDrawer, setOpenDrawer] = useState<string | null>(null);
  const [showBoundaries, setShowBoundaries] = useState(false);
  const [showRevise, setShowRevise] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [savingBoundary, setSavingBoundary] = useState(false);
  const [boundaryError, setBoundaryError] = useState('');
  const [snippet, setSnippet] = useState<{ file: string; line: number; lines: { n: number; text: string }[] } | null>(null);
  const [snippetError, setSnippetError] = useState('');

  const syncSnapshot = (next: EngineeringTask) => {
    setSnapshot(next);
    setAssumptionEdits({});
    setQuestionReplies({});
    setBoundaryError('');
    setSnippet(null);
    setSnippetError('');
  };

  useEffect(() => {
    if (snapshot.task_id !== task.task_id) {
      syncSnapshot(task);
      setOpenDrawer(null);
      setShowRevise(false);
      setFeedback('');
    }
  }, [task, snapshot.task_id]);

  const stale = snapshot.version !== task.version;
  const pkg = snapshot.requirement_package;
  const scope = snapshot.proposed_scope ?? snapshot.scope;
  const assumptions = pkg?.assumptions ?? [];
  const openQuestions = pkg?.open_questions ?? [...new Set([
    ...snapshot.unresolved,
    ...(snapshot.steps ?? []).filter(s => s.status !== 'superseded').flatMap(s => s.unresolved),
  ])];
  const boundaries = effectiveTaskBoundaries(snapshot);
  const nonGoalKeys = useMemo(() => new Set(boundaries.non_goals.map(taskBoundaryKey)), [boundaries.non_goals]);
  const hasBoundaries = boundaries.non_goals.length > 0 || boundaries.revoked.length > 0;
  const impact = hud?.task_id === snapshot.task_id ? hud.impact : undefined;

  const toggleDrawer = (key: string) => {
    setSnippet(null);
    setSnippetError('');
    setBoundaryError('');
    setOpenDrawer(prev => (prev === key ? null : key));
  };

  function collectNotes(): string[] {
    const notes: string[] = [];
    assumptions.forEach((orig, idx) => {
      const edited = assumptionEdits[idx];
      if (edited !== undefined && edited.trim() && edited.trim() !== orig.trim()) {
        notes.push(`用户调整 AI 补全假设：${edited.trim()}`);
      }
    });
    openQuestions.forEach((q, idx) => {
      const ans = questionReplies[idx]?.trim();
      if (ans) notes.push(`待确认项「${q.slice(0, 80)}」用户答复：${ans}`);
    });
    return notes;
  }

  async function guardCaller(caller: HudExternalCaller) {
    const rule = callerGuardRule(caller);
    const ruleKey = taskBoundaryKey(rule);
    if (savingBoundary || nonGoalKeys.has(ruleKey)) return;
    const existing = effectiveTaskBoundaries(snapshot);
    setSavingBoundary(true);
    setBoundaryError('');
    try {
      const updated = await arc().invoke<EngineeringTask>('engineering_task_boundaries', {
        task_id: snapshot.task_id,
        expected_version: snapshot.version,
        non_goals: [...existing.non_goals, rule],
        revoked: existing.revoked,
      });
      setSnapshot(updated);
      onTaskSaved?.(updated);
    } catch (e) {
      setBoundaryError((e as Error).message);
    } finally {
      setSavingBoundary(false);
    }
  }

  async function previewCaller(file: string, line: number) {
    setSnippetError('');
    try {
      const res = await arc().invoke<{ text: string }>('source', {
        source_snapshot_id: (snapshot.diff_baseline ?? snapshot.baseline).snapshot_id,
        path: file,
      });
      const all = res.text.split(/\r\n|\n|\r/);
      const start = Math.max(1, line - 3);
      const end = Math.min(all.length, line + 4);
      setSnippet({
        file,
        line,
        lines: all.slice(start - 1, end).map((text, idx) => ({ n: start + idx, text })),
      });
    } catch (e) {
      setSnippetError((e as Error).message);
    }
  }

  function handleApprove() {
    if (busy || savingBoundary || stale || !scope.length) return;
    const notes = collectNotes();
    onApprove(snapshot, notes.length ? notes : undefined);
  }

  async function handleRevise() {
    const text = feedback.trim();
    if (!text || busy || savingBoundary || stale) return;
    const ok = await onRevise(snapshot, text);
    if (ok !== false) {
      setFeedback('');
      setShowRevise(false);
    }
  }

  const externalCount = impact?.external_callers.length ?? 0;
  const sharedCount = impact?.shared_states.length ?? 0;
  const featureCount = impact?.impacted_features.length ?? 0;
  const untestedCount = impact?.untested_symbols.length ?? 0;
  const constraintCount = impact?.related_constraints.length ?? 0;
  const archCount = impact?.architecture_nodes.length ?? 0;
  const fullPackageNode = renderFullPackage?.(snapshot);

  return (
    <section
      className="hud-before"
      aria-label="审阅待确认方案"
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !showRevise && !e.nativeEvent.isComposing) {
          const target = e.target;
          if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable], .task-boundaries')) {
            return;
          }
          e.preventDefault();
          handleApprove();
        }
      }}
    >
      {/* Subtle single-line raw prompt quote */}
      <div className="hud-before-quote">
        <span title={snapshot.goal}>原话：{snapshot.goal}</span>
        <span className="hud-before-quote-meta">
          <span>需求包 v{snapshot.version}</span>
          {stale && (
            <button type="button" className="hud-mini-btn" disabled={busy} onClick={() => syncSnapshot(task)}>
              同步至 v{task.version}
            </button>
          )}
        </span>
      </div>

      <div className="hud-before-body">
        {error && <p role="alert" className="warning" style={{ margin: 0 }}>{error}</p>}

        {!pkg ? (
          <div className="row between">
            <span className="muted">此版本尚未生成正式需求包。</span>
            <button
              type="button"
              disabled={busy || stale}
              onClick={() => onRevise(snapshot, '根据当前目标和既有资料重新进行只读分析，生成完整需求包。')}
            >
              重新分析并生成需求包
            </button>
          </div>
        ) : (
          <>
            {/* Translated human-readable spec */}
            <div className="hud-translation-head">
              <h3>审阅待确认方案 · AI 结合源码翻译的需求</h3>
              <small>
                {assumptions.length > 0
                  ? '琥珀色条目为 AI 自行补全，不对可直接点字就地改，无误直接开改'
                  : '核对无误后直接点下方按钮开改'}
              </small>
            </div>

            {snapshot.summary && <p className="hud-translation-summary">{snapshot.summary}</p>}

            {scope.length > 0 && (
              <div className="hud-scope-inline" aria-label="建议修改文件">
                <span>涉及文件</span>
                {scope.map(file => (
                  <code key={file} title={file}>{shortFile(file)}</code>
                ))}
              </div>
            )}

            <ol className="hud-behaviors">
              {pkg.behaviors.map((item, idx) => (
                <li key={item.id} className="hud-behavior-item">
                  <span className="hud-behavior-index">{idx + 1}</span>
                  <div className="hud-behavior-content">
                    <span className="hud-behavior-title">{item.behavior}</span>
                    {item.design && <p className="hud-behavior-design">{item.design}</p>}
                    <div className="hud-behavior-meta">
                      {item.files.map(f => <code key={f} title={f}>{shortFile(f)}</code>)}
                      {item.verification && <small>验收：{item.verification}</small>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            {/* AI-inferred assumptions: click inline to refine */}
            {assumptions.length > 0 && (
              <div className="hud-assumptions" aria-label="AI 自行补全的假设">
                {assumptions.map((text, idx) => {
                  const val = assumptionEdits[idx] ?? text;
                  const trimmed = val.trim();
                  const cleared = assumptionEdits[idx] !== undefined && !trimmed;
                  const edited = assumptionEdits[idx] !== undefined && !!trimmed && trimmed !== text.trim();
                  return (
                    <div key={idx} className={`hud-assumption-row${edited ? ' is-edited' : cleared ? ' is-cleared' : ''}`}>
                      <span className="hud-assumption-tag">{edited ? '已就地调整' : cleared ? '留空忽略' : 'AI 补全'}</span>
                      <input
                        className="hud-assumption-input"
                        aria-label={`编辑 AI 假设 ${idx + 1}`}
                        placeholder="留空将忽略此编辑并沿用原方案，点右侧还原恢复"
                        value={val}
                        disabled={busy || stale}
                        onChange={e => setAssumptionEdits(prev => ({ ...prev, [idx]: e.target.value }))}
                      />
                      {(edited || cleared) && (
                        <button
                          type="button"
                          className="hud-assumption-reset"
                          onClick={() => setAssumptionEdits(prev => {
                            const next = { ...prev };
                            delete next[idx];
                            return next;
                          })}
                        >
                          还原
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Open questions: optional 1-line inline reply */}
            {openQuestions.length > 0 && (
              <div className="hud-assumptions" aria-label="待确认项">
                {openQuestions.map((q, idx) => (
                  <div key={idx} className="hud-question-row">
                    <span>待确认：{q}</span>
                    <input
                      type="text"
                      placeholder="直接补充一句回答（可选，开改时自动带给 Agent）…"
                      value={questionReplies[idx] ?? ''}
                      disabled={busy || stale}
                      onChange={e => setQuestionReplies(prev => ({ ...prev, [idx]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Compact boundaries (shown if present or toggled) */}
            {(hasBoundaries || showBoundaries) && (
              <TaskBoundaries
                task={snapshot}
                title="本轮不改与已撤销红线"
                disabled={busy || stale}
                onSavingChange={setSavingBoundary}
                onSaved={updated => {
                  setSnapshot(updated);
                  onTaskSaved?.(updated);
                }}
              />
            )}

            {/* Glanceable Impact HUD Strip (All drawers collapsed by default) */}
            <div className="hud-impact-area">
              <div className="hud-signal-strip" role="group" aria-label="改前影响面 HUD">
                <span className="hud-strip-label">影响面</span>
                {impact ? (
                  <button
                    type="button"
                    className={`hud-pill${externalCount > 0 ? ' tone-danger' : ''}`}
                    aria-expanded={openDrawer === 'callers'}
                    onClick={() => toggleDrawer('callers')}
                  >
                    <i className={`hud-dot ${externalCount > 0 ? 'danger' : 'ok'}`} />
                    <span>范围外调用 <strong>{externalCount}</strong></span>
                  </button>
                ) : hudError ? (
                  <span className="hud-pill tone-warn" title={hudError}>
                    <i className="hud-dot warn" />
                    <span>影响面暂不可用</span>
                  </span>
                ) : hudLoading ? (
                  <span className="hud-pill">
                    <i className="hud-dot pulse" />
                    <span>影响面分析中…</span>
                  </span>
                ) : null}

                {sharedCount > 0 && (
                  <button
                    type="button"
                    className="hud-pill tone-warn"
                    aria-expanded={openDrawer === 'shared'}
                    onClick={() => toggleDrawer('shared')}
                  >
                    <i className="hud-dot warn" />
                    <span>共享状态 <strong>{sharedCount}</strong></span>
                  </button>
                )}

                {featureCount > 0 && (
                  <button
                    type="button"
                    className="hud-pill tone-info"
                    aria-expanded={openDrawer === 'features'}
                    onClick={() => toggleDrawer('features')}
                  >
                    <i className="hud-dot info" />
                    <span>涉及功能 <strong>{featureCount}</strong></span>
                  </button>
                )}

                {archCount > 0 && (
                  <button
                    type="button"
                    className="hud-pill"
                    aria-expanded={openDrawer === 'arch'}
                    onClick={() => toggleDrawer('arch')}
                  >
                    <i className="hud-dot ok" />
                    <span>架构叠加</span>
                  </button>
                )}

                {untestedCount > 0 && (
                  <button
                    type="button"
                    className="hud-pill"
                    aria-expanded={openDrawer === 'untested'}
                    onClick={() => toggleDrawer('untested')}
                  >
                    <i className="hud-dot warn" />
                    <span>未测入口 <strong>{untestedCount}</strong></span>
                  </button>
                )}

                {constraintCount > 0 && (
                  <button
                    type="button"
                    className="hud-pill"
                    aria-expanded={openDrawer === 'constraints'}
                    onClick={() => toggleDrawer('constraints')}
                  >
                    <i className="hud-dot info" />
                    <span>关联约束 <strong>{constraintCount}</strong></span>
                  </button>
                )}

                <button
                  type="button"
                  className="hud-pill"
                  aria-expanded={openDrawer === 'files'}
                  onClick={() => toggleDrawer('files')}
                >
                  <span>拟改文件 <strong>{scope.length}</strong></span>
                </button>

                {!hasBoundaries && !showBoundaries && (
                  <button type="button" className="hud-pill" onClick={() => setShowBoundaries(true)}>
                    + 不改红线
                  </button>
                )}
              </div>

              {/* Quiet single-line hint ONLY when high-signal alert exists and drawer is closed */}
              {!openDrawer && (externalCount > 0 || sharedCount > 0) && impact && (
                <div className="hud-quiet-hint">
                  <span>
                    {externalCount > 0
                      ? <><code>{impact.external_callers[0].target_symbol}</code> 等有 {externalCount} 处范围外上游调用</>
                      : <>涉及跨目录共享状态 <code>{impact.shared_states[0].name}</code></>}
                    {featureCount > 0 ? `，命中 ${featureCount} 个已有功能模块` : ''}
                    ；点上方胶囊按需查看，无顾虑可直接开改。
                  </span>
                </div>
              )}

              {/* On-demand drawers */}
              {openDrawer === 'callers' && impact && (
                <div className={`hud-drawer${externalCount > 0 ? ' tone-danger' : ''}`}>
                  <div className="hud-drawer-head">
                    <strong>范围外上游调用点（本地 AST 索引）</strong>
                    <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                  </div>
                  {boundaryError && <small role="alert" className="warning">{boundaryError}</small>}
                  {snippetError && <small className="warning">{snippetError}</small>}
                  {snippet && (
                    <div className="hud-inline-snippet" aria-label="调用点源码预览">
                      <div className="row between" style={{ marginBottom: 6, color: 'var(--muted)' }}>
                        <span>{snippet.file}:{snippet.line}</span>
                        <button type="button" className="hud-drawer-close" onClick={() => setSnippet(null)}>关闭预览</button>
                      </div>
                      {snippet.lines.map(l => (
                        <div key={l.n} className={`hud-inline-snippet-line${l.n === snippet.line ? ' is-focus' : ''}`}>
                          <b>{l.n}</b>
                          <span>{l.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!externalCount ? (
                    <small>未检出范围外文件直接调用本次待改文件的公开符号。</small>
                  ) : (
                    <div className="hud-caller-list">
                      {impact.external_callers.slice(0, 14).map((c, idx) => {
                        const guarded = nonGoalKeys.has(taskBoundaryKey(callerGuardRule(c)));
                        return (
                          <div key={idx} className="hud-caller-row">
                            <span className="hud-caller-loc">
                              <span>{c.caller_file}:{c.caller_line}</span>
                              <span>({shortSymbol(c.caller_symbol)}) →</span>
                              <b>{c.target_symbol}</b>
                            </span>
                            <span className="hud-caller-actions">
                              <button
                                type="button"
                                className="hud-mini-btn"
                                onClick={() => void previewCaller(c.caller_file, c.caller_line)}
                              >
                                看源码
                              </button>
                              <button
                                type="button"
                                className={`hud-mini-btn${guarded ? ' done' : ''}`}
                                disabled={savingBoundary || stale || guarded}
                                onClick={() => void guardCaller(c)}
                              >
                                {guarded ? '✓ 已设红线' : '设为不改'}
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {openDrawer === 'shared' && impact && (
                <div className="hud-drawer tone-warn">
                  <div className="hud-drawer-head">
                    <strong>触碰的跨目录共享状态</strong>
                    <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                  </div>
                  <div className="hud-caller-list">
                    {impact.shared_states.map((s, idx) => (
                      <div key={idx} className="hud-caller-row">
                        <span className="hud-caller-loc">
                          <strong>{s.name}</strong>
                          <span>{s.file}:{s.line}</span>
                        </span>
                        <small>外部访问目录：{s.external_dirs.join('、')}</small>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {openDrawer === 'features' && impact && (
                <div className="hud-drawer">
                  <div className="hud-drawer-head">
                    <strong>可能受影响的已有功能模块</strong>
                    <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                  </div>
                  <div className="hud-caller-list">
                    {impact.impacted_features.map(f => (
                      <div key={f.scenario_id} className="hud-caller-row">
                        <strong>{f.label}</strong>
                        <small>{f.has_call_graph ? '已有调用链 · 改后可一键对比前后变化' : '已关联功能目录'}</small>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {openDrawer === 'arch' && impact && (
                <div className="hud-drawer">
                  <div className="hud-drawer-head">
                    <strong>工程全貌 · 任务影响叠加</strong>
                    <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                  </div>
                  <MiniArchitectureOverlay
                    nodes={impact.architecture_nodes}
                    edges={impact.architecture_edges}
                    onOpenFull={onOpenArchitectureOverlay ? () => onOpenArchitectureOverlay({
                      taskId: snapshot.task_id,
                      goal: snapshot.goal,
                      resultId: impact.architecture_result_id,
                      nodes: new Map(impact.architecture_nodes.map(n => [n.node_id, n.relation])),
                    }) : undefined}
                  />
                </div>
              )}

              {openDrawer === 'untested' && impact && (
                <div className="hud-drawer">
                  <div className="hud-drawer-head">
                    <strong>测试目录未检出调用的公开入口</strong>
                    <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                  </div>
                  <div className="hud-caller-list">
                    {impact.untested_symbols.map((u, idx) => (
                      <div key={idx} className="hud-caller-row">
                        <span className="hud-caller-loc">
                          <strong>{u.symbol}</strong>
                          <span>{u.file}:{u.line}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {openDrawer === 'constraints' && impact && (
                <div className="hud-drawer">
                  <div className="hud-drawer-head">
                    <strong>关联的历史工程约束与已知问题</strong>
                    <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                  </div>
                  <div className="hud-caller-list">
                    {impact.related_constraints.map(c => (
                      <div key={c.entry_id} className="hud-caller-row">
                        <div>
                          <strong>{c.key}</strong>
                          <div style={{ fontSize: 12, color: 'var(--ink-secondary)', marginTop: 2 }}>{c.excerpt}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {openDrawer === 'files' && (
                <div className="hud-drawer">
                  <div className="hud-drawer-head">
                    <strong>本次批准修改的文件范围（{scope.length}）</strong>
                    <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                  </div>
                  <div className="hud-caller-list">
                    {scope.map(file => (
                      <div key={file} className="hud-caller-row">
                        <span className="hud-caller-loc">{file}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Single Clean CTA Footer */}
      {pkg && (
        <div className="hud-before-footer">
          <div className="hud-before-footer-bar">
            <span className="hud-before-footer-hint">
              {collectNotes().length > 0
                ? `已记录 ${collectNotes().length} 处就地微调，执行时自动生效。`
                : '理解无误直接执行，无需逐项勾选。'}
            </span>
            <div className="hud-before-footer-actions">
              <button
                type="button"
                disabled={busy || savingBoundary || stale}
                onClick={() => setShowRevise(v => !v)}
              >
                {showRevise ? '收起修订' : '退回补充'}
              </button>
              <button
                className="primary"
                disabled={busy || savingBoundary || stale || !scope.length}
                onClick={handleApprove}
              >
                按此方案执行
              </button>
            </div>
          </div>

          <details className="hud-revise-details" open={showRevise} onToggle={e => setShowRevise(e.currentTarget.open)}>
            <summary>填写修订意见并退回补充</summary>
            <div className="hud-revision-drawer">
              <label>
                修订意见
                <textarea
                  aria-label="修订意见"
                  placeholder="需要补充或调整什么？"
                  value={feedback}
                  onChange={e => setFeedback(e.target.value)}
                />
              </label>
              <div className="row end">
                <button
                  type="button"
                  disabled={busy || savingBoundary || stale || !feedback.trim()}
                  onClick={() => void handleRevise()}
                >
                  退回补充
                </button>
              </div>
            </div>
          </details>
        </div>
      )}

      {fullPackageNode && (
        <details className="hud-before-details">
          <summary>查看完整需求包与实施步骤</summary>
          {fullPackageNode}
        </details>
      )}
    </section>
  );
}

/* ==========================================================================
   2. In-Flight Quiet Single-Line HUD Bar
   ========================================================================== */
export function FlightHudBar({
  task,
  attempt,
  dispatch,
  lines,
  receipt,
  latestMessage,
  latestAt,
  onSettings,
}: {
  task: EngineeringTask;
  attempt?: DevelopmentAttempt;
  dispatch?: Dispatch;
  lines: { at: string; text: string }[];
  receipt: string;
  latestMessage: string;
  latestAt?: string;
  onSettings: () => void;
}) {
  const terminal = ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(task.status);
  const backfilled = terminal || task.workflow === 'ready';
  const [expanded, setExpanded] = useState(false);

  const activeSteps = (task.steps ?? []).filter(s => s.status !== 'superseded');
  const completedSteps = activeSteps.filter(s => s.status === 'completed').length;
  const currentStep = activeSteps.find(s => s.status === 'in_progress');
  const scopeCount = (attempt?.write_scope ?? task.approval?.scope ?? task.scope).length;

  return (
    <section className={`hud-flight${backfilled ? ' is-terminal' : ''}`} aria-label="执行动态">
      <div className="hud-flight-bar">
        <div className="hud-flight-main">
          <i className={`hud-dot ${backfilled ? (task.status === 'completed' ? 'ok' : 'warn') : 'pulse'}`} />
          <span className="hud-flight-stage">
            {backfilled
              ? '执行动态'
              : `${attempt?.provider_id === 'dsh' ? 'DSH · ' : ''}${task.workflow === 'analysis' ? '只读分析中' : receipt}`}
          </span>
          {activeSteps.length > 0 && !backfilled && (
            <span className="hud-flight-step">
              步骤 {Math.min(activeSteps.length, completedSteps + (currentStep ? 1 : 0))}/{activeSteps.length}
            </span>
          )}
          {scopeCount > 0 && task.workflow !== 'analysis' && !backfilled && (
            <span className="hud-flight-step">范围 {scopeCount} 文件</span>
          )}
          <span className="hud-flight-msg" title={latestMessage}>{latestMessage}</span>
        </div>

        <div className="hud-flight-right">
          {latestAt && (
            <time className="hud-flight-time" dateTime={latestAt} title={new Date(latestAt).toLocaleString()}>
              {new Date(latestAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </time>
          )}
          {dispatch && ['blocked', 'unknown'].includes(dispatch.state) && (
            <button type="button" className="hud-mini-btn" onClick={onSettings}>核对派发</button>
          )}
          {lines.length > 0 && (
            <button
              type="button"
              className="hud-mini-btn"
              aria-expanded={expanded}
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? '收起实时流 ▴' : `实时流 (${lines.length}) ▾`}
            </button>
          )}
        </div>
      </div>

      {expanded && lines.length > 0 && (
        <div className="hud-flight-stream">
          <ol>
            {lines.map((line, i) => (
              <li key={i}>
                <time>{new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <pre>{line.text}</pre>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/* ==========================================================================
   3. Post-Dev 30-Second Digest HUD (Verdict + Structure Diff + Walkthrough Diff)
   ========================================================================== */
type SelectedTarget =
  | { kind: 'step'; step: WalkthroughDiffStep }
  | { kind: 'node'; node: WalkthroughDiffNode };

function CallChainDiffGraph({
  pathDiff,
  viewFilter,
  hideNoise,
  selectedKey,
  onSelectNode,
}: {
  pathDiff: WalkthroughPathDiff;
  viewFilter: 'diff' | 'before' | 'after';
  hideNoise: boolean;
  selectedKey: string;
  onSelectNode: (node: WalkthroughDiffNode) => void;
}) {
  const markerId = 'hud-chain-' + useId().replace(/:/g, '');
  const visibleNodes = pathDiff.participants.filter(n => {
    if (hideNoise && n.status === 'noise') return false;
    if (viewFilter === 'before') return n.before_node_id !== undefined;
    if (viewFilter === 'after') return n.after_node_id !== undefined;
    return true;
  });
  const nodeIds = new Set(visibleNodes.map(n => n.key));
  const visibleEdges = pathDiff.edges.filter(e => {
    if (!nodeIds.has(e.from_key) || !nodeIds.has(e.to_key)) return false;
    if (hideNoise && e.status === 'noise') return false;
    if (viewFilter === 'before') return e.status !== 'added';
    if (viewFilter === 'after') return e.status !== 'removed';
    return true;
  });

  // Topological rank assignment with cycle guard
  const rank = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const n of visibleNodes) incoming.set(n.key, []);
  for (const e of visibleEdges) {
    if (e.from_key !== e.to_key) incoming.get(e.to_key)?.push(e.from_key);
  }
  const visiting = new Set<string>();
  function getRank(key: string): number {
    if (rank.has(key)) return rank.get(key)!;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const parents = incoming.get(key) ?? [];
    const val = parents.length ? Math.max(...parents.map(p => getRank(p) + 1)) : 0;
    visiting.delete(key);
    rank.set(key, val);
    return val;
  }
  for (const n of visibleNodes) getRank(n.key);

  // Group into file bands
  const fileGroups = new Map<string, WalkthroughDiffNode[]>();
  for (const n of visibleNodes) {
    const g = n.file || '未定位文件';
    const list = fileGroups.get(g);
    if (list) list.push(n);
    else fileGroups.set(g, [n]);
  }

  const nodeW = 148;
  const nodeH = 56;
  const colStep = 178;
  const rowStep = 70;
  const boxes = new Map<string, { x: number; y: number }>();
  const bands: { file: string; y: number; h: number }[] = [];
  let cursorY = 16;
  let maxX = 420;

  for (const [file, list] of fileGroups) {
    const colRows = new Map<number, number>();
    const topY = cursorY;
    const contentTop = topY + 28;
    let bandBottom = contentTop + nodeH + 14;
    for (const node of list) {
      const c = rank.get(node.key) ?? 0;
      const r = colRows.get(c) ?? 0;
      colRows.set(c, r + 1);
      const x = 18 + c * colStep;
      const y = contentTop + r * rowStep;
      boxes.set(node.key, { x, y });
      maxX = Math.max(maxX, x + nodeW + 24);
      bandBottom = Math.max(bandBottom, y + nodeH + 14);
    }
    bands.push({ file, y: topY, h: bandBottom - topY });
    cursorY = bandBottom + 12;
  }

  const width = maxX;
  const height = Math.max(160, cursorY + 8);

  if (!visibleNodes.length) {
    return <p className="muted" style={{ margin: '8px 0' }}>当前过滤条件下没有可展示的函数节点。</p>;
  }

  return (
    <div className="hud-chain-frame">
      <svg
        className="hud-chain-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={width <= 760 ? { width: '100%', height: 'auto', maxWidth: width } : undefined}
        role="img"
        aria-label="函数调用链前后叠加图"
      >
        <defs>
          <marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
          </marker>
        </defs>
        {bands.map(band => (
          <g key={band.file}>
            <rect className="hud-chain-band" x="8" y={band.y} width={width - 16} height={band.h} rx="10" />
            <text x="18" y={band.y + 18} fill="var(--muted)" fontSize="11" fontFamily="var(--font-mono)">
              {band.file}
            </text>
          </g>
        ))}

        {visibleEdges.map(edge => {
          const a = boxes.get(edge.from_key);
          const b = boxes.get(edge.to_key);
          if (!a || !b) return null;
          const self = edge.from_key === edge.to_key;
          const d = self
            ? `M${a.x + nodeW - 20} ${a.y} C${a.x + nodeW + 20} ${a.y - 26} ${a.x + nodeW + 20} ${a.y + 24} ${a.x + nodeW} ${a.y + 20}`
            : (() => {
                const forward = a.x <= b.x;
                const sx = forward ? a.x + nodeW : a.x;
                const sy = a.y + nodeH / 2;
                const tx = forward ? b.x - 4 : b.x + nodeW + 4;
                const ty = b.y + nodeH / 2;
                const cx = (sx + tx) / 2;
                return `M${sx} ${sy} C${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`;
              })();
          const stroke =
            edge.status === 'added' ? 'var(--accent)'
              : edge.status === 'removed' ? 'var(--danger)'
                : edge.kind === 'execution_boundary' ? 'var(--blue)' : '#9eb1a7';
          const dash =
            edge.status === 'removed' ? '5 3'
              : edge.status === 'noise' ? '2 3'
                : edge.kind === 'execution_boundary' ? '6 3' : undefined;
          return (
            <path
              key={edge.key}
              d={d}
              fill="none"
              stroke={stroke}
              strokeWidth={edge.status === 'added' || edge.status === 'removed' ? 2 : 1.35}
              strokeDasharray={dash}
              opacity={edge.status === 'unchanged' ? 0.6 : 0.95}
              markerEnd={`url(#${markerId})`}
            >
              <title>{`${shortSymbol(edge.from_key)} → ${shortSymbol(edge.to_key)}（${edge.after_label || edge.before_label || edge.kind}）`}</title>
            </path>
          );
        })}

        {visibleNodes.map(node => {
          const b = boxes.get(node.key)!;
          const prefix =
            node.status === 'added' ? '+ '
              : node.status === 'removed' ? '− '
                : node.status === 'modified' ? '~ ' : '';
          const sub =
            node.status === 'added' ? '新增节点'
              : node.status === 'removed' ? '已移除'
                : node.status === 'modified' ? '代码或签名变化'
                  : node.status === 'noise' ? '说明粒度变化' : '未变化';
          return (
            <foreignObject key={node.key} x={b.x} y={b.y} width={nodeW} height={nodeH}>
              <button
                type="button"
                className={`hud-chain-node status-${node.status}`}
                aria-pressed={selectedKey === `node:${node.key}`}
                onClick={() => onSelectNode(node)}
                title={`${node.symbol}\n${node.file ?? ''}\n${node.description}`}
              >
                <strong>{prefix + shortSymbol(node.symbol)}</strong>
                <small>{sub}{node.after_line ? ` · L${node.after_line}` : node.before_line ? ` · L${node.before_line}` : ''}</small>
              </button>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}

function TimelineSequenceDiff({
  pathDiff,
  viewFilter,
  hideNoise,
  selectedKey,
  onSelectStep,
}: {
  pathDiff: WalkthroughPathDiff;
  viewFilter: 'diff' | 'before' | 'after';
  hideNoise: boolean;
  selectedKey: string;
  onSelectStep: (step: WalkthroughDiffStep) => void;
}) {
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());

  const visibleSteps = useMemo(() => pathDiff.steps.filter(s => {
    if (hideNoise && s.status === 'noise') return false;
    if (viewFilter === 'before') return s.before_index !== undefined;
    if (viewFilter === 'after') return s.after_index !== undefined;
    return true;
  }), [pathDiff.steps, hideNoise, viewFilter]);

  const blocks = useMemo(() => {
    const out: ({ type: 'step'; step: WalkthroughDiffStep } | { type: 'fold'; id: string; steps: WalkthroughDiffStep[] })[] = [];
    if (viewFilter !== 'diff') {
      for (const step of visibleSteps) out.push({ type: 'step', step });
      return out;
    }
    let run: WalkthroughDiffStep[] = [];
    const flush = () => {
      if (run.length >= 2) {
        out.push({ type: 'fold', id: `fold:${run[0].id}:${run.length}`, steps: run });
      } else {
        for (const s of run) out.push({ type: 'step', step: s });
      }
      run = [];
    };
    for (const step of visibleSteps) {
      if (step.status === 'unchanged') run.push(step);
      else {
        flush();
        out.push({ type: 'step', step });
      }
    }
    flush();
    return out;
  }, [visibleSteps, viewFilter]);

  if (!visibleSteps.length) {
    return <p className="muted" style={{ margin: '8px 0' }}>当前路径没有检测到调用时间步。</p>;
  }

  const renderStep = (step: WalkthroughDiffStep) => {
    const idx = viewFilter === 'before'
      ? (step.before_index ?? 0) + 1
      : (step.after_index ?? step.before_index ?? 0) + 1;
    const prefix =
      step.status === 'added' ? '+'
        : step.status === 'removed' ? '−'
          : step.status === 'modified' ? '~'
            : step.status === 'noise' ? '≈' : '';
    const text = viewFilter === 'before' ? (step.before_text ?? step.after_text) : (step.after_text ?? step.before_text);
    const condChanged = step.diff_reasons.includes('condition') && (step.before_condition || step.after_condition);
    const inputChanged = step.diff_reasons.includes('io') && (step.before_input?.trim() ?? '') !== (step.after_input?.trim() ?? '');
    const outputChanged = step.diff_reasons.includes('io') && (step.before_output?.trim() ?? '') !== (step.after_output?.trim() ?? '');

    return (
      <button
        type="button"
        key={step.id}
        className={`hud-step-card status-${step.status}`}
        aria-pressed={selectedKey === `step:${step.id}`}
        onClick={() => onSelectStep(step)}
      >
        <div className="hud-step-top">
          <span className="hud-step-flow">
            <span className="hud-step-num">{prefix}{String(idx).padStart(2, '0')}</span>
            {step.from_symbol && step.from_symbol !== step.to_symbol && (
              <>
                <span>{shortSymbol(step.from_symbol)}</span>
                <span style={{ color: 'var(--muted)' }}>{step.kind === 'return' ? '┄→' : '→'}</span>
              </>
            )}
            <strong>{shortSymbol(step.to_symbol)}</strong>
          </span>
          <span className="hud-step-kind">{stepKindLabels[step.kind]}</span>
        </div>
        {text && <span className="hud-step-text">{text}</span>}
        {viewFilter === 'diff' && step.status === 'modified' && (condChanged || inputChanged || outputChanged) && (
          <div className="hud-step-delta">
            {condChanged && (
              <span>
                条件：<del>{step.before_condition || '无条件'}</del> → <ins>{step.after_condition || '无条件'}</ins>
              </span>
            )}
            {inputChanged && (
              <span>
                入参：<del>{step.before_input || '—'}</del> → <ins>{step.after_input || '—'}</ins>
              </span>
            )}
            {outputChanged && (
              <span>
                产出：<del>{step.before_output || '—'}</del> → <ins>{step.after_output || '—'}</ins>
              </span>
            )}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="hud-timeline">
      {blocks.map(block => {
        if (block.type === 'step') return renderStep(block.step);
        const open = unfolded.has(block.id);
        return (
          <React.Fragment key={block.id}>
            <button
              type="button"
              className="hud-timeline-fold"
              onClick={() => setUnfolded(prev => {
                const next = new Set(prev);
                if (open) next.delete(block.id);
                else next.add(block.id);
                return next;
              })}
            >
              {open ? `▴ 收起 ${block.steps.length} 个未变时间块` : `⋯ 展开 ${block.steps.length} 个未变时间块 ⋯`}
            </button>
            {open && block.steps.map(renderStep)}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function sliceAroundLine<T extends { type: 'add' | 'del' | 'same' | 'gap'; oldLine?: number; newLine?: number }>(
  rows: T[],
  focusLine: number,
  maxRows = 60,
): T[] {
  if (rows.length <= maxRows) return rows;
  let bestIdx = 0;
  let bestDist = Infinity;
  rows.forEach((row, idx) => {
    if (row.type === 'gap') return;
    const line = row.newLine ?? row.oldLine;
    if (line === undefined) return;
    const dist = Math.abs(line - focusLine);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  });
  let start = Math.max(0, bestIdx - Math.floor(maxRows * 0.4));
  let end = Math.min(rows.length, start + maxRows);
  if (end - start < maxRows) start = Math.max(0, end - maxRows);
  return rows.slice(start, end);
}

function resolveAskBinding(diff: WalkthroughDiff, pathDiff: WalkthroughPathDiff, target: SelectedTarget | null) {
  if (!target) {
    return { resultId: diff.after_result_id, target: { kind: 'feature' as const, id: diff.feature_id }, askingBefore: false };
  }
  if (target.kind === 'node') {
    if (target.node.after_node_id) {
      return { resultId: diff.after_result_id, target: { kind: 'node' as const, id: target.node.after_node_id }, askingBefore: false };
    }
    if (target.node.before_node_id) {
      return { resultId: diff.before_result_id, target: { kind: 'node' as const, id: target.node.before_node_id }, askingBefore: true };
    }
    return { resultId: diff.after_result_id, target: { kind: 'feature' as const, id: diff.feature_id }, askingBefore: false };
  }
  if (target.step.after_step_id && pathDiff.after_path_id) {
    return {
      resultId: diff.after_result_id,
      target: {
        kind: 'call_step' as const,
        id: `call-step:${encodeURIComponent(pathDiff.after_path_id)}:${encodeURIComponent(target.step.after_step_id)}`,
      },
      askingBefore: false,
    };
  }
  if (target.step.before_step_id && pathDiff.before_path_id) {
    return {
      resultId: diff.before_result_id,
      target: {
        kind: 'call_step' as const,
        id: `call-step:${encodeURIComponent(pathDiff.before_path_id)}:${encodeURIComponent(target.step.before_step_id)}`,
      },
      askingBefore: true,
    };
  }
  const participant = pathDiff.participants.find(p => p.key === target.step.to_key);
  if (participant?.after_node_id) {
    return { resultId: diff.after_result_id, target: { kind: 'node' as const, id: participant.after_node_id }, askingBefore: false };
  }
  if (participant?.before_node_id) {
    return { resultId: diff.before_result_id, target: { kind: 'node' as const, id: participant.before_node_id }, askingBefore: true };
  }
  return { resultId: diff.after_result_id, target: { kind: 'feature' as const, id: diff.feature_id }, askingBefore: false };
}

function WalkthroughInspector({
  task,
  diff,
  pathDiff,
  target,
  onTargetedContinue,
}: {
  task: EngineeringTask;
  diff: WalkthroughDiff;
  pathDiff: WalkthroughPathDiff;
  target: SelectedTarget | null;
  onTargetedContinue?: (prefill: string) => void;
}) {
  const [sourceLines, setSourceLines] = useState<{ type: 'add' | 'del' | 'same' | 'gap'; oldLine?: number; newLine?: number; text: string }[] | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [loadingSource, setLoadingSource] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askedId, setAskedId] = useState<string | null>(null);
  const [askError, setAskError] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const askSeq = useRef(0);

  const askBinding = useMemo(() => resolveAskBinding(diff, pathDiff, target), [diff, pathDiff, target]);

  const file = target?.kind === 'node'
    ? target.node.file
    : target?.step.after_evidence?.path ?? target?.step.before_evidence?.path ?? null;
  const focusLine = target?.kind === 'node'
    ? (target.node.after_line ?? target.node.before_line ?? 1)
    : (target?.step.after_evidence?.line_start ?? target?.step.before_evidence?.line_start ?? 1);
  const symbolLabel = target?.kind === 'node'
    ? target.node.symbol
    : target ? `${target.step.from_symbol ? shortSymbol(target.step.from_symbol) + ' → ' : ''}${shortSymbol(target.step.to_symbol)}` : '';

  useEffect(() => {
    askSeq.current++;
    setSourceLines(null);
    setSourceError('');
    setAsking(false);
    setAskedId(null);
    setAnswer(null);
    setAskError('');
    if (!target || !file) return;
    let alive = true;
    setLoadingSource(true);
    const inChanges = task.changes.some(c => c.path.replaceAll('\\', '/') === file.replaceAll('\\', '/'));
    const load = async () => {
      if (inChanges && task.changes_status !== 'needs_review') {
        const res = await arc().invoke<{ before: string; after: string }>('engineering_diff', { task_id: task.task_id, path: file });
        const computed = computeLineDiff(res.before, res.after);
        const collapsed = collapseUnifiedContext(computed.lines, 3);
        const allRows = collapsed.map(item =>
          item.type === 'gap'
            ? { type: 'gap' as const, text: `… 已折叠 ${item.hidden} 行未变更代码 …` }
            : { type: item.type, oldLine: item.oldLine, newLine: item.newLine, text: item.text },
        );
        if (alive) setSourceLines(sliceAroundLine(allRows, focusLine, 60));
      } else {
        const snapId = askBinding.askingBefore ? diff.before_snapshot_id : diff.after_snapshot_id;
        const res = await arc().invoke<{ text: string }>('source', { source_snapshot_id: snapId, path: file });
        const all = res.text.split(/\r\n|\n|\r/);
        const start = Math.max(1, focusLine - 4);
        const end = Math.min(all.length, focusLine + 8);
        if (alive) {
          setSourceLines(all.slice(start - 1, end).map((text, idx) => ({
            type: 'same' as const,
            newLine: start + idx,
            text,
          })));
        }
      }
    };
    void load().catch(e => { if (alive) setSourceError((e as Error).message); }).finally(() => { if (alive) setLoadingSource(false); });
    return () => { alive = false; };
  }, [target, file, focusLine, askBinding.askingBefore, task.task_id, task.changes, task.changes_status, diff.before_snapshot_id, diff.after_snapshot_id]);

  // Listen for answer completion or failure on inline reading_ask; unsubscribe once terminal
  useEffect(() => {
    if (!askedId) return;
    let alive = true;
    let done = false;
    let off: () => void = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      off();
    };
    const poll = async () => {
      if (!alive || done) return;
      try {
        const ws = await arc().invoke<WorkspaceData>('data');
        if (!alive || done) return;
        const found = ws.questions?.find(q => q.question_id === askedId);
        if (found?.answer?.answer) {
          setAnswer(found.answer.answer);
          setAsking(false);
          finish();
          return;
        }
        const run = found ? ws.runs?.find(r => r.binding.run_id === found.run_id) : undefined;
        if (run && ['failed', 'cancelled', 'unknown'].includes(run.status)) {
          setAskError(run.error || `追问未完成（${run.status}）`);
          setAsking(false);
          finish();
        } else if (run?.status === 'completed') {
          setAskError('追问已结束但未返回有效答复。');
          setAsking(false);
          finish();
        }
      } catch (e) {
        if (!alive || done) return;
        setAskError((e as Error).message);
        setAsking(false);
        finish();
      }
    };
    off = arc().onEvent(e => {
      if (e.type === 'changed') void poll();
    });
    void poll();
    return () => { alive = false; finish(); };
  }, [askedId]);

  async function sendAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !question.trim() || asking) return;
    const mine = ++askSeq.current;
    setAsking(true);
    setAskError('');
    setAnswer(null);
    try {
      const submitted = await arc().invoke<ReadingQuestion>('reading_ask', {
        project_id: task.project_id,
        scenario_id: diff.scenario_id,
        result_id: askBinding.resultId,
        target: askBinding.target,
        question: question.trim(),
        source_mode: 'bound',
        submission_key: crypto.randomUUID(),
      });
      if (mine !== askSeq.current) return;
      setAskedId(submitted.question_id);
      setQuestion('');
    } catch (err) {
      if (mine !== askSeq.current) return;
      setAskError((err as Error).message);
      setAsking(false);
    }
  }

  if (!target) {
    return (
      <aside className="hud-inspector" aria-label="变更详情">
        <span className="muted">点选左侧任意变化节点或时间块，在这里直接看改前/改后源码并原位追问。</span>
      </aside>
    );
  }

  return (
    <aside className="hud-inspector" aria-label="变更详情">
      <div className="hud-inspector-head">
        <strong>{symbolLabel}</strong>
        <span className={`hud-pill ${
          (target.kind === 'node' ? target.node.status : target.step.status) === 'added' ? 'tone-ok'
            : (target.kind === 'node' ? target.node.status : target.step.status) === 'removed' ? 'tone-danger'
              : (target.kind === 'node' ? target.node.status : target.step.status) === 'modified' ? 'tone-warn' : ''
        }`}>
          {{ added: '新增', removed: '已移除', modified: '已变化', unchanged: '未变化', noise: '说明粒度变化' }[
            target.kind === 'node' ? target.node.status : target.step.status
          ]}
        </span>
      </div>

      {file && <div className="hud-inspector-loc">{file}{focusLine > 1 ? `:${focusLine}` : ''}</div>}

      {target.kind === 'node' && target.node.before_signature && target.node.after_signature &&
        target.node.before_signature !== target.node.after_signature && (
        <div className="hud-struct-row is-mod">
          <small>签名变化</small>
          <span style={{ textDecoration: 'line-through', color: 'var(--danger)' }}>{target.node.before_signature}</span>
          <span style={{ color: 'var(--accent-hover)' }}>{target.node.after_signature}</span>
        </div>
      )}

      {loadingSource ? (
        <small className="muted">正在读取源码对比…</small>
      ) : sourceError ? (
        <small className="warning">{sourceError}</small>
      ) : sourceLines && sourceLines.length > 0 ? (
        <pre className="hud-inspector-diff">
          {sourceLines.map((l, i) => {
            const focused = l.type !== 'gap' && (l.newLine === focusLine || l.oldLine === focusLine);
            return (
              <span key={i} className={`hud-diff-line ${l.type}${focused ? ' is-focus' : ''}`}>
                <b>{l.type === 'gap' ? '…' : (l.newLine ?? l.oldLine ?? '')}</b>
                <span>{l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : l.type === 'gap' ? '' : '  '}{l.text}</span>
              </span>
            );
          })}
        </pre>
      ) : (
        <small className="muted">当前节点未关联源码文件。</small>
      )}

      <div className="hud-inline-ask">
        <form onSubmit={e => void sendAsk(e)}>
          <input
            type="text"
            placeholder="对这处变化有疑问？回车原位追问…"
            value={question}
            disabled={asking}
            onChange={e => setQuestion(e.target.value)}
          />
          <button type="submit" className="hud-mini-btn" disabled={asking || !question.trim()}>
            {asking ? '思考中…' : '追问'}
          </button>
        </form>
        {askError && <small className="warning">{askError}</small>}
        {asking && !answer && <small className="muted">已提交原位追问，等待回答…</small>}
        {answer && <div className="hud-inline-ask-reply">{answer}</div>}
        <div className="hud-inspector-foot">
          <span>原位问答自动绑定{askBinding.askingBefore ? '改前' : '改后'}走读</span>
          {onTargetedContinue && (
            <button
              type="button"
              className="quiet"
              style={{ padding: 0, minHeight: 24, fontSize: 12 }}
              onClick={() => onTargetedContinue(
                `针对 ${file ? `${file}:${focusLine}` : symbolLabel}（${symbolLabel}）处的改动进行调整：`,
              )}
            >
              针对此处补修 →
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function StructureDiffDrawer({
  diff,
  onClose,
}: {
  diff: TaskHudStructureDiff;
  onClose: () => void;
}) {
  const brokenCallers = [
    ...diff.signature_changed_symbols,
    ...diff.removed_symbols,
  ].flatMap(s => (s.unupdated_external_callers ?? []).map(c => ({ symbol: s.symbol, caller: c })));

  return (
    <div className={`hud-drawer${brokenCallers.length || diff.new_cycles.length ? ' tone-danger' : ''}`}>
      <div className="hud-drawer-head">
        <strong>本地 AST 符号级结构 Diff 与契约守卫</strong>
        <button type="button" className="hud-drawer-close" onClick={onClose}>收起</button>
      </div>

      <div className="hud-struct-grid">
        {brokenCallers.length > 0 && (
          <div className="hud-struct-box">
            <h4 style={{ color: 'var(--danger)' }}>范围外未同步调用点 ({brokenCallers.length})</h4>
            {brokenCallers.slice(0, 12).map((item, idx) => (
              <div key={idx} className="hud-struct-row is-del">
                <span>{item.caller.caller_file}:{item.caller.caller_line} → {item.symbol}</span>
                <small>调用方：{item.caller.caller_symbol}</small>
              </div>
            ))}
          </div>
        )}

        {(diff.added_symbols.length > 0 || diff.removed_symbols.length > 0 || diff.signature_changed_symbols.length > 0) && (
          <div className="hud-struct-box">
            <h4>符号变化 (+{diff.added_symbols.length} / −{diff.removed_symbols.length} / ~{diff.signature_changed_symbols.length})</h4>
            {diff.signature_changed_symbols.slice(0, 8).map((s, i) => (
              <div key={'m' + i} className="hud-struct-row is-mod">
                <span>~ {s.symbol}</span>
                <small>{s.file}:{s.line} · 签名变化</small>
              </div>
            ))}
            {diff.added_symbols.slice(0, 8).map((s, i) => (
              <div key={'a' + i} className="hud-struct-row is-add">
                <span>+ {s.symbol}</span>
                <small>{s.file}:{s.line}</small>
              </div>
            ))}
            {diff.removed_symbols.slice(0, 8).map((s, i) => (
              <div key={'r' + i} className="hud-struct-row is-del">
                <span>− {s.symbol}</span>
                <small>{s.file}:{s.line}</small>
              </div>
            ))}
          </div>
        )}

        {(diff.added_calls.length > 0 || diff.removed_calls.length > 0) && (
          <div className="hud-struct-box">
            <h4>跨文件调用边 (+{diff.added_calls.length} / −{diff.removed_calls.length})</h4>
            {diff.added_calls.slice(0, 8).map((c, i) => (
              <div key={'ac' + i} className="hud-struct-row is-add">
                <span>+ {shortSymbol(c.caller_symbol)} → {shortSymbol(c.callee_symbol)}</span>
                <small>{c.caller_file}:{c.caller_line} → {shortFile(c.callee_file)}</small>
              </div>
            ))}
            {diff.removed_calls.slice(0, 8).map((c, i) => (
              <div key={'rc' + i} className="hud-struct-row is-del">
                <span>− {shortSymbol(c.caller_symbol)} → {shortSymbol(c.callee_symbol)}</span>
                <small>{c.caller_file} → {shortFile(c.callee_file)}</small>
              </div>
            ))}
          </div>
        )}

        {(diff.added_module_edges.length > 0 || diff.removed_module_edges.length > 0 || diff.new_cycles.length > 0 || diff.shared_state_changes.length > 0) && (
          <div className="hud-struct-box">
            <h4>模块依赖与共享状态</h4>
            {diff.new_cycles.map((cycle, i) => (
              <div key={'cyc' + i} className="hud-struct-row is-del">
                <span>新增循环依赖：{cycle.join(' → ')}</span>
              </div>
            ))}
            {diff.added_module_edges.slice(0, 6).map((e, i) => (
              <div key={'am' + i} className="hud-struct-row is-add">
                <span>+ {e.from} → {e.to} ({e.before_count} → {e.after_count})</span>
              </div>
            ))}
            {diff.removed_module_edges.slice(0, 6).map((e, i) => (
              <div key={'rm' + i} className="hud-struct-row is-del">
                <span>− {e.from} → {e.to} ({e.before_count} → {e.after_count})</span>
              </div>
            ))}
            {diff.shared_state_changes.map((s, i) => (
              <div key={'ss' + i} className="hud-struct-row is-mod">
                <span>共享状态 {s.name}</span>
                <small>
                  {s.added_dirs.length ? `新增访问：${s.added_dirs.join('、')}` : ''}
                  {s.removed_dirs.length ? ` 移除访问：${s.removed_dirs.join('、')}` : ''}
                </small>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function DeliveryHud({
  task,
  hud,
  onReloadHud,
  onOpenArchitectureOverlay,
  onTargetedContinue,
}: {
  task: EngineeringTask;
  hud: TaskHudSnapshot | null;
  onReloadHud: () => Promise<unknown>;
  onOpenArchitectureOverlay?: (overlay: TaskArchitectureOverlay) => void;
  onTargetedContinue?: (prefill: string) => void;
}) {
  const [showStruct, setShowStruct] = useState(false);
  const [selectedFeatureId, setSelectedFeatureId] = useState('');
  const [viewMode, setViewMode] = useState<'time' | 'chain'>('time');
  const [viewFilter, setViewFilter] = useState<'diff' | 'before' | 'after'>('diff');
  const [hideNoise, setHideNoise] = useState(true);
  const [selectedPathKey, setSelectedPathKey] = useState('');
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [triggering, setTriggering] = useState<string | null>(null);

  const activeTaskRef = useRef(task.task_id);
  activeTaskRef.current = task.task_id;
  const matchedHud = hud?.task_id === task.task_id ? hud : null;
  const struct = matchedHud?.structure_diff;
  const diffs = matchedHud?.walkthrough_diffs ?? [];
  const features = matchedHud?.impacted_features ?? [];

  const activeDiff = useMemo(
    () => diffs.find(d => d.scenario_id === selectedFeatureId) ?? diffs[0] ?? null,
    [diffs, selectedFeatureId],
  );
  const activePath = useMemo(
    () => activeDiff?.paths.find(p => p.path_key === selectedPathKey) ?? activeDiff?.paths[0] ?? null,
    [activeDiff, selectedPathKey],
  );

  // Auto-select first real changed step/node when switching path
  useEffect(() => {
    if (!activePath) {
      setSelectedTarget(null);
      return;
    }
    const firstStep = activePath.steps.find(s => ['added', 'modified', 'removed'].includes(s.status));
    if (firstStep) {
      setSelectedTarget({ kind: 'step', step: firstStep });
      return;
    }
    const firstNode = activePath.participants.find(n => ['added', 'modified', 'removed'].includes(n.status));
    setSelectedTarget(firstNode ? { kind: 'node', node: firstNode } : null);
  }, [activeDiff?.after_result_id, activePath?.path_key]);

  if (!matchedHud) return null;

  const unupdatedCallers = struct
    ? [...struct.signature_changed_symbols, ...struct.removed_symbols]
        .reduce((sum, s) => sum + (s.unupdated_external_callers?.length ?? 0), 0)
    : 0;
  const publicApiChanges = struct
    ? [...struct.signature_changed_symbols, ...struct.removed_symbols].filter(s => s.public_entry).length
    : 0;
  const symbolDeltaTotal = struct
    ? struct.added_symbols.length + struct.removed_symbols.length + struct.signature_changed_symbols.length
    : 0;
  const outOfScopeCount = struct?.out_of_scope_files.length ?? 0;
  const cycleCount = struct?.new_cycles.length ?? 0;
  const contractBroken = unupdatedCallers > 0;
  const firstBroken = struct
    ? [...struct.signature_changed_symbols, ...struct.removed_symbols].find(s => (s.unupdated_external_callers?.length ?? 0) > 0)
    : undefined;
  const hasArchNodes = matchedHud.impact.architecture_nodes.length > 0;

  const scopeBadge = task.changes_status === 'needs_review'
    ? { tone: 'tone-warn', dot: 'warn', label: '差异归属待核查' }
    : !struct
      ? { tone: '', dot: '', label: `结构比对未就绪 · ${task.changes.length} 文件` }
      : !struct.scope_declared
        ? { tone: 'tone-info', dot: 'info', label: `范围未限定 · ${task.changes.length} 文件` }
        : outOfScopeCount > 0
          ? { tone: 'tone-warn', dot: 'warn', label: `越界 ${outOfScopeCount} 文件` }
          : { tone: task.changes.length ? 'tone-ok' : '', dot: task.changes.length ? 'ok' : '', label: `范围内 · ${task.changes.length} 文件` };

  const contractBadge = contractBroken
    ? { tone: 'tone-danger', dot: 'danger', label: `契约预警 · ${unupdatedCallers} 处外部调用待核` }
    : publicApiChanges > 0
      ? { tone: 'tone-warn', dot: 'warn', label: `公开接口变动 ${publicApiChanges}（仓内无未同步调用）` }
      : { tone: 'tone-ok', dot: 'ok', label: '公开接口稳定' };

  async function refreshFeature(scenarioId: string) {
    const requestTaskId = task.task_id;
    setRefreshError('');
    setTriggering(scenarioId);
    try {
      await arc().invoke('walkthrough_feature_refresh', {
        task_id: requestTaskId,
        scenario_id: scenarioId,
        submission_key: `hud-${crypto.randomUUID().slice(0, 16)}`,
      });
      if (activeTaskRef.current === requestTaskId) await onReloadHud();
    } catch (e) {
      if (activeTaskRef.current === requestTaskId) setRefreshError((e as Error).message);
    } finally {
      if (activeTaskRef.current === requestTaskId) setTriggering(null);
    }
  }

  const selectedKey = selectedTarget
    ? (selectedTarget.kind === 'node' ? `node:${selectedTarget.node.key}` : `step:${selectedTarget.step.id}`)
    : '';

  return (
    <section className="hud-after" aria-label="交付 HUD 总览">
      {/* Single-line Verdict Strip */}
      <div className="hud-verdict-card">
        <div className="hud-verdict-strip">
          <span className="hud-strip-label">交付 HUD</span>

          <span className={`hud-pill ${scopeBadge.tone}`}>
            <i className={`hud-dot ${scopeBadge.dot}`} />
            <span>{scopeBadge.label}</span>
          </span>

          {struct && (
            <button
              type="button"
              className={`hud-pill ${contractBadge.tone}`}
              aria-expanded={showStruct}
              onClick={() => setShowStruct(v => !v)}
            >
              <i className={`hud-dot ${contractBadge.dot}`} />
              <span>{contractBadge.label}</span>
            </button>
          )}

          {struct && (
            <button
              type="button"
              className={`hud-pill ${cycleCount ? 'tone-danger' : symbolDeltaTotal ? 'tone-info' : ''}`}
              aria-expanded={showStruct}
              onClick={() => setShowStruct(v => !v)}
            >
              <i className={`hud-dot ${cycleCount ? 'danger' : symbolDeltaTotal ? 'info' : 'ok'}`} />
              <span>
                AST 结构 +{struct.added_symbols.length} / −{struct.removed_symbols.length} / ~{struct.signature_changed_symbols.length}
                {struct.added_calls.length ? ` · +${struct.added_calls.length} 调用` : ''}
                {cycleCount ? ` · 新增 ${cycleCount} 环` : ''}
              </span>
            </button>
          )}

          {hasArchNodes && onOpenArchitectureOverlay && (
            <button
              type="button"
              className="hud-pill"
              onClick={() => onOpenArchitectureOverlay({
                taskId: task.task_id,
                goal: task.goal,
                resultId: matchedHud.impact.architecture_result_id,
                nodes: new Map(matchedHud.impact.architecture_nodes.map(n => [n.node_id, n.relation])),
              })}
            >
              <span>架构叠加图 ↗</span>
            </button>
          )}
        </div>

        {!showStruct && (contractBroken || cycleCount > 0) && (
          <div className="hud-quiet-hint" style={{ borderLeft: '3px solid var(--danger)', background: '#fef6f5', color: 'var(--danger)' }}>
            <span>
              {contractBroken && firstBroken?.unupdated_external_callers?.[0]
                ? <>契约预警：<code>{firstBroken.unupdated_external_callers[0].caller_file}:{firstBroken.unupdated_external_callers[0].caller_line}</code> 等 {unupdatedCallers} 处范围外调用依赖已变更符号 <code>{firstBroken.symbol}</code></>
                : <>结构预警：本次改动引入 {cycleCount} 处新的跨模块循环依赖</>}
            </span>
            <button type="button" className="hud-mini-btn" onClick={() => setShowStruct(true)}>展开明细</button>
          </div>
        )}

        {showStruct && struct && (
          <StructureDiffDrawer diff={struct} onClose={() => setShowStruct(false)} />
        )}
      </div>

      {/* Function Module Walkthrough Call Chain & Timeline Diff */}
      {(diffs.length > 0 || features.length > 0) && (
        <div className="hud-walkthrough">
          <div className="hud-walkthrough-head">
            <div className="hud-walkthrough-title">
              <h3>受影响功能 · 调用链与时间块对比</h3>
              <div className="hud-feature-tabs">
                {features.map(f => {
                  const ready = diffs.some(d => d.scenario_id === f.scenario_id);
                  const active = activeDiff?.scenario_id === f.scenario_id;
                  const busyFeature = f.refreshing || triggering === f.scenario_id;
                  if (ready) {
                    return (
                      <button
                        key={f.scenario_id}
                        type="button"
                        className="hud-pill tone-ok"
                        aria-pressed={active}
                        title={f.label}
                        onClick={() => {
                          setSelectedFeatureId(f.scenario_id);
                          setSelectedPathKey('');
                        }}
                      >
                        <i className="hud-dot ok" />
                        <span>{f.label}</span>
                      </button>
                    );
                  }
                  if (!f.has_call_graph && f.refreshed_result_id) {
                    return (
                      <span
                        key={f.scenario_id}
                        className="hud-pill"
                        title={`${f.label}：开发前无函数调用链基线，已存改后走读但无法生成前后对比`}
                      >
                        <i className="hud-dot" />
                        <span>{f.label} · 无改前基线（已存新走读）</span>
                      </span>
                    );
                  }
                  const actionText = !f.has_call_graph
                    ? (busyFeature ? '生成中…' : f.error ? '重试补建' : '无改前图 · 补建走读')
                    : (busyFeature ? '刷新中…' : f.error ? '重试对比' : '刷新并对比');
                  return (
                    <button
                      key={f.scenario_id}
                      type="button"
                      className="hud-pill"
                      disabled={busyFeature || !task.end_state}
                      onClick={() => void refreshFeature(f.scenario_id)}
                      title={f.error || (!f.has_call_graph
                        ? '该功能在开发前没有函数调用链基线，点击仅补建开发后走读（不会生成前后对比）'
                        : '刷新该功能的最新走读以生成调用链与时间块前后对比')}
                    >
                      <i className={`hud-dot ${busyFeature ? 'pulse' : f.error ? 'danger' : 'info'}`} />
                      <span>{f.label} · {actionText}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {refreshError && <small className="warning">{refreshError}</small>}

          {activeDiff && activePath ? (
            <>
              <div className="hud-walkthrough-controls">
                <div className="hud-walkthrough-controls-left">
                  <div className="hud-segmented" role="group" aria-label="对比视图类型">
                    <button type="button" aria-pressed={viewMode === 'time'} onClick={() => setViewMode('time')}>
                      调用时间块
                    </button>
                    <button type="button" aria-pressed={viewMode === 'chain'} onClick={() => setViewMode('chain')}>
                      函数调用链叠加图
                    </button>
                  </div>

                  {activeDiff.paths.length > 1 && (
                    <select
                      className="hud-path-select"
                      aria-label="选择入口路径"
                      value={activePath.path_key}
                      onChange={e => setSelectedPathKey(e.target.value)}
                    >
                      {activeDiff.paths.map(p => (
                        <option key={p.path_key} value={p.path_key}>
                          {p.label} ({p.counts.added_steps + p.counts.removed_steps + p.counts.modified_steps} 步变化)
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="hud-walkthrough-controls-right">
                  <div className="hud-segmented" role="group" aria-label="对比版本切换">
                    <button type="button" aria-pressed={viewFilter === 'diff'} onClick={() => setViewFilter('diff')}>对比</button>
                    <button type="button" aria-pressed={viewFilter === 'before'} onClick={() => setViewFilter('before')}>改前</button>
                    <button type="button" aria-pressed={viewFilter === 'after'} onClick={() => setViewFilter('after')}>改后</button>
                  </div>

                  <label className="hud-noise-toggle">
                    <input
                      type="checkbox"
                      checked={hideNoise}
                      onChange={e => setHideNoise(e.target.checked)}
                    />
                    <span>
                      仅看代码实改
                      {activePath.counts.noise_count > 0 ? `（已过滤 ${activePath.counts.noise_count} 处措辞噪音）` : ''}
                    </span>
                  </label>
                </div>
              </div>

              {/* Participants Strip (for Timeline mode) */}
              {viewMode === 'time' && (
                <div className="hud-participants" aria-label="参与函数">
                  {activePath.participants
                    .filter(p => !(hideNoise && p.status === 'noise'))
                    .map(p => (
                      <button
                        type="button"
                        key={p.key}
                        className={`hud-participant-chip status-${p.status}`}
                        aria-pressed={selectedKey === `node:${p.key}`}
                        onClick={() => setSelectedTarget({ kind: 'node', node: p })}
                        title={`${p.symbol}${p.file ? '\n' + p.file : ''}`}
                      >
                        {p.status === 'added' ? '+ ' : p.status === 'removed' ? '− ' : p.status === 'modified' ? '~ ' : ''}
                        {shortSymbol(p.symbol)}
                      </button>
                    ))}
                </div>
              )}

              <div className={`hud-compare-split${viewMode === 'chain' ? ' is-chain' : ''}`}>
                <div>
                  {viewMode === 'time' ? (
                    <TimelineSequenceDiff
                      pathDiff={activePath}
                      viewFilter={viewFilter}
                      hideNoise={hideNoise}
                      selectedKey={selectedKey}
                      onSelectStep={step => setSelectedTarget({ kind: 'step', step })}
                    />
                  ) : (
                    <CallChainDiffGraph
                      pathDiff={activePath}
                      viewFilter={viewFilter}
                      hideNoise={hideNoise}
                      selectedKey={selectedKey}
                      onSelectNode={node => setSelectedTarget({ kind: 'node', node })}
                    />
                  )}
                </div>

                <WalkthroughInspector
                  task={task}
                  diff={activeDiff}
                  pathDiff={activePath}
                  target={selectedTarget}
                  onTargetedContinue={onTargetedContinue}
                />
              </div>
            </>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              {features.some(f => f.has_call_graph)
                ? '已识别上述受影响功能模块；点击任一功能的「刷新并对比」即可生成改前/改后的调用链叠加图与时间块时序 Diff。'
                : '已识别上述受影响功能模块；这些功能在开发前尚无函数调用链基线，可点击补建改后走读供后续任务对比。'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
