import React, { useEffect, useRef, useState } from 'react';
import type { Feature, Scenario, ScenarioBreakdownResult, ScenarioProposal } from '../shared';

interface Props {
  feature: Feature;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onAdded: (firstId: string) => Promise<void>;
  onClose: () => void;
}

export function ScenarioBreakdownForm({ feature, saving, setSaving, onAdded, onClose }: Props) {
  const [proposals, setProposals] = useState<ScenarioProposal[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const firstAdded = useRef('');

  useEffect(() => {
    let open = true;
    window.arc.invoke<ScenarioBreakdownResult>('feature_breakdown', { feature_id: feature.feature_id }).then(result => {
      if (!open) return;
      setProposals(result.proposals);
      setSelected(result.proposals.map(item => item.title));
    }).catch((e: Error) => { if (open) setError(e.message); });
    return () => { open = false; };
  }, [feature.feature_id]);

  async function addSelected(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !selected.length) return;
    setSaving(true);
    setError('');
    try {
      for (const { title, question } of proposals ?? []) {
        if (!selected.includes(title)) continue;
        const scene = await window.arc.invoke<Scenario>('scenario_add', { feature_id: feature.feature_id, title, question, kind: 'breakdown' });
        firstAdded.current ||= scene.scenario_id;
        setProposals(items => items?.filter(item => item.title !== title));
        setSelected(items => items.filter(item => item !== title));
      }
      await onAdded(firstAdded.current);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="breakdown-form" onSubmit={addSelected}>
      <p className="breakdown-feature">{feature.name}</p>
      {!proposals && !error && <p role="status">正在结合冻结源码拆分子场景…</p>}
      {error && <p className="warning" role="alert">{error}</p>}
      {proposals?.length === 0 && !error && !saving && <p role="status">已有场景覆盖了本次建议。</p>}
      {proposals?.map(item => (
        <label className="breakdown-choice" key={item.title}>
          <input type="checkbox" aria-label={item.title} checked={selected.includes(item.title)} disabled={saving}
            onChange={e => setSelected(e.target.checked ? [...selected, item.title] : selected.filter(title => title !== item.title))} />
          <span className="breakdown-copy">
            <strong title={item.question}>{item.title}</strong>
            <code title={item.entry_hint}>{item.entry_hint}</code>
            <span className="breakdown-rationale" title={item.rationale}>{item.rationale}</span>
          </span>
        </label>
      ))}
      <div className="row end">
        <button type="button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary" type="submit" disabled={saving || !selected.length}>
          {saving ? '正在加入…' : `加入所选子场景（${selected.length}）`}
        </button>
      </div>
    </form>
  );
}
