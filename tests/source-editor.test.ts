import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { Snapshot } from '../src/shared';
import { locate } from '../src/main/executables';
import { editorSourceFile, vscodeSourceArgs } from '../src/main/source-editor';
import { sha } from '../src/main/snapshot';

test('editor opens the bound source in the workspace and rejects stale or invalid locations', async t => {
  const scratch = path.resolve('.test-data');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'source-editor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const relative = '源码 示例.ts';
  const file = path.join(root, relative);
  const source = '// example\nfunction read() {}';
  await fs.writeFile(file, source);
  const snapshot: Snapshot = {
    source_snapshot_id: 'snapshot', project_id: 'project', captured_at: '', root_path: root,
    files: [{ path: relative, content_sha256: sha(source), bytes: Buffer.byteLength(source), line_count: 2, encoding: 'utf8' }],
    excluded: [], fingerprint: '', commit: null, dirty: null, build_config: '', consistency: 'verified',
  };
  const location = { path: relative, line: 2 };

  assert.equal(await editorSourceFile(snapshot, location, 'vscode'), await fs.realpath(file));
  assert.equal(await editorSourceFile(snapshot, { ...location, line: undefined }, 'default'), await fs.realpath(file));
  await assert.rejects(editorSourceFile(snapshot, { ...location, line: 3 }, 'vscode'), /行号超出/);
  await assert.rejects(editorSourceFile(snapshot, { ...location, path: '../other.ts' }, 'default'), /文件不在/);
  const executableSource = process.platform === 'win32' ? 'script.cmd' : 'shortcut.desktop';
  await assert.rejects(editorSourceFile({ ...snapshot, files: [{ ...snapshot.files[0], path: executableSource }] },
    { ...location, path: executableSource }, 'default'), /可能执行文件/);
  await fs.writeFile(file, '\n' + source);
  await assert.rejects(editorSourceFile(snapshot, location, 'vscode'), /工程中的文件已变化/);
  await fs.unlink(file);
  await assert.rejects(editorSourceFile(snapshot, location, 'default'), /源码文件已不存在/);
});

test('VS Code goto passes the full Windows path and line as one argument', () => {
  const file = 'C:\\测试工程\\with spaces & symbols\\read.ts';
  assert.deepEqual(vscodeSourceArgs(file, 15), ['--goto', `${file}:15`]);
  assert.deepEqual(vscodeSourceArgs(file), [file]);
});

test('Windows resolves the native VS Code executable beside the PATH launcher', { skip: process.platform !== 'win32' }, async t => {
  const scratch = path.resolve('.test-data');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'VS Code 目录-'));
  const oldPath = process.env.PATH;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'bin');
  const executable = path.join(root, 'Code.exe');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'code.cmd'), '');
  await fs.writeFile(executable, '');
  process.env.PATH = bin;

  assert.equal(await locate('code'), executable);
});
