import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { _electron, type Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildRefinementContext, parseGoalRefinement } from '../src/main/prompt-refiner';
import { ArcService } from '../src/main/service';
import { Store } from '../src/main/store';

test('refinement uses the project’s latest cached overview and active project material within 4 KiB', async t => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'refinement-db-'));
  const store = new Store(directory);
  t.after(async () => { store.close(); await fs.rm(directory, { recursive: true }); });
  const missing = path.join(directory, 'unbound-project');
  store.put('project', 'p', { project_id: 'p', name: '库存工程', root_path: missing, overview_scenario_id: 'overview' });
  assert.equal(buildRefinementContext(store, 'p', []), '工程：库存工程');

  const nodes = Array.from({ length: 16 }, (_, i) => ({
    node_id: String(i), label: '功能' + i, description: '核对库存' + '明细'.repeat(100),
  }));
  function overview(id: string, project: string, scene: string, created: string, summary: string) {
    store.put('explanation', id, { scenario_id: scene, created_at: created, result: {
      binding: { project_id: project }, summary: { text: summary }, nodes,
      feature_catalog: { groups: [{ node_ids: nodes.map(node => node.node_id) }] },
    } });
  }
  overview('latest', 'p', 'overview', '2026-11-18', '最新库存说明' + '概述'.repeat(500));
  overview('old', 'p', 'overview', '2026-11-17', 'OUTDATED');
  overview('unrelated', 'p', 'feature', '2026-11-19', 'OTHER_FEATURE');
  overview('foreign', 'q', 'overview', '2026-11-20', 'OTHER_PROJECT');
  function entry(id: string, category: string, text: string, extra: object = {}) {
    store.put('engineering_context', id, { entry_id: id, project_id: 'p', category, text, origin: 'user',
      status: 'current', updated_at: '2026-11-18', ...extra });
  }
  for (const category of ['purpose', 'technology', 'build', 'rule', 'interface']) {
    entry(category, category, '生效' + category + '用'.repeat(2000), category === 'rule' ? { supersedes: 'previous' } : {});
  }
  entry('previous', 'rule', 'REPLACED');
  entry('stale', 'rule', 'SUPERSEDED', { status: 'superseded' });
  entry('aggregate', 'rule', 'OBSOLETE_AGGREGATE', { covered_entries: ['previous'] });
  entry('other', 'rule', 'OTHER_PROJECT', { project_id: 'q' });
  entry('task', 'rule', 'OTHER_TASK', { task_id: 'another-task' });
  entry('issue', 'issue', 'EXCLUDED_CATEGORY');
  const boundaries = Array.from({ length: 40 }, (_, i) => i + '保留' + '现有接口'.repeat(80));
  const context = buildRefinementContext(store, 'p', boundaries);
  assert.ok(Buffer.byteLength(context) <= 4096);
  assert.match(context, /库存工程/);
  assert.match(context, /最新库存说明/);
  assert.match(context, /功能0: 核对库存/);
  assert.match(context, /功能14: 核对库存/);
  assert.match(context, /39保留/);
  for (const category of ['purpose', 'technology', 'build', 'rule', 'interface']) assert.ok(context.includes('生效' + category));
  assert.doesNotMatch(context, /功能15:|OUTDATED|REPLACED|SUPERSEDED|OBSOLETE_AGGREGATE|OTHER_|EXCLUDED_CATEGORY|�/);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
});

test('both transports validate the same reply and deduplicate normalized boundaries', () => {
  const response = {
    refined_goal: ' 统计库存余量。\n显示逐项合计。 ',
    suggested_non_goals: [' 保留 `sku`。', '沿用单位', '沿用单位；'],
    clarifications: [' 零库存是否单列？ '],
  };
  const raw = JSON.stringify(response);
  const expected = { refined_goal: response.refined_goal.trim(), suggested_non_goals: ['沿用单位'], clarifications: ['零库存是否单列？'] };
  assert.deepEqual(parseGoalRefinement(raw, ['保留   sku'], 'codex'), expected);
  assert.deepEqual(parseGoalRefinement('```json\n' + raw + '\n```', ['保留   sku'], 'dsh'), expected);
});

test('an unbound project can use its configured DSH channel in one tool-free turn', async t => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'refinement-dsh-'));
  const cli = path.join(directory, 'dsh-fixture.cjs');
  await fs.writeFile(cli, 'if (process.argv[2] === "--version") console.log("0.2.1-rc.5"); else process.exit(1);');
  const priorKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'offline-test';
  const turns: string[] = [];
  const service = new ArcService(directory, '', undefined, undefined, async options => {
    assert.equal(options.toolFree, true);
    assert.equal(options.profile.path, cli);
    assert.match(options.prompt, /库存工程/);
    assert.match(options.prompt, /核对金额/);
    assert.match(options.prompt, /保留单位/);
    assert.ok(options.timeoutMs! > 0 && options.timeoutMs! <= 60000);
    turns.push(path.dirname(options.run.output_path));
    return { code: 0, stderr: '', raw: '```json\n{"refined_goal":"核对库存金额。","suggested_non_goals":["保留单位。"],"clarifications":[]}\n```' };
  });
  t.after(async () => {
    if (priorKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = priorKey;
    service.store.close();
    await fs.rm(directory, { recursive: true });
  });
  service.store.put('project', 'p', { project_id: 'p', name: '库存工程', root_path: path.join(directory, 'missing') });
  service.store.put('settings', 'providers', { dsh_path: cli });
  const result = await service.refineDevelopmentGoal('p', '核对金额', ['保留单位'], 'dsh');
  assert.equal(result.engine, 'dsh');
  assert.equal(result.refined_goal, '核对库存金额。');
  assert.deepEqual(result.suggested_non_goals, []);
  assert.ok(result.duration_ms >= 0);
  assert.equal(turns.length, 1);
  await assert.rejects(fs.stat(turns[0]), { code: 'ENOENT' });
  assert.deepEqual(service.store.all('engineering_task'), []);
});

test('rejects malformed or out-of-contract replies with a readable error', () => {
  const valid = { refined_goal: '核对库存', suggested_non_goals: [], clarifications: [] };
  assert.throws(() => parseGoalRefinement('分析完成', [], 'codex'), /不是有效的 JSON/);
  for (const invalid of [{}, { ...valid, unexpected: true }, { ...valid, refined_goal: '   ' },
    { ...valid, refined_goal: '字'.repeat(1501) }, { ...valid, suggested_non_goals: ['A', 'B', 'C', 'D'] },
    { ...valid, suggested_non_goals: ['字'.repeat(121)] }, { ...valid, clarifications: ['A', 'B', 'C'] },
    { ...valid, clarifications: ['字'.repeat(161)] }]) {
    assert.throws(() => parseGoalRefinement(JSON.stringify(invalid), [], 'dsh'), /字段或长度/);
  }
});

const goal = '订单里有多件商品时总价算错了，想把它修好。';
const suggestion = {
  refined_goal: '修复订单合计金额忽略商品数量的问题。\n每行金额按单价乘以数量计算；验证同一商品购买两件时，合计为单价的两倍。',
  suggested_non_goals: ['保留现有折扣规则', '保留收据展示格式'],
  clarifications: ['数量为零时，订单行是否仍需显示在收据中？'],
  engine: 'codex',
  duration_ms: 2400,
};

async function checkIdleLayout(page:Page, width:number, height:number) {
  await page.setViewportSize({width,height});
  const layout = await page.locator('.requirement-composer').evaluate(form => {
    const row = form.querySelector('.composer-starters')!.getBoundingClientRect();
    const button = form.querySelector('.composer-refine-button')!.getBoundingClientRect();
    const lastStarter = form.querySelector('.composer-starters > button:last-of-type')!.getBoundingClientRect();
    const overflow:string[] = [];
    for (let el:Element|null = form; el; el = el.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) {
        overflow.push(el.className);
      }
    }
    return {
      stripHeight:form.querySelector('.composer-exec-strip')!.getBoundingClientRect().height,
      overflow, pageOverflow:document.documentElement.scrollHeight - innerHeight,
      bottom:form.getBoundingClientRect().bottom, rightGap:row.right-button.right,
      rowOffset:button.top-lastStarter.top,
    };
  });
  assert.deepEqual(layout.overflow, [], JSON.stringify(layout));
  assert.equal(layout.stripHeight,56, JSON.stringify({width,height,...layout}));
  assert.ok(layout.pageOverflow <= 1 && layout.bottom <= height, JSON.stringify(layout));
  assert.ok(Math.abs(layout.rightGap) <= 1 && Math.abs(layout.rowOffset) <= 2, JSON.stringify(layout));
}

test('RequirementComposer settings and prompt refinement', async t => {
  if (!['dist/main.cjs','dist/preload.cjs','dist/ui/index.html'].every(file=>existsSync(file))) {
    execFileSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});
  }
  const evidence = process.env.ARC_TEST_REFINEMENT_VISUALS === '1' ? path.resolve('.test-data/prompt-refiner-ui') : null;
  const base = evidence ?? path.resolve('.test-data');
  await fs.mkdir(base,{recursive:true});
  const run = await fs.mkdtemp(path.join(base,'composer-'));
  const userData = path.join(run,'user-data');
  const workspace = path.join(run,'订单示例');
  const env:Record<string,string> = {ARC_DATA_DIR:userData};
  for (const [key,value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ARC_DATA_DIR') env[key] = value;
  }
  env.CODEX_HOME = path.join(run,'codex-home');
  await fs.mkdir(env.CODEX_HOME);
  await fs.writeFile(path.join(env.CODEX_HOME,'config.toml'),'model = "fixture-sol"');
  await fs.writeFile(path.join(env.CODEX_HOME,'models_cache.json'),JSON.stringify({models:[
    {slug:'fixture-sol',display_name:'Fixture Sol'}, {slug:'fixture-astra',display_name:'Fixture Astra'},
  ]}));
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    args:[`--user-data-dir=${userData}`, path.resolve('tests/fixtures/prompt-refiner-main.cjs')],
    env,
  });
  try {
    assert.equal(await app.evaluate(({app})=>app.getPath('userData')),userData);
    await fs.cp('examples/development-fixture',workspace,{recursive:true});
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.getByRole('button',{name:'打开工程',exact:true}).click();
    await page.getByLabel('本地工程绝对路径').fill(workspace);
    await page.getByRole('button',{name:'仅打开',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'需求与开发'}).click();
    const form = page.locator('.requirement-composer');
    const input = form.getByRole('textbox',{name:'开发任务'});
    const refine = form.getByRole('button',{name:'优化提示词',exact:true});
    const card = form.getByRole('region',{name:'优化建议'});
    await form.locator('.composer-command').first().waitFor();
    await t.test('settings and execution strip select and save the same Codex preferences',async()=>{
      const quick=form.getByRole('combobox',{name:'本次 Codex 模型'});
      assert.equal(await quick.locator('option:checked').textContent(),'默认（fixture-sol）');
      await quick.selectOption('fixture-astra');
      await form.getByRole('button',{name:'连接设置'}).click();
      const dialog=page.getByRole('dialog',{name:'连接 Agent'});
      const model=dialog.getByRole('combobox',{name:'Codex 模型',exact:true});
      const effort=dialog.getByRole('combobox',{name:'Codex 推理强度'});
      assert.equal(await model.locator('option:checked').textContent(),'Fixture Astra');
      await effort.selectOption('high');
      await model.selectOption({label:'自定义模型…'});
      await dialog.getByRole('textbox',{name:'自定义模型名称'}).fill('custom-local');
      await dialog.getByRole('button',{name:'应用',exact:true}).click();
      await dialog.getByRole('textbox',{name:'自定义模型名称'}).waitFor({state:'hidden'});
      await dialog.getByRole('button',{name:'关闭对话框'}).click();
      assert.equal(await quick.inputValue(),'custom-local');
      assert.deepEqual(await page.evaluate(async()=>(await window.arc.invoke('data')).codex_preferences),
        {model:'custom-local',reasoning_effort:'high'});
      await quick.selectOption('');
      await page.waitForFunction(async()=>(await window.arc.invoke('data')).codex_preferences.model==='');
      assert.deepEqual(await page.evaluate(async()=>(await window.arc.invoke('data')).codex_preferences),
        {model:'',reasoning_effort:'high'});
    });
    assert.ok(await refine.isDisabled());
    await input.fill(goal);
    await checkIdleLayout(page,1024,768);
    await checkIdleLayout(page,1440,900);
    if (evidence) await page.screenshot({path:path.join(evidence,'composer-with-refine-btn-1440.png'),scale:'css'});

    await refine.click();
    assert.ok(await form.getByRole('button',{name:'优化中…'}).isDisabled());
    await app.evaluate(({app},value)=>app.emit('test-refinement',{ok:true,value}),suggestion);
    await card.waitFor();
    assert.equal(await card.locator('.refinement-text').textContent(),suggestion.refined_goal);
    assert.equal(await input.inputValue(),goal);
    assert.ok(await card.getByText(suggestion.clarifications[0],{exact:true}).isVisible());
    if (evidence) await page.screenshot({path:path.join(evidence,'composer-refinement-card-1440.png'),scale:'css'});
    const boundary = suggestion.suggested_non_goals[0];
    const scope = form.locator('.composer-scope-options').getByRole('button',{name:boundary,exact:true});
    const chip = card.getByRole('button',{name:new RegExp(boundary)});
    await chip.click();
    assert.equal(await chip.getAttribute('aria-pressed'),'true');
    assert.equal(await scope.count(),1);
    await chip.click();
    assert.equal(await scope.count(),0);
    await chip.click();
    await card.getByRole('button',{name:'采用到输入框'}).click();
    assert.equal(await input.inputValue(),suggestion.refined_goal);
    assert.equal(await scope.getAttribute('aria-pressed'),'true');
    await form.getByRole('button',{name:'恢复原文'}).click();
    assert.equal(await input.inputValue(),goal);
    assert.equal(await form.getByRole('button',{name:'恢复原文'}).count(),0);

    await refine.click();
    await app.evaluate(({app})=>app.emit('test-refinement',{ok:false,error:'本次提示词优化超时。'}));
    await form.getByRole('alert').filter({hasText:'本次提示词优化超时。'}).waitFor();
    assert.equal(await input.inputValue(),goal);

    await refine.click();
    await form.getByRole('button',{name:'优化中…'}).waitFor();
    await input.fill('');
    await app.evaluate(({app},value)=>app.emit('test-refinement',{ok:true,value}),suggestion);
    await page.evaluate(async()=>{
      await window.arc.invoke('data');
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    });
    assert.equal(await card.count(),0);
    assert.equal(await input.inputValue(),'');
    assert.ok(await refine.isDisabled());
  } finally {
    await app.close();
    if (!evidence) await fs.rm(run,{recursive:true,force:true,maxRetries:3});
  }
});
