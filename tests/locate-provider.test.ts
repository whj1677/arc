import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { locate } from '../src/main/providers';

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
