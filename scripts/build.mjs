import { execFileSync } from 'node:child_process';
import { build as vite } from 'vite';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import grammars from '../src/main/tree-sitter-grammars.json' with { type: 'json' };
await vite({ base: './', build: { outDir: 'dist/ui', emptyOutDir: true }, esbuild: { jsx: 'automatic' } });
// The CLI inherits stdio and does not need a Node-to-esbuild service pipe.
const cli = fileURLToPath(import.meta.resolve('esbuild/bin/esbuild'));
function bundle(entries, ...options) {
  const args = [...entries.map(name => `src/main/${name}.ts`), '--outdir=dist', '--out-extension:.js=.cjs',
    '--bundle', '--platform=node', '--format=cjs', '--external:electron', '--external:node:sqlite', ...options];
  if (process.platform === 'win32') execFileSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  else execFileSync(cli, args, { stdio: 'inherit' });
}
bundle(['main'], '--sourcemap');
bundle(['preload', 'context-server', 'arc-mcp']);

const wasmDir = 'dist/tree-sitter';
await mkdir(wasmDir, { recursive: true });
await copyFile('node_modules/web-tree-sitter/tree-sitter.wasm', wasmDir + '/tree-sitter.wasm');
await Promise.all(Object.values(grammars).map(source =>
  copyFile(`node_modules/${source}`, `${wasmDir}/${basename(source)}`)
));
