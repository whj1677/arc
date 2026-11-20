import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isValidCodexModel, loadCodexModelCatalog } from '../src/main/codex-models';

test('model identifiers accept the default and reject malformed CLI arguments', () => {
  for (const value of ['', 'GPT-6.2_astra', 'a'.repeat(80)]) assert.ok(isValidCodexModel(value));
  for (const value of ['-m', '_foo', 'a b', 'model/path', 'a'.repeat(81), '中文'])
    assert.equal(isValidCodexModel(value), false);
});

test('local Codex catalog reads root config and visible models in cache order', t => {
  const base = path.resolve('.test-data');
  fs.mkdirSync(base, { recursive: true });
  const home = fs.mkdtempSync(path.join(base, 'codex-catalog-'));
  t.after(() => fs.rmSync(home, { recursive: true }));
  const load = () => loadCodexModelCatalog({ CODEX_HOME: home });
  const config = path.join(home, 'config.toml'), cache = path.join(home, 'models_cache.json');
  assert.deepEqual(load(), { default_model: undefined, models: [] });
  fs.writeFileSync(config, '# model = "comment"\n model = "local.model" # primary\n[profiles.work]\nmodel = "section"');
  const entries = [
    { slug: 'alpha', display_name: 'Preview', visibility: 'other' }, { slug: 'hidden', visibility: 'hide' },
    { slug: 'beta' }, { slug: 'alpha', display_name: 'Alpha', visibility: 'list' },
    { slug: 'beta', display_name: 'Duplicate' }, null, { slug: 12 }, { slug: '' }, { slug: 'bad name' },
  ];
  for (const json of [entries, { models: entries }, { data: entries }]) {
    fs.writeFileSync(cache, JSON.stringify(json));
    assert.deepEqual(load(), { default_model: 'local.model', models: [
      { slug: 'alpha', display_name: 'Alpha' }, { slug: 'beta', display_name: 'beta' },
    ] });
  }
  fs.writeFileSync(cache, '{');
  assert.deepEqual(load(), { default_model: 'local.model', models: [] });
  fs.writeFileSync(config, '# model = "commented"\n[profiles.work]\nmodel = "only-in-section"');
  assert.equal(load().default_model, undefined);
  for (const quote of ['"""', "'''"]) {
    fs.writeFileSync(config, [`developer_instructions = ${quote}`, 'model = "example-in-prompt"', quote, 'model = "actual-model"'].join('\n'));
    assert.equal(load().default_model, 'actual-model');
  }
});
