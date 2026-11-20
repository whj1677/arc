import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {timelineModel} from '../src/ui/timeline-model';
import {modernReading} from '../src/ui/presentation';
import {defaults} from '../src/ui/workbench-primitives';
import type {AnalysisResult,ReadingState} from '../src/shared';
const actual=JSON.parse(fs.readFileSync('evidence/readability-20261021/walk-result.json','utf8')) as AnalysisResult;
test('real trade timeline follows only evidenced control links; rejection and uncertain returns stay branches',()=>{
 const before=JSON.stringify(actual),m=timelineModel(actual);assert.equal(m.ordered,true);assert.deepEqual(m.ids,['generate','confirm','complete','review']);assert.deepEqual(m.links.map(e=>e.edge_id),['generated-plan','confirmed-state','completed-record']);
 for(let i=0;i<m.links.length;i++){assert.equal(m.links[i].source_node_id,m.ids[i]);assert.equal(m.links[i].target_node_id,m.ids[i+1]);}
 assert.equal(JSON.stringify(actual),before);
});
test('calls, ties, cycles and inferred control do not invent a business sequence',()=>{
 assert.equal(timelineModel({...actual,edges:actual.edges.map(e=>({...e,kind:'sync_call'}))}).ordered,false);
 const a=actual.edges[0],b=actual.edges[1];
 const diamond=[a,{...b,edge_id:'other',source_node_id:'generate',target_node_id:'complete'},{...b,edge_id:'end1',source_node_id:'confirm',target_node_id:'review'},{...b,edge_id:'end2',source_node_id:'complete',target_node_id:'review'}];
 assert.equal(timelineModel({...actual,edges:diamond}).ordered,false);
 assert.equal(timelineModel({...actual,edges:[a,b,{...b,edge_id:'cycle',source_node_id:'complete',target_node_id:'confirm'}]}).ordered,false);
 assert.equal(timelineModel({...actual,edges:actual.edges.map(e=>({...e,status:'inferred'}))}).ordered,false);
});

test('a real retry link stays a branch instead of destroying an otherwise unambiguous six-stage path',()=>{
 const ids=['prepare','check','generate','confirm','complete','review'];
 const nodes=ids.map(node_id=>({...actual.nodes[0],node_id}));
 const edges=ids.slice(0,-1).map((id,i)=>({...actual.edges[0],edge_id:'next-'+i,source_node_id:id,target_node_id:ids[i+1],transfers:undefined}));
 edges.push({...edges[0],edge_id:'retry',source_node_id:'generate',target_node_id:'check'});
 const m=timelineModel({...actual,nodes,edges});assert.equal(m.ordered,true);assert.deepEqual(m.ids,ids);assert.equal(m.links.some(e=>e.edge_id==='retry'),false);assert.equal(m.edgeCount,6);
});
test('presentation migration preserves the saved graph state and does not force timeline again',()=>{
 const old:ReadingState={entrance:'walk',view:'flow',selected:'old-edge',zoom:1.2,stage:'old-stage',mode:'source',result_id:'old-result',scroll:{'canvas-flow':{top:25,left:8}},scenario_id:'scene',file:'source',evidence_id:'evidence',source_snapshot_id:'snapshot',left_width:220,right_width:360,catalog_hidden:false,pinned:false,detail_tab:'details',expanded:[],compare_id:'',linked:true};
 const next=modernReading(old);assert.equal(next.view,'timeline');assert.equal(next.mode,'normal');assert.equal(next.view_states?.flow.mode,'normal');assert.equal(next.view_states?.flow.selected,'old-edge');assert.equal(next.view_states?.flow.stage,'old-stage');assert.equal(next.result_id,'old-result');assert.deepEqual(next.scroll,old.scroll);
 assert.equal(next.zoom,1);assert.equal(next.view_states?.flow.zoom,1.2);assert.equal(modernReading({...next,view:'flow'}).view,'flow');assert.equal(old.view,'flow');
 const nav={...next,view:'walknav',catalog_hidden:true,view_states:{timeline:{selected:'confirmed-state',file:'',evidence_id:'',source_snapshot_id:'frozen-snapshot',zoom:1.4,stage:'',mode:'normal' as const,detail_tab:'details',result_id:'timeline-result'}}};
 const restored=modernReading(nav);assert.equal(restored.view,'timeline');assert.equal(restored.selected,'confirmed-state');assert.equal(restored.zoom,1.4);assert.equal(restored.source_snapshot_id,'frozen-snapshot');assert.equal(restored.result_id,'timeline-result');assert.equal(restored.catalog_hidden,false);assert.deepEqual(restored.scroll,nav.scroll);assert.equal(nav.view,'walknav');
 const fresh=modernReading({...next,view:'walknav',view_states:undefined});assert.equal(fresh.view,'timeline');assert.equal(fresh.selected,'');assert.equal(fresh.result_id,next.result_id);
 const overview=modernReading({...old,entrance:'overview',view:'composition',presentation_version:3});
 assert.equal(overview.view,'system');assert.equal(overview.zoom,1);assert.equal(overview.result_id,old.result_id);assert.equal(overview.source_snapshot_id,old.source_snapshot_id);assert.deepEqual(overview.scroll,old.scroll);assert.equal(overview.view_states?.composition.zoom,old.zoom);
 assert.equal(modernReading({...overview,view:'files',architecture_version:undefined}).view,'files','file reading is not replaced by overview migration');
});

test('restoring a retired overview tab opens architecture while the feature catalog remains available in walkthroughs',()=>{
  for(const view of ['home','functions','capabilities','dependencies','composition','map']){
    const saved={...defaults,entrance:'overview' as const,view,architecture_version:1,catalog_hidden:false,result_id:'previous-result',source_snapshot_id:'frozen',selected:'old-node'};
    const restored=modernReading(saved);
    assert.equal(restored.entrance,'overview');
    assert.equal(restored.view,'system');
    assert.equal(restored.catalog_hidden,true);
    assert.equal(restored.result_id,saved.result_id);
    assert.equal(restored.source_snapshot_id,saved.source_snapshot_id);
    assert.equal(restored.selected,'');
  }
  const catalog=modernReading({...defaults,entrance:'walk',view:'capabilities',catalog_hidden:false});
  assert.equal(catalog.view,'capabilities');
  assert.equal(catalog.catalog_hidden,false);
});


test('explicit normal path cannot absorb a real error response with input/output transfers',()=>{
 const handoff=JSON.parse(fs.readFileSync('evidence/multi-project-20261021/codex-feature-corrected.json','utf8')).explanation.result as AnalysisResult;
 const reviewed={...handoff,edges:handoff.edges.map(e=>({...e,flow_role:(['flow-submit-check','flow-check-assemble','flow-assemble-publish','flow-publish-download'].includes(e.edge_id)?'main':e.edge_id==='flow-check-download'?'alternative':'exception') as 'main'|'alternative'|'exception'}))};
 const m=timelineModel(reviewed);assert.equal(m.ordered,true);assert.deepEqual(m.ids,['submit','check','assemble','publish','download']);assert.equal(m.edgeCount,handoff.edges.length);assert.ok(reviewed.edges.find(e=>e.edge_id==='error-download-record')?.transfers?.length);
 assert.ok(!m.links.some(e=>e.flow_role!=='main'));
 const noMain={...reviewed,edges:reviewed.edges.map(e=>({...e,flow_role:'exception' as const}))};assert.equal(timelineModel(noMain).ordered,false,'declared roles without a main path must not fall back to longest failure path');
});
