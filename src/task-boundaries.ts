import type {EngineeringTask} from './engineering';

export function taskBoundaryKey(text:string) {
  return text.replace(/`+([^`]+)`+/g,'$1').replace(/\s+/g,' ').trim().replace(/[。.;；]+$/u,'').trimEnd();
}

export { taskBoundaryKey as normalizeBoundaryText };

export function uniqueTaskBoundaries(items:string[]) {
  const seen=new Set<string>();
  return items.filter(item=>{
    const key=taskBoundaryKey(item);
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}

export function effectiveTaskBoundaries(task:EngineeringTask) {
  const bounds=task.boundaries??task.requirement_package;
  return {
    non_goals:uniqueTaskBoundaries(bounds?.non_goals??[]),
    revoked:uniqueTaskBoundaries(bounds?.revoked??[]),
  };
}

/** Only pass the requirement and acceptance criteria the user reviewed. */
export function approvedRequirement(task:EngineeringTask) {
  const pkg=task.requirement_package!;
  return {
    ...(pkg.short_title?{short_title:pkg.short_title}:{}),
    ...(pkg.rule_decisions?{rule_decisions:pkg.rule_decisions}:{}),
    behaviors:pkg.behaviors,
    ...(task.active_behavior_focus?{active_behavior_focus:task.active_behavior_focus}:{}),
    scope:task.approval?.scope??task.scope,
    steps:(task.steps??[]).filter(step=>step.status!=='superseded').map(({step_id,title,change,criteria})=>({
      step_id,title,change,criteria:criteria.map(({criterion_id,text})=>({criterion_id,text})),
    })),
    decisions:task.decisions,
  };
}
