import type {Project} from '../shared';

// Source-only imports often share generic names. Keep their parent visible
// without changing the stored project identity or assuming product semantics.
export function projectLabel(project:Pick<Project,'name'|'root_path'>){
 const parts=project.root_path.replace(/\\/g,'/').replace(/\/+$/,'').split('/').filter(Boolean);
 return /^(src|app|source|server|web)$/i.test(project.name)&&parts.length>1
  ?`${parts.at(-2)} · ${project.name}`:project.name;
}
