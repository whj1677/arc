import { test } from 'node:test';
import assert from 'node:assert/strict';
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
