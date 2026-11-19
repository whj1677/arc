import fs from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisResult, Explanation, Project, Revision, Run, Scenario, Snapshot, WorkspaceData } from '../shared';
import { Store, id, now } from './store';
import { readSource } from './snapshot';
import { validateResult } from './validation';

export interface ProjectIoHost {
  readonly store: Store;
  readonly directory: string;
  readonly resources: string;
  data(): WorkspaceData;
  openProject(rootPath: string, fictional?: boolean, buildConfig?: string): Promise<Project>;
  addFeature(projectId: string, name: string, question?: string): { feature: any; scenario: Scenario };
  acceptResult(runId: string, value: unknown, semanticReview?: string, allowFollowups?: boolean): Promise<Run>;
}

export async function loadDemoProject(host: ProjectIoHost): Promise<Project> {
  const root = path.join(host.resources, 'examples', 'source-fixture');
  const project = await host.openProject(root, true);
  const already = host.store.all<Explanation>('explanation').find(e => e.result.binding.project_id === project.project_id);
  if (already) return project;

  project.name = '演示 · 配置应答与持久化';
  host.store.put('project', project.project_id, project);
  const { scenario } = host.addFeature(project.project_id, '配置更新', 'ACK_OK 是否代表参数已持久化？');
  const result = JSON.parse(await fs.readFile(path.join(host.resources, 'examples', 'analysis-result.json'), 'utf8')) as AnalysisResult;
  const runId = id('demo-run');
  const run: Run = {
    binding: {
      project_id: project.project_id,
      feature_id: scenario.feature_id,
      scenario_id: scenario.scenario_id,
      question_revision_id: scenario.question_revision_id,
      source_snapshot_id: project.snapshot_id,
      run_id: runId,
    },
    provider_id: 'demo',
    status: 'running',
    question: scenario.question,
    title: scenario.title,
    created_at: now(),
    submission_key: runId,
    output_path: '',
  };
  const rebound: AnalysisResult = {
    ...result,
    result_id: id('demo-result'),
    binding: run.binding,
    provider: { provider_id: 'demo', connection_id: 'local-demo', adapter_version: '0.1.0' },
    evidence: result.evidence.map(e => ({ ...e, source_snapshot_id: project.snapshot_id })),
  };
  host.store.put('run', runId, run);
  await host.acceptResult(runId, rebound);
  return project;
}

export async function exportProjectBundle(host: ProjectIoHost, projectId: string, file: string): Promise<string> {
  const data = host.data();
  const project = host.store.get<Project>('project', projectId);
  const snapshots = data.snapshots.filter(s => s.project_id === projectId);
  const contents: Record<string, Record<string, string>> = {};
  for (const snapshot of snapshots) {
    contents[snapshot.source_snapshot_id] = {};
    for (const f of snapshot.files) {
      const source = await readSource(host.directory, snapshot, f.path);
      contents[snapshot.source_snapshot_id][f.path] = source.text;
    }
  }
  const runs = data.runs
    .filter(r => r.binding.project_id === projectId)
    .map(r => ({ ...r, output_path: '', pid: undefined }));
  const bundle = {
    format: 'arc-export-v1',
    exported_at: now(),
    project,
    features: data.features.filter(x => x.project_id === projectId),
    scenarios: data.scenarios.filter(x => x.project_id === projectId),
    revisions: data.revisions.filter(x => data.scenarios.some(s => s.project_id === projectId && s.scenario_id === x.scenario_id)),
    annotations: data.annotations.filter(x => x.project_id === projectId),
    explanations: data.explanations.filter(x => x.result.binding.project_id === projectId),
    questions: (data.questions || []).filter(x => x.project_id === projectId),
    runs,
    snapshots,
    contents,
  };
  await fs.writeFile(file, JSON.stringify(bundle, null, 2), { flag: 'wx' });
  return file;
}

export async function importAnalysisResult(host: ProjectIoHost, scenarioId: string, file: string): Promise<Run> {
  const stat = await fs.stat(file);
  if (stat.size > 2 * 1024 * 1024) throw new Error('导入结果超过 2 MiB');
  const raw = await fs.readFile(file, 'utf8');
  const value = JSON.parse(raw) as AnalysisResult;
  const scene = host.store.get<Scenario>('scenario', scenarioId);
  const project = host.store.get<Project>('project', scene.project_id);
  const binding = value.binding;
  if (!binding || binding.project_id !== project.project_id || binding.feature_id !== scene.feature_id || binding.scenario_id !== scene.scenario_id) {
    throw new Error('导入结果不属于所选工程与场景，未按名称猜测或重绑');
  }
  const revision = host.store.get<Revision>('revision', binding.question_revision_id);
  const snapshot = host.store.get<Snapshot>('snapshot', binding.source_snapshot_id);
  if (revision.scenario_id !== scenarioId || snapshot.project_id !== project.project_id) {
    throw new Error('导入问题/来源归属不一致');
  }

  const original: Run = {
    binding,
    provider_id: value.provider?.provider_id,
    status: 'running',
    question: revision.question,
    title: scene.title,
    created_at: now(),
    submission_key: id('import'),
    output_path: '',
    origin: 'manual_import',
  };
  const report = await validateResult(value, original, snapshot, host.directory);
  if (report.errors.length) {
    throw new Error(`导入校验失败：${report.errors.slice(0, 5).join('；')}`);
  }

  const runId = id('import-run');
  const run: Run = {
    ...original,
    binding: { ...binding, run_id: runId },
    imported_binding: binding,
    output_path: path.join(host.directory, 'runs', runId, 'imported-original.json'),
  };
  await fs.mkdir(path.dirname(run.output_path), { recursive: true });
  await fs.writeFile(run.output_path, raw, { flag: 'wx' });
  const rebound: AnalysisResult = { ...value, result_id: id('import-result'), binding: run.binding };
  host.store.put('run', runId, run);
  await host.acceptResult(runId, rebound);
  return host.store.get<Run>('run', runId);
}
