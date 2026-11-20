import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CatalogUnresolved,FeatureCatalog} from '../src/ui/FeatureCatalog';
import type {AnalysisResult,Explanation,WorkspaceData} from '../src/shared';

const base=JSON.parse(fs.readFileSync('examples/analysis-result.json','utf8')) as AnalysisResult;
const scopeItems=['未展开：移植层的上下文切换','堆分配策略取决于构建配置'];
const noAction=()=>{};

function renderCatalog(unresolved_scope:string[],busy=false,addFeatureFromScope?: (item:string)=>void){
  const result={...base,coverage:{...base.coverage,unresolved_scope},feature_catalog:{scope:'冻结源码',groups:[{label:'核心能力',node_ids:[base.nodes[0].node_id]}]}};
  const explanation:Explanation={result,result_id:result.result_id,scenario_id:result.binding.scenario_id,created_at:'',source_status:'current'};
  const data:WorkspaceData={projects:[],features:[],scenarios:[],revisions:[],annotations:[],runs:[],explanations:[explanation],providers:[],snapshots:[]};
  return renderToStaticMarkup(React.createElement(FeatureCatalog,{explanation,data,projectId:result.binding.project_id,busy,open:noAction,discover:noAction,mode:'codex',setMode:noAction,addFeatureFromScope}));
}

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
