import React,{useState} from 'react';
import type {WorkspaceBinding} from '../engineering';
import type {EffectiveCommands,ProjectEnvironment,ToolProbeStatus} from '../main/env-probe';
import {rememberEnvironment,useProjectEnvironment} from './project-environment-store';
import './project-environment.css';

const fields=[['build','构建命令'],['test','测试命令'],['typecheck','类型检查']] as const;
const statusLabels:Record<ToolProbeStatus,string>={available:'可用',missing:'本机未发现',unverifiable:'未能确认',declared:'项目声明需要'};
export function ProjectEnvironmentCard({workspace}:{workspace:WorkspaceBinding}){
  const projectId=workspace.project_id;
  const {environment,error:loadError}=useProjectEnvironment(workspace);
  const [draft,setDraft]=useState<EffectiveCommands|null>(null);
  const [updating,setBusy]=useState(false),[error,setError]=useState('');
  const busy=updating||(!environment&&!loadError);
  async function update(action:'refresh'|'save'){
    setBusy(true);setError('');
    try {
      const overrides=draft&&environment?Object.fromEntries(Object.entries(draft).filter(([key,value])=>
        value!==environment.candidate_commands[key as keyof EffectiveCommands])):undefined;
      const env=action==='refresh'
        ?await window.arc.invoke<ProjectEnvironment>('project_environment',{project_id:projectId,refresh:true})
        :await window.arc.invoke<ProjectEnvironment>('project_environment_save',{project_id:projectId,effective_commands:overrides});
      rememberEnvironment(workspace,env);setDraft(null);
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  const canFill=environment&&draft&&fields.some(([key])=>!draft[key]&&environment.candidate_commands[key]);
  return <section className="project-home-section env-card" aria-label="本机环境与有效命令">
    <header className="project-home-heading"><div><h2>本机环境与有效命令</h2><small>自动实测本机工具链，派活时直接注入给 Codex / DSH</small></div>
      <button disabled={busy||!!draft} onClick={()=>void update('refresh')}>{busy&&!draft?'探测中…':'重新探测'}</button>
    </header>
    {(error||(!environment&&loadError))&&<p className="warning" role="alert">{error||loadError}</p>}
    {environment&&<>
      <ul className="env-tools" aria-label="工具状态">{environment.tools.map(tool=><li key={tool.id} className={'env-tool '+tool.status} title={[tool.required_by,tool.detail].filter(Boolean).join(' · ')}>
        <i aria-hidden="true"/>{tool.label}{tool.version&&' '+tool.version} · {statusLabels[tool.status]}
      </li>)}</ul>
      <form onSubmit={e=>{e.preventDefault();if(draft)void update('save');}}>
        <div className="env-commands">{fields.map(([key,label])=><div key={key}><span>{label}</span>{draft?
          <input aria-label={label} autoFocus={key==='build'} maxLength={2048} disabled={busy} value={draft[key]??''}
            placeholder={environment.candidate_commands[key]||'未配置'} onChange={e=>setDraft({...draft,[key]:e.target.value})}/>:
          environment.effective_commands[key]?<code>{environment.effective_commands[key]}</code>:<small>未配置</small>}</div>)}</div>
        <div className="env-actions">{draft?<>{canFill&&<button type="button" disabled={busy} onClick={()=>{
          const filled={...draft};for(const [key] of fields)if(!filled[key]&&environment.candidate_commands[key])filled[key]=environment.candidate_commands[key];setDraft(filled);
        }}>填入探测值</button>}<button type="button" disabled={busy} onClick={()=>setDraft(null)}>取消</button>
          <button className="primary" type="submit" disabled={busy}>{busy?'保存中…':'保存命令'}</button></>:
          <button type="button" disabled={busy} onClick={()=>setDraft({...environment.effective_commands})}>编辑命令</button>}</div>
      </form>
    </>}
  </section>;
}
