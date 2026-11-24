import { isUtf8 } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { moduleReferencePaths, normalizeBranchKey, type ArchitectureDocument, type UpdateRunRecord } from '../architecture-workspace';
import type { Snapshot } from '../shared';
import { git } from './live-radar-git';
import { inside, safeFile, sha, workspaceGitDirectory, workspacePaths } from './snapshot';

type DetectionSummary = UpdateRunRecord['detection_summary'];
export type ArchitectureChangedFile = DetectionSummary['changed_files'][number] & { rename_confidence?: 'exact' | 'uncertain' };
type ChangeSource = ArchitectureChangedFile['source'];
export interface ArchitectureDetection {
  detection_summary: DetectionSummary & { changed_files: ArchitectureChangedFile[] };
  live_hashes: Record<string, string>;
  live_workspace_fingerprint: string;
  live_git: Awaited<ReturnType<typeof detectWorkspaceGitState>>;
  has_changes: boolean;
  rename_details: Array<{ old_path: string; path: string; rename_confidence: 'exact' | 'uncertain' }>;
}

export function workspaceBranchKey(branch?: string | null, commit?: string | null) {
  return normalizeBranchKey(branch ?? (commit ? 'HEAD:' + commit : undefined));
}

const nonGitState = { isGit: false, branch: undefined, branchKey: workspaceBranchKey(), commit: undefined, dirty: false };
export async function detectWorkspaceGitState(rootPath: string) {
  if (!await workspaceGitDirectory(rootPath)) return nonGitState;
  const status = await git(rootPath, 'status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind',
    '--no-renames', '--untracked-files=normal', '--', '.');
  const rows = status.split('\0');
  const oid = rows.find(row => row.startsWith('# branch.oid '))?.slice(13);
  const name = rows.find(row => row.startsWith('# branch.head '))?.slice(14);
  if (!oid || !name) throw Error('无法读取 Git 工作区标识');
  const commit = oid === '(initial)' ? undefined : oid;
  const branch = name === '(detached)' ? undefined : name;
  return { isGit: true, branch, branchKey: workspaceBranchKey(branch, commit), commit, dirty: rows.some(row => row && !row.startsWith('#')) };
}

const excluded = /(?:^|\/)(?:logs?|caches?|\.cache|\.[^/]*[_-]cache|\.gradle|\.turbo|coverage|target|out)(?:\/|$)|\.log(?:\.\d+)?$/i;
const rules = /^(?:AGENTS\.md|CLAUDE\.md|\.eslintrc.*)$/i;
const config = /^(?:CMakeLists\.txt|Makefile|GNUmakefile|Dockerfile|go\.mod|go\.sum|Cargo\.lock|.*\.(?:proto|graphql|gql|openapi|json|ya?ml|toml|cmake|mk|gradle|csproj|sln|xml))$/i;
const code = /\.(?:[cm]?[jt]sx?|c|h|cc|cpp|cxx|hh|hpp|hxx|inl|inc|pyi?|java|go|rs|cs|kt|kts|swift|m|mm|rb|php|scala|sh|ps1|sql|lua|vue|svelte|html?|css|scss|less|v|sv|vhd|asm|s|r|dart|ex|exs|zig|sol)$/i;
export function architectureBoundPaths(doc?: ArchitectureDocument) {
  const bindings = doc?.modules.map(moduleReferencePaths) ?? [];
  const files = new Set([...bindings.flatMap(ref => ref.files), ...(doc?.relations.flatMap(rel => rel.evidence.map(ev => ev.path)) ?? [])]);
  const directories = new Set(bindings.flatMap(ref => ref.directories));
  return { files, directories };
}
function fileClassifier(doc?: ArchitectureDocument) {
  const { files, directories } = architectureBoundPaths(doc);
  return (file: string): ArchitectureChangedFile['category'] | undefined => {
    const name = path.posix.basename(file);
    if (excluded.test(file)) return;
    if (rules.test(name)) return 'rule';
    if (config.test(name)) return 'config_or_contract';
    if (code.test(name) || files.has(file) || directories.has('.')) return 'code';
    for (const dir of directories) if (file.startsWith(dir.replace(/\/$/, '') + '/')) return 'code';
  };
}

function manifest(entries: [string, string][]) {
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { file_hashes: Object.fromEntries(entries), workspace_fingerprint: sha(JSON.stringify(entries)) };
}

export function frozenManifest(snapshot: Snapshot, doc?: ArchitectureDocument) {
  const category = fileClassifier(doc);
  return manifest(snapshot.files.filter(file => category(file.path)).map(file => [file.path, file.content_sha256]));
}

export async function collectInScopeFileHashes(rootPath: string, snapshot?: Snapshot, strictGit = false, doc?: ArchitectureDocument) {
  if (snapshot) return frozenManifest(snapshot, doc);
  const category = fileClassifier(doc);
  const entries: [string, string][] = [];
  try {
    for await (const file of workspacePaths(rootPath, file => !excluded.test(file), strictGit)) {
      if (!category(file)) continue;
      const input = await safeFile(rootPath, file);
      if ((await fs.stat(input)).size > 2 * 1024 * 1024) continue;
      const bytes = await fs.readFile(input);
      if (!bytes.includes(0) && isUtf8(bytes)) entries.push([file, sha(bytes)]);
    }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT' && failure.path && path.isAbsolute(failure.path) &&
      inside(rootPath, failure.path) && path.relative(rootPath, failure.path)) throw Error(unstableScan);
    throw error;
  }
  return manifest(entries);
}

async function gitSources(root: string, base: string | undefined, head: string | undefined) {
  const sources = new Map<string, ChangeSource>(), renames = new Map<string, string>();
  const diff = (...refs: string[]) => git(root, 'diff', '--relative', '--no-ext-diff', '--name-status', '-z', '-M', ...refs, '--', '.');
  if (base && !/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(base)) throw Error('无效的架构基线 Git 提交标识');
  const [committed, staged, unstaged, untracked] = await Promise.all([
    base && head && base !== head ? diff(base, head) : '', diff('--cached'), diff(),
    git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.'),
  ]);
  for (const [source, output] of [['committed', committed], ['staged', staged], ['unstaged', unstaged]] as const) {
    const fields = output.split('\0');
    for (let i = 0; i < fields.length - 1;) {
      const status = fields[i++], file = fields[i++];
      sources.set(file, source);
      if (status.startsWith('R') || status.startsWith('C')) {
        const next = fields[i++];
        sources.set(next, source);
        if (status.startsWith('R')) renames.set(next, file);
      }
    }
  }
  for (const file of untracked.split('\0')) if (file) sources.set(file, 'untracked');
  return { sources, renames };
}

// Require a distinctive common stem before suggesting a path-only rename for review.
function similarPath(old: string, next: string) {
  const a = path.posix.parse(old), b = path.posix.parse(next);
  if (a.base === b.base) return true;
  if (a.ext !== b.ext) return false;
  const first = a.name.toLowerCase(), second = b.name.toLowerCase();
  let prefix = 0, suffix = 0;
  const length = Math.min(first.length, second.length);
  while (prefix < length && first[prefix] === second[prefix]) prefix++;
  while (prefix + suffix < length && first.at(-suffix-1) === second.at(-suffix-1)) suffix++;
  return prefix + suffix >= 4 && (prefix + suffix) / Math.max(first.length, second.length) >= 0.6;
}

const unstableScan = '扫描期间工作区文件发生变化，请重新检查';
export async function detectArchitectureChanges(rootPath: string, doc: ArchitectureDocument): Promise<ArchitectureDetection> {
  let live_git: ArchitectureDetection['live_git'] = nonGitState;
  let live_hashes: Record<string, string> = {}, live_workspace_fingerprint = '';
  const base = doc.baseline;
  const summary = { base_branch: base?.branch, base_commit: base?.commit };
  try {
    live_git = await detectWorkspaceGitState(rootPath);
    const scan = () => collectInScopeFileHashes(rootPath, undefined, live_git.isGit, doc);
    const live = await scan();
    live_hashes = live.file_hashes;
    live_workspace_fingerprint = live.workspace_fingerprint;
    const { sources, renames } = live_git.isGit ? await gitSources(rootPath, base?.commit, live_git.commit)
      : { sources: new Map<string, ChangeSource>(), renames: new Map<string, string>() };
    if ((await scan()).workspace_fingerprint !== live_workspace_fingerprint) throw Error(unstableScan);
    const after = await detectWorkspaceGitState(rootPath);
    if (after.isGit !== live_git.isGit || after.branchKey !== live_git.branchKey || after.commit !== live_git.commit || after.dirty !== live_git.dirty)
      throw Error('变更检测期间 Git 工作区状态发生变化，请重新检查');
    const before = base?.file_hashes ?? {};
    const category = fileClassifier(doc);
    const changes = new Map<string, ArchitectureChangedFile>();
    for (const file of new Set([...Object.keys(before), ...Object.keys(live_hashes)])) {
      const kind = category(file);
      if (!kind || before[file] === live_hashes[file]) continue;
      const status = !Object.hasOwn(before, file) ? 'added' : !Object.hasOwn(live_hashes, file) ? 'deleted' : 'modified';
      changes.set(file, { path: file, status, category: kind, source: sources.get(file) ?? 'snapshot_diff' });
    }
    const removed = [...changes.values()].filter(f => f.status === 'deleted').map(f => f.path);
    const added = [...changes.values()].filter(f => f.status === 'added');
    const rename_details: ArchitectureDetection['rename_details'] = [];
    function pair(add: ArchitectureChangedFile, old: string, confidence: 'exact' | 'uncertain') {
      changes.delete(old);
      Object.assign(add, { status: 'renamed', old_path: old, rename_confidence: confidence });
      rename_details.push({ path: add.path, old_path: old, rename_confidence: confidence });
    }
    function byHash<T>(files: T[], hash: (file: T) => string) {
      const groups = new Map<string, T[]>();
      for (const file of files) {
        const key = hash(file), group = groups.get(key);
        if (group) group.push(file); else groups.set(key, [file]);
      }
      return groups;
    }
    const deletedByHash = byHash(removed, file => before[file]);
    const addedByHash = byHash(added, file => live_hashes[file.path]);
    for (const [hash, files] of addedByHash) {
      const matches = deletedByHash.get(hash);
      if (files.length === 1 && matches?.length === 1) pair(files[0], matches[0], 'exact');
    }
    for (const add of added.filter(f => f.status === 'added')) {
      const fromGit = renames.get(add.path);
      if (fromGit && changes.get(fromGit)?.status === 'deleted') { pair(add, fromGit, 'uncertain'); continue; }
      const candidates = removed.filter(old => changes.has(old) && similarPath(old, add.path));
      if (candidates.length === 1 && added.filter(f => f.status === 'added' && similarPath(candidates[0], f.path)).length === 1)
        pair(add, candidates[0], 'uncertain');
    }
    const changed_files = [...changes.values()].sort((a,b) => a.path.localeCompare(b.path));
    // Earlier ARC baselines included all UTF-8 text, including out-of-scope documentation.
    const comparableFingerprint = Object.keys(before).some(file => !category(file))
      ? manifest(Object.entries(before).filter(([file]) => category(file))).workspace_fingerprint : base?.workspace_fingerprint;
    return { detection_summary: { ...summary, git_branch: live_git.branch, git_commit: live_git.commit, changed_files, detection_reliable: true },
      live_git, live_hashes, live_workspace_fingerprint, rename_details,
      has_changes: !base || changed_files.length > 0 || comparableFingerprint !== live_workspace_fingerprint || doc.branch_key !== live_git.branchKey };
  } catch (error) {
    return { detection_summary: { ...summary, git_branch: live_git.branch, git_commit: live_git.commit,
      changed_files: [], detection_reliable: false, detection_error: error instanceof Error ? error.message : String(error) },
      live_git, live_hashes, live_workspace_fingerprint, has_changes: true, rename_details: [] };
  }
}
