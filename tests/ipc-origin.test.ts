import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesUiUrl} from '../src/main/ipc-origin';

test('IPC URL prefix comparison folds only a Windows file URL drive letter',()=>{
  const ui='file:///c:/Arc/ui/index.html';
  assert.ok(matchesUiUrl('file:///C:/Arc/ui/index.html#files',ui,'win32'));
  assert.ok(matchesUiUrl(ui,'file:///C:/Arc/ui/index.html','win32'));
  assert.ok(!matchesUiUrl('file:///C:/Arc/ui/index.html',ui,'linux'));
  for(const frame of ['file:///D:/Arc/ui/index.html','file:///C:/arc/ui/index.html','file://server/C:/Arc/ui/index.html','https://C:/Arc/ui/index.html']){
    assert.ok(!matchesUiUrl(frame,ui,'win32'),frame);
  }
});
