import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import type {ArchitectureDocument} from '../src/architecture-workspace';
import type {Explanation, SourceEvidence} from '../src/shared';
import {createCodexSemanticAnalyzer, makeReviewItem, type SemanticInput} from '../src/main/architecture-semantic';
import {resolveArchitectureReviewDecision} from '../src/main/architecture-review';
import type {ActiveProcess} from '../src/main/providers';
import {capture} from '../src/main/snapshot';
import {now, Store} from '../src/main/store';

test('default incremental Codex adapter scopes files, applies model settings, validates output and frozen evidence', async t=>{
  const base=path.resolve('.test-data');
  await fs.mkdir(base,{recursive:true});
  const temp=await fs.mkdtemp(path.join(base,'semantic-'));
  const root=path.join(temp,'repo'), store=new Store(path.join(temp,'database'));
  t.after(async()=>{store.close();await fs.rm(temp,{recursive:true,force:true});});
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'a.c'),'int f(void) { return 1; }\n');
  await fs.writeFile(path.join(root,'unrelated.c'),'/* unrelated implementation */\n');
  const snapshot=await capture(root,'project',store.directory,'');
  const ev:SourceEvidence={evidence_id:'ev',source_snapshot_id:snapshot.source_snapshot_id,role:'definition',note:'returns one',
    path:'a.c',content_sha256:snapshot.files.find(f=>f.path==='a.c')!.content_sha256,line_start:1,line_end:1};
  const doc:ArchitectureDocument={id:'doc',project_id:'project',branch_key:'main',version:1,title:'Doc',summary:'',
    modules:[{id:'m',name:'Reader',kind:'stage',layer:'core',summary:'old summary',code_links:[],evidence:[ev],
      updated_at:now(),origin:'code_analysis',implementation_status:'implemented'}],relations:[],exclusions:[],review_items:[],
    layout:{positions:{},manual_positions:[]},created_at:now(),updated_at:now(),update_status:'changes_pending'};
  const profile={provider_id:'codex',path:'configured-codex',status:'available',checked_at:now()};
  const preferences={model:'custom-model',reasoning_effort:'medium'};
  store.put('provider','codex',profile);
  store.put('settings','codex_preferences',preferences);
  let calls=0;
  const input:SemanticInput={unit:{kind:'module',id:'m',paths:['a.c']},snapshot,doc,onModelCall:()=>calls++};
  const wire={category:'module_update',target_kind:'module',target_id:'m',title:'Return constant',
    proposed:{name:null,kind:null,summary:'Return constant',layer:null,parent_id:null,bind_paths:null},evidence:[{...ev,symbol_id:null}]};
  let response:unknown={proposals:[wire]};
  const analyzer=createCodexSemanticAnalyzer(store,'runtime',async opts=>{
    assert.deepEqual(opts.profile,profile);
    assert.deepEqual(opts.preferences,preferences);
    assert.deepEqual(opts.sourcePaths,['a.c']);
    assert.equal(opts.run.binding.source_snapshot_id,snapshot.source_snapshot_id);
    assert.equal(path.relative(store.directory,opts.outputDirectory!).split(path.sep)[0],'runs');
    assert.equal(opts.run.output_path,path.join(opts.outputDirectory!,'result.json'));
    assert.ok(opts.outputSchema);
    assert.doesNotMatch(opts.prompt,/unrelated\.c|unrelated implementation/);
    if(input.unit.kind==='feature'){
      assert.match(opts.prompt,/Old reading/);
      assert.match(JSON.stringify(opts.outputSchema),/dataflow_change/);
      assert.doesNotMatch(JSON.stringify(opts.outputSchema),/module_update/);
    } else assert.match(JSON.stringify(opts.outputSchema),/module_update/);
    opts.started({} as ActiveProcess);
    return {code:0,raw:JSON.stringify(response),stderr:''};
  });
  assert.equal(analyzer.countsModelCalls,true);
  // Keep reading the frozen source after the live checkout changes.
  await fs.writeFile(path.join(root,'a.c'),'\n');
  const [proposal]=await analyzer.analyze(input);
  assert.equal(calls,1);
  assert.deepEqual(proposal.proposed,{summary:'Return constant'});
  assert.deepEqual(proposal.evidence,[ev]);
  assert.match(proposal.analysis_run_id!,/^architecture-/);
  response={proposals:[{...wire,evidence:[{...ev,path:'unrelated.c',symbol_id:null}]}]};
  await assert.rejects(analyzer.analyze(input),/冻结源码范围/);
  response={proposals:[{...wire,proposed:{...wire.proposed,arbitrary_field:'unexpected'}}]};
  await assert.rejects(analyzer.analyze(input),/结构无效/);
  input.unit={kind:'unmapped',id:'a.c',paths:['a.c']};
  response={proposals:[{...wire,proposed:{...wire.proposed,summary:null,bind_paths:['a.c']}}]};
  const [ownership]=await analyzer.analyze(input);
  const item=makeReviewItem(ownership,doc,doc,snapshot)!;
  const pending=store.saveArchitectureDoc({...doc,review_items:[item]},0);
  store.put('snapshot',snapshot.source_snapshot_id,snapshot);
  const accepted=resolveArchitectureReviewDecision(store,pending,{reviewId:item.id,decision:'accept'},store.saveArchitectureDoc.bind(store));
  assert.deepEqual(accepted.modules[0].code_links.map(link=>link.path),['a.c']);
  assert.equal(accepted.modules[0].summary,'old summary');
  assert.equal(makeReviewItem(ownership,accepted,accepted,snapshot),undefined);
  const prior:Explanation={result_id:'walk',scenario_id:'scene',created_at:now(),source_status:'current',
    result:{schema_version:'1.0',fictional:false,result_id:'walk',binding:{project_id:'project',feature_id:'f',scenario_id:'scene',
      run_id:'old-run',question_revision_id:'rev',source_snapshot_id:snapshot.source_snapshot_id},
      provider:{provider_id:'codex',connection_id:'local-codex',adapter_version:'1'},evidence:[ev],nodes:[],edges:[],claims:[],gaps:[],
      summary:{text:'feature',claim_ids:[]},coverage:{covered_scope:[],unresolved_scope:[]},
      reading_guide:{steps:[{id:'step',title:'Old reading',actor:'Reader',text:'Read',detail:'',outcome:'one',node_ids:[],evidence_ids:['ev']}],
        roles:[],files:[],paths:[],handoffs:[]}}};
  input.unit={kind:'feature',id:'f',paths:['a.c'],explanation:prior};
  response={proposals:[]};
  assert.deepEqual(await analyzer.analyze(input),[]);
  assert.equal(calls,5);
});
