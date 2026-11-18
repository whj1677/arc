import type {WorkspaceData} from '../shared';

export const analysisModes={
  codex:{name:'Codex',option:'Codex · 派发到绑定会话',start:'启动 Codex 分析',retry:'通过 Codex 重新分析',
    description:'ARC 派发到绑定的 Codex 会话，实际领取后开始分析。'},
  dsh:{name:'DeepSeek Harness',option:'DeepSeek Harness · 本机运行',start:'启动 DeepSeek Harness 分析',retry:'通过 DeepSeek Harness 重新分析',
    description:'ARC 调用本机 DeepSeek Harness，只读分析冻结源码，进度和结果写回 ARC。'},
  mcp:{name:'MCP',option:'外部 Agent · 等待对话领取',start:'准备 MCP 分析任务',retry:'准备 MCP 重新分析',
    description:'ARC 保存分析任务，由已接入 MCP 的 Agent 对话领取。'},
};
export type AnalysisMode=keyof typeof analysisModes;
export function isAnalysisMode(value:unknown):value is AnalysisMode{
  return typeof value==='string'&&Object.hasOwn(analysisModes,value);
}

// A prepared MCP request is not a running Agent. Keep the distinction after restart.
export function waitingForAgent(data:WorkspaceData,scenarioId:string){
 const request=data.requested_analysis,scene=data.scenarios.find(s=>s.scenario_id===scenarioId);
 if(!request||!scene||scene.archived||request.scenario_id!==scenarioId||request.project_id!==scene.project_id)return false;
 const project=data.projects.find(p=>p.project_id===scene.project_id);
 if(request.source_snapshot_id!==project?.snapshot_id||(request.question_revision_id&&request.question_revision_id!==scene.question_revision_id))return false;
 if(data.explanations.some(e=>e.scenario_id===scenarioId&&e.result.binding.question_revision_id===scene.question_revision_id&&e.result.binding.source_snapshot_id===request.source_snapshot_id&&(!request.created_at||!e.created_at||e.created_at>=request.created_at)))return false;
 return !data.runs.some(r=>!r.reading_question_id&&r.binding.scenario_id===scenarioId&&(['queued','running','validating','cancel_requested'].includes(r.status)||!request.created_at||r.created_at>=request.created_at));
}
