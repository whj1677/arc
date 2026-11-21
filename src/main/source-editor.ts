import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Snapshot, SourceEditor, SourceEditorLocation } from '../shared';
import { locate } from './executables';
import { fileSha256, safeFile } from './snapshot';

export async function editorSourceFile(snapshot: Snapshot, location: Pick<SourceEditorLocation, 'path' | 'line'>, editor: SourceEditor) {
  const { path: relative, line } = location;
  const entry = snapshot.files.find(file => file.path === relative);
  if (!entry) throw new Error('文件不在本次源码快照内。');
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1 || line > entry.line_count)) {
    throw new Error('源码行号超出快照中的文件范围。');
  }
  // The system's Open action can run these file types instead of showing source.
  const extension = path.extname(relative).toLowerCase();
  if (editor === 'default' && (extension === '.desktop' || extension === '.command' || (process.platform === 'win32' &&
      /^\.(?:exe|com|bat|cmd|ps1|js|jse|vbs|vbe|wsf|wsh|hta|scr|pif|lnk|url|msc|msi|reg|cpl|appref-ms|application|py|pyw)$/.test(extension)))) {
    throw new Error('此类型的系统关联可能执行文件，请使用 VS Code 查看源码。');
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

export function vscodeSourceLaunch(program: string, file: string, line?: number) {
  const args = line === undefined ? [file] : ['--goto', `${file}:${line}:1`];
  const env = { ...process.env };
  if (process.platform === 'win32') {
    // Match the official code.cmd without passing source paths through cmd.exe.
    args.unshift(path.join(path.dirname(program), 'resources', 'app', 'out', 'cli.js'));
    delete env.VSCODE_DEV;
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return { args, env };
}

export async function openSourceInVSCode(file: string, line?: number) {
  let program: string;
  try {
    program = await locate('code');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error('未找到 VS Code。请安装 VS Code 或将其命令行目录加入 PATH。');
  }
  const { args, env } = vscodeSourceLaunch(program, file, line);
  await new Promise<void>((resolve, reject) => {
    execFile(program, args, { windowsHide: true, env }, error => {
      if (error) reject(new Error(`无法启动 VS Code：${error.message}`));
      else resolve();
    });
  });
}
