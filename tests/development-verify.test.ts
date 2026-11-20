import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {ProjectEnvironment} from '../src/main/env-probe';
import {runHostVerification,selectHostVerificationCommands} from '../src/main/development-verify';

function environment(commands:ProjectEnvironment['effective_commands'],tools:ProjectEnvironment['tools'] = []):ProjectEnvironment {
  return {project_id:'p',probed_at:'',candidate_commands:{},effective_commands:commands,tools};
}

test('host verification orders checks and targets approved JS or Python tests',() => {
  const scope = ['src/cart.ts','tests/cart.test.ts','src/cart.spec.ts','test/with spaces.ts'];
  for (const base of ['npm run test','npm test','pnpm run test','yarn test']) {
    const env = environment({build:'npm run build',test:base,typecheck:'npm run typecheck'});
    assert.deepEqual(selectHostVerificationCommands(env,scope).commands,[
      {kind:'typecheck',command:'npm run typecheck'},
      {kind:'test',command:`${base} -- tests/cart.test.ts src/cart.spec.ts 'test/with spaces.ts'`},
      {kind:'build',command:'npm run build'},
    ]);
  }
  for (const base of ['pytest','python -m pytest','python3 -m pytest']) {
    assert.equal(selectHostVerificationCommands(environment({test:base}),['test_cart.py','cart_test.py']).commands[0].command,
      base+' test_cart.py cart_test.py');
  }
  for (const [base,files] of [
    ['npm test',['src/cart.ts']],['npm test',["tests/a'b.test.ts"]],['go test ./...',['tests/example.go']],
    ['pytest -q',['tests/check.py']],
  ] as const) {
    assert.equal(selectHostVerificationCommands(environment({test:base}),files).commands[0].command,base);
  }
});

test('missing CMake gracefully skips local C++ verification and preserves independent commands',async () => {
  const env = environment({build:'cmake -S . -B build',test:'ctest --test-dir build'},[{id:'cmake',label:'CMake',status:'missing'}]);
  const result = await runHostVerification({workspace:'.',env,writeScope:[],isStopped:()=>false});
  assert.deepEqual(result.commands,[]);
  assert.deepEqual(result.failed,[]);
  assert.equal(result.skipped.length,2);
  assert.ok(result.skipped.every(note => /CMake.*独立 Diff/.test(note)));
  assert.deepEqual(selectHostVerificationCommands({...env,effective_commands:{...env.effective_commands,typecheck:'go vet ./...'}},[]).commands,
    [{kind:'typecheck',command:'go vet ./...'}]);
});

async function fixture(t:TestContext,script:string) {
  await fs.mkdir('.test-data',{recursive:true});
  const workspace = await fs.mkdtemp(path.resolve('.test-data','host-验证 '));
  t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  await fs.writeFile(path.join(workspace,'check.cjs'),script);
  return workspace;
}

test('host captures both streams, exit code and bounded output before reporting the command',async t => {
  const workspace = await fixture(t,"process.stdout.write('x'.repeat(30000)); process.stdout.write('stdout-tail'); process.stderr.write('stderr-tail');");
  const received:string[] = [];
  const result = await runHostVerification({
    workspace,env:environment({build:'node check.cjs'}),writeScope:[],isStopped:()=>false,
    onCommand:async command => {
      received.push(command.id);
      assert.equal(command.cwd,workspace);
      assert.equal(command.exit_code,0);
      assert.match(command.output,/stdout-tail/);
      assert.match(command.output,/stderr-tail/);
      assert.equal(command.output.length,24000);
    },
  });
  assert.equal(result.commands.length,1);
  assert.deepEqual(received,[result.commands[0].id]);
  assert.deepEqual(result.failed,[]);
});

test('host stops on a nonzero exit, a reported test failure, or zero executed tests',async t => {
  const workspace = await fixture(t,`switch(process.argv[2]){
    case 'exit': console.error('compiler error'); process.exit(17);
    case 'failure': console.log('# tests 2\\n# pass 1\\n# fail 1'); break;
    case 'empty': console.log('# tests 0'); break;
  }`);
  for (const [mode,code,reason] of [['exit',17,'验证失败'],['failure',0,'验证失败'],['empty',0,'空跑或跳过']] as const) {
    const command = 'node check.cjs '+mode;
    const result = await runHostVerification({workspace,env:environment({test:command,build:'node missing.cjs'}),writeScope:[],isStopped:()=>false});
    assert.equal(result.commands.length,1);
    assert.equal(result.failed.length,1);
    assert.deepEqual(result.failed[0],{command,exit_code:code,output:result.commands[0].output,reason});
  }
});

test('stopping host verification terminates the running command before later checks',async t => {
  const workspace = await fixture(t,"require('node:fs').writeFileSync('running',''); setInterval(()=>{},1000)");
  const result = await runHostVerification({workspace,env:environment({test:'node check.cjs',build:'node missing.cjs'}),
    writeScope:[],isStopped:()=>existsSync(path.join(workspace,'running'))});
  assert.equal(result.commands.length,1);
  assert.equal(result.commands[0].exit_code,null);
  assert.match(result.failed[0].reason,/取消/);
});

test('the per-command deadline stops a hung process and keeps a timeout receipt',async t => {
  const workspace = await fixture(t,'setInterval(()=>{},1000)');
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback:()=>void,delay:number,...args:unknown[]) =>
    schedule(callback,delay===180000?300:delay,...args));
  const result = await runHostVerification({workspace,env:environment({test:'node check.cjs'}),writeScope:[],isStopped:()=>false});
  assert.equal(result.commands[0].exit_code,null);
  assert.match(result.commands[0].output,/180 秒/);
  assert.match(result.failed[0].reason,/180 秒/);
});

test('Windows cancellation reclaims a pipe inherited by a process whose shell has already exited',{skip:process.platform!=='win32'},async t=>{
  const workspace=await fixture(t,`
    const fs=require('node:fs');
    setTimeout(()=>fs.writeFileSync('orphan-pid',String(process.pid)),700);
    setTimeout(()=>fs.writeFileSync('expired',''),20000);
  `);
  const command="Start-Process -NoNewWindow -FilePath node -ArgumentList 'check.cjs'";
  const result=await runHostVerification({workspace,env:environment({test:command}),writeScope:[],
    isStopped:()=>existsSync(path.join(workspace,'orphan-pid'))});
  assert.equal(result.commands[0].exit_code,null);
  assert.match(result.failed[0].reason,/取消/);
  assert.equal(existsSync(path.join(workspace,'expired')),false);
  const pid=Number(await fs.readFile(path.join(workspace,'orphan-pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('stock Windows PowerShell short-circuits the configured CMake build pair',{skip:process.platform!=='win32'},async t => {
  const workspace = await fixture(t,'');
  await fs.writeFile(path.join(workspace,'cmake.cmd'),[
    '@echo off','if "%1"=="--build" echo build-ok','if exist broken exit /b 9','exit /b 0',
  ].join('\r\n'));
  const prior = process.env.PATH!;
  process.env.PATH = [workspace,path.join(process.env.SystemRoot!,'System32')].join(path.delimiter);
  t.after(()=>{ process.env.PATH=prior; });
  const command = 'cmake -S . -B build && cmake --build build';
  const run = () => runHostVerification({workspace,env:environment({build:command}),writeScope:[],isStopped:()=>false});
  const success = await run();
  assert.deepEqual(success.failed,[]);
  assert.match(success.commands[0].output,/build-ok/);
  await fs.writeFile(path.join(workspace,'broken'),'');
  const failure = await run();
  assert.equal(failure.failed[0].exit_code,9);
  assert.doesNotMatch(failure.commands[0].output,/build-ok/);
});
