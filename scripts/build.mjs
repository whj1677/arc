import { build } from 'esbuild';
import { build as vite } from 'vite';
await vite({ base: './', build: { outDir: 'dist/ui', emptyOutDir: true }, esbuild: { jsx: 'automatic' } });
await build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node:sqlite'], sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['src/main/context-server.ts'], outfile: 'dist/context-server.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['node:sqlite'], supported: {'top-level-await': true} });
await build({entryPoints:['src/main/arc-mcp.ts'],outfile:'dist/arc-mcp.cjs',bundle:true,platform:'node',format:'cjs',external:['node:sqlite']});
