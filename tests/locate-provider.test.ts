import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { locate } from '../src/main/providers';
import { locateVerificationShell } from '../src/main/development-runner';
import { isSupportedDshVersion,resolveDsh } from '../src/main/dsh';
import { getDefaultExecutableOverride,setDefaultExecutableOverrides,windowsGitDirs } from '../src/main/executables';
import { ProjectEnvironmentService } from '../src/main/env-probe';
import { ArcService,isSupportedNodeVersion } from '../src/main/service';
import { workspaceGitDirectory } from '../src/main/snapshot';
import { Store } from '../src/main/store';

async function isolatedInstall(t:TestContext) {
  await fs.mkdir('.test-data',{recursive:true});
  const root=await fs.mkdtemp(path.resolve('.test-data','locate-'));
  for(const key of ['PATH','ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA','APPDATA','PNPM_HOME','VOLTA_HOME','NVM_SYMLINK','USERPROFILE','SystemRoot','npm_config_prefix','DSH_HOME']) {
    const original=process.env[key];
    process.env[key]=path.join(root,key);
    t.after(()=>{if(original===undefined)delete process.env[key];else process.env[key]=original;});
  }
  t.after(()=>fs.rm(root,{recursive:true}));
  return root;
}

async function installFile(root:string,relative:string,contents='') {
  const file=path.join(root,relative);
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,contents,{mode:0o755});
  return file;
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
    dsh:['APPDATA/npm','PNPM_HOME','LOCALAPPDATA/pnpm','VOLTA_HOME/bin','USERPROFILE/scoop/shims','npm_config_prefix','NVM_SYMLINK','ProgramFiles/nodejs','ProgramFiles(x86)/nodejs','LOCALAPPDATA/Programs/nodejs'],
    codex:['APPDATA/npm','PNPM_HOME','LOCALAPPDATA/pnpm','VOLTA_HOME/bin','USERPROFILE/scoop/shims','LOCALAPPDATA/Programs/codex','USERPROFILE/.local/bin','npm_config_prefix'],
  };
  assert.deepEqual(windowsGitDirs(),candidates.git.map(dir=>path.join(root,dir)));
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

test('Windows discovers the newest usable Codex extension in VS Code and Cursor',{skip:process.platform!=='win32'},async t=>{
  const root=await isolatedInstall(t);
  const arch=process.arch==='arm64'?'arm64':'x86_64';
  for(const editor of ['.vscode','.cursor']){
    const extensions=path.join(root,'USERPROFILE',editor,'extensions');
    const older=await installFile(extensions,'openai.chatgpt-0.9.0/bin/windows-x86_64/codex.exe');
    const newest=await installFile(extensions,`OpenAI.ChatGPT-0.10.0/bin/windows-${arch}/codex.exe`);
    await installFile(extensions,'openai.chatgpt-0.11.0/bin/linux-x86_64/codex');
    await installFile(extensions,`other.chatgpt-1.0.0/bin/windows-${arch}/codex.exe`);
    assert.equal(await locate('codex'),newest);
    await fs.unlink(newest);
    assert.equal(await locate('codex'),older);
    await fs.unlink(older);
  }
});

test('Windows finds native Codex inside a custom npm prefix',{skip:process.platform!=='win32'},async t=>{
  const root=await isolatedInstall(t);
  const arch=process.arch==='arm64'?'arm64':'x64';
  const target=arch==='arm64'?'aarch64':'x86_64';
  const native=await installFile(root,`npm_config_prefix/node_modules/@openai/codex-win32-${arch}/vendor/${target}-pc-windows-msvc/bin/codex.exe`);
  assert.equal(await locate('codex'),native);
});

test('Windows resolves DSH package shims with Node from NVM and rejects escaping or missing entries',{skip:process.platform!=='win32'},async t=>{
  const root=await isolatedInstall(t);
  const node=await installFile(root,'NVM_SYMLINK/node.exe');
  const prefix=path.join(root,'npm_config_prefix');
  const entryTail='node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  const pnpmEntry=`global\\5\\.pnpm\\@deepseek-ai+dsh@0.2.1-rc.2\\${entryTail}`;
  for(const [variable,entry] of [['%~dp0\\',pnpmEntry],['%~dp0',entryTail],['%dp0%\\',entryTail]]){
    const shim=await installFile(prefix,'dsh.cmd',`@echo off\r\nnode "${variable}${entry}" %*\r\n`);
    const script=await installFile(prefix,entry);
    assert.deepEqual(await resolveDsh(),{command:node,prefix:[script],path:shim});
  }
  await installFile(root,entryTail);
  const shim=await installFile(prefix,'dsh.cmd',`@echo off\r\nnode "%~dp0..\\${entryTail}" %*\r\n`);
  await assert.rejects(resolveDsh(shim),/超出启动器目录/);
  await installFile(prefix,'dsh.cmd',`@echo off\r\nnode "%~dp0missing\\${entryTail}" %*\r\n`);
  await assert.rejects(resolveDsh(shim));
});

test('Windows honors a Node override for a DSH shim with an embedded absolute Node path',{skip:process.platform!=='win32'},async t=>{
  const root=await isolatedInstall(t);
  const embedded=await installFile(root,'old tools/node.exe');
  const node=await installFile(root,'new tools/node.exe');
  const entry=await installFile(root,'dsh/lib/bin.js');
  const shim=await installFile(root,'dsh.cmd',`@echo off\r\n"${embedded}" "${entry}" %*\r\n`);
  assert.deepEqual(await resolveDsh(shim),{command:embedded,prefix:[entry],path:shim});
  await fs.unlink(embedded);
  t.after(()=>setDefaultExecutableOverrides({}));
  setDefaultExecutableOverrides({node});
  assert.deepEqual(await resolveDsh(shim),{command:node,prefix:[entry],path:shim});
  setDefaultExecutableOverrides({});
  await assert.rejects(resolveDsh(shim),{code:'ENOENT'});
});

test('Node and Git overrides take precedence and clearing invalidates cached automatic paths',async t=>{
  const root=await isolatedInstall(t);
  const windows=process.platform==='win32';
  t.after(()=>setDefaultExecutableOverrides({}));
  process.env.PATH=path.join(root,'initial');
  for(const name of ['node','git'] as const){
    const binary=windows?name+'.exe':name;
    const toolDir=name==='git'?'Git/cmd':'nodejs';
    const initial=await installFile(root,windows?`ProgramFiles(x86)/${toolDir}/${binary}`:`initial/${binary}`);
    assert.equal(await locate(name),initial);
    const fallback=await installFile(root,windows?`ProgramFiles/${toolDir}/${binary}`:`updated/${binary}`);
    process.env.PATH=path.join(root,'updated');
    const custom=await installFile(root,`custom tools/${binary}`);
    setDefaultExecutableOverrides({[name]:custom});
    assert.equal(getDefaultExecutableOverride(name),custom);
    assert.equal(await locate(name),custom);
    assert.equal(await locate(name,initial),initial);
    setDefaultExecutableOverrides({});
    assert.equal(getDefaultExecutableOverride(name),undefined);
    assert.equal(await locate(name),fallback);
    process.env.PATH=path.join(root,'initial');
  }
});

test('Windows project environment detection skips configured programs inside the workspace',{skip:process.platform!=='win32'},async t=>{
  const root=await isolatedInstall(t);
  const workspace=path.join(root,'workspace');
  await installFile(workspace,'package.json','{}');
  const node=await installFile(workspace,'tools/node.exe');
  const git=await installFile(workspace,'tools/git.exe');
  const store=new Store(path.join(root,'storage'));
  try {
    setDefaultExecutableOverrides({node,git});
    const env=await new ProjectEnvironmentService(store).get('p',workspace);
    assert.equal(env.tools.find(tool=>tool.id==='node')?.status,'missing');
    assert.equal(env.tools.find(tool=>tool.id==='git')?.status,'missing');
  } finally {
    setDefaultExecutableOverrides({});
    store.close();
  }
});

test('ArcService persists trimmed program paths, reloads them on startup, and clears them',async t=>{
  const root=await isolatedInstall(t);
  const directory=path.join(root,'storage');
  const node=path.join(root,'custom tools','node.exe');
  const git=path.join(root,'missing-git.exe');
  const codex=path.join(root,'missing-codex.exe');
  const dsh=path.join(root,'missing-dsh.cmd');
  const service=new ArcService(directory,path.resolve('.'));
  try {
    assert.deepEqual(service.providerPathConfig(),{});
    await service.probe({codex_path:` ${codex} `,dsh_path:` ${dsh} `,node_path:` ${node} `,git_path:` ${git} `},'dsh');
    const saved={codex_path:codex,dsh_path:dsh,node_path:node,git_path:git};
    assert.deepEqual(service.providerPathConfig(),saved);
    assert.equal(getDefaultExecutableOverride('node'),node);
    assert.equal(getDefaultExecutableOverride('git'),git);
    const invalidConfigs:Record<string,string>[]=[{unknown_path:node},{node_path:42 as unknown as string}];
    for(const invalid of invalidConfigs){
      await assert.rejects(service.probe(invalid,'codex'),/不支持的连接配置/);
      assert.deepEqual(service.providerPathConfig(),saved);
    }
  } finally {
    await service.shutdown();
    service.store.close();
  }
  assert.equal(getDefaultExecutableOverride('node'),undefined);
  assert.equal(getDefaultExecutableOverride('git'),undefined);
  const reopened=new ArcService(directory,path.resolve('.'));
  try {
    assert.equal(getDefaultExecutableOverride('node'),node);
    assert.equal(getDefaultExecutableOverride('git'),git);
    await reopened.probe({node_path:' ',git_path:'',dsh_path:'\t'},'codex');
    assert.deepEqual(reopened.providerPathConfig(),{codex_path:codex});
    assert.equal(getDefaultExecutableOverride('node'),undefined);
    assert.equal(getDefaultExecutableOverride('git'),undefined);
  } finally {
    await reopened.shutdown();
    reopened.store.close();
  }
});

test('ArcService immediately uses saved Node for DSH and reports runtime versions and invalid paths',async t=>{
  const systemRoot=process.env.SystemRoot;
  const root=await isolatedInstall(t);
  if(systemRoot!==undefined)process.env.SystemRoot=systemRoot;
  const node=process.execPath;
  const git=path.join(root,'missing-git.exe');
  const dsh=await installFile(root,'custom tools/dsh.cjs',`console.log('0.2.1-rc.2');\n`);
  const service=new ArcService(path.join(root,'storage'),path.resolve('.'));
  try {
    const [profile]=await service.probe({dsh_path:dsh,node_path:node,git_path:git},'dsh');
    assert.equal(profile.path,dsh);
    const tools=await service.probeRuntimeTools();
    const gitStatus=tools.find(tool=>tool.id==='git');
    assert.equal(gitStatus?.status,'missing');
    assert.equal(gitStatus?.path,git);
    assert.match(gitStatus?.reason??'',/指定的程序路径不存在或无法访问/);
    assert.equal(profile.version,'0.2.1-rc.2',profile.reason);
    assert.deepEqual(tools.find(tool=>tool.id==='node'),{id:'node',label:'Node.js',status:'available',path:node,version:process.version});
  } finally {
    await service.shutdown();
    service.store.close();
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

test('Node runtime check requires at least v22.13.0 for node:sqlite MCP support',()=>{
  for(const version of ['v22.13.0','v22.19.0','v24.0.0','22.13.0'])
    assert.equal(isSupportedNodeVersion(version),true,version);
  for(const version of ['v20.18.0','v22.12.9','v18.20.0','not a version',''])
    assert.equal(isSupportedNodeVersion(version),false,version);
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
