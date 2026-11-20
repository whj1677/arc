import React, { useMemo, useState } from 'react';
import type { SourceFile } from '../shared';
import { fileIndex, type FileTopic, type SourceCoverage } from './file-map';

interface FileMapProps {
  files: readonly SourceFile[];
  analyzedPaths: SourceCoverage;
  title: string;
  expanded: readonly string[];
  toggle: (path: string) => void;
  selected: string;
  select: (path: string) => void;
  zoom: number;
  search: string;
}

export function FileMap({ files, analyzedPaths, title, expanded, toggle, selected, select, zoom, search }: FileMapProps) {
  const { root } = useMemo(() => fileIndex(files, analyzedPaths), [files, analyzedPaths]);
  const [analyzedOnly, setAnalyzedOnly] = useState(false);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const filterAnalyzed = analyzedOnly && analyzedPaths.size > 0;
  const query = search.trim().toLowerCase();
  const autoExpand = filterAnalyzed || !!query;
  let visible = 0;

  const matches = (topic: FileTopic): boolean =>
    ((!filterAnalyzed || analyzedPaths.has(topic.path) || topic.analyzedCount > 0) &&
      (!query || topic.path.toLowerCase().includes(query))) || topic.children.some(matches);

  const renderChildren = (topic: FileTopic, depth: number): React.ReactNode => {
    const children = topic.children.filter(matches);
    const limit = filterAnalyzed ? children.length : limits[topic.path] ?? (topic.path ? 40 : 80);
    return (
      <>
        {children.slice(0, limit).map(child => renderTopic(child, depth))}
        {children.length > limit && (
          <button className="filemap-more" onClick={() => setLimits(previous => ({ ...previous, [topic.path]: limit + 40 }))}>
            再显示 40 项 · 余 {children.length - limit}
          </button>
        )}
      </>
    );
  };

  function renderRow(topic: FileTopic, label: string) {
    const analyzed = analyzedPaths.get(topic.path);
    return (
      <button
        className={`filemap-select${selected === topic.path ? ' selected' : ''}${analyzed ? ' is-analyzed' : ''}`}
        data-file-path={topic.path}
        data-file-kind={topic.folder ? 'folder' : 'file'}
        data-zoom-anchor
        onClick={() => select(topic.path)}
      >
        <span className="filemap-icon" aria-hidden="true" />
        <strong>{label}</strong>
        {topic.folder && <small aria-label={`${topic.count} 个文本文件`}>{topic.count}</small>}
        {analyzed ? (
          <span className="filemap-badge">{analyzed === 'explained' ? '已解释' : '已引用'}</span>
        ) : topic.folder && topic.analyzedCount > 0 && (
          <span className="filemap-badge">{topic.analyzedCount}/{topic.count} 已涉及</span>
        )}
      </button>
    );
  }

  function renderTopic(topic: FileTopic, depth: number): React.ReactNode {
    if (!filterAnalyzed && ++visible > 180) return null;
    const canExpand = topic.folder && (filterAnalyzed || depth < 24);
    const open = canExpand && (autoExpand || expanded.includes(topic.path));
    return (
      <div className="filemap-branch" key={topic.path}>
        <div className="filemap-topic">
          {canExpand && (
            <button
              className="filemap-fold"
              aria-label={`${open ? '收起' : '展开'}文件夹 ${topic.path}`}
              aria-expanded={open}
              disabled={autoExpand}
              onClick={() => toggle(topic.path)}
            >
              {open ? '▾' : '▸'}
            </button>
          )}
          {renderRow(topic, topic.name)}
        </div>
        {open && <div className="filemap-children">{renderChildren(topic, depth + 1)}</div>}
      </div>
    );
  }

  return (
    <section className="file-mindmap" style={{ fontSize: 13 * zoom }} data-zoom-surface aria-label="源码目录">
      <h2>源码目录</h2>
      {analyzedPaths.size > 0 && (
        <div className="filemap-filters" role="group" aria-label="源码目录筛选">
          <button aria-pressed={!filterAnalyzed} onClick={() => setAnalyzedOnly(false)}>全部文件（{root.count}）</button>
          <button aria-pressed={filterAnalyzed} onClick={() => setAnalyzedOnly(true)}>已涉及（{root.analyzedCount}）</button>
        </div>
      )}
      <div className="filemap-tree">
        <div className="filemap-root">{renderRow(root, title)}</div>
        <div className="filemap-children">{renderChildren(root, 0)}</div>
        {!root.children.some(matches) && <p className="filemap-empty">{query || filterAnalyzed ? '没有匹配的文件' : '当前快照没有索引到文本文件'}</p>}
      </div>
      {visible > 180 && <p className="warning">当前显示前 180 项，请收起部分目录或搜索具体路径。</p>}
    </section>
  );
}
