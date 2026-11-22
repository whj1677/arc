import React, {useState} from 'react';
import {auditDelivery} from '../delivery-audit';
import type {EngineeringTask, MaterialSourceIndexEntry} from '../engineering';
import './delivery-audit.css';

export function DeliveryAuditBar({task, entries, onRefresh, busy = false}: {
  task: EngineeringTask; entries: MaterialSourceIndexEntry[]; onRefresh: () => Promise<unknown>; busy?: boolean;
}) {
  const {scope, verification, redlines, review, impacted_materials} = auditDelivery(task, entries);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const complete = ['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(task.status);
  const scopeLabel = scope.out_of_scope.length ? `${scope.out_of_scope.length} 项越界` : scope.overlap.length ? `${scope.overlap.length} 项重叠`
    : task.changes_status === 'needs_review' ? '归属待核' : task.changes.length ? '范围内' : '暂无变更';
  const verificationTone = verification.status === 'passed' ? 'ok' : verification.status === 'not_run' ? 'neutral' : 'warning';
  async function refresh() {
    setRefreshing(true); setError('');
    try { await onRefresh(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setRefreshing(false); }
  }
  return <section className="delivery-audit" aria-label="交付自检">
    <div className="delivery-audit-row">
      <strong>交付自检</strong>
      <span className="delivery-check" data-tone={scope.status === 'warning' ? 'warning' : task.changes.length ? 'ok' : 'neutral'}>范围合规 · {scopeLabel}</span>
      <span className="delivery-check" data-tone={verificationTone}>验证可信度 · {verification.label}</span>
      <span className="delivery-check" data-tone={redlines.hits.length ? 'warning' : 'neutral'}>红线核对 · {redlines.hits.length ? `${redlines.hits.length} 项命中` : '无命中'}</span>
      {review.status !== 'none' && <span className="delivery-check" data-tone={review.status === 'needs_fix' ? 'warning' : review.status === 'no_diff' ? 'neutral' : 'ok'}>独立审查 · {review.label}</span>}
    </div>
    {review.summary && (review.status === 'repaired' || review.status === 'needs_fix') && <details className="delivery-review">
      <summary>{review.summary.split(/\r?\n/)[0]}</summary>
      <p>{review.summary}</p>
    </details>}
    {!!(scope.out_of_scope.length || scope.overlap.length || redlines.hits.length) && <details className="delivery-audit-details">
      <summary>查看待核对项</summary>
      {!!scope.out_of_scope.length && <p>超出范围　{scope.out_of_scope.join('、')}</p>}
      {!!scope.overlap.length && <p>已有改动重叠　{scope.overlap.join('、')}</p>}
      {!!redlines.hits.length && <p>命中撤销关键词　{redlines.hits.join('、')}</p>}
    </details>}
    {complete && impacted_materials.length > 0 && <div className="delivery-materials">
      <span>本次改动涉及 <b>{impacted_materials.length}</b> 份工程资料</span>
      <button type="button" className="quiet" disabled={refreshing || busy} onClick={() => void refresh()}>{refreshing ? '正在刷新…' : '刷新工程资料'}</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
