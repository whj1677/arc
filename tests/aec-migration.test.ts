import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { scanAecLegacy, applyAecRuleMigration, installArcAgentRules, planAecRuleMigration, ARC_ENGINEERING_RULES } from '../src/main/aec-migration';
import { ARC_CHECKER_SOURCE } from '../src/main/aec-checker-source';
import oldScript from './fixtures/aec/legacy-upgrade-rules';
import { ArcService } from '../src/main/service';
import { ArcMcpBridge } from '../src/main/mcp-bridge';
const exec = promisify(execFile);

const oldBlock = '<!-- ai-engineering-context:start version=old -->\r\nAlways create REQ\r\n<!-- ai-engineering-context:end version=old -->';
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-aec 中文 '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('imports retain source revisions; migration preserves user bytes and historical documents', async t => {
  const root = await fixture(t);
  const original = '\ufeff# User\r\nApproval required.\r\n' + oldBlock + '\r\nUser tail.\r\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), original);
  await fs.mkdir(path.join(root, 'docs/requirements/REQ-0100'), { recursive: true });
  const history = path.join(root, 'docs/requirements/REQ-0100/current_state.md');
  await fs.writeFile(history, 'historical claim, not current verification');
  const scan = await scanAecLegacy(root);
  assert.deepEqual(await scanAecLegacy(root), scan);
  assert.equal(scan.documents.find(doc => doc.path.endsWith('current_state.md'))?.status, 'needs_review');
  assert.deepEqual(await applyAecRuleMigration(root, scan.rules), ['AGENTS.md']);
  const migrated = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(migrated.startsWith('\ufeff# User\r\nApproval required.\r\n'));
  assert.ok(migrated.endsWith('\r\nUser tail.\r\n'));
  assert.ok(migrated.includes('arc_begin_development'));
  assert.ok(!migrated.includes('Always create REQ'));
  assert.equal(await fs.readFile(history, 'utf8'), 'historical claim, not current verification');
  assert.deepEqual(await applyAecRuleMigration(root, (await scanAecLegacy(root)).rules), []);
  const before = scan.documents.find(doc => doc.path === 'AGENTS.md')!;
  const after = (await scanAecLegacy(root)).documents.find(doc => doc.path === 'AGENTS.md')!;
  assert.equal(before.importKey, after.importKey);
  assert.notEqual(before.revisionKey, after.revisionKey);
  assert.equal((await installArcAgentRules(root)).changed, false);
});
test('all rules preflight before changes; stale and malformed plans fail without writes', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'AGENTS.md'), oldBlock);
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '<!-- ai-engineering-context:start -->');
  const scan = await scanAecLegacy(root);
  assert.equal(scan.rules.find(rule => rule.path === 'CLAUDE.md')?.state, 'conflict');
  await assert.rejects(applyAecRuleMigration(root, scan.rules), /冲突/);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), oldBlock);
  await fs.writeFile(path.join(root, 'CLAUDE.md'), oldBlock);
  const current = await scanAecLegacy(root);
  await fs.appendFile(path.join(root, 'CLAUDE.md'), 'new user instruction');
  await assert.rejects(applyAecRuleMigration(root, current.rules), /已变化/);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), oldBlock);
});
test('explicit agent installation is idempotent and preserves custom rules', async t => {
  const root = await fixture(t);
  const user = '# Team\r\nKeep user rules.\r\n';
  await fs.writeFile(path.join(root, 'agents.md'), user);
  assert.equal((await scanAecLegacy(root)).rules[0].state, 'current');
  assert.equal(await fs.readFile(path.join(root, 'agents.md'), 'utf8'), user);
  assert.deepEqual(await installArcAgentRules(root), { path: 'agents.md', changed: true });
  const content = await fs.readFile(path.join(root, 'agents.md'), 'utf8');
  assert.ok(content.startsWith(user));
  assert.equal((await installArcAgentRules(root)).changed, false);
  assert.equal(await fs.readFile(path.join(root, 'agents.md'), 'utf8'), content);
  assert.equal((await fs.readdir(root)).length, 1);
});
test('recognized arc-1 rule text upgrades on reconnect while user-edited managed text is preserved', async t => {
  const root = await fixture(t), previous = ARC_ENGINEERING_RULES.split('\n').filter(line => !line.includes('修改前用 arc_update_development')).join('\n');
  const old = '# Team rules\n<!-- arc-engineering:start version=arc-1 -->\n' + previous + '\n<!-- arc-engineering:end version=arc-1 -->\nKeep custom tail.\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), old);
  const connectionFile = path.join(root, 'mcp', 'connection.json'), upgraded = await installArcAgentRules(root, { connectionFile });
  assert.equal(upgraded.changed, true);
  const content = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(content.startsWith('# Team rules\n')); assert.ok(content.endsWith('Keep custom tail.\n'));
  assert.match(content, /arc_save_development_steps|修改前用 arc_update_development/); assert.ok(content.includes('arc-connection-file'));
  assert.equal((await installArcAgentRules(root, { connectionFile })).changed, false);
  const customized = content.replace('修改前用 arc_update_development', '用户改写：修改前用 arc_update_development');
  await fs.writeFile(path.join(root, 'AGENTS.md'), customized);
  await assert.rejects(installArcAgentRules(root, { connectionFile }), /改写|识别/);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), customized);
});
test('tampered replacement cannot change user content outside a managed block', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'user policy\n' + oldBlock);
  const plan = planAecRuleMigration('AGENTS.md', 'user policy\n' + oldBlock);
  plan.replacementContent = plan.replacementContent.replace('user policy', 'injected policy');
  await assert.rejects(applyAecRuleMigration(root, [plan]), /非管理内容/);
});
test('official legacy migration entry becomes ARC adapter, custom checker is not overwritten', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), oldBlock);
  await fs.writeFile(path.join(root, 'scripts/upgrade_project_rules.py'), oldScript);
  let scan = await scanAecLegacy(root);
  assert.equal(scan.rules.find(rule => rule.path === 'scripts/upgrade_project_rules.py')?.state, 'migrate');
  assert.ok(scan.documents.some(doc => doc.path === 'scripts/upgrade_project_rules.py' && doc.content === oldScript));
  await applyAecRuleMigration(root, scan.rules);
  const run = await exec('python', ['-B', 'scripts/upgrade_project_rules.py', '--target', root, '--mode', 'apply'], { cwd: root, windowsHide: true });
  assert.match(run.stdout, /ARC_RULES_CURRENT/);
  assert.equal((await fs.readdir(root)).includes('docs'), false);
  await fs.writeFile(path.join(root, 'scripts/check_ai_context.py'), '# user custom checker');
  scan = await scanAecLegacy(root);
  assert.equal(scan.rules.find(rule => rule.path === 'scripts/check_ai_context.py')?.state, 'conflict');
  await assert.rejects(applyAecRuleMigration(root, scan.rules), /冲突/);
  assert.equal(await fs.readFile(path.join(root, 'scripts/check_ai_context.py'), 'utf8'), '# user custom checker');
});
test('bundled checker automatically reads bound ARC task, rejects stale code and supports rebinding', async t => {
  const temp = await fixture(t), root = path.join(temp, '工程');
  await fs.mkdir(root);
  const connectionFile = path.join(temp, 'connection.json');
  await installArcAgentRules(root, { connectionFile });
  await fs.writeFile(path.join(root, 'check_ai_context.py'), ARC_CHECKER_SOURCE);
  await fs.writeFile(path.join(root, 'main.py'), 'value = 1\n');
  const git = (...args: string[]) => exec('git', ['-C', root, ...args], { windowsHide: true });
  await git('init'); await git('add', '.');
  await git('-c', 'user.name=ARC test', '-c', 'user.email=arc@example.invalid', 'commit', '-m', 'fixture');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  await fs.writeFile(path.join(root, 'main.py'), 'value = 2\n');
  const state = { head, fingerprint: 'frozen-test-state',workspace_fingerprint:'test-workspace-bytes' };
  const task = { task_id: 'task-test', goal: 'Update value', summary: 'Updated', workspace_path: root, saved: 'saved', status: 'completed', updated_at: '2026-01-01T00:00:00Z', baseline: state, end_state: state,
    changes: [{path:'main.py', before_sha256:createHash('sha256').update('value = 1\n').digest('hex'), after_sha256:createHash('sha256').update('value = 2\n').digest('hex')}],
    verification: [{command:'inspection', cwd:root, outcome:'passed', exit_code:0, origin:'self_reported', code_state:state}] };
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer fixture-token') { response.writeHead(403); response.end(); return; }
    const chunks: Buffer[]=[]; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body.name);
    const value = body.name === 'arc_engineering_context' ? {workspace:{root_path:root},code_state:state,recent_tasks:[{task_id:task.task_id,updated_at:task.updated_at}]} : task;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({value}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as any).port;
  await fs.writeFile(connectionFile, JSON.stringify({url:`http://127.0.0.1:${port}/tool`, token:'fixture-token'}));
  const run = () => exec('python', ['-B','check_ai_context.py','--root',root], {cwd:root, windowsHide:true,timeout:20000});
  assert.match((await run()).stdout, /ARC_RECORD_OK/);
  assert.deepEqual(requests, ['arc_engineering_context','arc_development_task']);
  await fs.writeFile(path.join(root, 'main.py'), 'value = 3\n');
  await assert.rejects(run(), (error:any) => /Changed content is stale/.test(error.stdout));
  const rebound = path.join(temp, 'restored-connection.json');
  await installArcAgentRules(root, {connectionFile:rebound});
  const rules = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(rules.includes(JSON.stringify(rebound)));
  assert.equal(rules.split('arc-connection-file:').length, 2);
});
test('bundled checker verifies a real ARC bridge task and fails clearly after disconnect', async t => {
  const temp = await fixture(t), root = path.join(temp, '真实工作区');
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), oldBlock);
  await fs.writeFile(path.join(root, 'scripts/upgrade_project_rules.py'), oldScript);
  await fs.writeFile(path.join(root, 'scripts/check_ai_context.py'), ARC_CHECKER_SOURCE);
  await fs.writeFile(path.join(root, 'main.py'), 'value = 1\n');
  await fs.writeFile(path.join(root, 'user.txt'), 'preexisting user change\n');
  const git = (...args:string[]) => exec('git', ['-C', root, ...args], {windowsHide:true});
  await git('init'); await git('add', '.');
  await git('-c','user.name=ARC test','-c','user.email=arc@example.invalid','commit','-m','fixture');
  const service = new ArcService(path.join(temp, 'data'), path.resolve('.'));
  const bridge = new ArcMcpBridge(service, path.resolve('.'));
  let bridgeClosed = false;
  try {
    const project = await service.openProject(root);
    await bridge.start(); await bridge.enable(project.project_id);
    await applyAecRuleMigration(root, (await scanAecLegacy(root)).rules);
    await installArcAgentRules(root, {connectionFile:bridge.connectionFile});
    assert.deepEqual(await applyAecRuleMigration(root, (await scanAecLegacy(root)).rules), []);
    assert.equal((await installArcAgentRules(root, {connectionFile:bridge.connectionFile})).changed, false);
    await fs.appendFile(path.join(root, 'user.txt'), 'not owned by the task\n');
    const task = await bridge.call('arc_begin_development', {workspace_path:root,goal:'Change value to two',submission_key:'actual-bridge-task'});
    await fs.writeFile(path.join(root, 'main.py'), 'value = 2\n');
    const command = 'python -B -c "import runpy; assert runpy.run_path(\'main.py\')[\'value\'] == 2"';
    await exec('python', ['-B','-c',"import runpy; assert runpy.run_path('main.py')['value'] == 2"], {cwd:root,windowsHide:true});
    const context = await bridge.call('arc_engineering_context', {workspace_path:root});
    const logPath = `logs/${task.task_id}/python.log`;
    const logFile = path.join(service.directory,logPath);
    await fs.mkdir(path.dirname(logFile),{recursive:true});
    await fs.writeFile(logFile,command+'\nexit 0\n');
    // Bind the real local command output through ARC's observed-evidence path.
    const saved = await service.engineering.finishTask({task_id:task.task_id,expected_version:task.version,submission_key:'actual-bridge-finish',status:'completed',summary:'Updated main.py; Python assertion passed',verification:[{
      evidence_id:'actual-python-assertion',command,cwd:root,outcome:'passed',exit_code:0,origin:'observed',log_path:logPath,code_state:context.code_state,created_at:new Date().toISOString()
    }]});
    assert.equal(saved.status, 'completed');
    const run = (...args:string[]) => exec('python', ['-B','scripts/check_ai_context.py','--root',root,...args], {cwd:root,windowsHide:true,timeout:20000});
    assert.match((await run()).stdout, /ARC_RECORD_OK.*self_reported=0/);
    assert.match((await run('--task',task.task_id)).stdout, /ARC_RECORD_OK.*self_reported=0/);
    await fs.rename(logFile,logFile+'.missing');
    await assert.rejects(run('--task',task.task_id),(error:any)=>error.code===2&&/execution log is missing/.test(error.stdout));
    await fs.rename(logFile+'.missing',logFile);
    await bridge.close(); bridgeClosed = true;
    await assert.rejects(run(), (error:any) => error.code === 2 && /ARC_RECORD_FAILED/.test(error.stdout) && !/ARC_RECORD_OK/.test(error.stdout));
    const adapter = await exec('python', ['-B','scripts/upgrade_project_rules.py','--target',root,'--mode','ensure'], {cwd:root,windowsHide:true});
    assert.match(adapter.stdout, /ARC_RULES_CURRENT/);
    assert.equal((await fs.readdir(root)).includes('docs'), false);
    assert.equal(await fs.readFile(path.join(root, 'user.txt'),'utf8'), 'preexisting user change\nnot owned by the task\n');
  } finally {
    if (!bridgeClosed) await bridge.close();
    await service.shutdown(); service.store.close();
  }
});
