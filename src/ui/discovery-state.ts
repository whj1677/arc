import {discoveredFeature} from '../discovered-feature';
import {hasFunctionGraphs,isExecutionMode,type ExecutionMode,type Explanation,type Run,type WorkspaceData} from '../shared';

export const analysisModes={
  codex:{name:'Codex',option:'Codex 直连 · 推荐',start:'启动 Codex 分析',retry:'通过 Codex 重新分析',
    description:'自动调用本机 Codex，无需手动建会话'},
  dsh:{name:'DSH',option:'DSH · DeepSeek Harness',start:'启动 DSH 分析',retry:'通过 DSH 重新分析',
    description:'自动调用本机 DSH Web，无需手动建会话'},
  codex_desktop:{name:'Codex 桌面会话',option:'Codex 桌面会话',start:'派发 Codex 分析',retry:'通过 Codex 桌面会话重新分析',
    description:'派发到已绑定的 Codex 桌面端对话'},
  mcp:{name:'MCP',option:'外部 Agent · MCP',start:'准备 MCP 分析任务',retry:'准备 MCP 重新分析',
    description:'保存任务，由外部对话自行领取'},
} satisfies Record<ExecutionMode,{name:string;option:string;start:string;retry:string;description:string}>;
export type AnalysisMode=ExecutionMode;
export const isAnalysisMode=isExecutionMode;

// A prepared MCP request is not a running Agent. Keep the distinction after restart.
export function waitingForAgent(data:WorkspaceData,scenarioId:string){
 const request=data.requested_analysis,scene=data.scenarios.find(s=>s.scenario_id===scenarioId);
 if(!request||!scene||scene.archived||request.scenario_id!==scenarioId||request.project_id!==scene.project_id)return false;
 const project=data.projects.find(p=>p.project_id===scene.project_id);
 if(request.source_snapshot_id!==project?.snapshot_id||(request.question_revision_id&&request.question_revision_id!==scene.question_revision_id))return false;
 if(data.explanations.some(e=>e.scenario_id===scenarioId&&e.result.binding.question_revision_id===scene.question_revision_id&&e.result.binding.source_snapshot_id===request.source_snapshot_id&&(!request.created_at||!e.created_at||e.created_at>=request.created_at)))return false;
 return !data.runs.some(r=>!r.reading_question_id&&r.binding.scenario_id===scenarioId&&(['queued','running','validating','cancel_requested'].includes(r.status)||!request.created_at||r.created_at>=request.created_at));
}

const graphStatuses:Record<string,string>={queued:'已排队',waiting_agent:'等待领取',running:'分析中',validating:'正在校验',cancel_requested:'正在停止',failed:'分析失败',blocked_external:'连接受阻',cancelled:'已停止',unknown:'状态待核查'};

export function catalogGraphState(data:WorkspaceData,overview:Explanation,nodeId:string){
  const catalog=overview.result,scope=catalog.binding;
  const project=data.projects.find(item=>item.project_id===scope.project_id);
  const feature=discoveredFeature(data.features,data.explanations,catalog,nodeId,project?.snapshot_id||'');
  const scene=feature&&data.scenarios.find(s=>s.project_id===scope.project_id&&s.feature_id===feature.feature_id&&s.kind==='feature_overview');
  // A fresh analysis of the same feature may outlive its catalog. Historical catalogs stay snapshot-bound.
  const latestCatalog=data.explanations.findLast(e=>e.scenario_id===overview.scenario_id&&e.result.feature_catalog);
  const latestSnapshot=latestCatalog?.result_id===overview.result_id ? project?.snapshot_id : undefined;
  const matches=(b:Run['binding'])=>!!scene&&b.project_id===scope.project_id&&b.feature_id===feature?.feature_id&&b.scenario_id===scene.scenario_id
    &&(b.source_snapshot_id===scope.source_snapshot_id||b.source_snapshot_id===latestSnapshot)&&b.question_revision_id===scene.question_revision_id;
  const reports=data.explanations.filter(e=>e.scenario_id===scene?.scenario_id&&matches(e.result.binding));
  const readyReports=reports.filter(e=>hasFunctionGraphs(e.result));
  const ready=readyReports.findLast(e=>e.result.binding.source_snapshot_id===latestSnapshot)??readyReports.at(-1);
  const latest=reports.findLast(e=>e.result.binding.source_snapshot_id===latestSnapshot)??reports.at(-1);
  const runs=data.runs.filter(r=>!r.reading_question_id&&matches(r.binding));
  const run=runs.filter(r=>['queued','waiting_agent','running','validating','cancel_requested'].includes(r.status)).at(-1)??runs.at(-1);
  const waiting=!!scene&&scope.source_snapshot_id===project?.snapshot_id&&waitingForAgent(data,scene.scenario_id);
  const status=run&&graphStatuses[run.status]|| (waiting?'等待领取':latest&&!hasFunctionGraphs(latest.result)?'证据缺口':'');
  return {ready,latest,run,status,archived:!!(feature?.archived||scene?.archived)};
}
