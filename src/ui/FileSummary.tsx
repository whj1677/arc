import React, { useEffect, useState } from 'react';
import type { Snapshot, WorkspaceData } from '../shared';
import { fileCitations, filePurpose } from './file-map';
import { SourceExcerpt } from './SourceExcerpt';

interface FileSummaryProps {
  data: WorkspaceData;
  projectId: string;
  snapshot: Snapshot;
  path: string;
  ask: (question: string) => void;
  disabled?: boolean;
  showSource?: boolean;
}

// The source IPC verifies the file hash against the requested frozen snapshot.
function FrozenFile({ snapshotId, path }: { snapshotId: string; path: string }) {
  const [source, setSource] = useState<{ text: string } | { error: string }>();
  useEffect(() => {
    let active = true;
    window.arc.invoke<{ text: string }>('source', { source_snapshot_id: snapshotId, path })
      .then(value => { if (active) setSource(value); })
      .catch(reason => { if (active) setSource({ error: String(reason) }); });
    return () => { active = false; };
  }, [snapshotId, path]);
  return <section className="question-source" aria-label="文件冻结源码">
    <h3>冻结源码</h3>{!source ? <p role="status">正在读取文件…</p> : 'error' in source
      ? <p role="alert">{source.error}</p> : <pre tabIndex={0}>{source.text}</pre>}
  </section>;
}

export function FileSummary({ data, projectId, snapshot, path, ask, disabled, showSource }: FileSummaryProps) {
  const [expandedCitation, setExpandedCitation] = useState('');
  const file = snapshot.files.find(f => f.path === path);
  const folder = !file;
  const purpose = filePurpose(data, projectId, snapshot.source_snapshot_id, path, folder);
  const overview = data.projects.find(p => p.project_id === projectId)?.overview_scenario_id;
  const whole = !path && data.explanations.findLast(e => e.scenario_id === overview && e.result.binding.source_snapshot_id === snapshot.source_snapshot_id);
  const citations = purpose ? [] : fileCitations(data, projectId, snapshot.source_snapshot_id, path, folder);
  const count = folder ? snapshot.files.filter(f => !path || f.path.startsWith(path + '/')).length : 0;
  return (
    <article className="file-summary">
      <span className="eyebrow">{folder ? '文件夹作用' : '文件摘要'}</span>
      <h2>{path ? path.split('/').at(-1) : '工程根目录'}</h2>
      <p className="path">{path || snapshot.root_path}</p>
      {file && showSource && <FrozenFile key={snapshot.source_snapshot_id + '/' + path} snapshotId={snapshot.source_snapshot_id} path={path} />}
      {purpose ? <>
        <p className="file-purpose">{purpose.node.description}</p>
        <p className="summary-state">{purpose.explanation.source_status === 'current' ? '来源引用 · 结论待核对' : '原快照说明 · 当前目录变化需复核'}</p>
        {[...purpose.node.inputs, ...purpose.node.outputs].map(io => (
          <div className="io-row" key={io.io_id}><strong>{io.name}</strong><p>{io.description}</p></div>
        ))}
        <details>
          <summary>说明依据与边界</summary>
          {purpose.explanation.result.claims.filter(c => purpose.node.claim_ids.includes(c.claim_id)).map(c => (
            <div key={c.claim_id}><p>{c.statement}</p>{c.limitations.map((x, i) => <small key={i}>{x}</small>)}</div>
          ))}
          {purpose.explanation.result.evidence.filter(e => purpose.node.evidence_ids.includes(e.evidence_id)).map(e => (
            <p className="path" key={e.evidence_id}>{e.path}:{e.line_start}–{e.line_end}</p>
          ))}
        </details>
        <details className="file-scope-meta">
          <summary>任务与源码绑定</summary>
          <dl>
            <dt>原问题</dt><dd>{data.scenarios.find(s => s.scenario_id === purpose.explanation.scenario_id)?.title}</dd>
            <dt>运行</dt><dd>{purpose.explanation.result.binding.run_id}</dd>
            <dt>问题修订</dt><dd>{purpose.explanation.result.binding.question_revision_id}</dd>
            <dt>源码快照</dt><dd>{purpose.explanation.result.binding.source_snapshot_id}</dd>
          </dl>
        </details>
      </> : <>
        {whole && <>
          <p className="file-purpose">{whole.result.summary.text}</p>
          <p className="summary-state">工程全貌说明 · {whole.source_status === 'current' ? '来源引用待核对' : '原快照，目录变化需复核'}</p>
        </>}
        {!citations.length && !whole && <>
          <h3>用途尚未分析</h3>
          <p>当前快照已索引这个{folder ? '文件夹' : '文件'}，还没有明确的{folder ? '目录作用' : '整文件摘要'}。</p>
        </>}
        {!whole && <>
          <button disabled={disabled} onClick={() => ask(`请依据当前冻结快照，概括${folder ? '目录' : '整文件'} ${path || '工程根目录'} 的职责、主要内容和协作边界，并引用具体源码行。`)}>
            生成{folder ? '目录' : '整文件'}摘要
          </button>
          <p className="summary-state">回答保存在当前位置的“提问”页。</p>
        </>}
        {citations.length > 0 && <section>
          <h3>已在以下分析中引用（{citations.length} 处）</h3>
          {citations.map(({ explanation, evidence }) => {
            const key = explanation.result_id + '/' + evidence.evidence_id;
            const scenario = data.scenarios.find(s => s.scenario_id === explanation.scenario_id);
            const feature = scenario?.kind === 'feature_overview' && data.features.find(f => f.feature_id === scenario.feature_id);
            return <div className="io-row" key={key}>
              <strong>{feature && feature.name || scenario?.title || data.runs.find(r => r.binding.run_id === explanation.result.binding.run_id)?.title}</strong>
              <button className="quiet path" aria-expanded={expandedCitation === key} onClick={() => setExpandedCitation(expandedCitation === key ? '' : key)}>
                {evidence.path}:{evidence.line_start}–{evidence.line_end}
              </button>
              <p>{evidence.note}</p>
              {expandedCitation === key && <SourceExcerpt evidence={evidence} hidePath />}
            </div>;
          })}
        </section>}
      </>}
      <p className="muted">{folder ? `本范围索引 ${count} 个文本文件。` : `${file.line_count} 行 · ${file.encoding} · ${file.bytes} 字节。`}</p>
    </article>
  );
}
