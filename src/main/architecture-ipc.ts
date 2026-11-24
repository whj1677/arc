import type { ModuleReferencePaths } from '../architecture-workspace';
import type { ArcService } from './service';

export const architectureOperations = [
  'architecture_get', 'architecture_save', 'architecture_versions', 'architecture_restore',
  'architecture_delete_impact', 'architecture_branches',
  'architecture_check_updates', 'architecture_update_affected', 'architecture_review_resolve',
] as const;
type Operation = typeof architectureOperations[number];

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${field} 必须是非空字符串`);
  return value;
}

function version(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw Error('架构文档版本无效');
  return value;
}

function draftReferencePaths(value: unknown): ModuleReferencePaths | undefined {
  if (value === undefined) return undefined;
  const paths = value as Partial<ModuleReferencePaths> | null;
  const valid = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string');
  if (!valid(paths?.files) || !valid(paths?.directories)) throw Error('草稿源码关联路径无效');
  return { files: paths.files, directories: paths.directories };
}

export async function architectureIpc(service: ArcService, operation: Operation, args: Record<string, unknown>) {
  const project = identifier(args.project_id, 'project_id');
  const branch = args.branch_key === undefined ? undefined : identifier(args.branch_key, 'branch_key');
  switch (operation) {
    case 'architecture_check_updates':
      return service.checkArchitectureUpdates(project, { branchKey: branch });
    case 'architecture_update_affected': {
      const modules = args.module_ids, retry = args.retry_failed_only;
      if (modules !== undefined && !Array.isArray(modules)) throw Error('module_ids 必须是模块标识数组');
      if (retry !== undefined && typeof retry !== 'boolean') throw Error('retry_failed_only 必须是布尔值');
      return service.updateAffectedArchitecture(project, { branchKey: branch,
        moduleIds: modules?.map(id => identifier(id, 'module_id')), retryFailedOnly: retry });
    }
    case 'architecture_review_resolve': {
      const { decision, note } = args;
      if (decision !== 'accept' && decision !== 'reject' && decision !== 'defer') throw Error('审查决定无效');
      if (note !== undefined && typeof note !== 'string') throw Error('审查备注必须是文本');
      return service.resolveArchitectureReview(project, { branchKey: branch, reviewId: identifier(args.review_id, 'review_id'), decision, note });
    }
    case 'architecture_get': {
      const active_branch = await service.getActiveArchitectureBranch(project);
      const document = await service.getArchitectureDocument(project, {
        branchKey: branch ?? active_branch, version: args.version === undefined ? undefined : version(args.version, 1),
      });
      return { document, active_branch, branches: service.listArchitectureBranches(project),
        versions: await service.listArchitectureVersions(project, document.branch_key) };
    }
    case 'architecture_save': {
      if (!args.document || typeof args.document !== 'object' || Array.isArray(args.document)) throw Error('缺少架构文档');
      // The service validates the document and its project/branch identity before writing.
      const document = service.saveArchitectureDocument(project, args.document as Parameters<ArcService['saveArchitectureDocument']>[1],
        args.expected_version === undefined ? undefined : version(args.expected_version, 0));
      return { document, versions: await service.listArchitectureVersions(project, document.branch_key) };
    }
    case 'architecture_versions':
      return { versions: await service.listArchitectureVersions(project, branch) };
    case 'architecture_restore': {
      const document = service.restoreArchitectureVersion(project, identifier(args.branch_key, 'branch_key'), version(args.version, 1));
      return { document, versions: await service.listArchitectureVersions(project, document.branch_key) };
    }
    case 'architecture_delete_impact':
      return service.getModuleDeleteImpact(project, branch ?? await service.getActiveArchitectureBranch(project), identifier(args.module_id, 'module_id'), draftReferencePaths(args.draft_paths));
    case 'architecture_branches':
      return { branches: service.listArchitectureBranches(project), active_branch: await service.getActiveArchitectureBranch(project) };
  }
}
