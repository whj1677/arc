import React, { useMemo, useState } from 'react';
import { computeLineDiff, collapseSplitContext, collapseUnifiedContext } from './text-diff';

export function TextDiffView({
  path,
  before,
  after,
  truncated,
  onClose,
}: {
  path: string;
  before: string;
  after: string;
  truncated: boolean;
  onClose: () => void;
}) {
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');
  const [contextOnly, setContextOnly] = useState(true);

  const diff = useMemo(() => computeLineDiff(before, after), [before, after]);
  const hasChanges = diff.stats.added > 0 || diff.stats.removed > 0;

  const unifiedItems = useMemo(
    () => (contextOnly && hasChanges ? collapseUnifiedContext(diff.lines, 3) : diff.lines),
    [diff.lines, contextOnly, hasChanges],
  );
  const splitItems = useMemo(
    () => (contextOnly && hasChanges ? collapseSplitContext(diff.split, 3) : diff.split.map(row => ({ type: 'row' as const, row }))),
    [diff.split, contextOnly, hasChanges],
  );

  return (
    <section className="engineering-diff" aria-label="文件修改前后对比">
      <div className="engineering-diff-header">
        <div className="engineering-diff-title">
          <strong title={path}>{path}</strong>
          <div className="engineering-diff-stats" aria-label="变更行数统计">
            <span className="diff-stat-add">+{diff.stats.added}</span>
            <span className="diff-stat-del">−{diff.stats.removed}</span>
          </div>
        </div>
        <div className="engineering-diff-controls">
          <div className="diff-mode-switch" role="group" aria-label="对比视图切换">
            <button type="button" aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}>
              并排
            </button>
            <button type="button" aria-pressed={viewMode === 'unified'} onClick={() => setViewMode('unified')}>
              行内
            </button>
          </div>
          {hasChanges && (
            <button type="button" className="diff-context-toggle" aria-pressed={contextOnly} onClick={() => setContextOnly(v => !v)}>
              {contextOnly ? '显示全文' : '仅看变更'}
            </button>
          )}
          <button type="button" onClick={onClose}>
            关闭对比
          </button>
        </div>
      </div>

      {truncated && <p className="warning engineering-diff-warning">文件较长，当前显示部分内容；完整版本保存在引用快照。</p>}

      {viewMode === 'split' ? (
        <div className="engineering-diff-split">
          <section>
            <h4>任务开始时</h4>
            <pre className="diff-code">
              {!before ? (
                <span className="diff-line diff-line-empty">此版本不存在该文件</span>
              ) : (
                splitItems.map((item, idx) =>
                  item.type === 'gap' ? (
                    <span className="diff-line diff-line-gap" key={`lg-${idx}`}>
                      <b>…</b>
                      <i> </i>
                      <span>已折叠 {item.hidden} 行未变更内容</span>
                      {'\n'}
                    </span>
                  ) : (
                    <span className={`diff-line diff-line-${item.row.left.type}`} key={`l-${idx}`}>
                      <b>{item.row.left.line ?? ''}</b>
                      <i>{item.row.left.type === 'del' ? '−' : ' '}</i>
                      <span>{item.row.left.text}</span>
                      {'\n'}
                    </span>
                  ),
                )
              )}
            </pre>
          </section>
          <section>
            <h4>任务结束时</h4>
            <pre className="diff-code">
              {!after ? (
                <span className="diff-line diff-line-empty">此版本不存在该文件</span>
              ) : (
                splitItems.map((item, idx) =>
                  item.type === 'gap' ? (
                    <span className="diff-line diff-line-gap" key={`rg-${idx}`}>
                      <b>…</b>
                      <i> </i>
                      <span>已折叠 {item.hidden} 行未变更内容</span>
                      {'\n'}
                    </span>
                  ) : (
                    <span className={`diff-line diff-line-${item.row.right.type}`} key={`r-${idx}`}>
                      <b>{item.row.right.line ?? ''}</b>
                      <i>{item.row.right.type === 'add' ? '+' : ' '}</i>
                      <span>{item.row.right.text}</span>
                      {'\n'}
                    </span>
                  ),
                )
              )}
            </pre>
          </section>
        </div>
      ) : (
        <div className="engineering-diff-unified">
          <pre className="diff-code">
            {unifiedItems.map((item, idx) =>
              item.type === 'gap' ? (
                <span className="diff-line diff-line-gap" key={`ug-${idx}`}>
                  <b>…</b>
                  <b>…</b>
                  <i> </i>
                  <span>已折叠 {item.hidden} 行未变更内容</span>
                  {'\n'}
                </span>
              ) : (
                <span className={`diff-line diff-line-${item.type}`} key={`u-${idx}`}>
                  <b>{item.oldLine ?? ''}</b>
                  <b>{item.newLine ?? ''}</b>
                  <i>{item.type === 'add' ? '+' : item.type === 'del' ? '−' : ' '}</i>
                  <span>{item.text}</span>
                  {'\n'}
                </span>
              ),
            )}
          </pre>
        </div>
      )}
    </section>
  );
}
