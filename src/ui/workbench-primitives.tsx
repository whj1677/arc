import React, { useEffect, useRef, useState } from 'react';
import type { AnalysisResult, Explanation, ReadingState, SourceEvidence, WorkspaceData } from '../shared';
import { hasFunctionGraphs } from '../shared';

export const initialData: WorkspaceData = {
  projects: [],
  features: [],
  scenarios: [],
  revisions: [],
  annotations: [],
  runs: [],
  explanations: [],
  providers: [],
  snapshots: [],
};

export const defaults: ReadingState = {
  entrance: 'overview',
  view: 'system',
  scenario_id: '',
  result_id: '',
  selected: '',
  file: '',
  evidence_id: '',
  source_snapshot_id: '',
  mode: 'normal',
  left_width: 220,
  right_width: 360,
  catalog_hidden: false,
  pinned: false,
  detail_tab: 'details',
  expanded: [],
  scroll: {},
  zoom: 1,
  stage: '',
  compare_id: '',
  linked: true,
  presentation_version: 3,
  architecture_version: 1,
};

export const statuses: Record<string, string> = {
  validating: '本地校验中',
  queued: '排队',
  waiting_agent: '等待 Agent 领取',
  running: '运行中',
  cancel_requested: '停止请求中',
  cancelled: '已停止',
  completed: '执行完成',
  failed: '失败',
  unknown: '状态未知',
  blocked_external: '外部条件缺失',
  available: '本机可用 · 待工程验证',
  auth_required: '需要登录',
};

export const short = (s: string) => (s.length > 28 ? s.slice(0, 12) + '…' + s.slice(-10) : s);

export function closePopovers(except?: Node) {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    '.analysis-options[open],.context-edit-actions[open],.source-options[open],.view-options[open],.canvas-filter[open],.feature-menu[open]',
  )) {
    if (!except || !menu.contains(except)) menu.open = false;
  }
}

export type HomeBookmark = {
  projectId: string;
  label: string;
  catalogNodeId?: string;
  position: Pick<
    ReadingState,
    | 'scenario_id'
    | 'result_id'
    | 'source_snapshot_id'
    | 'entrance'
    | 'view'
    | 'selected'
    | 'file'
    | 'evidence_id'
    | 'detail_tab'
    | 'reading_path'
    | 'function_path'
    | 'stage'
    | 'function_mode'
  >;
};

export function firstGraphPath(result: AnalysisResult) {
  return result.function_walkthroughs?.find(path => hasFunctionGraphs({ ...result, function_walkthroughs: [path] }))?.id || '';
}

export function ScrollPanel({
  name,
  children,
  positions,
  restoreKey,
  onPosition,
}: {
  name: string;
  children: React.ReactNode;
  positions: ReadingState['scroll'];
  restoreKey: string;
  onPosition: (name: string, top: number, left: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoring = useRef(false);

  useEffect(() => {
    const p = positions[name];
    restoring.current = true;
    if (ref.current) {
      ref.current.scrollTop = p?.top || 0;
      ref.current.scrollLeft = p?.left || 0;
    }
    requestAnimationFrame(() => {
      restoring.current = false;
    });
  }, [restoreKey, name]);

  return (
    <div
      className="panel-scroll"
      ref={ref}
      onScroll={e => {
        if (restoring.current) return;
        const { scrollTop, scrollLeft } = e.currentTarget;
        onPosition(name, scrollTop, scrollLeft);
      }}
    >
      {children}
    </div>
  );
}

export function Separator({
  side,
  value,
  change,
  reset,
}: {
  side: 'left_width' | 'right_width';
  value: number;
  change: (side: 'left_width' | 'right_width', delta: number) => void;
  reset: () => void;
}) {
  return (
    <div
      className="splitter"
      role="separator"
      aria-label={side === 'left_width' ? '调整目录宽度' : '调整详情宽度'}
      aria-orientation="vertical"
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          change(side, (e.key === 'ArrowRight' ? 1 : -1) * (side === 'left_width' ? 16 : -16));
        }
        if (e.key === 'Home') reset();
      }}
      onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.x = String(e.clientX);
      }}
      onPointerMove={e => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const previous = Number(e.currentTarget.dataset.x);
        change(side, (e.clientX - previous) * (side === 'left_width' ? 1 : -1));
        e.currentTarget.dataset.x = String(e.clientX);
      }}
    />
  );
}

export function EvidenceButton({ evidence, open }: { evidence: SourceEvidence; open: (e: SourceEvidence) => void }) {
  return (
    <button className="evidence-button" onClick={() => open(evidence)}>
      <strong>
        {evidence.path}:{evidence.line_start}–{evidence.line_end}
      </strong>
      <small>
        {evidence.role} · {evidence.note}
      </small>
      <span>查看依据位置 →</span>
    </button>
  );
}

export function Compare({
  explanations,
  oldId,
  newId,
  linked,
  selectOld,
}: {
  explanations: Explanation[];
  oldId: string;
  newId: string;
  linked: boolean;
  selectOld: (v: string) => void;
}) {
  const old = explanations.find(e => e.result_id === oldId) || explanations.at(-2);
  const fresh = explanations.find(e => e.result_id === newId) || explanations.at(-1);
  const [selected, setSelected] = useState('');

  return (
    <div className="compare-columns">
      {[old, fresh].map((e, index) => (
        <section className="compare-panel" key={index}>
          <div className="pane-heading">
            <h2>{index === 0 ? '旧版' : '新版'}</h2>
            {index === 0 && (
              <select aria-label="选择旧版" value={e?.result_id || ''} onChange={ev => selectOld(ev.target.value)}>
                {explanations.map(v => (
                  <option key={v.result_id} value={v.result_id}>
                    {short(v.result_id)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="panel-scroll">
            <p className="path">
              来源 {e?.result.binding.source_snapshot_id}
              <br />
              问题 {e?.result.binding.question_revision_id}
            </p>
            <p>{e?.result.summary.text}</p>
            <p className="warning">
              {old?.result.binding.source_snapshot_id === fresh?.result.binding.source_snapshot_id
                ? '同一来源的解释差异'
                : '不同源码来源；解释差异不自动等于源码差异'}
            </p>
            {e?.result.nodes.map(n => (
              <button
                className={`compare-node ${linked && n.node_id === selected ? 'selected' : ''}`}
                key={n.node_id}
                onClick={() => setSelected(n.node_id)}
              >
                <strong>{n.label}</strong>
                <span>{n.description}</span>
                <small>
                  {(index === 0 ? fresh : old)?.result.nodes.some(v => v.node_id === n.node_id)
                    ? '相同稳定 ID 可联动'
                    : '无对应稳定 ID · 新增 / 移除 / 无法匹配'}
                </small>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
