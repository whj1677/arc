import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CompletionBinding, WorkspaceAsset } from '../engineering';
import type { Snapshot, SourceFile } from '../shared';
import { id, now } from './store';
import { locate } from './executables';
const exec = promisify(execFile);
export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export async function fileSha256(file:string) {
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(file))hash.update(bytes);
  return hash.digest('hex');
}
export function isRelativePath(value: unknown): value is string {
  return typeof value === 'string' && !!value && !value.includes('\\') && !value.includes(':') && !value.includes('\0') &&
    !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
export function relativePath(value: string) {
  if (!isRelativePath(value)) throw new Error('拒绝非规范或越界路径');
  return value;
}
export function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function safeFile(root: string, file: string) {
  relativePath(file);
  const base = await fs.realpath(root), target = path.resolve(base, file);
  if (!inside(base, target)) throw new Error('路径越界');
  const resolved = await fs.realpath(target);
  if (!inside(base, resolved)) throw new Error('符号链接越界');
  // Reject all reparse/symlink segments, even when the final target happens to be inside.
  let cursor = base;
  for (const part of file.split('/')) { cursor = path.join(cursor, part); if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('不读取符号链接'); }
  if (!(await fs.stat(resolved)).isFile()) throw new Error('不是普通文件');
  return resolved;
}
const ignored = new Set(['.git','node_modules','.arc-local','dist','release','.next','.venv','venv','.idea','.cache','.codex','.dsh','.tools','.test-data','.runtime','.work','.pytest_cache','__pycache__','CMakeFiles']);
export function generatedMarker(name:string, directory:boolean) {
  return directory ? name === 'CMakeFiles' : name === 'CMakeCache.txt' || name === 'build.ninja';
}
// A directory named build can contain authored source. Check build markers
// in the listing already needed for traversal, without stat'ing every child.
export async function sourceDirectoryEntries(directory:string) {
  if(path.basename(directory)==='CMakeFiles')return null;
  const entries=await fs.readdir(directory,{withFileTypes:true});
  return entries.some(entry=>(entry.isFile() || entry.isDirectory()) && generatedMarker(entry.name,entry.isDirectory()))?null:entries;
}
const secret = /^(?:\.env(?:\..*)?|\.?auth\.json|\.?credentials(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
export function excludedEntry(name:string) {
  return ignored.has(name) || secret.test(name) || /^\.tmp_/i.test(name);
}
const windowsIgnored = new Set([...ignored].map(name => name.toLowerCase()));
function windowsPathAlias(part: string) {
  return /[. ]$/.test(part) || /~\d/.test(part) || /^(?:nul|con|aux|prn|com\d|lpt\d)(?:\.|$)/i.test(part);
}
// Live callers supply their own spelling, while snapshot traversal sees canonical directory entries.
export function livePathComponentAllowed(part: string) {
  return !excludedEntry(part) && (process.platform !== 'win32' ||
    (!windowsIgnored.has(part.toLowerCase()) && !windowsPathAlias(part)));
}
// Rollback can recreate missing paths, including paths supplied by a restored
// archive. Apply the same exclusions before consulting its saved manifests.
export function rollbackPathAllowed(file:string) {
  return relativePath(file).split('/').every(part=>
    !excludedEntry(part)&&!ignored.has(part.toLowerCase())&&
    !/^(?:cmakefiles$|cmake-build-)/i.test(part)&&
    !(process.platform==='win32'&&windowsPathAlias(part))
  );
}
export function decode(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('非 UTF-8 文本，未提供可靠行定位'); }
}
export const linesOf = (text: string) => { const lines = text.split(/\r\n|\n|\r/); if (lines.at(-1) === '') lines.pop(); return lines; };
async function ignoredByGit(root:string) {
  // Ask Git for ignored, untracked paths. Tracked files remain eligible even
  // when they match a later ignore rule. A non-worktree root yields no Git
  // exclusions; do not recurse into nested worktrees to discover their rules.
  const gitIgnored = new Set<string>();
  try {
    const {stdout}=await exec(await locate('git'),['--no-optional-locks','-c','core.fsmonitor=false','-C',root,'ls-files','--others','--ignored','--exclude-standard','--directory','-z'],{windowsHide:true,timeout:10000,maxBuffer:8*1024*1024});
    for(const entry of stdout.split('\0').filter(Boolean))gitIgnored.add(entry.replace(/\/$/,''));
  } catch { /* Without a verified Git list, retain the ordinary exclusions. */ }
  return gitIgnored;
}
export async function* workspacePaths(root:string, includePath?: (file:string)=>boolean): AsyncGenerator<string> {
  const gitIgnored=await ignoredByGit(root);
  async function* walk(dir:string,prefix=''): AsyncGenerator<string> {
    for(const entry of await sourceDirectoryEntries(dir)??[]){
      const rel=prefix?`${prefix}/${entry.name}`:entry.name;
      if(gitIgnored.has(rel)||excludedEntry(entry.name)||entry.isSymbolicLink())continue;
      if(includePath && !includePath(rel))continue;
      if(entry.isDirectory())yield* walk(path.join(dir,entry.name),rel);
      else if(entry.isFile())yield rel;
    }
  }
  yield* walk(root);
}
// Hash eligible worktree bytes without storing them or exposing binary contents.
export async function workspaceFiles(root:string, snapshot?:Snapshot) {
  const files=new Map<string,string>(), assets:WorkspaceAsset[]=[];
  const textFiles=new Map(snapshot?.files.map(file=>[file.path,file.content_sha256]));
  for await(const rel of workspacePaths(root)){
    const input=await safeFile(root,rel), before=await fs.stat(input);
    const digest=await fileSha256(input);
    const after=await fs.stat(input);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.ino!==after.ino)throw Error(`采集期间文件变化：${rel}，请重试`);
    files.set(rel,digest);
    if(!snapshot)continue;
    if(textFiles.get(rel)===digest)textFiles.delete(rel);
    else if(textFiles.has(rel))throw Error(`采集期间文本文件变化：${rel}，请重试`);
    else assets.push({path:rel,sha256:digest});
  }
  if(textFiles.size)throw Error('采集期间文本文件清单变化，请重试');
  return {fingerprint:sha(JSON.stringify([...files].sort(([a],[b])=>a<b?-1:a>b?1:0))),assets};
}

export async function workspaceGitDirectory(root:string):Promise<string|null> {
  try {
    const {stdout}=await exec(await locate('git'),['-C',root,'rev-parse','--git-common-dir'],{windowsHide:true,timeout:10000});
    return path.resolve(root,stdout.trim());
  } catch(error) {
    const failure=error as NodeJS.ErrnoException&{stderr?:string};
    if(failure.stderr?.includes('not a git repository'))return null;
    if(failure.code!=='ENOENT')throw error;
    for(let directory=root;;directory=path.dirname(directory)){
      try{await fs.lstat(path.join(directory,'.git'));}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        if(directory===path.dirname(directory))return null;
        continue;
      }
      throw Error('检测到 Git 工作区，但当前 ARC 启动环境的 PATH 找不到 Git。请让 Git 可从终端执行，再重新启动 ARC。');
    }
  }
}

export async function bindWorkspaceCompletion(workspacePath:string):Promise<CompletionBinding> {
  const workspace_path=await fs.realpath(workspacePath);
  async function checkout(){
    const git=async (...args:string[])=>(await exec(await locate('git'),['-C',workspace_path,...args],{windowsHide:true,timeout:10000})).stdout.trim();
    const git_common_dir=await workspaceGitDirectory(workspace_path);
    const head=git_common_dir?await git('rev-parse','HEAD').catch(()=>null):null;
    const branch=git_common_dir?await git('symbolic-ref','--short','-q','HEAD').catch(()=>null):null;
    return {git_common_dir,head,branch};
  }
  const before=await checkout(), {fingerprint}=await workspaceFiles(workspace_path),after=await checkout();
  if(before.head!==after.head||before.branch!==after.branch||before.git_common_dir!==after.git_common_dir)throw Error('采集期间分支或 HEAD 变化，请重试');
  return {workspace_path,workspace_fingerprint:fingerprint,...after};
}

export async function capture(rootPath: string, projectId: string, storage: string, buildConfig: string, signal?: AbortSignal, progress?: (n: number) => void): Promise<Snapshot> {
  const root = await fs.realpath(rootPath);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('请选择工程目录');
  if (inside(root, path.resolve(storage))) throw new Error('工程范围包含 Arc 数据目录；请选择更精确的工程子目录。');
  const snapshotId = id('source'), destination = path.join(storage, 'snapshots', snapshotId);
  const files: SourceFile[] = [], excluded: {path:string;reason:string}[] = [];
  const gitIgnored=await ignoredByGit(root);
  let total = 0;
  const abort = () => { if (signal?.aborted) throw new Error('索引已取消，未发布不完整快照'); };
  async function walk(directory: string, prefix = '') {
    abort();
    const entries = await sourceDirectoryEntries(directory);
    if(!entries){excluded.push({path:prefix||'.',reason:'CMake/Ninja 生成目录，不进入源码快照'});return;}
    entries.sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      abort();
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if(gitIgnored.has(rel)){excluded.push({path:rel,reason:'Git 忽略的未跟踪文件或目录，不进入源码快照'});continue;}
      if (excludedEntry(entry.name)) { excluded.push({path:rel,reason:'构建/临时/依赖/状态/凭据默认排除'}); continue; }
      if (entry.isSymbolicLink()) { excluded.push({path:rel,reason:'符号链接/重解析点不进入快照'}); continue; }
      if (entry.isDirectory()) { await walk(path.join(directory,entry.name),rel); continue; }
      if (!entry.isFile()) continue;
      relativePath(rel);
      const input = await safeFile(root,rel);
      const stat = await fs.stat(input);
      if (stat.size > 2 * 1024 * 1024) { excluded.push({path:rel,reason:'超过单文件 2 MiB 索引预算'}); continue; }
      const bytes = await fs.readFile(input);
      if (bytes.includes(0)) { excluded.push({path:rel,reason:'二进制或含 NUL，不索引'}); continue; }
      let text: string;
      try { text = decode(bytes); } catch { excluded.push({path:rel,reason:'非 UTF-8，编码待确认'}); continue; }
      total += bytes.byteLength;
      if (total > 256 * 1024 * 1024 || files.length >= 50000) throw new Error('超出本次快照 256 MiB / 50,000 文件预算，请缩小工程范围');
      const output = path.join(destination,rel);
      await fs.mkdir(path.dirname(output),{recursive:true});
      await fs.writeFile(output,bytes,{flag:'wx'});
      files.push({path:rel, content_sha256:sha(bytes),bytes:bytes.length,line_count:linesOf(text).length,encoding:'utf-8'});
      if (files.length % 50 === 0) progress?.(files.length);
    }
  }
  // All stored bytes are retained. A second manifest checks membership AND byte identity.
  await walk(root); abort();
  const observed = new Set<string>();
  async function verify(directory: string, prefix = '') {
    for (const entry of await sourceDirectoryEntries(directory)??[]) {
      abort();
      if (excludedEntry(entry.name) || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if(gitIgnored.has(rel))continue;
      if (entry.isDirectory()) { await verify(path.join(directory,entry.name),rel); continue; }
      if (!entry.isFile()) continue;
      const input = await safeFile(root,rel), stat = await fs.stat(input);
      if (stat.size > 2*1024*1024) continue;
      const bytes = await fs.readFile(input);
      if (bytes.includes(0)) continue;
      try { decode(bytes); } catch { continue; }
      observed.add(rel);
      if (expected.get(rel) !== sha(bytes)) throw new Error(`捕获期间文件变化：${rel}。未发布混合快照，请重试。`);
    }
  }
  const expected = new Map(files.map(f => [f.path,f.content_sha256]));
  await verify(root);
  if (observed.size !== files.length) throw new Error('捕获期间文件清单变化，请重试');
  let commit: string|null=null, dirty: string|null=null;
  try { commit = (await exec(await locate('git'),['-C',root,'rev-parse','HEAD'],{windowsHide:true,timeout:5000})).stdout.trim(); dirty = (await exec(await locate('git'),['--no-optional-locks','-C',root,'status','--porcelain=v1','--untracked-files=normal'],{windowsHide:true,timeout:5000,maxBuffer:1024*1024})).stdout.trim(); } catch { /* A non-Git project is valid; identity is not guessed. */ }
  const snapshot: Snapshot = {source_snapshot_id:snapshotId,project_id:projectId,captured_at:now(),root_path:root,files,excluded,fingerprint:sha(JSON.stringify([files.map(f=>[f.path,f.content_sha256]),buildConfig])),commit,dirty,build_config:buildConfig,consistency:'verified'};
  await fs.mkdir(destination,{recursive:true});
  progress?.(files.length);
  return snapshot;
}
export async function readSource(storage: string, snapshot: Snapshot, file: string) {
  const entry = snapshot.files.find(f=>f.path===file);
  if (!entry) throw new Error('文件不在本次授权快照内');
  const input = await safeFile(path.join(storage,'snapshots',snapshot.source_snapshot_id),file);
  const bytes = await fs.readFile(input);
  if (sha(bytes)!==entry.content_sha256) throw new Error('快照缓存哈希不匹配，拒绝冒充历史来源');
  return { ...entry, source_snapshot_id:snapshot.source_snapshot_id,text:decode(bytes) };
}
export async function freshness(snapshot: Snapshot) {
  const additions: string[] = [];
  const gitIgnored=await ignoredByGit(snapshot.root_path);
  const expected=new Map(snapshot.files.map(file=>[file.path,file.content_sha256]));
  const changed=new Set(expected.keys());
  async function walk(directory:string,prefix='') {
    for(const entry of await sourceDirectoryEntries(directory)??[]){
      if(excludedEntry(entry.name)||entry.isSymbolicLink())continue;
      const rel=prefix?`${prefix}/${entry.name}`:entry.name;
      if(gitIgnored.has(rel))continue;
      if(entry.isDirectory()){await walk(path.join(directory,entry.name),rel);continue;}
      if(!entry.isFile())continue;
      if(expected.has(rel)){
        try {
          const bytes=await fs.readFile(await safeFile(snapshot.root_path,rel));
          if(sha(bytes)===expected.get(rel))changed.delete(rel);
        } catch { /* Keep unavailable files marked as changed. */ }
        continue;
      }
      const input=await safeFile(snapshot.root_path,rel);
      if((await fs.stat(input)).size>2*1024*1024)continue;
      const bytes=await fs.readFile(input);if(bytes.includes(0))continue;
      try{decode(bytes);}catch{continue;}
      additions.push(rel);
    }
  }
  await walk(snapshot.root_path);
  return [...changed,...additions];
}
