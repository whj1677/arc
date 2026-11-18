import React,{useState,useEffect} from 'react';
import type {Explanation,WorkspaceData} from '../shared';
import './feature-catalog.css';
import {SourceExcerpt} from './SourceExcerpt';
import {analysisModes,isAnalysisMode,waitingForAgent,type AnalysisMode} from './discovery-state';
import {discoveredFeature} from '../discovered-feature';
export function AnalysisModePicker({label,ariaLabel=label,mode,setMode}:{label:string;ariaLabel?:string;mode:AnalysisMode;setMode:(mode:AnalysisMode)=>void}){
  return <label>{label}<select aria-label={ariaLabel} value={mode} onChange={event=>{
    const next=event.target.value;if(isAnalysisMode(next))setMode(next);
  }}>{Object.entries(analysisModes).map(([id,item])=><option value={id} key={id}>{item.option}</option>)}</select></label>;
}
export function FeatureCatalog({explanation,data,projectId,busy,open,discover,mode,setMode}:{explanation?:Explanation;data:WorkspaceData;projectId:string;busy:boolean;open:(id:string)=>void;discover:()=>void;mode:AnalysisMode;setMode:(mode:AnalysisMode)=>void}){
  const result=explanation?.result,catalog=result?.feature_catalog;
  const [search,setSearch]=useState('');
  useEffect(()=>setSearch(''),[projectId]);
  const query=search.trim().toLocaleLowerCase();
  const groups=catalog?.groups.map(group=>({...group,node_ids:group.node_ids.filter(id=>{const node=result!.nodes.find(n=>n.node_id===id);return !query||!!node&&`${group.label} ${node.label} ${node.description}`.toLocaleLowerCase().includes(query);})})).filter(group=>group.node_ids.length)||[];
  const readings=new Map(catalog?.readings?.map(item=>[item.node_id,item]));
  const readyCount=catalog?.groups.flatMap(g=>g.node_ids).filter(id=>readings.get(id)?.steps.length).length??0;
  const count=catalog?.groups.reduce((sum,g)=>sum+g.node_ids.length,0)||0;
  return <section className="feature-catalog" aria-label="已发现的功能目录">
    <div className="feature-catalog-heading"><div><span className="eyebrow">先看全貌 · 按需深入</span><h2>系统有哪些功能</h2><p>打开功能即可阅读工程分析已查明的内容，并核对对应源码。</p></div>{!catalog&&<button disabled={busy} onClick={discover}>{mode==='mcp'?'准备功能发现任务':'在 ARC 内发现功能'}</button>}</div>
    {catalog?<><div className="discovery-coverage"><strong>已发现 {count} 项功能 · {readyCount} 项已保存首轮步骤</strong><details><summary>查看目录来源与覆盖范围</summary><p>{catalog.scope}</p></details>{explanation?.source_status!=='current'&&<small className="warning">来源已有变化：这是已保存的目录，详细分析仍须核对绑定快照。</small>}</div>
    <div className="discovery-mode"><AnalysisModePicker label="深入分析方式" ariaLabel="功能展开方式" mode={mode} setMode={setMode}/><small>{analysisModes[mode].description}</small></div>
    <div className="catalog-search"><input type="search" aria-label="搜索工程功能" placeholder="按功能名称或用途查找…" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button onClick={()=>setSearch('')}>清除搜索</button>}<small>{query?`找到 ${groups.reduce((n,g)=>n+g.node_ids.length,0)} 项功能`:'点击功能卡片即可继续'}</small></div>
    {!groups.length&&(count?<p role="status">没有匹配的功能，试试用途关键词或清除搜索。</p>:<section className="discovery-empty"><h3>本轮尚未确认功能入口</h3><p>{catalog.scope}</p>{Array.from(new Set([...result!.coverage.unresolved_scope,...result!.gaps.map(gap=>gap.question)])).filter(Boolean).map(reason=><p key={reason}>{reason}</p>)}</section>)}
    <div className="capability-groups">{groups.map((group,i)=><section className="capability-group" key={i}><h3>{group.label}<small>{group.node_ids.length}</small></h3>{group.node_ids.map(id=>{
      const node=result!.nodes.find(n=>n.node_id===id);if(!node)return null;
      const feature=discoveredFeature(data.features,data.explanations,result!,id,data.projects.find(p=>p.project_id===projectId)?.snapshot_id||'');
      const scene=data.scenarios.find(s=>s.feature_id===feature?.feature_id&&s.kind==='feature_overview');
      const saved=data.explanations.some(e=>e.scenario_id===scene?.scenario_id&&e.result.binding.question_revision_id===scene?.question_revision_id&&e.result.binding.source_snapshot_id===data.projects.find(p=>p.project_id===projectId)?.snapshot_id);
      const run=data.runs.filter(r=>r.binding.scenario_id===scene?.scenario_id&&!r.reading_question_id).at(-1);
      const running=run&&['running','queued','validating','cancel_requested'].includes(run.status);
      const archived=feature?.archived||scene?.archived;
      return <button className="capability-card" data-capability-id={id} key={id} disabled={busy||archived} onClick={()=>open(id)}><span><strong>{node.label}</strong><small title={node.description}>{node.description}</small></span><span className="capability-state">{archived?'已归档':saved?'继续走读':readings.get(id)?.steps.length?'阅读流程':running?'分析中':waitingForAgent(data,scene?.scenario_id||'')?'等待领取':run?({failed:'失败 · 查看记录',blocked_external:'连接受阻',cancelled:'已停止',unknown:'状态待核查'}[run.status]||'查看记录'):'查看已有线索'}<b aria-hidden="true">↗</b></span></button>;
    })}</section>)}</div></>:<div className="discovery-empty"><h3>尚未生成工程功能目录</h3><p>分析工程后，这里展示已查明的功能入口、主要处理步骤、结果与源码依据，未查明的部分会标出。</p><p className="muted">{data.features.some(f=>f.project_id===projectId)?'原有手动功能和分析仍保留在左侧，不代表工程的全部功能。':'尚未分析目录，不按文件名猜测业务功能。'}</p></div>}
  </section>;
}


export function CatalogFeatureReading({explanation,nodeId,currentSnapshot,sourceId,onSource}:{explanation:Explanation;nodeId:string;currentSnapshot:string;sourceId:string;onSource:(id:string)=>void}){
  const result=explanation.result;
  const node=result.nodes.find(n=>n.node_id===nodeId);
  const reading=result.feature_catalog?.readings?.find(item=>item.node_id===nodeId);
  if(!node)return null;
  const sources=result.evidence.filter(e=>e.source_snapshot_id===result.binding.source_snapshot_id);
  const selected=sources.find(e=>e.evidence_id===sourceId);
  const references=(ids:readonly string[])=>sources.filter(e=>ids.includes(e.evidence_id)).map(e=>
    <button key={e.evidence_id} aria-pressed={sourceId===e.evidence_id} onClick={()=>onSource(e.evidence_id)}>
      {e.path} · L{e.line_start}{e.line_end!==e.line_start?'–'+e.line_end:''}
    </button>);
  return <article className="catalog-reading" aria-label="工程分析中的功能说明">
    <header><small>{result.binding.source_snapshot_id!==currentSnapshot?'历史工程分析':'工程分析'} · {reading?.steps.length?'首轮走读':'功能线索'}</small><h2>{node.label}</h2><p>{node.description}</p></header>
    {reading?.entry&&<div className="catalog-reading-fact"><strong>触发入口</strong><span>{reading.entry}</span></div>}
    {!!reading?.steps.length&&<section><h3>处理过程</h3><ol className="catalog-reading-steps">{reading.steps.map((step,index)=>
      <li key={index}><p>{step.text}</p><div className="catalog-reading-refs">{references(step.evidence_ids)}</div></li>)}</ol></section>}
    {reading?.outcome&&<div className="catalog-reading-fact"><strong>处理结果</strong><span>{reading.outcome}</span></div>}
    {reading?.boundary?<p className="catalog-reading-boundary"><strong>覆盖边界</strong> {reading.boundary}</p>:!reading?.steps.length&&<p className="catalog-reading-boundary">这份目录只保存了用途与发现依据。可通过「深入分析功能」补充业务流程和调用细节。</p>}
    <section><h3>功能来源</h3><div className="catalog-reading-refs">{references(node.evidence_ids)}</div></section>
    {selected&&<section className="catalog-reading-source"><button onClick={()=>onSource('')}>收起源码</button><SourceExcerpt key={selected.evidence_id} evidence={selected}/></section>}
  </article>;
}
