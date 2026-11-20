// Real Codex acceptance of opening the complete current repository from ARC.
// Run after build: node scripts/project-onboarding-ui.mjs
// Uses the existing official login; consumes account usage, never runs in npm test.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const freshProject=process.env.ARC_VERIFY_NEW_PROJECT==='1';
const root=path.resolve('.'),scratch=path.resolve(freshProject?'../.test-data/first-analysis-current':'../.test-data/project-onboarding');
await fs.mkdir(scratch,{recursive:true});
const env={...process.env,ARC_DATA_DIR:path.join(scratch,'data')};delete env.ELECTRON_RUN_AS_NODE;
if(freshProject)assert.equal(await fs.access(path.join(env.ARC_DATA_DIR,'arc.sqlite')).then(()=>true,()=>false),false,'Fresh-project acceptance requires an empty first-analysis data directory; it never reuses saved results.');
let app,page;const errors=[];
const read=()=>page.evaluate(()=>window.arc.invoke('data'));
async function launch(){
  app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.locator('header').first().waitFor();
}
async function openProject(button,directory=root){
  await page.getByRole('button',{name:'打开工程',exact:true}).click();
  await page.getByLabel('本地工程绝对路径',{exact:true}).fill(directory);
  await page.screenshot({path:path.join(scratch,'open.png')});
  const submittedAt=Date.now();
  if(button==='打开并分析')await page.getByLabel('本地工程绝对路径',{exact:true}).press('Enter');
  else await page.getByRole('button',{name:button,exact:true}).click();
  await page.locator('dialog').waitFor({state:'hidden',timeout:60000});
  await page.locator('.workspace').waitFor();
  return submittedAt;
}
async function waitRun(runId,timeout=900000,onPoll=async()=>{}){
  const start=Date.now();let logged=0;
  while(Date.now()-start<timeout){
    const data=await read(),run=data.runs.find(r=>r.binding.run_id===runId);
    assert.ok(run);
    await onPoll(run,data);
    if(['completed','failed','cancelled','unknown','blocked_external'].includes(run.status)){
      assert.equal(run.status,'completed',run.error||run.status);return data;
    }
    if(Date.now()-logged>20000){console.log(`Real Codex ${run.title}: ${run.status}, ${Math.round((Date.now()-start)/1000)}s`);logged=Date.now();}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  await page.evaluate(id=>window.arc.invoke('run_cancel',{run_id:id}),runId);
  throw Error(`Real onboarding acceptance exceeded ${timeout/60000} minutes; task stopped and diagnostics retained.`);
}
async function firstAnalysisJourney(){
  const empty=await read();
  assert.equal(empty.projects.length,0);assert.equal(empty.runs.length,0);assert.equal(empty.explanations.length,0);
  const submittedAt=await openProject('打开并分析');
  await page.waitForFunction(async()=>(await window.arc.invoke('data')).runs.length===1);
  let data=await read(),run=data.runs[0];
  assert.equal(run.provider_id,'codex');assert.equal(run.origin,undefined);assert.equal(run.overview_from_result_id,undefined);
  assert.equal(run.overview_format,'overview-1');
  const runId=run.binding.run_id,observedStages=new Set();
  data=await waitRun(runId,310000,async(current,progress)=>{
    if(current.status!=='completed')assert.equal(progress.explanations.length,0,'Candidates must remain unpublished during generation, research and recheck.');
    const events=await page.evaluate(id=>window.arc.invoke('run_events',{run_id:id}),runId);
    const stage=events.filter(e=>e.type==='local.stage').at(-1)?.stage;
    if(stage&&!observedStages.has(stage)){
      observedStages.add(stage);console.log(`First analysis stage: ${stage}, ${((Date.now()-submittedAt)/1000).toFixed(1)}s since open`);
      if(['overview_discovery','overview_review','overview_research','overview_recheck'].includes(stage)){
        await page.screenshot({path:path.join(scratch,`${stage}.png`)});
      }
    }
  });
  run=data.runs.find(r=>r.binding.run_id===runId);
  assert.equal(data.runs.length,1,'Opening must automatically finish all phases inside the original task.');
  assert.equal(data.explanations.length,1,'Only the fully checked first result may be published.');
  const explanation=data.explanations[0],result=explanation.result;
  assert.equal(result.binding.run_id,runId);assert.equal(result.binding.source_snapshot_id,run.binding.source_snapshot_id);
  const directory=path.join(env.ARC_DATA_DIR,'runs',runId);
  const json=async file=>JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));
  const initial=await json('review/result.json'),final=await json('overview-review.json');
  const rejected=initial.relations.filter(r=>r.verdict!=='supported');
  const events=await page.evaluate(id=>window.arc.invoke('run_events',{run_id:id}),runId);
  const stages=['overview_review','overview_research','overview_recheck','overview_reviewed'].map(stage=>({stage,at:events.find(e=>e.type==='local.stage'&&e.stage===stage)?.received_at}));
  const elapsedSeconds=(Date.parse(run.ended_at)-Date.parse(run.created_at))/1000;
  const totalSeconds=(Date.parse(run.ended_at)-submittedAt)/1000;
  console.log(JSON.stringify({run:runId,result:explanation.result_id,snapshot:run.binding.source_snapshot_id,totalSeconds,elapsedSeconds,rejected:rejected.map(r=>({edge:r.edge_id,reason:r.reason})),stages},null,2));
  assert.ok(rejected.length,'This fresh real run found no relation doubts: first analysis passed, but the automatic research branch was not exercised. Do not claim that branch passed.');
  const research=await json('research/result.json'),recheck=await json('recheck/result.json');
  for(const reply of [initial,research,recheck,final]){
    assert.equal(reply.run_id,runId);assert.equal(reply.source_snapshot_id,run.binding.source_snapshot_id);
  }
  assert.deepEqual(research.relations.map(r=>r.edge_id).sort(),rejected.map(r=>r.edge_id).sort());
  const resolved=research.relations.filter(r=>r.outcome==='resolved');
  assert.ok(resolved.length,'At least one genuinely doubtful relation must be investigated and independently rechecked.');
  assert.deepEqual(recheck.relations.map(r=>r.edge_id).sort(),resolved.map(r=>r.edge_id).sort());
  const reads=events.filter(e=>e.phase==='overview_research'&&e.type==='item.completed'&&e.item?.type==='mcp_tool_call'&&e.item.server==='arc_frozen_source'&&e.item.tool==='arc_read_source'&&e.item.status==='completed'&&!e.item.error&&!e.item.result?.isError);
  assert.ok(reads.length,'Automatic investigation must actually read frozen source, not reuse a saved explanation.');
  assert.ok(stages.every(s=>s.at));
  assert.ok(result.edges.every(e=>final.relations.some(r=>r.edge_id===e.edge_id&&r.verdict==='supported')));
  assert.ok(result.architecture?.node_ids.length&&result.feature_catalog?.groups.length);
  assert.ok(totalSeconds<240,`Opening through automatic research, recheck and saving took ${totalSeconds}s; target is below 240s.`);
  const recovered=recheck.relations.filter(r=>r.verdict==='supported').map(r=>r.edge_id);
  assert.ok(recovered.length,'A newly checked relation must actually reach the displayed result.');
  assert.ok(recovered.every(id=>result.edges.some(e=>e.edge_id===id)));
  const edge=result.edges.find(e=>e.edge_id===recovered[0]);
  const citation=result.evidence.find(e=>edge.evidence_ids.includes(e.evidence_id));
  assert.ok(research.evidence.some(e=>e.id===citation.evidence_id),'The displayed citation must be newly read during automatic research.');
  // No clicks, retries, research button or external conversation between opening and completion.
  await page.locator('.architecture-node').first().waitFor();
  const relation=page.locator(`[data-edge-id="${recovered[0]}"]`);
  await relation.focus();await relation.press('Enter');
  await page.locator('.supporting-evidence summary').click();await page.locator('.supporting-evidence .evidence-button').first().click();
  const source=page.getByLabel('所选来源依据',{exact:true});await source.locator('pre').waitFor();
  const sourceText=await source.innerText();
  for(const text of [citation.path,citation.source_snapshot_id,citation.content_sha256,`第 ${citation.line_start}–${citation.line_end} 行`])assert.ok(sourceText.includes(text),`Citation must show ${text}`);
  const frozen=await fs.readFile(path.join(env.ARC_DATA_DIR,'snapshots',citation.source_snapshot_id,citation.path),'utf8');
  const highlighted=await source.locator('pre .highlight').evaluateAll(lines=>lines.map(line=>[...line.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('')).join(''));
  assert.equal(highlighted,frozen.split(/\r\n|\n|\r/).slice(citation.line_start-1,citation.line_end).map(line=>line+'\n').join(''));
  await page.screenshot({path:path.join(scratch,'result.png')});
  await page.locator('footer').getByText('阅读位置已保存',{exact:false}).waitFor();
  await app.close();await launch();
  await page.locator(`[data-edge-id="${recovered[0]}"]`).waitFor();
  const restored=await read();assert.equal(restored.runs.length,1);assert.equal(restored.explanations[0].result_id,explanation.result_id);
  assert.deepEqual(restored.explanations[0].result.edges.find(e=>e.edge_id===edge.edge_id),edge);
  assert.deepEqual(restored.explanations[0].result.evidence.find(e=>e.evidence_id===citation.evidence_id),citation);
  assert.equal(errors.length,0,errors.join('\n'));
  const times=[Date.parse(run.created_at),...stages.map(s=>Date.parse(s.at)),Date.parse(run.ended_at)];
  console.log(JSON.stringify({passed:true,newProject:true,newAnalysis:true,run:runId,result:explanation.result_id,snapshot:run.binding.source_snapshot_id,totalSeconds,elapsedSeconds,phaseSeconds:Object.fromEntries(['generation','initialReview','research','recheck','save'].map((name,i)=>[name,(times[i+1]-times[i])/1000])),actualResearchReads:reads.length,researchedRelations:rejected.length,recoveredRelations:recovered.length,remainingRelations:final.relations.filter(r=>r.verdict!=='supported').length,checks:['empty data, open complete current repository','one direct Codex task automatically investigates and rechecks genuine doubts','no intermediate user action or external Agent','only source-checked relations displayed','new relation evidence opens','restart restores first result without another task']},null,2));
}
async function researchJourney(){
  await openProject('仅打开');
  let data=await read();
  const project=data.projects.find(p=>p.root_path===root);
  const original=data.explanations.find(e=>e.result.binding.project_id===project.project_id&&e.result.gaps.some(g=>g.question.includes('r-submit')&&g.gap_id.startsWith('overview-review-')));
  assert.ok(original,'This acceptance continues the real saved r-submit gap.');
  const originalJson=JSON.stringify(original),questionIds=data.questions.filter(q=>q.result_id===original.result_id).map(q=>q.question_id);
  await page.getByRole('button',{name:'工程全貌',exact:true}).click();
  await page.locator('.detail-tabs').getByRole('button',{name:'历史',exact:true}).click();
  const historyIndex=data.explanations.filter(e=>e.scenario_id===original.scenario_id).reverse().findIndex(e=>e.result_id===original.result_id);
  await page.locator('.history-row').nth(historyIndex).click();
  await page.locator('.architecture-node').first().click();
  let run=data.runs.filter(r=>r.overview_from_result_id===original.result_id&&r.status==='completed').at(-1);
  const newResearch=!run||process.env.ARC_VERIFY_FRESH_RESEARCH==='1';
  if(newResearch){
    const ids=new Set(data.runs.map(r=>r.binding.run_id));
    await page.getByRole('button',{name:'自动补查关系',exact:true}).click();
    await page.waitForFunction(async resultId=>(await window.arc.invoke('data')).runs.some(r=>r.overview_from_result_id===resultId&&['queued','running','validating'].includes(r.status)),original.result_id);
    data=await read();run=data.runs.find(r=>!ids.has(r.binding.run_id)&&r.overview_from_result_id===original.result_id);assert.ok(run);
    assert.equal(await page.locator('[data-edge-id="r-submit"]').count(),0,'Unreviewed correction must not appear in the original graph.');
    await page.screenshot({path:path.join(scratch,'research-progress.png')});
    data=await waitRun(run.binding.run_id,300000);
  }
  run=data.runs.find(r=>r.binding.run_id===run.binding.run_id);
  const revised=data.explanations.find(e=>e.result.binding.run_id===run.binding.run_id);assert.ok(revised);
  assert.notEqual(revised.result_id,original.result_id);
  assert.equal(revised.result.binding.source_snapshot_id,original.result.binding.source_snapshot_id);
  assert.equal(JSON.stringify(data.explanations.find(e=>e.result_id===original.result_id)),originalJson);
  assert.ok(questionIds.every(id=>data.questions.some(q=>q.question_id===id&&q.result_id===original.result_id)));
  const edge=revised.result.edges.find(e=>e.edge_id==='r-submit');assert.ok(edge,'The specific previous gap must actually be resolved.');
  assert.equal(edge.kind,'dependency');assert.equal(edge.status,'source_supported');assert.equal(edge.source_node_id,'mcp');assert.equal(edge.target_node_id,'service');
  assert.match(edge.label,/校验|保存/);
  const statement=revised.result.claims.filter(c=>edge.claim_ids.includes(c.claim_id)).map(c=>c.statement).join('\n');
  assert.match(statement,/同进程/);assert.match(statement,/依赖/);assert.match(statement,/事务/);
  const runDirectory=path.join(env.ARC_DATA_DIR,'runs',run.binding.run_id);
  const research=JSON.parse(await fs.readFile(path.join(runDirectory,'research','result.json'),'utf8'));
  const recheck=JSON.parse(await fs.readFile(path.join(runDirectory,'recheck','result.json'),'utf8'));
  assert.ok(research.relations.some(item=>item.edge_id==='r-submit'&&item.outcome==='resolved'));
  assert.ok(recheck.relations.some(item=>item.edge_id==='r-submit'&&item.verdict==='supported'));
  const events=await page.evaluate(id=>window.arc.invoke('run_events',{run_id:id}),run.binding.run_id);
  const sourceReads=events.filter(e=>e.phase==='overview_research'&&e.type==='item.completed'&&e.item?.tool==='arc_read_source'&&e.item.status==='completed');
  assert.ok(sourceReads.length>0,'Research must make real frozen-source tool reads.');
  const newEvidence=revised.result.evidence.filter(e=>edge.evidence_ids.includes(e.evidence_id));
  assert.ok(newEvidence.some(e=>e.path==='src/main/mcp-bridge.ts'));
  assert.ok(newEvidence.some(e=>e.path==='src/main/service.ts'||e.path==='src/main/main.ts'));
  assert.equal(await page.locator('[data-edge-id="r-submit"]').count(),0,'Completion must not replace the graph being read.');
  await page.getByRole('button',{name:'查看本次分析结果',exact:true}).first().click();
  await page.locator('[data-edge-id="r-submit"]').focus();await page.locator('[data-edge-id="r-submit"]').press('Enter');
  await page.locator('.supporting-evidence summary').click();await page.locator('.supporting-evidence .evidence-button').first().click();
  await page.locator('[aria-label="所选来源依据"] pre').waitFor();
  await page.screenshot({path:path.join(scratch,'research-result.png')});
  await app.close();await launch();
  await page.locator('[data-edge-id="r-submit"]').waitFor();
  assert.ok((await read()).explanations.some(e=>e.result_id===revised.result_id));assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({passed:true,newResearch,run:run.binding.run_id,original:original.result_id,result:revised.result_id,snapshot:revised.result.binding.source_snapshot_id,elapsedSeconds:(Date.parse(run.ended_at)-Date.parse(run.created_at))/1000,actualSourceReads:sourceReads.length,label:edge.label,kind:edge.kind,checks:['real automatic source investigation','only the rejected relation revised and independently rechecked','original graph and questions preserved','source citation opens','restart restores corrected relation']},null,2));
}
try{
  await launch();
  if(freshProject)await firstAnalysisJourney();
  else if(process.env.ARC_VERIFY_RESEARCH==='1')await researchJourney();
  else{

  const initialRuns=new Set((await read()).runs.map(run=>run.binding.run_id));
  await openProject('打开并分析');
  let data=await read();const project=data.projects.find(p=>p.root_path===root);assert.ok(project?.overview_scenario_id);
  let run=data.runs.filter(r=>r.binding.scenario_id===project.overview_scenario_id&&!r.reading_question_id&&!r.overview_from_result_id).at(-1);
  if(run&&(['failed','cancelled','unknown','blocked_external'].includes(run.status)||process.env.ARC_VERIFY_FRESH_OVERVIEW==='1'&&run.status==='completed')){
    const previousId=run.binding.run_id;
    await page.locator('.context .analysis-start').click();
    await page.waitForFunction(async ({previousId,scenarioId})=>{const data=await window.arc.invoke('data');return data.runs.filter(r=>r.binding.scenario_id===scenarioId&&!r.reading_question_id&&!r.overview_from_result_id).at(-1)?.binding.run_id!==previousId;},{previousId,scenarioId:project.overview_scenario_id});
    data=await read();run=data.runs.filter(r=>r.binding.scenario_id===project.overview_scenario_id&&!r.reading_question_id&&!r.overview_from_result_id).at(-1);
    assert.notEqual(run.binding.run_id,previousId,'Explicit UI retry must create a new run.');
  }
  assert.ok(run);assert.equal(run.provider_id,'codex');assert.notEqual(run.origin,'mcp');assert.notEqual(run.status,'waiting_agent');
  const newAnalysis=!initialRuns.has(run.binding.run_id);console.log(newAnalysis?'Started a new real whole-project analysis.':'Reusing saved real whole-project analysis for UI regression.');
  if(newAnalysis){
    assert.equal(await page.locator('.detail-tabs').getByRole('button',{name:'分析进度',exact:true}).count(),1);
    await page.screenshot({path:path.join(scratch,'progress.png')});
  }
  data=await waitRun(run.binding.run_id);
  run=data.runs.find(item=>item.binding.run_id===run.binding.run_id);
  assert.equal(run.overview_format,'overview-1','Acceptance must use the compact, independently reviewed overview. Set ARC_VERIFY_FRESH_OVERVIEW=1 for an older saved result.');
  const request=JSON.parse(await fs.readFile(path.join(env.ARC_DATA_DIR,'runs',run.binding.run_id,'request.json'),'utf8'));
  assert.ok(request.args.includes('model_reasoning_effort="low"'),'Built-in overview must use its scoped discovery depth.');
  const explanation=data.explanations.find(e=>e.result.binding.run_id===run.binding.run_id);assert.ok(explanation);
  assert.ok(explanation.result.architecture?.node_ids.length,'Whole project must have a source-backed architecture.');
  assert.ok(explanation.result.feature_catalog?.groups.some(g=>g.node_ids.length),'Whole project must have a feature catalog.');
  assert.ok(explanation.result.evidence.length);assert.equal(run.origin,undefined);
  const elapsedSeconds=(Date.parse(run.ended_at)-Date.parse(run.created_at))/1000;
  const raw=await fs.readFile(path.join(env.ARC_DATA_DIR,'runs',run.binding.run_id,'result.json'),'utf8');
  const reviewPath=path.join(env.ARC_DATA_DIR,'runs',run.binding.run_id,'overview-review.json');
  const review=JSON.parse(await fs.readFile(await fs.access(reviewPath).then(()=>reviewPath,()=>path.join(env.ARC_DATA_DIR,'runs',run.binding.run_id,'review','result.json')),'utf8'));
  assert.equal(review.schema_version,'overview-review-1');
  assert.equal(review.run_id,run.binding.run_id);assert.equal(review.source_snapshot_id,run.binding.source_snapshot_id);
  assert.ok(explanation.result.edges.every(edge=>!['sync_call','return'].includes(edge.kind)),'High-level overview must not invent synchronous call/return semantics.');
  assert.ok(explanation.result.edges.every(edge=>review.relations.some(item=>item.edge_id===edge.edge_id&&item.verdict==='supported')),'Every displayed relation must pass the independent source review.');
  assert.match(run.validation.semantic,/独立 Agent/);
  if(newAnalysis)assert.ok(elapsedSeconds<240,`First analysis including review took ${elapsedSeconds}s; target below 240s versus the 371s baseline.`);
  console.log(JSON.stringify({elapsedSeconds,rawBytes:Buffer.byteLength(raw),reviewedRelations:review.relations.length,excludedRelations:review.relations.filter(item=>item.verdict!=='supported').length,snapshot:run.binding.source_snapshot_id}));
  await page.getByRole('button',{name:'工程全貌',exact:true}).click();
  await page.locator('.architecture-node').first().waitFor();
  await page.locator('.detail-tabs').getByRole('button',{name:'历史',exact:true}).click();
  const resultIndex=data.explanations.filter(e=>e.scenario_id===explanation.scenario_id).reverse().findIndex(e=>e.result_id===explanation.result_id);
  await page.locator('.history-row').nth(resultIndex).click();
  const nodeId=await page.locator('[data-component-id]').first().getAttribute('data-component-id');
  await page.locator('.architecture-node').first().click();
  await page.getByRole('button',{name:'就这里提问',exact:true}).click();
  const question='这个组件负责什么？它和其他组件怎样协作？只解释已查证的主要职责，150字以内并给出源码依据。';
  let q=(await read()).questions.find(q=>q.result_id===explanation.result_id&&q.question===question&&q.answer);
  if(!q){
    await page.getByLabel('当前位置的问题',{exact:true}).fill(question);
    await page.getByLabel('当前位置的问题',{exact:true}).press('Control+Enter');
    await page.waitForFunction(text=>document.querySelector('.question-thread')?.textContent?.includes(text),question);
    q=(await read()).questions.filter(q=>q.question===question).at(-1);assert.ok(q);
    data=await waitRun(q.run_id,300000);q=data.questions.find(item=>item.question_id===q.question_id);
  }
  assert.ok(q.answer.evidence.length);assert.equal(q.source_snapshot_id,explanation.result.binding.source_snapshot_id);assert.equal(q.result_id,explanation.result_id);assert.equal(q.target.id,nodeId);
  await page.locator('.question-answer').first().waitFor();
  await page.locator('.question-evidence button').first().click();
  await page.locator('[aria-label="冻结源码依据"] pre').waitFor();
  await page.getByRole('button',{name:'返回这条回答',exact:false}).click();
  await page.screenshot({path:path.join(scratch,'question.png')});
  // The first graph must already represent IPC without a false sync_call.
  // The subsequent user clue exercises contextual follow-up, not graph repair.
  const ipcEdge=explanation.result.edges.find(edge=>/IPC/i.test(edge.label)&&edge.kind==='execution_boundary');assert.ok(ipcEdge,'A source-backed IPC boundary must survive review.');
  assert.ok(ipcEdge.evidence_ids.some(id=>explanation.result.evidence.some(e=>e.evidence_id===id&&/preload|main\.ts/.test(e.path))));
  await page.locator(`[data-edge-id="${ipcEdge.edge_id}"]`).focus();
  await page.locator(`[data-edge-id="${ipcEdge.edge_id}"]`).press('Enter');
  await page.getByRole('button',{name:'就这里提问',exact:true}).click();
  const correction=(ipcEdge.kind==='sync_call'?'请纠正并核对这条关系：图中 IPC 被标成同步调用，但':'请核对这条关系：')+'我认为 ipcRenderer.invoke 返回 Promise。它实际怎样交接？收到成功是否表示分析结果已保存？200字以内，用源码依据说明，并指出原图的表述边界。';
  let corrected=(await read()).questions.find(item=>item.result_id===explanation.result_id&&item.question===correction&&item.answer);
  if(!corrected){
    await page.getByLabel('当前位置的问题',{exact:true}).fill(correction);
    await page.getByLabel('这是纠错，同时保存为对象批注',{exact:true}).check();
    await page.getByLabel('当前位置的问题',{exact:true}).press('Control+Enter');
    await page.waitForFunction(text=>document.querySelector('.question-thread')?.textContent?.includes(text),correction);
    corrected=(await read()).questions.filter(item=>item.question===correction).at(-1);assert.ok(corrected);
    data=await waitRun(corrected.run_id,300000);corrected=data.questions.find(item=>item.question_id===corrected.question_id);
  }
  assert.equal(corrected.target.kind,'edge');assert.equal(corrected.target.id,ipcEdge.edge_id);
  assert.ok(corrected.context.annotations.some(item=>item.text===correction));
  assert.match(corrected.answer.answer,/Promise|异步/);assert.ok(corrected.answer.evidence.length);
  assert.equal((await read()).explanations.find(item=>item.result_id===explanation.result_id).result.edges.find(edge=>edge.edge_id===ipcEdge.edge_id).kind,ipcEdge.kind);
  await page.locator(`[data-question-id="${corrected.question_id}"] .question-answer`).waitFor();
  await page.screenshot({path:path.join(scratch,'correction.png')});
  await page.getByRole('button',{name:'浏览功能总览',exact:true}).click();
  await page.locator('.capability-card').first().waitFor();
  const firstFeature=await page.locator('.capability-card strong').first().innerText();
  await page.getByLabel('搜索工程功能',{exact:true}).fill(firstFeature);
  assert.ok(await page.locator('.capability-card').count()>0);
  await page.getByLabel('搜索工程功能',{exact:true}).fill('no-such-feature-123456');
  assert.equal(await page.locator('.capability-card').count(),0);
  await page.getByRole('button',{name:'清除搜索',exact:true}).click();
  await page.setViewportSize({width:1024,height:768});
  await page.screenshot({path:path.join(scratch,'catalog-compact.png')});
  assert.ok(await page.evaluate(()=>document.body.scrollWidth<=window.innerWidth+2),'Catalog must fit a compact desktop window.');
  await page.setViewportSize({width:1424,height:861});
  await page.screenshot({path:path.join(scratch,'catalog.png')});
  const before=(await read()).runs.length;
  await openProject('打开并分析');
  assert.equal((await read()).runs.length,before,'Reopening must restore reading without another model run.');
  await page.locator('.capability-card').first().waitFor();
  const beforeBrowse=(await read()).runs.length;
  await openProject('仅打开',path.join(root,'src/ui'));
  assert.equal((await read()).runs.length,beforeBrowse,'Browse-only must not invoke a model.');
  const browseProject=(await read()).projects.find(p=>p.root_path===path.join(root,'src/ui'));assert.ok(browseProject);
  assert.equal(await page.getByLabel('当前工程',{exact:true}).inputValue(),browseProject.project_id);
  await page.getByLabel('当前工程',{exact:true}).selectOption(project.project_id);
  await page.locator('.capability-card').first().waitFor();
  await app.close();await launch();
  await page.locator('.capability-card').first().waitFor();
  assert.ok((await read()).questions.some(item=>item.question_id===q.question_id&&item.answer));
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({passed:true,newAnalysis,project:project.project_id,result:explanation.result_id,question:q.question_id,correction:corrected.question_id,components:explanation.result.architecture.node_ids.length,features:explanation.result.feature_catalog.groups.reduce((n,g)=>n+g.node_ids.length,0),checks:['open and directly analyze the complete repository','real source-backed architecture and catalog','ask about a generated component in ARC','return from evidence','correction included in a real question with source-backed answer','feature search','reopen without duplicate analysis','browse only without a model','restart restores reading']},null,2));
  }
}catch(error){if(page)await page.screenshot({path:path.join(scratch,'failure.png')}).catch(()=>{});throw error;}
finally{await app?.close();}
