import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ARC_CHECKER_SOURCE, ARC_MIGRATION_ADAPTER_SOURCE, OFFICIAL_AEC_SCRIPT_HASHES } from './aec-checker-source';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const AEC_VERSION = 'arc-1';
export const ARC_ENGINEERING_RULES = `本工程通过 ARC 保存工程上下文与开发记录，不需要安装或调用独立 AEC Skill。
- 普通任务自动调用 arc_engineering_context，workspace_path 必须是当前实际工程绝对路径；只读解释不创建开发任务、不修改工程。
- 开发前调用 arc_begin_development（workspace_path、goal、稳定 submission_key）；已有 task_id 时续接原任务，冻结正确工作区和开始基线。
- 使用 Agent 原有能力实施最小充分改动和必要验证；保留已有用户改动。按实际影响记录接口、迁移或重要决定，不强制新建 FIX/REQ 文件包或空章节。
- 结束调用 arc_finish_development（task_id、expected_version、稳定 submission_key、真实 status、summary、verification、unresolved）；中途用 arc_update_development，恢复用 arc_development_task。
- 验证记录包含实际 command、cwd、exit_code、outcome 和对应 code_state；区分 observed 与 self_reported、未运行与通过，失败和未完成项不得省略。
- saved=pending_sync 只表示待同步，不能声称已保存到 ARC；保留任务 ID 并在恢复连接后续接。历史文档不是已验证的当前事实，冲突和过期来源标记待复核。
- 用户自有规则、安全、发布和审批要求继续有效；不因 ARC 接入扩大权限。`;

export interface AecLegacyDocument {
  importKey: string; revisionKey: string; path: string; sha256: string; content: string;
  kind: 'context'|'task'|'rule'|'evidence'; status: 'needs_review';
}
export interface AecRuleMigration {
  path: string; originalSha256: string; originalContent: string; replacementContent: string;
  state: 'migrate'|'current'|'conflict'; reason?: string;
}
export interface AecScan { documents: AecLegacyDocument[]; rules: AecRuleMigration[]; warnings: string[] }

function block(namespace: string, body: string, newline: string) {
  return `<!-- ${namespace}:start version=${AEC_VERSION} -->${newline}${body.replace(/\r?\n/g, newline)}${newline}<!-- ${namespace}:end version=${AEC_VERSION} -->`;
}

function span(text: string, namespace: string) {
  const signals = text.match(new RegExp(`<!--\\s*${namespace}:(?:start|end)\\b`, 'g')) || [];
  const markers = [...text.matchAll(new RegExp(`<!--\\s*${namespace}:(start|end)(?:\\s+version=([A-Za-z0-9_.-]+))?\\s*-->`, 'g'))];
  if (!signals.length) return undefined;
  if (signals.length !== 2 || markers.length !== 2 || markers[0][1] !== 'start' || markers[1][1] !== 'end' || markers[0][2] !== markers[1][2]) {
    throw new Error(`${namespace} 管理标记残缺、重复、逆序或版本不一致`);
  }
  return { start: markers[0].index!, end: markers[1].index! + markers[1][0].length, version: markers[0][2] };
}

export function planAecRuleMigration(file: string, originalContent: string): AecRuleMigration {
  const base = { path: file, originalContent, originalSha256: hash(originalContent), replacementContent: originalContent };
  if (Object.hasOwn(OFFICIAL_AEC_SCRIPT_HASHES, file)) {
    const replacementContent = /\/(?:check_ai_context|collect_delivery_evidence)\.py$/.test(file) ? ARC_CHECKER_SOURCE : ARC_MIGRATION_ADAPTER_SOURCE;
    if (originalContent === replacementContent) return { ...base, state: 'current' };
    if (!OFFICIAL_AEC_SCRIPT_HASHES[file].includes(hash(originalContent.replace(/\r\n/g, '\n')))) return { ...base, state: 'conflict', reason: `${file}: 未识别为官方管理版本，保留自定义脚本；需确认其检查/建包条款` };
    return { ...base, replacementContent, state: 'migrate' };
  }
  try {
    const managed = span(originalContent, 'ai-engineering-context');
    if (!managed) return { ...base, state: 'current', reason: '没有可明确识别的 AEC 管理块；保留用户规则' };
    if (managed.version === AEC_VERSION) return { ...base, state: 'current' };
    const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
    return { ...base, state: 'migrate', replacementContent: originalContent.slice(0, managed.start) + block('ai-engineering-context', ARC_ENGINEERING_RULES, newline) + originalContent.slice(managed.end) };
  } catch (error) { return { ...base, state: 'conflict', reason: String(error) }; }
}

async function safePath(root: string, relative: string, missing = false) {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('非法迁移路径');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (missing && error.code === 'ENOENT') return undefined; throw error; });
    if (stat?.isSymbolicLink()) throw new Error(`迁移不读取或写入符号链接: ${relative}`);
  }
  return current;
}

export async function scanAecLegacy(workspacePath: string): Promise<AecScan> {
  const root = await fs.realpath(workspacePath);
  const result: AecScan = { documents: [], rules: [], warnings: [] };
  const paths = new Set<string>();
  const roots = ['docs/ai_engineering', 'docs/modules', 'docs/interfaces', 'docs/requirements', 'docs/changes'];
  async function walk(relative: string) {
    let dir: string;
    try { dir = await safePath(root, relative); }
    catch (error: any) { if (error.code !== 'ENOENT') result.warnings.push(String(error)); return; }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) { result.warnings.push(`未导入符号链接: ${relative}/${entry.name}`); continue; }
      if (/^(?:REQ-0000-template|backups|node_modules|\.git)$/.test(entry.name)) continue;
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (/\.(?:md|json|txt)$/i.test(entry.name) && !entry.name.startsWith('_')) paths.add(rel);
    }
  }
  for (const relative of roots) await walk(relative);
  const rootFiles = await fs.readdir(root);
  for (const file of rootFiles.filter(name => /^(?:AGENTS|CLAUDE)\.md$/i.test(name))) paths.add(file);
  for (const file of Object.keys(OFFICIAL_AEC_SCRIPT_HASHES)) {
    try { await safePath(root, file); paths.add(file); }
    catch (error: any) { if (error.code !== 'ENOENT') result.warnings.push(String(error)); }
  }
  for (const relative of [...paths].sort()) {
    try {
      const file = await safePath(root, relative);
      if ((await fs.stat(file)).size > 2 * 1024 * 1024) { result.warnings.push(`文件超过 2 MB，未自动导入: ${relative}`); continue; }
      const bytes = await fs.readFile(file);
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const digest = hash(bytes);
      const rule = Object.hasOwn(OFFICIAL_AEC_SCRIPT_HASHES, relative) || /^(?:AGENTS|CLAUDE)\.md$/i.test(relative) || content.includes('<!-- ai-engineering-context:');
      const kind = rule ? 'rule' : /(?:verification|evidence|test_result)/i.test(relative) ? 'evidence' : relative.startsWith('docs/requirements/') || relative.startsWith('docs/changes/') ? 'task' : 'context';
      result.documents.push({ importKey: `aec:${relative}`, revisionKey: `aec:${relative}:${digest}`, path: relative, sha256: digest, content, kind, status: 'needs_review' });
      if (rule) {
        const migration = planAecRuleMigration(relative, content);
        result.rules.push(migration);
        const outside = content.replace(/<!--[\s\S]*?-->/g, '');
        if (!Object.hasOwn(OFFICIAL_AEC_SCRIPT_HASHES, relative) && !content.includes('ai-engineering-context:start') && /(?:REQ-|sync_requirement_status|collect_delivery_evidence)/.test(outside)) result.warnings.push(`${relative}: 未受管的旧流程要求，需人工确认归属；未修改`);
      }
    } catch (error) { result.warnings.push(`${relative}: ${String(error)}`); }
  }
  return result;
}

/** Caller must persist the imported originals before applying a reviewed plan. */
export async function applyAecRuleMigration(workspacePath: string, rules: AecRuleMigration[]): Promise<string[]> {
  const root = await fs.realpath(workspacePath);
  const conflicts = rules.filter(rule => rule.state === 'conflict');
  if (conflicts.length) throw new Error(`AEC 管理规则存在冲突；未写入：${conflicts.map(rule => `${rule.path}: ${rule.reason || '未知管理内容'}`).join('；')}`);
  const selected = rules.filter(rule => rule.state === 'migrate');
  if (new Set(selected.map(rule => rule.path.toLowerCase())).size !== selected.length) throw new Error('重复规则路径');
  const plans: {rule: AecRuleMigration; file: string}[] = [];
  for (const rule of selected) {
    const file = await safePath(root, rule.path);
    const original = await fs.readFile(file);
    if (hash(original) !== rule.originalSha256) throw new Error(`规则在预检后已变化: ${rule.path}`);
    const expected = planAecRuleMigration(rule.path, original.toString('utf8'));
    if (expected.state !== 'migrate' || expected.replacementContent !== rule.replacementContent) throw new Error(`拒绝修改非管理内容: ${rule.path}`);
    plans.push({ rule, file });
  }
  const written: typeof plans = [];
  try {
    for (const plan of plans) {
      if (hash(await fs.readFile(plan.file)) !== plan.rule.originalSha256) throw new Error(`规则在写入前已变化: ${plan.rule.path}`);
      await atomicWrite(plan.file, plan.rule.replacementContent);
      written.push(plan);
    }
  } catch (error) {
    for (const plan of written.reverse()) {
      if (hash(await fs.readFile(plan.file)) === hash(plan.rule.replacementContent)) await atomicWrite(plan.file, plan.rule.originalContent);
    }
    throw error;
  }
  return plans.map(plan => plan.rule.path);
}

async function atomicWrite(file: string, text: string) {
  const temp = `${file}.arc-${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, text, { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

/** Explicit Agent connection only; never called by a read-only project scan. */
export async function installArcAgentRules(workspacePath: string, options: { connectionFile?: string } = {}): Promise<{ path: string; changed: boolean }> {
  const root = await fs.realpath(workspacePath);
  const candidates = (await fs.readdir(root)).filter(name => /^agents\.md$/i.test(name));
  if (candidates.length > 1) throw new Error('存在多个大小写不同的 AGENTS.md，需先明确入口');
  const relative = candidates[0] || 'AGENTS.md';
  const file = await safePath(root, relative, true);
  const original = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const legacy = span(original, 'ai-engineering-context');
  if (legacy && legacy.version !== AEC_VERSION) throw new Error('请先导入并迁移 AEC 管理规则，再连接 Agent');
  const managed = span(original, 'arc-engineering');
  if (options.connectionFile && !path.isAbsolute(options.connectionFile)) throw new Error('ARC 连接文件路径必须是绝对路径');
  const active = legacy?.version === AEC_VERSION ? legacy : managed;
  if (active?.version === AEC_VERSION) {
    if (!options.connectionFile) return { path: relative, changed: false };
    const body = original.slice(active.start, active.end), marker = `<!-- arc-connection-file: ${JSON.stringify(options.connectionFile)} -->`;
    const existingMarkers = [...body.matchAll(/<!-- arc-connection-file: .*? -->/g)];
    if (existingMarkers.length > 1) throw new Error('ARC 连接路径标记重复，未修改用户规则');
    const updatedBody = existingMarkers.length ? body.replace(existingMarkers[0][0], marker) : body.replace(/-->/, `-->${original.includes('\r\n') ? '\r\n' : '\n'}${marker}`);
    if (updatedBody === body) return { path: relative, changed: false };
    if (await fs.readFile(file, 'utf8') !== original) throw new Error('AGENTS.md 在预检后已变化');
    await atomicWrite(file, original.slice(0, active.start) + updatedBody + original.slice(active.end));
    return { path: relative, changed: true };
  }
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const binding = options.connectionFile ? `<!-- arc-connection-file: ${JSON.stringify(options.connectionFile)} -->${newline}` : '';
  const content = block('arc-engineering', binding + ARC_ENGINEERING_RULES, newline);
  const replacement = managed ? original.slice(0, managed.start) + content + original.slice(managed.end) : original + (original && !original.endsWith('\n') ? newline : '') + newline + content + newline;
  const current = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (current !== original) throw new Error('AGENTS.md 在预检后已变化');
  await atomicWrite(file, replacement);
  return { path: relative, changed: true };
}
