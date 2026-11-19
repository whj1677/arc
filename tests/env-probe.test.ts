import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ProjectEnvironmentService,formatEnvironmentBrief} from '../src/main/env-probe';
import {Store} from '../src/main/store';

async function fixture(t:TestContext){
  const base=path.resolve('.test-data');await fs.mkdir(base,{recursive:true});
  const temp=await fs.mkdtemp(path.join(base,'env-probe-')),root=path.join(temp,'示例 工程'),bin=path.join(temp,'host tools');
  await Promise.all([fs.mkdir(root),fs.mkdir(bin)]);
  const store=new Store(path.join(temp,'data')),service=new ProjectEnvironmentService(store);
  const saved=process.env.PATH;
  process.env.PATH=[root,bin].join(path.delimiter);
  t.after(async()=>{process.env.PATH=saved;store.close();await fs.rm(temp,{recursive:true,force:true});});
  const write=(name:string,contents:string)=>fs.writeFile(path.join(root,name),contents);
  const executable=(dir:string,name:string,output:string,code=0)=>process.platform==='win32'?
    fs.writeFile(path.join(dir,name+'.cmd'),`@echo off\r\necho ${output}\r\nexit /b ${code}\r\n`):
    fs.writeFile(path.join(dir,name),`#!/bin/sh\necho "${output}"\nexit ${code}\n`,{mode:0o755});
  return {root,bin,store,service,write,executable};
}

test('probes host versions, distinguishes missing and failed tools, and only declares project wrappers',async t=>{
  const {root,bin,service,write,executable}=await fixture(t);
  await Promise.all([
    write('package.json',JSON.stringify({packageManager:'pnpm@9',scripts:{test:'some test',build:'some build',typecheck:'some check'}})),
    write('pom.xml','<project/>'),write('mvnw','exit 1'),write('mvnw.cmd','exit /b 1'),
    executable(bin,'node','v24.1.0'),executable(bin,'pnpm','error 1.2',1),executable(root,'java','99.0'),
  ]);
  const env=await service.get('p',root);
  assert.deepEqual(env.tools.map(tool=>tool.id),['git','node','pnpm','java','mvnw']);
  const tool=(id:string)=>env.tools.find(item=>item.id===id)!;
  assert.equal(tool('node').status,'available');assert.equal(tool('node').version,'24.1.0');
  assert.equal(tool('pnpm').status,'unverifiable');assert.equal(tool('java').status,'missing');
  assert.equal(tool('mvnw').status,'declared');
  assert.deepEqual(env.candidate_commands,{build:'pnpm run build',test:'pnpm run test',typecheck:'pnpm run typecheck'});
  const brief=formatEnvironmentBrief(env);assert.equal(brief.split('\n').length,5);
  for(const bit of ['Node.js 24.1.0','Java（本机未发现）','Maven Wrapper（项目声明）','pnpm（未核实）','测试：pnpm run test'])assert.ok(brief.includes(bit),bit);
});

test('cached detection survives reopen, refresh picks up manifest changes and preserves validated overrides',async t=>{
  const {root,store,service,write}=await fixture(t);
  await write('requirements.txt','pytest>=8\n');
  const first=await service.get('p',root);
  assert.match(first.candidate_commands.test!,/python3? -m pytest/);
  await service.save('p',root,{test:' python -m pytest -q ',build:''});
  await write('Cargo.toml','');
  const reopened=new ProjectEnvironmentService(store);
  const cached=await reopened.get('p',root);
  assert.equal(cached.probed_at,first.probed_at);assert.ok(!cached.tools.some(tool=>tool.id==='cargo'));
  const updated=await reopened.get('p',root,true);
  assert.ok(updated.tools.some(tool=>tool.id==='cargo'));assert.equal(updated.candidate_commands.build,'cargo build');
  assert.deepEqual(updated.effective_commands,{build:'',test:'python -m pytest -q',typecheck:'cargo check'});
  for(const invalid of [{test:'a\nb'},{other:'x'},{test:42}])await assert.rejects(reopened.save('p',root,invalid),/有效命令/);
  assert.equal((await reopened.get('p',root)).effective_commands.test,'python -m pytest -q');
});

test('detects relevant toolchains and derives wrapper, CMake, Go, and Python commands',async t=>{
  const {root,service,write}=await fixture(t);
  const cases=[
    ['pom.xml','mvnw','mvnw.cmd','mvnw','package','test'],
    ['build.gradle','gradlew','gradlew.bat','gradlew','build','test'],
    ['build.gradle.kts','gradlew','gradlew.bat','gradlew','build','test'],
  ] as const;
  for(const [manifest,script,winScript,id,build,testCmd] of cases){
    await Promise.all([write(manifest,''),write(script,''),write(winScript,'')]);
    const env=await service.get('p',root,true),command=process.platform==='win32'?'.\\'+winScript:'./'+script;
    assert.ok(env.tools.some(tool=>tool.id===id&&tool.status==='declared'));
    assert.deepEqual(env.candidate_commands,{build:command+' '+build,test:command+' '+testCmd});
    await fs.unlink(path.join(root,manifest));
  }
  await write('go.mod','module example');let env=await service.get('p',root,true);
  assert.deepEqual(env.candidate_commands,{build:'go build ./...',test:'go test ./...'});
  await write('CMakeLists.txt','');await write('pyproject.toml','[tool.pytest.ini_options]');
  env=await service.get('p',root,true);
  assert.match(env.candidate_commands.build!,/^cmake/);assert.match(env.candidate_commands.test!,/pytest/);
  assert.ok(env.tools.some(tool=>tool.label==='CMake'));assert.ok(env.tools.some(tool=>tool.label==='Python'));
});
