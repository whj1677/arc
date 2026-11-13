import React,{useMemo,useState} from 'react';
import type {SourceFile} from '../shared';
import {fileIndex} from './file-map';
import type {FileTopic} from './file-map';
export function FileMap({files,title,expanded,toggle,selected,select,zoom,search}:{files:readonly SourceFile[];title:string;expanded:readonly string[];toggle:(path:string)=>void;selected:string;select:(path:string)=>void;zoom:number;search:string}){
 const {root}=useMemo(()=>fileIndex(files),[files]),[limits,setLimits]=useState<Record<string,number>>({});let visible=0;
 const query=search.trim().toLowerCase();const matches=(n:FileTopic):boolean=>!query||n.path.toLowerCase().includes(query)||n.children.some(matches);
 const roots=root.children.filter(matches),rootLimit=limits['']||80;
 const render=(topic:FileTopic,depth=0):React.ReactNode=>{
  if(++visible>180)return null;
  const children=topic.children.filter(matches),open=topic.folder&&(!!query||expanded.includes(topic.path));
  const limit=limits[topic.path]||40;
  return <div className="filemap-branch" key={topic.path}><div className="filemap-topic"><button className={`filemap-select ${selected===topic.path?'selected':''}`} data-file-path={topic.path} data-file-kind={topic.folder?'folder':'file'} data-zoom-anchor onClick={()=>select(topic.path)}><span aria-hidden="true">{topic.folder?'▱':'▤'}</span><strong>{topic.name}</strong>{topic.folder&&<small>{topic.count}</small>}</button>{topic.folder&&<button className="composition-fold" aria-label={`${open?'收起':'展开'}文件夹 ${topic.path}`} aria-expanded={open} onClick={()=>toggle(topic.path)}>{open?'−':'＋'}</button>}</div>{open&&depth<24&&<div className="filemap-children">{children.slice(0,limit).map(n=>render(n,depth+1))}{children.length>limit&&<button className="filemap-more" onClick={()=>setLimits(x=>({...x,[topic.path]:limit+40}))}>再显示 40 项 · 余 {children.length-limit}</button>}</div>}</div>;
 };
 return <section className="file-mindmap composition" style={{fontSize:16*zoom}} data-zoom-surface aria-label="文件结构导图"><div className="composition-intro"><h2>文件结构</h2><p>点击文件夹或文件，右侧查看用途摘要；用＋展开下一级。索引来自当前冻结快照。</p></div><div className="filemap-tree"><button className={`composition-root ${!selected?'selected':''}`} data-file-path="" data-file-kind="folder" data-zoom-anchor onClick={()=>select('')}><small>工程根目录</small><strong>{title}</strong><small>{files.length} 个文本文件</small></button><div className="filemap-children">{roots.slice(0,rootLimit).map(n=>render(n))}{roots.length>rootLimit&&<button className="filemap-more" onClick={()=>setLimits(x=>({...x,'':rootLimit+40}))}>再显示 40 项 · 余 {roots.length-rootLimit}</button>}</div></div>{visible>180&&<p className="warning">当前显示前 180 个可见主题，请收起部分目录或搜索具体路径。</p>}<p className="composition-boundary">目录关系来自实际文件索引；用途摘要需 Agent 读取对应源码后单独说明。未分析不会按名称生成职责。</p></section>;
}
