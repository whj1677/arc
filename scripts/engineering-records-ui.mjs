// Real Electron/SQLite/MCP/migration/export workflow. No model or fake Agent results.
// Run after build. Uses the real acceptance fixture, or creates it without analysis.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('.'),scratch=path.resolve('../.test-data/engineering-integration');
const workspace=path.join(scratch,'workspace'),dataDirectory=path.join(scratch,'data');
await fs.mkdir(scratch,{recursive:true});
if(!await fs.access(workspace).then(()=>true,()=>false))await fs.cp(path.join(root,'examples/development-fixture'),workspace,{recursive:true});
const env={...process.env,CODEX_HOME:path.join(scratch,'isolated-codex')};delete env.ELECTRON_RUN_AS_NODE;await fs.mkdir(env.CODEX_HOME,{recursive:true});
let app,page;const errors=[];
async function launch(directory){app=await electron.launch({args:[root],env:{...env,ARC_DATA_DIR:directory},timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.locator('header').first().waitFor();}
const navigation=()=>page.getByRole('complementary',{name:'ARC 工程工作台导航'});
async function invoke(name,args){return page.evaluate(([name,args])=>window.arc.invoke(name,args),[name,args]);}
async function menu(){const summary=page.getByText('接入与恢复',{exact:true});if(!await summary.evaluate(e=>e.parentElement.open))await summary.click();}
async function closedMenu(){const summary=page.getByText('接入与恢复',{exact:true});if(await summary.evaluate(e=>e.parentElement.open))await summary.click();}
async function tool(directory,name,args){const connection=JSON.parse(await fs.readFile(path.join(directory,'mcp/connection.json'),'utf8'));const response=await fetch(connection.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`},body:JSON.stringify({name,args,client:{name:'ARC UI acceptance',version:'1'}})});const result=await response.json();assert.equal(response.status,200,result.error);if(result.error)throw Error(result.error);return result.value;}
try{
  await launch(dataDirectory);
  let data=await invoke('data');let project=data.projects.find(p=>p.root_path===workspace);
  if(!project){await navigation().getByRole('button',{name:'打开工程',exact:true}).click();await page.getByLabel('本地工程绝对路径',{exact:true}).fill(workspace);await page.getByRole('button',{name:'仅打开',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});data=await invoke('data');project=data.projects.find(p=>p.root_path===workspace);}
  await navigation().getByLabel('当前工程',{exact:true}).selectOption(project.project_id);
  await navigation().getByRole('button',{name:'工程与开发',exact:true}).click();
  await page.locator('.engineering-workspace').waitFor();
  await page.getByRole('navigation',{name:'工程栏目'}).getByRole('button',{name:/^任务/}).click();
  const tasksBefore=await invoke('engineering_tasks',{project_id:project.project_id});
  if(tasksBefore.length){await page.locator('.engineering-task-row').first().click();await page.getByRole('button',{name:'版本历史',exact:true}).click();await page.getByLabel('工程任务版本',{exact:true}).waitFor();assert.ok(await page.getByLabel('工程任务版本',{exact:true}).locator('option').count()>1);const diagnostic=page.getByRole('button',{name:'查看执行诊断',exact:true});if(await diagnostic.count()){await diagnostic.last().click();await page.locator('.engineering-log pre').waitFor();assert.ok((await page.locator('.engineering-log pre').textContent()).length);await page.getByRole('button',{name:'关闭日志',exact:true}).click();}}
  await page.getByRole('button',{name:'工程上下文',exact:true}).click();
  await page.getByRole('button',{name:'来源与补充',exact:true}).first().click();
  await page.locator('.question-source pre').first().waitFor();
  const correction='用户补充：订单数量可以为零，折扣模块与订单汇总分别维护；这条线索仍须结合源码核实。';
  await page.getByLabel('上下文补充',{exact:true}).fill(correction);await page.getByRole('button',{name:'保存用户补充',exact:true}).click();await page.getByLabel('上下文补充',{exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'收起工程上下文',exact:true}).click();
  const agents=path.join(workspace,'AGENTS.md');const original=await fs.readFile(agents,'utf8');
  if(!original.includes('engineering-context:')&&!original.includes('arc-engineering:'))await fs.appendFile(agents,'\n<!-- ai-engineering-context:start version=old -->\nAlways create REQ\n<!-- ai-engineering-context:end version=old -->\n');
  const legacy=path.join(workspace,'docs/requirements/REQ-legacy/current_state.md');await fs.mkdir(path.dirname(legacy),{recursive:true});await fs.writeFile(legacy,'Historical order import. Verification was claimed in an old document; it needs review.\n');
  await menu();await page.getByRole('button',{name:'连接 Agent / 迁移旧规则',exact:true}).click();
  await page.getByText('Agent 接入已保存；请在该工作区开启新会话',{exact:true}).waitFor();
  const migrated=await fs.readFile(agents,'utf8');assert.ok(migrated.startsWith(original.split('\n<!-- ai-engineering-context:')[0].split('\n<!-- arc-engineering:')[0]));assert.ok(migrated.includes('arc_begin_development'));assert.ok(!migrated.includes('Always create REQ'));
  assert.equal(await fs.readFile(legacy,'utf8'),'Historical order import. Verification was claimed in an old document; it needs review.\n');
  const tasks=await invoke('engineering_tasks',{project_id:project.project_id});const imported=tasks.find(t=>t.origin==='legacy_import');assert.ok(imported);assert.equal(imported.verification_status,'not_run');
  await page.getByRole('button',{name:'连接 Agent / 迁移旧规则',exact:true}).click();
  await page.getByRole('button',{name:'连接 Agent / 迁移旧规则',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('.engineering-management button')?.disabled);
  assert.equal(await fs.readFile(agents,'utf8'),migrated);assert.equal((await invoke('engineering_tasks',{project_id:project.project_id})).filter(t=>t.origin==='legacy_import').length,1);
  const uiContext=await invoke('engineering_context',{project_id:project.project_id});
  const agentContext=await tool(dataDirectory,'arc_engineering_context',{workspace_path:workspace});
  assert.equal(uiContext.version,agentContext.version);assert.equal(uiContext.code_state.fingerprint,agentContext.code_state.fingerprint);assert.ok(agentContext.entries.some(e=>e.origin==='user'&&e.text===correction));
  await page.getByRole('button',{name:'检查 / 重试待同步记录',exact:true}).click();await page.getByText('待同步记录已检查',{exact:true}).waitFor();
  const bundle=path.join(scratch,'engineering-records.json');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},bundle);
  await page.getByRole('button',{name:'导出工程记录',exact:true}).click();await page.getByText('已导出工程记录和引用证据',{exact:true}).waitFor();
  await closedMenu();await page.waitForFunction(()=>!document.querySelector('.development-form button')?.disabled||document.querySelector('.development-form button')?.textContent!=='保存中…');await page.screenshot({path:path.join(scratch,'records-desktop.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,850));
  await page.waitForFunction(()=>innerWidth<=1024);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(scratch,'records-1024.png')});
  await app.close();app=null;
  const restoredData=await fs.mkdtemp(path.join(scratch,'restore-check-'));
  await launch(restoredData);assert.equal((await invoke('data')).projects.length,0);
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},bundle);
  await page.getByRole('button',{name:'恢复工程记录',exact:true}).click();
  await page.locator('.engineering-workspace').waitFor();
  assert.equal((await invoke('engineering_context',{project_id:project.project_id})).workspace.status,'unbound');
  await menu();await page.getByLabel('重新绑定工程目录',{exact:true}).fill(workspace);await page.getByRole('button',{name:'绑定工作区',exact:true}).click();
  await page.getByText('工作区已绑定，历史来源保持不变',{exact:true}).waitFor();
  await page.getByRole('button',{name:'连接 Agent / 迁移旧规则',exact:true}).click();await page.getByText('Agent 接入已保存；请在该工作区开启新会话',{exact:true}).waitFor();
  const restoredContext=await tool(restoredData,'arc_engineering_context',{workspace_path:workspace});assert.ok(restoredContext.entries.some(e=>e.origin==='user'&&e.text===correction));
  for(const old of tasksBefore){const restored=await tool(restoredData,'arc_development_task',{task_id:old.task_id});assert.equal(restored.task_id,old.task_id);assert.equal(restored.goal,old.goal);assert.equal(restored.status,old.status);}
  await closedMenu();await page.locator('.engineering-task-row').filter({hasText:imported.goal}).click();await page.getByText('AEC 历史任务 · 待复核。原文与来源已保存，旧验证声明不视为本次真实执行。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'工程上下文',exact:true}).click();await page.getByRole('button',{name:'来源与补充',exact:true}).first().click();await page.locator('.question-source pre').first().waitFor();
  await page.screenshot({path:path.join(scratch,'restored-records.png')});
  const restoredReading=await invoke('data');assert.equal(restoredReading.explanations.filter(e=>e.result.binding.project_id===project.project_id).length,data.explanations.filter(e=>e.result.binding.project_id===project.project_id).length);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({recordsUiPassed:true,realAgentDevelopmentPassed:false,projectId:project.project_id,restoredData,checks:['actual Electron source and user correction','actual MCP same context/version','managed AEC migration and idempotency','history task remains unverified','native dialog adapter export to real bundle','empty database restore and explicit rebind','restored MCP reads task and frozen source','desktop and 1024 layout no horizontal overflow']},null,2));
}catch(error){await page?.screenshot({path:path.join(scratch,'records-failure.png')}).catch(()=>{});throw error;}
finally{await app?.close();}
