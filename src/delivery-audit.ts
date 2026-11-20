import type {CodeState, ContextEntry, EngineeringTask, MaterialSourceIndexEntry, VerificationEvidence} from './engineering';
import {effectiveTaskBoundaries,taskBoundaryKey} from './task-boundaries';

type Metrics = NonNullable<VerificationEvidence['metrics']>;
type Inspection = Metrics & {skipped_flag?: boolean; label: string};

// Only strip a known shell wrapper; never match a test name as a substring of
// an unrelated command (for example `echo npm test`).
export function commandBody(value:string){
  let body=value.trim();
  const wrapped=body.match(/^(?:"(?:[^"]*[\\/])?(?:powershell|pwsh|bash|sh)(?:\.exe)?"|(?:\S*[\\/])?(?:powershell|pwsh|bash|sh)(?:\.exe)?)\s+(?:-[A-Za-z]+\s+)*?(?:-Command|-c)\s+([\s\S]+)$/i);
  if(wrapped){
    body=wrapped[1].trim();
    // Codex prints the shell argument as adjacent shlex-quoted fragments.
    // Decode the outer argument only. Quotes inside the script are significant.
    if(/^(?:'[^']*'|"(?:[^"\\]|\\[\s\S])*")+$/.test(body)){
      const fragments=body.matchAll(/'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"/g);
      body=Array.from(fragments,([,single,double])=>single??double.replace(/\\(["\\$\x60]|\r?\n)/g,(_,escaped)=>escaped.endsWith('\n')?'':escaped)).join('');
    }
  }
  return body.replace(/\r\n/g,'\n').trim();
}

function summaryCounts(text: string): Metrics {
  const counts: Metrics = {};
  for (const match of text.matchAll(/(\d+)\s+(passed|failed|errors?|skipped|pending|todo|xfailed|xpassed|total)\b/gi)) {
    const name = match[2].toLowerCase();
    const key = name === 'total' ? 'total' : /^(passed|xpassed)$/.test(name) ? 'passed' : /^(failed|errors?)$/.test(name) ? 'failed' : 'skipped';
    counts[key] = (counts[key] ?? 0) + Number(match[1]);
  }
  if (Object.keys(counts).length) counts.total ??= (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0);
  return counts;
}

function runnerCounts(output: string): Metrics {
  const lines = output.split(/\r?\n/).map(line => line.trim());
  const tap: Metrics = {};
  const fields = {tests: 'total', pass: 'passed', fail: 'failed', skipped: 'skipped', todo: 'skipped'} as const;
  for (const line of lines) {
    const match = /^(?:#|ℹ)\s+(tests|pass|fail|skipped|todo) (\d+)$/.exec(line);
    if (match) {
      const key = fields[match[1] as keyof typeof fields];
      tap[key] = (tap[key] ?? 0) + Number(match[2]);
    }
  }
  if (tap.total !== undefined) return tap;

  const js = lines.findLast(line => /^Tests\s*:?\s+\d/.test(line));
  if (js) return summaryCounts(js);
  const pytest = lines.findLast(line => /^(?:=+\s*)?\d+ (?:passed|failed|skipped|deselected|xfailed|xpassed|warnings?|errors?)\b.*\bin [\d.]+s/i.test(line));
  if (pytest) return /\bdeselected\b/.test(pytest) ? {total: 0, ...summaryCounts(pytest)} : summaryCounts(pytest);

  // Surefire prints one line per class and a second, aggregate line per module.
  const maven = lines.map(line => /^(?:\[(?:INFO|WARNING|ERROR)\]\s*)?Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(.*)$/.exec(line)).filter(match => match !== null);
  if (maven.length) {
    const aggregates = maven.filter(match => !match[5].trim());
    const counts = {total: 0, passed: 0, failed: 0, skipped: 0};
    for (const match of aggregates.length ? aggregates : maven) {
      const total = Number(match[1]), failed = Number(match[2]) + Number(match[3]), skipped = Number(match[4]);
      counts.total += total; counts.passed += total - failed - skipped; counts.failed += failed; counts.skipped += skipped;
    }
    return counts;
  }
  const gradle = lines.findLast(line => /^\d+ tests? completed\b/.test(line));
  if (gradle) {
    const total = parseInt(gradle, 10), {failed = 0, skipped = 0} = summaryCounts(gradle);
    return {total, passed: total - failed - skipped, failed, skipped};
  }
  // Go may replay the entire verbose transcript for a cached package.
  const goResults: string[] = [], pending: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const result = /^--- (PASS|FAIL|SKIP): \S+/.exec(line);
    if (result) pending.push(result[1]);
    if (/^(?:ok|FAIL)\s+\S+/.test(line)) {
      if (!line.includes('(cached)')) goResults.push(...pending);
      pending.length = 0;
    }
  }
  goResults.push(...pending);
  if (goResults.length) return {total: goResults.length, passed: goResults.filter(s => s === 'PASS').length, failed: goResults.filter(s => s === 'FAIL').length, skipped: goResults.filter(s => s === 'SKIP').length};
  const ctestSummary = /^(?:\d+%\s+tests passed,\s*)?(\d+) tests failed out of (\d+)$/;
  const ctest = lines.findLast(line => ctestSummary.test(line))?.match(ctestSummary);
  if (ctest) {
    const failed = Number(ctest[1]), total = Number(ctest[2]);
    return {total, passed: total - failed, failed};
  }
  const gtest = {total: 0, passed: 0, failed: 0, skipped: 0};
  let hasSummary = false;
  for (const line of lines) {
    const match = /^\[\s*(PASSED|FAILED|SKIPPED)\s*\]\s+(\d+)\s+tests?\b/.exec(line);
    if (match) {
      hasSummary = true;
      const count = Number(match[2]);
      gtest[match[1].toLowerCase() as 'passed' | 'failed' | 'skipped'] += count;
      gtest.total += count;
    }
  }
  if (gtest.total === 0 && lines.some(line => /^(?:\[=+\]\s+)?0 tests from 0 test suites ran\./.test(line))) return {total: 0};
  if (hasSummary) return gtest;
  return {};
}

const skipOption = /(?:^|[\s"'])(?:-D(?:skipTests|maven\.test\.skip)(?:=true)?|-x\s+test|--exclude-task(?:=|\s+)test)(?=$|[\s"';])/i;

export function inspectVerificationOutput(command: string, exitCode: number | null, output: string): Inspection {
  const text = output.replace(/\x1b\[[\d;]*m/g, '');
  const counts = runnerCounts(text);
  const skippedFlag = skipOption.test(command) || /(?:^|\n)\s*(?:\[INFO\]\s*)?Tests are skipped\./im.test(text);
  const noTests = /(?:^|\n)\s*(?:=+\s*|\[INFO\]\s*)?(?:no tests? (?:ran|found|to run|were found)|no test files found|collected 0 items)\b/im.test(text);
  const goPackages = text.split(/\r?\n/).filter(line => /^(ok|FAIL|\?)\s+/.test(line));
  const goEmpty = goPackages.length > 0 && goPackages.every(line => /\[(?:no test files|no tests to run)\]|\(cached\)/.test(line));
  const gradleTasks = [...text.matchAll(/^> Task (?:[\w:.-]*:)?test(?: (NO-SOURCE|SKIPPED|UP-TO-DATE|FROM-CACHE))?\s*$/gim)];
  const gradleEmpty = gradleTasks.length > 0 && gradleTasks.every(match => match[1]);
  const silentTest = !text.trim() && /\b(?:node\s+--test|pytest|jest|vitest|go\s+test|ctest|(?:npm|yarn|pnpm)\s+(?:run\s+)?test)\b/i.test(command);
  const empty = skippedFlag || silentTest || counts.total === 0 || (counts.total !== undefined && counts.total === counts.skipped)
    || (counts.total === undefined && (noTests || goEmpty || gradleEmpty));
  if (counts.total === undefined && (noTests || goEmpty || gradleEmpty)) counts.total = 0;
  const label = exitCode === null ? '未取得退出码' : exitCode !== 0 || counts.failed ? '验证失败' : empty ? '空跑或跳过'
    : counts.passed !== undefined ? `通过 ${counts.passed} 项` : '命令成功';
  return {...counts, ...(skippedFlag && {skipped_flag: true}), ...(empty && {suspicious_empty: true}), label};
}

export function sameVerificationState(a: CodeState, b: CodeState) {
  return !!a.workspace_fingerprint && a.workspace_fingerprint === b.workspace_fingerprint && a.head === b.head && a.branch === b.branch && a.git_common_dir === b.git_common_dir;
}

export function evidenceSupportsPass(e: VerificationEvidence) {
  return e.origin === 'observed' && e.outcome === 'passed' && e.exit_code === 0 && !!e.log_path && e.code_state_verified !== false
    && !e.metrics?.failed && !e.metrics?.suspicious_empty && !skipOption.test(e.command);
}

export function evidenceFailed(e: VerificationEvidence) {
  return e.outcome === 'failed' || e.origin === 'observed' && (e.metrics?.failed ?? 0) > 0;
}

export function verificationEvidenceLabel(e: VerificationEvidence) {
  if (e.origin === 'observed') {
    if (e.metrics?.suspicious_empty || skipOption.test(e.command)) return '空跑或跳过';
    if (e.metrics?.failed) return `失败 ${e.metrics.failed} 项`;
    if (e.outcome === 'passed' && e.metrics?.passed !== undefined) return `通过 ${e.metrics.passed} 项`;
  }
  const outcome = {passed:'通过', failed:'失败', blocked:'受阻', not_run:'未执行'}[e.outcome];
  return e.origin === 'self_reported' ? `自述${outcome}` : outcome;
}

function auditVerification(task: EngineeringTask, logs: Record<string, string>) {
  if (task.verification_status === 'stale') return {status: 'stale', label: '代码已变，待重验'} as const;
  if (!task.verification.length) return {status: 'not_run', label: '未执行'} as const;
  const state = task.end_state ?? task.baseline;
  const latest = new Map<string, VerificationEvidence>();
  for (const item of task.verification) {
    if (!sameVerificationState(item.code_state, state)) continue;
    if (item.origin === 'observed' && (logs[item.evidence_id] !== undefined || (item.log_path && logs[item.log_path] !== undefined))) {
      const log = logs[item.evidence_id] ?? logs[item.log_path!];
      // ARC command logs start with the executed command, followed by its output.
      const header = item.command + '\n';
      const output = log.startsWith(header) ? log.slice(header.length) : log;
      latest.set(commandBody(item.command), {...item, metrics: inspectVerificationOutput(item.command, item.exit_code, output)});
    } else latest.set(commandBody(item.command), item);
  }
  const checks = [...latest.values()];
  const empty = checks.some(e => e.origin === 'observed' && (e.metrics?.suspicious_empty || skipOption.test(e.command)));
  if (task.verification_status === 'failed' || checks.some(evidenceFailed)) {
    return {status: 'failed', label: empty ? '失败 · 空跑或跳过' : '验证失败'} as const;
  }
  if (empty) return {status: 'suspicious_empty', label: '空跑或跳过'} as const;
  if ((checks.length ? checks : task.verification).every(item => item.origin === 'self_reported')) return {status: 'self_reported', label: '仅 Agent 自述'} as const;
  if (task.verification_status !== 'passed' || !checks.length || !checks.every(evidenceSupportsPass)) return {status: 'partial', label: '证据待核'} as const;
  const passed = checks.reduce((sum, e) => sum + (e.metrics?.passed ?? 0), 0);
  const skipped = checks.reduce((sum, e) => sum + (e.metrics?.skipped ?? 0), 0);
  return {status: 'passed', passed, skipped, label: passed ? `通过 ${passed} 项${skipped ? ` · 跳过 ${skipped}` : ''}` : '命令成功'} as const;
}

function auditDiffReview(task: EngineeringTask): {status:'approved'|'repaired'|'needs_fix'|'none'; label:string; summary?:string} {
  const saved = task.decisions.flatMap(line => {
    const match = /^独立 Diff 审查（(approved|needs_fix)）[：:，\s]*([\s\S]*)$/.exec(line);
    return match ? [{verdict:match[1], summary:match[2].trim()}] : [];
  });
  const final = task.diff_review ?? saved.at(-1);
  if (!final) return {status:'none', label:''};
  if (final.verdict === 'needs_fix') return {status:'needs_fix', label:'有阻断项', summary:final.summary};
  if (task.diff_review?.repaired || (saved.some(review => review.verdict === 'needs_fix') && saved.some(review => review.verdict === 'approved')))
    return {status:'repaired', label:'自修后通过', summary:final.summary};
  return {status:'approved', label:'通过', summary:final.summary};
}

export function auditDelivery(task: EngineeringTask, contextEntries: (MaterialSourceIndexEntry & {status?: ContextEntry['status']})[], verificationLogs: Record<string, string> = {}) {
  const pathKey = (path: string) => path.replaceAll('\\', '/');
  const scope = new Set((task.approval?.scope ?? task.proposed_scope ?? task.scope).map(pathKey));
  const out_of_scope = task.changes.filter(change => !scope.has(pathKey(change.path))).map(change => change.path);
  const overlap = task.changes.filter(change => change.ownership === 'preexisting_overlap').map(change => change.path);
  const scopeWarning = !!(out_of_scope.length || overlap.length || task.changes_status === 'needs_review');
  const sourceTexts = [task.summary, ...(task.steps ?? []).filter(s => s.status !== 'superseded').flatMap(s =>
    [s.title, s.change, s.progress, ...s.criteria.map(c => c.text), ...s.unresolved]), ...task.changes.map(change => change.path)].map(text => taskBoundaryKey(text).toLowerCase());
  const hits = effectiveTaskBoundaries(task).revoked.filter(term => {
    const key = taskBoundaryKey(term).toLowerCase();
    return key && sourceTexts.some(text => text.includes(key));
  });
  const changed = new Set(task.changes.map(change => pathKey(change.path)));
  const impacted_materials = contextEntries.filter(entry => entry.status !== 'superseded' && entry.sources.some(s => changed.has(pathKey(s.path))))
    .map(({entry_id, key, category}) => ({entry_id, key, category}));
  return {scope: {status: scopeWarning ? 'warning' as const : 'ok' as const, out_of_scope, overlap}, verification: auditVerification(task, verificationLogs), review:auditDiffReview(task), redlines: {hits}, impacted_materials};
}
