import React from 'react';
import type {Project} from '../shared';
import {projectLabel} from './project-label';

type WorkbenchView='overview'|'walk'|'materials'|'engineering';
type Props={
  projects:Project[];
  projectId:string;
  active:WorkbenchView;
  onProject:(id:string)=>void;
  onOpen:()=>void;
  onSettings:()=>void;
  onNavigate:(view:WorkbenchView)=>void;
};
const navigationGroups=[{label:'理解工程',items:[{view:'overview',label:'工程全貌',icon:'▦'},{view:'walk',label:'功能走读',icon:'↝'},{view:'materials',label:'工程资料',icon:'▤'}]},{label:'协作开发',items:[{view:'engineering',label:'需求与开发',icon:'✓'}]}] as const;

export function WorkbenchNavigation({
  projects,projectId,active,onProject,onOpen,onSettings,onNavigate
}:Props){
  const current=projects.find(project=>project.project_id===projectId);
  return <aside className="workbench-navigation" aria-label="ARC 工程工作台导航">
    <div className="workbench-brand">
      <span className="workbench-brand-mark" aria-hidden="true">ARC</span>
      <div className="workbench-brand-copy">
        <strong>ARC 工程工作台</strong>
        <small>从源码理解到开发记录</small>
      </div>
    </div>
    <label className="workbench-project">
      <span>当前工程</span>
      <select aria-label="当前工程" title={current?.root_path||'选择本地工程'} value={projectId} onChange={event=>onProject(event.target.value)}>
        <option value="">选择工程</option>
        {projects.map(project=><option key={project.project_id} value={project.project_id} title={project.root_path}>{projectLabel(project)}</option>)}
      </select>
    </label>
    <nav className="workbench-primary-nav" aria-label="主要导航">
      {navigationGroups.map(group=><section className="workbench-nav-group" key={group.label}><h2>{group.label}</h2>{group.items.map(item=><button type="button" key={item.view} title={item.label} aria-label={item.label} aria-current={active===item.view?'page':undefined} onClick={()=>onNavigate(item.view)}>
        <span className="workbench-nav-icon" aria-hidden="true">{item.icon}</span>
        <span className="workbench-nav-label">{item.label}</span>
      </button>)}</section>)}
    </nav>
    <div className="workbench-side-actions">
      <button type="button" title="打开工程" aria-label="打开工程" onClick={onOpen}><span aria-hidden="true">＋</span><span className="workbench-nav-label">打开工程</span></button>
      <button type="button" title="连接与设置" aria-label="连接与设置" onClick={onSettings}><span aria-hidden="true">⚙</span><span className="workbench-nav-label">连接与设置</span></button>
    </div>
  </aside>;
}
