import type { AnalysisResult, RunBinding, ProviderId, SourceEvidence } from '../contracts/agent-adapter';
export type { AnalysisResult, RunBinding, SourceEvidence, ProviderId };
export type {ReadingGuide} from '../contracts/agent-adapter';
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
export interface Annotation { annotation_id: string; project_id: string; scenario_id: string; result_id: string | null; object_id: string | null; source_snapshot_id: string; text: string; created_at: string }
export interface Run {
  binding: RunBinding; provider_id: ProviderId; status: string; created_at: string; ended_at?: string;
  question: string; title: string; error?: string; external_id?: string; pid?: number;
  previous_run_id?: string; submission_key: string; output_path: string; runtime_version?: string;
  validation?: { structure: string; anchors: string; errors: string[]; semantic: string };
  origin?: 'manual_import' | 'mcp';
  mcp_connection_id?: string;
  imported_binding?: RunBinding;
  native_ui?: 'dsh-web';
}
export interface Explanation { result_id: string; scenario_id: string; created_at: string; source_status: string; result: AnalysisResult }
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
  reading_focus?: string;
  feature_reading_version?: number;
}
export interface AnalysisRequest { project_id:string; scenario_id:string; source_snapshot_id:string; question_revision_id?:string; created_at?:string }
export interface WorkspaceData { projects: Project[]; features: Feature[]; scenarios: Scenario[]; revisions: Revision[]; annotations: Annotation[]; runs: Run[]; explanations: Explanation[]; providers: ProviderProfile[]; snapshots: Snapshot[]; requested_analysis?:AnalysisRequest }
export interface ArcApi {
  invoke<T = any>(operation: string, args?: unknown): Promise<T>;
  onEvent(callback: (event: { type: string; [key: string]: any }) => void): () => void;
}
declare global { interface Window { arc: ArcApi } }
