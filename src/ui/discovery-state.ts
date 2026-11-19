import {isExecutionMode,type ExecutionMode,type WorkspaceData} from '../shared';

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
