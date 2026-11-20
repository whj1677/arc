import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CodeModuleBrowser} from '../src/ui/CodeModules';
import type {CodeIndexSummary} from '../src/shared';

test('the static module view groups source directories and shows ranked entry names and directed call counts', () => {
  const summary: CodeIndexSummary = {
    modules: ['app/ems', 'app/pcs', 'hal/can'].map(dir => ({
      dir, files: [dir + '/run.cpp'], file_count: 1, symbol_count: 2, key_symbols: [dir.split('/')[1] + '::run'],
    })),
    module_edges: [{from: 'app/ems', to: 'hal/can', count: 4}], total_files: 3, total_symbols: 6, total_calls: 5,
  };
  const html = renderToStaticMarkup(createElement(CodeModuleBrowser, {summary}));
  assert.match(html, /<summary>app <small>2 个目录/);
  assert.match(html, /data-module-dir="hal\/can"/);
  assert.match(html, /ems::run/);
  assert.match(html, /data-module-from="app\/ems" data-module-to="hal\/can"[^]*?<td>4<\/td>/);
  const filtered = renderToStaticMarkup(createElement(CodeModuleBrowser, {summary, search: 'EMS::run'}));
  assert.match(filtered, /data-module-dir="app\/ems"/);
  assert.doesNotMatch(filtered, /data-module-dir="app\/pcs"/);
  assert.match(filtered, /data-module-to="hal\/can"/);
});

test('wrapped source trees retain subsystem groups and full directory IDs even when searching', () => {
  const dirs = ['product', 'product/include/x', 'product/src/app/core', 'product/src/hal/can', 'product/src/mid/managers'];
  const summary: CodeIndexSummary = {
    modules: dirs.map(dir => ({dir, files: [dir + '/entry.c'], file_count: 1, symbol_count: 0, key_symbols: []})),
    total_files: dirs.length, total_symbols: 0, total_calls: 0, module_edges: [],
  };
  const html = renderToStaticMarkup(createElement(CodeModuleBrowser, {summary}));
  for (const group of ['include', 'src/app', 'src/hal', 'src/mid']) assert.ok(html.includes('<summary>' + group + ' '));
  const filtered = renderToStaticMarkup(createElement(CodeModuleBrowser, {summary, search: 'can'}));
  assert.match(filtered, /<summary>src\/hal /);
  assert.match(filtered, /data-module-dir="product\/src\/hal\/can"/);
});
