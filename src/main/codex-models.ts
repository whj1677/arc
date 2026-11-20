import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { CodexModelCatalog } from '../shared';

export function isValidCodexModel(slug: string): boolean {
  return typeof slug === 'string' && (slug === '' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(slug));
}

function readOptional<T>(file: string, parse: (text: string) => T): T | undefined {
  try { return parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return undefined; }
}

export function loadCodexModelCatalog(env = process.env): CodexModelCatalog {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const model = readOptional(path.join(home, 'config.toml'), parseToml)?.model;
  const default_model = typeof model === 'string' && model && isValidCodexModel(model) ? model : undefined;
  const raw = readOptional(path.join(home, 'models_cache.json'), JSON.parse);
  const entries = Array.isArray(raw) ? raw : raw?.models ?? raw?.data;
  const models = new Map<string, { display_name: string; preferred: boolean }>();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.slug || !isValidCodexModel(entry.slug) || entry.visibility === 'hide') continue;
    const preferred = entry.visibility === 'list' || entry.visibility == null;
    const previous = models.get(entry.slug);
    if (previous && (!preferred || previous.preferred)) continue;
    const display_name = typeof entry.display_name === 'string' && entry.display_name.trim() || entry.slug;
    models.set(entry.slug, { display_name, preferred });
  }
  return { default_model, models: Array.from(models, ([slug, { display_name }]) => ({ slug, display_name })) };
}
