import React from 'react';
import type { CodeBinding } from '../architecture-workspace';

export function CodeLinkEditor({ links, onChange }: { links: CodeBinding[]; onChange: (links: CodeBinding[]) => void }) {
  function change(id: string, patch: Partial<CodeBinding>) {
    onChange(links.map(link => link.id === id ? { ...link, ...patch, origin: link.origin === 'code_analysis' ? 'manual_override' : link.origin } : link));
  }
  return <fieldset className="architecture-code-links"><legend>代码关联</legend>
    {links.map((link, index) => <fieldset key={link.id}><legend>关联 {index + 1}</legend>
      <label>类型<select aria-label="类型" value={link.kind} onChange={e => change(link.id, { kind: e.target.value as CodeBinding['kind'], symbol_name: undefined, symbol_id: undefined,
        ...(e.target.value === 'directory' && { start_line: undefined, end_line: undefined, file_sha256: undefined }) })}>
        <option value="file">文件</option><option value="directory">目录</option><option value="symbol">符号</option>
      </select></label>
      <label>路径<input aria-label="路径" value={link.path} required onChange={e => change(link.id, { path: e.target.value, file_sha256: undefined, source_snapshot_id: undefined, symbol_id: undefined })}/></label>
      {link.kind === 'symbol' && <label>符号名<input aria-label="符号名" value={link.symbol_name ?? ''} onChange={e => change(link.id, { symbol_name: e.target.value || undefined, symbol_id: undefined })}/></label>}
      {link.kind !== 'directory' && <>
        <label>起始行<input aria-label="起始行" type="number" min={1} value={link.start_line ?? ''} onChange={e => change(link.id, { start_line: e.target.value ? Number(e.target.value) : undefined })}/></label>
        <label>结束行<input aria-label="结束行" type="number" min={link.start_line ?? 1} value={link.end_line ?? ''} onChange={e => change(link.id, { end_line: e.target.value ? Number(e.target.value) : undefined })}/></label>
      </>}
      <button type="button" onClick={() => onChange(links.filter(item => item.id !== link.id))}>移除关联</button>
    </fieldset>)}
    <button type="button" onClick={() => onChange([...links, { id: crypto.randomUUID(), kind: 'file', path: '', origin: 'manual' }])}>添加代码关联</button>
  </fieldset>;
}
