import type {WorkspaceData} from '../shared';

// A prepared MCP request is not a running Agent. Keep the distinction after restart.
export function waitingForAgent(data:WorkspaceData,scenarioId:string){
 const request=data.requested_analysis,scene=data.scenarios.find(s=>s.scenario_id===scenarioId);
 if(!request||!scene||scene.archived||request.scenario_id!==scenarioId||request.project_id!==scene.project_id)return false;
 const project=data.projects.find(p=>p.project_id===scene.project_id);
 if(request.source_snapshot_id!==project?.snapshot_id||(request.question_revision_id&&request.question_revision_id!==scene.question_revision_id))return false;
 if(data.explanations.some(e=>e.scenario_id===scenarioId&&e.result.binding.question_revision_id===scene.question_revision_id&&e.result.binding.source_snapshot_id===request.source_snapshot_id&&(!request.created_at||!e.created_at||e.created_at>=request.created_at)))return false;
 return !data.runs.some(r=>!r.reading_question_id&&r.binding.scenario_id===scenarioId&&(['queued','running','validating','cancel_requested'].includes(r.status)||!request.created_at||r.created_at>=request.created_at));
}
