import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CatalogUnresolved,FeatureCatalog} from '../src/ui/FeatureCatalog';
import type {AnalysisResult,Explanation,Feature,Run,Scenario,WorkspaceData} from '../src/shared';

const base=JSON.parse(fs.readFileSync('examples/analysis-result.json','utf8')) as AnalysisResult;
const scopeItems=['未展开：移植层的上下文切换','堆分配策略取决于构建配置'];
const noAction=()=>{};

function renderCatalog(unresolved_scope:string[],busy=false,addFeatureFromScope?: (item:string)=>void,{
  pending=1,statuses=[],cancelQueued,source_status='current',
}: {pending?:number;statuses?:string[];cancelQueued?:()=>void;source_status?:Explanation['source_status']}={}){
  const nodes=Array.from({length:pending+statuses.length},(_,i)=>({...base.nodes[0],node_id:`node-${i}`}));
  const groups=[{label:'核心能力',node_ids:nodes.slice(0,pending).map(node=>node.node_id)}];
  if(statuses.length)groups.push({label:'其他能力',node_ids:nodes.slice(pending).map(node=>node.node_id)});
  const result={...base,nodes,coverage:{...base.coverage,unresolved_scope},feature_catalog:{scope:'冻结源码',groups}};
  const explanation:Explanation={result,result_id:result.result_id,scenario_id:result.binding.scenario_id,created_at:'',source_status};
  const {project_id,source_snapshot_id,question_revision_id}=result.binding;
  const features:Feature[]=[],scenarios:Scenario[]=[],runs:Run[]=[];
  statuses.forEach((status,i)=>{
    const feature_id=`feature-${i}`,scenario_id=`scenario-${i}`;
    features.push({feature_id,project_id,name:feature_id,archived:false,sort_order:i,discovery:{result_id:result.result_id,node_id:nodes[pending+i].node_id,source_snapshot_id}});
    scenarios.push({scenario_id,feature_id,project_id,title:scenario_id,question:'',question_revision_id,archived:false,sort_order:i,kind:'feature_overview'});
    runs.push({binding:{...result.binding,feature_id,scenario_id,run_id:`run-${i}`},provider_id:'codex',status,created_at:'',question:'',title:'',submission_key:'',output_path:''});
  });
  const data:WorkspaceData={projects:[],features,scenarios,revisions:[],annotations:[],runs,explanations:[explanation],providers:[],snapshots:[],codex_preferences:{model:'',reasoning_effort:'auto'},codex_models:{models:[]}};
  return renderToStaticMarkup(React.createElement(FeatureCatalog,{explanation,data,projectId:project_id,busy,open:noAction,discover:noAction,mode:'codex',fillPending:noAction,cancelQueued,addFeatureFromScope}));
}

test('group generation is available only for groups with pending graphs',()=>{
  const html=renderCatalog([],false,undefined,{pending:2,statuses:['running']});
  assert.match(html,/核心能力<\/span><small>0\/2<\/small><button[^>]*>生成本组（2）/);
  assert.match(html,/其他能力<\/span><small>0\/1<\/small><\/h3>/);
});

test('batch selection is available at either size, with fill-all capped at eight pending graphs',()=>{
  const small=renderCatalog([],false,undefined,{pending:8});
  assert.match(small,/>批量选择<\/button>/);
  assert.match(small,/补齐未就绪双图（8）/);
  assert.match(renderCatalog([],false,undefined,{pending:8,source_status:'stale'}),/按原快照补齐双图（8）/);
  const large=renderCatalog([],false,undefined,{pending:9});
  assert.match(large,/>批量选择<\/button>/);
  assert.doesNotMatch(large,/补齐未就绪双图|按原快照补齐双图/);
});

test('clear queue counts queued runs only and requires a cancellation callback',()=>{
  const active=['running','validating'];
  const statuses=['queued',...active,'queued'];
  assert.match(renderCatalog([],false,undefined,{statuses,cancelQueued:noAction}),/清空排队（2）/);
  assert.doesNotMatch(renderCatalog([],false,undefined,{statuses:active,cancelQueued:noAction}),/清空排队/);
  assert.doesNotMatch(renderCatalog([],false,undefined,{statuses}),/清空排队/);
});

test('the feature catalog shows nonblank unresolved scope below the cards with available actions',()=>{
  const unresolved=[` ${scopeItems[0]} `,'  ',scopeItems[1]];
  const html=renderCatalog(unresolved,false,noAction);
  assert.match(html,/class="capability-card".*class="catalog-unresolved"/);
  assert.match(html,/未展开 \/ 待补充范围 <small>2<\/small>/);
  for(const item of scopeItems)assert.ok(html.includes(`<span>${item}</span>`));
  assert.equal((html.match(/补充为新功能/g)||[]).length,2);
  assert.doesNotMatch(renderCatalog(unresolved,true,noAction),/补充为新功能/);
  assert.doesNotMatch(renderCatalog(unresolved),/补充为新功能/);
  assert.doesNotMatch(renderCatalog(['  '],false,noAction),/catalog-unresolved/);
});

type ScopeElement=React.ReactElement<{children?:React.ReactNode;onClick?:()=>void}>;
function actionButtons(node:React.ReactNode):ScopeElement[]{
  return React.Children.toArray(node).flatMap(child=>{
    if(!React.isValidElement<ScopeElement['props']>(child))return [];
    return child.type==='button'?[child]:actionButtons(child.props.children);
  });
}

test('each unresolved item button passes its own item to the add callback',()=>{
  const selected:string[]=[];
  const buttons=actionButtons(CatalogUnresolved({items:scopeItems,addFeatureFromScope:item=>selected.push(item)}));
  assert.equal(buttons.length,2);
  buttons[1].props.onClick!();
  assert.deepEqual(selected,[scopeItems[1]]);
});
