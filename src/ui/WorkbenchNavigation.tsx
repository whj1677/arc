import React from 'react';
import type {Project} from '../shared';
import {projectLabel} from './project-label';

type WorkbenchView='overview'|'walk'|'materials'|'radar'|'engineering';
type IconName=WorkbenchView|'open'|'settings';
type Props={
  projects:Project[];
  projectId:string;
  active:WorkbenchView;
  onProject:(id:string)=>void;
  onOpen:()=>void;
  onSettings:()=>void;
  onNavigate:(view:WorkbenchView)=>void;
};
const navigationGroups=[
  {label:'理解工程',items:[{view:'overview',label:'工程全貌',icon:'overview'},{view:'walk',label:'功能走读',icon:'walk'},{view:'materials',label:'工程资料',icon:'materials'}]},
  {label:'协作开发',items:[{view:'radar',label:'变更雷达',icon:'radar'},{view:'engineering',label:'需求与开发',icon:'engineering'}]}
] as const;

function NavIcon({name}:{name:IconName}){
  return <svg className="workbench-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name==='overview'&&<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>}
    {name==='walk'&&<><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6.5 7.8l4.2 8.3M17.5 7.8l-4.2 8.3"/></>}
    {name==='materials'&&<><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 16h6"/></>}
    {name==='radar'&&<><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.2"/><path d="M12 12l5.2-5.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></>}
    {name==='engineering'&&<><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8 12 2.5 2.5L16.5 8"/></>}
    {name==='open'&&<><path d="M3.5 7.5h6l2 2h9v10h-17z"/><path d="M3.5 7.5v-3h6l2 3M12 13v5M9.5 15.5h5"/></>}
    {name==='settings'&&<><circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"/></>}
  </svg>;
}

export function WorkbenchNavigation({projects,projectId,active,onProject,onOpen,onSettings,onNavigate}:Props){
  const current=projects.find(project=>project.project_id===projectId);
  return <aside className="workbench-navigation" aria-label="ARC 工程工作台导航">
    <div className="workbench-brand">
      <span className="workbench-brand-mark" aria-hidden="true">A</span>
      <div className="workbench-brand-copy"><strong>ARC</strong><small>工程理解与开发</small></div>
    </div>
    <div className="workbench-project-block">
      <div className="workbench-section-label"><span>当前工程</span><span>{projects.length}</span></div>
      <label className="workbench-project">
        <select aria-label="当前工程" title={current?.root_path||'选择本地工程'} value={projectId} onChange={event=>onProject(event.target.value)}>
          <option value="">选择工程</option>
          {projects.map(project=><option key={project.project_id} value={project.project_id} title={project.root_path}>{projectLabel(project)}</option>)}
        </select>
        <svg className="workbench-project-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.5 6.2 8 9.7l3.5-3.5"/>
        </svg>
      </label>
      <small className="workbench-project-meta"><i aria-hidden="true"/>{current?'本机工作区':'尚未选择工程'}</small>
    </div>
    <nav className="workbench-primary-nav" aria-label="主要导航">
      {navigationGroups.map(group=><section className="workbench-nav-group" key={group.label}><h2>{group.label}</h2>{group.items.map(item=><button type="button" key={item.view} title={item.label} aria-label={item.label} aria-current={active===item.view?'page':undefined} onClick={()=>onNavigate(item.view)}>
        <NavIcon name={item.icon}/><span className="workbench-nav-label">{item.label}</span>
      </button>)}</section>)}
    </nav>
    <div className="workbench-side-actions">
      <button type="button" title="打开工程" aria-label="打开工程" onClick={onOpen}><NavIcon name="open"/><span className="workbench-nav-label">打开工程</span></button>
      <button type="button" title="连接 Agent" aria-label="连接 Agent" onClick={onSettings}><NavIcon name="settings"/><span className="workbench-nav-label">连接 Agent</span></button>
    </div>
    <div className="workbench-local-status"><i aria-hidden="true"/><span>数据保存在本机</span></div>
  </aside>;
}
