import React,{useState,useEffect} from 'react';
import type {Explanation,WorkspaceData} from '../shared';
import {explanationFreshness} from '../freshness';
import {SourceExcerpt} from './SourceExcerpt';
import {analysisModes,catalogGraphState,isAnalysisMode,type AnalysisMode} from './discovery-state';
export function AnalysisModePicker({label,ariaLabel=label,mode,setMode}:{label:string;ariaLabel?:string;mode:AnalysisMode;setMode:(mode:AnalysisMode)=>void}){
  return <label>{label}<select aria-label={ariaLabel} value={mode} onChange={event=>{
    const next=event.target.value;if(isAnalysisMode(next))setMode(next);
  }}>{Object.entries(analysisModes).map(([id,item])=><option value={id} key={id}>{item.option}</option>)}</select></label>;
}
export function CatalogUnresolved({items,addFeatureFromScope}:{items:string[];addFeatureFromScope?:(item:string)=>void}){
  return <section className="catalog-unresolved" aria-label="未展开或待补充范围">
    <h3>未展开 / 待补充范围 <small>{items.length}</small></h3>
    <p>以下内容在首轮工程全貌中未完全展开；如需深入查证，可一键加入功能目录并生成双图。</p>
    <ul>{items.map((item,index)=><li key={index}>
      <span>{item}</span>
      {addFeatureFromScope&&<button type="button" className="secondary" onClick={()=>addFeatureFromScope(item)}>补充为新功能</button>}
    </li>)}</ul>
  </section>;
}

function isPending(graph:ReturnType<typeof catalogGraphState>){
  return !graph.archived&&!graph.ready&&!['已排队','等待领取','分析中','正在校验','正在停止'].includes(graph.status);
}

export function FeatureCatalog({explanation,data,projectId,busy,open,discover,mode,setMode,fillPending,cancelQueued,addFeatureFromScope}:{explanation?:Explanation;data:WorkspaceData;projectId:string;busy:boolean;open:(id:string)=>void;discover:()=>void;mode:AnalysisMode;setMode:(mode:AnalysisMode)=>void;fillPending?:(nodeIds:string[])=>void;cancelQueued?:(runIds:string[])=>void;addFeatureFromScope?:(item:string)=>void}){
  const result=explanation?.result,catalog=result?.feature_catalog;
  const unresolved=(result?.coverage.unresolved_scope||[]).map(item=>item.trim()).filter(Boolean);
  const project=data.projects.find(item=>item.project_id===projectId);
  const checked=data.project_freshness?.[projectId];
  const changedFiles=checked && checked.snapshot_id===project?.snapshot_id ? checked.changed_files : [];
  const [search,setSearch]=useState('');
  const [selectMode,setSelectMode]=useState(false);
  const [selectedIds,setSelectedIds]=useState<Set<string>>(new Set());

  function exitSelection(){
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function updateSelection(ids:string[],selected:boolean){
    setSelectedIds(previous=>{
      const next=new Set(previous);
      for(const id of ids){
        if(selected)next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  useEffect(()=>setSearch(''),[projectId]);
  useEffect(exitSelection,[projectId,explanation?.result_id]);
  const query=search.trim().toLocaleLowerCase();
  const nodes=new Map(result?.nodes.map(node=>[node.node_id,node]));
  const groups=catalog?.groups.map(group=>({...group,visibleIds:group.node_ids.filter(id=>{const node=nodes.get(id);return !query||!!node&&`${group.label} ${node.label} ${node.description}`.toLocaleLowerCase().includes(query);})})).filter(group=>group.visibleIds.length)||[];
  const readings=new Map(catalog?.readings?.map(item=>[item.node_id,item]));
  const ids=[...new Set(catalog?.groups.flatMap(g=>g.node_ids))];
  const graphs=new Map(ids.map(id=>[id,catalogGraphState(data,explanation!,id)]));
  const count=ids.length,items=[...graphs.values()],readyCount=items.filter(item=>item.ready&&!item.archived).length;
  const pendingIds=ids.filter(id=>isPending(graphs.get(id)!));
  const pendingSet=new Set(pendingIds);
  const visiblePendingIds=[...new Set(groups.flatMap(group=>group.visibleIds.filter(id=>pendingSet.has(id))))];
  const selectedPendingIds=[...selectedIds].filter(id=>pendingSet.has(id));
  const queuedRunIds=[...new Set(items.flatMap(({run})=>run?.status==='queued'?[run.binding.run_id]:[]))];
  const generate=mode==='mcp'?undefined:fillPending;
  const selecting=selectMode&&!!generate;
  const counts=new Map<string,number>();
  for(const item of items){
    const label=item.archived?'已归档':item.status||(!item.ready?'仅有首轮线索':'');
    if(label)counts.set(label,(counts.get(label)||0)+1);
  }
  return <section className="feature-catalog" aria-label="已发现的功能目录">
    <header className="feature-catalog-heading"><div><h2>系统有哪些功能</h2><p>从功能入口查看首轮步骤与源码，或展开函数调用链和时间图。</p></div>{!catalog&&<button disabled={busy} onClick={discover}>{mode==='mcp'?'准备功能发现任务':'在 ARC 内发现功能'}</button>}</header>
    {catalog?<><div className="discovery-coverage"><div className="discovery-coverage-row"><div className="catalog-progress"><strong>已发现 {count} 项功能 · 双图就绪 {readyCount}/{count}</strong>
      {count>0&&<progress aria-label="功能双图覆盖进度" value={readyCount} max={count}/>}</div>
      <div className="discovery-coverage-actions">
        {queuedRunIds.length>0&&cancelQueued&&<button className="secondary" disabled={busy} onClick={()=>cancelQueued(queuedRunIds)}>清空排队（{queuedRunIds.length}）</button>}
        {generate&&(selecting
          ? <button className="secondary" onClick={exitSelection}>退出批量选择</button>
          : pendingIds.length>0&&<>
            <button className="secondary" onClick={()=>setSelectMode(true)}>批量选择</button>
            {pendingIds.length<=8&&<button className="primary" disabled={busy} onClick={()=>generate(pendingIds)}>
              {explanation?.source_status==='current' ? `补齐未就绪双图（${pendingIds.length}）` : `按原快照补齐双图（${pendingIds.length}）`}
            </button>}
          </>)}
      </div></div>
      <details><summary>目录来源与覆盖范围</summary><p>{catalog.scope}</p>
        {!!counts.size&&<p aria-label="功能分析状态">{[...counts].map(([label,n])=>`${label} ${n}`).join(' · ')}</p>}
      </details>{explanation?.source_status!=='current'&&<small className="warning">来源已有变化，详细分析仍须核对绑定快照。</small>}</div>
    <div className="catalog-controls">
      <div className="catalog-search"><input type="search" aria-label="搜索工程功能" placeholder="按功能名称或用途查找…" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button onClick={()=>setSearch('')}>清除搜索</button>}</div>
      <div className="discovery-mode" title={analysisModes[mode].description}><AnalysisModePicker label="补查方式" ariaLabel="功能展开方式" mode={mode} setMode={next=>{if(next==='mcp')exitSelection();setMode(next);}}/></div>
    </div>
    {query&&<p role="status">找到 {groups.reduce((n,g)=>n+g.visibleIds.length,0)} 项功能</p>}
    {!groups.length&&(count?<p role="status">没有匹配的功能，试试用途关键词或清除搜索。</p>:<section className="discovery-empty"><h3>本轮尚未确认功能入口</h3><p>{catalog.scope}</p>{Array.from(new Set(result!.gaps.map(gap=>gap.question.trim()).filter(reason=>reason&&!unresolved.includes(reason)))).map(reason=><p key={reason}>{reason}</p>)}</section>)}
    {selecting&&generate&&<div className="catalog-batch-bar">
      <span role="status">已选 {selectedPendingIds.length} 项待生成</span>
      <div className="discovery-coverage-actions">
        <button className="secondary" disabled={!visiblePendingIds.length} onClick={()=>updateSelection(visiblePendingIds,true)}>全选当前（{visiblePendingIds.length}）</button>
        <button className="secondary" disabled={!selectedPendingIds.length} onClick={()=>setSelectedIds(new Set())}>清空选择</button>
        <button className="primary" disabled={busy||!selectedPendingIds.length} onClick={()=>{generate(selectedPendingIds);exitSelection();}}>生成已选双图（{selectedPendingIds.length}）</button>
      </div>
    </div>}
    <div className={`capability-groups${selecting?' is-selecting':''}`}>{groups.map((group,i)=>{
      const groupReadyCount=group.node_ids.filter(id=>{const graph=graphs.get(id)!;return graph.ready&&!graph.archived;}).length;
      const groupPendingIds=group.node_ids.filter(id=>pendingSet.has(id));
      const groupSelected=groupPendingIds.every(id=>selectedIds.has(id));
      return <section className="capability-group" key={i}>
        <h3><span>{group.label}</span><small>{groupReadyCount}/{group.node_ids.length}</small>
          {groupPendingIds.length>0&&generate&&(selecting
            ? <button className="secondary" onClick={()=>updateSelection(groupPendingIds,!groupSelected)}>{groupSelected?'取消本组':'全选本组'}</button>
            : <button className="secondary" disabled={busy} onClick={()=>generate(groupPendingIds)}>生成本组（{groupPendingIds.length}）</button>)}
        </h3>
        {group.visibleIds.map(id=>{
          const node=nodes.get(id);if(!node)return null;
          const graph=graphs.get(id)!;
          const affected=graph.ready && project && explanationFreshness(graph.ready,project.snapshot_id,changedFiles).kind==='affected';
          const label=graph.archived?'已归档':[affected?'所引源码已变':graph.ready?'双图就绪':'',graph.status].filter(Boolean).join(' · ')||(readings.get(id)?.steps.length?'阅读首轮步骤':'查看已有线索');
          const selectable=selecting&&pendingSet.has(id),checked=selectable&&selectedIds.has(id);
          const selectionClass=checked?' is-selected':selecting&&!selectable?' is-unselectable':'';
          return <button className={`capability-card${selectionClass}`} data-capability-id={id} key={id}
            disabled={selecting?!selectable:busy||graph.archived} aria-pressed={selectable?checked:undefined}
            onClick={()=>selecting?updateSelection([id],!checked):open(id)}>
            <strong>{node.label}</strong>
            <span className={`capability-state${affected ? ' affected' : ''}`}>{label}</span>
            <small title={node.description}>{node.description}</small>
            {selectable&&<span className="capability-check" aria-hidden="true">{checked?'✓':''}</span>}
          </button>;
        })}
      </section>;
    })}</div>
    {unresolved.length>0&&<CatalogUnresolved items={unresolved} addFeatureFromScope={busy?undefined:addFeatureFromScope}/>}</>:<div className="discovery-empty"><h3>尚未生成工程功能目录</h3><p>分析工程后，这里展示已查明的功能入口、主要处理步骤、结果与源码依据，未查明的部分会标出。</p><p className="muted">{data.features.some(f=>f.project_id===projectId)?'原有手动功能和分析仍保留在左侧，不代表工程的全部功能。':'尚未分析目录，不按文件名猜测业务功能。'}</p></div>}
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
  return <article className="catalog-reading" aria-label="工程分析中的功能说明">
    <header><small>{result.binding.source_snapshot_id!==currentSnapshot?'历史工程分析':'工程分析'} · {reading?.steps.length?'首轮走读':'功能线索'}</small>
      <h2>{node.label}</h2>
      <p>{node.description}</p>
    </header>
    {functionActions}
    {(reading?.entry||reading?.outcome)&&<dl className="catalog-reading-facts">
      {reading.entry&&<div><dt>触发入口</dt><dd>{reading.entry}</dd></div>}
      {reading.outcome&&<div><dt>处理结果</dt><dd>{reading.outcome}</dd></div>}
    </dl>}
    {!!reading?.steps.length&&<section><h3>处理步骤</h3><ol className="catalog-reading-steps">{reading.steps.map((step,index)=>
      <li key={index}><p>{step.text}</p><div className="catalog-reading-refs">{references(step.evidence_ids)}</div></li>)}</ol></section>}
    {(reading?.boundary||!reading?.steps.length)&&<aside className="catalog-reading-boundary"><strong>覆盖边界</strong><p>{reading?.boundary||'首轮尚未展开这项功能的完整处理步骤。'}</p></aside>}
    <section><h3>功能来源</h3><div className="catalog-reading-refs">{references(node.evidence_ids)}</div></section>
    {selected&&<section className="catalog-reading-source"><button onClick={()=>onSource('')}>收起源码</button><SourceExcerpt key={selected.evidence_id} evidence={selected}/></section>}
  </article>;
}
