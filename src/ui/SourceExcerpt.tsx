import React,{useEffect,useState} from 'react';
import type {SourceEvidence} from '../shared';

/** Always read the evidence's frozen source, never the current workspace file. */
export function SourceExcerpt({evidence:e}:{evidence:SourceEvidence}){
  const [source,setSource]=useState<{text:string;content_sha256:string}|null>(null),[error,setError]=useState('');
  useEffect(()=>{let current=true;setSource(null);setError('');void window.arc.invoke<{text:string;content_sha256:string}>('source',{source_snapshot_id:e.source_snapshot_id,path:e.path}).then(value=>{if(current)setSource(value);}).catch(reason=>{if(current)setError(reason.message);});return()=>{current=false;};},[e.source_snapshot_id,e.path]);
  const start=Math.max(1,e.line_start-3),end=e.line_end+3;
  return <section className="question-source" aria-label="冻结源码依据"><strong>{e.path}:{e.line_start}–{e.line_end}</strong><small>冻结快照：{e.source_snapshot_id}</small><small>SHA-256：{e.content_sha256}</small>{error?<p role="alert">源码读取失败：{error}</p>:!source?<p role="status">正在读取冻结源码…</p>:source.content_sha256!==e.content_sha256?<p role="alert">源码哈希与引用不符，未展示为有效依据。</p>:<pre>{source.text.split(/\r\n|\n|\r/).slice(start-1,end).map((line,index)=><span className={start+index>=e.line_start&&start+index<=e.line_end?'highlight':''} key={index}><b>{start+index}</b>{line}{'\n'}</span>)}</pre>}</section>;
}
