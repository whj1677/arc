// Real Kimi + ARC UI acceptance. Analysis content comes from real Kimi sessions through MCP.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile),root=path.resolve('.'),stage=process.argv[2]||'initial';
const fixture=path.resolve('examples/can-monitor-fixture'),scratch=path.resolve(process.env.ARC_ACCEPTANCE_DIR||'.test-data/can-connections-acceptance');
const workspace=path.join(scratch,'workspace'),counterexample=path.join(scratch,'counterexample'),dataDirectory=path.join(scratch,'kimi-data');
const compiler=path.resolve(process.env.ARC_TEST_CC||'.test-data/acceptance-tools/tcc/tcc/tcc.exe');
const featureName='CAN 节点在线状态',question='这个功能如何接收帧、维护在线计时、判断掉线并恢复？';
const env={...process.env,ARC_DATA_DIR:dataDirectory};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const pageErrors=[];
const read=()=>page.evaluate(()=>window.arc.invoke('data'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function node(args,cwd=root){return exec(process.execPath,args,{cwd,env:{...process.env,ARC_TEST_CC:compiler},windowsHide:true,maxBuffer:16*1024*1024});}
async function runFixture(directory,expectedBehavior){
  let result;try{result=await node([path.join(directory,'verify.mjs')],directory);}catch(error){result=error;}
  const stdout=result.stdout||'',stderr=result.stderr||'',receipts=[...stdout.matchAll(/\{"stage":"(?:compile|behavior)"[^\r\n]+/g)].map(match=>JSON.parse(match[0]));
  const compile=receipts.find(item=>item.stage==='compile'),behavior=receipts.find(item=>item.stage==='behavior');
  assert.equal(compile?.exit_code,0,`编译必须单独成功：${stdout}\n${stderr}`);assert.equal(behavior?.exit_code,expectedBehavior,`行为结果不符合本阶段预期：${stdout}\n${stderr}`);
  if(expectedBehavior===0)assert.match(stdout,/CAN_BEHAVIOR_OK/);else assert.match(stderr,/BEHAVIOR_ASSERTION_FAILED/);
  return {compile,behavior,stdout,stderr};
}
async function git(directory,...args){return exec('git',['-C',directory,...args],{windowsHide:true});}
async function initGit(directory){await git(directory,'init','-b','main');await git(directory,'config','user.name','ARC Acceptance');await git(directory,'config','user.email','arc-acceptance@example.invalid');await git(directory,'add','.');await git(directory,'commit','-m','Disposable CAN acceptance fixture');}
async function registerProject(directory){
  const setup=await node(['--import','tsx','scripts/kimi-session-client.mjs','setup',dataDirectory,directory,featureName,question]),registered=JSON.parse(setup.stdout);
  return {registered};
}
async function prepare(){
  await fs.rm(scratch,{recursive:true,force:true});await fs.mkdir(scratch,{recursive:true});await fs.cp(fixture,workspace,{recursive:true});
  const baseline=await runFixture(workspace,1);await initGit(workspace);const offer=await registerProject(workspace);
  await fs.writeFile(path.join(scratch,'baseline.json'),JSON.stringify(baseline,null,2));await fs.writeFile(path.join(scratch,'initial-offer.json'),JSON.stringify(offer,null,2));
  console.log(JSON.stringify({stage:'prepare',publicFixture:true,compileExit:baseline.compile.exit_code,behaviorExit:baseline.behavior.exit_code,scenario_id:offer.registered.scenario.scenario_id}));
}
async function launch(){app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>pageErrors.push(error.message));await page.locator('header').first().waitFor();}
const navigation=()=>page.getByRole('complementary',{name:'ARC 工程工作台导航'});
const navigate=name=>navigation().getByRole('button',{name,exact:true}).click();
async function openOnly(directory){await navigate('打开工程');const dialog=page.getByRole('dialog');await dialog.getByLabel('本地工程绝对路径',{exact:true}).fill(directory);await dialog.getByRole('button',{name:'仅打开',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});}
async function openSaved(directory){
  await launch();await openOnly(directory);const returnToReading=page.getByRole('button',{name:'返回关联功能走读',exact:true});
  if(await returnToReading.isVisible()){await returnToReading.click();await page.locator('.detail-tabs').waitFor();return;}
  await navigate('功能走读');const scene=page.locator('.scene-row').filter({hasText:'这个功能如何接收帧'});
  if(!await scene.isVisible())await page.locator('.feature-toggle').filter({hasText:featureName}).click();await scene.click();await page.waitForFunction(()=>[...document.querySelectorAll('.scene-row')].some(button=>button.getAttribute('aria-current')==='page'));
}
async function openEvidence(explanation,preferred){
  await page.locator('.detail-tabs').getByRole('button',{name:'依据',exact:true}).click();const buttons=page.locator('.detail .evidence-button');await buttons.first().waitFor();let index=preferred?explanation.result.evidence.findIndex(preferred):0;if(index<0)index=0;await buttons.nth(index).click();const source=page.locator('.question-source');await source.waitFor();await source.locator('pre').waitFor();return {text:await source.textContent(),evidence:explanation.result.evidence[index]};
}
async function close(){await app?.close();app=undefined;page=undefined;}
async function initial(){
  const offer=JSON.parse(await fs.readFile(path.join(scratch,'initial-offer.json')));await openSaved(workspace);const data=await read(),project=data.projects.find(item=>item.root_path===workspace),explanation=data.explanations.find(item=>item.result.binding.run_id===offer.binding.run_id);assert.ok(project&&explanation);
  const serialized=JSON.stringify(explanation.result);for(const symbol of ['last_valid_ms','monitor_tick'])assert.ok(serialized.includes(symbol),`Walkthrough lacks ${symbol}`);const clicked=await openEvidence(explanation,item=>item.path==='can_monitor.c'&&item.role==='write');assert.match(clicked.text,/last_valid_ms/);
  await page.screenshot({path:path.join(scratch,'initial-walkthrough.png')});await fs.writeFile(path.join(scratch,'initial.json'),JSON.stringify({project_id:project.project_id,scenario_id:explanation.scenario_id,run_id:offer.binding.run_id,result_id:explanation.result_id,clicked_evidence:clicked.evidence,result:explanation.result},null,2));assert.equal(pageErrors.length,0,pageErrors.join('\n'));
  console.log(JSON.stringify({stage:'initial',realKimi:true,result_id:explanation.result_id,sourceOpened:true}));
}
async function develop(){
  const initialRecord=JSON.parse(await fs.readFile(path.join(scratch,'initial.json')));await openSaved(workspace);await page.locator('.detail-tabs').getByRole('button',{name:'说明',exact:true}).click();await page.getByRole('region',{name:'围绕当前位置修改'}).getByRole('button',{name:'围绕这里修改',exact:true}).click();
  const goal='无效 CAN 帧不能刷新在线计时，掉线阈值和恢复规则不变。';await page.getByLabel('围绕这里修改的要求',{exact:true}).fill(goal);await page.getByLabel('开发执行通道',{exact:true}).selectOption('kimi');await page.getByLabel('本次允许修改的文件',{exact:true}).fill('can_monitor.c');await page.getByRole('button',{name:'保存并等待 Kimi 接续',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.feature-task-status')?.textContent?.includes('开发执行中'));const data=await read(),task=data.development_tasks?.find(item=>item.reading?.scenario_id===initialRecord.scenario_id);assert.ok(task);assert.equal(task.goal,goal);assert.equal(task.reading.result_id,initialRecord.result_id);assert.equal(task.reading.source_snapshot_id,initialRecord.result.binding.source_snapshot_id);assert.equal(task.status,'running');
  await page.screenshot({path:path.join(scratch,'kimi-task-waiting.png')});await fs.writeFile(path.join(scratch,'develop.json'),JSON.stringify({project_id:initialRecord.project_id,scenario_id:initialRecord.scenario_id,task_id:task.task_id,goal:task.goal,requests:task.requests,reading:task.reading,walkthrough:task.walkthrough,status:task.status},null,2));console.log(JSON.stringify({stage:'develop',realKimi:true,task_id:task.task_id,readingBound:true,status:'waiting_for_kimi'}));
}
async function verify(){
  const record=JSON.parse(await fs.readFile(path.join(scratch,'develop.json')));await launch();await openOnly(workspace);await navigate('工程与开发');await page.getByRole('navigation',{name:'工程栏目'}).getByRole('button',{name:/^任务/}).click();await page.locator('.engineering-task-row').filter({hasText:'无效 CAN 帧'}).click();await page.getByRole('button',{name:'返回关联功能走读',exact:true}).click();await page.locator('.detail-tabs').waitFor();const data=await read(),task=data.development_tasks?.find(item=>item.task_id===record.task_id);assert.equal(task.status,'completed',JSON.stringify({summary:task.summary,unresolved:task.unresolved}));assert.equal(task.walkthrough?.status,'completed',task.walkthrough?.error);assert.ok(task.changes.some(change=>change.path==='can_monitor.c'));assert.ok(task.verification.some(item=>item.origin==='self_reported'&&item.outcome==='passed'),'Kimi must report the actual passing command; ARC keeps it self_reported');
  const renewed=data.explanations.find(item=>item.result_id===task.walkthrough.result_id),old=data.explanations.find(item=>item.result_id===record.reading.result_id),project=data.projects.find(item=>item.project_id===record.project_id);assert.ok(renewed&&old);assert.equal(renewed.scenario_id,old.scenario_id);assert.notEqual(renewed.result.binding.source_snapshot_id,old.result.binding.source_snapshot_id);assert.equal(renewed.source_status,'current');assert.equal(project.snapshot_id,renewed.result.binding.source_snapshot_id,'开发后复核必须自动更新项目来源，不能依赖手动刷新');
  await page.locator('.detail-tabs').getByRole('button',{name:'说明',exact:true}).click();await navigate('调用链');await page.locator('.function-map-node,.fn-participant').first().click();await page.locator('.feature-development').waitFor();await page.locator('.feature-task-origin summary').click();assert.match(await page.locator('.feature-task-origin').textContent(),/无效 CAN 帧不能刷新在线计时/);await page.screenshot({path:path.join(scratch,'function-development.png')});
  await page.locator('.detail-tabs').getByRole('button',{name:'历史',exact:true}).click();await page.locator('.history-row').filter({hasText:old.result.binding.source_snapshot_id.slice(0,12)}).click();await page.locator('.detail-tabs').getByRole('button',{name:'说明',exact:true}).click();const viewButton=page.getByRole('button',{name:'查看同一功能的新版走读',exact:true});await viewButton.waitFor();await viewButton.click();await page.getByText('当前已是新版走读',{exact:true}).waitFor();await page.screenshot({path:path.join(scratch,'current-version-badge.png')});
  const clicked=await openEvidence(renewed,item=>item.path==='can_monitor.c'&&item.role==='write');assert.match(clicked.text,/last_valid_ms/);await page.screenshot({path:path.join(scratch,'fixed-walkthrough.png')});const tested=await runFixture(workspace,0);
  await fs.writeFile(path.join(scratch,'develop.json'),JSON.stringify({...record,status:task.status,requests:task.requests,walkthrough:task.walkthrough,summary:task.summary,decisions:task.decisions,unresolved:task.unresolved,verification:task.verification,clicked_evidence:clicked.evidence,result:renewed.result,automatic_source:true,function_detail_entry:true,host_test:tested},null,2));assert.equal(pageErrors.length,0,pageErrors.join('\n'));
  console.log(JSON.stringify({stage:'verify',realKimi:true,task_id:task.task_id,old_result:old.result_id,new_result:renewed.result_id,automaticSource:true,functionDetailEntry:true,sourceOpened:true,compileExit:tested.compile.exit_code,behaviorExit:tested.behavior.exit_code,arcVerification:'self_reported'}));
}
async function progress(){
  const record=JSON.parse(await fs.readFile(path.join(scratch,'develop.json')));await launch();await openOnly(workspace);await navigate('工程与开发');await page.getByRole('navigation',{name:'工程栏目'}).getByRole('button',{name:/^任务/}).click();await page.locator('.engineering-task-row').filter({hasText:'无效 CAN 帧'}).click();await page.locator('.development-steps').waitFor();
  const task=await page.evaluate(id=>window.arc.invoke('engineering_task',{task_id:id}),record.task_id);assert.equal(task.status,'running');assert.ok(task.steps?.length);
  const unfinished=task.steps.filter(step=>['in_progress','pending'].includes(step.status)),unfinishedIds=new Set(unfinished.map(step=>step.step_id));
  assert.ok(unfinished.length);assert.ok(task.steps.some(step=>step.unresolved.length));assert.ok(task.verification.some(item=>item.outcome==='failed'));
  assert.ok(unfinished.every(step=>step.verification_status!=='passed'),'未完成步骤不应提前出现通过结论');
  assert.ok(!task.verification.some(item=>item.outcome==='passed'&&unfinishedIds.has(item.step_id)),'中途最终复验尚未执行，不应出现该步骤的通过证据');
  await page.screenshot({path:path.join(scratch,'task-steps-progress.png')});await fs.writeFile(path.join(scratch,'progress.json'),JSON.stringify({task_id:task.task_id,version:task.version,status:task.status,steps:task.steps,verification:task.verification},null,2));assert.equal(pageErrors.length,0,pageErrors.join('\n'));console.log(JSON.stringify({stage:'progress',task_id:task.task_id,steps:task.steps.length,unfinished:true,evidence:true}));
}
async function prepareCounterexample(){
  await fs.rm(counterexample,{recursive:true,force:true});await fs.cp(workspace,counterexample,{recursive:true});await fs.rm(path.join(counterexample,'.git'),{recursive:true,force:true});const file=path.join(counterexample,'can_monitor.c');let text=await fs.readFile(file,'utf8');const needle=/void receive_frame\([^\n]+\) \{\r?\n/;assert.match(text,needle);text=text.replace(needle,match=>match+'  monitor->last_valid_ms = now_ms;\n');await fs.writeFile(file,text);await initGit(counterexample);const tested=await runFixture(counterexample,1);const genericLine=(await fs.readFile(file,'utf8')).split(/\r?\n/).findIndex(line=>line.includes('void receive_frame'))+2;
  const offer=await registerProject(counterexample,'counterexample','kimi-public-counterexample-001');await fs.writeFile(path.join(scratch,'counterexample-setup.json'),JSON.stringify({generic_line:genericLine,tested},null,2));await fs.writeFile(path.join(scratch,'counterexample-offer.json'),JSON.stringify(offer,null,2));console.log(JSON.stringify({stage:'prepare-counterexample',genericLine,compileExit:tested.compile.exit_code,behaviorExit:tested.behavior.exit_code,scenario_id:offer.registered.scenario.scenario_id}));
}
async function counterexampleView(){
  const setup=JSON.parse(await fs.readFile(path.join(scratch,'counterexample-setup.json'))),offer=JSON.parse(await fs.readFile(path.join(scratch,'counterexample-offer.json')));await openSaved(counterexample);const data=await read(),project=data.projects.find(item=>item.root_path===counterexample),explanation=data.explanations.find(item=>item.result.binding.run_id===offer.binding.run_id);assert.ok(explanation);
  const evidence=explanation.result.evidence.find(item=>item.path==='can_monitor.c'&&item.line_start<=setup.generic_line&&item.line_end>=setup.generic_line);assert.ok(evidence,`ARC did not bind the early write at line ${setup.generic_line}`);
  const result=explanation.result,supported=result.claims.filter(item=>item.status==='source_supported'&&item.evidence_ids.includes(evidence.evidence_id)),early=supported.map(item=>item.statement).find(text=>/校验前|校验之前/.test(text)&&/无效/.test(text)&&/last_valid_ms/.test(text)&&/刷新|续期|写入/.test(text));
  const explanations=[result.summary.text,...result.claims.map(item=>item.statement),...(result.reading_guide?.steps??[]).flatMap(item=>[item.text,item.outcome,item.detail])],impact=explanations.find(text=>/800/.test(text)&&/无效|冲突/.test(text)&&/online\s*=?\s*1|保持在线|仍为在线|不会掉线/.test(text));
  const insufficient=result.gaps.find(item=>item.evidence_ids.includes(evidence.evidence_id)&&/证据不足|无法确认|尚未确认/.test(`${item.question}${item.impact}`));assert.ok(early&&impact||insufficient,'走读必须解释提前刷新对无效帧和在线状态的影响，或明确证据不足');
  const clicked=await openEvidence(explanation,item=>item.evidence_id===evidence.evidence_id);assert.match(clicked.text,/last_valid_ms\s*=\s*now_ms/);await page.screenshot({path:path.join(scratch,'counterexample-walkthrough.png')});
  await fs.writeFile(path.join(scratch,'counterexample.json'),JSON.stringify({project_id:project.project_id,scenario_id:explanation.scenario_id,result_id:explanation.result_id,generic_line:setup.generic_line,clicked_evidence:clicked.evidence,early_explanation:early,impact_explanation:impact,insufficient_evidence:insufficient,behavior:setup.tested.behavior,compile:setup.tested.compile,result},null,2));assert.equal(pageErrors.length,0,pageErrors.join('\n'));
  console.log(JSON.stringify({stage:'counterexample',realKimi:true,earlyWriteEvidence:true,regexEvidenceCheck:!!(early&&impact),semanticReviewRequired:true,sourceOpened:true,compileExit:setup.tested.compile.exit_code,behaviorExit:setup.tested.behavior.exit_code}));
}
try{if(stage==='prepare')await prepare();else if(stage==='initial')await initial();else if(stage==='develop')await develop();else if(stage==='progress')await progress();else if(stage==='verify')await verify();else if(stage==='prepare-counterexample')await prepareCounterexample();else if(stage==='counterexample-view')await counterexampleView();else throw Error(`Unknown stage ${stage}`);}catch(error){if(page)await page.screenshot({path:path.join(scratch,`${stage}-failure.png`)}).catch(()=>{});console.error(error);process.exitCode=1;}finally{await close();}
