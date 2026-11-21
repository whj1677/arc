import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SourceEditor } from '../shared';
import type { WalkthroughPathDiff } from '../development-hud';
import type { LiveFileDiff, LiveWorkspaceRadar, RadarMode } from '../live-radar';
import {
  CallChainDiffGraph,
  StructureDiffDrawer,
  isRiskLabel,
  shortFile,
  shortSymbol,
  sliceAroundLine,
  statusLabels,
  type SelectedTarget,
  type TaskArchitectureOverlay,
} from './DevelopmentHud';
import { TextDiffView } from './TextDiffView';
import { collapseUnifiedContext, computeLineDiff } from './text-diff';
import './live-radar.css';

const arc = () => window.arc;

function formatAiContextBrief(radar: LiveWorkspaceRadar): string {
  const lines: string[] = [];
  const label = radar.mode === 'worktree'
    ? `当前工作区未提交改动（基于 ${radar.branch || 'HEAD'}）`
    : `提交 ${radar.target_ref.slice(0, 8)} 变更`;
  lines.push(`# ARC 实时变更上下文 · ${label}`);
  lines.push('');
  lines.push(`## 改动文件 (${radar.changed_files.length})`);
  for (const f of radar.changed_files.slice(0, 30)) {
    const tag = f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M';
    lines.push(`- [${tag}] \`${f.path}\``);
  }
  const struct = radar.structure_diff;
  if (struct) {
    const broken = [...struct.signature_changed_symbols, ...struct.removed_symbols]
      .flatMap(s => (s.unupdated_external_callers ?? []).map(c => ({ symbol: s, caller: c })));
    if (broken.length > 0) {
      lines.push('');
      lines.push(`## 契约未同步风险 (${broken.length} 处范围外调用)`);
      for (const { symbol, caller } of broken.slice(0, 20)) {
        const sig = symbol.before_signature && symbol.after_signature
          ? `（签名：\`${symbol.before_signature}\` → \`${symbol.after_signature}\`）`
          : '（符号已移除）';
        lines.push(`- \`${caller.caller_file}:${caller.caller_line}\` (\`${caller.caller_symbol}\`) 调用 \`${symbol.symbol}\`${sig}`);
      }
    }
    const symSummary = [
      struct.added_symbols.length ? `+${struct.added_symbols.length} 新增` : '',
      struct.removed_symbols.length ? `−${struct.removed_symbols.length} 移除` : '',
      struct.signature_changed_symbols.length ? `~${struct.signature_changed_symbols.length} 改签名` : '',
    ].filter(Boolean).join(' / ');
    if (symSummary) {
      lines.push('');
      lines.push(`## 本地 AST 结构变化：${symSummary}`);
    }
    if (struct.new_cycles.length > 0) {
      lines.push(`- 新增模块循环依赖：${struct.new_cycles.map(c => c.join(' → ')).join('；')}`);
    }
  }
  if (radar.impact.architecture_nodes.length > 0) {
    const direct = radar.impact.architecture_nodes.filter(n => n.relation === 'direct').map(n => n.label);
    const neighbor = radar.impact.architecture_nodes.filter(n => n.relation === 'neighbor').map(n => n.label);
    lines.push('');
    lines.push(`## 涉及架构模块`);
    if (direct.length) lines.push(`- 直接改动：${direct.join('、')}`);
    if (neighbor.length) lines.push(`- 邻接波及：${neighbor.join('、')}`);
  }
  if (radar.impact.related_constraints.length > 0) {
    lines.push('');
    lines.push(`## 关联工程约束`);
    for (const c of radar.impact.related_constraints.slice(0, 6)) {
      lines.push(`- **${c.key}**：${c.excerpt}`);
    }
  }
  return lines.join('\n');
}

function LiveDiffInspector({
  projectId,
  radar,
  pathDiff,
  target,
  onClose,
  onOpenFullDiff,
  onRefreshRadar,
}: {
  projectId: string;
  radar: LiveWorkspaceRadar;
  pathDiff: WalkthroughPathDiff;
  target: SelectedTarget;
  onClose: () => void;
  onOpenFullDiff: (file: string) => void;
  onRefreshRadar: () => void;
}) {
  const [diffData, setDiffData] = useState<LiveFileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openError, setOpenError] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const codeRef = useRef<HTMLPreElement | null>(null);

  const nodeMap = useMemo(() => new Map(pathDiff.participants.map(n => [n.key, n])), [pathDiff.participants]);
  const callerNode = target.kind === 'edge' ? nodeMap.get(target.edge.from_key) : undefined;
  const calleeNode = target.kind === 'edge' ? nodeMap.get(target.edge.to_key) : undefined;
  const activeNode = target.kind === 'node' ? target.node : callerNode ?? calleeNode;

  const file = activeNode?.file ?? null;
  const focusLine = activeNode?.after_line ?? activeNode?.before_line ?? 1;
  const isRiskEdge = target.kind === 'edge' && isRiskLabel(target.edge.after_label || target.edge.before_label);
  const sigNode = target.kind === 'node' ? target.node : isRiskEdge ? calleeNode : undefined;
  const status = target.kind === 'node' ? target.node.status : target.kind === 'edge' ? target.edge.status : target.step.status;
  const heading = target.kind === 'node'
    ? shortSymbol(target.node.symbol)
    : target.kind === 'edge'
      ? `${shortSymbol(target.edge.from_key)} → ${shortSymbol(target.edge.to_key)}`
      : shortSymbol(target.step.to_symbol);

  useEffect(() => {
    setOpenError('');
    setCopyState('idle');
    if (!file) {
      setDiffData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    arc().invoke<LiveFileDiff>('workspace_live_diff', {
      project_id: projectId,
      base_ref: radar.base_ref,
      target_ref: radar.target_ref,
      path: file,
      fingerprint: radar.fingerprint,
    }).then(data => {
      if (alive) setDiffData(data);
    }).catch((err: Error) => {
      if (alive) {
        setDiffData(null);
        setError(err.message);
      }
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [projectId, radar.base_ref, radar.target_ref, radar.fingerprint, file]);

  const diffRows = useMemo(() => {
    if (!diffData || diffData.binary) return null;
    if (!diffData.before && !diffData.after) return [];
    const computed = computeLineDiff(diffData.before, diffData.after);
    const hasChanges = computed.stats.added > 0 || computed.stats.removed > 0;
    const raw = hasChanges ? collapseUnifiedContext(computed.lines, 3) : computed.lines;
    const mapped = raw.map(item =>
      'hidden' in item
        ? { type: 'gap' as const, text: `… 已折叠 ${item.hidden} 行 …` }
        : { type: item.type, oldLine: item.oldLine, newLine: item.newLine, text: item.text },
    );
    return sliceAroundLine(mapped, focusLine, hasChanges ? 40 : 18);
  }, [diffData, focusLine]);

  // Center the highlighted focus line in the inspector viewport once loaded
  useEffect(() => {
    const pre = codeRef.current;
    if (!pre || !diffRows?.length) return;
    const focusEl = pre.querySelector<HTMLElement>('.hud-diff-line.is-focus');
    if (focusEl) {
      pre.scrollTop = Math.max(0, focusEl.offsetTop - pre.clientHeight / 2 + focusEl.clientHeight / 2);
    }
  }, [diffRows, focusLine]);

  async function openInEditor(editor: SourceEditor) {
    if (!file) return;
    setOpenError('');
    try {
      await arc().invoke('workspace_open_file', {
        project_id: projectId,
        path: file,
        line: focusLine,
        editor,
      });
    } catch (e) {
      setOpenError((e as Error).message);
    }
  }

  async function copyFixPrompt() {
    const promptLines: string[] = [];
    if (isRiskEdge && sigNode) {
      promptLines.push(`请检查并同步未更新的调用点：\`${file}:${focusLine}\`（\`${callerNode?.symbol ?? heading}\`）`);
      if (sigNode.before_signature && sigNode.after_signature) {
        promptLines.push(`被调函数 \`${sigNode.symbol}\`（\`${sigNode.file}\`）签名已变更：`);
        promptLines.push(`- 改前：\`${sigNode.before_signature}\``);
        promptLines.push(`- 改后：\`${sigNode.after_signature}\``);
      } else {
        promptLines.push(`被调函数 \`${sigNode.symbol}\` 已变更或移除，请核对该调用点是否仍兼容。`);
      }
    } else {
      promptLines.push(`请检查并调整 \`${file}:${focusLine}\`（\`${heading}\`）处的当前改动。`);
    }
    try {
      await navigator.clipboard.writeText(promptLines.join('\n'));
      setCopyState('ok');
      setTimeout(() => setCopyState('idle'), 1800);
    } catch {
      setCopyState('fail');
      setTimeout(() => setCopyState('idle'), 2600);
    }
  }

  return (
    <aside className="hud-inspector radar-inspector" aria-label="实时变更详情">
      <div className="hud-inspector-head">
        <strong>{heading}</strong>
        <div className="hud-inspector-head-right">
          <span className={`hud-pill ${
            isRiskEdge ? 'tone-danger'
              : status === 'added' ? 'tone-ok'
                : status === 'removed' ? 'tone-danger'
                  : status === 'modified' ? 'tone-warn' : ''
          }`}>
            {isRiskEdge ? (target.kind === 'edge' && !target.edge.ast_confirmed ? '待核查' : '未同步') : statusLabels[status]}
          </span>
          <button type="button" className="hud-drawer-close" aria-label="关闭源码面板" onClick={onClose}>✕</button>
        </div>
      </div>

      {file && (
        <div className="radar-inspector-loc-row">
          <span className="hud-inspector-loc" title={file}>{file}:{focusLine}</span>
          {radar.mode === 'worktree' && (
            <span className="radar-editor-btns">
              <button type="button" className="hud-mini-btn" onClick={() => void openInEditor('vscode')}>VS Code</button>
              <button type="button" className="hud-mini-btn" onClick={() => void openInEditor('default')}>打开</button>
            </span>
          )}
        </div>
      )}
      {openError && <small className="warning">{openError}</small>}

      {target.kind === 'edge' && (
        <div className={`hud-struct-row ${target.edge.status === 'added' ? 'is-add' : target.edge.status === 'removed' || isRiskEdge ? 'is-del' : 'is-mod'}`}>
          <span>
            {callerNode?.file && calleeNode?.file && callerNode.file !== calleeNode.file ? '跨文件' : '同文件'}
            {' · '}
            {target.edge.kind === 'execution_boundary' ? '异步边界' : target.edge.kind === 'reference' ? '回调引用' : '同步调用'}
            {target.edge.ast_confirmed ? ' · AST 已证实' : ' · 候选待核查'}
          </span>
          <small>{target.edge.after_label || target.edge.before_label || '调用关系'}</small>
        </div>
      )}

      {sigNode && sigNode.before_signature && sigNode.after_signature &&
        sigNode.before_signature !== sigNode.after_signature && (
        <div className="hud-struct-row is-mod">
          <small>{isRiskEdge ? `被调方 ${shortSymbol(sigNode.symbol)} 签名变化` : '签名变化'}</small>
          <span style={{ textDecoration: 'line-through', color: 'var(--danger)' }}>{sigNode.before_signature}</span>
          <span style={{ color: 'var(--accent-hover)' }}>{sigNode.after_signature}</span>
        </div>
      )}

      {loading ? (
        <small className="muted">读取实时源码对比…</small>
      ) : error ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <small className="warning">{error}</small>
          {error.includes('刷新') && (
            <button type="button" className="hud-mini-btn" onClick={onRefreshRadar}>立即刷新雷达</button>
          )}
        </div>
      ) : diffData?.binary ? (
        <small className="muted">二进制文件，暂不展示文本 Diff。</small>
      ) : diffRows && diffRows.length > 0 ? (
        <pre ref={codeRef} className="hud-inspector-diff radar-inspector-code">
          {diffRows.map((l, i) => {
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
        <small className="muted">未关联文本改动。</small>
      )}

      <div className="radar-inspector-actions">
        <button type="button" className="hud-mini-btn" onClick={() => void copyFixPrompt()}>
          {copyState === 'ok'
            ? '✓ 已复制提示'
            : copyState === 'fail'
              ? '复制失败，点击重试'
              : isRiskEdge ? '复制同步修复提示给 AI' : '复制位置给 AI'}
        </button>
        {file && (
          <button type="button" className="hud-drawer-close" onClick={() => onOpenFullDiff(file)}>
            整文件 Diff →
          </button>
        )}
      </div>
    </aside>
  );
}

export function LiveRadarView({
  project,
  onOpenArchitectureOverlay,
}: {
  project: Project;
  onOpenArchitectureOverlay: (overlay: TaskArchitectureOverlay) => void;
}) {
  const [mode, setMode] = useState<RadarMode>('worktree');
  const [selectedCommit, setSelectedCommit] = useState('');
  const [focusFile, setFocusFile] = useState('');
  const [sourceOnly, setSourceOnly] = useState(true);
  const [radar, setRadar] = useState<LiveWorkspaceRadar | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'graph' | 'files'>('graph');
  const [viewFilter, setViewFilter] = useState<'diff' | 'before' | 'after'>('diff');
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget | null>(null);
  const [openDrawer, setOpenDrawer] = useState<'struct' | 'features' | 'constraints' | null>(null);
  const [selectedFile, setSelectedFile] = useState('');
  const [fileDiff, setFileDiff] = useState<LiveFileDiff | null>(null);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [fileDiffError, setFileDiffError] = useState('');
  const [briefCopyState, setBriefCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const seqRef = useRef(0);
  const fingerprintRef = useRef('');

  const loadRadar = useCallback(async (opts?: { nextMode?: RadarMode; nextCommit?: string; nextFocusFile?: string; force?: boolean }) => {
    const reqMode = opts?.nextMode ?? mode;
    const reqCommit = opts?.nextCommit !== undefined ? opts.nextCommit : selectedCommit;
    const reqFocus = opts?.nextFocusFile !== undefined ? opts.nextFocusFile : focusFile;
    const mine = ++seqRef.current;
    setLoading(true);
    setError('');
    try {
      const value = await arc().invoke<LiveWorkspaceRadar>('workspace_live_radar', {
        project_id: project.project_id,
        mode: reqMode,
        ...(reqMode === 'commit' && reqCommit ? { commit: reqCommit } : {}),
        ...(reqFocus ? { focus_file: reqFocus } : {}),
        ...(!opts?.force && fingerprintRef.current ? { previous_fingerprint: fingerprintRef.current } : {}),
      });
      if (mine !== seqRef.current) return;
      const changed = value.fingerprint !== fingerprintRef.current;
      fingerprintRef.current = value.fingerprint;
      setRadar(value);
      if (reqFocus && !value.changed_files.some(f => f.path === reqFocus)) {
        setFocusFile('');
      }
      if (reqMode === 'commit' && !reqCommit && value.recent_commits[0]) {
        setSelectedCommit(value.recent_commits[0].sha);
      }
      if (changed) {
        setSelectedTarget(null);
        if (value.ast_call_graph) {
          setActiveTab('graph');
        } else if (!reqFocus) {
          setActiveTab('files');
        }
        const preferred = value.changed_files.find(f => f.is_source) ?? value.changed_files[0];
        setSelectedFile(prev => (value.changed_files.some(f => f.path === prev) ? prev : preferred?.path ?? ''));
      }
    } catch (e) {
      if (mine === seqRef.current) setError((e as Error).message);
    } finally {
      if (mine === seqRef.current) setLoading(false);
    }
  }, [project.project_id, mode, selectedCommit, focusFile]);

  useEffect(() => {
    fingerprintRef.current = '';
    setMode('worktree');
    setFocusFile('');
    setSourceOnly(true);
    setRadar(null);
    setSelectedCommit('');
    setSelectedTarget(null);
    setOpenDrawer(null);
    setSelectedFile('');
    void loadRadar({ nextMode: 'worktree', nextCommit: '', nextFocusFile: '', force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.project_id]);

  // Auto-refresh seamlessly when user Alt-Tabs back from VS Code / Codex / Antigravity!
  useEffect(() => {
    const off = arc().onEvent(event => {
      if (event.type === 'window_focus' && mode === 'worktree') {
        void loadRadar();
      }
    });
    return off;
  }, [loadRadar, mode]);

  // Load selected file diff when in 'files' tab
  const radarBaseRef = radar?.base_ref;
  const radarTargetRef = radar?.target_ref;
  const radarFingerprint = radar?.fingerprint;
  useEffect(() => {
    if (activeTab !== 'files' || !radarBaseRef || !radarTargetRef || !selectedFile) {
      setFileDiff(null);
      return;
    }
    let alive = true;
    setFileDiffLoading(true);
    setFileDiffError('');
    arc().invoke<LiveFileDiff>('workspace_live_diff', {
      project_id: project.project_id,
      base_ref: radarBaseRef,
      target_ref: radarTargetRef,
      path: selectedFile,
      fingerprint: radarFingerprint,
    }).then(data => {
      if (alive) setFileDiff(data);
    }).catch((e: Error) => {
      if (alive) {
        setFileDiff(null);
        setFileDiffError(e.message);
      }
    }).finally(() => {
      if (alive) setFileDiffLoading(false);
    });
    return () => { alive = false; };
  }, [activeTab, project.project_id, radarBaseRef, radarTargetRef, radarFingerprint, selectedFile]);

  const radarMatchesSelection = !!radar && radar.mode === mode &&
    (mode !== 'commit' || !selectedCommit || radar.target_ref === selectedCommit);
  const activeRadar = radarMatchesSelection ? radar : null;

  const struct = activeRadar?.structure_diff;
  const astGraph = activeRadar?.ast_call_graph;
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
  const cycleCount = struct?.new_cycles.length ?? 0;
  const firstBroken = struct
    ? [...struct.signature_changed_symbols, ...struct.removed_symbols].find(s => (s.unupdated_external_callers?.length ?? 0) > 0)
    : undefined;
  const hasArchNodes = (activeRadar?.impact.architecture_nodes.length ?? 0) > 0;
  const features = activeRadar?.impact.impacted_features ?? [];
  const constraints = activeRadar?.impact.related_constraints ?? [];

  const contractBadge = unupdatedCallers > 0
    ? {
        tone: 'tone-danger',
        dot: 'danger',
        label: `契约 · ${firstBroken ? shortSymbol(firstBroken.symbol) + ' 等 ' : ''}${unupdatedCallers} 处未同步`,
      }
    : publicApiChanges > 0
      ? { tone: 'tone-warn', dot: 'warn', label: `接口变动 ${publicApiChanges}（未检出未同步调用）` }
      : { tone: 'tone-ok', dot: 'ok', label: '接口未变更' };

  async function copyContextForAi() {
    if (!activeRadar) return;
    try {
      await navigator.clipboard.writeText(formatAiContextBrief(activeRadar));
      setBriefCopyState('ok');
      setTimeout(() => setBriefCopyState('idle'), 1800);
    } catch {
      setBriefCopyState('fail');
      setTimeout(() => setBriefCopyState('idle'), 2600);
    }
  }

  const sourceFiles = useMemo(
    () => (activeRadar?.changed_files ?? []).filter(f => f.is_source),
    [activeRadar],
  );
  const focusLabels = useMemo(() => {
    const baseCounts = new Map<string, number>();
    for (const f of sourceFiles) {
      const base = shortFile(f.path);
      baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
    }
    const twoCounts = new Map<string, number>();
    for (const f of sourceFiles) {
      const parts = f.path.split('/');
      const two = parts.length >= 2 ? parts.slice(-2).join('/') : f.path;
      twoCounts.set(two, (twoCounts.get(two) ?? 0) + 1);
    }
    return new Map(sourceFiles.map(f => {
      const base = shortFile(f.path);
      if ((baseCounts.get(base) ?? 0) <= 1) return [f.path, base];
      const parts = f.path.split('/');
      const two = parts.length >= 2 ? parts.slice(-2).join('/') : f.path;
      if ((twoCounts.get(two) ?? 0) <= 1) return [f.path, two];
      return [f.path, parts.length >= 3 ? parts.slice(-3).join('/') : f.path];
    }));
  }, [sourceFiles]);
  const nonSourceCount = (activeRadar?.changed_files.length ?? 0) - sourceFiles.length;
  const hasMixedFiles = sourceFiles.length > 0 && nonSourceCount > 0;
  const visibleChangedFiles = useMemo(() => {
    const all = activeRadar?.changed_files ?? [];
    const sorted = [...all].sort((a, b) => Number(!!b.is_source) - Number(!!a.is_source) || a.path.localeCompare(b.path));
    return hasMixedFiles && sourceOnly ? sorted.filter(f => f.is_source) : sorted;
  }, [activeRadar, hasMixedFiles, sourceOnly]);

  function switchMode(next: RadarMode, commitSha = '') {
    setMode(next);
    setSelectedCommit(commitSha);
    setFocusFile('');
    fingerprintRef.current = '';
    setSelectedTarget(null);
    setOpenDrawer(null);
    void loadRadar({ nextMode: next, nextCommit: commitSha, nextFocusFile: '', force: true });
  }

  function selectFocusFile(nextFile: string) {
    setFocusFile(nextFile);
    setSelectedTarget(null);
    void loadRadar({ nextFocusFile: nextFile });
  }

  return (
    <main className="radar-workspace" aria-label="本机实时变更雷达">
      {/* Top Cockpit Bar */}
      <header className="radar-header">
        <div className="radar-header-left">
          <div className="radar-title-row">
            <i className={`hud-dot ${activeRadar?.changed_files.length ? 'pulse' : 'ok'}`} />
            <h2>变更雷达</h2>
            {radar?.branch && <span className="radar-branch-chip">{radar.branch}</span>}
            {radar?.git_subpath && (
              <span className="radar-speed-chip" title={`检测到嵌套 Git 仓库：${radar.git_subpath}`}>
                子仓库 · {radar.git_subpath}
              </span>
            )}
            {radar?.source === 'snapshot' && (
              <span className="radar-branch-chip" title="非 Git 目录：实时对比 ARC 基准快照与当前工作区">
                基准快照对比
              </span>
            )}
            {activeRadar && (
              <span className="radar-speed-chip" title="纯本地增量 AST 计算耗时（零 LLM 等待）">
                {activeRadar.computed_ms} ms{activeRadar.cache_hit ? ' · 缓存' : ' · 本地 AST'}
              </span>
            )}
          </div>
          <p className="radar-subtitle">
            在任意 IDE / Codex / Antigravity 改完代码切回这里，1 秒内看清调用链、未同步契约与架构波及。
          </p>
        </div>

        <div className="radar-header-controls">
          {radar?.source !== 'snapshot' && (
            <div className="hud-segmented" role="group" aria-label="对比范围">
              <button
                type="button"
                aria-pressed={mode === 'worktree'}
                onClick={() => switchMode('worktree')}
              >
                工作区未提交
              </button>
              <button
                type="button"
                aria-pressed={mode === 'commit'}
                disabled={!radar?.recent_commits.length}
                onClick={() => switchMode('commit', selectedCommit || radar?.recent_commits[0]?.sha || '')}
              >
                提交记录
              </button>
            </div>
          )}

          {mode === 'commit' && radar && radar.recent_commits.length > 0 && (
            <select
              className="radar-commit-select"
              aria-label="选择提交记录"
              value={selectedCommit || radar.recent_commits[0].sha}
              onChange={e => switchMode('commit', e.target.value)}
            >
              {radar.recent_commits.map(c => (
                <option key={c.sha} value={c.sha}>
                  {c.short_sha} · {c.subject.slice(0, 56)}
                </option>
              ))}
            </select>
          )}

          {activeRadar && activeRadar.changed_files.length > 0 && (
            <button type="button" className="radar-ai-copy-btn" onClick={() => void copyContextForAi()}>
              {briefCopyState === 'ok'
                ? '✓ 已复制给 AI'
                : briefCopyState === 'fail'
                  ? '复制失败，点击重试'
                  : '复制上下文给 AI'}
            </button>
          )}

          <button type="button" className="primary radar-refresh-btn" disabled={loading} onClick={() => void loadRadar({ force: true })}>
            {loading ? '扫描中…' : '刷新'}
          </button>
        </div>
      </header>

      {error && <p role="alert" className="warning radar-error">{error}</p>}

      {!activeRadar && loading ? (
        <section className="radar-empty-card">
          <strong>{radar ? '正在切换并对比本地变更…' : '正在建立本机增量 AST 索引…'}</strong>
          <p>首次扫描会缓存基准提交的语法树，之后每次切回窗口仅重析改动文件（约 100–300ms）。</p>
        </section>
      ) : activeRadar && !activeRadar.is_git && !activeRadar.snapshot_id ? (
        <section className="radar-empty-card">
          <strong>当前目录尚未初始化 Git 仓库且尚无基准快照</strong>
          <p>请先在「工程全貌」刷新一次源码快照，或在工程内初始化 Git 仓库即可启用毫秒级调用链与影响雷达。</p>
        </section>
      ) : activeRadar && activeRadar.changed_files.length === 0 ? (
        <section className="radar-empty-card">
          <div className="radar-empty-icon" aria-hidden="true">✓</div>
          {activeRadar.mode === 'commit' ? (
            <>
              <strong>
                所选提交（{activeRadar.target_ref === 'EMPTY' ? '无提交' : activeRadar.target_ref.slice(0, 7)}）在当前工程范围内无可展示的源码变更
              </strong>
              <p>该提交可能为空提交，或仅修改了被排除/忽略的文件；并未改变当前工作区的未提交状态。</p>
              <div className="radar-empty-actions">
                <button type="button" className="primary" onClick={() => switchMode('worktree')}>
                  返回工作区未提交
                </button>
              </div>
            </>
          ) : (
            <>
              <strong>
                {activeRadar.source === 'snapshot'
                  ? '当前工作区与 ARC 基准快照一致'
                  : `当前工作区干净（与 ${activeRadar.branch || 'HEAD'} 一致）`}
              </strong>
              <p>在 VS Code / Codex / Antigravity 任意修改代码后切回 ARC，这里会自动亮起调用链变化与未同步契约预警。</p>
              {activeRadar.recent_commits[0] && (
                <div className="radar-empty-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => switchMode('commit', activeRadar.recent_commits[0].sha)}
                  >
                    查看最近提交：{activeRadar.recent_commits[0].short_sha} · {activeRadar.recent_commits[0].subject.slice(0, 40)}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      ) : activeRadar ? (
        <div className="radar-content">
          {/* Single-Line Cockpit Verdict Strip */}
          <div className="hud-verdict-card">
            <div className="hud-verdict-strip">
              <div className="hud-verdict-left">
                <span className="hud-strip-label">实时 HUD</span>

                <span className="hud-pill tone-info">
                  <i className="hud-dot info" />
                  <span>{activeRadar.changed_files.length} 文件变更</span>
                </span>

                {struct && (
                  <button
                    type="button"
                    className={`hud-pill ${contractBadge.tone}`}
                    aria-expanded={openDrawer === 'struct'}
                    onClick={() => setOpenDrawer(prev => (prev === 'struct' ? null : 'struct'))}
                  >
                    <i className={`hud-dot ${contractBadge.dot}`} />
                    <span>{contractBadge.label}</span>
                  </button>
                )}

                {struct && (
                  <button
                    type="button"
                    className={`hud-pill ${cycleCount ? 'tone-danger' : symbolDeltaTotal ? 'tone-info' : ''}`}
                    aria-expanded={openDrawer === 'struct'}
                    onClick={() => setOpenDrawer(prev => (prev === 'struct' ? null : 'struct'))}
                  >
                    <i className={`hud-dot ${cycleCount ? 'danger' : symbolDeltaTotal ? 'info' : 'ok'}`} />
                    <span>
                      AST +{struct.added_symbols.length}/−{struct.removed_symbols.length}/~{struct.signature_changed_symbols.length}
                      {struct.added_calls.length ? ` · +${struct.added_calls.length} 调用` : ''}
                      {cycleCount ? ` · +${cycleCount} 环` : ''}
                    </span>
                  </button>
                )}

                {features.length > 0 && (
                  <button
                    type="button"
                    className="hud-pill"
                    aria-expanded={openDrawer === 'features'}
                    onClick={() => setOpenDrawer(prev => (prev === 'features' ? null : 'features'))}
                  >
                    <i className="hud-dot ok" />
                    <span>涉及功能 {features.length}</span>
                  </button>
                )}

                {constraints.length > 0 && (
                  <button
                    type="button"
                    className="hud-pill tone-warn"
                    aria-expanded={openDrawer === 'constraints'}
                    onClick={() => setOpenDrawer(prev => (prev === 'constraints' ? null : 'constraints'))}
                  >
                    <i className="hud-dot warn" />
                    <span>工程约束 {constraints.length}</span>
                  </button>
                )}
              </div>

              <div className="hud-toolbar-right">
                {hasArchNodes && (
                  <button
                    type="button"
                    className="hud-pill"
                    onClick={() => onOpenArchitectureOverlay({
                      taskId: '__live_radar__',
                      goal: activeRadar.mode === 'worktree' ? `本机工作区实时改动（${activeRadar.changed_files.length} 文件）` : `提交 ${activeRadar.target_ref.slice(0, 8)} 变更`,
                      resultId: activeRadar.impact.architecture_result_id,
                      nodes: new Map(activeRadar.impact.architecture_nodes.map(n => [n.node_id, n.relation])),
                    })}
                  >
                    <span>架构叠加 ↗</span>
                  </button>
                )}
              </div>
            </div>

            {openDrawer === 'struct' && struct && (
              <StructureDiffDrawer diff={struct} onClose={() => setOpenDrawer(null)} />
            )}

            {openDrawer === 'features' && (
              <div className="hud-drawer">
                <div className="hud-drawer-head">
                  <strong>本次改动命中的功能模块 ({features.length})</strong>
                  <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                </div>
                <div className="hud-caller-list">
                  {features.map(f => (
                    <div key={f.scenario_id} className="hud-caller-row">
                      <strong>{f.label}</strong>
                      <small>{f.has_call_graph ? '已有调用链走读' : '功能目录匹配'}</small>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {openDrawer === 'constraints' && (
              <div className="hud-drawer tone-warn">
                <div className="hud-drawer-head">
                  <strong>关联工程约束 ({constraints.length})</strong>
                  <button type="button" className="hud-drawer-close" onClick={() => setOpenDrawer(null)}>收起</button>
                </div>
                <div className="hud-caller-list">
                  {constraints.map(c => (
                    <div key={c.entry_id} className="hud-caller-row">
                      <div>
                        <strong>{c.key}</strong>
                        <div style={{ fontSize: 12, color: 'var(--ink-secondary)' }}>{c.excerpt}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Main Interactive Stage Card */}
          <div className="hud-walkthrough radar-stage-card">
            <div className="hud-walkthrough-toolbar">
              <div className="hud-toolbar-left">
                <div className="hud-segmented" role="group" aria-label="视图切换">
                  <button
                    type="button"
                    aria-pressed={activeTab === 'graph'}
                    disabled={!astGraph && !focusFile}
                    onClick={() => setActiveTab('graph')}
                  >
                    本地 AST 调用图
                  </button>
                  <button
                    type="button"
                    aria-pressed={activeTab === 'files'}
                    onClick={() => setActiveTab('files')}
                  >
                    改动文件 Diff ({activeRadar.changed_files.length})
                  </button>
                </div>
              </div>

              {activeTab === 'graph' && astGraph && (
                <div className="hud-toolbar-right">
                  <div className="hud-segmented" role="group" aria-label="差异过滤">
                    <button type="button" aria-pressed={viewFilter === 'diff'} onClick={() => setViewFilter('diff')}>对比</button>
                    <button type="button" aria-pressed={viewFilter === 'before'} onClick={() => setViewFilter('before')}>改前</button>
                    <button type="button" aria-pressed={viewFilter === 'after'} onClick={() => setViewFilter('after')}>改后</button>
                  </div>
                  {selectedTarget && (
                    <button type="button" className="hud-mini-btn" onClick={() => setSelectedTarget(null)}>
                      全宽图
                    </button>
                  )}
                </div>
              )}
            </div>

            {activeTab === 'graph' && (astGraph || focusFile || loading) && sourceFiles.length >= 2 && (
              <div className="radar-focus-bar" role="group" aria-label="按改动文件聚焦调用图">
                <span className="radar-focus-label">聚焦文件</span>
                <button
                  type="button"
                  className={`radar-focus-chip${!focusFile ? ' is-active' : ''}`}
                  aria-pressed={!focusFile}
                  onClick={() => selectFocusFile('')}
                >
                  全部源码 ({sourceFiles.length})
                </button>
                {sourceFiles.slice(0, 24).map(f => (
                  <button
                    key={f.path}
                    type="button"
                    className={`radar-focus-chip${focusFile === f.path ? ' is-active' : ''}`}
                    aria-pressed={focusFile === f.path}
                    title={f.path}
                    onClick={() => selectFocusFile(focusFile === f.path ? '' : f.path)}
                  >
                    {focusLabels.get(f.path) ?? shortFile(f.path)}
                  </button>
                ))}
              </div>
            )}

            {activeTab === 'graph' && astGraph ? (
              <div className={`hud-stage${selectedTarget ? ' has-inspector' : ''}`}>
                <CallChainDiffGraph
                  pathDiff={astGraph.path}
                  viewFilter={viewFilter}
                  hideNoise={false}
                  selectedTarget={selectedTarget}
                  omittedNeighbors={astGraph.omitted_neighbors}
                  omittedChanges={astGraph.omitted_changes}
                  onSelectNode={node => setSelectedTarget(prev =>
                    prev?.kind === 'node' && prev.node.key === node.key ? null : { kind: 'node', node },
                  )}
                  onSelectEdge={edge => setSelectedTarget(prev =>
                    prev?.kind === 'edge' && prev.edge.key === edge.key ? null : { kind: 'edge', edge },
                  )}
                />

                {selectedTarget && (
                  <LiveDiffInspector
                    projectId={project.project_id}
                    radar={activeRadar}
                    pathDiff={astGraph.path}
                    target={selectedTarget}
                    onClose={() => setSelectedTarget(null)}
                    onRefreshRadar={() => void loadRadar({ force: true })}
                    onOpenFullDiff={file => {
                      setSelectedFile(file);
                      setActiveTab('files');
                    }}
                  />
                )}
              </div>
            ) : activeTab === 'graph' && loading ? (
              <div className="radar-focus-empty">
                <strong>正在更新调用图视图…</strong>
                <p>正在复用本机缓存索引计算调用链。</p>
              </div>
            ) : activeTab === 'graph' && focusFile ? (
              <div className="radar-focus-empty">
                <strong>“{focusLabels.get(focusFile) ?? shortFile(focusFile)}” 仅包含类型定义、常量或注释改动</strong>
                <p>该文件本次未涉及可调用函数的结构变化，因此本地 AST 调用图为空。</p>
                <div className="radar-empty-actions">
                  <button type="button" className="primary" onClick={() => selectFocusFile('')}>
                    查看全部改动源码 ({sourceFiles.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFile(focusFile);
                      setActiveTab('files');
                    }}
                  >
                    查看该文件 Diff
                  </button>
                </div>
              </div>
            ) : (
              <div className="radar-files-split">
                <aside className="radar-file-list" aria-label="改动文件清单">
                  {hasMixedFiles && (
                    <div className="radar-file-filter">
                      <button
                        type="button"
                        aria-pressed={sourceOnly}
                        onClick={() => {
                          setSourceOnly(true);
                          if (!sourceFiles.some(f => f.path === selectedFile) && sourceFiles[0]) setSelectedFile(sourceFiles[0].path);
                        }}
                      >
                        仅源码 ({sourceFiles.length})
                      </button>
                      <button
                        type="button"
                        aria-pressed={!sourceOnly}
                        onClick={() => setSourceOnly(false)}
                      >
                        全部 ({activeRadar.changed_files.length})
                      </button>
                    </div>
                  )}
                  {visibleChangedFiles.map(file => {
                    const active = selectedFile === file.path;
                    const badge = file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : 'M';
                    return (
                      <button
                        key={file.path}
                        type="button"
                        className={`radar-file-row${active ? ' is-selected' : ''}`}
                        aria-pressed={active}
                        title={file.path}
                        onClick={() => setSelectedFile(file.path)}
                      >
                        <span className={`radar-file-status status-${file.status}`}>{badge}</span>
                        <span className="radar-file-info">
                          <strong>{shortFile(file.path)}</strong>
                          <small>{file.path}</small>
                        </span>
                      </button>
                    );
                  })}
                </aside>

                <div className="radar-file-diff-pane">
                  {!astGraph && !focusFile && (
                    <div className="radar-nonsource-note">
                      本次变动不含可解析源码文件，已自动展示文件清单与差异对比。
                    </div>
                  )}
                  {fileDiffLoading ? (
                    <p className="muted" style={{ padding: 16 }}>读取实时文件差异…</p>
                  ) : fileDiffError ? (
                    <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <p className="warning" style={{ margin: 0 }}>{fileDiffError}</p>
                      {fileDiffError.includes('刷新') && (
                        <button type="button" className="hud-mini-btn" onClick={() => void loadRadar({ force: true })}>立即刷新雷达</button>
                      )}
                    </div>
                  ) : fileDiff?.binary ? (
                    <p className="muted" style={{ padding: 16 }}>二进制文件，暂不支持文本 Diff。</p>
                  ) : fileDiff ? (
                    <TextDiffView
                      path={fileDiff.path}
                      before={fileDiff.before}
                      after={fileDiff.after}
                      truncated={fileDiff.truncated}
                      beforeLabel={
                        activeRadar.source === 'snapshot'
                          ? '改前（ARC 快照）'
                          : activeRadar.mode === 'worktree'
                            ? `改前（${activeRadar.branch || 'HEAD'}）`
                            : '父提交'
                      }
                      afterLabel={activeRadar.mode === 'worktree' ? '当前工作区' : `提交 ${activeRadar.target_ref.slice(0, 7)}`}
                      closeLabel="返回调用图"
                      onClose={astGraph || focusFile ? () => setActiveTab('graph') : undefined}
                    />
                  ) : (
                    <p className="muted" style={{ padding: 16 }}>在左侧选择一个改动文件查看前后对比。</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}
