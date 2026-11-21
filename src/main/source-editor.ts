import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Snapshot, SourceEditor, SourceEditorLocation } from '../shared';
import { locate, windowsDefaultExecutable, windowsEditorCli } from './executables';
import { fileSha256, safeFile } from './snapshot';

const exec = promisify(execFile);

export async function editorSourceFile(snapshot: Snapshot, location: Pick<SourceEditorLocation, 'path' | 'line'>) {
  const { path: relative, line } = location;
  const entry = snapshot.files.find(file => file.path === relative);
  if (!entry) throw new Error('文件不在本次源码快照内。');
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1 || line > entry.line_count)) {
    throw new Error('源码行号超出快照中的文件范围。');
  }
  try {
    const file = await safeFile(snapshot.root_path, relative);
    if (await fileSha256(file) !== entry.content_sha256) {
      throw new Error('工程中的文件已变化。可在 Arc 查看原版本源码依据，或更新走读后重试。');
    }
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`工程中的源码文件已不存在：${relative}`);
    throw error;
  }
}

export function sourceEditorLaunch(file: string, line?: number, cli?: string) {
  const args = line === undefined ? [file] : ['--goto', `${file}:${line}:1`];
  const env = { ...process.env };
  if (cli) {
    args.unshift(cli);
    for (const key of Object.keys(env)) {
      if (['VSCODE_DEV', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) delete env[key];
    }
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return { args, env };
}

export async function defaultSourceLaunch(file: string, line: number | undefined, associatedProgram?: string) {
  const cli = associatedProgram && await windowsEditorCli(associatedProgram);
  if (cli) return sourceEditorLaunch(file, line, cli);
  const extension = (path.extname(file) || path.basename(file)).toLowerCase();
  // The system's Open action can execute these file types.
  if (extension === '.desktop' || extension === '.command' || (process.platform === 'win32' &&
      /^\.(?:exe|com|bat|cmd|ps1|js|jse|vbs|vbe|wsf|wsh|hta|scr|pif|lnk|url|msc|msi|reg|cpl|appref-ms|application|py|pyw)$/.test(extension))) {
    throw new Error('此类型的系统关联可能执行文件，请使用 Trae 或 VS Code 查看源码。');
  }
}

export async function openSourceInEditor(file: string, line: number | undefined, editor: SourceEditor, openPath: (file: string) => Promise<string>) {
  const windows = process.platform === 'win32';
  if (editor === 'default') {
    const extension = /\.[^.]+$/.exec(path.basename(file))?.[0].toLowerCase() ?? '';
    const program = windows ? await windowsDefaultExecutable(extension) : undefined;
    const launch = await defaultSourceLaunch(file, line, program);
    if (program && launch) {
      await launchEditor(program, launch, '默认编辑器');
      return;
    }
    const error = await openPath(file);
    if (error) throw new Error(`无法使用系统默认关联打开此文件：${error}`);
    return;
  }

  const label = editor === 'trae' ? 'Trae' : 'VS Code';
  let program: string;
  try {
    program = await locate(editor === 'trae' ? 'trae' : 'code');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(`未找到 ${label}。请安装 ${label} 或将其命令行目录加入 PATH。`);
  }
  const cli = windows ? await windowsEditorCli(program) : undefined;
  if (windows && !cli) throw new Error(`未找到 ${label} 的命令行入口。`);
  await launchEditor(program, sourceEditorLaunch(file, line, cli), label);
}

async function launchEditor(program: string, { args, env }: ReturnType<typeof sourceEditorLaunch>, label: string) {
  try {
    await exec(program, args, { windowsHide: true, env, timeout: 15000 });
  } catch (error) {
    throw new Error(`无法启动 ${label}：${(error as Error).message}`);
  }
}
