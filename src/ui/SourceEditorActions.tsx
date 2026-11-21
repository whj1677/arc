import React, { useState } from 'react';
import type { SourceEditor, SourceEditorLocation } from '../shared';

export function SourceEditorActions({ location }: { location: SourceEditorLocation }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

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
    <div className="row" role="group" aria-label="在编辑器中打开源码" aria-busy={opening}>
      <button type="button" disabled={opening} onClick={() => void open('default')}>在默认编辑器中打开（仅文件）</button>
      <button type="button" disabled={opening} onClick={() => void open('vscode')}>
        {location.line === undefined ? '在 VS Code 中打开' : `在 VS Code 中打开到第 ${location.line} 行`}
      </button>
    </div>
    {error && <small className="warning" role="alert">{error}</small>}
  </>;
}
