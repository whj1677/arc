import React, { useState } from 'react';
import type { CodexModelCatalog } from '../shared';

export interface CodexModelSelection {
  catalog: CodexModelCatalog;
  model: string;
  onModelChange: (model: string) => Promise<boolean>;
}

export function CodexModelSelect({ catalog, model, onModelChange, label, disabled, allowCustom = false }:
  CodexModelSelection & { label: string; disabled: boolean; allowCustom?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const defaultLabel = allowCustom ? '跟随 Codex 默认' : '默认';
  return <>
    <select className="codex-model-select" aria-label={label} disabled={disabled}
      value={draft === null ? model : '@custom'} title={model || catalog.default_model}
      onChange={event => {
        const value = event.target.value;
        if (value === '@custom') setDraft(model);
        else { setDraft(null); void onModelChange(value); }
      }}>
      <option value="">{defaultLabel}{catalog.default_model && `（${catalog.default_model}）`}</option>
      {catalog.models.map(option => <option key={option.slug} value={option.slug} title={option.slug}>{option.display_name}</option>)}
      {model && !catalog.models.some(option => option.slug === model) && <option value={model}>{model}</option>}
      {allowCustom && <option value="@custom">自定义模型…</option>}
    </select>
    {draft !== null && <div className="custom-codex-model">
      <input aria-label="自定义模型名称" placeholder="输入模型标识" value={draft} maxLength={80}
        autoFocus disabled={disabled} onChange={event => setDraft(event.target.value)} />
      <button type="button" disabled={disabled || !draft.trim()} onClick={async () => {
        if (await onModelChange(draft.trim())) setDraft(null);
      }}>应用</button>
    </div>}
  </>;
}
