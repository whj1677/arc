import React, { useEffect, useState } from 'react';
import type { CodeIndexSummary } from '../shared';

type OpenFile = (path: string) => void;
type BrowserOptions = { openFile?: OpenFile; search?: string };

function commonDirectoryDepth(modules: CodeIndexSummary['modules']) {
  const paths = modules.map(module => module.dir.split('/'));
  const first = paths[0] ?? [];
  const different = first.findIndex((part, depth) => paths.some(parts => parts[depth] !== part));
  return different < 0 ? first.length : different;
}

export function CodeModules({ snapshotId, openFile, search }: { snapshotId: string } & BrowserOptions) {
  const [summary, setSummary] = useState<CodeIndexSummary>();
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setSummary(undefined);
    setError('');
    window.arc.invoke<CodeIndexSummary>('code_index_summary', {source_snapshot_id: snapshotId}).then(
      value => { if (current) setSummary(value); },
      reason => { if (current) setError(reason.message); },
    );
    return () => { current = false; };
  }, [snapshotId]);
  if (error) return <p role="alert">读取冻结快照的代码索引失败：{error}</p>;
  if (!summary) return <p role="status">正在读取冻结快照的代码索引…</p>;
  return <CodeModuleBrowser key={snapshotId} summary={summary} openFile={openFile} search={search}/>;
}

export function CodeModuleBrowser({ summary, openFile, search = '' }: { summary: CodeIndexSummary } & BrowserOptions) {
  const [selectedDir, selectDir] = useState('');
  const query = search.trim().toLowerCase();
  const modules = query ? summary.modules.filter(module =>
    [module.dir, ...module.files, ...module.key_symbols].some(text => text.toLowerCase().includes(query))
  ) : summary.modules;
  const selected = modules.find(module => module.dir === selectedDir);
  const visibleDirs = new Set(modules.map(module => module.dir));
  const edges = summary.module_edges.filter(edge => selected
    ? edge.from === selected.dir || edge.to === selected.dir : visibleDirs.has(edge.from) || visibleDirs.has(edge.to));
  const prefixDepth = commonDirectoryDepth(summary.modules);
  const groups = new Map<string, CodeIndexSummary['modules']>();
  for (const module of [...modules].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const parts = module.dir.split('/').slice(prefixDepth);
    const root = parts[0] === 'src' && parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0] ?? module.dir;
    const group = groups.get(root);
    if (group) group.push(module);
    else groups.set(root, [module]);
  }
  const sourceGroupsFirst = [...groups].sort(([a], [b]) => Number(b.startsWith('src/')) - Number(a.startsWith('src/')));
  const displayDir = (dir: string) => dir === '.' ? '工程根目录' : dir;
  return <section className="code-module-browser" aria-label="代码模块依赖（静态索引）">
    <p className="code-module-totals">已索引 <b>{summary.modules.length}</b> 个目录 · <b>{summary.total_files}</b> 个文件 · <b>{summary.total_symbols}</b> 个符号 · <b>{summary.total_calls}</b> 处调用</p>
    {!groups.size ? <p>{summary.modules.length ? '没有匹配的目录、文件或符号。' : '此快照中没有可索引的源码文件。'}</p> :
      <div className="code-module-layout">
        <section className="code-module-directory" aria-label="源码目录">
          <h3>源码目录</h3>
          {sourceGroupsFirst.map(([root, modules]) => <details className="code-module-group" open key={root}>
            <summary>{displayDir(root)} <small>{modules.length} 个目录</small></summary>
            {modules.map(module => <button type="button" key={module.dir} data-module-dir={module.dir} data-zoom-anchor
              aria-pressed={module.dir === selectedDir} className="code-module-choice"
              onClick={() => selectDir(module.dir === selectedDir ? '' : module.dir)}>
              <strong>{displayDir(module.dir)}</strong>
              <small>{module.file_count} 个文件 · {module.symbol_count} 个符号</small>
              {module.key_symbols.length > 0 && <code>{module.key_symbols.slice(0, 3).join(' · ')}</code>}
            </button>)}
          </details>)}
        </section>
        <section className="code-module-dependencies" aria-label="模块调用和源码文件">
          <div className="code-module-title"><h3>{selected ? displayDir(selected.dir) : '跨目录调用'}</h3>
            {selected && <button type="button" onClick={() => selectDir('')}>显示全部调用</button>}
          </div>
          {selected && <div className="code-module-source">
            {selected.key_symbols.length > 0 && <><h4>主要符号</h4><p>{selected.key_symbols.map(name => <code key={name}>{name}</code>)}</p></>}
            <h4>源码文件</h4>
            <ul>{selected.files.map(file => <li key={file}>{openFile ?
              <button type="button" data-zoom-anchor title={'打开冻结源码 ' + file} onClick={() => openFile(file)}>{file}</button> : file}</li>)}</ul>
          </div>}
          {selected && <h4>关联的跨目录调用</h4>}
          <p className="code-module-note">按已解析的静态调用位置计数。选择目录可查看相关调用和源码。</p>
          {edges.length > 0 ? <table className="code-module-edges">
            <thead><tr><th scope="col">调用方</th><th scope="col">被调用方</th><th scope="col">调用点</th></tr></thead>
            <tbody>{edges.map(edge => <tr key={JSON.stringify([edge.from, edge.to])} data-module-from={edge.from} data-module-to={edge.to}>
              {[edge.from, edge.to].map(dir => <td key={dir}>{visibleDirs.has(dir) ?
                <button type="button" aria-pressed={dir === selected?.dir} onClick={() => selectDir(dir)}>{displayDir(dir)}</button>
                : displayDir(dir)}</td>)}
              <td>{edge.count}</td>
            </tr>)}</tbody>
          </table> : <p>索引未解析到{selected ? '与此目录相关的' : ''}跨目录调用。</p>}
        </section>
      </div>}
  </section>;
}
