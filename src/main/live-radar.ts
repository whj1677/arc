import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAstCallGraphDiff, computeStructureDiff, type TaskHudImpact } from '../development-hud';
import type { WorkspaceBinding } from '../engineering';
import type { LiveFileDiff, LiveWorkspaceRadar, RadarMode } from '../live-radar';
import type { Project, Snapshot, SourceEditor } from '../shared';
import { ambiguousCHeader, assembleCodeIndex, hasCppSources, parseSourceUnit, supportsSourceFile, type SourceUnit } from './code-index';
import { architectureImpact, impactedFeaturesForFiles, indexImpact, relatedConstraints } from './development-hud';
import {
  allowedPath, blobPreview, blobs, commitChanges, git, gitOptional, previewLimit, treeFiles, validateRef,
  worktreeChangedMessage, worktreeChanges, worktreeDirectories, worktreePreview, worktreeStamp, type Change, type GitTree,
} from './live-radar-git';
import { decode, safeFile, sha, sourceDirectoryEntries, workspaceGitDirectory } from './snapshot';
import { snapshotChanges, snapshotPreview, snapshotTree } from './live-radar-snapshot';
import { openSourceInEditor } from './source-editor';
import type { Store } from './store';

const indexLimit = 2 * 1024 * 1024;
const maxIndexedFiles = 10_000;
const maxIndexedBytes = 64 * 1024 * 1024;
export type RadarOptions = { mode?: RadarMode; commit?: string; previousFingerprint?: string; focus_file?: string };
export interface FileDiffOptions { base_ref: string; target_ref: string; path: string; fingerprint?: string }

function boundProject(store: Store, projectId: string) {
  if (store.all<WorkspaceBinding>('engineering_workspace').some(w => w.project_id === projectId && w.status === 'unbound')) {
    throw Error('恢复的工程尚未重新绑定本机工作区，请先重新绑定后再使用变更雷达');
  }
  return store.get<Project>('project', projectId);
}

async function gitWorkspace(root: string) {
  const directory = await workspaceGitDirectory(root);
  if (directory) return {root, directory, prefix: ''};
  const children = (await sourceDirectoryEntries(root) ?? []).filter(entry =>
    !entry.name.startsWith('.') && allowedPath(entry.name));
  if (children.length !== 1 || !children[0].isDirectory()) return;
  const child = children[0].name, nested = path.join(root, child);
  const nestedDirectory = await workspaceGitDirectory(nested);
  if (nestedDirectory) return {root: nested, directory: nestedDirectory, prefix: child + '/'};
}

function localPath(file: string, prefix: string) {
  if (!file.startsWith(prefix) || file === prefix) throw Error('文件不在 Git 工作区范围内');
  return file.slice(prefix.length);
}

function projectSnapshot(store: Store, project: Project) {
  const snapshot = project.snapshot_id ? store.maybe<Snapshot>('snapshot', project.snapshot_id) : null;
  if (snapshot && (snapshot.project_id !== project.project_id || snapshot.source_snapshot_id !== project.snapshot_id)) {
    throw Error('快照不属于当前工程');
  }
  return snapshot;
}

// Keep a bounded number of immutable revisions. Concurrent polls share their cold build.
function revisionCache<T>() {
  const cache = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>) => {
    const prior = cache.get(key);
    if (prior) { cache.delete(key); cache.set(key, prior); return prior; }
    const value = load().catch(error => {
      if (cache.get(key) === value) cache.delete(key);
      throw error;
    });
    cache.set(key, value);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    return value;
  };
}
function memo<T>(load: (root: string, ref: string) => Promise<T>) {
  const cached = revisionCache<T>();
  return (root: string, ref: string) => cached(JSON.stringify([root, ref]), () => load(root, ref));
}
const tree = memo(treeFiles);
const gitPrefix = memo(async root => (await git(root, 'rev-parse', '--show-prefix')).replace(/\r?\n$/, ''));
const recentCommits = memo(async (root, head) => {
  if (head === 'EMPTY') return [];
  const log = await git(root, 'log', '-n', '12', '--format=%H%x1f%h%x1f%s%x1f%cI', head, '--', '.');
  if (!log) return [];
  return log.trimEnd().split('\n').map(line => {
    const [sha, short_sha, ...rest] = line.split('\x1f');
    return {sha, short_sha, authored_at: rest.pop()!, subject: rest.join('\x1f')};
  });
});

function sourceText(bytes: Buffer) {
  if (bytes.includes(0)) return;
  try { return decode(bytes); } catch { return; } // Frozen snapshots also omit non-UTF-8 files.
}

interface ParsedFile { unit: SourceUnit; header?: {text: string; cpp: boolean; alternate?: Promise<SourceUnit>} }
async function parse(file: string, text: string, cpp: boolean): Promise<ParsedFile> {
  const unit = await parseSourceUnit(file, text, cpp);
  return {unit, header: ambiguousCHeader(file, text) ? {text, cpp} : undefined};
}

async function assemble(files: Map<string, ParsedFile>, cpp: boolean, ref: string, fingerprint: string) {
  // Keep equal-ranked symbols and extern declarations stable across delete/reinsert edits.
  const units: SourceUnit[] = [];
  for (const file of [...files.keys()].sort()) {
    const {unit, header} = files.get(file)!;
    if (header && header.cpp !== cpp) {
      header.alternate ??= parseSourceUnit(unit.file, header.text, cpp);
      units.push(await header.alternate);
    } else units.push(unit);
  }
  return assembleCodeIndex(units, ref, fingerprint);
}

interface Edit { stamp: string; text?: string; parsed?: ParsedFile; binary?: boolean }
type ReadBlobs = (paths: Iterable<string>) => AsyncIterable<readonly [string, Buffer]>;
async function buildBase(entries: ReadonlyMap<string, {size: number}>, read: ReadBlobs, ref: string, prefix: string) {
  const files = new Map<string, ParsedFile>();
  const supported = [...entries].filter(([file, entry]) => supportsSourceFile(file) && entry.size <= indexLimit);
  if (supported.length > maxIndexedFiles || supported.reduce((sum, [, entry]) => sum + entry.size, 0) > maxIndexedBytes) {
    throw Error('工程源码规模超过实时雷达索引预算，请打开更小范围的子目录');
  }
  const paths = supported.map(([file]) => file);
  const cpp = hasCppSources(paths);
  for await (const [file, bytes] of read(paths)) {
    const text = sourceText(bytes);
    if (text !== undefined) files.set(file, await parse(prefix + file, text, cpp));
  }
  return {entries, files, read, cpp, index: await assemble(files, cpp, ref, ref), edits: new Map<string, Edit>()};
}
type Baseline = Awaited<ReturnType<typeof buildBase>>;
const cachedBase = revisionCache<Baseline>();
function baseIndex(root: string, ref: string, prefix: string, storage: string, snapshot: Snapshot | null) {
  const key = JSON.stringify([root, ref, prefix, snapshot && [storage, snapshot.source_snapshot_id, snapshot.fingerprint]]);
  return cachedBase(key, async () => {
    if (!snapshot) {
      const entries = await tree(root, ref);
      return buildBase(entries, paths => blobs(root, entries, paths), ref, prefix);
    }
    const {entries, read} = snapshotTree(storage, snapshot);
    return buildBase(entries, read, snapshot.source_snapshot_id, prefix);
  });
}

async function gitComparison(root: string, gitDirectory: string, options: RadarOptions) {
  const mode = options.mode ?? 'worktree';
  if (mode !== 'worktree' && mode !== 'commit') throw Error('无效雷达模式');
  let head: string | null, branch: string | null;
  let base: string, target = 'WORKTREE', targetTree: GitTree | undefined;
  let changes: Change[];
  if (mode === 'worktree') {
    const [porcelain, prefix] = await Promise.all([
      git(root, 'status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind', '--no-renames',
        '--untracked-files=all', '--ignored=matching', '--', '.'),
      gitPrefix(root, gitDirectory),
    ]);
    const headers = porcelain.split('\0', 2);
    const oid = headers[0]?.match(/^# branch\.oid (.+)$/)?.[1];
    const name = headers[1]?.match(/^# branch\.head (.+)$/)?.[1];
    if (!oid || !name) throw Error('无法读取 Git 工作区标识');
    head = oid === '(initial)' ? null : oid;
    branch = name === '(detached)' ? null : name;
    base = head ?? 'EMPTY';
    changes = await worktreeChanges(root, await tree(root, base), prefix, base, porcelain);
  } else {
    const [oid, branchName] = await Promise.all([
      gitOptional(root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'),
      gitOptional(root, 'symbolic-ref', '--short', '-q', 'HEAD'),
    ]);
    head = oid?.trim() ?? null; branch = branchName?.trim() ?? null;
    base = 'EMPTY';
    const ref = options.commit ?? 'HEAD';
    validateRef(ref);
    if (['EMPTY', 'WORKTREE', 'SNAPSHOT'].includes(ref)) throw Error('请选择有效提交');
    if (ref === 'HEAD' && !head) {
      target = 'EMPTY';
    } else {
      const ancestry = (await git(root, 'rev-list', '-n', '1', '--parents', (ref === 'HEAD' ? head! : ref) + '^{commit}', '--')).trim();
      const [commit, parent] = ancestry.split(' ');
      target = commit; base = parent ?? 'EMPTY';
    }
    targetTree = await tree(root, target);
    changes = commitChanges(await tree(root, base), targetTree);
  }
  changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const fingerprint = sha(JSON.stringify([base, mode, target, mode === 'worktree' ? changes : null]));
  return {base, target, mode, head, branch, changes, fingerprint, targetTree};
}
type Comparison = Awaited<ReturnType<typeof gitComparison>> & {unchanged?: Map<string, Change>};

async function comparison(git: Awaited<ReturnType<typeof gitWorkspace>>, root: string, snapshot: Snapshot | null, options: RadarOptions): Promise<Comparison> {
  if (git) return gitComparison(git.root, git.directory, options);
  const {changes, unchanged} = snapshot ? await snapshotChanges(root, snapshot) : {changes: [], unchanged: undefined};
  changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {base: snapshot ? 'SNAPSHOT' : 'EMPTY', target: 'WORKTREE', mode: 'worktree', head: null, branch: null,
    fingerprint: snapshot ? sha(JSON.stringify([snapshot.source_snapshot_id, snapshot.fingerprint, changes])) : '',
    changes, unchanged, targetTree: undefined};
}

async function patchIndex(root: string, state: Comparison, baseline: Baseline, prefix: string) {
  const {target, targetTree, changes, fingerprint} = state;
  const afterSources = new Map<string, string>();
  const binaryFiles = new Set<string>();
  const oversized = new Set(changes.filter(c => supportsSourceFile(c.path) &&
    (c.size > indexLimit || (baseline.entries.get(c.path)?.size ?? 0) > indexLimit)).map(c => c.path));
  const comparable = changes.filter(c => !oversized.has(c.path));
  const beforeFiles = oversized.size ? new Map(baseline.files) : baseline.files;
  for (const file of oversized) beforeFiles.delete(file);
  const changedPaths = comparable.map(c => prefix + c.path);
  const dirty = comparable.filter(c => supportsSourceFile(c.path));
  const beforeIndex = beforeFiles === baseline.files ? baseline.index : await assemble(beforeFiles, baseline.cpp, state.base, state.base);
  const beforeSources = new Map<string, string>();
  if (!dirty.length) return {beforeIndex, afterIndex: beforeIndex, beforeSources, afterSources, binaryFiles, changedPaths};
  for await (const [file, bytes] of baseline.read(dirty.map(c => c.path))) {
    const text = sourceText(bytes);
    if (text !== undefined) beforeSources.set(prefix + file, text);
  }
  const afterPaths = new Set([...baseline.entries].filter(([file, entry]) => supportsSourceFile(file) && entry.size <= indexLimit).map(([file]) => file));
  for (const change of changes) {
    if (change.status === 'removed' || change.size > indexLimit) afterPaths.delete(change.path);
    else if (supportsSourceFile(change.path)) afterPaths.add(change.path);
  }
  const cpp = hasCppSources(afterPaths);
  const files = new Map(beforeFiles);
  const edits = targetTree ? new Map<string, Edit>() : baseline.edits;
  const current = new Set(dirty.map(c => c.path));
  for (const file of edits.keys()) if (!current.has(file)) edits.delete(file);
  const pending = new Map<string, Change>();
  function apply(change: Change, edit: Edit) {
    if (edit.parsed) files.set(change.path, edit.parsed);
    if (edit.text !== undefined) afterSources.set(prefix + change.path, edit.text);
    if (edit.binary) binaryFiles.add(change.path);
  }
  for (const change of dirty) {
    files.delete(change.path);
    if (change.status === 'removed') continue;
    const cached = edits.get(change.path);
    if (cached && cached.stamp === change.stamp + '/' + change.size) apply(change, cached);
    else pending.set(change.path, change);
  }
  async function update(file: string, bytes: Buffer) {
    const change = pending.get(file)!;
    const text = sourceText(bytes);
    const edit = {stamp: change.stamp + '/' + change.size, text, binary: text === undefined,
      parsed: text === undefined ? undefined : await parse(prefix + file, text, cpp)};
    edits.set(file, edit); apply(change, edit);
  }
  if (targetTree) {
    for await (const [file, bytes] of blobs(root, targetTree, pending.keys())) await update(file, bytes);
  } else {
    for (const [file, change] of pending) {
      const handle = await fs.open(await safeFile(root, file), 'r');
      try {
        const check = async () => {
          const stat = await handle.stat();
          if (stat.size !== change.size || worktreeStamp(stat) !== change.stamp) throw Error('索引期间文件变化，请重试：' + file);
        };
        await check();
        const bytes = await handle.readFile();
        await check();
        await update(file, bytes);
      } finally { await handle.close(); }
    }
  }
  const afterIndex = await assemble(files, cpp, target, fingerprint);
  return {beforeIndex, afterIndex, beforeSources, afterSources, binaryFiles, changedPaths};
}

const views = new WeakMap<Baseline, {fingerprint: string; value: ReturnType<typeof patchIndex>}>();
async function liveIndexes(root: string, state: Comparison, prefix: string, storage: string, snapshot: Snapshot | null) {
  const baseline = await baseIndex(root, state.base, prefix, storage, snapshot);
  const prior = views.get(baseline);
  if (prior?.fingerprint === state.fingerprint) return prior.value;
  const value = patchIndex(root, state, baseline, prefix).catch(error => {
    if (views.get(baseline)?.value === value) views.delete(baseline);
    throw error;
  });
  views.set(baseline, {fingerprint: state.fingerprint, value});
  return value;
}

function emptyImpact(): TaskHudImpact {
  return {scope_files: [], scope_declared: false, external_callers: [], shared_states: [], architecture_nodes: [],
    architecture_edges: [], impacted_features: [], untested_symbols: [], related_constraints: []};
}
function impactMetadata(store: Store, project: Project, files: Set<string>) {
  return {...architectureImpact(store.latestOverview(project)?.result, files),
    impacted_features: impactedFeaturesForFiles(store, project, files), related_constraints: relatedConstraints(store, project, files)};
}
function impact(store: Store, project: Project, index: ReturnType<typeof assembleCodeIndex> | undefined, files: Set<string>): TaskHudImpact {
  if (!files.size) return emptyImpact();
  return {...emptyImpact(), scope_files: [...files], ...(index && indexImpact(index, files)), ...impactMetadata(store, project, files)};
}

function callGraph(indexes: Awaited<ReturnType<typeof liveIndexes>>, state: Comparison, focus?: string) {
  const {beforeIndex, afterIndex, beforeSources, afterSources, changedPaths} = indexes;
  return computeAstCallGraphDiff({beforeIndex, afterIndex, beforeSources, afterSources,
    beforeSnapshotId: state.base, afterSnapshotId: state.target, changedFiles: changedPaths,
    focusFiles: focus ? [focus] : undefined});
}

// Key results by store/project: the same checkout can have different saved architecture and features.
type RadarCacheEntry = {radar: LiveWorkspaceRadar; state: Comparison};
const radarCache = new WeakMap<Store, Map<string, RadarCacheEntry>>();
const radarKey = (projectId: string, mode: RadarMode) => JSON.stringify([projectId, mode]);
export async function buildLiveWorkspaceRadar(store: Store, storage: string, projectId: string, options: RadarOptions = {}): Promise<LiveWorkspaceRadar> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  if (options.focus_file !== undefined && !allowedPath(options.focus_file)) throw Error('文件不在工程源码范围内');
  const project = boundProject(store, projectId), root = project.root_path;
  const repo = await gitWorkspace(root);
  const snapshot = repo ? null : projectSnapshot(store, project);
  const prefix = repo?.prefix ?? '';
  const state = await comparison(repo, root, snapshot, options);
  const {head, branch, mode, base, target, fingerprint, changes} = state;
  const key = radarKey(projectId, mode);
  const cache = radarCache.get(store) ?? new Map<string, RadarCacheEntry>();
  radarCache.set(store, cache);
  const prior = cache.get(key)?.radar, subpath = prefix.slice(0, -1) || undefined;
  const hit = prior?.workspace_path === root && prior.git_subpath === subpath && prior.is_git === !!repo &&
    options.previousFingerprint === fingerprint && prior.fingerprint === fingerprint && prior.head_sha === head && prior.branch === branch;
  const files = new Set(changes.map(c => prefix + c.path));
  const focus = options.focus_file;
  const focusOn = (comparable: readonly string[] | undefined) =>
    focus && (comparable ? comparable.includes(focus) : files.has(focus)) ? focus : undefined;
  if (hit) {
    const currentImpact = files.size ? {...prior.impact, ...impactMetadata(store, project, files)} : prior.impact;
    const focus_file = focusOn(prior.structure_diff?.changed_files);
    const radar = {...prior, focus_file, impact: currentImpact, cache_hit: true};
    if (focus_file !== prior.focus_file && prior.structure_diff) {
      const indexes = await liveIndexes(repo?.root ?? root, state, prefix, storage, snapshot);
      radar.ast_call_graph = callGraph(indexes, state, focus_file);
    }
    radar.computed_ms = elapsed();
    cache.set(key, {radar, state});
    return radar;
  }
  const [indexes, recent_commits] = await Promise.all([
    changes.some(c => supportsSourceFile(c.path)) ? liveIndexes(repo?.root ?? root, state, prefix, storage, snapshot) : undefined,
    repo ? recentCommits(repo.root, head ?? 'EMPTY') : [],
  ]);
  const focus_file = focusOn(indexes?.changedPaths);
  const radar: LiveWorkspaceRadar = {
    project_id: projectId, workspace_path: root, source: repo ? 'git' : 'snapshot', is_git: !!repo,
    git_subpath: subpath, snapshot_id: snapshot?.source_snapshot_id, branch, head_sha: head, mode, focus_file,
    base_ref: base, target_ref: target, fingerprint, cache_hit: false, recent_commits,
    changed_files: changes.map(({stamp, size, ...file}) => ({...file, path: prefix + file.path,
      is_source: supportsSourceFile(file.path), ...(indexes?.binaryFiles.has(file.path) && {binary: true})})),
    impact: impact(store, project, indexes?.afterIndex, files), computed_ms: 0,
  };
  if (indexes) {
    const {beforeIndex, afterIndex, changedPaths} = indexes;
    radar.structure_diff = computeStructureDiff(beforeIndex, afterIndex, [], changedPaths);
    radar.ast_call_graph = callGraph(indexes, state, focus_file);
  }
  radar.computed_ms = elapsed();
  cache.set(key, {radar, state});
  return radar;
}

export async function liveWorkspaceImpact(store: Store, storage: string, project: Project, files: string[]) {
  for (const file of files) if (!allowedPath(file)) throw Error('文件不在工程源码范围内');
  const root = boundProject(store, project.project_id).root_path;
  if (!files.length) return emptyImpact();
  const repo = await gitWorkspace(root);
  const snapshot = repo ? null : projectSnapshot(store, project);
  for (const file of files) localPath(file, repo?.prefix ?? '');
  if (!repo && !snapshot) return emptyImpact();
  const state = await comparison(repo, root, snapshot, {});
  const {afterIndex} = await liveIndexes(repo?.root ?? root, state, repo?.prefix ?? '', storage, snapshot);
  return impact(store, project, afterIndex, new Set(files));
}

export async function readLiveFileDiff(store: Store, storage: string, projectId: string, options: FileDiffOptions): Promise<LiveFileDiff> {
  const {base_ref, target_ref, fingerprint} = options;
  validateRef(base_ref); validateRef(target_ref);
  if (!allowedPath(options.path)) throw Error('文件不在工程源码范围内');
  const project = boundProject(store, projectId);
  const repo = await gitWorkspace(project.root_path);
  const root = repo?.root ?? project.root_path, file = localPath(options.path, repo?.prefix ?? '');
  const snapshot = repo ? null : projectSnapshot(store, project);
  if (target_ref === 'SNAPSHOT' || (base_ref === 'SNAPSHOT' && (!snapshot || target_ref !== 'WORKTREE'))) throw Error('无效快照比较');
  let scannedBase = base_ref;
  let change: Change | undefined;
  if (target_ref === 'WORKTREE' && fingerprint !== undefined) {
    const scan = radarCache.get(store)?.get(radarKey(projectId, 'worktree'));
    if (!scan || scan.state.fingerprint !== fingerprint || scan.radar.workspace_path !== project.root_path ||
        scan.radar.is_git !== !!repo || scan.radar.git_subpath !== (repo?.prefix.slice(0, -1) || undefined) ||
        scan.radar.snapshot_id !== snapshot?.source_snapshot_id) {
      throw Error('雷达快照已过期，请刷新变更雷达');
    }
    scannedBase = scan.state.base;
    if (base_ref !== scannedBase && !(repo && base_ref === 'HEAD')) throw Error('雷达快照已过期，请刷新变更雷达');
    change = scan.state.changes.find(c => c.path === file);
    if (!change && !repo) {
      change = scan.state.unchanged?.get(file) ?? {path: file, status: 'removed', stamp: '', size: 0};
    } else if (!change) {
      const [head, status] = await Promise.all([
        gitOptional(root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'),
        git(root, '--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', file),
      ]);
      if ((head?.trim() ?? 'EMPTY') !== scannedBase || status) throw Error(worktreeChangedMessage);
    }
  }
  async function read(ref: string) {
    if (ref === 'WORKTREE') return worktreePreview(root, file, change, !!repo);
    if (ref === 'EMPTY') return Buffer.alloc(0);
    if (ref === 'SNAPSHOT' && snapshot) {
      const preview = await snapshotPreview(storage, snapshot, file);
      if ('missing' in preview) throw Error('快照缓存哈希不匹配');
      return preview;
    }
    if (!repo) throw Error('当前工作区没有 Git 提交');
    const oid = await gitOptional(root, 'rev-parse', '--verify', '--quiet', ref + '^{commit}');
    if (!oid && ref === 'HEAD') return Buffer.alloc(0);
    if (!oid) throw Error('Git 提交不存在');
    return blobPreview(root, file, await tree(root, oid.trim()));
  }
  const [old, next] = await Promise.all([read(scannedBase), read(target_ref)]);
  const truncated = old.length > previewLimit || next.length > previewLimit;
  if (old.includes(0) || next.includes(0)) return {path: options.path, before: '', after: '', truncated, binary: true};
  const preview = (bytes: Buffer) => new TextDecoder().decode(bytes.subarray(0, previewLimit), {stream: bytes.length > previewLimit});
  return {path: options.path, before: preview(old), after: preview(next), truncated};
}

export async function openLiveWorkspaceFile(store: Store, projectId: string, filePath: string, line: number | undefined,
    editor: SourceEditor, openPath: (file: string) => Promise<string>) {
  if (!allowedPath(filePath)) throw Error('文件不在工程源码范围内');
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw Error('无效源码行号');
  const root = boundProject(store, projectId).root_path;
  if (!await worktreeDirectories(root)(path.posix.dirname(filePath))) throw Error('文件不在工程源码范围内');
  const repo = await gitWorkspace(root);
  if (repo && await gitOptional(repo.root, 'check-ignore', '-q', '--', localPath(filePath, repo.prefix)) !== null) throw Error('文件被 Git 忽略');
  const file = await safeFile(root, filePath);
  return openSourceInEditor(file, line, editor, openPath);
}
