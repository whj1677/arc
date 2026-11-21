import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAstCallGraphDiff, computeStructureDiff, type TaskHudImpact } from '../development-hud';
import type { WorkspaceBinding } from '../engineering';
import type { LiveFileDiff, LiveWorkspaceRadar, RadarMode } from '../live-radar';
import type { Project, SourceEditor } from '../shared';
import { ambiguousCHeader, assembleCodeIndex, hasCppSources, parseSourceUnit, supportsSourceFile, type SourceUnit } from './code-index';
import { architectureImpact, impactedFeaturesForFiles, indexImpact, relatedConstraints } from './development-hud';
import {
  allowedPath, blobPreview, blobs, commitChanges, git, gitOptional, previewLimit, treeFiles, validateRef,
  worktreeChangedMessage, worktreeChanges, worktreeDirectories, worktreePreview, worktreeStamp, type Change, type GitTree,
} from './live-radar-git';
import { decode, safeFile, sha, workspaceGitDirectory } from './snapshot';
import { openSourceInEditor } from './source-editor';
import type { Store } from './store';

const indexLimit = 2 * 1024 * 1024;
const maxIndexedFiles = 10_000;
const maxIndexedBytes = 64 * 1024 * 1024;
type Options = { mode?: RadarMode; commit?: string; previousFingerprint?: string };
export interface FileDiffOptions { base_ref: string; target_ref: string; path: string; fingerprint?: string }

function boundProjectRoot(store: Store, projectId: string) {
  if (store.all<WorkspaceBinding>('engineering_workspace').some(w => w.project_id === projectId && w.status === 'unbound')) {
    throw Error('恢复的工程尚未重新绑定本机工作区，请先重新绑定后再使用变更雷达');
  }
  return store.get<Project>('project', projectId).root_path;
}

// Keep a bounded number of immutable revisions. Concurrent polls share their cold build.
function memo<T>(load: (root: string, ref: string) => Promise<T>) {
  const cache = new Map<string, Promise<T>>();
  return (root: string, ref: string) => {
    const key = JSON.stringify([root, ref]);
    const prior = cache.get(key);
    if (prior) { cache.delete(key); cache.set(key, prior); return prior; }
    const value = load(root, ref).catch(error => {
      if (cache.get(key) === value) cache.delete(key);
      throw error;
    });
    cache.set(key, value);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    return value;
  };
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

interface ParsedFile { unit: SourceUnit; cppHeader?: SourceUnit }
async function parse(file: string, text: string): Promise<ParsedFile> {
  const unit = await parseSourceUnit(file, text);
  // A plain .h changes grammar when the first/last C++ source is added/removed.
  // Prepare both interpretations once to avoid reparsing untouched headers on edits.
  const cppHeader = ambiguousCHeader(file, text) ? await parseSourceUnit(file, text, true) : undefined;
  return {unit, cppHeader};
}

function assemble(files: Map<string, ParsedFile>, ref: string, fingerprint: string) {
  const cpp = hasCppSources(files.keys());
  // Keep equal-ranked symbols and extern declarations stable across delete/reinsert edits.
  const units = [...files.keys()].sort().map(file => {
    const entry = files.get(file)!;
    return cpp && entry.cppHeader ? entry.cppHeader : entry.unit;
  });
  return assembleCodeIndex(units, ref, fingerprint);
}

interface Edit { stamp: string; text?: string; parsed?: ParsedFile; binary?: boolean }
const baseIndex = memo(async (root, ref) => {
  const entries = await tree(root, ref);
  const files = new Map<string, ParsedFile>();
  const supported = [...entries].filter(([file, entry]) => supportsSourceFile(file) && entry.size <= indexLimit);
  if (supported.length > maxIndexedFiles || supported.reduce((sum, [, entry]) => sum + entry.size, 0) > maxIndexedBytes) {
    throw Error('工程源码规模超过实时雷达索引预算，请打开更小范围的子目录');
  }
  for await (const [file, bytes] of blobs(root, entries, supported.map(([file]) => file))) {
    const text = sourceText(bytes);
    if (text !== undefined) files.set(file, await parse(file, text));
  }
  return {entries, files, index: assemble(files, ref, ref), edits: new Map<string, Edit>()};
});

async function comparison(root: string, gitDirectory: string, options: Options) {
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
    if (ref === 'EMPTY' || ref === 'WORKTREE') throw Error('请选择有效提交');
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
type Comparison = Awaited<ReturnType<typeof comparison>>;

type Baseline = Awaited<ReturnType<typeof baseIndex>>;
async function patchIndex(root: string, state: Comparison, baseline: Baseline) {
  const {target, targetTree, changes, fingerprint} = state;
  const afterSources = new Map<string, string>();
  const binaryFiles = new Set<string>();
  const oversized = new Set(changes.filter(c => supportsSourceFile(c.path) &&
    (c.size > indexLimit || (baseline.entries.get(c.path)?.size ?? 0) > indexLimit)).map(c => c.path));
  const comparable = changes.filter(c => !oversized.has(c.path));
  const beforeFiles = oversized.size ? new Map(baseline.files) : baseline.files;
  for (const file of oversized) beforeFiles.delete(file);
  const changedPaths = comparable.map(c => c.path);
  const dirty = comparable.filter(c => supportsSourceFile(c.path));
  const beforeIndex = beforeFiles === baseline.files ? baseline.index : assemble(beforeFiles, state.base, state.base);
  if (!dirty.length) return {beforeIndex, afterIndex: beforeIndex, afterSources, binaryFiles, changedPaths};
  const files = new Map(beforeFiles);
  const edits = targetTree ? new Map<string, Edit>() : baseline.edits;
  const current = new Set(dirty.map(c => c.path));
  for (const file of edits.keys()) if (!current.has(file)) edits.delete(file);
  const pending = new Map<string, Change>();
  function apply(change: Change, edit: Edit) {
    if (edit.parsed) files.set(change.path, edit.parsed);
    if (edit.text !== undefined) afterSources.set(change.path, edit.text);
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
      parsed: text === undefined ? undefined : await parse(file, text)};
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
  const afterIndex = assemble(files, target, fingerprint);
  return {beforeIndex, afterIndex, afterSources, binaryFiles, changedPaths};
}

const views = new WeakMap<Baseline, {fingerprint: string; value: ReturnType<typeof patchIndex>}>();
async function liveIndexes(root: string, state: Comparison) {
  const baseline = await baseIndex(root, state.base);
  const prior = views.get(baseline);
  if (prior?.fingerprint === state.fingerprint) return prior.value;
  const value = patchIndex(root, state, baseline).catch(error => {
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
function impact(store: Store, project: Project, index: ReturnType<typeof assemble>, files: Set<string>): TaskHudImpact {
  if (!files.size) return emptyImpact();
  return {scope_files: [...files], scope_declared: false, ...indexImpact(index, files), ...impactMetadata(store, project, files)};
}

// Key results by store/project: the same checkout can have different saved architecture and features.
type RadarCacheEntry = {radar: LiveWorkspaceRadar; state: Comparison};
const radarCache = new WeakMap<Store, Map<string, RadarCacheEntry>>();
const radarKey = (projectId: string, mode: RadarMode) => JSON.stringify([projectId, mode]);
export async function buildLiveWorkspaceRadar(store: Store, projectId: string, options: Options = {}): Promise<LiveWorkspaceRadar> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const root = boundProjectRoot(store, projectId);
  const key = radarKey(projectId, options.mode ?? 'worktree');
  const gitDirectory = await workspaceGitDirectory(root);
  if (!gitDirectory) {
    radarCache.get(store)?.delete(key);
    return {project_id: projectId, workspace_path: root, is_git: false, branch: null, head_sha: null,
      mode: options.mode ?? 'worktree', base_ref: 'EMPTY', target_ref: options.mode === 'commit' ? 'EMPTY' : 'WORKTREE',
      fingerprint: '', computed_ms: elapsed(), cache_hit: false, recent_commits: [], changed_files: [], impact: emptyImpact()};
  }
  const state = await comparison(root, gitDirectory, options);
  const {head, branch, mode, base, target, fingerprint, changes} = state;
  const cache = radarCache.get(store) ?? new Map<string, RadarCacheEntry>();
  radarCache.set(store, cache);
  const prior = cache.get(key)?.radar;
  if (prior?.workspace_path === root && options.previousFingerprint === fingerprint && prior.fingerprint === fingerprint && prior.head_sha === head && prior.branch === branch) {
    const files = new Set(prior.impact.scope_files);
    const currentImpact = files.size ? {...prior.impact, ...impactMetadata(store, store.get<Project>('project', projectId), files)} : prior.impact;
    const radar = {...prior, impact: currentImpact, cache_hit: true, computed_ms: elapsed()};
    cache.set(key, {radar, state});
    return radar;
  }
  const [indexes, recent_commits] = await Promise.all([
    changes.length ? liveIndexes(root, state) : undefined, recentCommits(root, head ?? 'EMPTY'),
  ]);
  const radar: LiveWorkspaceRadar = {
    project_id: projectId, workspace_path: root, is_git: true, branch, head_sha: head, mode,
    base_ref: base, target_ref: target, fingerprint, cache_hit: false, recent_commits,
    changed_files: changes.map(({stamp, size, ...file}) => indexes?.binaryFiles.has(file.path) ? {...file, binary: true} : file),
    impact: emptyImpact(), computed_ms: 0,
  };
  if (indexes) {
    const {beforeIndex, afterIndex, afterSources, changedPaths} = indexes;
    const beforeSources = new Map<string, string>();
    const entries = await tree(root, base);
    for await (const [file, bytes] of blobs(root, entries, changedPaths.filter(supportsSourceFile))) {
      const text = sourceText(bytes);
      if (text !== undefined) beforeSources.set(file, text);
    }
    radar.structure_diff = computeStructureDiff(beforeIndex, afterIndex, [], changedPaths);
    radar.ast_call_graph = computeAstCallGraphDiff({beforeIndex, afterIndex, beforeSnapshotId: base, afterSnapshotId: target,
      changedFiles: changedPaths, beforeSources, afterSources});
    radar.impact = impact(store, store.get<Project>('project', projectId), afterIndex, new Set(changes.map(c => c.path)));
  }
  radar.computed_ms = elapsed();
  cache.set(key, {radar, state});
  return radar;
}

export async function liveWorkspaceImpact(store: Store, project: Project, files: string[]) {
  for (const file of files) if (!allowedPath(file)) throw Error('文件不在工程源码范围内');
  const root = boundProjectRoot(store, project.project_id);
  if (!files.length) return emptyImpact();
  const gitDirectory = await workspaceGitDirectory(root);
  if (!gitDirectory) return emptyImpact();
  const {afterIndex} = await liveIndexes(root, await comparison(root, gitDirectory, {}));
  return impact(store, project, afterIndex, new Set(files));
}

export async function readLiveFileDiff(store: Store, projectId: string, options: FileDiffOptions): Promise<LiveFileDiff> {
  const {base_ref, target_ref, path: file, fingerprint} = options;
  validateRef(base_ref); validateRef(target_ref);
  if (!allowedPath(file)) throw Error('文件不在工程源码范围内');
  const root = boundProjectRoot(store, projectId);
  let scannedBase = base_ref;
  let change: Change | undefined;
  if (target_ref === 'WORKTREE' && fingerprint !== undefined) {
    const scan = radarCache.get(store)?.get(radarKey(projectId, 'worktree'));
    if (!scan || scan.state.fingerprint !== fingerprint || scan.radar.workspace_path !== root) {
      throw Error('雷达快照已过期，请刷新变更雷达');
    }
    scannedBase = scan.state.base;
    if (base_ref !== 'HEAD' && base_ref !== scannedBase) throw Error('雷达快照已过期，请刷新变更雷达');
    change = scan.state.changes.find(c => c.path === file);
    if (!change) {
      const [head, status] = await Promise.all([
        gitOptional(root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'),
        git(root, '--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', file),
      ]);
      if ((head?.trim() ?? 'EMPTY') !== scannedBase || status) throw Error(worktreeChangedMessage);
    }
  }
  async function read(ref: string) {
    if (ref === 'WORKTREE') return worktreePreview(root, file, change);
    if (ref === 'EMPTY') return Buffer.alloc(0);
    const oid = await gitOptional(root, 'rev-parse', '--verify', '--quiet', ref + '^{commit}');
    if (!oid && ref === 'HEAD') return Buffer.alloc(0);
    if (!oid) throw Error('Git 提交不存在');
    return blobPreview(root, file, await tree(root, oid.trim()));
  }
  const [old, next] = await Promise.all([read(scannedBase), read(target_ref)]);
  const truncated = old.length > previewLimit || next.length > previewLimit;
  if (old.includes(0) || next.includes(0)) return {path: file, before: '', after: '', truncated, binary: true};
  const preview = (bytes: Buffer) => new TextDecoder().decode(bytes.subarray(0, previewLimit), {stream: bytes.length > previewLimit});
  return {path: file, before: preview(old), after: preview(next), truncated};
}

export async function openLiveWorkspaceFile(store: Store, projectId: string, filePath: string, line: number | undefined,
    editor: SourceEditor, openPath: (file: string) => Promise<string>) {
  if (!allowedPath(filePath)) throw Error('文件不在工程源码范围内');
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw Error('无效源码行号');
  const root = boundProjectRoot(store, projectId);
  if (!await worktreeDirectories(root)(path.posix.dirname(filePath))) throw Error('文件不在工程源码范围内');
  if (await gitOptional(root, 'check-ignore', '-q', '--', filePath) !== null) throw Error('文件被 Git 忽略');
  const file = await safeFile(root, filePath);
  return openSourceInEditor(file, line, editor, openPath);
}
