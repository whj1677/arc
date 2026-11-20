import type { AnalysisResult, RunBinding, ProviderId, SourceEvidence } from '../contracts/agent-adapter';
export type { AnalysisResult, RunBinding, SourceEvidence, ProviderId };
export type {ReadingGuide} from '../contracts/agent-adapter';
export type ExecutionMode = 'codex' | 'dsh' | 'codex_desktop' | 'mcp';
export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === 'codex' || value === 'dsh' || value === 'codex_desktop' || value === 'mcp';
}
export interface SourceFile { path: string; content_sha256: string; bytes: number; line_count: number; encoding: string }
export interface Snapshot {
  source_snapshot_id: string; project_id: string; captured_at: string; root_path: string;
  files: SourceFile[]; excluded: { path: string; reason: string }[]; fingerprint: string;
  commit: string | null; dirty: string | null; build_config: string; consistency: 'verified';
}
export interface Project { project_id: string; name: string; root_path: string; snapshot_id: string; fictional: boolean; build_config: string; created_at: string; overview_scenario_id?:string }
export interface Feature { feature_id: string; project_id: string; name: string; archived: boolean; sort_order: number; discovery?: {result_id:string;node_id:string;source_snapshot_id:string} }
export interface Scenario { scenario_id: string; feature_id: string; project_id: string; title: string; question: string; question_revision_id: string; archived: boolean; sort_order: number; kind?: 'feature_overview' }
export interface Revision { question_revision_id: string; scenario_id: string; question: string; created_at: string }
export interface Annotation { annotation_id: string; project_id: string; scenario_id: string; result_id: string | null; object_id: string | null; source_snapshot_id: string; text: string; created_at: string; target?: ReadingTarget }
export interface ReadingTarget { kind:'feature'|'node'|'edge'|'file'|'directory'|'step'|'role'|'handoff'|'call_step'; id:string }
export interface ReadingContext {
  project:{project_id:string;name:string}; feature:{feature_id:string;name:string};
  scenario:{scenario_id:string;title:string;question:string;question_revision_id:string};
  result_id:string|null; target:ReadingTarget; source_snapshot_id:string;
  source:{captured_at:string;commit:string|null;fingerprint:string;mode:'bound'|'latest';previous_snapshot_id:string|null};
  existing_explanation:unknown; evidence:SourceEvidence[]; annotations:Annotation[];
  reply_to?:{question_id:string;result_id:string|null;question:string;answer:string|null;evidence:SourceEvidence[];uncertainties:string[];source_snapshot_id:string;historical:boolean}|null;
  recent_questions:{question_id:string;question:string;answer:string|null;evidence:SourceEvidence[];source_snapshot_id:string}[];
}
export interface ReadingAnswer { schema_version:'reading-1'; question_id:string; binding:RunBinding; answer:string; evidence:SourceEvidence[]; uncertainties:string[] }
export interface ReadingQuestion {
  question_id:string; project_id:string;feature_id:string;scenario_id:string;question_revision_id:string;
  result_id:string|null;target:ReadingTarget;source_snapshot_id:string;source_mode:'bound'|'latest';
  question:string;created_at:string;run_id:string;run_ids:string[];context:ReadingContext;answer?:ReadingAnswer;
  submission_key:string;previous_question_id?:string;
}
export interface ReadingAsk {
  project_id:string;scenario_id?:string;result_id?:string|null;target:ReadingTarget;question:string;
  source_mode?:'bound'|'latest';mode?:ExecutionMode;submission_key:string;correction?:boolean;previous_question_id?:string;
}
export const overviewTotalMinutes = 10;
export const overviewIdleMinutes = 3;
export interface Run {
  binding: RunBinding; provider_id: ProviderId; status: string; created_at: string; ended_at?: string;
  execution_mode?: ExecutionMode;
  question: string; title: string; error?: string; external_id?: string; pid?: number;
  previous_run_id?: string; submission_key: string; output_path: string; runtime_version?: string;
  validation?: { structure: string; anchors: string; errors: string[]; semantic: string };
  origin?: 'manual_import' | 'mcp';
  mcp_connection_id?: string;
  mcp_request_key?:string;
  imported_binding?: RunBinding;
  native_ui?: 'dsh-web';
  reading_question_id?:string;
  reading_context?:ReadingContext;
  overview_format?:'overview-1';
  execution_started_at?:string;
  overview_candidate_ready?:boolean;
  feature_graph_format?:'feature-graph-1';
  dsh_overview_format?:'overview-1';
  dsh_function_format?:'function-1';
  repair_from_run_id?:string;
  dsh_return_attempt?:number;
  dsh_return_errors?:string[];
  overview_from_result_id?:string;
  overview_parent_run_id?:string;
  overview_followup_mode?:'direct'|'dispatch'|'manual';
  development_task_id?:string;
  refresh_from_result_id?:string;
}
export function hasFunctionGraphs(result:AnalysisResult):boolean {
  const functions=new Set(result.nodes.filter(node=>node.kind==='function').map(node=>node.node_id));
  return !!result.function_walkthroughs?.some(path=>path.steps.some(step=>{
    if(!['call','callback','dispatch'].includes(step.kind)||!step.from_node_id||!step.to_node_id||!functions.has(step.from_node_id)||!functions.has(step.to_node_id))return false;
    const kind=step.kind==='call'?'sync_call':'execution_boundary';
    return result.edges.some(edge=>edge.kind===kind&&edge.status==='source_supported'&&edge.source_node_id===step.from_node_id&&edge.target_node_id===step.to_node_id);
  }));
}
export interface Explanation { result_id: string; scenario_id: string; created_at: string; source_status: string; result: AnalysisResult }
export interface ProjectFreshness { snapshot_id: string; changed_files: string[]; checked_at: string }
export interface ProviderProfile { provider_id: ProviderId; requested_name: string; product: string; status: string; version?: string; path?: string; reason: string; transport: string; auth: string; capabilities: Record<string,string>; checked_at: string }
export interface ReadingState {
  entrance: 'overview' | 'walk'; view: string; scenario_id: string; result_id: string;
  selected: string; file: string; evidence_id: string; source_snapshot_id: string;
  mode: 'normal' | 'source' | 'compare'; left_width: number; right_width: number;
  catalog_hidden: boolean; pinned: boolean; detail_tab: string; expanded: string[];
  scroll: Record<string, {top:number;left:number}>; zoom: number; stage: string; compare_id: string; linked: boolean;
  view_states?: Record<string, Pick<ReadingState,'selected'|'file'|'evidence_id'|'source_snapshot_id'|'mode'|'detail_tab'|'zoom'|'stage'|'result_id'>>;
  files_open?: boolean;
  summary_expanded?: boolean;
  graph_scope?: 'focus' | 'all';
  presentation_version?: number;
  architecture_version?: number;
  reading_path?: string;
  function_path?: string;
  function_mode?: 'calls'|'time';
  reading_focus?: string;
  feature_reading_version?: number;
}
export interface AnalysisRequest { project_analysis?:true; project_id:string; scenario_id:string; source_snapshot_id:string; question_revision_id?:string; created_at?:string; development_task_id?:string }
export interface WorkspaceData { projects: Project[]; features: Feature[]; scenarios: Scenario[]; revisions: Revision[]; annotations: Annotation[]; runs: Run[]; explanations: Explanation[]; providers: ProviderProfile[]; snapshots: Snapshot[]; project_freshness?: Record<string, ProjectFreshness>; requested_analysis?:AnalysisRequest; questions?:ReadingQuestion[]; development_tasks?:import('./engineering').EngineeringTask[]; default_engine?:ExecutionMode }
export interface ArcApi {
  invoke<T = any>(operation: string, args?: unknown): Promise<T>;
  onEvent(callback: (event: { type: string; [key: string]: any }) => void): () => void;
}
declare global { interface Window { arc: ArcApi } }
