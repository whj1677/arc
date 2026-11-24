/**
 * Arc 自有拟定初始合同 v1.0；不是全产品数据模型，也不是供应商原生 SDK。
 * 供应商 ACP、SDK、CLI 或 OpenAPI 由适配器映射到本合同。
 * 所有序列化字段使用 snake_case。接口不保存账号、密钥或令牌值。
 * TypeScript 只提供静态类型；运行时仍须校验 JSON、跨对象引用和源码锚点。
 */

export type ProviderId = 'codex' | 'dsh' | 'workbuddy' | 'kimi' | 'demo';
export type Id = string;
export type Sha256 = string;

/** 一次 run 创建时复制并冻结；切页、改问题或换源码不得改写旧绑定。 */
export interface RunBinding {
  readonly project_id: Id;
  readonly feature_id: Id;
  readonly scenario_id: Id;
  readonly question_revision_id: Id;
  readonly source_snapshot_id: Id;
  readonly run_id: Id;
}

/** 供应商标识独立存储，不得拿 session_id 替代场景或 run_id。 */
export interface ExternalIds {
  readonly external_provider_id?: string;
  readonly external_session_id?: string;
  readonly external_thread_id?: string;
  readonly external_task_id?: string;
  readonly external_run_id?: string;
}

export interface ProviderRunContext extends ExternalIds {
  readonly provider_id: ProviderId;
  readonly connection_id: Id;
  readonly adapter_version: string;
  readonly runtime_version?: string;
}

export interface RunRef {
  readonly binding: RunBinding;
  readonly provider: ProviderRunContext;
}

export type CapabilityName =
  | 'submit_task' | 'event_stream' | 'get_status' | 'cancel_run'
  | 'followup' | 'restore' | 'session_isolation' | 'workspace_binding'
  | 'structured_output' | 'artifact_access' | 'permission_roundtrip'
  | 'source_read' | 'code_write';

export interface CapabilityEvidence {
  readonly kind: 'official_documentation' | 'handshake' | 'integration_check';
  readonly reference: string;
  readonly checked_at: string;
  readonly note: string;
}

export interface CapabilityEntry {
  readonly support: 'native' | 'emulated' | 'unsupported' | 'unknown';
  /** 必填：说明模拟方式、限制或尚未核验原因，不能只给布尔值。 */
  readonly reason: string;
  readonly version?: string;
  readonly evidence?: readonly CapabilityEvidence[];
}

export type CapabilityMap = Readonly<Record<CapabilityName, CapabilityEntry>>;

export type ProductIdentity = {
  readonly requested_name: string;
  readonly status: 'pending';
  readonly candidate_product?: string;
  readonly reason: string;
} | VerifiedProductIdentity;

export interface VerifiedProductIdentity {
  readonly requested_name: string;
  readonly status: 'verified';
  readonly resolved_product: string;
  readonly publisher: string;
  readonly verification_reference: string;
}

export type AuthReport = {
  readonly status: 'not_required';
  readonly reason: string;
} | {
  readonly status: 'authenticated';
  readonly method: string;
  readonly granted_scopes: readonly string[];
  readonly expires_at?: string;
} | {
  readonly status: 'auth_required' | 'expired' | 'unsupported' | 'unknown';
  readonly reason: string;
};

export type ReadyAuth = Extract<AuthReport, {
  readonly status: 'not_required' | 'authenticated';
}>;

export interface ProbeBase {
  readonly provider_id: ProviderId;
  readonly connection_id: Id;
  readonly transport: string;
  readonly runtime_version?: string;
  readonly capabilities: CapabilityMap;
  readonly checked_at: string;
}

/** 包括 workbuddy 在内，身份未核验或授权未知时都不能 ready。 */
export type ProbeReport = ProbeBase & ({
  readonly status: 'ready';
  readonly identity: VerifiedProductIdentity;
  readonly auth: ReadyAuth;
} | {
  readonly status: 'unconfigured' | 'not_installed' | 'auth_required'
    | 'incompatible' | 'offline' | 'error';
  readonly identity: ProductIdentity;
  readonly auth: AuthReport;
  readonly reason: string;
});

export interface ProbeRequest {
  readonly connection_id: Id;
  /** 探测不能偷偷安装程序、改共享 profile、创建任务或替换登录。 */
  readonly allow_runtime_start: boolean;
}

export interface AuthRequest {
  readonly connection_id: Id;
  readonly requested_scopes: readonly string[];
  readonly authorization_reference: string;
}

export type AuthFlow = {
  readonly state: 'interaction_required';
  readonly flow_id: Id;
  readonly instruction: string;
  readonly official_authorization_url?: string;
} | {
  readonly state: 'completed';
  readonly auth: ReadyAuth;
};

export interface WorkspaceBase {
  readonly workspace_id: Id;
  readonly root_path: string;
  /** 样例可相对请求文件；正式本地工程解析后必须归一到授权根。 */
  readonly path_resolution: 'absolute' | 'request_directory';
  readonly filesystem_kind: 'local' | 'remote_snapshot';
  readonly allowed_read_paths: readonly string[];
  readonly source_snapshot_manifest_path: string;
}

export interface ReadOnlyWorkspace extends WorkspaceBase {
  readonly access_mode: 'read_only';
  readonly allowed_write_paths?: never;
  readonly write_authorization_id?: never;
}

export interface ScopedWriteWorkspace extends WorkspaceBase {
  readonly access_mode: 'scoped_write';
  readonly allowed_write_paths: readonly string[];
  readonly write_authorization_id: Id;
  readonly isolated_checkout_id?: Id;
}

export interface RunRequestBase {
  readonly schema_version: '1.0';
  readonly fictional: boolean;
  readonly binding: RunBinding;
  readonly provider: {
    readonly provider_id: ProviderId;
    readonly connection_id: Id;
  };
  readonly title: string;
  readonly question: string;
  readonly acceptance_criteria: readonly string[];
  readonly instructions: readonly string[];
  readonly policy: {
    readonly respect_workspace_rules: true;
    readonly command_transport: 'argv_stdin';
    readonly permission_policy: 'ask_on_new_scope';
    readonly network_access: 'disabled' | 'explicitly_authorized';
    readonly provider_data_scope: 'none' | 'selected_evidence' | 'allowed_read_paths';
    readonly data_transfer_authorization_id?: Id;
  };
  readonly limits: {
    readonly max_runtime_seconds: number;
    readonly max_output_bytes: number;
  };
  readonly output_contract: {
    readonly schema_version: '1.0';
    readonly schema_path: string;
    readonly format: 'json';
  };
}

/** 默认走读只读；实现任务必须另行明确写入范围和已有授权。 */
export type RunRequest = RunRequestBase & ({
  readonly task_kind: 'analysis';
  readonly workspace: ReadOnlyWorkspace;
} | {
  readonly task_kind: 'implementation';
  readonly workspace: ReadOnlyWorkspace | ScopedWriteWorkspace;
});

/** 仅表示任务生命周期，不能复用作证据强度、覆盖率或源码新鲜度。 */
export type TaskStatus = 'queued' | 'running' | 'waiting_for_permission'
  | 'waiting_for_input' | 'cancel_requested' | 'completed' | 'failed'
  | 'cancelled' | 'unknown';
export type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled';

export interface RunStatusSnapshot {
  readonly run_ref: RunRef;
  readonly task_status: TaskStatus;
  readonly observed_at: string;
  readonly provider_stop_reason?: string;
  /** 断连时远端可能仍在工作；不能因此把 task_status 改成 cancelled。 */
  readonly connection_status: 'connected' | 'disconnected' | 'unknown';
  readonly last_event_cursor?: string;
}

export interface SubmitReceipt {
  readonly run_ref: RunRef;
  readonly accepted_at: string;
  readonly task_status: 'queued' | 'running';
}

export interface EventSubscriptionRequest {
  readonly run_ref: RunRef;
  readonly after_cursor?: string;
}

export interface EventBase {
  readonly event_id: Id;
  readonly run_ref: RunRef;
  readonly occurred_at: string;
  readonly cursor?: string;
  readonly provider_event_id?: string;
  readonly sequence?: number;
}

export interface ArtifactReadRequest {
  readonly run_ref: RunRef;
  readonly artifact_id: Id;
  /** 限制解码后的原始字节数；不能用字符串长度代替。 */
  readonly max_bytes: number;
  readonly authorization_reference: Id;
}

export interface ArtifactContent {
  readonly run_ref: RunRef;
  readonly artifact_id: Id;
  readonly media_type: string;
  readonly byte_length: number;
  readonly content_sha256: Sha256;
  readonly body: {
    readonly encoding: 'utf-8';
    readonly text: string;
  } | {
    readonly encoding: 'base64';
    readonly data_base64: string;
  };
}

export interface PermissionPrompt {
  readonly permission_request_id: Id;
  readonly tool_name: string;
  readonly description: string;
  readonly requested_scope: readonly string[];
  readonly choices: readonly {
    readonly choice_id: string;
    readonly label: string;
    readonly effect: 'allow_once' | 'allow_scope' | 'deny';
  }[];
}

/** 供应商完成事件不保证分析已经有效；产物后续进入 Arc 校验链。 */
export type AdapterEvent = EventBase & ({
  readonly type: 'status_changed';
  readonly task_status: TaskStatus;
} | {
  readonly type: 'text_delta';
  readonly text: string;
} | {
  readonly type: 'artifact_available';
  readonly artifact_id: Id;
  readonly media_type: string;
  readonly size_bytes?: number;
} | {
  readonly type: 'permission_requested';
  readonly permission: PermissionPrompt;
} | {
  readonly type: 'provider_finished';
  readonly task_status: TerminalTaskStatus;
  readonly provider_stop_reason?: string;
} | {
  readonly type: 'connection_changed';
  readonly connection_status: 'connected' | 'disconnected' | 'unknown';
  readonly reason: string;
});

export interface CancelRequest {
  readonly run_ref: RunRef;
  readonly cancel_request_id: Id;
  readonly reason: string;
}

export type CancelReceipt = {
  readonly state: 'requested';
  readonly remote_termination_confirmed: false;
  readonly reason: string;
} | {
  readonly state: 'cancelled_confirmed';
  readonly remote_termination_confirmed: true;
  readonly task_status: 'cancelled';
} | {
  readonly state: 'already_terminal';
  readonly remote_termination_confirmed: false;
  readonly task_status: TerminalTaskStatus;
  readonly reason: string;
};

export interface FollowupRequest {
  readonly previous_run_ref: RunRef;
  /** 新追问创建新 run；要求原供应商会话续接，不能静默新建会话。 */
  readonly next_request: RunRequest;
  readonly continuity: 'same_provider_session';
}

export interface RestoreRequest {
  readonly run_ref: RunRef;
  readonly after_cursor?: string;
}

export interface RestoreReceipt {
  /** 恢复原任务观察/会话，不允许实现为重复 submit。 */
  readonly restored_run_ref: RunRef;
  readonly status: RunStatusSnapshot;
  readonly replay_from_cursor?: string;
}

export type AdapterError = {
  readonly code: 'unsupported';
  readonly capability: CapabilityName | 'authentication';
  readonly reason: string;
  readonly retryable: false;
} | {
  /** 可能已被接收：必须先对账，不得依据一般 retryable 逻辑重发。 */
  readonly code: 'submission_unknown';
  readonly binding: RunBinding;
  readonly connection_id: Id;
  readonly reason: string;
  readonly retryable: false;
  readonly reconciliation: 'query_status_or_restore';
} | {
  readonly code: 'identity_unverified' | 'auth_required' | 'scope_denied'
    | 'invalid_request' | 'provider_unavailable' | 'incompatible_version'
    | 'protocol_error' | 'run_not_found' | 'continuity_lost' | 'budget_exceeded';
  readonly reason: string;
  readonly retryable: boolean;
};

export type OperationResult<T> = {
  readonly ok: true;
  readonly mode: 'native' | 'emulated';
  readonly value: T;
} | {
  readonly ok: false;
  readonly error: AdapterError;
};

export interface AgentAdapter {
  readonly provider_id: ProviderId;
  readonly adapter_version: string;
  probe(request: ProbeRequest): Promise<ProbeReport>;
  get_auth_status(connection_id: Id): Promise<AuthReport>;
  authenticate(request: AuthRequest): Promise<OperationResult<AuthFlow>>;
  submit(request: RunRequest): Promise<OperationResult<SubmitReceipt>>;
  events(request: EventSubscriptionRequest): Promise<OperationResult<AsyncIterable<AdapterEvent>>>;
  /** 按绑定和产物 ID 读取；供应商 locator 仅在适配器内部保存，前端不得任意 fetch。 */
  read_artifact(request: ArtifactReadRequest): Promise<OperationResult<ArtifactContent>>;
  get_status(run_ref: RunRef): Promise<OperationResult<RunStatusSnapshot>>;
  cancel(request: CancelRequest): Promise<OperationResult<CancelReceipt>>;
  followup(request: FollowupRequest): Promise<OperationResult<SubmitReceipt>>;
  restore(request: RestoreRequest): Promise<OperationResult<RestoreReceipt>>;
  respond_to_permission(request: {
    readonly run_ref: RunRef;
    readonly permission_request_id: Id;
    readonly choice_id: string;
    readonly authorization_reference: Id;
  }): Promise<OperationResult<{ readonly acknowledged: boolean }>>;
}

/** 下列结构与 analysis-result.schema.json 对应，由 Arc 负责最终校验。 */
export type ClaimStatus = 'source_supported' | 'inferred' | 'user_clue' | 'unknown';
export type NodeKind = 'stage' | 'function' | 'resource' | 'decision' | 'execution_boundary';
export type EdgeKind = 'sync_call' | 'return' | 'queue_send' | 'queue_receive'
  | 'data_publish' | 'data_read' | 'dependency' | 'control_flow' | 'execution_boundary';

export interface SourceEvidence {
  readonly evidence_id: Id;
  readonly source_snapshot_id: Id;
  /** 相对快照根的 POSIX 路径，禁止绝对路径、.. 和快照根外的软链接。 */
  readonly path: string;
  readonly line_start: number;
  readonly line_end: number;
  /** 整个文件原始字节的 SHA-256；不得先转码或规范化换行，也不是片段哈希。 */
  readonly content_sha256: Sha256;
  readonly symbol_id?: string;
  readonly role: 'definition' | 'callsite' | 'read' | 'write' | 'declaration' | 'context';
  readonly note: string;
}

export interface NodeIO {
  readonly io_id: Id;
  readonly name: string;
  readonly availability: 'specified' | 'partial' | 'unknown';
  /** 未知类型必须为 null；不能由模型捏造类型或值。 */
  readonly data_type: string | null;
  readonly value_or_shape: string | null;
  readonly description: string;
  readonly claim_ids: readonly Id[];
  readonly evidence_ids: readonly Id[];
}

export interface ExecutionContext {
  readonly kind: 'task' | 'isr' | 'callback' | 'startup' | 'caller' | 'unknown';
  /** 确认的上下文标识或分析分组标识；未知为 null，必须结合 status 阅读。 */
  readonly identity: string | null;
  readonly label: string;
  readonly status: ClaimStatus;
  readonly claim_ids: readonly Id[];
  readonly evidence_ids: readonly Id[];
}

export interface AnalysisNode {
  /** Optional for older results. Exact function identity, distinct from a business stage. */
  readonly function_details?: {
    readonly symbol:string;
    readonly signature:string|null;
    readonly definition_evidence_id:Id;
    /** null = not established; [] = explicitly no parameters/return value. */
    readonly parameter_io_ids:readonly Id[]|null;
    readonly return_io_ids:readonly Id[]|null;
  };
  readonly node_id: Id;
  readonly kind: NodeKind;
  readonly label: string;
  readonly description: string;
  /** Whole-file/folder purpose explicitly bound to this result's snapshot. */
  readonly source_scope?: {readonly kind:'file'|'folder';readonly path:string};
  readonly execution_context: ExecutionContext;
  /** 只表示图中的聚合归属，不表示调用或先后；禁止自指和父子循环。 */
  readonly parent_node_id?: Id;
  /** 工程的执行轮次标识，区别于 Arc 的 run_id；无实际依据时省略。 */
  readonly execution_episode_id?: Id;
  readonly inputs: readonly NodeIO[];
  readonly outputs: readonly NodeIO[];
  readonly claim_ids: readonly Id[];
  readonly evidence_ids: readonly Id[];
}

export interface AnalysisEdge {
  readonly edge_id: Id;
  readonly kind: EdgeKind;
  readonly source_node_id: Id;
  readonly target_node_id: Id;
  readonly label: string;
  readonly status: ClaimStatus;
  readonly condition?: string;
  /** Explicit output -> input mapping. Absence does not imply data transfer. */
  readonly transfers?: readonly {
    readonly label: string;
    readonly source_output_id: Id;
    readonly target_input_id: Id;
    readonly status: ClaimStatus;
    readonly claim_ids: readonly Id[];
    readonly evidence_ids: readonly Id[];
  }[];
  /** 仅用于 return：引用方向相反的 sync_call，不能由画布邻近关系猜测。 */
  readonly flow_role?: 'main' | 'alternative' | 'exception';
  readonly related_call_edge_id?: Id;
  /** source_supported 关系至少引用一个同状态且有证据的 claim。 */
  readonly claim_ids: readonly Id[];
  readonly evidence_ids: readonly Id[];
}

export type TransferSpec = NonNullable<AnalysisEdge['transfers']>[number];

export interface AnalysisClaim {
  readonly claim_id: Id;
  readonly statement: string;
  /** source_supported 只表示当前范围有源码依据，不表示全局语义为真。 */
  readonly status: ClaimStatus;
  readonly rationale: string;
  readonly limitations: readonly string[];
  readonly evidence_ids: readonly Id[];
  readonly targets: {
    readonly node_ids: readonly Id[];
    readonly edge_ids: readonly Id[];
    readonly io_ids: readonly Id[];
  };
}

export interface AnalysisGap {
  readonly gap_id: Id;
  readonly kind: 'missing_implementation' | 'missing_entry' | 'missing_trace'
    | 'missing_contract' | 'unsupported_language' | 'out_of_scope' | 'other';
  readonly question: string;
  readonly reason?: string;
  readonly impact: string;
  readonly suggested_action: string;
  readonly related_node_ids: readonly Id[];
  readonly related_edge_ids?: readonly Id[];
  readonly claim_ids: readonly Id[];
  readonly evidence_ids: readonly Id[];
}

/** Optional source-bound reading copy. It describes the same saved result; it is not executable workflow. */
export interface ReadingGuide {
  readonly steps: readonly {id:string;title:string;actor:string;text:string;outcome:string;detail:string;node_ids:readonly Id[];evidence_ids:readonly Id[]}[];
  readonly roles: readonly {id:string;title:string;duty:string;files:readonly string[];evidence_ids:readonly Id[]}[];
  readonly handoffs: readonly {id:string;from:string;to:string;label:string;kind:string;send:string;receive:string;detail:string;evidence_ids:readonly Id[]}[];
  readonly files: readonly {path:string;title:string;description:string;detail:string;step_ids:readonly string[];evidence_ids:readonly Id[]}[];
  readonly paths: readonly {id:string;label:string;entry:string;intro:string;boundary:string;step_ids:readonly string[];lanes:readonly {label:string;step_ids:readonly string[];link_labels:readonly string[]}[];failure_ids:readonly string[];role_ids:readonly string[];handoff_ids:readonly string[];files:readonly string[]}[];
}

export interface FunctionWalkthrough {
  readonly id:Id;
  readonly label:string;
  readonly trigger:string;
  readonly entry_node_id:Id;
  readonly boundary:string;
  readonly evidence_ids:readonly Id[];
  readonly steps:readonly {
    readonly id:Id;
    readonly kind:'entry'|'call'|'callback'|'dispatch'|'return'|'work';
    readonly from_node_id:Id|null;
    readonly to_node_id:Id;
    readonly text:string;
    readonly input:string;
    readonly output:string;
    readonly condition:string;
    readonly evidence_ids:readonly Id[];
  }[];
}

export interface CatalogReading {
  readonly node_id: Id;
  readonly entry: string;
  readonly outcome: string;
  readonly steps: readonly { readonly text: string; readonly evidence_ids: readonly Id[] }[];
  readonly boundary: string;
}

export interface AnalysisResult {
  /** Ordered, source-bound reading paths. Never inferred from graph layout or edge array order. */
  readonly function_walkthroughs?: readonly FunctionWalkthrough[];
  readonly reading_guide?: ReadingGuide;
  /** 功能节点说明用途，逐项阅读内容绑定本次结果的源码依据。历史目录可能只有节点。 */
  readonly feature_catalog?: { readonly scope: string; readonly groups: readonly {readonly label:string; readonly node_ids:readonly Id[]}[]; readonly readings?: readonly CatalogReading[] };
  /** 组件和连接必须引用本结果的节点/关系；不由 UI 猜测系统组成。 */
  readonly architecture?: { readonly node_ids: readonly Id[]; readonly edge_ids: readonly Id[] };
  readonly schema_version: '1.0';
  readonly fictional: boolean;
  readonly result_id: Id;
  readonly binding: RunBinding;
  readonly provider: ProviderRunContext;
  readonly summary: {
    readonly text: string;
    readonly claim_ids: readonly Id[];
  };
  readonly coverage: {
    readonly covered_scope: readonly string[];
    readonly unresolved_scope: readonly string[];
  };
  readonly nodes: readonly AnalysisNode[];
  readonly edges: readonly AnalysisEdge[];
  readonly claims: readonly AnalysisClaim[];
  readonly evidence: readonly SourceEvidence[];
  readonly gaps: readonly AnalysisGap[];
}

/** 两道校验分开记录。结构通过不能跳过来源校验；哈希通过也不自动证实结论。 */
export interface AnalysisValidationReport {
  readonly result_id: Id;
  readonly structure: {
    readonly status: 'pending' | 'passed' | 'failed';
    readonly errors: readonly string[];
  };
  readonly source_anchors: {
    readonly status: 'pending' | 'passed' | 'partial' | 'failed';
    readonly errors: readonly string[];
  };
  readonly freshness: {
    readonly question: 'current' | 'superseded' | 'unknown';
    readonly source: 'current' | 'changed' | 'unknown';
  };
}
