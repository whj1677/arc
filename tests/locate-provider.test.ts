import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { locate } from '../src/main/providers';
import { locateVerificationShell } from '../src/main/development-runner';
import { isSupportedDshVersion,resolveDsh } from '../src/main/dsh';
import { workspaceGitDirectory } from '../src/main/snapshot';

async function isolatedInstall(t:TestContext) {
  await fs.mkdir('.test-data',{recursive:true});
  const root=await fs.mkdtemp(path.resolve('.test-data','locate-'));
  for(const key of ['PATH','ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA','APPDATA','PNPM_HOME','VOLTA_HOME','NVM_SYMLINK','USERPROFILE','SystemRoot']) {
    const original=process.env[key];
    process.env[key]=path.join(root,key);
    t.after(()=>{if(original===undefined)delete process.env[key];else process.env[key]=original;});
  }
  t.after(()=>fs.rm(root,{recursive:true}));
  return root;
}

test('an installation without Git distinguishes a Git workspace from a non-Git folder',async t=>{
  await isolatedInstall(t);
  // The plain directory must be outside ARC's own Git worktree.
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'arc-git-path-'));
  t.after(()=>fs.rm(directory,{recursive:true}));
  const repo=path.join(directory,'repo'),plain=path.join(directory,'plain');
  await fs.mkdir(path.join(repo,'.git'),{recursive:true});await fs.mkdir(plain);
  if(process.platform!=='win32')t.mock.method(fs,'access',async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});});
  await assert.rejects(workspaceGitDirectory(repo),/找不到 Git/);
  assert.equal(await workspaceGitDirectory(plain),null);
});

test('POSIX finds an executable on PATH without which and skips non-executable files',{skip:process.platform==='win32'},async t=>{
  const root=await isolatedInstall(t);
  const dirs=[path.join(root,'first'),path.join(root,'second')];
  for(const dir of dirs)await fs.mkdir(dir);
  await fs.writeFile(path.join(dirs[0],'git'),'');
  const git=path.join(dirs[1],'git');
  await fs.writeFile(git,'#!/bin/sh\n',{mode:0o755});
  process.env.PATH=dirs.join(path.delimiter);
  assert.equal(await locate('git'),git);
});

test('Windows locates standard Git, Node and DSH installations without a terminal PATH',{skip:process.platform!=='win32'},async t=>{
  const root=await isolatedInstall(t);
  const candidates={
    git:['ProgramFiles/Git/cmd','ProgramFiles(x86)/Git/cmd','LOCALAPPDATA/Programs/Git/cmd','USERPROFILE/scoop/shims'],
    node:['ProgramFiles/nodejs','ProgramFiles(x86)/nodejs','LOCALAPPDATA/Programs/nodejs','NVM_SYMLINK','VOLTA_HOME/bin','USERPROFILE/scoop/shims'],
    dsh:['APPDATA/npm','PNPM_HOME','LOCALAPPDATA/pnpm','VOLTA_HOME/bin','USERPROFILE/scoop/shims'],
    codex:['APPDATA/npm','PNPM_HOME','LOCALAPPDATA/pnpm','VOLTA_HOME/bin','USERPROFILE/scoop/shims','LOCALAPPDATA/Programs/codex','USERPROFILE/.local/bin'],
  };
  for(const [name,dirs] of Object.entries(candidates)){
    for(const dir of dirs){
      const file=path.join(root,dir,name+'.exe');
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,'');
      assert.equal(name==='dsh'?(await resolveDsh()).path:await locate(name),file);
      await fs.unlink(file);
    }
  }
});

test('verification prefers PowerShell 7 and falls back to Windows PowerShell',{skip:process.platform!=='win32'},async t=>{
  const system32=path.join(process.env.SystemRoot!,'System32');
  const root=await isolatedInstall(t);
  const modern=path.join(root,'bin','pwsh.exe'),stock=path.join(root,'SystemRoot','System32','WindowsPowerShell','v1.0','powershell.exe');
  for(const file of [modern,stock]){
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'');
  }
  process.env.PATH=[path.dirname(modern),system32].join(path.delimiter);
  assert.equal(await locateVerificationShell(),modern);
  await fs.unlink(modern);
  assert.equal(await locateVerificationShell(),stock);
});

test('DSH accepts semantic versions at or above the Web minimum',()=>{
  for(const version of ['0.2.1-rc.2','0.2.1-rc.5','0.2.1-rc.10','0.2.1','0.2.2','0.3.0','1.0.0','0.3.0-alpha.1+build'])
    assert.equal(isSupportedDshVersion(version),true,version);
  for(const version of ['0.2.0','0.2.1-rc.1','0.2.1-beta.99','0.2','not a version','0.2.1-rc.02',''])
    assert.equal(isSupportedDshVersion(version),false,version);
});

test('locate reports a clean Chinese error without Windows where.exe mojibake when binary is missing', async () => {
  await assert.rejects(
    () => locate('arc-definitely-missing-binary-999999'),
    (error: Error) => {
      assert.match(error.message, /未找到「arc-definitely-missing-binary-999999」程序/);
      assert.ok(!error.message.includes('\uFFFD'), 'Error message must not contain UTF-8 replacement mojibake');
      assert.ok(!/where\.exe/i.test(error.message), 'Error message must not leak raw where.exe stderr');
      return true;
    },
  );
});

test('locate reports a clean Chinese error when an explicit absolute path does not exist', async () => {
  const missing = path.resolve('definitely-missing-codex-executable.exe');
  await assert.rejects(
    () => locate('codex', missing),
    (error: Error) => {
      assert.match(error.message, /指定的程序路径不存在或无法访问/);
      assert.ok(error.message.includes(missing));
      return true;
    },
  );
});

test('Windows resolves npm Codex wrappers and heals stale WindowsApps paths', {skip:process.platform!=='win32'}, async t => {
  await fs.mkdir('.test-data',{recursive:true});
  const root=await fs.mkdtemp(path.resolve('.test-data','locate-codex-'));
  const envKeys=['APPDATA','SystemRoot',Object.keys(process.env).find(key=>key.toLowerCase()==='path')??'Path'];
  const originalEnv=envKeys.map(key=>process.env[key]);
  t.after(async()=>{
    envKeys.forEach((key,index)=>{
      const value=originalEnv[index];
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    });
    await fs.rm(root,{recursive:true});
  });
  const npm=path.join(root,'npm');
  process.env.APPDATA=root;
  process.env.SystemRoot=root;
  process.env[envKeys[2]]=npm;
  const arch=process.arch==='arm64'?'arm64':'x64';
  const vendor=path.join('@openai',`codex-win32-${arch}`,'vendor',`${arch==='arm64'?'aarch64':'x86_64'}-pc-windows-msvc`);
  const modules=path.join(npm,'node_modules');
  const native=path.join(modules,'@openai','codex','node_modules',vendor,'bin','codex.exe');
  const legacy=path.join(modules,vendor,'codex','codex.exe');
  await fs.mkdir(path.dirname(native),{recursive:true});
  await fs.writeFile(native,'');
  for(const wrapper of ['codex','codex.cmd']) {
    const configured=path.join(npm,wrapper);
    await fs.writeFile(configured,'');
    assert.equal(await locate('codex',configured),native);
  }
  const stale=path.join(root,'WindowsApps','OpenAI.Codex_0.0.0.0_x64__2p2nqsd0c76g0','app','resources','codex.exe');
  assert.equal(await locate('codex',stale.replaceAll('\\','/')),native);
  await fs.unlink(native);
  await fs.mkdir(path.dirname(legacy),{recursive:true});
  await fs.writeFile(legacy,'');
  assert.equal(await locate('codex',stale),legacy);
});
