import type {EngineeringTask} from './engineering';

export function effectiveTaskBoundaries(task:EngineeringTask) {
  return task.boundaries??{
    non_goals:task.requirement_package?.non_goals??[],
    revoked:task.requirement_package?.revoked??[],
  };
}

/** Only pass the requirement and acceptance criteria the user reviewed. */
export function approvedRequirement(task:EngineeringTask) {
  return {
    behaviors:task.requirement_package!.behaviors,
    scope:task.approval!.scope,
    steps:(task.steps??[]).filter(step=>step.status!=='superseded').map(({step_id,title,change,criteria})=>({
      step_id,title,change,criteria:criteria.map(({criterion_id,text})=>({criterion_id,text})),
    })),
    decisions:task.decisions,
  };
}
