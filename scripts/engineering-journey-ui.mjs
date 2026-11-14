// Real Codex acceptance. Run after build; uses current official account usage.
// Fixture source is public and reproducible; received model results are never simulated.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve('.'),scratch=path.resolve(process.env.ARC_ACCEPTANCE_DIR||'../.test-data/engineering-integration');
const workspace=path.join(scratch,'workspace'),dataDirectory=path.join(scratch,'data');
await fs.mkdir(scratch,{recursive:true});
if(!await fs.access(workspace).then(()=>true,()=>false)){
  await fs.cp(path.join(root,'examples/development-fixture'),workspace,{recursive:true});
  await fs.writeFile(path.join(workspace,'notes.txt'),'Keep this user note.\n');
  const git=async(...args)=>exec('git',['-C',workspace,...args],{windowsHide:true});
  await git('init','-b','main');await git('config','user.name','ARC Acceptance');await git('config','user.email','arc-acceptance@example.invalid');
  await git('add','.');await git('commit','-m','Initial reproducible order example');
  await fs.appendFile(path.join(workspace,'notes.txt'),'Uncommitted user note; preserve it.\n');
}
const env={...process.env,ARC_DATA_DIR:dataDirectory};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[];
const read=()=>page.evaluate(()=>window.arc.invoke('data'));
async function launch(){app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.locator('header').first().waitFor();}
const navigation=()=>page.getByRole('complementary',{name:'ARC 工程工作台导航'});
const navigate=name=>navigation().getByRole('button',{name,exact:true}).click();
const selectProject=id=>navigation().getByLabel('当前工程',{exact:true}).selectOption(id);
const selectTasks=()=>page.getByRole('navigation',{name:'工程栏目'}).getByRole('button',{name:/^任务/}).click();
async function open(directory,analyze){await navigate('打开工程');const dialog=page.getByRole('dialog');await dialog.getByLabel('本地工程绝对路径',{exact:true}).fill(directory);const started=Date.now();await dialog.getByRole('button',{name:analyze?'打开并分析':'仅打开',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});return started;}
async function waitFor(get,done,timeout=600000){const start=Date.now();let next=0;for(;;){const value=await get();if(done(value))return value;if(Date.now()-start>timeout)throw Error(`Timed out after ${timeout/1000}s`);if(Date.now()>next){console.log(`Real acceptance waiting ${Math.round((Date.now()-start)/1000)}s: ${value?.status||'starting'}`);next=Date.now()+20000;}await new Promise(resolve=>setTimeout(resolve,1000));}}
try{
  await launch();const before=await read(),fresh=!before.projects.some(project=>project.root_path===workspace);
  if(process.env.ARC_ACCEPTANCE_CODEX){
    await navigate('工程与数据');
    const dialog=page.getByRole('dialog');
    await dialog.getByLabel('Codex 程序路径',{exact:true}).fill(process.env.ARC_ACCEPTANCE_CODEX);
    await dialog.getByRole('button',{name:'检测 Codex 执行通道',exact:true}).click();
    await dialog.getByText('Logged in using ChatGPT',{exact:false}).waitFor();
    await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();
  }
  const opened=await open(workspace,true);
  await navigate('工程全貌');const overview=page.locator('.engineering-overview');if(!await overview.evaluate(e=>e.open))await overview.locator('summary').click();await page.locator('.engineering-facts').waitFor();
  const firstContextSeconds=(Date.now()-opened)/1000;
  let data=await read();const project=data.projects.find(item=>item.root_path===workspace);assert.ok(project);
  const context=await page.evaluate(id=>window.arc.invoke('engineering_context',{project_id:id}),project.project_id);
  assert.ok(context.entries.some(entry=>entry.category==='purpose'&&entry.sources.length));assert.ok(context.entries.some(entry=>entry.category==='build'&&entry.sources.length));
  assert.ok(context.entries.some(entry=>entry.conflict&&entry.status==='needs_review'),'The missing documented verify command must remain a visible conflict.');
  await page.screenshot({path:path.join(scratch,'first-context.png')});
  const analysis=await waitFor(async()=>(await read()).runs.filter(run=>run.binding.project_id===project.project_id).at(-1),run=>run&&['completed','failed','cancelled','unknown','blocked_external'].includes(run.status),310000);
  assert.equal(analysis.status,'completed',analysis.error);await page.locator('.architecture-node').first().waitFor();
  if(fresh)assert.equal(await fs.access(path.join(workspace,'docs','requirements')).then(()=>true,()=>false),false);
  console.log(JSON.stringify({firstContextSeconds,fresh,analysisRun:analysis.binding.run_id,firstAnalysisSeconds:(Date.parse(analysis.ended_at)-Date.parse(analysis.created_at))/1000,contextVersion:context.version}));
  await overview.locator('summary').evaluate(summary=>{summary.parentElement.open=true;});
  await page.getByRole('button',{name:'描述开发任务',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='development-goal');
  const goal='修复订单 total 忽略 quantity 的问题：每项金额应为 price × quantity，quantity 为 0 时该项贡献 0。保留 notes.txt 的已有修改和其他功能，修改前运行 npm test 复现失败，修改后再次运行 npm test 验证。';
  let tasks=await page.evaluate(id=>window.arc.invoke('engineering_tasks',{project_id:id}),project.project_id);
  let task=tasks.find(item=>item.goal===goal);
  const newDevelopment=!task;
  if(task?.status!=='completed'){
    const attemptsBefore=task?.attempt_ids.length??0;
    if(task){await page.locator('.engineering-task-row').filter({hasText:goal}).click();await page.getByRole('button',{name:'继续此任务',exact:true}).click();}
    await page.getByLabel('开发任务',{exact:true}).fill(goal);await page.getByRole('button',{name:task?'继续开发':'开始开发',exact:true}).click();
    task=await waitFor(async()=>(await page.evaluate(id=>window.arc.invoke('engineering_tasks',{project_id:id}),project.project_id)).find(item=>item.goal===goal),value=>!!value&&value.attempt_ids.length>attemptsBefore,20000);
    console.log(`Started real development ${task.task_id}`);await page.screenshot({path:path.join(scratch,'development-progress.png')});
    const other=path.join(scratch,'other');await fs.mkdir(other,{recursive:true});await fs.writeFile(path.join(other,'README.md'),'A separate project used only to verify task ownership.\n');
    await open(other,false);
    task=await waitFor(()=>page.evaluate(id=>window.arc.invoke('engineering_task',{task_id:id}),task.task_id),value=>['completed','failed','blocked','cancelled','interrupted'].includes(value.status));
  }
  if(process.argv.includes('--expect-environment-blocked')){
    assert.equal(task.status,'blocked',JSON.stringify({summary:task.summary,unresolved:task.unresolved}));assert.match(task.summary,/尚未调用模型/);assert.equal(task.verification_status,'not_run');
    const {attempts}=await page.evaluate(id=>window.arc.invoke('development_events',{task_id:id}),task.task_id);const latest=attempts.at(-1);assert.ok(latest.log_path);const diagnostic=JSON.parse(await fs.readFile(path.join(dataDirectory,latest.log_path),'utf8'));assert.equal(diagnostic.model_called,false);assert.equal(diagnostic.stage,'sandbox_check');
    await selectProject(project.project_id);await navigate('工程与开发');await selectTasks();await page.locator('.engineering-task-row').filter({hasText:goal}).click();const activity=page.locator('.engineering-task-detail details').filter({has:page.locator('summary').filter({hasText:'执行与活动'})});if(!await activity.evaluate(e=>e.open))await activity.locator('summary').click();await page.getByRole('button',{name:'查看执行诊断',exact:true}).last().click();await page.locator('.engineering-log pre').waitFor();await page.screenshot({path:path.join(scratch,'sandbox-blocked.png')});
    console.log(JSON.stringify({sandboxFailureUiPassed:true,realDevelopmentPassed:false,taskId:task.task_id,modelCalled:false,verificationStatus:task.verification_status,attempts:attempts.length},null,2));
  }else{
  assert.equal(task.status,'completed',JSON.stringify({summary:task.summary,unresolved:task.unresolved}));
  assert.equal(task.workspace_path,workspace);assert.equal(task.project_id,project.project_id);
  assert.ok(task.changes.some(change=>change.path==='src/cart.mjs'));
  assert.ok(!task.changes.some(change=>change.path==='notes.txt'));
  assert.match(await fs.readFile(path.join(workspace,'notes.txt'),'utf8'),/Uncommitted user note/);
  const observedTests=task.verification.filter(evidence=>evidence.origin==='observed'&&/npm(?:\.cmd)? test/.test(evidence.command));
  assert.deepEqual(observedTests.map(evidence=>evidence.exit_code),[1,0]);
  const verifiedTest=observedTests.at(-1);
  assert.equal(verifiedTest.code_state_verified,true);
  assert.equal(verifiedTest.code_state.workspace_fingerprint,task.end_state.workspace_fingerprint);
  for(const evidence of observedTests){
    const log=await fs.readFile(path.join(dataDirectory,evidence.log_path),'utf8');
    assert.match(log,evidence.exit_code===0?/# fail 0/:/# fail [1-9]/);
  }
  assert.ok(['passed','partial'].includes(task.verification_status),task.verification_status);
  if(fresh)assert.equal(await fs.access(path.join(workspace,'docs','requirements')).then(()=>true,()=>false),false);
  const verified=await exec(process.execPath,['--test','tests/order.test.mjs'],{cwd:workspace,windowsHide:true});assert.match(verified.stdout,/# fail 0/);
  await selectProject(project.project_id);await navigate('工程与开发');await selectTasks();await page.locator('.engineering-task-row').filter({hasText:goal}).click();
  await page.getByRole('button',{name:'查看修改前后',exact:true}).first().click();await page.locator('.engineering-diff pre').first().waitFor();
  await page.screenshot({path:path.join(scratch,'development-result.png')});
  await page.locator('footer').getByText('阅读位置已保存',{exact:false}).waitFor();await app.close();await launch();
  await page.locator('.engineering-task-detail').waitFor();assert.ok((await page.evaluate(id=>window.arc.invoke('engineering_tasks',{project_id:id}),project.project_id)).some(item=>item.task_id===task.task_id&&item.status==='completed'));
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({arcEntryPassed:true,fresh,newDevelopment,projectId:project.project_id,workspace,taskId:task.task_id,verificationStatus:task.verification_status,firstContextSeconds,developmentSeconds:(Date.parse(task.updated_at)-Date.parse(task.created_at))/1000,processDocuments:0,checks:['source-backed first context and existing architecture view','real workspace edit and observed validation before and after','automatic task completion','project switch preserves ownership','unrelated user change preserved','frozen before/after opens','restart restores development record']},null,2));
  }
}catch(error){if(page)await page.screenshot({path:path.join(scratch,'failure.png')}).catch(()=>{});throw error;}
finally{await app?.close();}
