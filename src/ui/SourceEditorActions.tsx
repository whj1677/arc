import React, { useState } from 'react';
import type { SourceEditor, SourceEditorLocation } from '../shared';

export function SourceEditorActions({ location }: { location: SourceEditorLocation }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const label = location.line === undefined ? '在编辑器中打开' : `在编辑器中打开（第 ${location.line} 行）`;

  async function open(editor: SourceEditor) {
    setOpening(true);
    setError('');
    try {
      await window.arc.invoke('source_open_editor', { ...location, editor });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setOpening(false);
    }
  }

  return <>
    <div className="row" role="group" aria-label={label} aria-busy={opening}>
      <small>{label}</small>
      <button type="button" disabled={opening} onClick={() => void open('default')}>默认编辑器</button>
      <button type="button" disabled={opening} onClick={() => void open('trae')}>Trae</button>
      <button type="button" disabled={opening} onClick={() => void open('vscode')}>VS Code</button>
    </div>
    {error && <small className="warning" role="alert">{error}</small>}
  </>;
}
