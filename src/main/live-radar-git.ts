import { execFile, spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import { locate } from './executables';
import { generatedMarker, isRelativePath, livePathComponentAllowed, relativePath, safeFile, sourceDirectoryEntries } from './snapshot';
import type { RadarChangedFile } from '../live-radar';

const exec = promisify(execFile);
const gitArgs = (root: string, args: string[]) => [
  '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args,
];

export async function git(root: string, ...args: string[]) {
  return (await exec(await locate('git'), gitArgs(root, args), {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  })).stdout;
}

export async function gitOptional(root: string, ...args: string[]) {
  try { return await git(root, ...args); }
  catch (error) {
    if ((error as {code?: number}).code === 1) return null;
    throw error;
  }
}

export function validateRef(ref: string) {
  if (!['HEAD', 'EMPTY', 'WORKTREE', 'SNAPSHOT'].includes(ref) &&
      !(typeof ref === 'string' && /^[0-9a-f]{7,40}(?:~1)?$/.test(ref))) throw Error('无效 Git 引用');
}

export function allowedPath(file: string) {
  return relativePath(file).split('/').every(livePathComponentAllowed);
}

interface BlobEntry { oid: string; size: number; mode: string }
export class GitTree extends Map<string, BlobEntry> {
  readonly generatedFiles: string[] = [];
  readonly directories = new Set<string>();
}

function markerDirectory(file: string, regularFile = true) {
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i++) {
    const directory = i < parts.length - 1;
    if ((directory || regularFile) && generatedMarker(parts[i], directory)) return parts.slice(0, i).join('/') || '.';
  }
}

export async function treeFiles(root: string, ref: string): Promise<GitTree> {
  const tree = new GitTree();
  if (ref === 'EMPTY') return tree;
  const generated = new Set<string>();
  for (const record of (await git(root, 'ls-tree', '-rlz', ref, '--', '.')).split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t'), file = record.slice(tab + 1);
    const [mode, , oid, size] = record.slice(0, tab).trim().split(/\s+/);
    if (!isRelativePath(file)) continue;
    const marker = markerDirectory(file, mode.startsWith('100'));
    if (marker) generated.add(marker);
    if (!/^100(?:644|755)$/.test(mode) || !allowedPath(file)) continue;
    tree.set(file, { oid, mode, size: Number(size) });
    for (let dir = path.posix.dirname(file); !tree.directories.has(dir); dir = path.posix.dirname(dir)) {
      tree.directories.add(dir);
    }
  }
  if (generated.size) {
    for (const file of tree.keys()) {
      for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
        if (generated.has(dir)) { tree.generatedFiles.push(file); tree.delete(file); break; }
        if (dir === '.') break;
      }
    }
  }
  return tree;
}

// Batch immutable blobs by byte size so a cold index needs only a few Git processes.
export async function* blobs(root: string, tree: GitTree, files: Iterable<string>) {
  let batch: string[] = [], size = 0;
  async function* read() {
    const ids = batch.map(file => tree.get(file)!.oid);
    const child = exec(await locate('git'), gitArgs(root, ['cat-file', '--batch']), {
      encoding: 'buffer', windowsHide: true, timeout: 30000, maxBuffer: size + batch.length * 100,
    });
    const input = child.child?.stdin;
    const sent = input && finished(input, {readable: false, cleanup: true});
    input?.end(ids.join('\n') + '\n');
    const [{stdout}] = await Promise.all([child, sent]);
    let offset = 0;
    for (const file of batch) {
      const entry = tree.get(file)!, header = stdout.indexOf(10, offset);
      if (header < 0 || stdout.toString('ascii', offset, header) !== entry.oid + ' blob ' + entry.size ||
          stdout[header + 1 + entry.size] !== 10) throw Error('Git blob 元数据不一致');
      const start = header + 1;
      yield [file, stdout.subarray(start, start + entry.size)] as const;
      offset = start + entry.size + 1;
    }
  }
  for (const file of files) {
    const entry = tree.get(file);
    if (!entry) continue;
    if (batch.length && (size + entry.size > 8 * 1024 * 1024 || batch.length === 1024)) {
      yield* read(); batch = []; size = 0;
    }
    batch.push(file); size += entry.size;
  }
  if (batch.length) yield* read();
}

export const previewLimit = 200 * 1024;
export async function readPreview(handle: FileHandle, size: number) {
  const bytes = Buffer.alloc(Math.min(size, previewLimit + 1));
  let offset = 0;
  while (offset < bytes.length) {
    const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

export async function blobPreview(root: string, file: string, tree: GitTree) {
  const entry = tree.get(file);
  if (!entry) return Buffer.alloc(0);
  if (entry.size <= previewLimit) {
    for await (const [, bytes] of blobs(root, tree, [file])) return bytes;
  }
  // Stop reading huge historical blobs once the preview and truncation flag are known.
  const child = spawn(await locate('git'), gitArgs(root, ['cat-file', 'blob', entry.oid]), {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000,
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  const bytes = Buffer.alloc(previewLimit + 1);
  let copied = 0;
  async function readPrefix() {
    for await (const chunk of child.stdout) {
      copied += (chunk as Buffer).copy(bytes, copied);
      if (copied === bytes.length) { child.kill(); break; }
    }
  }
  const [code] = await Promise.all([done, readPrefix()]);
  if (copied !== bytes.length) throw Error(`Git blob 预览不完整（退出码 ${code}）`);
  return bytes;
}

export function worktreeDirectories(root: string) {
  const cache = new Map<string, Promise<boolean>>();
  function eligible(dir: string): Promise<boolean> {
    let check = cache.get(dir);
    if (!check) {
      check = (async () => {
        if (dir !== '.' && !await eligible(path.posix.dirname(dir))) return false;
        const full = path.join(root, dir);
        try {
          const stat = await fs.lstat(full);
          return stat.isDirectory() && !stat.isSymbolicLink() && !!await sourceDirectoryEntries(full);
        } catch (error) {
          if (missing(error)) return false;
          throw error;
        }
      })();
      cache.set(dir, check);
    }
    return check;
  }
  return eligible;
}

export function missing(error: unknown) {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

export const worktreeChangedMessage = '文件在本次雷达扫描后已修改，请刷新变更雷达';
export async function worktreePreview(root: string, file: string, change?: Change, isGit = true) {
  const absent = () => {
    if (change && change.status !== 'removed') throw Error(worktreeChangedMessage);
    return Buffer.alloc(0);
  };
  if (!await worktreeDirectories(root)(path.posix.dirname(file))) return absent();
  // check-ignore leaves tracked files eligible, including files matching later rules.
  if (isGit && await gitOptional(root, 'check-ignore', '-q', '--', file) !== null) {
    if (change) return absent();
    throw Error('文件被 Git 忽略');
  }
  try {
    if (change) {
      if (!(await fs.lstat(path.join(root, file))).isFile()) return absent();
      if (change.status === 'removed') throw Error(worktreeChangedMessage);
    }
    const handle = await fs.open(await safeFile(root, file), 'r');
    try {
      const check = (stat: Stats) => {
        if (change && (stat.size !== change.size || worktreeStamp(stat) !== change.stamp)) throw Error(worktreeChangedMessage);
      };
      const stat = await handle.stat();
      check(stat);
      const bytes = await readPreview(handle, stat.size);
      if (change) check(await handle.stat());
      return bytes;
    } finally { await handle.close(); }
  } catch (error) {
    if (missing(error)) return absent();
    throw error;
  }
}

export interface Change extends RadarChangedFile { stamp: string; size: number }
export function commitChanges(before: GitTree, after: GitTree): Change[] {
  const changes: Change[] = [];
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(file), next = after.get(file);
    if (old?.oid === next?.oid && old?.mode === next?.mode) continue;
    changes.push({path: file, status: !old ? 'added' : !next ? 'removed' : 'modified',
      stamp: next?.oid ?? '', size: next?.size ?? 0});
  }
  return changes;
}

export const worktreeStamp = (stat: Pick<Stats, 'mtimeMs' | 'ctimeMs'>) => stat.mtimeMs + '/' + stat.ctimeMs;
type Flags = {staged: boolean; unstaged: boolean};

export async function worktreeChanges(root: string, before: GitTree, prefix: string, baseRef: string, porcelain: string) {
  const flags = new Map<string, Flags>();
  const markerDirs = new Map<string, Flags>();
  const stagedDeletions = new Set<string>();
  const ignoredFiles = new Set<string>();
  function mark(map: Map<string, Flags>, key: string, status: Flags) {
    const previous = map.get(key);
    map.set(key, {staged: !!previous?.staged || status.staged, unstaged: !!previous?.unstaged || status.unstaged});
  }
  for (const row of porcelain.split('\0')) {
    if (!row || row.startsWith('#')) continue;
    const fields = row.split(' '), type = fields[0];
    let full: string, status: Flags;
    if (type === '1' || type === 'u') {
      full = fields.slice(type === '1' ? 8 : 10).join(' ');
      status = {staged: fields[1][0] !== '.', unstaged: fields[1][1] !== '.'};
    } else if (type === '?' || type === '!') {
      full = row.slice(2);
      status = {staged: false, unstaged: true};
    } else throw Error('未知 Git 工作区状态记录');
    if (!full.startsWith(prefix)) continue;
    const file = full.slice(prefix.length);
    const namedPath = file.replace(/\/$/, '');
    if (!isRelativePath(namedPath)) continue;
    const marker = markerDirectory(file);
    if (marker && (marker === '.' || allowedPath(marker))) mark(markerDirs, marker, status);
    // Git can collapse an ignored directory containing a local generation marker.
    if (type === '!' && file.endsWith('/') && before.directories.has(namedPath)) mark(markerDirs, namedPath, status);
    if (type === '!') ignoredFiles.add(file);
    if (type === '1' && fields[1][0] === 'D') stagedDeletions.add(file);
    if (type !== '!' && !file.endsWith('/') && allowedPath(file)) mark(flags, file, status);
  }
  const directories = worktreeDirectories(root);
  // A staged edit may have been entirely undone in the working copy.
  const net = baseRef !== 'EMPTY' && [...flags.values()].some(s => s.staged && s.unstaged)
    ? new Set((await git(root, 'diff', '--no-renames', '--no-ext-diff', '--relative', '--name-only', '-z', baseRef, '--', '.')).split('\0'))
    : undefined;
  const induced = new Set<string>();
  if (markerDirs.size) {
    for (const file of [...before.keys(), ...before.generatedFiles]) {
      if (flags.has(file)) continue;
      const parent = path.posix.dirname(file);
      for (let dir = parent; ; dir = path.posix.dirname(dir)) {
        const status = markerDirs.get(dir);
        if (status) {
          if (await directories(parent) !== before.has(file)) { flags.set(file, status); induced.add(file); }
          break;
        }
        if (dir === '.') break;
      }
    }
  }
  const changes: Change[] = [];
  for (const [file, status] of flags) {
    if (net && status.staged && status.unstaged && !net.has(file) && !induced.has(file)) continue;
    let stat;
    if (await directories(path.posix.dirname(file))) {
      try { stat = await fs.lstat(path.join(root, file)); }
      catch (error) { if (!missing(error)) throw error; }
    }
    const present = stat?.isFile() && !(stagedDeletions.has(file) &&
      (ignoredFiles.has(file) || await gitOptional(root, 'check-ignore', '-q', '--', file) !== null));
    if (!present && !before.has(file)) continue;
    changes.push({path: file, status: !present ? 'removed' : before.has(file) ? 'modified' : 'added',
      ...status, size: present ? stat!.size : 0, stamp: present ? worktreeStamp(stat!) : ''});
  }
  return changes;
}
