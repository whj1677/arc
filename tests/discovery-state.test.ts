import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogGraphState,waitingForAgent} from '../src/ui/discovery-state';
import type {Explanation,WorkspaceData} from '../src/shared';
const data=()=>({projects:[{project_id:'p',snapshot_id:'s'}],scenarios:[{scenario_id:'q',project_id:'p',question_revision_id:'v'}],requested_analysis:{project_id:'p',scenario_id:'q',question_revision_id:'v',source_snapshot_id:'s',created_at:'2026-10-21T10:00:00Z'},runs:[],explanations:[]} as unknown as WorkspaceData);
test('MCP preparation remains waiting after reload, but never impersonates a started or saved task',()=>{
 const d=data();assert.equal(waitingForAgent(JSON.parse(JSON.stringify(d)),'q'),true);
 assert.equal(waitingForAgent(d,'other'),false);
 for(const status of ['queued','running','validating','cancel_requested','failed','blocked_external','cancelled','completed','unknown']){
  const v=data();v.runs.push({binding:{scenario_id:'q'},created_at:'2026-10-21T10:01:00Z',status} as any);assert.equal(waitingForAgent(v,'q'),false,status);
 }
 d.explanations.push({scenario_id:'q',result:{binding:{question_revision_id:'v',source_snapshot_id:'s'}}} as any);assert.equal(waitingForAgent(d,'q'),false);
});
test('old failures permit a newly requested handoff; stale binding and archived targets cannot look pending',()=>{
 const d=data();d.runs.push({binding:{scenario_id:'q'},created_at:'2026-10-21T09:00:00Z',status:'failed'} as any);assert.equal(waitingForAgent(d,'q'),true);
 for(const change of [(v:WorkspaceData)=>v.projects[0].snapshot_id='new',(v:WorkspaceData)=>v.scenarios[0].question_revision_id='new',(v:WorkspaceData)=>v.scenarios[0].archived=true]){const v=data();change(v);assert.equal(waitingForAgent(v,'q'),false);}
});
test('requesting an explicit update keeps old saved results readable without hiding the new waiting state',()=>{
 const d=data();d.explanations.push({scenario_id:'q',created_at:'2026-10-21T09:00:00Z',result:{binding:{question_revision_id:'v',source_snapshot_id:'s'}}} as any);assert.equal(waitingForAgent(d,'q'),true);
 d.explanations[0].created_at='2026-10-21T11:00:00Z';assert.equal(waitingForAgent(d,'q'),false);
});

test('reopening the latest catalog selects the refreshed graph for the same feature and revision',()=>{
  const workspace=data();
  const catalog=(id:string)=>({
    result_id:id,scenario_id:'overview',
    result:{result_id:id,binding:{project_id:'p',scenario_id:'overview',source_snapshot_id:'s'},nodes:[{node_id:'entry',kind:'stage',label:'入口',description:'入口',evidence_ids:['ev']}],
      evidence:[{evidence_id:'ev',path:'main.c',line_start:1,line_end:1,content_sha256:'hash'}],feature_catalog:{groups:[{node_ids:['entry']}]}}
  } as unknown as Explanation);
  const previous=catalog('previous'),latest=catalog('latest');
  workspace.features=[previous,latest].map(e=>({feature_id:e.result_id,project_id:'p',name:'入口',archived:false,sort_order:0,discovery:{result_id:e.result_id,node_id:'entry',source_snapshot_id:'s'}}));
  workspace.scenarios=workspace.features.map(f=>({...workspace.scenarios[0],feature_id:f.feature_id,scenario_id:f.feature_id,kind:'feature_overview'}));
  function graph(id:string,feature:string,snapshot:string,revision='v'){
    return {result_id:id,scenario_id:feature,result:{binding:{project_id:'p',feature_id:feature,scenario_id:feature,source_snapshot_id:snapshot,question_revision_id:revision},
      nodes:[{node_id:'a',kind:'function'},{node_id:'b',kind:'function'}],
      edges:[{kind:'sync_call',status:'source_supported',source_node_id:'a',target_node_id:'b'}],
      function_walkthroughs:[{steps:[{kind:'call',from_node_id:'a',to_node_id:'b'}]}]}} as unknown as Explanation;
  }
  workspace.explanations=[previous,latest,graph('historical','previous','s'),graph('old','latest','s')];
  assert.equal(catalogGraphState(workspace,latest,'entry').ready?.result_id,'old');
  workspace.projects[0].snapshot_id='refreshed';
  workspace.explanations.push(graph('new','latest','refreshed'),graph('wrong-revision','latest','refreshed','old'),graph('different-feature','previous','refreshed'));
  assert.equal(catalogGraphState(workspace,latest,'entry').ready?.result_id,'new');
  assert.equal(catalogGraphState(workspace,previous,'entry').ready?.result_id,'historical');
});
