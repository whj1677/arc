import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitingForAgent} from '../src/ui/discovery-state';
import type {WorkspaceData} from '../src/shared';
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
