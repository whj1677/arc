import React from 'react';
import type {WorkspaceData} from '../shared';
import {sceneStatus} from './presentation';
// This is a navigator built from the user's real feature/scenario records, not
// an analysis graph or generated business model.
export function WalkNavigator({data,projectId,title,selected,choose,zoom}:{data:WorkspaceData;projectId:string;title:string;selected:string;choose:(id:string)=>void;zoom:number}){
 const project=data.projects.find(p=>p.project_id===projectId);
 const scenes=data.scenarios.filter(s=>s.project_id===projectId&&!s.archived&&s.scenario_id!==project?.overview_scenario_id);
 const features=data.features.filter(f=>f.project_id===projectId&&!f.archived&&scenes.some(s=>s.feature_id===f.feature_id)).sort((a,b)=>a.sort_order-b.sort_order);
 return <section className="walk-navigator composition" style={{fontSize:16*zoom}} data-zoom-surface aria-label="功能场景导航导图"><div className="composition-intro"><h2>先选要理解的功能</h2><p>选择一个功能或场景，进入对应时间线。这里是导航索引，不是业务执行图。</p></div><div className="walk-nav-tree"><div className="composition-root" data-zoom-anchor><small>当前工程</small><strong>{title}</strong></div><div className="walk-nav-features">{features.map((feature,index)=>{
  const entries=scenes.filter(s=>s.feature_id===feature.feature_id).sort((a,b)=>a.sort_order-b.sort_order),overall=entries.find(s=>s.kind==='feature_overview')||entries[0];
  return <div className="walk-nav-feature" style={{'--branch-color':['#8dcbbb','#c0b0e8','#ddbf8f','#98bedb'][index%4]} as React.CSSProperties} key={feature.feature_id}><button className="composition-topic" data-feature-id={feature.feature_id} data-zoom-anchor onClick={()=>choose(overall.scenario_id)}><strong>{feature.name}</strong><small>看整体时间线 →</small></button><details open={entries.some(s=>s.scenario_id===selected)||undefined}><summary>{entries.length} 个走读入口</summary><div className="walk-nav-scenes">{entries.map(scene=><button key={scene.scenario_id} className={`walk-nav-scene ${selected===scene.scenario_id?'selected':''}`} data-scenario-id={scene.scenario_id} data-zoom-anchor onClick={()=>choose(scene.scenario_id)}><strong>{scene.kind==='feature_overview'?'整体流程':scene.title}</strong><small>{sceneStatus(data.runs.filter(r=>r.binding.scenario_id===scene.scenario_id),data.explanations.some(e=>e.scenario_id===scene.scenario_id))}</small></button>)}</div></details></div>;
 })}{!features.length&&<p className="muted">还没有功能。先添加一个功能，再提出要理解的问题。</p>}</div></div></section>;
}
