import React from 'react';
import type {Explanation,WorkspaceData} from '../shared';
import './feature-catalog.css';
import {waitingForAgent} from './discovery-state';
import {discoveredFeature} from '../discovered-feature';
export function FeatureCatalog({explanation,data,projectId,busy,open,discover,mode,setMode,provider}:{explanation?:Explanation;data:WorkspaceData;projectId:string;busy:boolean;open:(id:string)=>void;discover:()=>void;mode:string;setMode:(mode:string)=>void;provider:string}){
  const result=explanation?.result,catalog=result?.feature_catalog;
  const count=catalog?.groups.reduce((sum,g)=>sum+g.node_ids.length,0)||0;
  return <section className="feature-catalog" aria-label="已发现的功能目录">
    <div className="feature-catalog-heading"><div><span className="eyebrow">先看全貌 · 按需深入</span><h2>系统有哪些功能</h2><p>先浏览功能用途，选中一个后再展开流程、输入输出和失败处理。</p></div>{!catalog&&<button disabled={busy} onClick={discover}>让 Agent 发现功能</button>}</div>
    {catalog?<><div className="discovery-coverage"><strong>已发现 {count} 项功能 · {catalog.groups.length} 个分组</strong><details><summary>查看目录来源与覆盖范围</summary><p>{catalog.scope}</p></details>{explanation?.source_status!=='current'&&<small className="warning">来源已有变化：这是已保存的目录，详细分析仍须核对绑定快照。</small>}</div>
    <div className="discovery-mode"><label>首次展开时 <select aria-label="功能展开方式" value={mode} onChange={e=>setMode(e.target.value)}><option value="codex">Codex · 在 ARC 内分析</option><option value="mcp">外部 Agent · MCP 待领取</option></select></label><small>{mode==='codex'?'点击后启动本机 Codex 只读分析；进度和结果会回到 ARC。已有说明直接继续阅读。':'点击后准备本功能任务；需在已接入 Arc MCP 的外部对话中领取。ARC 不自动唤醒对话。'}</small></div>
    <div className="capability-groups">{catalog.groups.map((group,i)=><section className="capability-group" key={i}><h3>{group.label}<small>{group.node_ids.length}</small></h3>{group.node_ids.map(id=>{
      const node=result!.nodes.find(n=>n.node_id===id);if(!node)return null;
      const feature=discoveredFeature(data.features,data.explanations,result!,id,data.projects.find(p=>p.project_id===projectId)?.snapshot_id||'');
      const scene=data.scenarios.find(s=>s.feature_id===feature?.feature_id&&s.kind==='feature_overview');
      const saved=data.explanations.some(e=>e.scenario_id===scene?.scenario_id&&e.result.binding.question_revision_id===scene?.question_revision_id&&e.result.binding.source_snapshot_id===data.projects.find(p=>p.project_id===projectId)?.snapshot_id);
      const run=data.runs.filter(r=>r.binding.scenario_id===scene?.scenario_id&&!r.reading_question_id).at(-1);
      const running=run&&['running','queued','validating','cancel_requested'].includes(run.status);
      const archived=feature?.archived||scene?.archived;
      return <button className="capability-card" data-capability-id={id} key={id} disabled={busy||archived} onClick={()=>open(id)}><span><strong>{node.label}</strong><small title={node.description}>{node.description}</small></span><span className="capability-state">{archived?'已归档':running?'查看进度':waitingForAgent(data,scene?.scenario_id||'')?'等待 Agent 领取':saved?'查看详情':run?({failed:'失败 · 查看记录',blocked_external:'连接受阻',cancelled:'已停止',unknown:'状态待核查'}[run.status]||'查看记录'):'展开功能'}<b aria-hidden="true">↗</b></span></button>;
    })}</section>)}</div></>:<div className="discovery-empty"><h3>先发现功能，不必先知道名字</h3><p>Agent 将读取工程入口和导航，整理带来源依据的功能目录。首次只生成名称与用途，详细流程等你选择后再分析。</p><p className="muted">{data.features.some(f=>f.project_id===projectId)?'原有手动功能和分析仍保留在左侧，不代表工程的全部功能。':'尚未分析目录，不按文件名猜测业务功能。'}</p></div>}
  </section>;
}
