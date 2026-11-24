import path from 'node:path';
import { moduleReferencePaths, type ArchitectureDocument, type CodeBinding, type UpdateRunRecord } from '../architecture-workspace';
import type { Project, Snapshot, SourceEvidence } from '../shared';
import { frozenManifest, type ArchitectureChangedFile, type ArchitectureDetection } from './architecture-change-detector';
import { architectureSyntax, getCodeIndex, hasCppSources, supportsSourceFile, type CodeIndex } from './code-index';
import { capture, readSource } from './snapshot';
import type { Store } from './store';

type Summary = UpdateRunRecord['impact_summary'];
type Anchor = CodeBinding | SourceEvidence;
export interface ArchitectureRelocation {
  target_kind: 'module' | 'relation';
  target_id: string;
  field: 'code_links' | 'evidence';
  before: Anchor;
  after: Anchor;
}
interface UnresolvedRelocation {
  target_kind: 'module' | 'relation'; target_id: string; path: string; old_path?: string; reason: string;
}
interface ImpactParams {
  doc: ArchitectureDocument; detection: ArchitectureDetection; rootPath: string; store: Store; project: Project;
  oldSnapshot?: Snapshot; newSnapshot?: Snapshot; oldIndex?: CodeIndex; newIndex?: CodeIndex;
}
type Syntax = NonNullable<Awaited<ReturnType<typeof architectureSyntax>>>;
const under = (file: string, dir: string) => dir === '.' || file === dir || file.startsWith(dir.replace(/\/$/, '') + '/');
const header = (file: string) => /(?:\.d\.ts|\.h(?:pp|xx|h)?)$/i.test(file);
const globalConfig = (file: string) => /(?:^|\/)(?:CMakeLists\.txt|Makefile|package\.json|tsconfig\.json|Cargo\.toml|go\.mod|pyproject\.toml)$/i.test(file);

export async function captureArchitectureSnapshot(project: Project, store: Store, detection: ArchitectureDetection, doc: ArchitectureDocument, rootPath = project.root_path) {
  const row = store.db.prepare(`SELECT json FROM objects WHERE kind='snapshot'
    AND json_extract(json,'$.project_id')=? ORDER BY rowid DESC LIMIT 1`).get(project.project_id);
  const recent: Snapshot | undefined = row && JSON.parse(String(row.json));
  if (recent?.consistency === 'verified' && recent.root_path === rootPath && recent.build_config === project.build_config &&
      (recent.commit ?? undefined) === detection.live_git.commit && Boolean(recent.dirty) === detection.live_git.dirty &&
      frozenManifest(recent, doc).workspace_fingerprint === detection.live_workspace_fingerprint) return recent;
  const snapshot = await capture(rootPath, project.project_id, store.directory, project.build_config);
  store.put('snapshot', snapshot.source_snapshot_id, snapshot);
  return snapshot;
}

function relocatedAnchor(anchor: Anchor, change: ArchitectureChangedFile, old: Snapshot, next: Snapshot,
    previousIndex: CodeIndex, nextIndex: CodeIndex, oldSyntax?: Syntax, newSyntax?: Syntax): Anchor | undefined {
  const binding = 'kind' in anchor;
  const file = next.files.find(entry => entry.path === change.path)!;
  const oldFile = old.files.find(entry => entry.path === anchor.path);
  const boundHash = binding ? anchor.file_sha256 : anchor.content_sha256;
  if (!oldFile || (boundHash && boundHash !== oldFile.content_sha256)) return;
  let start = binding ? anchor.start_line : anchor.line_start, end = binding ? anchor.end_line : anchor.line_end;
  let symbolId = anchor.symbol_id;
  const previous = previousIndex.symbols.filter(s => s.file === anchor.path);
  const explicitSymbol = previous.find(s => s.id === symbolId);
  const name = binding && anchor.symbol_name;
  const bound = explicitSymbol ?? (name ? previous.find(s => (s.qualified_name === name || s.name === name)
    && (start === undefined || (s.start_line <= start && s.end_line >= start))) : undefined);
  if (name && !bound && !change.rename_confidence) return;
  if (oldSyntax && newSyntax && start !== undefined) {
    const first = oldSyntax.rows.findIndex(([,last]) => last >= start!);
    const last = oldSyntax.rows.findLastIndex(([first]) => first <= (end ?? start!));
    if (first < 0 || first > last) return;
    start = newSyntax.rows[first][0] + Math.max(0, start - oldSyntax.rows[first][0]);
    if (end !== undefined) end = newSyntax.rows[last][1] - Math.max(0, oldSyntax.rows[last][1] - end);
  }
  if (bound) {
    // Same tree positions can contain overloaded declarations. Use source order within the qualified name.
    const same = (s: typeof bound) => s.qualified_name === bound.qualified_name && s.kind === bound.kind;
    const ordinal = previous.filter(same).findIndex(s => s.id === bound.id);
    const replacement = nextIndex.symbols.filter(s => s.file === change.path && same(s))[ordinal];
    if (!replacement && !change.rename_confidence) return;
    if (explicitSymbol && replacement) symbolId = replacement.id;
    if (replacement && binding && start === undefined && anchor.kind === 'symbol') {
      start = replacement.start_line; end = replacement.end_line;
    }
  }
  if (start !== undefined && (start < 1 || (end ?? start) > file.line_count)) return;
  return binding ? { ...anchor, path: file.path, source_snapshot_id: next.source_snapshot_id, file_sha256: file.content_sha256, start_line: start, end_line: end, symbol_id: symbolId }
    : { ...anchor, path: file.path, content_sha256: file.content_sha256, source_snapshot_id: next.source_snapshot_id,
        line_start: start!, line_end: end!, symbol_id: symbolId };
}

function referencesOf(doc: ArchitectureDocument) {
  const refs = new Map<string, Array<Omit<ArchitectureRelocation, 'after'>>>();
  function add(target_kind: ArchitectureRelocation['target_kind'], target_id: string, field: ArchitectureRelocation['field'], before: Anchor) {
    if ('kind' in before && before.kind === 'directory') return;
    const entries = refs.get(before.path) ?? [];
    entries.push({ target_kind, target_id, field, before });
    refs.set(before.path, entries);
  }
  for (const mod of doc.modules) {
    mod.code_links.forEach(link => add('module', mod.id, 'code_links', link));
    mod.evidence.forEach(ev => add('module', mod.id, 'evidence', ev));
  }
  for (const relation of doc.relations) relation.evidence.forEach(ev => add('relation', relation.id, 'evidence', ev));
  return refs;
}

function dependencyNeighbors(index: CodeIndex, affectedFiles: Set<string>) {
  const neighbors = new Set<string>();
  function edge(a: string, b: string) {
    if (affectedFiles.has(a)) neighbors.add(b);
    if (affectedFiles.has(b)) neighbors.add(a);
  }
  const ids = new Map(index.symbols.map(s => [s.id, s.file]));
  for (const call of index.calls) for (const target of call.target_ids) edge(call.file, ids.get(target)!);
  // Resolve local imports by path, then unique suffix (e.g. a configured C include directory).
  const aliases = new Map<string, string | null>(), exact = new Map<string,string>();
  for (const file of new Set([...index.files,...affectedFiles])) {
    const names = [file, file.replace(/\.(?:[cm]?[jt]sx?|py|java)$/i, ''), file.replace(/\.d\.ts$/i, '')];
    for (const alias of new Set(names)) {
      exact.set(alias, file);
      const parts = alias.split('/');
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join('/'), existing = aliases.get(key);
        aliases.set(key, existing === undefined || existing === file ? file : null);
      }
    }
  }
  const consumers = new Map<string, Set<string>>();
  for (const [source, imports] of Object.entries(index.imports ?? {})) for (const specifier of imports) {
    const target = specifier.replace(/\.[mc]?js$/i, '');
    const local = path.posix.join(path.posix.dirname(source), target);
    const resolved = exact.get(local) ?? exact.get(local + '/index') ?? exact.get(target) ?? aliases.get(target) ?? aliases.get(target.replaceAll('.', '/'));
    if (resolved) {
      edge(source, resolved);
      const dependents = consumers.get(resolved) ?? new Set<string>();
      dependents.add(source);
      consumers.set(resolved,dependents);
    }
  }
  // Headers and re-exports can expose an interface through more than one import.
  const reachable = new Set(affectedFiles);
  for (const file of reachable) for (const consumer of consumers.get(file) ?? []) {
    neighbors.add(consumer);
    reachable.add(consumer);
  }
  for (const state of index.shared_states) if (affectedFiles.has(state.file)) {
    for (const mod of index.modules) if (state.access_dirs.includes(mod.dir)) mod.files.forEach(file => neighbors.add(file));
  }
  return neighbors;
}

// Walkthroughs retain the snapshot they explain. Replay only exact moves on
// this document's branch between that snapshot and the current code baseline.
function walkthroughScopes(store: Store, project: Project, doc: ArchitectureDocument, detection: ArchitectureDetection) {
  const explanations = store.latestFeatureExplanations(project, doc.branch_key);
  if (!explanations.length) return [];
  const history = store.db.prepare(`SELECT s.rowid AS snapshot_order, json_extract(f.value,'$.old_path') AS old_path,
    json_extract(f.value,'$.path') AS path FROM engineering_versions v
    JOIN objects s ON s.kind='snapshot' AND s.id=json_extract(v.json,'$.last_update.read_baseline.snapshot_id')
    JOIN json_each(v.json,'$.last_update.detection_summary.changed_files') f
    WHERE v.kind='architecture_doc' AND v.id=? AND json_extract(v.json,'$.baseline.snapshot_id')=s.id
    AND s.rowid <= (SELECT rowid FROM objects WHERE kind='snapshot' AND id=?)
    AND json_extract(f.value,'$.rename_confidence')='exact'
    GROUP BY s.rowid, json_extract(f.value,'$.old_path'), json_extract(f.value,'$.path')
    ORDER BY min(v.version)`).all(doc.id,doc.baseline?.snapshot_id ?? '') as
    {snapshot_order:number;old_path:string;path:string}[];
  const snapshotOrder = store.db.prepare("SELECT rowid FROM objects WHERE kind='snapshot' AND id=?");
  const livePaths = Object.keys(detection.live_hashes);
  return explanations.map(({ result, scenario_id }) => {
    const files = new Set(result.evidence.map(ev => ev.path)), dirs: string[] = [];
    for (const {source_scope: scope} of result.nodes) {
      if (scope?.kind === 'file') files.add(scope.path);
      if (scope?.kind === 'folder') dirs.push(scope.path);
    }
    const matches = (file: string) => files.has(file) || dirs.some(dir => under(file,dir));
    if (history.length) {
      const origin = snapshotOrder.get(result.binding.source_snapshot_id);
      if (origin) for (const move of history) if (move.snapshot_order > Number(origin.rowid) && matches(move.old_path)) {
        files.delete(move.old_path);
        files.add(move.path);
      }
    }
    // The current detection may also contain a rename. Include its candidate
    // destination for reading, without binding uncertain moves into later runs.
    for (const move of detection.rename_details) if (matches(move.old_path)) files.add(move.path);
    return { feature_id:result.binding.feature_id, scenario_id, matches, paths:livePaths.filter(matches) };
  });
}

export function architectureFileOwners(doc: ArchitectureDocument) {
  const owners = doc.modules.map(mod => ({ id: mod.id, ...moduleReferencePaths(mod) }));
  const endpoints = new Map(owners.map(owner => [owner.id, owner]));
  for (const rel of doc.relations) for (const id of [rel.from, rel.to])
    endpoints.get(id)?.files.push(...rel.evidence.map(ev => ev.path));
  return (file: string) => owners.filter(ref => ref.files.includes(file) || ref.directories.some(dir => under(file, dir))).map(ref => ref.id);
}

export async function analyzeArchitectureImpact(params: ImpactParams): Promise<{
  impact_summary: Summary; autoRelocations: ArchitectureRelocation[]; unresolvedRelocations: UnresolvedRelocation[];
  affectedScenarioIds: string[]; scenarioPaths: Record<string,string[]>; modulePaths: Map<string,Set<string>>;
}> {
  const { doc, detection, store, project } = params;
  const { changed_files: changes, detection_reliable } = detection.detection_summary;
  const autoRelocations: ArchitectureRelocation[] = [];
  const unresolvedRelocations: UnresolvedRelocation[] = [];
  const all = doc.modules.map(m => m.id), affected = new Set<string>(), paths = new Set<string>();
  const modules = architectureFileOwners(doc);
  const modulePaths = new Map<string,Set<string>>();
  function affect(id: string, cause: string) {
    affected.add(id);
    if (Object.hasOwn(detection.live_hashes, cause)) {
      const extra = modulePaths.get(id) ?? new Set<string>();
      extra.add(cause);
      modulePaths.set(id, extra);
    }
  }
  const unmapped_files: string[] = [];
  for (const change of changes) {
    paths.add(change.path);
    if (change.old_path) paths.add(change.old_path);
    if (['added','modified'].includes(change.status) && !modules(change.path).length) unmapped_files.push(change.path);
  }
  const featureIds = new Set<string>(), scenarioPaths: Record<string,string[]> = Object.create(null);
  function result(mode: Summary['mode'], reason: string) {
    return { impact_summary: { mode, reason, affected_module_ids: all.filter(id => affected.has(id)),
      reused_module_ids: all.filter(id => !affected.has(id)), affected_feature_ids: [...featureIds], unmapped_files },
      autoRelocations, unresolvedRelocations, affectedScenarioIds: Object.keys(scenarioPaths), scenarioPaths, modulePaths };
  }
  function wide(reason: string) { all.forEach(id => affected.add(id)); return result('wide_recheck', reason); }
  if (!detection_reliable) return wide('变更检测失败，需要重新检查：' + detection.detection_summary.detection_error);
  if (doc.branch_key !== detection.live_git.branchKey) return wide('当前 Git 分支与保存的架构分支不一致');
  if (doc.baseline && !detection.has_changes && !changes.length)
    return result('none', '工作区无相关变更，直接复用已保存架构结果');

  let scopes: ReturnType<typeof walkthroughScopes> | undefined;
  function featuresReferencing(files: Set<string>, causes: string[] = [], allScopes = false) {
    scopes ??= walkthroughScopes(store,project,doc,detection);
    for (const scope of scopes) {
      if (allScopes || [...files].some(scope.matches)) {
        featureIds.add(scope.feature_id);
        scenarioPaths[scope.scenario_id] = [...new Set([...(scenarioPaths[scope.scenario_id] ?? scope.paths),
          ...causes.filter(file => Object.hasOwn(detection.live_hashes,file))])];
      }
    }
  }
  if (!doc.baseline) { featuresReferencing(paths); return wide('缺少已保存的源码基线，需要全面检查'); }
  if (!changes.length) return wide('工作区指纹与保存基线不一致，需要重新检查');
  const old = params.oldSnapshot ?? store.get<Snapshot>('snapshot', doc.baseline.snapshot_id);
  const next = params.newSnapshot ?? await captureArchitectureSnapshot(project, store, detection, doc, params.rootPath);
  if (frozenManifest(next, doc).workspace_fingerprint !== detection.live_workspace_fingerprint)
    throw Error('影响分析快照与检测到的工作区指纹不一致，请重新检查');
  const [oldIndex, newIndex] = await Promise.all([
    params.oldIndex ?? getCodeIndex(store.directory, old), params.newIndex ?? getCodeIndex(store.directory, next),
  ]);
  const refs = referencesOf(doc);
  const semanticFiles = new Set<string>(), contracts = new Set<string>();
  const exactMoves = new Map(detection.rename_details.filter(r => r.rename_confidence === 'exact').map(r => [r.old_path,r.path]));
  for (const mod of doc.modules) for (const link of mod.code_links) {
    if (link.kind !== 'directory' || !exactMoves.size) continue;
    const dir = link.path.replace(/\/$/, '');
    const leaving = [...exactMoves].filter(([from,to]) => under(from,dir) && !under(to,dir));
    if (!leaving.length) continue;
    // A directory binding can move as a whole only when its entire membership has moved together.
    const [from,to] = leaving[0], suffix = from.slice(dir.length);
    const dest = to.endsWith(suffix) ? to.slice(0,-suffix.length) : undefined;
    const members = Object.keys(doc.baseline.file_hashes).filter(file => under(file,dir));
    if (dest && members.every(file => exactMoves.get(file) === dest + file.slice(dir.length)) &&
        Object.keys(detection.live_hashes).filter(file => under(file,dest)).length === members.length) {
      autoRelocations.push({ target_kind:'module',target_id:mod.id,field:'code_links',before:link,after:{...link,path:dest} });
    } else {
      unresolvedRelocations.push({target_kind:'module',target_id:mod.id,old_path:from,path:to,
        reason:'文件已移出绑定目录，需确认新路径的目录归属'});
    }
  }
  const uncertainSyntax: string[] = [];
  for (const change of changes) {
    const oldPath = change.old_path ?? change.path;
    let before: Syntax | undefined, after: Syntax | undefined;
    if (change.status === 'modified' && supportsSourceFile(change.path)) {
      const syntaxOf = async (snap: Snapshot, index: CodeIndex) => {
        const source = await readSource(store.directory, snap, change.path);
        return architectureSyntax(change.path, source.text, hasCppSources(index.files));
      };
      [before, after] = await Promise.all([syntaxOf(old, oldIndex), syntaxOf(next, newIndex)]);
    }
    const cosmetic = change.rename_confidence === 'exact' || (!!before && before.structure === after?.structure);
    if (cosmetic) {
      const anchors = refs.get(oldPath) ?? [];
      const unresolved = new Set<string>();
      for (const ref of anchors) {
        const moved = relocatedAnchor(ref.before, change, old, next, oldIndex, newIndex, before, after);
        if (moved) autoRelocations.push({ ...ref, after: moved });
        else if (!unresolved.has(ref.target_kind + ':' + ref.target_id)) {
          unresolved.add(ref.target_kind + ':' + ref.target_id);
          unresolvedRelocations.push({ target_kind: ref.target_kind, target_id: ref.target_id, path: change.path,
            old_path: change.old_path, reason: '原引用的哈希、符号或行范围无法与读取快照核对，请确认定位' });
        }
      }
      continue;
    }
    semanticFiles.add(change.path);
    semanticFiles.add(oldPath);
    if (change.status === 'modified' && change.category === 'code' && (!before || !after)) uncertainSyntax.push(change.path);
    const publicFileChanged = (change.status === 'deleted' || change.status === 'added') &&
      (change.status === 'deleted' ? oldIndex : newIndex).symbols.some(s => s.file === change.path && s.public_entry);
    if (header(change.path) || change.category === 'config_or_contract' || publicFileChanged || (before && after && before.contract !== after.contract)) {
      contracts.add(change.path);
      contracts.add(oldPath);
    }
  }
  if (!semanticFiles.size) return result('reference_only', unresolvedRelocations.length
    ? '文件移动或仅调整注释与行号，部分历史引用需要人工确认' : '文件移动或仅调整注释与行号，已核实源码引用');
  featuresReferencing(semanticFiles);
  for (const file of semanticFiles) modules(file).forEach(id => affect(id, file));
  for (const contract of contracts) {
    const contractOwners = new Set(modules(contract));
    for (const index of [oldIndex,newIndex]) {
      const neighbors = dependencyNeighbors(index, new Set([contract]));
      for (const file of neighbors) modules(file).forEach(id => affect(id, contract));
      featuresReferencing(neighbors, [contract]);
    }
    for (const rel of doc.relations) {
      if (contractOwners.has(rel.from)) affect(rel.to, contract);
      if (contractOwners.has(rel.to)) affect(rel.from, contract);
    }
  }
  // The source index cannot enumerate generated consumers of configuration and schema files.
  const configs = changes.filter(c => semanticFiles.has(c.path) && (c.category === 'config_or_contract' || c.category === 'rule'));
  if (configs.length) {
    const causes = configs.map(c => c.path);
    for (const id of all) for (const file of causes) affect(id,file);
    featuresReferencing(semanticFiles, causes, true);
    return wide(configs.some(c => globalConfig(c.path) || c.category === 'rule')
      ? '构建配置或全局工程规则发生变化，需要重新检查全部模块'
      : '静态索引无法确定配置或共享契约的全部使用方，需要全面检查：' + causes.join('、'));
  }
  if (uncertainSyntax.length) return wide('无法通过语法树确认公共接口是否变化：' + uncertainSyntax.join('、'));
  const scope = '受影响模块 ' + [...affected].join('、') + '；复用模块 ' + all.filter(id => !affected.has(id)).join('、');
  if (all.length && affected.size / all.length > 0.6) return result('wide_recheck', '超过 60% 的模块受影响。' + scope);
  if (contracts.size) return result('cross_module', '公共接口、签名或共享状态发生变化。' + scope);
  return result(featureIds.size && !unmapped_files.length ? 'dataflow_only' : 'local_module',
    (unmapped_files.length ? '有文件需要核实模块归属。' : '实现发生变化，保留既有接口。') + scope);
}
