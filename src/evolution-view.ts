export type EvolutionSourceMode = 'task_blueprint' | 'task_actual' | 'workspace_radar';

export interface EvolutionApproachStep {
  id: string;
  title: string;
  detail: string;
  files: string[];
  status?: 'planned' | 'done' | 'partial' | 'blocked';
}

export interface EvolutionAssumption {
  id: string;
  text: string;
  source: 'requirement_package' | 'review_blocker' | 'unresolved';
  file?: string;
  fix?: string;
}

export interface EvolutionDrift {
  planned_count: number;
  actual_count: number;
  matched_files: string[];
  untouched_planned_files: string[];
  out_of_scope_files: string[];
  overlap_files: string[];
  attribution_pending: boolean;
}

export interface EvolutionArchModule {
  id: string;
  label: string;
  layer: string;
  layer_order: number;
  relation: 'direct' | 'neighbor' | 'gap' | 'unchanged';
  source_kind: 'overview_node' | 'directory_fallback';
  files: string[];
  changed_files: string[];
  added_symbols: number;
  removed_symbols: number;
  modified_symbols: number;
  summary?: string;
}

export interface EvolutionArchEdge {
  id: string;
  from_id: string;
  to_id: string;
  from_label: string;
  to_label: string;
  kind: 'new_cross_layer' | 'new_same_layer' | 'strengthened' | 'removed' | 'existing';
  cross_layer: boolean;
  before_count: number;
  after_count: number;
  label?: string;
  sample_call?: {
    file: string;
    line: number;
    caller_symbol: string;
    callee_symbol: string;
  };
}

export interface EvolutionArchSummary {
  mode: 'overview' | 'directory_fallback' | 'empty';
  architecture_result_id?: string;
  modules: EvolutionArchModule[];
  all_modules_count: number;
  omitted_modules: number;
  edges: EvolutionArchEdge[];
  new_cycles: string[][];
}

export interface EvolutionCallSite {
  file: string;
  line: number;
  caller_symbol: string;
  target_symbol: string;
  target_file: string;
  status: 'added' | 'removed' | 'unchanged';
  ambiguous?: boolean;
}

export interface EvolutionFlowStep {
  id: string;
  order: number;
  status: 'added' | 'removed' | 'modified' | 'description_only' | 'unchanged' | 'planned';
  title: string;
  subtitle?: string;
  symbol?: string;
  file?: string | null;
  line?: number;
  before_line?: number;
  after_line?: number;
  before_text?: string;
  after_text?: string;
  before_signature?: string;
  after_signature?: string;
  call_sites?: EvolutionCallSite[];
  side_effect_note?: string;
}

export interface EvolutionFeatureFlow {
  id: string;
  mode: 'walkthrough_diff' | 'walkthrough_stale' | 'ast_symbol_flow' | 'document_only' | 'empty';
  feature_id?: string;
  scenario_id?: string;
  feature_label: string;
  before_result_id?: string;
  after_result_id?: string;
  before_snapshot_id?: string;
  after_snapshot_id?: string;
  stale_notice?: string;
  steps: EvolutionFlowStep[];
  omitted_steps: number;
}

export interface EvolutionSideEffect {
  id: string;
  evidence_kind: 'ast_proved' | 'ai_inferred';
  severity: 'high' | 'warn' | 'info';
  category: 'contract_break' | 'new_cross_layer_edge' | 'new_cycle' | 'shared_state' | 'review_blocker' | 'constraint';
  title: string;
  detail: string;
  file?: string;
  line?: number;
  target_file?: string;
  target_line?: number;
  module_ids?: string[];
  fix?: string;
}

export interface EvolutionChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  is_source: boolean;
  module_id?: string;
  ownership?: string;
}

export interface EvolutionVerificationBadge {
  tone: 'ok' | 'warn' | 'danger' | 'muted';
  label: string;
  detail: string;
}

export interface EvolutionView {
  mode: EvolutionSourceMode;
  base_label: string;
  target_label: string;
  base_snapshot_id?: string;
  target_snapshot_id?: string;
  document_only: boolean;
  changed_files: EvolutionChangedFile[];
  approach: EvolutionApproachStep[];
  assumptions: EvolutionAssumption[];
  drift?: EvolutionDrift;
  architecture: EvolutionArchSummary;
  features: EvolutionFeatureFlow[];
  active_feature_index: number;
  side_effects: EvolutionSideEffect[];
  verification_badge?: EvolutionVerificationBadge;
}
