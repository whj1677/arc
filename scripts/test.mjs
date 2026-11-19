import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const env = { ...process.env };

if (process.platform === 'win32') {
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = env[pathKey] ?? '';
  const hasGit = currentPath
    .split(path.delimiter)
    .some(dir => dir && fs.existsSync(path.join(dir, 'git.exe')));
  if (!hasGit) {
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'),
    ].filter(Boolean);
    const gitDir = candidates.find(dir => fs.existsSync(path.join(dir, 'git.exe')));
    if (gitDir) {
      env[pathKey] = currentPath ? `${gitDir}${path.delimiter}${currentPath}` : gitDir;
    }
  }
}

const args = process.argv.slice(2);
const targets = args.length ? args : ['tests/*.test.ts'];
const tsxBin = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const result = spawnSync(tsxBin, ['--test', ...targets], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
