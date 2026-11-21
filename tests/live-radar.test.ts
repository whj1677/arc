import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import Parser from 'web-tree-sitter';
import { assembleCodeIndex, parseSourceUnit } from '../src/main/code-index';
import { locate } from '../src/main/executables';
import { buildLiveWorkspaceRadar, readLiveFileDiff } from '../src/main/live-radar';
import { previewLimit } from '../src/main/live-radar-git';
import { snapshotPreview } from '../src/main/live-radar-snapshot';
import { ArcMcpBridge, bridgeTools } from '../src/main/mcp-bridge';
import { ArcService } from '../src/main/service';
import { sha } from '../src/main/snapshot';
import type { Snapshot } from '../src/shared';

const exec = promisify(execFile);
const original = 'export function submit(value: string) { return value; }\n';
const revised = 'export function submit(value: number, strict: boolean) { return strict ? value : 0; }\n';
const consumer = 'import {submit} from "./api";\nexport function consume() { return submit("42"); }\n';

test('a cached caller can resolve a new target without changing previous indexes or parsed units', async () => {
  const client = await parseSourceUnit('consumer.ts', consumer);
  const api = await parseSourceUnit('api.ts', original);
  const before = assembleCodeIndex([client], 'before', 'before');
  const after = assembleCodeIndex([client, api], 'after', 'after');
  const removed = assembleCodeIndex([client], 'removed', 'removed');
  assert.deepEqual(after.calls[0].target_ids, [api.symbols[0].id]);
  assert.deepEqual(before.calls[0].target_ids, []);
  assert.deepEqual(removed.calls[0].target_ids, []);
  assert.deepEqual(client.calls[0].target_ids, []);
});

async function fixture(t: TestContext, initial = true, layout: 'git' | 'nested' | 'plain' = 'git') {
  const temporary = path.resolve('.test-data');
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, 'live-radar-'));
  const root = path.join(directory, '工作区 with spaces');
  const arc = new ArcService(path.join(directory, 'data'), process.cwd());
  t.after(async () => {
    await arc.shutdown();
    arc.store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repo = layout === 'nested' ? path.join(root, 'sub') : root;
  await fs.mkdir(repo, {recursive: true});
  if (layout !== 'git') {
    // Keep Git discovery from crossing the fixture boundary into the ARC checkout.
    const previous = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = directory;
    t.after(() => {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previous;
    });
  }
  const program = await locate('git');
  const git = async (...args: string[]) => (await exec(program, ['-C', repo, ...args], { windowsHide: true })).stdout.trim();
  const write = async (file: string, content: string | Buffer) => {
    const destination = path.join(repo, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  };
  async function record(subject: string, parent?: string) {
    await git('add', '-A');
    const tree = await git('write-tree');
    const revision = await git('-c', 'user.name=ARC tests', '-c', 'user.email=arc@example.invalid',
      'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', subject);
    await git('update-ref', 'HEAD', revision);
    return revision;
  }
  if (layout !== 'plain') {
    await git('init', '-b', 'radar');
    await git('config', 'core.autocrlf', 'false');
  }
  let head = '';
  if (initial) {
    await write('api.ts', original);
    await write('consumer.ts', consumer);
    await write('old.ts', 'export function obsolete() {}\n');
    await write('.gitignore', 'ignore-me.ts\n');
    if (layout !== 'plain') head = await record('Initial API');
  }
  const project = await arc.openProject(root);
  const radar = (options?: Parameters<typeof arc.liveRadar>[1]) => arc.liveRadar(project.project_id, options);
  const diff = (file: string, base_ref = 'HEAD', target_ref = 'WORKTREE') =>
    arc.liveFileDiff(project.project_id, { path: file, base_ref, target_ref });
  return { root, arc, project, write, git, record, head, radar, diff };
}

test('worktree radar includes staged, unstaged and new paths and reports unchanged callers', async t => {
  const { root, project, arc, git, write, head, radar } = await fixture(t);
  const clean = await radar();
  assert.equal(clean.is_git, true);
  assert.equal(clean.project_id, project.project_id);
  assert.equal(clean.head_sha, head);
  assert.equal(clean.branch, 'radar');
  assert.equal(clean.mode, 'worktree');
  assert.equal(clean.target_ref, 'WORKTREE');
  assert.deepEqual(clean.recent_commits.map(c => [c.sha, c.subject]), [[head, 'Initial API']]);
  assert.ok(head.startsWith(clean.recent_commits[0].short_sha));
  assert.ok(Number.isFinite(Date.parse(clean.recent_commits[0].authored_at)));
  assert.deepEqual(clean.changed_files, []);

  await write('api.ts', revised);
  await git('add', 'api.ts');
  await write('api.ts', revised + '// local\n');
  await write('new feature.ts', 'export function enabled() { return true; }\n');
  await fs.unlink(path.join(root, 'old.ts'));
  await write('ignore-me.ts', 'untracked and gitignored');
  await write('node_modules/generated.ts', 'excluded by Arc');
  await write('output/CMakeCache.txt', '# generated build directory');
  await write('output/generated.ts', 'excluded by Arc');
  const snapshots = arc.store.all('snapshot').length;
  const dirty = await radar({ previousFingerprint: clean.fingerprint });
  assert.equal(dirty.cache_hit, false);
  const changed = new Map(dirty.changed_files.map(f => [f.path, f]));
  assert.deepEqual([...changed].map(([file, row]) => [file, row.status]).sort(), [
    ['api.ts', 'modified'], ['new feature.ts', 'added'], ['old.ts', 'removed'],
  ]);
  assert.equal(changed.get('api.ts')?.staged, true);
  assert.equal(changed.get('api.ts')?.unstaged, true);
  assert.equal(dirty.impact.scope_declared, false);
  assert.deepEqual([...dirty.impact.scope_files].sort(), [...changed.keys()].sort());
  const structure = dirty.structure_diff!;
  assert.deepEqual(structure.added_symbols.map(s => s.symbol), ['enabled']);
  assert.deepEqual(structure.removed_symbols.map(s => s.symbol), ['obsolete']);
  assert.deepEqual(structure.signature_changed_symbols[0]?.unupdated_external_callers?.map(c => c.caller_file), ['consumer.ts']);
  assert.ok(dirty.ast_call_graph?.path.edges.some(e => e.after_label === '未同步调用'));
  assert.equal(arc.store.all('snapshot').length, snapshots);
  assert.deepEqual(arc.store.all('engineering_task'), []);
  assert.deepEqual(arc.store.all('run'), []);
});

test('successive polls skip parsing on a fingerprint hit and parse only the edited unit on a miss', async t => {
  const { arc, project, write, radar } = await fixture(t);
  await write('api.ts', revised);
  await write('pending.ts', 'export function pending() { return submit(1, true); }\n');
  const warm = await radar();
  assert.deepEqual(warm.impact.related_constraints, []);
  arc.store.put('engineering_context', 'poll-rule', {
    entry_id: 'poll-rule', key: 'Public API', category: 'rule', text: 'Preserve the public API',
    project_id: project.project_id, status: 'current', sources: [{ path: 'api.ts' }],
  });
  // web-tree-sitter allocates one native Parser per parsed file. Count allocations
  // after warm-up so slow Git subprocess startup on Windows cannot mask a regression.
  const parses = t.mock.method(Parser.prototype as Parser & { initialize(): void }, 'initialize');
  const hit = await radar({ previousFingerprint: warm.fingerprint });
  assert.equal(hit.cache_hit, true);
  assert.equal(hit.fingerprint, warm.fingerprint);
  assert.equal(parses.mock.callCount(), 0);
  assert.deepEqual(hit.impact.related_constraints.map(rule => rule.entry_id), ['poll-rule']);
  assert.equal(hit.impact.external_callers, warm.impact.external_callers);
  assert.equal(hit.structure_diff, warm.structure_diff);
  await write('api.ts', 'export function submit() { return 100; }\n');
  const next = await radar({ previousFingerprint: warm.fingerprint });
  assert.equal(next.cache_hit, false);
  assert.notEqual(next.fingerprint, warm.fingerprint);
  assert.equal(parses.mock.callCount(), 1);
  assert.deepEqual(next.structure_diff!.added_symbols.map(s => s.symbol), ['pending']);
  assert.match(next.structure_diff!.signature_changed_symbols[0].after_signature!, /submit\(\)/);
  t.diagnostic(`Warm poll ${hit.computed_ms} ms; second edit ${next.computed_ms} ms, one parse`);
});

test('a cold, clean radar never parses the base source tree', async t => {
  const { radar } = await fixture(t);
  const parses = t.mock.method(Parser.prototype as Parser & { initialize(): void }, 'initialize');
  const clean = await radar();
  assert.equal(parses.mock.callCount(), 0);
  assert.equal(clean.structure_diff, undefined);
  assert.equal(clean.ast_call_graph, undefined);
  assert.deepEqual(clean.impact.scope_files, []);
  assert.deepEqual(clean.recent_commits.map(c => c.subject), ['Initial API']);
});

test('restored projects must be rebound before any live radar operation', async t => {
  const { arc, project, radar, diff, root } = await fixture(t);
  const projectId = project.project_id;
  arc.store.put('engineering_workspace', 'restored', {
    workspace_id: 'restored', project_id: projectId, root_path: root, status: 'unbound', created_at: project.created_at,
  });
  const unbound = /恢复的工程尚未重新绑定本机工作区/;
  await assert.rejects(radar(), unbound);
  await assert.rejects(arc.liveImpact(projectId, ['api.ts']), unbound);
  await assert.rejects(diff('api.ts'), unbound);
  await assert.rejects(arc.openLiveFile(projectId, 'api.ts', 1, 'default', async () => assert.fail('editor opened')), unbound);
});

test('a staged deletion leaves ignored on-disk bytes outside the radar', async t => {
  const { arc, project, head, git, write, radar } = await fixture(t);
  await write('.gitignore', 'ignore-me.ts\napi.ts\n');
  await write('api.ts', revised);
  await git('rm', '--cached', '--', 'api.ts');
  const scan = await radar();
  assert.equal(scan.changed_files.find(file => file.path === 'api.ts')?.status, 'removed');
  assert.deepEqual(scan.structure_diff?.removed_symbols.map(symbol => symbol.symbol), ['submit']);
  const diff = await arc.liveFileDiff(project.project_id, {
    base_ref: head, target_ref: 'WORKTREE', path: 'api.ts', fingerprint: scan.fingerprint,
  });
  assert.equal(diff.before, original);
  assert.equal(diff.after, '');
});

test('crossing the per-file AST limit preserves the file change without reporting symbol changes', async t => {
  const { head, write, record, radar } = await fixture(t);
  await write('api.ts', original + '/*' + 'x'.repeat(2 * 1024 * 1024) + '*/');
  const grown = await radar();
  assert.deepEqual(grown.changed_files.map(file => [file.path, file.status]), [['api.ts', 'modified']]);
  assert.deepEqual(grown.structure_diff?.removed_symbols, []);
  assert.deepEqual(grown.structure_diff?.changed_files, []);
  assert.equal(grown.ast_call_graph, undefined);
  await record('Store oversized API', head);
  await write('api.ts', revised);
  const shrunk = await radar();
  assert.deepEqual(shrunk.changed_files.map(file => [file.path, file.status]), [['api.ts', 'modified']]);
  assert.deepEqual(shrunk.structure_diff?.added_symbols, []);
  assert.equal(shrunk.ast_call_graph, undefined);
});

test('fingerprinted previews reject changed files, newly dirty callers and superseded scans', async t => {
  const { arc, project, write, radar, record, head } = await fixture(t);
  await write('api.ts', revised);
  const scan = await radar();
  const preview = (file: string) => arc.liveFileDiff(project.project_id, {
    base_ref: scan.base_ref, target_ref: scan.target_ref, path: file, fingerprint: scan.fingerprint,
  });
  assert.equal((await preview('api.ts')).after, revised);
  assert.equal((await preview('consumer.ts')).after, consumer);
  await write('api.ts', original);
  await assert.rejects(preview('api.ts'), /文件在本次雷达扫描后已修改/);
  await write('consumer.ts', consumer + '// edited\n');
  await assert.rejects(preview('consumer.ts'), /文件在本次雷达扫描后已修改/);
  await record('Commit caller edit', head);
  await assert.rejects(preview('consumer.ts'), /文件在本次雷达扫描后已修改/);
  await radar();
  await assert.rejects(preview('api.ts'), /雷达快照已过期/);
});

test('a non-Git project without a saved snapshot returns a clean empty radar', async t => {
  const { arc, project, radar } = await fixture(t, true, 'plain');
  arc.store.put('project', project.project_id, {...project, snapshot_id: undefined});
  const result = await radar();
  assert.equal(result.source, 'snapshot');
  assert.equal(result.is_git, false);
  assert.equal(result.head_sha, null);
  assert.deepEqual(result.changed_files, []);
  assert.deepEqual(result.recent_commits, []);
  assert.deepEqual(result.impact.scope_files, []);
});

test('a single child Git repository reports project-relative paths through radar, preview and open', async t => {
  const { root, arc, project, write, radar } = await fixture(t, true, 'nested');
  await fs.mkdir(path.join(root, '.tools-hidden'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await write('api.ts', revised);
  const scan = await radar({ focus_file: 'sub/api.ts' });
  assert.equal(scan.source, 'git');
  assert.equal(scan.is_git, true);
  assert.equal(scan.git_subpath, 'sub');
  assert.deepEqual(scan.changed_files.map(f => [f.path, f.is_source]), [['sub/api.ts', true]]);
  assert.deepEqual(scan.structure_diff?.signature_changed_symbols[0]?.unupdated_external_callers?.map(c => c.caller_file), ['sub/consumer.ts']);
  assert.deepEqual(scan.ast_call_graph?.path.participants.map(p => p.file).sort(), ['sub/api.ts', 'sub/consumer.ts']);
  assert.deepEqual(scan.impact.scope_files, ['sub/api.ts']);
  assert.deepEqual(scan.impact.external_callers.map(c => c.caller_file), ['sub/consumer.ts']);
  const pair = await arc.liveFileDiff(project.project_id, {
    base_ref: scan.base_ref, target_ref: scan.target_ref, path: 'sub/api.ts', fingerprint: scan.fingerprint,
  });
  assert.deepEqual([pair.path, pair.before, pair.after], ['sub/api.ts', original, revised]);
  await assert.rejects(arc.liveFileDiff(project.project_id, {base_ref: scan.base_ref, target_ref: 'WORKTREE', path: 'api.ts'}));
  const opened: string[] = [];
  const openPath = async (file: string) => { opened.push(file); return ''; };
  await arc.openLiveFile(project.project_id, 'sub/api.ts', 1, 'default', openPath);
  await write('ignore-me.ts', 'excluded');
  await assert.rejects(arc.openLiveFile(project.project_id, 'sub/ignore-me.ts', 1, 'default', openPath));
  assert.deepEqual(opened, [await fs.realpath(path.join(root, 'sub/api.ts'))]);
});

test('a visible source file beside a nested Git repository keeps the radar in snapshot mode', async t => {
  const { root, radar } = await fixture(t, true, 'nested');
  await fs.writeFile(path.join(root, 'main.c'), 'int main(void) { return 0; }\n');
  const scan = await radar();
  assert.equal(scan.source, 'snapshot');
  assert.equal(scan.is_git, false);
  assert.equal(scan.git_subpath, undefined);
  assert.deepEqual(scan.changed_files.map(f => [f.path, f.status]), [['main.c', 'added']]);
});

test('a non-Git radar compares frozen bytes with the live tree, including same-size edits', async t => {
  const { root, arc, project, write, radar } = await fixture(t, true, 'plain');
  const edited = original.replace('value: string', 'value: number');
  await write('api.ts', edited);
  await fs.unlink(path.join(root, 'old.ts'));
  await write('notes.txt', 'added');
  await write('.env', 'excluded');
  await write('generated/CMakeCache.txt', 'generated directory');
  await write('generated/api.ts', revised);
  const scan = await radar();
  assert.equal(scan.source, 'snapshot');
  assert.equal(scan.is_git, false);
  assert.equal(scan.snapshot_id, project.snapshot_id);
  assert.deepEqual([scan.base_ref, scan.target_ref], ['SNAPSHOT', 'WORKTREE']);
  assert.deepEqual(scan.changed_files.map(f => [f.path, f.status, f.is_source]), [
    ['api.ts', 'modified', true], ['notes.txt', 'added', false], ['old.ts', 'removed', true],
  ]);
  assert.deepEqual(scan.structure_diff?.removed_symbols.map(s => s.symbol), ['obsolete']);
  assert.deepEqual(scan.structure_diff?.signature_changed_symbols.map(s => s.symbol), ['submit']);
  assert.ok(scan.ast_call_graph?.path.participants.some(p => p.file === 'consumer.ts'));
  assert.deepEqual(scan.impact.external_callers.map(c => c.caller_file), ['consumer.ts']);
  const preview = (file: string) => readLiveFileDiff(arc.store, arc.directory, project.project_id, {
    path: file, base_ref: 'SNAPSHOT', target_ref: 'WORKTREE', fingerprint: scan.fingerprint,
  });
  const pair = await preview('api.ts');
  assert.deepEqual([pair.before, pair.after], [original, edited]);
  assert.equal((await preview('old.ts')).after, '');
  assert.equal((await preview('notes.txt')).before, '');
  const opened: string[] = [];
  const openPath = async (file: string) => { opened.push(file); return ''; };
  await arc.openLiveFile(project.project_id, 'api.ts', 1, 'default', openPath);
  await assert.rejects(arc.openLiveFile(project.project_id, 'generated/api.ts', 1, 'default', openPath));
  assert.deepEqual(opened, [await fs.realpath(path.join(root, 'api.ts'))]);
});

test('a snapshot preview rejects corruption beyond the preview cap', async t => {
  const temporary = path.resolve('.test-data');
  await fs.mkdir(temporary, { recursive: true });
  const storage = await fs.mkdtemp(path.join(temporary, 'snapshot-preview-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const file = 'large.txt';
  const bytes = Buffer.alloc(previewLimit + 2, 'a');
  const snapshot: Snapshot = {
    source_snapshot_id: 'source-test', project_id: 'test', captured_at: '', root_path: storage,
    files: [{ path: file, bytes: bytes.length, content_sha256: sha(bytes), line_count: 1, encoding: 'utf-8' }],
    excluded: [], fingerprint: '', commit: null, dirty: null, build_config: '', consistency: 'verified',
  };
  const directory = path.join(storage, 'snapshots', snapshot.source_snapshot_id);
  await fs.mkdir(directory, { recursive: true });
  const blob = path.join(directory, file);
  await fs.writeFile(blob, bytes);
  assert.deepEqual(await snapshotPreview(storage, snapshot, file), bytes.subarray(0, previewLimit + 1));
  bytes[previewLimit + 1] = 0x62;
  await fs.writeFile(blob, bytes);
  assert.deepEqual(await snapshotPreview(storage, snapshot, file), { missing: true });
});

test('a cold scan with only a documentation edit returns project impact without parsing source', async t => {
  const { arc, project, write, radar } = await fixture(t);
  arc.store.put('engineering_context', 'docs', {
    entry_id: 'docs', key: 'Docs', category: 'rule', text: 'Keep documentation current',
    project_id: project.project_id, status: 'current', sources: [{ path: 'README.md' }],
  });
  await write('README.md', '# Instructions');
  await parseSourceUnit('warm.c', '');
  const initializes = t.mock.method(Parser.prototype as Parser & { initialize(): void }, 'initialize');
  const scan = await radar({ focus_file: 'README.md' });
  assert.equal(scan.focus_file, 'README.md');
  assert.equal(initializes.mock.callCount(), 0);
  assert.deepEqual(scan.changed_files.map(f => [f.path, f.is_source]), [['README.md', false]]);
  assert.equal(scan.structure_diff, undefined);
  assert.equal(scan.ast_call_graph, undefined);
  assert.deepEqual(scan.impact.related_constraints.map(c => c.entry_id), ['docs']);
});

test('a C baseline parses an ambiguous header once and changes grammar only when C++ is introduced', async t => {
  const { write, radar, record } = await fixture(t, false);
  const header = 'int read_value(void);\n';
  await write('value.h', header);
  await write('value.c', 'int read_value(void) { return 1; }\n');
  await record('Initial C sources');
  await write('value.c', 'int read_value(void) { return 2; }\n');
  await parseSourceUnit('warm.c', '');
  const initializes = t.mock.method(Parser.prototype as Parser & { initialize(): void }, 'initialize');
  const initial = await radar();
  assert.equal(initializes.mock.callCount(), 3);
  await write('first.cpp', 'int first() { return 1; }\n');
  const withCpp = await radar({ previousFingerprint: initial.fingerprint });
  assert.ok(withCpp.structure_diff?.added_symbols.some(s => s.symbol === 'first'));
  assert.equal(initializes.mock.callCount(), 5);
});

test('changing focus on the same fingerprint scopes the call graph and reuses both indexes', async t => {
  const { write, radar } = await fixture(t);
  await write('api.ts', revised);
  await write('other.ts', 'export function other() { return 7; }\n');
  const full = await radar();
  const initializes = t.mock.method(Parser.prototype as Parser & { initialize(): void }, 'initialize');
  for (const file of ['other.ts', 'api.ts']) {
    const scan = await radar({ previousFingerprint: full.fingerprint, focus_file: file });
    assert.equal(scan.focus_file, file);
    assert.equal(scan.fingerprint, full.fingerprint);
    assert.deepEqual(scan.changed_files, full.changed_files);
    assert.deepEqual(scan.structure_diff, full.structure_diff);
    assert.deepEqual(scan.ast_call_graph?.path.participants.filter(p => p.code_changed).map(p => p.file), [file]);
  }
  assert.equal(initializes.mock.callCount(), 0);
  await assert.rejects(radar({ focus_file: '../outside.ts' }));
});

test('API focus keeps a caller updated in the same diff out of contract risks', async t => {
  const { write, radar, record } = await fixture(t, false);
  await write('api.ts', original);
  await write('caller.ts', consumer);
  await record('Initial API and caller');
  await write('api.ts', revised);
  await write('caller.ts', consumer.replace('submit("42")', 'submit(42, true)'));

  const scan = await radar({ focus_file: 'api.ts' });
  assert.equal(scan.focus_file, 'api.ts');
  assert.deepEqual(scan.structure_diff?.signature_changed_symbols[0]?.unupdated_external_callers, []);
  const graph = scan.ast_call_graph!.path;
  const caller = graph.participants.find(p => p.file === 'caller.ts')!;
  assert.equal(caller.code_changed, true);
  assert.equal(graph.edges.find(edge => edge.from_key === caller.key)?.after_label, '跨文件调用');
});

test('commit mode handles unborn history, the root tree and a selected commit independent of live bytes', async t => {
  const { write, radar, record, diff } = await fixture(t, false);
  await write('api.ts', original);
  const unborn = await radar();
  assert.equal(unborn.head_sha, null);
  assert.deepEqual(unborn.recent_commits, []);
  assert.deepEqual(unborn.changed_files.map(f => [f.path, f.status]), [['api.ts', 'added']]);
  const first = await record('Initial API');
  await write('api.ts', revised);
  const second = await record('Change type', first);
  await write('api.ts', '// dirty live edit, absent from both commits\n');
  const root = await radar({ mode: 'commit', commit: first });
  assert.equal(root.base_ref, 'EMPTY');
  assert.equal(root.target_ref, first);
  assert.deepEqual(root.changed_files.map(f => f.status), ['added']);
  assert.deepEqual(root.structure_diff?.added_symbols.map(s => s.symbol), ['submit']);
  const selected = await radar({ mode: 'commit', commit: 'HEAD' });
  assert.deepEqual(selected.changed_files.map(f => [f.path, f.status]), [['api.ts', 'modified']]);
  const pair = await diff('api.ts', selected.base_ref, selected.target_ref);
  assert.equal(pair.before, original);
  assert.equal(pair.after, revised);
  assert.equal((await diff('api.ts', second.slice(0, 12) + '~1', second)).before, original);
  assert.deepEqual(selected.recent_commits.map(c => c.sha), [second, first]);
  assert.match(selected.structure_diff!.signature_changed_symbols[0].after_signature!, /strict: boolean/);
});

test('file diff reads added, deleted, binary and bounded text and rejects invalid paths and refs', async t => {
  const { root, arc, project, write, diff, record, head } = await fixture(t);
  await write('added.txt', 'new text');
  assert.equal((await diff('added.txt')).before, '');
  assert.equal((await diff('added.txt')).after, 'new text');
  await fs.unlink(path.join(root, 'api.ts'));
  const removed = await diff('api.ts', head);
  assert.equal(removed.before, original);
  assert.equal(removed.after, '');
  await write('sample.bin', Buffer.from([65, 0, 66]));
  assert.equal((await diff('sample.bin', 'EMPTY')).binary, true);
  await write('large.txt', 'x'.repeat(300_000));
  const large = await diff('large.txt');
  assert.equal(large.truncated, true);
  assert.ok(large.after.length > 0 && large.after.length <= 205_000);
  const historical = await record('Store large text and binary', head);
  const committed = await diff('large.txt', 'EMPTY', historical);
  assert.equal(committed.truncated, true);
  assert.equal(committed.after, large.after);
  assert.equal((await diff('sample.bin', 'EMPTY', historical)).binary, true);
  await assert.rejects(diff('api.ts', '--all'));
  await assert.rejects(diff('api.ts', head, 'refs/heads/radar'));
  await assert.rejects(diff('../data/arc.sqlite'));
  await write('.env', 'fixture=excluded');
  await assert.rejects(diff('.env'));
  await write('ignore-me.ts', 'excluded by git');
  await assert.rejects(diff('ignore-me.ts'));
  await write('README', 'live source');
  const opened: string[] = [];
  const openPath = async (file: string) => { opened.push(file); return ''; };
  await arc.openLiveFile(project.project_id, 'README', 1, 'default', openPath);
  assert.deepEqual(opened, [await fs.realpath(path.join(root, 'README'))]);
  await assert.rejects(arc.openLiveFile(project.project_id, '../data/arc.sqlite', undefined, 'default', openPath));
  await assert.rejects(arc.openLiveFile(project.project_id, 'ignore-me.ts', undefined, 'default', openPath), /文件被 Git 忽略/);
  await write('generated/CMakeCache.txt', '# generated build directory');
  await write('generated/api.ts', original);
  await assert.rejects(arc.openLiveFile(project.project_id, 'generated/api.ts', undefined, 'default', openPath), /文件不在工程源码范围内/);
  assert.equal(opened.length, 1);
});

test('a project opened inside a larger repository has project-relative paths in both modes', async t => {
  const { root, arc, write, head, record } = await fixture(t);
  await write('component/api.ts', original);
  const first = await record('Add nested project', head);
  const nested = await arc.openProject(path.join(root, 'component'));
  await write('component/api.ts', revised);
  await write('private.ts', 'export function unrelated() {}');
  const local = await buildLiveWorkspaceRadar(arc.store, arc.directory, nested.project_id);
  assert.deepEqual(local.changed_files.map(f => f.path), ['api.ts']);
  assert.equal(local.structure_diff?.signature_changed_symbols[0]?.symbol, 'submit');
  const second = await record('Update nested and outer APIs', first);
  await write('private.ts', 'export function unrelated() { return 1; }');
  await record('Only update outer APIs', second);
  const selected = await buildLiveWorkspaceRadar(arc.store, arc.directory, nested.project_id, { mode: 'commit', commit: second });
  assert.deepEqual(selected.changed_files.map(f => f.path), ['api.ts']);
  assert.deepEqual(selected.recent_commits.map(c => c.sha), [second, first]);
  const pair = await readLiveFileDiff(arc.store, arc.directory, nested.project_id, {
    base_ref: selected.base_ref, target_ref: selected.target_ref, path: 'api.ts',
  });
  assert.equal(pair.before, original);
  assert.equal(pair.after, revised);
});

test('adding or removing a CMake marker changes the eligibility of unchanged tracked siblings', async t => {
  const { root, write, git, record, radar } = await fixture(t, false);
  const marker = 'component/CMakeCache.txt', source = 'component/api.ts';
  await write('.gitignore', marker + '\n');
  await write(source, original);
  const first = await record('Track authored component');
  await write(marker, '# generated component');
  const hidden = await radar();
  assert.deepEqual(hidden.changed_files.map(f => [f.path, f.status]), [[source, 'removed']]);
  assert.deepEqual(hidden.structure_diff?.removed_symbols.map(s => s.symbol), ['submit']);
  await git('add', '--force', marker);
  await record('Track generated marker', first);
  await fs.unlink(path.join(root, marker));
  const restored = await radar();
  assert.deepEqual(restored.changed_files.map(f => [f.path, f.status]), [[source, 'added']]);
  assert.deepEqual(restored.structure_diff?.added_symbols.map(s => s.symbol), ['submit']);
});

test('workspace impact MCP checks the grant, reads the live index and returns a compact contract summary', async t => {
  const { root, project, arc, write } = await fixture(t);
  const bridge = new ArcMcpBridge(arc, process.cwd());
  const tool = 'arc_workspace_impact';
  assert.equal(bridgeTools.find(item => item.name === tool)?.annotations.readOnlyHint, true);
  await assert.rejects(bridge.call(tool, { workspace_path: root }), /授权/);
  await bridge.enable(project.project_id);
  const overview = arc.overview(project.project_id);
  const { feature, scenario } = arc.addFeature(project.project_id, 'Submission');
  const catalog = arc.addFeature(project.project_id, 'Public entry').feature;
  arc.store.put('feature', catalog.feature_id, {
    ...catalog, discovery: { result_id: 'overview', node_id: 'api', source_snapshot_id: project.snapshot_id },
  });
  arc.store.put('explanation', 'overview', {
    result_id: 'overview', scenario_id: overview.scenario_id, created_at: project.created_at,
    result: {
      result_id: 'overview', binding: { project_id: project.project_id }, nodes: [
        { node_id: 'api', label: 'API', kind: 'component', evidence_ids: ['api-file'] },
      ], edges: [], architecture: { node_ids: ['api'], edge_ids: [] },
      evidence: [{ evidence_id: 'api-file', path: 'api.ts' }],
    },
  });
  arc.store.put('explanation', 'feature', {
    result_id: 'feature', scenario_id: scenario.scenario_id, created_at: project.created_at,
    result: { result_id: 'feature', binding: { project_id: project.project_id }, nodes: [], edges: [],
      evidence: [{ evidence_id: 'feature-api', path: 'api.ts' }] },
  });
  arc.store.put('engineering_context', 'rule', {
    entry_id: 'rule', key: 'Public API', category: 'rule', text: 'Preserve the public API',
    project_id: project.project_id, status: 'current', sources: [{ path: 'api.ts' }],
  });
  await write('api.ts', revised);
  await write('new-caller.ts', 'export interface Receipt { id: string; }\nexport function liveCaller() { return submit(3, true); }\n');
  const count = arc.store.all('snapshot').length;
  const scoped = await bridge.call(tool, { workspace_path: root, files: ['api.ts'] });
  assert.deepEqual(scoped.scope_files, ['api.ts']);
  assert.deepEqual(scoped.external_callers.map((c: { caller_symbol: string }) => c.caller_symbol).sort(), ['consume', 'liveCaller']);
  assert.equal(scoped.architecture_nodes[0]?.node_id, 'api');
  assert.deepEqual(scoped.impacted_features.map((f: {feature_id: string}) => f.feature_id).sort(),
    [feature.feature_id, catalog.feature_id].sort());
  assert.equal(scoped.related_constraints[0]?.entry_id, 'rule');
  const summary = await bridge.call(tool, { workspace_path: root });
  assert.deepEqual(summary.changed_files.map((f: { path: string }) => f.path).sort(), ['api.ts', 'new-caller.ts']);
  assert.equal(summary.contract_risks[0]?.unupdated_external_callers[0]?.caller_file, 'consumer.ts');
  assert.ok(summary.symbol_changes.some((s: { symbol: string }) => s.symbol === 'submit'));
  assert.ok(summary.symbol_changes.some((s: { symbol: string }) => s.symbol === 'Receipt'));
  assert.ok(Number.isFinite(summary.computed_ms));
  assert.equal(arc.store.all('snapshot').length, count);
  assert.deepEqual(arc.store.all('engineering_task'), []);
  assert.deepEqual(arc.store.all('run'), []);
  await assert.rejects(bridge.call(tool, { workspace_path: path.dirname(root), files: [] }), /绑定|归属/);
  bridge.disable();
  await assert.rejects(bridge.call(tool, { workspace_path: root, files: ['api.ts'] }), /授权/);
  await bridge.close();
});
