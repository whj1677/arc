// Real Codex acceptance of opening the complete current repository from ARC.
// Run after build: node scripts/project-onboarding-ui.mjs
// Uses the existing official login; consumes account usage, never runs in npm test.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.'),scratch=path.resolve('../.test-data/project-onboarding');
await fs.mkdir(scratch,{recursive:true});
const env={...process.env,ARC_DATA_DIR:path.join(scratch,'data')};delete env.ELECTRON_RUN_AS_NODE;
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
  if(button==='打开并分析')await page.getByLabel('本地工程绝对路径',{exact:true}).press('Enter');
  else await page.getByRole('button',{name:button,exact:true}).click();
  await page.locator('dialog').waitFor({state:'hidden',timeout:60000});
  await page.locator('.workspace').waitFor();
}
async function waitRun(runId,timeout=900000){
  const start=Date.now();let logged=0;
  while(Date.now()-start<timeout){
    const data=await read(),run=data.runs.find(r=>r.binding.run_id===runId);
    assert.ok(run);
    if(['completed','failed','cancelled','unknown','blocked_external'].includes(run.status)){
      assert.equal(run.status,'completed',run.error||run.status);return data;
    }
    if(Date.now()-logged>20000){console.log(`Real Codex ${run.title}: ${run.status}, ${Math.round((Date.now()-start)/1000)}s`);logged=Date.now();}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  await page.evaluate(id=>window.arc.invoke('run_cancel',{run_id:id}),runId);
  throw Error(`Real onboarding acceptance exceeded ${timeout/60000} minutes; task stopped and diagnostics retained.`);
}
try{
  await launch();
  const initialRuns=new Set((await read()).runs.map(run=>run.binding.run_id));
  await openProject('打开并分析');
  let data=await read();const project=data.projects.find(p=>p.root_path===root);assert.ok(project?.overview_scenario_id);
  let run=data.runs.filter(r=>r.binding.scenario_id===project.overview_scenario_id&&!r.reading_question_id).at(-1);
  if(run&&(['failed','cancelled','unknown','blocked_external'].includes(run.status)||process.env.ARC_VERIFY_FRESH_OVERVIEW==='1'&&run.status==='completed')){
    const previousId=run.binding.run_id;
    await page.locator('.context .analysis-start').click();
    await page.waitForFunction(async ({previousId,scenarioId})=>{const data=await window.arc.invoke('data');return data.runs.filter(r=>r.binding.scenario_id===scenarioId&&!r.reading_question_id).at(-1)?.binding.run_id!==previousId;},{previousId,scenarioId:project.overview_scenario_id});
    data=await read();run=data.runs.filter(r=>r.binding.scenario_id===project.overview_scenario_id&&!r.reading_question_id).at(-1);
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
  assert.ok(request.args.includes('model_reasoning_effort="medium"'),'Built-in overview must use its scoped discovery depth.');
  const explanation=data.explanations.find(e=>e.result.binding.run_id===run.binding.run_id);assert.ok(explanation);
  assert.ok(explanation.result.architecture?.node_ids.length,'Whole project must have a source-backed architecture.');
  assert.ok(explanation.result.feature_catalog?.groups.some(g=>g.node_ids.length),'Whole project must have a feature catalog.');
  assert.ok(explanation.result.evidence.length);assert.equal(run.origin,undefined);
  const elapsedSeconds=(Date.parse(run.ended_at)-Date.parse(run.created_at))/1000;
  const raw=await fs.readFile(path.join(env.ARC_DATA_DIR,'runs',run.binding.run_id,'result.json'),'utf8');
  const review=JSON.parse(await fs.readFile(path.join(env.ARC_DATA_DIR,'runs',run.binding.run_id,'review','result.json'),'utf8'));
  assert.equal(review.schema_version,'overview-review-1');
  assert.equal(review.run_id,run.binding.run_id);assert.equal(review.source_snapshot_id,run.binding.source_snapshot_id);
  assert.ok(explanation.result.edges.every(edge=>!['sync_call','return'].includes(edge.kind)),'High-level overview must not invent synchronous call/return semantics.');
  assert.ok(explanation.result.edges.every(edge=>review.relations.some(item=>item.edge_id===edge.edge_id&&item.verdict==='supported')),'Every displayed relation must pass the independent source review.');
  assert.match(run.validation.semantic,/独立 Agent/);
  if(newAnalysis)assert.ok(elapsedSeconds<240,`First analysis including review took ${elapsedSeconds}s; target below 240s versus the 371s baseline.`);
  console.log(JSON.stringify({elapsedSeconds,rawBytes:Buffer.byteLength(raw),reviewedRelations:review.relations.length,excludedRelations:review.relations.filter(item=>item.verdict!=='supported').length,snapshot:run.binding.source_snapshot_id}));
  await page.getByRole('button',{name:'工程全貌',exact:true}).click();
  await page.locator('.architecture-node').first().waitFor();
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
}catch(error){if(page)await page.screenshot({path:path.join(scratch,'failure.png')}).catch(()=>{});throw error;}
finally{await app?.close();}
