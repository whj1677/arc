import type { ProviderId } from './shared';
import type {AnalysisNode,AnalysisEdge,AnalysisClaim,SourceEvidence,RunBinding} from '../contracts/agent-adapter';

export interface CodeState {
  snapshot_id:string; fingerprint:string; head:string|null; branch:string|null;
  git_common_dir:string|null; dirty:string[]; captured_at:string;
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
export interface SaveEngineeringEntry {
  project_id?:string;workspace_path?:string;entry_id?:string;expected_version:number;submission_key:string;
  category:EngineeringSectionCategory;key:string;text:string;status?:'current'|'needs_review';sources?:ContextSource[];
}
export interface ContextEntry {
  entry_id:string; project_id:string; version:number; key:string;
  category:'purpose'|'module'|'interface'|'build'|'rule'|'decision'|'issue'|'technology'|EngineeringSectionCategory;
  origin:'source'|'document'|'user'|'agent'; text:string;
  status:'current'|'needs_review'|'superseded'; sources:ContextSource[];
  code_fingerprint:string; updated_at:string; supersedes?:string; conflict?:string;
  truncated?:boolean;
  legacy_import?:LegacyImport;
}
export interface EngineeringContext {
  project_id:string; workspace:WorkspaceBinding; version:number; code_state:CodeState;
  entries:ContextEntry[]; analysis_refs:{result_id:string; source_snapshot_id:string; status:string;summary:string}[];
  analysis?:EngineeringAnalysis;
  recent_tasks:Pick<EngineeringTask,'task_id'|'goal'|'status'|'summary'|'version'|'updated_at'|'verification_status'|'decisions'|'unresolved'>[];
  total_entries:number; next_offset:number|null;
}
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
}
export interface VerificationEvidence {
  evidence_id:string; command:string; cwd:string; outcome:'passed'|'failed'|'blocked'|'not_run';
  exit_code:number|null; origin:'observed'|'self_reported'; code_state:CodeState;
  created_at:string; log_path?:string; note?:string;
  code_state_verified?:boolean;
}
export interface EngineeringTask {
  task_id:string; project_id:string; workspace_id:string; workspace_path:string;
  version:number; submission_key:string; goal:string; scope:string[];
  status:'pending'|'running'|'blocked'|'completed'|'failed'|'cancelled'|'interrupted';
  baseline:CodeState; end_state?:CodeState; context_version:number;
  summary:string; decisions:string[]; unresolved:string[]; changes:FileChange[];
  verification:VerificationEvidence[]; verification_status:'not_run'|'passed'|'failed'|'partial'|'stale';
  attempt_ids:string[]; created_at:string; updated_at:string; saved:'saved';
  requests?:{text:string;submission_key:string;created_at:string}[];
  preexisting_files?:{path:string;sha256:string|null}[];
  rebind_source_snapshot_id?:string; rebind_preexisting_files?:{path:string;sha256:string|null}[];
  origin?:'legacy_import'; legacy_import?:LegacyImport;
}
export interface DevelopmentAttempt {
  attempt_id:string; task_id:string; project_id:string; workspace_id:string; workspace_path:string;
  provider_id:ProviderId; model:string; origin:'arc'|'agent';
  status:'starting'|'running'|'completed'|'failed'|'cancelled'|'interrupted';
  started_at:string; ended_at?:string; pid?:number; session_id?:string; runtime_version?:string;
  error?:string; log_path?:string;
  baseline?:CodeState; context_version?:number;
  connection_status?:'connected'|'unknown';
}
export interface ContextRequest {project_id?:string; workspace_path?:string; refresh?:boolean;query?:string;entry_id?:string;result_id?:string;category?:ContextEntry['category'];offset?:number;limit?:number}
export interface CreateEngineeringTask extends ContextRequest {
  goal:string; submission_key:string; task_id?:string; scope?:string[];
}
export interface UpdateEngineeringTask {
  task_id:string; expected_version:number; submission_key:string; summary?:string;
  decisions?:string[]; unresolved?:string[]; verification?:VerificationEvidence[];
  status?:EngineeringTask['status']; attempt_id?:string;
}
export interface FinishEngineeringTask extends UpdateEngineeringTask {
  status:'completed'|'failed'|'blocked'|'cancelled';
}
