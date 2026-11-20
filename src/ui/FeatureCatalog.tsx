import React,{useState,useEffect} from 'react';
import type {Explanation,WorkspaceData} from '../shared';
import {explanationFreshness} from '../freshness';
import './feature-catalog.css';
import {SourceExcerpt} from './SourceExcerpt';
import {analysisModes,catalogGraphState,isAnalysisMode,type AnalysisMode} from './discovery-state';
export function AnalysisModePicker({label,ariaLabel=label,mode,setMode}:{label:string;ariaLabel?:string;mode:AnalysisMode;setMode:(mode:AnalysisMode)=>void}){
  return <label>{label}<select aria-label={ariaLabel} value={mode} onChange={event=>{
    const next=event.target.value;if(isAnalysisMode(next))setMode(next);
  }}>{Object.entries(analysisModes).map(([id,item])=><option value={id} key={id}>{item.option}</option>)}</select></label>;
}
export function FeatureCatalog({explanation,data,projectId,busy,open,discover,mode,setMode,fillPending}:{explanation?:Explanation;data:WorkspaceData;projectId:string;busy:boolean;open:(id:string)=>void;discover:()=>void;mode:AnalysisMode;setMode:(mode:AnalysisMode)=>void;fillPending?:(nodeIds:string[])=>void}){
  const result=explanation?.result,catalog=result?.feature_catalog;
  const project=data.projects.find(item=>item.project_id===projectId);
  const checked=data.project_freshness?.[projectId];
  const changedFiles=checked && checked.snapshot_id===project?.snapshot_id ? checked.changed_files : [];
  const [search,setSearch]=useState('');
  useEffect(()=>setSearch(''),[projectId]);
  const query=search.trim().toLocaleLowerCase();
  const groups=catalog?.groups.map(group=>({...group,node_ids:group.node_ids.filter(id=>{const node=result!.nodes.find(n=>n.node_id===id);return !query||!!node&&`${group.label} ${node.label} ${node.description}`.toLocaleLowerCase().includes(query);})})).filter(group=>group.node_ids.length)||[];
  const readings=new Map(catalog?.readings?.map(item=>[item.node_id,item]));
  const ids=[...new Set(catalog?.groups.flatMap(g=>g.node_ids))];
  const graphs=new Map(ids.map(id=>[id,catalogGraphState(data,explanation!,id)]));
  const pendingIds=ids.filter(id=>{
    const graph=graphs.get(id)!;
    return !graph.archived&&!graph.ready&&!['已排队','等待领取','分析中','正在校验','正在停止'].includes(graph.status);
  });
  const count=ids.length,items=[...graphs.values()],readyCount=items.filter(item=>item.ready&&!item.archived).length;
  const counts=new Map<string,number>();
  for(const item of items){
    const label=item.archived?'已归档':item.status||(!item.ready?'仅有首轮线索':'');
    if(label)counts.set(label,(counts.get(label)||0)+1);
  }
  return <section className="feature-catalog" aria-label="已发现的功能目录">
    <div className="feature-catalog-heading"><div><h2>系统有哪些功能</h2><p>工程分析会逐项核对函数调用。打开已就绪的功能可直接查看调用链和调用时间图，分析期间可先阅读已有步骤与源码。</p></div>{!catalog&&<button disabled={busy} onClick={discover}>{mode==='mcp'?'准备功能发现任务':'在 ARC 内发现功能'}</button>}</div>
    {catalog?<><div className="discovery-coverage"><div className="row between"><strong>已发现 {count} 项功能 · 双图就绪 {readyCount}/{count}</strong>
      {pendingIds.length>0&&fillPending&&mode!=='mcp'&&(
        <button className="primary" disabled={busy} onClick={()=>fillPending(pendingIds)}>
          {explanation?.source_status==='current' ? `补齐未就绪双图（${pendingIds.length}）` : `按原快照补齐双图（${pendingIds.length}）`}
        </button>
      )}</div>
      {!!counts.size&&<p aria-label="功能分析状态">{[...counts].map(([label,n])=>`${label} ${n}`).join(' · ')}</p>}
      <details><summary>查看目录来源与覆盖范围</summary><p>{catalog.scope}</p></details>{explanation?.source_status!=='current'&&<small className="warning">来源已有变化：这是已保存的目录，详细分析仍须核对绑定快照。</small>}</div>
    <div className="discovery-mode"><AnalysisModePicker label="补查分析方式" ariaLabel="功能展开方式" mode={mode} setMode={setMode}/><small>{analysisModes[mode].description}</small></div>
    <div className="catalog-search"><input type="search" aria-label="搜索工程功能" placeholder="按功能名称或用途查找…" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button onClick={()=>setSearch('')}>清除搜索</button>}<small>{query?`找到 ${groups.reduce((n,g)=>n+g.node_ids.length,0)} 项功能`:'点击功能卡片即可继续'}</small></div>
    {!groups.length&&(count?<p role="status">没有匹配的功能，试试用途关键词或清除搜索。</p>:<section className="discovery-empty"><h3>本轮尚未确认功能入口</h3><p>{catalog.scope}</p>{Array.from(new Set([...result!.coverage.unresolved_scope,...result!.gaps.map(gap=>gap.question)])).filter(Boolean).map(reason=><p key={reason}>{reason}</p>)}</section>)}
    <div className="capability-groups">{groups.map((group,i)=><section className="capability-group" key={i}><h3>{group.label}<small>{group.node_ids.length}</small></h3>{group.node_ids.map(id=>{
      const node=result!.nodes.find(n=>n.node_id===id);if(!node)return null;
      const graph=graphs.get(id)!;
      const affected=graph.ready && project && explanationFreshness(graph.ready,project.snapshot_id,changedFiles).kind==='affected';
      const label=graph.archived?'已归档':[affected?'所引源码已变':graph.ready?'双图就绪':'',graph.status].filter(Boolean).join(' · ')||(readings.get(id)?.steps.length?'阅读首轮步骤':'查看已有线索');
      return <button className="capability-card" data-capability-id={id} key={id} disabled={busy||graph.archived} onClick={()=>open(id)}><span><strong>{node.label}</strong><small title={node.description}>{node.description}</small></span><span className={`capability-state${affected ? ' affected' : ''}`}>{label}<b aria-hidden="true">↗</b></span></button>;
    })}</section>)}</div></>:<div className="discovery-empty"><h3>尚未生成工程功能目录</h3><p>分析工程后，这里展示已查明的功能入口、主要处理步骤、结果与源码依据，未查明的部分会标出。</p><p className="muted">{data.features.some(f=>f.project_id===projectId)?'原有手动功能和分析仍保留在左侧，不代表工程的全部功能。':'尚未分析目录，不按文件名猜测业务功能。'}</p></div>}
  </section>;
}


export function CatalogFeatureReading({explanation,nodeId,currentSnapshot,sourceId,onSource,functionActions}:{explanation:Explanation;nodeId:string;currentSnapshot:string;sourceId:string;onSource:(id:string)=>void;functionActions?:React.ReactNode}){
  const result=explanation.result;
  const node=result.nodes.find(n=>n.node_id===nodeId);
  const reading=result.feature_catalog?.readings?.find(item=>item.node_id===nodeId);
  if(!node)return null;
  const evidenceIds=new Set([...node.evidence_ids,...(reading?.steps.flatMap(step=>step.evidence_ids)??[])]);
  const sources=result.evidence.filter(e=>e.source_snapshot_id===result.binding.source_snapshot_id&&evidenceIds.has(e.evidence_id));
  const selected=sources.find(e=>e.evidence_id===sourceId);
  const references=(ids:readonly string[])=>sources.filter(e=>ids.includes(e.evidence_id)).map(e=>
    <button key={e.evidence_id} aria-pressed={sourceId===e.evidence_id} onClick={()=>onSource(e.evidence_id)}>
      {e.path} · L{e.line_start}{e.line_end!==e.line_start?'–'+e.line_end:''}
    </button>);
  return <article className="catalog-reading" aria-label={functionActions?'首轮函数走读线索':'工程分析中的功能说明'}>
    <header><small>{result.binding.source_snapshot_id!==currentSnapshot?'历史工程分析':'工程分析'} · {functionActions?'首轮线索':reading?.steps.length?'首轮走读':'功能线索'}</small>
      <h2>{functionActions?'函数调用图尚未生成':node.label}</h2>
      <p>{functionActions?`下方保留了工程全貌中「${node.label}」的首轮线索和源码依据。`:node.description}</p>
    </header>
    {functionActions}
    {reading?.entry&&<div className="catalog-reading-fact"><strong>触发入口</strong><span>{reading.entry}</span></div>}
    {!!reading?.steps.length&&<section><h3>{functionActions?'已记录的处理步骤':'处理过程'}</h3><ol className="catalog-reading-steps">{reading.steps.map((step,index)=>
      <li key={index}><p>{step.text}</p><div className="catalog-reading-refs">{references(step.evidence_ids)}</div></li>)}</ol></section>}
    {reading?.outcome&&<div className="catalog-reading-fact"><strong>处理结果</strong><span>{reading.outcome}</span></div>}
    {reading?.boundary?<p className="catalog-reading-boundary"><strong>覆盖边界</strong> {reading.boundary}</p>:!reading?.steps.length&&<p className="catalog-reading-boundary">这份目录只保存了用途与发现依据。</p>}
    <section><h3>功能来源</h3><div className="catalog-reading-refs">{references(node.evidence_ids)}</div></section>
    {selected&&<section className="catalog-reading-source"><button onClick={()=>onSource('')}>收起源码</button><SourceExcerpt key={selected.evidence_id} evidence={selected}/></section>}
  </article>;
}
