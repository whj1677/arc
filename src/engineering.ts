import type { ExecutionMode,ProviderId,ReadingTarget } from './shared';
import type {AnalysisNode,AnalysisEdge,AnalysisClaim,SourceEvidence,RunBinding} from '../contracts/agent-adapter';

export interface GoalRefinement {
  refined_goal: string;
  suggested_non_goals: string[];
  clarifications: string[];
  engine: 'codex' | 'dsh';
  duration_ms: number;
}

export interface WorkspaceAsset {path:string;sha256:string}
export interface CompletionBinding {
  workspace_path:string;workspace_fingerprint:string;head:string|null;branch:string|null;git_common_dir:string|null;
}
export interface CodeState {
  snapshot_id:string; fingerprint:string; head:string|null; branch:string|null;
  git_common_dir:string|null; dirty:string[]; captured_at:string;
  workspace_fingerprint?:string; assets?:WorkspaceAsset[];
}
export interface WorkspaceBinding {
  workspace_id:string; project_id:string; root_path:string; status:'bound'|'unbound';
  git_common_dir:string|null; created_at:string; rebound_at?:string;
}
export interface ContextSource {
  path:string; snapshot_id:string; content_sha256:string; line_start:number; line_end:number;
}
export interface LegacyImport {
  import_key:string; revision_key:string; source_kind:'context'|'task'|'rule'|'evidence';
  sources:ContextSource[]; imported_at:string;
}
export const engineeringSectionCategories=['plan','architecture','design','verification_plan'] as const;
export type EngineeringSectionCategory=typeof engineeringSectionCategories[number];
export const engineeringCategories=['purpose','build','rule','issue','module','interface','decision','technology',...engineeringSectionCategories] as const;
export interface SaveEngineeringEntry {
  task_id?:string;
  project_id?:string;workspace_path?:string;entry_id?:string;expected_version:number;submission_key:string;
  category:typeof engineeringCategories[number];key:string;text:string;status?:'current'|'needs_review';sources?:ContextSource[];
}
export interface ContextEntry {
  task_id?:string;
  entry_id:string; project_id:string; version:number; key:string;
  category:'purpose'|'module'|'interface'|'build'|'rule'|'decision'|'issue'|'technology'|EngineeringSectionCategory;
  origin:'source'|'document'|'user'|'agent'; text:string;
  status:'current'|'needs_review'|'superseded'; sources:ContextSource[];
  code_fingerprint:string; updated_at:string; supersedes?:string; conflict?:string;
  truncated?:boolean;
  update_suggestion?:{source_entry_id:string;source_version:number;previous_text:string;proposed_text:string};
  analysis_result_id?:string;
  covered_entries?:string[];
  source_version?:number;
  legacy_import?:LegacyImport;
}
export function activeContextEntries(entries: ContextEntry[]): ContextEntry[] {
  const current = entries.filter(entry => entry.status !== 'superseded');
  const replaced = new Set(current.map(entry => entry.supersedes).filter(id => id !== undefined));
  // Correcting an individual source also invalidates aggregates that still quote it.
  for (const entry of current.filter(entry => !replaced.has(entry.entry_id))) {
    if (entry.covered_entries?.some(id => replaced.has(id))) replaced.add(entry.entry_id);
  }
  for (const entry of current.filter(entry => !replaced.has(entry.entry_id))) {
    for (const id of entry.covered_entries ?? []) replaced.add(id);
  }
  return current.filter(entry => !replaced.has(entry.entry_id));
}

export interface EngineeringContext {
  material_sources?:MaterialSourceIndexEntry[];
  environment_brief?:string;
  knowledge_brief?:string;
  project_id:string; workspace:WorkspaceBinding; version:number; code_state:CodeState;
  entries:ContextEntry[]; analysis_refs:{result_id:string; source_snapshot_id:string; status:string;summary:string;architecture?:boolean}[];
  analysis?:EngineeringAnalysis;
  recent_tasks:Pick<EngineeringTask,'task_id'|'goal'|'status'|'summary'|'version'|'updated_at'|'verification_status'|'decisions'|'unresolved'>[];
  total_entries:number; next_offset:number|null;
}
export type MaterialSourceIndexEntry=Pick<ContextEntry,'entry_id'|'key'|'category'>&{sources:{path:string}[]};
export interface EngineeringAnalysis {
  result_id:string; binding:RunBinding; created_at:string;
  source_snapshot_id:string; source_fingerprint:string; source_status:string;
  status:'current'|'needs_review'|'unbound'; summary:string;
  coverage:{covered_scope:readonly string[];unresolved_scope:readonly string[]};
  nodes:(Pick<AnalysisNode,'node_id'|'kind'|'label'|'description'|'parent_node_id'|'source_scope'|'claim_ids'|'evidence_ids'>&{in_architecture:boolean;truncated:boolean})[];
  edges:(Pick<AnalysisEdge,'edge_id'|'kind'|'source_node_id'|'target_node_id'|'label'|'status'|'condition'|'claim_ids'|'evidence_ids'>&{in_architecture:boolean;truncated:boolean})[];
  node_refs:Pick<AnalysisNode,'node_id'|'label'|'kind'>[];
  claims:AnalysisClaim[]; evidence:SourceEvidence[];
  total_items:number; next_offset:number|null; truncated:boolean;
}
export interface FileChange {
  path:string; before_sha256:string|null; after_sha256:string|null;
  ownership:'task_change'|'preexisting_overlap';
  text_diff_unavailable?:boolean;
}
export interface DevelopmentCriterion {
  criterion_id:string; text:string; evidence_ids:string[];
}
export interface DevelopmentStep {
  step_id:string; title:string; change:string; status:'pending'|'in_progress'|'completed'|'blocked'|'failed'|'superseded';
  progress:string; criteria:DevelopmentCriterion[]; evidence_ids:string[]; unresolved:string[];
  created_at:string; updated_at:string;
  verification_status?:'not_run'|'passed'|'failed'|'partial'|'stale';
}
export interface VerificationEvidence {
  metrics?:{total?:number;passed?:number;failed?:number;skipped?:number;suspicious_empty?:boolean};
  evidence_id:string; command:string; cwd:string; outcome:'passed'|'failed'|'blocked'|'not_run';
  exit_code:number|null; origin:'observed'|'self_reported'; code_state:CodeState;
  created_at:string; log_path?:string; note?:string;
  code_state_verified?:boolean; step_id?:string; criterion_id?:string;
}
export interface TaskReadingBinding {
  feature_id:string; scenario_id:string; result_id:string; source_snapshot_id:string;
  target:ReadingTarget;
  evidence?:{evidence_id:string;path:string;line_start:number;line_end:number};
}
export interface WalkthroughUpdate {
  status:'pending'|'running'|'completed'|'failed';
  previous_result_id:string; source_snapshot_id?:string; run_id?:string; result_id?:string;
  update_id?:string; error?:string; updated_at:string;
}
export interface RequirementPackage {
  assumptions?:string[]; open_questions?:string[]; non_goals?:string[]; revoked?:string[];
  risks?:string[];
  behaviors:{id:string;behavior:string;design:string;files:string[];step_ids:string[];verification:string}[];
}
export interface EngineeringTask {
  task_id:string; project_id:string; workspace_id:string; workspace_path:string;
  reading?:TaskReadingBinding; walkthrough?:WalkthroughUpdate;
  version:number; submission_key:string; title?:string; goal:string; scope:string[];
  workflow?:'analysis'|'ready'|'execution'; proposed_scope?:string[];
  requirement_package?:RequirementPackage;
  boundaries?:{non_goals:string[];revoked:string[]};
  approval?:{reviewed_version:number;scope:string[];notes?:string[]};
  analysis_channel?:'codex'|'kimi'|'dsh';
  execution_mode?:ExecutionMode;
  fast_mode?:boolean;
  diff_review?:{
    verdict:'approved'|'needs_fix'|'no_diff';
    summary:string;
    repaired?:boolean;
    blocking_issues?:{file:string;issue:string;fix:string}[];
  };
  rolled_back_at?:string;
  status:'pending'|'running'|'blocked'|'completed'|'failed'|'cancelled'|'interrupted';
  baseline:CodeState; end_state?:CodeState; diff_baseline?:CodeState; context_version:number;
  summary:string; decisions:string[]; unresolved:string[]; changes:FileChange[];
  verification:VerificationEvidence[]; changes_status?:'needs_review'; steps?:DevelopmentStep[];
  verification_status:'not_run'|'passed'|'failed'|'partial'|'stale';
  attempt_ids:string[]; created_at:string; updated_at:string; saved:'saved';
  requests?:{text:string;submission_key:string;created_at:string}[];
  preexisting_files?:{path:string;sha256:string|null}[];
  rebind_source_snapshot_id?:string; rebind_preexisting_files?:{path:string;sha256:string|null}[];
  origin?:'legacy_import'; legacy_import?:LegacyImport;
}
export interface DevelopmentAttempt {
  skipped_verification?:string[];
  attempt_id:string; task_id:string; project_id:string; workspace_id:string; workspace_path:string;
  provider_id:ProviderId; model:string; origin:'arc'|'agent';
  status:'starting'|'running'|'completed'|'failed'|'cancelled'|'interrupted';
  started_at:string; ended_at?:string; pid?:number; session_id?:string; runtime_version?:string;
  error?:string; log_path?:string;
  baseline?:CodeState; context_version?:number;
  write_scope?:string[];
  connection_status?:'connected'|'unknown';
}
export interface ContextRequest {view?:'strict'|'execution';task_id?:string;project_id?:string; workspace_path?:string; cached?:boolean;refresh?:boolean;query?:string;entry_id?:string;result_id?:string;category?:ContextEntry['category'];offset?:number;limit?:number}
export interface CreateEngineeringTask extends ContextRequest {
  goal:string; submission_key:string; task_id?:string; scope?:string[]; reading?:TaskReadingBinding;
  notes?: string[];
  fast_mode?:boolean;
  boundaries?:EngineeringTask['boundaries'];
}
export function developmentFileError(file:string) {
  if(file.length>1000||/[\u0000-\u001f\u007f\\:*?\[\]{}<>|"~]/.test(file))return '请输入工程内具体文件的相对路径。';
  const parts=file.split('/');
  if(parts.some(part=>!part||/[. ]$/.test(part)||/^\.(?:git|codex|agents|aws|arc-local)$/i.test(part)))return '不允许授权 Git、Agent 元数据或非规范路径。';
  if(/^(?:AGENTS(?:\.override)?\.md|\.gitmodules|\.gitattributes)$/i.test(parts.at(-1)!))return '不允许授权 Agent 规则或 Git 配置文件。';
  return '';
}
export interface UpdateEngineeringTask {
  task_id:string; expected_version:number; submission_key:string; summary?:string;
  proposed_scope?:string[]; requirement_package?:RequirementPackage;
  decisions?:string[]; unresolved?:string[]; verification?:VerificationEvidence[]; steps?:DevelopmentStep[];
  status?:EngineeringTask['status']; attempt_id?:string;
}
export interface FinishEngineeringTask extends UpdateEngineeringTask {
  status:'completed'|'failed'|'blocked'|'cancelled';
  completion_binding?:CompletionBinding|null;
}
