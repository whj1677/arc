import React, { useEffect, useState } from 'react';
import type { SourceEvidence } from '../shared';

/** Always read the evidence's frozen source, never the current workspace file. */
export function SourceExcerpt({
  evidence: e,
  hidePath = false,
}: {
  evidence: SourceEvidence;
  hidePath?: boolean;
}) {
  const [source, setSource] = useState<{ text: string; content_sha256: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setSource(null);
    setError('');
    void window.arc
      .invoke<{ text: string; content_sha256: string }>('source', {
        source_snapshot_id: e.source_snapshot_id,
        path: e.path,
      })
      .then(value => {
        if (current) setSource(value);
      })
      .catch(reason => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [e.source_snapshot_id, e.path]);

  const start = Math.max(1, e.line_start - 3);
  const end = e.line_end + 3;

  return (
    <section className={`question-source ${hidePath ? 'embedded' : ''}`} aria-label="冻结源码依据">
      {!hidePath && (
        <div className="question-source-header">
          <strong title={e.path}>
            {e.path}:{e.line_start}–{e.line_end}
          </strong>
        </div>
      )}
      {error ? (
        <p role="alert" className="source-alert">
          源码读取失败：{error}
        </p>
      ) : !source ? (
        <div className="arc-skeleton-box" role="status">
          <span className="arc-skeleton-line wide" aria-hidden="true" />
          <span className="arc-skeleton-line medium" aria-hidden="true" />
          <span className="arc-skeleton-line short" aria-hidden="true" />
          <small>正在读取冻结源码…</small>
        </div>
      ) : source.content_sha256 !== e.content_sha256 ? (
        <p role="alert" className="source-alert">
          源码哈希与引用不符，未展示为有效依据。
        </p>
      ) : (
        <pre>
          {source.text
            .split(/\r\n|\n|\r/)
            .slice(start - 1, end)
            .map((line, index) => (
              <span className={start + index >= e.line_start && start + index <= e.line_end ? 'highlight' : ''} key={index}>
                <b>{start + index}</b>
                {line}
                {'\n'}
              </span>
            ))}
        </pre>
      )}
      <div className="question-source-footer">
        <small title={e.source_snapshot_id}>冻结快照：{e.source_snapshot_id}</small>
        <small title={e.content_sha256}>SHA-256：{e.content_sha256}</small>
      </div>
    </section>
  );
}
