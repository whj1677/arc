// Explicit real-provider acceptance; never part of npm test.
// Run: node --import tsx scripts/reading-journey-ui.mjs
// The starting graph is an explicitly marked source review of real ARC code.
// All questions and follow-ups below use the actual Codex execution channel.
// An isolated local store preserves progress if the provider or UI check fails.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ArcService} from '../src/main/service.ts';

const root=path.resolve('.'),scratch=path.resolve('../.test-data/reading-journey'),dataDir=path.join(scratch,'data');
await fs.mkdir(scratch,{recursive:true});
const terminal=new Set(['completed','failed','blocked_external','cancelled','unknown']);
async function waitRun(read,id,timeout=300000){
  const start=Date.now();let announced=0;
  while(Date.now()-start<timeout){
    const data=await read(),run=data.runs.find(r=>r.binding.run_id===id);
    if(run&&terminal.has(run.status)){assert.equal(run.status,'completed',run.error||run.status);return data;}
    if(Date.now()-announced>20000){console.log(`Waiting for real Codex: ${run?.status||'preparing'}, ${Math.round((Date.now()-start)/1000)}s`);announced=Date.now();}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('Real Codex acceptance exceeded 5 minutes; partial data retained.');
}

console.log('Preparing a real ARC main-process analysis in an isolated reading store.');
const service=new ArcService(dataDir,root);
let project,scenario,explanation;
try{
  project=await service.openProject(path.join(root,'src/main'));
  scenario=service.data().scenarios.find(s=>s.project_id===project.project_id&&s.title==='只读分析提交与保存');
  if(!scenario){
    const created=service.addFeature(project.project_id,'只读分析提交与保存','只走读 service.ts 中 startRun、execute、acceptResult：用户提交分析后，什么时候仅代表已排队，什么时候才真正保存解释？仅针对这三段逻辑生成3个主要步骤及准确源码依据，其他范围明确未分析。无需提供 architecture、function_walkthroughs 或 reading_guide；不要展开其他功能。');
    scenario=created.scenario;scenario.title='只读分析提交与保存';service.store.put('scenario',scenario.scenario_id,scenario);
  }
  explanation=service.data().explanations.filter(e=>e.scenario_id===scenario.scenario_id).at(-1);
  if(!explanation){
    const snapshot=service.store.get('snapshot',project.snapshot_id),file=snapshot.files.find(f=>f.path==='service.ts');
    const source=await service.source(project.snapshot_id,'service.ts'),lines=source.text.split(/\r\n|\n|\r/);
    const sections=[['submit','登记并启动分析','保存固定来源的运行记录，启动异步执行后返回运行对象。','async startRun(', 'private fail('],['execute','等待只读分析返回','准备只读模型任务，检查取消、退出码及返回格式，再交给结果校验。','private async execute(', 'async acceptResult('],['save','校验并保存解释','验证归属和源码依据，通过后在事务中保存解释或追问答案及完成状态。','async acceptResult(', 'async revalidate(']];
    const evidence=sections.map(([id,,note,start,end])=>{const first=lines.findIndex(s=>s.includes(start)),last=lines.findIndex((s,i)=>i>first&&s.includes(end));assert.ok(first>=0&&last>first);return {evidence_id:'source-'+id,source_snapshot_id:project.snapshot_id,path:'service.ts',line_start:first+1,line_end:last,content_sha256:file.content_sha256,role:'definition',note};});
    const nodes=sections.map(([id,label,description])=>({node_id:id,kind:'stage',label,description,execution_context:{kind:'unknown',identity:null,label:'主进程异步任务',status:'unknown',claim_ids:[],evidence_ids:[]},inputs:[],outputs:[],claim_ids:['claim-'+id],evidence_ids:['source-'+id]}));
    const edges=[{edge_id:'submit-execute',kind:'control_flow',source_node_id:'submit',target_node_id:'execute',label:'异步启动',status:'source_supported',flow_role:'main',claim_ids:['claim-submit'],evidence_ids:['source-submit']},{edge_id:'execute-save',kind:'control_flow',source_node_id:'execute',target_node_id:'save',label:'返回通过初检后校验',status:'source_supported',flow_role:'main',claim_ids:['claim-execute'],evidence_ids:['source-execute']}];
    const claims=sections.map(([id,,statement])=>({claim_id:'claim-'+id,statement,status:'source_supported',rationale:'核对绑定快照中函数实现',limitations:['这是现有阅读结果的来源审阅入口；不是完整工程图验收。'],evidence_ids:['source-'+id],targets:{node_ids:[id],edge_ids:edges.filter(e=>e.source_node_id===id).map(e=>e.edge_id),io_ids:[]}}));
    const graph={schema_version:'1.0',fictional:false,result_id:randomUUID(),binding:{project_id:project.project_id,feature_id:scenario.feature_id,scenario_id:scenario.scenario_id,question_revision_id:scenario.question_revision_id,source_snapshot_id:project.snapshot_id,run_id:randomUUID()},provider:{provider_id:'codex',connection_id:'local-codex',adapter_version:'0.1.0'},summary:{text:'源码审阅：提交返回运行记录，模型执行与解释入库随后异步完成。',claim_ids:claims.map(c=>c.claim_id)},coverage:{covered_scope:['service.ts 的 startRun、execute、acceptResult'],unresolved_scope:['完整工程架构、其他功能和业务运行']},nodes,edges,claims,evidence,gaps:[]};
    const input=path.join(scratch,'source-review.json');await fs.writeFile(input,JSON.stringify(graph));
    const run=await service.importResult(scenario.scenario_id,input);assert.equal(run.origin,'manual_import');
    explanation=service.data().explanations.find(e=>e.result.binding.run_id===run.binding.run_id);
    await service.probe();
  }
  assert.ok(explanation?.result.nodes.length>=2,'Real analysis must contain selectable steps.');
  const reading={entrance:'walk',view:'flow',scenario_id:scenario.scenario_id,result_id:explanation.result_id,selected:explanation.result.nodes[0].node_id,file:'',evidence_id:'',source_snapshot_id:explanation.result.binding.source_snapshot_id,mode:'normal',left_width:220,right_width:420,catalog_hidden:false,pinned:false,detail_tab:'details',expanded:[scenario.feature_id],scroll:{},zoom:1,stage:'',compare_id:'',linked:true,presentation_version:3,architecture_version:1,feature_reading_version:1};
  service.reading(`${project.project_id}/${scenario.scenario_id}/desktop`,reading);
  service.store.put('reading','last-session',{project_id:project.project_id,scenario_id:scenario.scenario_id,entrance:'walk'});
}finally{await service.shutdown();service.store.close();}

const env={...process.env,ARC_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[];
async function launch(){app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.locator('.workspace').waitFor();}
const read=()=>page.evaluate(()=>window.arc.invoke('data'));
async function assertDetailFits(){
  const widths=await page.evaluate(()=>['body','.detail','.detail > .panel-scroll'].map(selector=>{const element=document.querySelector(selector);return {selector,client:element.clientWidth,scroll:element.scrollWidth};}));
  for(const width of widths)assert.ok(width.scroll<=width.client+2,`${width.selector} must not overflow horizontally after opening source: ${width.scroll} > ${width.client}. Source pre may scroll independently.`);
}
async function send(question){
  const saved=(await read()).questions.filter(q=>q.question===question&&q.answer).at(-1);
  if(saved){console.log(`Resuming with saved real answer: ${saved.question_id}`);return saved;}
  await page.getByLabel('当前位置的问题',{exact:true}).fill(question);
  await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await page.waitForFunction(q=>document.querySelector('.question-thread')?.textContent?.includes(q)||document.querySelector('.question-error')?.textContent,question);
  assert.equal(await page.locator('.question-error').count(),0,await page.locator('.question-error').allTextContents().then(items=>items.join(';')));
  const data=await read(),item=data.questions.filter(q=>q.question===question).at(-1);assert.ok(item,'Question must persist immediately.');return item;
}
try{
  await launch();
  await page.locator('.graph-node').first().click();
  const clue='核对提交成功与解释入库的区别；已排队不能直接视作分析完成。';
  if(!(await read()).annotations.some(a=>a.scenario_id===scenario.scenario_id&&a.text===clue)){
    await page.locator('.user-clue-editor > summary').click();
    await page.getByLabel('补充线索',{exact:true}).fill(clue);
    await page.getByRole('button',{name:'保存线索',exact:true}).click();
  }
  await page.getByRole('button',{name:'就这里提问',exact:true}).click();
  const first=await send('这一步返回成功是否代表整个分析已经完成并保存？请直接说明，250字以内，给出2处源码依据。');
  assert.ok(first.context.annotations.some(a=>a.text===clue));
  await page.locator('.graph-node').nth(1).click();
  const switched=await page.locator('[aria-label="当前位置问答"]').getAttribute('data-target-id');
  const completed=await waitRun(read,first.run_id);const saved=completed.questions.find(q=>q.question_id===first.question_id);
  assert.ok(saved.answer?.evidence.length);assert.equal(saved.target.id,first.target.id);assert.notEqual(switched,first.target.id);
  await page.locator('.graph-node').first().click();
  await page.locator('.question-answer').first().waitFor();
  await page.locator('.question-evidence button').first().click();await page.locator('[aria-label="冻结源码依据"] pre').waitFor();
  await assertDetailFits();
  await page.screenshot({path:path.join(scratch,'answer.png')});
  const follow=await send('结合刚才的回答，校验不通过时会怎样？我之前补充的线索应如何理解？最多200字并给出源码依据。');
  assert.ok(follow.context.reply_to?.question_id===first.question_id||follow.context.recent_questions.some(q=>q.question_id===first.question_id&&q.answer));
  assert.ok(follow.context.annotations.some(a=>a.text===clue));
  await waitRun(read,follow.run_id);
  assert.equal(follow.source_snapshot_id,first.source_snapshot_id);
  await new Promise(resolve=>setTimeout(resolve,300));
  await app.close();await launch();
  await page.locator('.detail').getByRole('button',{name:'提问',exact:true}).click();
  await page.locator('.question-answer').first().waitFor();
  assert.equal(await page.locator('.question-answer').count(),2);
  assert.equal(await page.locator('[aria-label="当前位置问答"]').getAttribute('data-target-id'),first.target.id);
  const boxes=await page.evaluate(()=>{const canvas=document.querySelector('.canvas'),detail=document.querySelector('.detail');const c=canvas?.getBoundingClientRect(),d=detail?.getBoundingClientRect();return {canvas:c?.toJSON(),detail:d?.toJSON(),overflow:document.documentElement.scrollWidth>innerWidth+2};});
  assert.equal(boxes.overflow,false);assert.ok(boxes.canvas&&boxes.detail&&boxes.canvas.right<=boxes.detail.left+8,'Path and discussion must remain side by side.');
  await page.screenshot({path:path.join(scratch,'restored.png')});

  console.log('Checking project return and an unexplained directory through the actual UI.');
  const graphBefore=JSON.stringify((await read()).explanations.find(e=>e.result_id===explanation.result_id).result);
  const other=await page.evaluate(source=>window.arc.invoke('open_project_path',{path:source}),path.join(root,'examples/source-fixture'));
  await page.locator('.project-select option').filter({hasText:other.name}).last().waitFor({state:'attached'});
  await page.getByLabel('当前工程',{exact:true}).selectOption(other.project_id);
  await page.waitForFunction(async id=>(await window.arc.invoke('reading_get',{key:'last-session'}))?.project_id===id,other.project_id);
  await page.locator('.main-nav').getByRole('button',{name:'工程全貌',exact:true}).click();
  await page.locator('.catalog-views').getByRole('button',{name:'文件组织',exact:true}).click();
  await page.locator('[data-file-path="src"]').click();
  await page.getByRole('button',{name:'解释这个文件夹',exact:true}).click();
  assert.equal(await page.locator('[aria-label="当前位置问答"]').getAttribute('data-target-kind'),'directory');
  await page.getByLabel('提问执行方式',{exact:true}).selectOption('mcp');
  const directoryQuestion='src 目录在这个工程中负责什么？请结合冻结源码说明。';
  let directoryItem=(await read()).questions.find(q=>q.project_id===other.project_id&&q.question===directoryQuestion);
  if(!directoryItem){
    await page.getByLabel('当前位置的问题',{exact:true}).fill(directoryQuestion);
    await page.getByRole('button',{name:'保存问题，等待 Agent 领取',exact:true}).click();
    await page.waitForFunction(async question=>(await window.arc.invoke('data')).questions.some(q=>q.question===question),directoryQuestion);
    directoryItem=(await read()).questions.find(q=>q.project_id===other.project_id&&q.question===directoryQuestion);
  }
  const directoryCard=page.locator(`[data-question-id="${directoryItem.question_id}"]`);
  let directoryRun=(await read()).runs.find(r=>r.binding.run_id===directoryItem.run_id);
  if(directoryRun.status!=='waiting_agent'){
    await directoryCard.getByRole('button',{name:'重试这个问题',exact:true}).click();
    await page.waitForFunction(async id=>{const d=await window.arc.invoke('data'),q=d.questions.find(q=>q.question_id===id);return d.runs.find(r=>r.binding.run_id===q.run_id)?.status==='waiting_agent';},directoryItem.question_id);
    directoryItem=(await read()).questions.find(q=>q.question_id===directoryItem.question_id);
    directoryRun=(await read()).runs.find(r=>r.binding.run_id===directoryItem.run_id);
  }
  assert.equal(directoryRun.status,'waiting_agent');assert.equal(directoryRun.origin,'mcp');assert.equal(directoryRun.pid,undefined);
  await directoryCard.getByText('等待外部 Agent 领取',{exact:true}).waitFor();
  assert.ok((await directoryCard.innerText()).includes('尚未开始分析'));
  await directoryCard.getByRole('button',{name:'取消等待',exact:true}).click();
  await directoryCard.getByRole('button',{name:'重试这个问题',exact:true}).waitFor();
  const cancelledId=directoryItem.run_id;
  assert.equal((await read()).runs.find(r=>r.binding.run_id===cancelledId).status,'cancelled');
  await directoryCard.getByRole('button',{name:'重试这个问题',exact:true}).click();
  await page.waitForFunction(async ({id,previous})=>{const q=(await window.arc.invoke('data')).questions.find(q=>q.question_id===id);return q.run_id!==previous;},{id:directoryItem.question_id,previous:cancelledId});
  const retriedDirectory=(await read()).questions.find(q=>q.question_id===directoryItem.question_id);
  assert.equal(retriedDirectory.source_snapshot_id,directoryItem.source_snapshot_id);
  assert.deepEqual(retriedDirectory.target,{kind:'directory',id:'src'});
  assert.equal((await read()).runs.find(r=>r.binding.run_id===retriedDirectory.run_id).status,'waiting_agent');
  await page.screenshot({path:path.join(scratch,'directory-mcp.png')});
  await directoryCard.getByRole('button',{name:'取消等待',exact:true}).click();
  await directoryCard.getByRole('button',{name:'重试这个问题',exact:true}).waitFor();

  await page.getByLabel('当前工程',{exact:true}).selectOption(project.project_id);
  await page.waitForFunction(async id=>(await window.arc.invoke('reading_get',{key:'last-session'}))?.project_id===id,project.project_id);
  await page.locator('.question-answer').first().waitFor();
  assert.equal(await page.locator('[aria-label="当前位置问答"]').getAttribute('data-target-id'),first.target.id);
  assert.equal(await page.locator('.question-answer').count(),2);
  assert.equal(await page.locator('.scene-row[aria-current="page"]').getAttribute('aria-label'),scenario.title);

  console.log('Asking real Codex about an unexplained file with an explicitly refreshed source snapshot.');
  await page.locator('.main-nav').getByRole('button',{name:'工程全貌',exact:true}).click();
  await page.locator('.catalog-views').getByRole('button',{name:'文件组织',exact:true}).click();
  await page.locator('[data-file-path="store.ts"]').click();
  await page.locator('.file-summary').getByRole('heading',{name:'用途尚未分析',exact:true}).waitFor();
  await page.getByRole('button',{name:'解释这个文件',exact:true}).click();
  assert.equal(await page.locator('[aria-label="当前位置问答"]').getAttribute('data-target-id'),'store.ts');
  await page.getByLabel('提问执行方式',{exact:true}).selectOption('codex');
  await page.getByLabel('提问源码来源',{exact:true}).selectOption('latest');
  const fileQuestion=await send('store.ts 在 ARC 中负责什么？只按本次最新冻结源码回答，200字以内，并给出2处准确依据；说明它保存完成与业务分析完成的区别。');
  assert.equal(fileQuestion.target.kind,'file');assert.equal(fileQuestion.target.id,'store.ts');
  assert.equal(fileQuestion.result_id,null);assert.equal(fileQuestion.source_mode,'latest');
  assert.notEqual(fileQuestion.source_snapshot_id,explanation.result.binding.source_snapshot_id);
  const afterFile=await waitRun(read,fileQuestion.run_id),fileAnswer=afterFile.questions.find(q=>q.question_id===fileQuestion.question_id);
  assert.ok(fileAnswer.answer?.evidence.some(e=>e.path==='store.ts'));
  assert.ok(fileAnswer.answer.evidence.every(e=>e.source_snapshot_id===fileQuestion.source_snapshot_id));
  assert.equal(JSON.stringify(afterFile.explanations.find(e=>e.result_id===explanation.result_id).result),graphBefore,'A file answer must not rewrite the saved graph or its source binding.');
  await page.locator(`[data-question-id="${fileQuestion.question_id}"] .question-answer`).waitFor();
  await page.locator(`[data-question-id="${fileQuestion.question_id}"] .question-evidence button`).first().click();
  await page.locator('[aria-label="冻结源码依据"] pre').waitFor();
  await assertDetailFits();
  assert.ok((await page.locator('[aria-label="冻结源码依据"]').innerText()).includes(fileQuestion.source_snapshot_id));
  await page.screenshot({path:path.join(scratch,'latest-file.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,real_provider:'codex',starting_result:'source-reviewed import of real ARC implementation, not full graph generation acceptance',project:project.root_path,result_id:explanation.result_id,question_ids:[first.question_id,follow.question_id,fileQuestion.question_id],mcp_question_id:directoryItem.question_id,checks:['real node answer with source','saved annotation in input','follow-up context','switch during execution preserves original owner','restart restores answers and position','project switch restores original question position','side-by-side layout','clickable frozen source','unexplained file asks real Codex using explicit latest snapshot','file answer leaves previous graph unchanged','unexplained directory registers MCP waiting without claiming execution','MCP cancellation and retry preserve original directory and source'],screenshots:scratch},null,2));
}catch(error){if(page)await page.screenshot({path:path.join(scratch,'failure.png')}).catch(()=>{});throw error;}finally{await app?.close();}
