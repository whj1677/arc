import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AnalysisResult, Explanation, Run, Scenario, SourceEvidence } from '../src/shared';
import {
  applyModuleDelete, applyRelationDelete, architectureDocId, architectureDocumentToAnalysisResult,
  buildModuleExclusionSignature, buildRelationExclusionSignature, canonicalEvidenceKey, normalizeBranchKey,
  seedArchitectureFromExplanation, validateArchitectureDocument, wouldCreateHierarchyCycle,
  type ArchitectureDocument, type ArchitectureModule, type UpdateRunRecord,
} from '../src/architecture-workspace';
import { collectInScopeFileHashes, computeEvidenceFingerprint, detectWorkspaceGitState } from '../src/main/architecture-workspace-service';
import { architectureIpc } from '../src/main/architecture-ipc';
import { ArcService } from '../src/main/service';
import { ArcMcpBridge } from '../src/main/mcp-bridge';
import { Store } from '../src/main/store';
import { pruneUnreferencedSnapshots } from '../src/main/snapshot-gc';
import { architectureMap } from '../src/ui/architecture-map';

const at = '2026-01-01T00:00:00.000Z';
const bytes = 'export const dispatch = 1;\n';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function legacy(project = 'p', snapshot = 'source-old', scenario?: Scenario): Explanation {
  const binding = {project_id:project, source_snapshot_id:snapshot, feature_id:scenario?.feature_id ?? 'feature',
    scenario_id:scenario?.scenario_id ?? 'scenario', question_revision_id:'rev', run_id:'analysis'};
  const evidence: SourceEvidence = {evidence_id:'ev', source_snapshot_id:snapshot, path:'src/run.ts',
    content_sha256:sha(bytes), line_start:1, line_end:1, symbol_id:'dispatch', role:'definition', note:'entry'};
  const io = {io_id:'request', name:'request', description:'dispatch payload', availability:'specified' as const,
    data_type:'Request', value_or_shape:null, evidence_ids:['ev'], claim_ids:[]};
  const node = (node_id:string, kind:AnalysisResult['nodes'][number]['kind'], parent_node_id?:string) => ({
    node_id, kind, label:node_id, description:node_id+' summary', parent_node_id,
    execution_context:{kind:'unknown' as const, identity:null, label:'unknown', status:'unknown' as const, claim_ids:[], evidence_ids:[]},
    inputs:[io], outputs:[{...io,io_id:'out'}], claim_ids:[], evidence_ids:['ev'],
  });
  const edge = (edge_id:string, from:string, to:string) => ({edge_id, kind:'dependency' as const, label:edge_id,
    source_node_id:from, target_node_id:to, status:'source_supported' as const, evidence_ids:['ev'], claim_ids:[],
    transfers:[{label:'payload', source_output_id:'out', target_input_id:'request', status:'inferred' as const, claim_ids:[], evidence_ids:['ev']}]});
  const result:AnalysisResult = {schema_version:'1.0', fictional:false, result_id:'overview', binding,
    provider:{provider_id:'codex',connection_id:'fixture',adapter_version:'1'}, summary:{text:'Dispatcher',claim_ids:[]},
    coverage:{covered_scope:['dispatcher'],unresolved_scope:[]}, claims:[], gaps:[], evidence:[evidence],
    architecture:{node_ids:['entry','group','child','leaf','storage'],edge_ids:['calls','writes']},
    nodes:[node('entry','execution_boundary'),node('group','stage'),node('child','stage','group'),
      node('leaf','stage','child'),node('storage','resource'),node('outside','function')],
    edges:[edge('calls','entry','group'),edge('writes','child','storage'),edge('outside-edge','outside','entry')]};
  return {result_id:result.result_id, scenario_id:binding.scenario_id, source_status:'current', created_at:at, result};
}

function seed() {
  return seedArchitectureFromExplanation({projectId:'p', branchKey:'main', explanation:legacy()});
}

function planned(): ArchitectureModule {
  return {id:'plan',name:'Planned scheduler',kind:'stage',layer:'core',summary:'Future scheduling',notes:'Owner review',
    code_links:[],evidence:[],origin:'manual',implementation_status:'planned',updated_at:at};
}

function git(root:string, ...args:string[]) {
  return execFileSync('git', ['--no-optional-locks','-C',root,...args], {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
}
async function directory() {
  const parent = path.resolve('.test-data');
  await fs.mkdir(parent,{recursive:true});
  return fs.mkdtemp(path.join(parent,'architecture-'));
}
async function projectFixture(t:TestContext) {
  const dir = await directory(), root = path.join(dir,'目标 工程');
  let runningService: ArcService | undefined;
  t.after(async()=>{
    if (runningService) {await runningService.shutdown();runningService.store.close();}
    await fs.rm(dir,{recursive:true,force:true});
  });
  await fs.mkdir(path.join(root,'src'),{recursive:true});
  await fs.writeFile(path.join(root,'src/run.ts'),bytes);
  await fs.writeFile(path.join(root,'AGENTS.md'),'Engineering rules\n');
  await fs.writeFile(path.join(root,'package.json'),'{"name":"fixture"}\n');
  git(root,'init','-b','main');
  git(root,'add','.');
  git(root,'-c','user.name=ARC Fixture','-c','user.email=arc@example.invalid','commit','-m','Initial fixture');
  const service = runningService = new ArcService(path.join(dir,'arc-data'),path.resolve('.'));
  const project = await service.openProject(root);
  const scene = service.overview(project.project_id);
  const explanation = legacy(project.project_id,project.snapshot_id,scene);
  return {root,service,project,scene,explanation};
}

test('legacy seed selects stable architecture IDs, preserves evidence, hierarchy, IO and transfers',()=>{
  const explanation = legacy(), original = structuredClone(explanation);
  const doc = seedArchitectureFromExplanation({projectId:'p',branchKey:'main',explanation});
  assert.deepEqual(doc.modules.map(m=>m.id),explanation.result.architecture!.node_ids);
  assert.deepEqual(doc.relations.map(r=>r.id),explanation.result.architecture!.edge_ids);
  assert.equal(doc.modules.find(m=>m.id==='entry')!.layer,'entry');
  assert.equal(doc.modules.find(m=>m.id==='storage')!.layer,'foundation');
  const child = doc.modules.find(m=>m.id==='child')!;
  assert.equal(child.parent_id,'group');
  assert.equal(child.summary,'child summary');
  assert.equal(child.code_links[0].path,'src/run.ts');
  assert.equal(child.code_links[0].symbol_id,'dispatch');
  assert.equal(child.code_links[0].source_snapshot_id,child.evidence[0].source_snapshot_id);
  assert.deepEqual(child.evidence,explanation.result.evidence);
  assert.deepEqual(doc.relations[0].transfers,explanation.result.edges[0].transfers);
  const projected = architectureDocumentToAnalysisResult(doc,explanation.result);
  assert.deepEqual(projected.nodes.find(n=>n.node_id==='child')!.inputs,explanation.result.nodes[2].inputs);
  assert.deepEqual(validateArchitectureDocument(doc),[]);
  doc.modules[0].name='edited';
  assert.deepEqual(explanation,original);
  assert.equal(normalizeBranchKey(),'default');
  assert.equal(architectureDocId('p'),architectureDocId('p','default'));
  assert.notEqual(architectureDocId('p','main'),architectureDocId('p','feature/main'));
});

test('hierarchy rejects self, descendants and invalid parents while cyclic directed relations remain valid',()=>{
  const doc = seed();
  for(const parent of ['group','child','leaf']){
    assert.equal(wouldCreateHierarchyCycle(doc.modules,'group',parent),true);
    const bad=structuredClone(doc);
    bad.modules.find(m=>m.id==='group')!.parent_id=parent;
    assert.ok(validateArchitectureDocument(bad).length);
  }
  assert.equal(wouldCreateHierarchyCycle(doc.modules,'group','storage'),false);
  doc.modules.push(planned());
  doc.relations.push({...doc.relations[0],id:'feedback',from:'group',to:'entry',origin:'manual',status:'manual'});
  assert.deepEqual(validateArchitectureDocument(doc),[]);
  for (const patch of [{name:' '},{id:'group'},{parent_id:'missing'},{origin:'code_analysis'},{layer:'wrong'}]) {
    const bad=structuredClone(doc);
    Object.assign(bad.modules.at(-1)!,patch);
    assert.ok(validateArchitectureDocument(bad).length,JSON.stringify(patch));
  }
  for(const patch of [{id:'calls'},{from:'unknown'},{to:'unknown'}]){
    const bad=structuredClone(doc);
    Object.assign(bad.relations.at(-1)!,patch);
    assert.ok(validateArchitectureDocument(bad).length);
  }
});

test('the saved layer reaches the map and manual prose does not inherit a frozen source claim',async t=>{
  const dir=await directory(),store=new Store(dir);
  t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true});});
  const explanation=legacy(),original=explanation.result;
  const result:AnalysisResult={...original,
    claims:[{claim_id:'entry-claim',statement:'Original entry',status:'source_supported',rationale:'',
      limitations:[],evidence_ids:['ev'],targets:{node_ids:['entry'],edge_ids:[],io_ids:[]}}],
    nodes:original.nodes.map(n=>n.node_id==='entry'?{...n,claim_ids:['entry-claim']}:n),
    gaps:[{gap_id:'storage-gap',kind:'other',question:'Storage?',impact:'',suggested_action:'',
      related_node_ids:['storage'],claim_ids:[],evidence_ids:[]}],
  };
  const doc=seedArchitectureFromExplanation({projectId:'p',branchKey:'main',explanation:{...explanation,result}});
  Object.assign(doc.modules[0],{layer:'foundation',summary:'Proposed adapter',origin:'manual_override'});
  doc.modules.find(m=>m.id==='storage')!.hidden=true;
  store.saveArchitectureDoc(doc,0);
  const view=architectureDocumentToAnalysisResult(store.getArchitectureDoc('p','main')!,result);
  const map=architectureMap(view);
  assert.ok(map.layers.find(layer=>layer.id==='infrastructure')?.roots.includes('entry'));
  assert.ok(!map.layers.find(layer=>layer.id==='boundary')?.roots.includes('entry'));
  assert.deepEqual(view.nodes.find(n=>n.node_id==='entry')?.claim_ids,[]);
  assert.deepEqual(view.gaps,[]);
  assert.deepEqual(view.claims,[]);
  assert.equal(result.claims.length,1);
  assert.equal(result.gaps.length,1);
});

test('hiding modules and relations is reversible and the visible projection retains only connected edges',()=>{
  const doc=seed(),original=structuredClone(doc);
  doc.modules.find(m=>m.id==='child')!.hidden=true;
  doc.relations[0].hidden=true;
  const visible=architectureDocumentToAnalysisResult(doc);
  assert.ok(!visible.architecture!.node_ids.includes('child'));
  assert.deepEqual(visible.architecture!.edge_ids,[]);
  const full=architectureDocumentToAnalysisResult(doc,undefined,{includeHidden:true});
  assert.deepEqual(full.architecture!.node_ids,original.modules.map(m=>m.id));
  assert.deepEqual(full.architecture!.edge_ids,['calls','writes']);
  delete doc.modules.find(m=>m.id==='child')!.hidden;
  delete doc.relations[0].hidden;
  assert.deepEqual(doc,original);
});

test('delete strategies preserve unrelated layout, reparent only direct children and bind exclusions to evidence',()=>{
  const doc=seed(),group=doc.modules.find(m=>m.id==='group')!;
  group.parent_id='entry';
  doc.layout={positions:{group:{x:1,y:2},leaf:{x:3,y:4},entry:{x:5,y:6}},manual_positions:['group','leaf','entry']};
  const original=structuredClone(doc);
  const keep=applyModuleDelete(doc,'group','reparent_children',computeEvidenceFingerprint);
  assert.deepEqual(keep.removed_module_ids,['group']);
  assert.deepEqual(keep.reparented_child_ids,['child']);
  assert.equal(keep.doc.modules.find(m=>m.id==='child')!.parent_id,'entry');
  assert.equal(keep.doc.modules.find(m=>m.id==='leaf')!.parent_id,'child');
  assert.deepEqual(keep.removed_relation_ids,['calls']);
  assert.deepEqual(keep.doc.layout.positions,{leaf:{x:3,y:4},entry:{x:5,y:6}});
  assert.deepEqual(keep.doc.layout.manual_positions,['leaf','entry']);
  const drop=applyModuleDelete(doc,'group','delete_subtree',computeEvidenceFingerprint);
  assert.deepEqual(drop.removed_module_ids.sort(),['child','group','leaf']);
  assert.deepEqual(drop.removed_relation_ids.sort(),['calls','writes']);
  assert.deepEqual(drop.doc.relations,[]);
  assert.deepEqual(drop.doc.layout.positions,{entry:{x:5,y:6}});
  assert.deepEqual(doc,original);
  const signature=buildModuleExclusionSignature('group');
  const exclusion=drop.doc.exclusions.find(e=>e.signature===signature)!;
  assert.equal(exclusion.evidence_fingerprint,computeEvidenceFingerprint(group.evidence,signature));
  const rel=doc.relations[0],relSig=buildRelationExclusionSignature(rel.from,rel.to,rel.kind);
  const result=applyRelationDelete(doc,rel.id,computeEvidenceFingerprint,'design changed');
  assert.equal(result.exclusions[0].reason,'design changed');
  assert.equal(result.exclusions[0].signature,relSig);
  assert.equal(result.exclusions[0].evidence_fingerprint,sha(canonicalEvidenceKey(rel.evidence,relSig)));
  const a=rel.evidence[0],b={...a,line_start:2,line_end:4};
  assert.equal(computeEvidenceFingerprint([a,b]),computeEvidenceFingerprint([b,a]));
  assert.notEqual(computeEvidenceFingerprint([a]),computeEvidenceFingerprint([b]));
  doc.relations.push({...rel,id:'manual',label:'manual link',origin:'manual',status:'manual',evidence:[]});
  assert.deepEqual(applyRelationDelete(doc,'manual').exclusions,[]);
  for (const origin of ['manual_override','manual'] as const) {
    group.origin=rel.origin=origin;
    const removed=applyModuleDelete(doc,group.id,'reparent_children',computeEvidenceFingerprint).doc;
    assert.equal(removed.exclusions.find(e=>e.signature===signature)?.evidence_fingerprint,computeEvidenceFingerprint(group.evidence,signature));
    assert.equal(removed.exclusions.find(e=>e.signature===relSig)?.evidence_fingerprint,computeEvidenceFingerprint(rel.evidence,relSig));
    assert.equal(applyRelationDelete(doc,rel.id,computeEvidenceFingerprint).exclusions[0]?.evidence_fingerprint,
      computeEvidenceFingerprint(rel.evidence,relSig));
  }
});

test('version zero supports manual creation, optimistic saves, exact reads and restore',async t=>{
  const {service,project}=await projectFixture(t), projectId=project.project_id;
  const store=service.store;
  const get=await architectureIpc(service,'architecture_get',{project_id:projectId});
  assert.ok('active_branch' in get && 'document' in get && get.document);
  assert.equal(get.active_branch,'main');
  const initial=get.document;
  assert.equal(initial.version,0);
  assert.equal(store.getArchitectureDoc(projectId,'main'),undefined);
  const first=service.saveArchitectureDocument(projectId,{...initial,modules:[planned()]},0);
  assert.equal(first.version,1);
  assert.equal(first.last_confirmed_version,1);
  const second=service.saveArchitectureDocument(projectId,{...first,title:'Owner edit',modules:[
    {...planned(),name:'Scheduler',summary:'Manual purpose',notes:'Keep the timer separate',layer:'entry',
      code_links:[{id:'run',kind:'file',path:'src/run.ts',origin:'manual'}]},
  ]},1);
  assert.equal(second.modules[0].id,'plan');
  assert.equal(second.last_confirmed_version,2);
  assert.throws(()=>service.saveArchitectureDocument(projectId,first,1),/Architecture document version conflict/);
  assert.throws(()=>service.saveArchitectureDocument(projectId,first,0),/Architecture document version conflict/);
  assert.deepEqual(store.getArchitectureDocById(first.id),second);
  const failed=service.saveArchitectureDocument(projectId,{...second,modules:[{...second.modules[0],analysis_status:'failed'}]},2);
  assert.equal(failed.last_confirmed_version,2);
  assert.deepEqual(await service.getArchitectureDocument(projectId,{version:1}),first);
  await assert.rejects(service.getArchitectureDocument(projectId,{version:999}));
  assert.deepEqual((await service.listArchitectureVersions(projectId,'main')).map(v=>v.version),[3,2,1]);
  const ipc=await architectureIpc(service,'architecture_restore',{project_id:projectId,branch_key:'main',version:1});
  assert.ok('document' in ipc && ipc.document);
  assert.equal(ipc.document.version,4);
  assert.equal(ipc.document.update_status,'changes_pending');
  assert.equal(ipc.document.pending_changes_summary,undefined);
  assert.notEqual(ipc.document.last_confirmed_version,ipc.document.version);
  assert.deepEqual(ipc.document.modules,first.modules);
  await assert.rejects(architectureIpc(service,'architecture_get',{project_id:projectId,version:-1}));
  await assert.rejects(architectureIpc(service,'architecture_save',{project_id:projectId,document:{...first,id:'foreign'}}));
  await assert.rejects(architectureIpc(service,'architecture_save',{project_id:projectId,document:{...first,project_id:'other'}}));
  await assert.rejects(architectureIpc(service,'architecture_save',{project_id:projectId,document:{...first,layout:null}}));
  const history=await architectureIpc(service,'architecture_versions',{project_id:projectId,branch_key:'main'});
  assert.ok('versions' in history && history.versions);
  assert.deepEqual(history.versions.map(v=>v.version),[4,3,2,1]);
  assert.deepEqual(store.getArchitectureDocVersion(first.id,2),second);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,2);
});

test('save is atomic across current and history rows, and separate connections reject stale writers',async t=>{
  const dir=await directory();
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new Store(dir),other=new Store(dir);
  try {
    const first=store.saveArchitectureDoc(seed(),0);
    assert.deepEqual(other.getArchitectureDocById(first.id),first);
    const second=other.saveArchitectureDoc({...first,title:'saved elsewhere'},1);
    assert.throws(()=>store.saveArchitectureDoc(first,1),/version conflict/);
    store.db.exec("CREATE TEMP TRIGGER abort_current BEFORE UPDATE ON objects WHEN NEW.kind='architecture_doc' BEGIN SELECT RAISE(ABORT,'simulated update failure'); END");
    assert.throws(()=>store.saveArchitectureDoc(first,2),/simulated update failure/);
    assert.deepEqual(store.getArchitectureDocById(first.id),second);
    assert.equal(store.getArchitectureDocVersion(first.id,3),undefined);
  } finally {store.close();other.close();}
  const reopened=new Store(dir);
  try {
    assert.equal(reopened.getArchitectureDoc('p','main')!.title,'saved elsewhere');
    assert.equal(reopened.listArchitectureDocVersions(seed().id).length,2);
  } finally {reopened.close();}
});

test('non-Git projects use the default document branch',async t=>{
  // Outside the repository so Git cannot discover the ARC checkout as an ancestor.
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'arc-plain-project-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=await detectWorkspaceGitState(root);
  assert.equal(state.isGit,false);
  assert.equal(state.branchKey,'default');
  assert.equal(state.dirty,false);
});

test('branch seeding compares live source with frozen bytes, omits pending decisions from other branches',async t=>{
  const {root,service,project,explanation}=await projectFixture(t),p=project.project_id;
  service.store.put('explanation',explanation.result_id,explanation);
  const original=service.store.get('explanation',explanation.result_id);
  await fs.mkdir(path.join(root,'dist'));
  await fs.writeFile(path.join(root,'dist/generated.js'),'generated');
  await fs.writeFile(path.join(root,'tool.log'),'log');
  const live=await collectInScopeFileHashes(root);
  assert.deepEqual(Object.keys(live.file_hashes).sort(),['AGENTS.md','package.json','src/run.ts']);
  const [first,concurrent]=await Promise.all([service.getArchitectureDocument(p),service.getArchitectureDocument(p)]);
  assert.deepEqual(concurrent,first);
  assert.equal((await service.listArchitectureVersions(p,'main')).length,1);
  assert.equal(first.version,1);
  assert.equal(first.update_status,'up_to_date');
  assert.equal(first.baseline!.file_hashes['src/run.ts'],sha(bytes));
  const pending:ArchitectureDocument['review_items'][number]={id:'review',dedupe_key:'one',category:'uncertain',status:'pending',
    title:'Check main only',scope_summary:'main',evidence:[],evidence_fingerprint:'empty',code_baseline_fingerprint:first.baseline!.fingerprint,created_at:at};
  const next=service.saveArchitectureDocument(p,{...first,review_items:[pending]},1);
  assert.equal(next.last_confirmed_version,1);
  git(root,'switch','-c','feature/next');
  await fs.appendFile(path.join(root,'src/run.ts'),'// changed\n');
  const second=await service.getArchitectureDocument(p);
  assert.equal(second.branch_key,'feature/next');
  assert.equal(second.version,1);
  assert.deepEqual(second.review_items,[]);
  assert.equal(second.update_status,'changes_pending');
  assert.deepEqual(second.baseline!.file_hashes,first.baseline!.file_hashes);
  assert.notEqual((await collectInScopeFileHashes(root)).workspace_fingerprint,second.baseline!.workspace_fingerprint);
  const branches=await architectureIpc(service,'architecture_branches',{project_id:p});
  assert.ok('branches' in branches);
  assert.deepEqual(branches.branches,['feature/next','main']);
  assert.equal(branches.active_branch,'feature/next');
  assert.deepEqual((await service.getArchitectureDocument(p,{branchKey:'main'})).review_items,[pending]);
  const request=structuredClone(second);
  Reflect.deleteProperty(request.baseline!,'file_hashes');
  const saved=await architectureIpc(service,'architecture_save',{project_id:p,document:request,expected_version:1});
  assert.ok('document' in saved && saved.document);
  assert.deepEqual(saved.document.baseline!.file_hashes,second.baseline!.file_hashes);
  assert.deepEqual(service.store.get('explanation',original.result_id),original);
});

test('delete impact reports feature evidence; edits reach analysis, Q&A and authorized MCP without writing to the project',async t=>{
  const {root,service,project,scene,explanation}=await projectFixture(t),p=project.project_id;
  const targetState=async()=> {
    const files=await fs.readdir(root,{recursive:true,withFileTypes:true});
    const result=[];
    for(const file of files.filter(f=>f.isFile())){
      const name=path.join(file.parentPath,file.name);
      result.push([path.relative(root,name),(await fs.stat(name)).mtimeMs,sha((await fs.readFile(name)).toString('base64'))]);
    }
    return {files:result.sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),status:git(root,'status','--porcelain')};
  };
  const before=await targetState();
  service.store.put('explanation',explanation.result_id,explanation);
  const {feature,scenario}=service.addFeature(p,'Dispatch path');
  const walkthrough=legacy(p,project.snapshot_id,scenario);
  walkthrough.result_id='feature-walk';
  walkthrough.result={...walkthrough.result,result_id:'feature-walk'};
  service.store.put('explanation',walkthrough.result_id,walkthrough);
  const first=await service.getArchitectureDocument(p);
  const impact=await architectureIpc(service,'architecture_delete_impact',{project_id:p,module_id:'group'});
  assert.ok('module_id' in impact);
  assert.deepEqual(impact.child_modules,[{id:'child',name:'child'}]);
  assert.equal(impact.descendant_count,2);
  assert.ok(impact.incident_relations.some(r=>r.id==='calls'));
  assert.ok(impact.referenced_features.some(f=>f.id===feature.feature_id));
  const edited=applyModuleDelete(first,'group','delete_subtree').doc;
  const groupSignature=buildModuleExclusionSignature('group');
  edited.exclusions.find(e=>e.signature===groupSignature)!.evidence_fingerprint='';
  edited.modules.push({...planned(),parent_id:'entry'});
  edited.modules[0]={...edited.modules[0],name:'Owner entry',notes:'Send events here',origin:'manual_override'};
  edited.relations.push({id:'route',from:'entry',to:'plan',kind:'dependency',label:'Future route',notes:'only proposed',
    evidence:[],origin:'manual',status:'manual',updated_at:at});
  const saved=service.saveArchitectureDocument(p,edited,1);
  assert.ok(saved.exclusions.every(e=>/^[0-9a-f]{64}$/.test(e.evidence_fingerprint)));
  assert.equal(saved.exclusions.find(e=>e.signature===groupSignature)!.evidence_fingerprint,
    computeEvidenceFingerprint(first.modules.find(m=>m.id==='group')!.evidence,groupSignature));
  assert.equal(service.store.get('feature',feature.feature_id).name,feature.name);
  const updated=service.saveArchitectureDocument(p,{...saved,relations:[{...saved.relations[0],label:'Revised route'}]},2);
  const run:Run={binding:explanation.result.binding,provider_id:'codex',status:'running',question:scene.question,title:scene.title,
    created_at:at,submission_key:'test-analysis',output_path:''};
  const analysis=await service.analysisContext(run);
  const question=await service.askReading({project_id:p,scenario_id:scene.scenario_id,target:{kind:'feature',id:scene.feature_id},
    question:'Which modules are planned?',mode:'mcp',submission_key:'arch-question'});
  const bridge=new ArcMcpBridge(service,path.resolve('.'));
  try {
    await bridge.enable(p);
    const external=await bridge.call('arc_engineering_context',{workspace_path:root,project_id:p});
    assert.ok(external.workspace && external.entries && external.analysis_refs);
    for(const context of [analysis.architecture_document,question.context.architecture_document,external.architecture_document]){
      assert.equal(context.version,updated.version);
      assert.equal(context.baseline.commit,git(root,'rev-parse','HEAD'));
      assert.equal(context.baseline.branch,'main');
      assert.equal(context.baseline.dirty,false);
      assert.equal(context.pending_review_count,0);
      assert.equal(context.update_status,'up_to_date');
      const module=context.modules.find((m:ArchitectureModule)=>m.id==='plan');
      assert.equal(module.parent_id,'entry');
      assert.equal(module.implementation_status,'planned');
      assert.match(module.implementation_note,/NOT YET IMPLEMENTED/i);
      const entry=context.modules.find((m:ArchitectureModule)=>m.id==='entry');
      assert.deepEqual([entry.name,entry.notes,entry.origin],['Owner entry','Send events here','manual_override']);
      assert.equal(entry.code_links[0].path,'src/run.ts');
      assert.equal(context.relations[0].label,'Revised route');
      assert.equal(context.relations[0].notes,'only proposed');
    }
  } finally {await bridge.close();}
  assert.deepEqual(await targetState(),before);
});

test('GC keeps current and historical baseline and update-run snapshots and collects an unrelated snapshot',async()=>{
  const dir=await directory(),store=new Store(dir);
  try {
    const snapshots=path.join(dir,'snapshots');
    const ids=['source-old-base','source-old-read','source-current-base','source-current-read','source-unused'];
    for(const id of ids){
      const target=path.join(snapshots,id);
      await fs.mkdir(target,{recursive:true});
      await fs.utimes(target,new Date(at),new Date(at));
      store.put('snapshot',id,{source_snapshot_id:id,captured_at:at});
    }
    const baseline=(id:string)=>({snapshot_id:id,fingerprint:'manifest',dirty:false,workspace_fingerprint:'tree',file_hashes:{},captured_at:at});
    const update=(id:string):UpdateRunRecord=>({id:'update',started_at:at,base_doc_version:0,read_baseline:baseline(id),
      post_check_consistent:true,detection_summary:{changed_files:[],detection_reliable:true},
      impact_summary:{mode:'none',reason:'no changes',affected_module_ids:[],affected_feature_ids:[],reused_module_ids:[],unmapped_files:[]},
      model_calls:0,auto_updates:[],review_item_ids:[],module_outcomes:{},overall_status:'up_to_date'});
    const doc=store.saveArchitectureDoc({...seed(),baseline:baseline(ids[0]),last_update:update(ids[1])},0);
    store.saveArchitectureDoc({...doc,baseline:baseline(ids[2]),last_update:update(ids[3])},1);
    await pruneUnreferencedSnapshots(dir,store);
    assert.deepEqual((await fs.readdir(snapshots)).sort(),ids.slice(0,4).sort());
    assert.deepEqual(store.all('snapshot').map(row=>row.source_snapshot_id).sort(),ids.slice(0,4).sort());
  } finally {store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('offline reading and engineering context select the stored architecture for the frozen snapshot',async t=>{
  const dir=await directory(),service=new ArcService(dir,process.cwd()),store=service.store;
  t.after(async()=>{await service.shutdown();store.close();await fs.rm(dir,{recursive:true,force:true});});
  const p='p',snapshot='source-old',root=path.join(dir,'unmounted');
  const explanation=legacy(p,snapshot);
  explanation.branch_key='main';
  store.put('project',p,{project_id:p,name:'Offline',snapshot_id:snapshot,root_path:root});
  store.put('snapshot',snapshot,{project_id:p,source_snapshot_id:snapshot,files:[{path:'src/run.ts'}],fingerprint:'old'});
  store.put('explanation',explanation.result_id,explanation);
  store.put('scenario','scenario',{project_id:p,scenario_id:'scenario',feature_id:'feature',question_revision_id:'rev'});
  store.put('feature','feature',{project_id:p,feature_id:'feature',name:'Dispatch'});
  store.put('revision','rev',{question:'How does dispatch work?'});
  store.put('engineering_workspace','ws',{workspace_id:'ws',project_id:p,status:'bound',root_path:root});
  store.put('engineering_context_state',p,{version:1});
  store.put('engineering_state','ws',{snapshot_id:snapshot,fingerprint:'old',branch:'main',head:'commit',dirty:[]});
  const original=store.saveArchitectureDoc({...seed(),baseline:{snapshot_id:snapshot,fingerprint:'old',
    file_hashes:{},dirty:false,workspace_fingerprint:'old',captured_at:at}},0);
  service.store.saveArchitectureDoc({...original,title:'later main',baseline:{...original.baseline!,snapshot_id:'later'}},1);
  service.store.saveArchitectureDoc({...original,id:architectureDocId(p,'other'),branch_key:'other',title:'other branch'},0);
  assert.equal(service.store.findArchitectureDocForSnapshot(p,snapshot,'main')?.id,original.id);
  assert.equal(service.store.findArchitectureDocForSnapshot('another-project',snapshot),undefined);
  const reading=await service.askReading({project_id:p,scenario_id:'scenario',result_id:explanation.result_id,
    target:{kind:'file',id:'src/run.ts'},question:'Which revision is visible?',mode:'mcp',submission_key:'frozen-history'});
  const entry=await service.engineering.context({project_id:p,entry_id:'no-such-entry'});
  const bridge=new ArcMcpBridge(service,process.cwd());
  const request={project_id:p,workspace_path:root,result_id:explanation.result_id};
  try {
    await assert.rejects(bridge.call('arc_engineering_context',request),/授权/);
    await bridge.enable(p);
    await assert.rejects(bridge.call('arc_engineering_context',{...request,workspace_path:root+'-other'}),/尚未绑定/);
    await assert.rejects(bridge.call('arc_engineering_context',{...request,project_id:'another'}),/归属不一致/);
    await assert.rejects(bridge.call('arc_begin_development',request),{code:'ENOENT'});
    const context=await bridge.call('arc_engineering_context',request);
    for(const doc of [reading.context.architecture_document,entry.architecture_document,context.architecture_document]){
      assert.equal(doc?.id,original.id);
      assert.equal(doc?.version,original.version);
    }
    assert.ok(context.live_state_error);
    assert.equal(context.analysis?.status,'needs_review');
  } finally {await bridge.close();}
  await assert.rejects(service.engineering.context({project_id:p,refresh:true}));
  // A manual branch document can predate code analysis and therefore has no snapshot ID.
  store.saveArchitectureDoc({...original,id:architectureDocId(p,'plan'),branch_key:'plan',baseline:undefined},0);
  store.put('engineering_state','ws',{snapshot_id:'unmatched',branch:'plan',dirty:[]});
  assert.equal((await service.engineering.context({project_id:p,cached:true})).architecture_document?.branch_key,'plan');
});
