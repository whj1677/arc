import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  HudArchitectureEdge,
  HudArchitectureNode,
  HudExternalCaller,
  TaskHudSnapshot,
  TaskHudStructureDiff,
  WalkthroughDiff,
  WalkthroughDiffEdge,
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
  call: '调用',
  callback: '回调',
  dispatch: '异步',
  return: '返回',
  work: '处理',
};

const statusLabels: Record<'added' | 'removed' | 'modified' | 'unchanged' | 'noise', string> = {
  added: '新增',
  removed: '已移除',
  modified: '已改动',
  unchanged: '未变',
  noise: '措辞变化',
};

/* ==========================================================================
   Mini Architecture Overlay SVG
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
  const cardW = 186;
  const cardH = 48;
  const gapY = 12;
  const leftX = 16;
  const rightX = neighbors.length ? 290 : 16;
  const rows = Math.max(direct.length, neighbors.length, 1);
  const width = neighbors.length ? 492 : 218;
  const height = Math.max(96, 24 + rows * (cardH + gapY));

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
      <svg className="hud-arch-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="任务架构影响叠加图">
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
                rx="7"
                fill={isDirect ? '#edf7f1' : '#fffcf5'}
                stroke={isDirect ? 'var(--accent)' : 'var(--amber)'}
                strokeWidth={isDirect ? 1.6 : 1.3}
                strokeDasharray={isDirect ? undefined : '4 3'}
              />
              <text x={p.x + 11} y={p.y + 21} fill="var(--ink)" fontSize="12" fontWeight="600">
                {node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label}
              </text>
              <text x={p.x + 11} y={p.y + 37} fill={isDirect ? 'var(--accent)' : 'var(--amber)'} fontSize="10.5">
                {isDirect ? '● 直改' : '○ 波及'}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="hud-arch-legend">
        <span className="hud-arch-legend-items">
          <span><i className="hud-dot ok" /> 直改 ({direct.length})</span>
          <span><i className="hud-dot warn" /> 波及 ({neighbors.length})</span>
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
   1. Pre-Dev Minimal HUD — Compact, Single-Viewport, Zero Fluff
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
  const [showRevise, setShowRevise] = useState(false);
  const [showFullPackage, setShowFullPackage] = useState(false);
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
      setShowFullPackage(false);
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
  const boundaryCount = boundaries.non_goals.length + boundaries.revoked.length;
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
  const noteCount = collectNotes().length;
  const fullPackageNode = showFullPackage ? renderFullPackage?.(snapshot) : null;

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
      {/* Top Glanceable HUD Strip: Impact Signals + Redlines + Version */}
      <div className="hud-before-top">
        <div className="hud-signal-strip" role="group" aria-label="改前影响面 HUD">
          <span className="hud-strip-label">改前 HUD</span>
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
              <span>索引中…</span>
            </span>
          ) : null}

          {sharedCount > 0 && (
            <button type="button" className="hud-pill tone-warn" aria-expanded={openDrawer === 'shared'} onClick={() => toggleDrawer('shared')}>
              <i className="hud-dot warn" />
              <span>共享状态 <strong>{sharedCount}</strong></span>
            </button>
          )}

          {featureCount > 0 && (
            <button type="button" className="hud-pill tone-info" aria-expanded={openDrawer === 'features'} onClick={() => toggleDrawer('features')}>
              <i className="hud-dot info" />
              <span>涉及功能 <strong>{featureCount}</strong></span>
            </button>
          )}

          {archCount > 0 && (
            <button type="button" className="hud-pill" aria-expanded={openDrawer === 'arch'} onClick={() => toggleDrawer('arch')}>
              <i className="hud-dot ok" />
              <span>架构叠加</span>
            </button>
          )}

          {untestedCount > 0 && (
            <button type="button" className="hud-pill" aria-expanded={openDrawer === 'untested'} onClick={() => toggleDrawer('untested')}>
              <i className="hud-dot warn" />
              <span>未测入口 <strong>{untestedCount}</strong></span>
            </button>
          )}

          {constraintCount > 0 && (
            <button type="button" className="hud-pill" aria-expanded={openDrawer === 'constraints'} onClick={() => toggleDrawer('constraints')}>
              <i className="hud-dot info" />
              <span>约束 <strong>{constraintCount}</strong></span>
            </button>
          )}

          <button
            type="button"
            className={`hud-pill${boundaryCount > 0 ? ' tone-warn' : ''}`}
            aria-expanded={openDrawer === 'boundaries'}
            onClick={() => toggleDrawer('boundaries')}
          >
            <span>{boundaryCount > 0 ? <>红线 <strong>{boundaryCount}</strong></> : '+ 红线'}</span>
          </button>
        </div>

        <span className="hud-before-ver">
          <span>v{snapshot.version}</span>
          {stale && (
            <button type="button" className="hud-mini-btn" disabled={busy} onClick={() => syncSnapshot(task)}>
              同步 v{task.version}
            </button>
          )}
        </span>
      </div>

      {/* On-Demand Compact Drawer (only rendered when a top HUD pill is clicked) */}
      {openDrawer && (
        <div className="hud-before-drawer-wrap">
          {openDrawer === 'callers' && impact && (
            <div className={`hud-drawer${externalCount > 0 ? ' tone-danger' : ''}`}>
              <div className="hud-drawer-head">
                <strong>范围外上游调用（本地 AST · {externalCount}）</strong>
                <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
              </div>
              {boundaryError && <small role="alert" className="warning">{boundaryError}</small>}
              {snippetError && <small className="warning">{snippetError}</small>}
              {snippet && (
                <div className="hud-inline-snippet" aria-label="调用点源码预览">
                  <div className="row between" style={{ marginBottom: 4, color: 'var(--muted)' }}>
                    <span>{snippet.file}:{snippet.line}</span>
                    <button type="button" className="hud-drawer-close" onClick={() => setSnippet(null)}>关闭</button>
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
                <small className="muted">未检出范围外直接调用。</small>
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
                          <button type="button" className="hud-mini-btn" onClick={() => void previewCaller(c.caller_file, c.caller_line)}>源码</button>
                          <button
                            type="button"
                            className={`hud-mini-btn${guarded ? ' done' : ''}`}
                            disabled={savingBoundary || stale || guarded}
                            onClick={() => void guardCaller(c)}
                          >
                            {guarded ? '✓ 已护' : '设为不改'}
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {openDrawer === 'boundaries' && (
            <div className="hud-drawer">
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
            </div>
          )}

          {openDrawer === 'shared' && impact && (
            <div className="hud-drawer tone-warn">
              <div className="hud-drawer-head">
                <strong>跨目录共享状态</strong>
                <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
              </div>
              <div className="hud-caller-list">
                {impact.shared_states.map((s, idx) => (
                  <div key={idx} className="hud-caller-row">
                    <span className="hud-caller-loc"><strong>{s.name}</strong><span>{s.file}:{s.line}</span></span>
                    <small>外部目录：{s.external_dirs.join('、')}</small>
                  </div>
                ))}
              </div>
            </div>
          )}

          {openDrawer === 'features' && impact && (
            <div className="hud-drawer">
              <div className="hud-drawer-head">
                <strong>受影响功能模块</strong>
                <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
              </div>
              <div className="hud-caller-list">
                {impact.impacted_features.map(f => (
                  <div key={f.scenario_id} className="hud-caller-row">
                    <strong>{f.label}</strong>
                    <small>{f.has_call_graph ? '已有调用链 · 改后支持对比' : '功能目录匹配'}</small>
                  </div>
                ))}
              </div>
            </div>
          )}

          {openDrawer === 'arch' && impact && (
            <div className="hud-drawer">
              <div className="hud-drawer-head">
                <strong>架构影响叠加</strong>
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
                <strong>测试未覆盖公开入口</strong>
                <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
              </div>
              <div className="hud-caller-list">
                {impact.untested_symbols.map((u, idx) => (
                  <div key={idx} className="hud-caller-row">
                    <span className="hud-caller-loc"><strong>{u.symbol}</strong><span>{u.file}:{u.line}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {openDrawer === 'constraints' && impact && (
            <div className="hud-drawer">
              <div className="hud-drawer-head">
                <strong>关联工程约束</strong>
                <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
              </div>
              <div className="hud-caller-list">
                {impact.related_constraints.map(c => (
                  <div key={c.entry_id} className="hud-caller-row">
                    <div>
                      <strong>{c.key}</strong>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-secondary)' }}>{c.excerpt}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Compact Spec Body */}
      <div className="hud-before-body">
        {error && <p role="alert" className="warning" style={{ margin: 0 }}>{error}</p>}

        {!pkg ? (
          <div className="row between">
            <span className="muted">尚未生成需求包。</span>
            <button
              type="button"
              disabled={busy || stale}
              onClick={() => void onRevise(snapshot, '根据当前目标和既有资料重新进行只读分析，生成完整需求包。')}
            >
              重新分析
            </button>
          </div>
        ) : (
          <>
            {(snapshot.summary || scope.length > 0) && (
              <div className="hud-spec-lead">
                {snapshot.summary && <p className="hud-spec-summary">{snapshot.summary}</p>}
                {scope.length > 0 && (
                  <div className="hud-scope-inline" aria-label="建议修改文件">
                    {scope.map(file => (
                      <code key={file} title={file}>{shortFile(file)}</code>
                    ))}
                  </div>
                )}
              </div>
            )}

            {pkg.behaviors.length > 0 && (
              <ol className="hud-behaviors">
                {pkg.behaviors.map((item, idx) => (
                  <li key={item.id} className="hud-behavior-item">
                    <span className="hud-behavior-index">{idx + 1}</span>
                    <div className="hud-behavior-content">
                      <div className="hud-behavior-head">
                        <span className="hud-behavior-title">{item.behavior}</span>
                        {item.files.map(f => (
                          <code key={f} className="hud-behavior-file" title={f}>{shortFile(f)}</code>
                        ))}
                      </div>
                      {item.design && <p className="hud-behavior-design">{item.design}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {(assumptions.length > 0 || openQuestions.length > 0) && (
              <div className="hud-inline-notes">
                {assumptions.map((text, idx) => {
                  const val = assumptionEdits[idx] ?? text;
                  const trimmed = val.trim();
                  const cleared = assumptionEdits[idx] !== undefined && !trimmed;
                  const edited = assumptionEdits[idx] !== undefined && !!trimmed && trimmed !== text.trim();
                  return (
                    <div key={'a' + idx} className={`hud-assumption-row${edited ? ' is-edited' : cleared ? ' is-cleared' : ''}`}>
                      <span className="hud-assumption-tag">{edited ? '已微调' : cleared ? '留空忽略' : 'AI 补全'}</span>
                      <input
                        className="hud-assumption-input"
                        aria-label={`编辑 AI 假设 ${idx + 1}`}
                        placeholder="留空忽略编辑，点还原恢复"
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
                {openQuestions.map((q, idx) => (
                  <div key={'q' + idx} className="hud-question-row">
                    <span>待确认：{q}</span>
                    <input
                      type="text"
                      placeholder="可选回答…"
                      value={questionReplies[idx] ?? ''}
                      disabled={busy || stale}
                      onChange={e => setQuestionReplies(prev => ({ ...prev, [idx]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Compact Single-Row Action Footer */}
      {pkg && (
        <div className="hud-before-footer">
          <div className="hud-before-footer-bar">
            <div className="hud-before-footer-left">
              {renderFullPackage && (
                <button
                  type="button"
                  className="hud-drawer-close"
                  aria-expanded={showFullPackage}
                  onClick={() => setShowFullPackage(v => !v)}
                >
                  {showFullPackage ? '收起完整需求包 ▴' : '完整需求包 ▾'}
                </button>
              )}
              {noteCount > 0 && <span className="hud-pill tone-ok">已微调 {noteCount} 项</span>}
            </div>
            <div className="hud-before-footer-actions">
              <button type="button" disabled={busy || savingBoundary || stale} onClick={() => setShowRevise(v => !v)}>
                {showRevise ? '取消' : '退回补充'}
              </button>
              <button className="primary" disabled={busy || savingBoundary || stale || !scope.length} onClick={handleApprove}>
                按此方案执行
              </button>
            </div>
          </div>

          <details className="hud-revise-details" open={showRevise} onToggle={e => setShowRevise(e.currentTarget.open)}>
            <summary>修订意见</summary>
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

      {fullPackageNode && <div className="hud-full-package-wrap">{fullPackageNode}</div>}
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
              {Math.min(activeSteps.length, completedSteps + (currentStep ? 1 : 0))}/{activeSteps.length}
            </span>
          )}
          {scopeCount > 0 && task.workflow !== 'analysis' && !backfilled && (
            <span className="hud-flight-step">{scopeCount} 文件</span>
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
            <button type="button" className="hud-mini-btn" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
              {expanded ? '收起 ▴' : `实时流 (${lines.length}) ▾`}
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
   3. Post-Dev Diagram-First HUD (Full-Width Call Graph + Lifeline Sequence Diff)
   ========================================================================== */
type SelectedTarget =
  | { kind: 'node'; node: WalkthroughDiffNode }
  | { kind: 'edge'; edge: WalkthroughDiffEdge }
  | { kind: 'step'; step: WalkthroughDiffStep };

function CallChainDiffGraph({
  pathDiff,
  viewFilter,
  hideNoise,
  selectedTarget,
  onSelectNode,
  onSelectEdge,
}: {
  pathDiff: WalkthroughPathDiff;
  viewFilter: 'diff' | 'before' | 'after';
  hideNoise: boolean;
  selectedTarget: SelectedTarget | null;
  onSelectNode: (node: WalkthroughDiffNode) => void;
  onSelectEdge: (edge: WalkthroughDiffEdge) => void;
}) {
  const markerId = 'hud-chain-' + useId().replace(/:/g, '');
  const visibleNodes = useMemo(() => pathDiff.participants.filter(n => {
    if (hideNoise && n.status === 'noise') return false;
    if (viewFilter === 'before') return n.before_node_id !== undefined;
    if (viewFilter === 'after') return n.after_node_id !== undefined;
    return true;
  }), [pathDiff.participants, hideNoise, viewFilter]);

  const nodeMap = useMemo(() => new Map(visibleNodes.map(n => [n.key, n])), [visibleNodes]);

  const visibleEdges = useMemo(() => pathDiff.edges.filter(e => {
    if (!nodeMap.has(e.from_key) || !nodeMap.has(e.to_key)) return false;
    if (hideNoise && e.status === 'noise') return false;
    if (viewFilter === 'before') return e.status !== 'added';
    if (viewFilter === 'after') return e.status !== 'removed';
    return true;
  }), [pathDiff.edges, nodeMap, hideNoise, viewFilter]);

  const entryKey = useMemo(() => {
    const exact = visibleNodes.find(n => n.key === pathDiff.path_key);
    if (exact) return exact.key;
    const bySym = visibleNodes.find(n => n.symbol === pathDiff.entry_symbol);
    return bySym?.key ?? visibleNodes[0]?.key ?? '';
  }, [visibleNodes, pathDiff.path_key, pathDiff.entry_symbol]);

  // Focus upstream/downstream subgraph when a node or edge is selected
  const focus = useMemo(() => {
    if (!selectedTarget) return null;
    if (selectedTarget.kind === 'edge') {
      return {
        nodes: new Set([selectedTarget.edge.from_key, selectedTarget.edge.to_key]),
        edges: new Set([selectedTarget.edge.key]),
      };
    }
    const anchor = selectedTarget.kind === 'node' ? selectedTarget.node.key : selectedTarget.step.to_key;
    if (!nodeMap.has(anchor)) return null;
    const out = new Map<string, WalkthroughDiffEdge[]>();
    const inc = new Map<string, WalkthroughDiffEdge[]>();
    for (const e of visibleEdges) {
      (out.get(e.from_key) ?? out.set(e.from_key, []).get(e.from_key)!).push(e);
      (inc.get(e.to_key) ?? inc.set(e.to_key, []).get(e.to_key)!).push(e);
    }
    const nodes = new Set<string>([anchor]);
    const edges = new Set<string>();
    const walk = (start: string, adj: Map<string, WalkthroughDiffEdge[]>, nextKey: (e: WalkthroughDiffEdge) => string) => {
      const q = [start];
      const seen = new Set([start]);
      while (q.length) {
        const cur = q.shift()!;
        for (const e of adj.get(cur) ?? []) {
          edges.add(e.key);
          const nxt = nextKey(e);
          nodes.add(nxt);
          if (!seen.has(nxt)) { seen.add(nxt); q.push(nxt); }
        }
      }
    };
    walk(anchor, out, e => e.to_key);
    walk(anchor, inc, e => e.from_key);
    return { nodes, edges };
  }, [selectedTarget, visibleEdges, nodeMap]);

  // Global topological rank (only used to order file swimlanes top-to-bottom)
  const globalRank = new Map<string, number>();
  const globalIncoming = new Map<string, string[]>();
  for (const n of visibleNodes) globalIncoming.set(n.key, []);
  for (const e of visibleEdges) {
    if (e.from_key !== e.to_key) globalIncoming.get(e.to_key)?.push(e.from_key);
  }
  if (entryKey) globalRank.set(entryKey, 0);
  const visitingGlobal = new Set<string>();
  function getGlobalRank(key: string): number {
    if (globalRank.has(key)) return globalRank.get(key)!;
    if (visitingGlobal.has(key)) return 0;
    visitingGlobal.add(key);
    const parents = globalIncoming.get(key) ?? [];
    const val = parents.length ? Math.max(...parents.map(p => getGlobalRank(p) + 1)) : 0;
    visitingGlobal.delete(key);
    globalRank.set(key, val);
    return val;
  }
  for (const n of visibleNodes) getGlobalRank(n.key);

  // Group into file swimlanes ordered top-to-bottom (entry file first, multi-node core files before leaf async sinks)
  const fileGroups = new Map<string, WalkthroughDiffNode[]>();
  for (const n of visibleNodes) {
    const g = n.file || '未定位文件';
    const list = fileGroups.get(g);
    if (list) list.push(n);
    else fileGroups.set(g, [n]);
  }
  const hasOutEdge = new Set(visibleEdges.map(e => e.from_key));
  const orderedGroups = [...fileGroups.entries()].sort(([, a], [, b]) => {
    const aHasEntry = a.some(n => n.key === entryKey) ? 0 : 1;
    const bHasEntry = b.some(n => n.key === entryKey) ? 0 : 1;
    if (aHasEntry !== bHasEntry) return aHasEntry - bHasEntry;
    const aSink = a.every(n => !hasOutEdge.has(n.key)) ? 1 : 0;
    const bSink = b.every(n => !hasOutEdge.has(n.key)) ? 1 : 0;
    if (aSink !== bSink) return aSink - bSink;
    const minA = Math.min(...a.map(n => globalRank.get(n.key) ?? 0));
    const minB = Math.min(...b.map(n => globalRank.get(n.key) ?? 0));
    return minA - minB || b.length - a.length;
  });

  // Compute local intra-file DAG columns so each file swimlane starts cleanly at col 0 (no staircase dead whitespace!)
  const nodeW = 186;
  const nodeH = 60;
  const colStep = 286;
  const rowStep = 74;
  const bandGap = 30;
  const pillW = 134;
  const pillH = 22;
  const skipEdges = visibleEdges.filter(e => {
    const fi = orderedGroups.findIndex(([f]) => f === (nodeMap.get(e.from_key)?.file || '未定位文件'));
    const ti = orderedGroups.findIndex(([f]) => f === (nodeMap.get(e.to_key)?.file || '未定位文件'));
    return fi !== -1 && ti !== -1 && Math.abs(ti - fi) > 1;
  });
  const leftRail = skipEdges.length > 0 ? 150 : 22;

  const boxes = new Map<string, { x: number; y: number; bandIndex: number }>();
  const bands: { file: string; count: number; y: number; h: number }[] = [];
  let cursorY = 12;
  let maxX = 680;

  orderedGroups.forEach(([file, list], bandIndex) => {
    const inBand = new Set(list.map(n => n.key));
    const localIncoming = new Map<string, string[]>();
    for (const n of list) localIncoming.set(n.key, []);
    for (const e of visibleEdges) {
      if (e.from_key !== e.to_key && inBand.has(e.from_key) && inBand.has(e.to_key)) {
        localIncoming.get(e.to_key)!.push(e.from_key);
      }
    }
    const localCol = new Map<string, number>();
    const vis = new Set<string>();
    const getCol = (key: string): number => {
      if (localCol.has(key)) return localCol.get(key)!;
      if (vis.has(key)) return 0;
      vis.add(key);
      const parents = localIncoming.get(key) ?? [];
      const val = parents.length ? Math.max(...parents.map(p => getCol(p) + 1)) : 0;
      vis.delete(key);
      localCol.set(key, val);
      return val;
    };
    for (const n of list) getCol(n.key);

    const sorted = [...list].sort((a, b) => (localCol.get(a.key) ?? 0) - (localCol.get(b.key) ?? 0));
    const colRows = new Map<number, number>();
    const topY = cursorY;
    const contentTop = topY + 32;
    let bandBottom = contentTop + nodeH + 14;
    for (const node of sorted) {
      const c = localCol.get(node.key) ?? 0;
      const r = colRows.get(c) ?? 0;
      colRows.set(c, r + 1);
      const x = leftRail + c * colStep;
      const y = contentTop + r * rowStep;
      boxes.set(node.key, { x, y, bandIndex });
      maxX = Math.max(maxX, x + nodeW + 24);
      bandBottom = Math.max(bandBottom, y + nodeH + 14);
    }
    bands.push({ file, count: list.length, y: topY, h: bandBottom - topY });
    cursorY = bandBottom + bandGap;
  });

  // Route edges: intra-file left-to-right, adjacent cross-file top-to-bottom through open corridor, skip-band via dedicated left rail
  const placedLabels: { x: number; y: number }[] = [];
  let railIdx = 0;
  const edgeGeoms = visibleEdges.flatMap(edge => {
    const a = boxes.get(edge.from_key);
    const b = boxes.get(edge.to_key);
    if (!a || !b) return [];
    const fromNode = nodeMap.get(edge.from_key)!;
    const toNode = nodeMap.get(edge.to_key)!;
    const crossFile = a.bandIndex !== b.bandIndex;
    let d: string;
    let mx: number;
    let my: number;
    if (edge.from_key === edge.to_key) {
      d = `M${a.x + nodeW - 18} ${a.y} C${a.x + nodeW + 34} ${a.y - 24} ${a.x + nodeW + 34} ${a.y + 32} ${a.x + nodeW + 2} ${a.y + 24}`;
      mx = a.x + nodeW + 34;
      my = a.y + 4;
    } else if (!crossFile) {
      // Intra-file edge
      if (a.x < b.x) {
        const sx = a.x + nodeW;
        const sy = a.y + nodeH / 2;
        const tx = b.x - 5;
        const ty = b.y + nodeH / 2;
        const cx = (sx + tx) / 2;
        d = `M${sx} ${sy} C${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`;
        mx = cx;
        my = (sy + ty) / 2;
      } else {
        const sx = a.x + nodeW / 2;
        const sy = a.y + nodeH;
        const tx = b.x + nodeW / 2;
        const ty = b.y + nodeH + 5;
        const cy = Math.max(sy, ty) + 26;
        d = `M${sx} ${sy} C${sx} ${cy} ${tx} ${cy} ${tx} ${ty}`;
        mx = (sx + tx) / 2;
        my = cy - 4;
      }
    } else if (Math.abs(b.bandIndex - a.bandIndex) === 1) {
      // Adjacent file band: route cleanly through the open bandGap corridor between bands!
      const down = b.bandIndex > a.bandIndex;
      const sx = a.x + nodeW / 2;
      const sy = down ? a.y + nodeH : a.y;
      const tx = b.x + nodeW / 2;
      const ty = down ? b.y - 5 : b.y + nodeH + 5;
      const corridorY = down
        ? bands[a.bandIndex].y + bands[a.bandIndex].h + bandGap / 2
        : bands[b.bandIndex].y + bands[b.bandIndex].h + bandGap / 2;
      d = `M${sx} ${sy} C${sx} ${corridorY} ${tx} ${corridorY} ${tx} ${ty}`;
      mx = (sx + tx) / 2;
      my = corridorY;
    } else {
      // Skip-band cross-file edge (e.g., async dispatch from entry to bottom sink): route along clean left rail!
      const rx = Math.max(24, leftRail - 68 - railIdx * 28);
      railIdx++;
      const sx = a.x;
      const sy = a.y + nodeH / 2;
      const tx = b.x - 5;
      const ty = b.y + nodeH / 2;
      d = `M${sx} ${sy} H${rx + 12} Q${rx} ${sy} ${rx} ${sy + (ty > sy ? 12 : -12)} V${ty + (ty > sy ? -12 : 12)} Q${rx} ${ty} ${rx + 12} ${ty} H${tx}`;
      mx = rx + 6;
      my = (sy + ty) / 2;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = placedLabels.some(p => Math.abs(p.x - mx) < pillW * 0.85 && Math.abs(p.y - my) < pillH + 3);
      if (!clash) break;
      my += (attempt % 2 === 0 ? 1 : -1) * (pillH + 4) * Math.ceil((attempt + 1) / 2);
    }
    placedLabels.push({ x: mx, y: my });
    maxX = Math.max(maxX, mx + pillW / 2 + 16);
    return [{ edge, d, mx, my, crossFile }];
  });

  const width = maxX;
  const height = Math.max(200, cursorY - bandGap + 14);

  if (!visibleNodes.length) {
    return <p className="muted" style={{ margin: '8px 0' }}>当前过滤条件下没有可展示的函数节点。</p>;
  }

  return (
    <div className="hud-diagram-wrap">
      <div className="hud-diagram-frame">
        <svg
          className="hud-diagram-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height: 'auto', maxWidth: width }}
          role="img"
          aria-label="多文件函数调用链前后对比图"
        >
          <defs>
            <marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="context-stroke" />
            </marker>
          </defs>

          {/* File Swimlane Bands */}
          {bands.map(band => (
            <g key={band.file}>
              <rect className="hud-file-band" x={Math.max(10, leftRail - 12)} y={band.y} width={width - Math.max(10, leftRail - 12) - 10} height={band.h} rx="12" />
              <foreignObject x={Math.max(20, leftRail - 2)} y={band.y + 6} width={width - Math.max(20, leftRail - 2) - 18} height="22">
                <div className="hud-file-band-head" title={band.file}>
                  <strong>{shortFile(band.file)}</strong>
                  <span>{band.file}</span>
                  <small>{band.count} 函数</small>
                </div>
              </foreignObject>
            </g>
          ))}

          {/* Call Edge Curves */}
          {edgeGeoms.map(({ edge, d }) => {
            const dimmed = Boolean(focus && !focus.edges.has(edge.key));
            const selected = selectedTarget?.kind === 'edge' && selectedTarget.edge.key === edge.key;
            const stroke =
              edge.status === 'added' ? 'var(--accent)'
                : edge.status === 'removed' ? 'var(--danger)'
                  : edge.kind === 'execution_boundary' ? 'var(--blue)' : '#899f94';
            const dash =
              edge.status === 'removed' ? '5 3'
                : edge.status === 'noise' ? '2 3'
                  : edge.kind === 'execution_boundary' ? '6 3' : undefined;
            return (
              <g
                key={'p:' + edge.key}
                className={`hud-edge-group${dimmed ? ' is-dim' : ''}`}
                onClick={() => onSelectEdge(edge)}
              >
                <path d={d} fill="none" stroke="transparent" strokeWidth="14" />
                <path
                  d={d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={selected ? 2.6 : edge.status === 'added' || edge.status === 'removed' ? 2.1 : 1.5}
                  strokeDasharray={dash}
                  markerEnd={`url(#${markerId})`}
                />
              </g>
            );
          })}

          {/* Function Cards */}
          {visibleNodes.map(node => {
            const b = boxes.get(node.key)!;
            const isEntry = node.key === entryKey;
            const dimmed = Boolean(focus && !focus.nodes.has(node.key));
            const isSelected = selectedTarget?.kind === 'node' && selectedTarget.node.key === node.key;
            const prefix = node.status === 'added' ? '+ ' : node.status === 'removed' ? '− ' : node.status === 'modified' ? '~ ' : '';
            const line = node.after_line ?? node.before_line;
            return (
              <foreignObject key={node.key} x={b.x} y={b.y} width={nodeW} height={nodeH}>
                <button
                  type="button"
                  className={`hud-chain-node status-${node.status}${dimmed ? ' is-dim' : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelectNode(node)}
                  title={`${node.symbol}\n${node.file ?? ''}${line ? ':' + line : ''}\n${node.description}`}
                >
                  <div className="hud-chain-node-meta">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {isEntry && <em className="hud-node-entry">入口</em>}
                      <span className="hud-node-badge">{statusLabels[node.status]}</span>
                    </span>
                    {line && <span className="hud-node-line">L{line}</span>}
                  </div>
                  <strong>{prefix + shortSymbol(node.symbol)}</strong>
                  <span className="hud-chain-node-desc">{node.description || node.label}</span>
                </button>
              </foreignObject>
            );
          })}

          {/* Clickable Relationship Pills */}
          {edgeGeoms.map(({ edge, mx, my, crossFile }) => {
            const dimmed = Boolean(focus && !focus.edges.has(edge.key));
            const selected = selectedTarget?.kind === 'edge' && selectedTarget.edge.key === edge.key;
            const text = edge.after_label || edge.before_label || (edge.kind === 'execution_boundary' ? '异步派发' : '同步调用');
            const tag =
              edge.status === 'added' ? '+'
                : edge.status === 'removed' ? '−'
                  : edge.kind === 'execution_boundary' ? '异步'
                    : crossFile ? '跨文件' : '';
            return (
              <foreignObject
                key={'l:' + edge.key}
                className={`hud-edge-group${dimmed ? ' is-dim' : ''}`}
                x={Math.max(12, Math.min(width - pillW - 12, mx - pillW / 2))}
                y={Math.max(8, my - pillH / 2)}
                width={pillW}
                height={pillH}
              >
                <button
                  type="button"
                  className={`hud-edge-pill status-${edge.status}${edge.kind === 'execution_boundary' ? ' kind-async' : ''}`}
                  aria-pressed={selected}
                  onClick={() => onSelectEdge(edge)}
                  title={`${shortSymbol(edge.from_key)} → ${shortSymbol(edge.to_key)}\n${crossFile ? '跨文件' : '同文件'} · ${edge.kind === 'execution_boundary' ? '异步边界' : '同步调用'}\n${text}`}
                >
                  {tag && <em className="hud-edge-tag">{tag}</em>}
                  <span>{text}</span>
                </button>
              </foreignObject>
            );
          })}
        </svg>
      </div>

      <div className="hud-diagram-legend">
        <span className="hud-legend-items">
          <span><i className="hud-dot ok" /> 新增节点/调用</span>
          <span><i className="hud-dot warn" /> 代码或签名改动</span>
          <span><i className="hud-dot danger" /> 已移除（虚线）</span>
          <span><i className="hud-dot info" /> 异步派发边界</span>
        </span>
        <span>{visibleNodes.length} 函数 · {visibleEdges.length} 调用关系 · 点节点或连线看源码 Diff</span>
      </div>
    </div>
  );
}

function TimelineSequenceDiff({
  pathDiff,
  viewFilter,
  hideNoise,
  selectedTarget,
  onSelectStep,
  onSelectNode,
}: {
  pathDiff: WalkthroughPathDiff;
  viewFilter: 'diff' | 'before' | 'after';
  hideNoise: boolean;
  selectedTarget: SelectedTarget | null;
  onSelectStep: (step: WalkthroughDiffStep) => void;
  onSelectNode: (node: WalkthroughDiffNode) => void;
}) {
  const markerId = 'hud-seq-' + useId().replace(/:/g, '');
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
      else { flush(); out.push({ type: 'step', step }); }
    }
    flush();
    return out;
  }, [visibleSteps, viewFilter]);

  // Only render lifelines for participants present in currently expanded/visible steps (expanding a fold adds its lifelines back!)
  const shownSteps = useMemo(() => blocks.flatMap(b => (b.type === 'step' ? [b.step] : unfolded.has(b.id) ? b.steps : [])), [blocks, unfolded]);

  const participants = useMemo(() => {
    const byKey = new Map(pathDiff.participants.map(p => [p.key, p]));
    const source = shownSteps.length ? shownSteps : visibleSteps;
    const order: WalkthroughDiffNode[] = [];
    const seen = new Set<string>();
    const add = (key: string | null) => {
      if (!key || seen.has(key)) return;
      const node = byKey.get(key);
      if (node) { seen.add(key); order.push(node); }
    };
    if (source.some(s => s.from_key === pathDiff.path_key || s.to_key === pathDiff.path_key)) add(pathDiff.path_key);
    for (const step of source) {
      add(step.from_key);
      add(step.to_key);
    }
    return order;
  }, [pathDiff.participants, pathDiff.path_key, shownSteps, visibleSteps]);

  if (!visibleSteps.length || !participants.length) {
    return <p className="muted" style={{ margin: '8px 0' }}>当前路径没有可展示的调用时间步。</p>;
  }

  const partW = 136;
  const colStep = 148;
  const leftPad = 24;
  const headerH = 70;
  const colX = new Map<string, number>();
  participants.forEach((p, idx) => {
    colX.set(p.key, leftPad + idx * colStep + partW / 2);
  });
  const width = Math.max(620, leftPad + participants.length * colStep + 22);

  // Flatten blocks respecting unfolded state and assign vertical Y bands
  type RowItem =
    | { type: 'fold'; id: string; count: number; open: boolean; y: number; h: number }
    | { type: 'step'; step: WalkthroughDiffStep; y: number; h: number; condChanged: boolean; inputChanged: boolean; outputChanged: boolean };

  const rows: RowItem[] = [];
  let cursorY = headerH + 10;
  const pushStep = (step: WalkthroughDiffStep) => {
    const condChanged = viewFilter === 'diff' && step.status === 'modified' && step.diff_reasons.includes('condition') && Boolean(step.before_condition || step.after_condition);
    const inputChanged = viewFilter === 'diff' && step.status === 'modified' && step.diff_reasons.includes('io') && (step.before_input?.trim() ?? '') !== (step.after_input?.trim() ?? '');
    const outputChanged = viewFilter === 'diff' && step.status === 'modified' && step.diff_reasons.includes('io') && (step.before_output?.trim() ?? '') !== (step.after_output?.trim() ?? '');
    const hasDelta = condChanged || inputChanged || outputChanged;
    const h = hasDelta ? 78 : 62;
    rows.push({ type: 'step', step, y: cursorY, h, condChanged, inputChanged, outputChanged });
    cursorY += h;
  };

  for (const block of blocks) {
    if (block.type === 'step') {
      pushStep(block.step);
    } else {
      const open = unfolded.has(block.id);
      rows.push({ type: 'fold', id: block.id, count: block.steps.length, open, y: cursorY, h: 36 });
      cursorY += 36;
      if (open) {
        for (const s of block.steps) pushStep(s);
      }
    }
  }

  const height = cursorY + 18;

  return (
    <div className="hud-diagram-wrap">
      <div className="hud-diagram-frame">
        <svg
          className="hud-diagram-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={width <= 1320 ? { width: '100%', height: 'auto', maxWidth: width } : undefined}
          role="img"
          aria-label="调用时间图前后对比"
        >
          <defs>
            <marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="context-stroke" />
            </marker>
          </defs>

          {/* Row diff highlight bands (behind lifelines) */}
          {rows.map(row => {
            if (row.type !== 'step' || row.step.status === 'unchanged' || row.step.status === 'noise') return null;
            const fill =
              row.step.status === 'added' ? '#edf8f1'
                : row.step.status === 'removed' ? '#fdf2f1' : '#fdf8ec';
            const bar =
              row.step.status === 'added' ? 'var(--accent)'
                : row.step.status === 'removed' ? 'var(--danger)' : 'var(--amber)';
            return (
              <g key={'bg:' + row.step.id}>
                <rect x="6" y={row.y + 2} width={width - 12} height={row.h - 4} rx="6" fill={fill} />
                <rect x="6" y={row.y + 2} width="3.5" height={row.h - 4} rx="2" fill={bar} />
              </g>
            );
          })}

          {/* Vertical Lifelines */}
          {participants.map(p => {
            const x = colX.get(p.key)!;
            return <line key={'ll:' + p.key} className="hud-seq-lifeline" x1={x} y1={headerH} x2={x} y2={height - 10} />;
          })}

          {/* Participant Column Headers */}
          {participants.map((p, idx) => {
            const x = colX.get(p.key)! - partW / 2;
            const prefix = p.status === 'added' ? '+ ' : p.status === 'removed' ? '− ' : p.status === 'modified' ? '~ ' : '';
            const selected = selectedTarget?.kind === 'node' && selectedTarget.node.key === p.key;
            return (
              <foreignObject key={'ph:' + p.key} x={x} y="8" width={partW} height="60">
                <button
                  type="button"
                  className={`hud-seq-participant status-${p.status}`}
                  aria-pressed={selected}
                  onClick={() => onSelectNode(p)}
                  title={`${p.symbol}\n${p.file ?? ''}`}
                >
                  <div className="hud-chain-node-meta">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {idx === 0 && <em className="hud-node-entry">入口</em>}
                      <span className="hud-node-badge">{statusLabels[p.status]}</span>
                    </span>
                  </div>
                  <strong>{prefix + shortSymbol(p.symbol)}</strong>
                  <small>{shortFile(p.file)}</small>
                </button>
              </foreignObject>
            );
          })}

          {/* Sequence Rows & Inline Fold Bars */}
          {rows.map(row => {
            if (row.type === 'fold') {
              const foldW = Math.min(280, width - 48);
              const foldX = width <= 1320 ? (width - foldW) / 2 : 24;
              return (
                <foreignObject key={row.id} x={foldX} y={row.y + 5} width={foldW} height="26">
                  <button
                    type="button"
                    className="hud-seq-fold-btn"
                    onClick={() => setUnfolded(prev => {
                      const next = new Set(prev);
                      if (row.open) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })}
                  >
                    {row.open ? `▴ 收起 ${row.count} 个未变调用步` : `⋯ 已折叠 ${row.count} 个未变调用步 · 点击展开 ⋯`}
                  </button>
                </foreignObject>
              );
            }

            const { step, y, h, condChanged, inputChanged, outputChanged } = row;
            const toX = colX.get(step.to_key) ?? (leftPad + partW / 2);
            const fromX = step.from_key ? (colX.get(step.from_key) ?? toX) : Math.max(12, toX - 88);
            const isSelf = step.from_key !== null && step.from_key === step.to_key;
            const arrowY = y + h - 13;
            const stroke =
              step.status === 'added' ? 'var(--accent)'
                : step.status === 'removed' ? 'var(--danger)'
                  : step.status === 'modified' ? 'var(--amber)'
                    : step.kind === 'dispatch' || step.kind === 'callback' ? 'var(--blue)' : '#6e8379';
            const dash =
              step.status === 'removed' || step.kind === 'return' ? '5 3'
                : step.kind === 'dispatch' || step.kind === 'callback' ? '6 3' : undefined;

            const arrowPath = isSelf
              ? `M${toX} ${arrowY - 11} h38 v15 h-33`
              : `M${fromX} ${arrowY} H${toX + (toX >= fromX ? -5 : 5)}`;

            const idx = viewFilter === 'before'
              ? (step.before_index ?? 0) + 1
              : (step.after_index ?? step.before_index ?? 0) + 1;
            const prefix =
              step.status === 'added' ? '+'
                : step.status === 'removed' ? '−'
                  : step.status === 'modified' ? '~' : '';
            const text = viewFilter === 'before' ? (step.before_text ?? step.after_text) : (step.after_text ?? step.before_text);
            const pillH = (condChanged || inputChanged || outputChanged) ? 48 : 32;
            const spanW = isSelf ? 228 : Math.max(220, Math.abs(toX - fromX) - 14);
            const pillW = Math.min(spanW, width - 28);
            const rawLeft = isSelf ? toX + 12 : (fromX + toX) / 2 - pillW / 2;
            const pillX = Math.max(14, Math.min(width - pillW - 14, rawLeft));
            const pillY = Math.max(y + 4, arrowY - pillH - 5);
            const selected = selectedTarget?.kind === 'step' && selectedTarget.step.id === step.id;

            return (
              <g key={step.id}>
                <path
                  d={arrowPath}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={step.status === 'added' || step.status === 'modified' ? 2 : 1.5}
                  strokeDasharray={dash}
                  markerEnd={`url(#${markerId})`}
                />
                <foreignObject x={pillX} y={pillY} width={pillW} height={pillH}>
                  <button
                    type="button"
                    className={`hud-seq-pill status-${step.status}`}
                    aria-pressed={selected}
                    onClick={() => onSelectStep(step)}
                    title={`${step.from_symbol ? shortSymbol(step.from_symbol) + ' → ' : ''}${shortSymbol(step.to_symbol)}\n${text ?? ''}`}
                  >
                    <div className="hud-seq-pill-main">
                      <span className="hud-seq-num">{prefix}{String(idx).padStart(2, '0')}</span>
                      <span className="hud-seq-text">{text || shortSymbol(step.to_symbol)}</span>
                      <span className="hud-seq-kind">{stepKindLabels[step.kind]}</span>
                    </div>
                    {(condChanged || inputChanged || outputChanged) && (
                      <div className="hud-seq-delta">
                        {condChanged && (
                          <span>条件：<del>{step.before_condition || '无'}</del> → <ins>{step.after_condition || '无'}</ins></span>
                        )}
                        {inputChanged && (
                          <span>入参：<del>{step.before_input || '—'}</del> → <ins>{step.after_input || '—'}</ins></span>
                        )}
                        {outputChanged && (
                          <span>产出：<del>{step.before_output || '—'}</del> → <ins>{step.after_output || '—'}</ins></span>
                        )}
                      </div>
                    )}
                  </button>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="hud-diagram-legend">
        <span className="hud-legend-items">
          <span><i className="hud-dot ok" /> 新增步骤</span>
          <span><i className="hud-dot warn" /> 条件/参数变化</span>
          <span><i className="hud-dot danger" /> 已移除步骤</span>
          <span><i className="hud-dot info" /> 异步/回调（虚线）</span>
        </span>
        <span>{participants.length} 参与函数 · {visibleSteps.length} 时序步 · 点箭头或函数看源码 Diff</span>
      </div>
    </div>
  );
}

/* ==========================================================================
   3C. On-Demand Right-Hand Source Diff & Inline Ask Inspector
   ========================================================================== */
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
    if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
  });
  let start = Math.max(0, bestIdx - Math.floor(maxRows * 0.4));
  let end = Math.min(rows.length, start + maxRows);
  if (end - start < maxRows) start = Math.max(0, end - maxRows);
  return rows.slice(start, end);
}

function resolveAskBinding(diff: WalkthroughDiff, pathDiff: WalkthroughPathDiff, target: SelectedTarget) {
  if (target.kind === 'node') {
    if (target.node.after_node_id) {
      return { resultId: diff.after_result_id, target: { kind: 'node' as const, id: target.node.after_node_id }, askingBefore: false };
    }
    if (target.node.before_node_id) {
      return { resultId: diff.before_result_id, target: { kind: 'node' as const, id: target.node.before_node_id }, askingBefore: true };
    }
    return { resultId: diff.after_result_id, target: { kind: 'feature' as const, id: diff.feature_id }, askingBefore: false };
  }
  if (target.kind === 'edge') {
    const caller = pathDiff.participants.find(p => p.key === target.edge.from_key);
    if (target.edge.status === 'removed' && caller?.before_node_id) {
      return { resultId: diff.before_result_id, target: { kind: 'node' as const, id: caller.before_node_id }, askingBefore: true };
    }
    if (caller?.after_node_id) {
      return { resultId: diff.after_result_id, target: { kind: 'node' as const, id: caller.after_node_id }, askingBefore: false };
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
  onClose,
  onTargetedContinue,
}: {
  task: EngineeringTask;
  diff: WalkthroughDiff;
  pathDiff: WalkthroughPathDiff;
  target: SelectedTarget;
  onClose: () => void;
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

  const callerNode = target.kind === 'edge' ? pathDiff.participants.find(p => p.key === target.edge.from_key) : undefined;
  const calleeNode = target.kind === 'edge' ? pathDiff.participants.find(p => p.key === target.edge.to_key) : undefined;

  const file =
    target.kind === 'node' ? target.node.file
      : target.kind === 'edge' ? (callerNode?.file ?? calleeNode?.file ?? null)
        : (target.step.after_evidence?.path ?? target.step.before_evidence?.path ?? null);

  const focusLine =
    target.kind === 'node' ? (target.node.after_line ?? target.node.before_line ?? 1)
      : target.kind === 'edge' ? (callerNode?.after_line ?? callerNode?.before_line ?? 1)
        : (target.step.after_evidence?.line_start ?? target.step.before_evidence?.line_start ?? 1);

  const symbolLabel =
    target.kind === 'node' ? target.node.symbol
      : target.kind === 'edge' ? `${shortSymbol(target.edge.from_key)} → ${shortSymbol(target.edge.to_key)}`
        : `${target.step.from_symbol ? shortSymbol(target.step.from_symbol) + ' → ' : ''}${shortSymbol(target.step.to_symbol)}`;

  const targetStatus =
    target.kind === 'node' ? target.node.status
      : target.kind === 'edge' ? target.edge.status : target.step.status;

  useEffect(() => {
    askSeq.current++;
    setSourceLines(null);
    setSourceError('');
    setAsking(false);
    setAskedId(null);
    setAnswer(null);
    setAskError('');
    if (!file) return;
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
            ? { type: 'gap' as const, text: `… 已折叠 ${item.hidden} 行 …` }
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

  useEffect(() => {
    if (!askedId) return;
    let alive = true;
    let done = false;
    let off: () => void = () => {};
    const finish = () => { if (done) return; done = true; off(); };
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
    off = arc().onEvent(e => { if (e.type === 'changed') void poll(); });
    void poll();
    return () => { alive = false; finish(); };
  }, [askedId]);

  async function sendAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || asking) return;
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

  return (
    <aside className="hud-inspector" aria-label="变更详情">
      <div className="hud-inspector-head">
        <strong>{symbolLabel}</strong>
        <div className="hud-inspector-head-right">
          <span className={`hud-pill ${
            targetStatus === 'added' ? 'tone-ok'
              : targetStatus === 'removed' ? 'tone-danger'
                : targetStatus === 'modified' ? 'tone-warn' : ''
          }`}>
            {statusLabels[targetStatus]}
          </span>
          <button type="button" className="hud-drawer-close" aria-label="关闭源码面板" onClick={onClose}>✕</button>
        </div>
      </div>

      {file && <div className="hud-inspector-loc">{file}{focusLine > 1 ? `:${focusLine}` : ''}</div>}

      {target.kind === 'edge' && (
        <div className={`hud-struct-row ${target.edge.status === 'added' ? 'is-add' : target.edge.status === 'removed' ? 'is-del' : 'is-mod'}`}>
          <span>
            {callerNode?.file && calleeNode?.file && callerNode.file !== calleeNode.file ? '跨文件' : '同文件'}
            {' · '}
            {target.edge.kind === 'execution_boundary' ? '异步派发边界' : '同步调用'}
            {target.edge.ast_confirmed ? ' · AST 已证实' : ''}
          </span>
          <small>{target.edge.after_label || target.edge.before_label || '调用关系'}</small>
        </div>
      )}

      {target.kind === 'node' && target.node.before_signature && target.node.after_signature &&
        target.node.before_signature !== target.node.after_signature && (
        <div className="hud-struct-row is-mod">
          <small>签名变化</small>
          <span style={{ textDecoration: 'line-through', color: 'var(--danger)' }}>{target.node.before_signature}</span>
          <span style={{ color: 'var(--accent-hover)' }}>{target.node.after_signature}</span>
        </div>
      )}

      {loadingSource ? (
        <small className="muted">读取源码对比…</small>
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
        <small className="muted">未关联源码文件。</small>
      )}

      <div className="hud-inline-ask">
        <form onSubmit={e => void sendAsk(e)}>
          <input
            type="text"
            placeholder="对这处变化原位追问…"
            value={question}
            disabled={asking}
            onChange={e => setQuestion(e.target.value)}
          />
          <button type="submit" className="hud-mini-btn" disabled={asking || !question.trim()}>
            {asking ? '思考中…' : '追问'}
          </button>
        </form>
        {askError && <small className="warning">{askError}</small>}
        {asking && !answer && <small className="muted">等待原位回答…</small>}
        {answer && <div className="hud-inline-ask-reply">{answer}</div>}
        <div className="hud-inspector-foot">
          <span>绑定{askBinding.askingBefore ? '改前' : '改后'}走读</span>
          {onTargetedContinue && (
            <button
              type="button"
              className="quiet"
              style={{ padding: 0, minHeight: 22, fontSize: 11.5 }}
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

function StructureDiffDrawer({ diff, onClose }: { diff: TaskHudStructureDiff; onClose: () => void }) {
  const brokenCallers = [
    ...diff.signature_changed_symbols,
    ...diff.removed_symbols,
  ].flatMap(s => (s.unupdated_external_callers ?? []).map(c => ({ symbol: s.symbol, caller: c })));

  return (
    <div className={`hud-drawer${brokenCallers.length || diff.new_cycles.length ? ' tone-danger' : ''}`}>
      <div className="hud-drawer-head">
        <strong>本地 AST 符号结构 Diff 与契约守卫</strong>
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
                  {s.added_dirs.length ? `新增：${s.added_dirs.join('、')}` : ''}
                  {s.removed_dirs.length ? ` 移除：${s.removed_dirs.join('、')}` : ''}
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
  const [viewMode, setViewMode] = useState<'chain' | 'time'>('chain');
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

  // Reset inspector when switching task, feature, or path so diagrams open cleanly at full width
  useEffect(() => {
    setSelectedTarget(null);
  }, [task.task_id, activeDiff?.after_result_id, activePath?.path_key]);

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
    ? { tone: 'tone-warn', dot: 'warn', label: '归属待核查' }
    : !struct
      ? { tone: '', dot: '', label: `${task.changes.length} 文件` }
      : !struct.scope_declared
        ? { tone: 'tone-info', dot: 'info', label: `范围未限定 · ${task.changes.length} 文件` }
        : outOfScopeCount > 0
          ? { tone: 'tone-warn', dot: 'warn', label: `越界 ${outOfScopeCount} 文件` }
          : { tone: task.changes.length ? 'tone-ok' : '', dot: task.changes.length ? 'ok' : '', label: `范围内 · ${task.changes.length} 文件` };

  const contractBadge = contractBroken
    ? {
        tone: 'tone-danger',
        dot: 'danger',
        label: `契约预警 · ${firstBroken ? shortSymbol(firstBroken.symbol) + ' 等 ' : ''}${unupdatedCallers} 处未同步`,
      }
    : publicApiChanges > 0
      ? { tone: 'tone-warn', dot: 'warn', label: `公开接口变动 ${publicApiChanges}（无未同步调用）` }
      : { tone: 'tone-ok', dot: 'ok', label: '接口兼容' };

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

  return (
    <section className="hud-after" aria-label="交付 HUD 总览">
      {/* Single Clean Verdict Bar (Click contract/AST pill to expand details) */}
      <div className="hud-verdict-card">
        <div className="hud-verdict-strip">
          <div className="hud-verdict-left">
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
                  AST +{struct.added_symbols.length}/−{struct.removed_symbols.length}/~{struct.signature_changed_symbols.length}
                  {struct.added_calls.length ? ` · +${struct.added_calls.length} 调用` : ''}
                  {cycleCount ? ` · +${cycleCount} 环` : ''}
                </span>
              </button>
            )}
          </div>

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
              <span>架构叠加 ↗</span>
            </button>
          )}
        </div>

        {showStruct && struct && <StructureDiffDrawer diff={struct} onClose={() => setShowStruct(false)} />}
      </div>

      {/* Unified Function Call Chain & Lifeline Sequence Diff Card */}
      {(diffs.length > 0 || features.length > 0) && (
        <div className="hud-walkthrough">
          <div className="hud-walkthrough-toolbar">
            <div className="hud-toolbar-left">
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
                      onClick={() => { setSelectedFeatureId(f.scenario_id); setSelectedPathKey(''); }}
                    >
                      <i className="hud-dot ok" />
                      <span>{f.label}</span>
                    </button>
                  );
                }
                if (!f.has_call_graph && f.refreshed_result_id) {
                  return (
                    <span key={f.scenario_id} className="hud-pill" title="开发前无调用链基线，已存改后走读">
                      <i className="hud-dot" />
                      <span>{f.label} · 无改前基线</span>
                    </span>
                  );
                }
                const actionText = !f.has_call_graph
                  ? (busyFeature ? '生成中…' : f.error ? '重试' : '补建走读')
                  : (busyFeature ? '刷新中…' : f.error ? '重试' : '刷新对比');
                return (
                  <button
                    key={f.scenario_id}
                    type="button"
                    className="hud-pill"
                    disabled={busyFeature || !task.end_state}
                    onClick={() => void refreshFeature(f.scenario_id)}
                    title={f.error || (f.has_call_graph ? '刷新走读生成前后对比' : '补建改后走读')}
                  >
                    <i className={`hud-dot ${busyFeature ? 'pulse' : f.error ? 'danger' : 'info'}`} />
                    <span>{f.label} · {actionText}</span>
                  </button>
                );
              })}

              {activeDiff && (
                <div className="hud-segmented" role="group" aria-label="对比视图类型">
                  <button type="button" aria-pressed={viewMode === 'chain'} onClick={() => setViewMode('chain')}>
                    函数调用链
                  </button>
                  <button type="button" aria-pressed={viewMode === 'time'} onClick={() => setViewMode('time')}>
                    调用时间图
                  </button>
                </div>
              )}

              {activeDiff && activeDiff.paths.length > 1 && activePath && (
                <select
                  className="hud-path-select"
                  aria-label="选择入口路径"
                  value={activePath.path_key}
                  onChange={e => setSelectedPathKey(e.target.value)}
                >
                  {activeDiff.paths.map(p => (
                    <option key={p.path_key} value={p.path_key}>
                      {p.label} ({p.counts.added_steps + p.counts.removed_steps + p.counts.modified_steps} 变化)
                    </option>
                  ))}
                </select>
              )}
            </div>

            {activeDiff && activePath && (
              <div className="hud-toolbar-right">
                <div className="hud-segmented" role="group" aria-label="对比版本切换">
                  <button type="button" aria-pressed={viewFilter === 'diff'} onClick={() => setViewFilter('diff')}>对比</button>
                  <button type="button" aria-pressed={viewFilter === 'before'} onClick={() => setViewFilter('before')}>改前</button>
                  <button type="button" aria-pressed={viewFilter === 'after'} onClick={() => setViewFilter('after')}>改后</button>
                </div>

                <label className="hud-noise-toggle">
                  <input type="checkbox" checked={hideNoise} onChange={e => setHideNoise(e.target.checked)} />
                  <span>仅实改{activePath.counts.noise_count > 0 ? ` (-${activePath.counts.noise_count})` : ''}</span>
                </label>

                {selectedTarget && (
                  <button type="button" className="hud-mini-btn" onClick={() => setSelectedTarget(null)}>
                    全宽图
                  </button>
                )}
              </div>
            )}
          </div>

          {refreshError && <small className="warning">{refreshError}</small>}

          {activeDiff && activePath ? (
            <div className={`hud-stage${selectedTarget ? ' has-inspector' : ''}`}>
              {viewMode === 'chain' ? (
                <CallChainDiffGraph
                  pathDiff={activePath}
                  viewFilter={viewFilter}
                  hideNoise={hideNoise}
                  selectedTarget={selectedTarget}
                  onSelectNode={node => setSelectedTarget(prev =>
                    prev?.kind === 'node' && prev.node.key === node.key ? null : { kind: 'node', node },
                  )}
                  onSelectEdge={edge => setSelectedTarget(prev =>
                    prev?.kind === 'edge' && prev.edge.key === edge.key ? null : { kind: 'edge', edge },
                  )}
                />
              ) : (
                <TimelineSequenceDiff
                  pathDiff={activePath}
                  viewFilter={viewFilter}
                  hideNoise={hideNoise}
                  selectedTarget={selectedTarget}
                  onSelectStep={step => setSelectedTarget(prev =>
                    prev?.kind === 'step' && prev.step.id === step.id ? null : { kind: 'step', step },
                  )}
                  onSelectNode={node => setSelectedTarget(prev =>
                    prev?.kind === 'node' && prev.node.key === node.key ? null : { kind: 'node', node },
                  )}
                />
              )}

              {selectedTarget && (
                <WalkthroughInspector
                  task={task}
                  diff={activeDiff}
                  pathDiff={activePath}
                  target={selectedTarget}
                  onClose={() => setSelectedTarget(null)}
                  onTargetedContinue={onTargetedContinue}
                />
              )}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {features.some(f => f.has_call_graph)
                ? '点击上方功能的「刷新对比」生成调用链与时间图对比。'
                : '上述功能开发前尚无调用链基线，可点击补建走读供后续对比。'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
