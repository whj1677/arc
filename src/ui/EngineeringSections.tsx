import React,{useCallback,useEffect,useRef,useState} from 'react';
import type {ContextEntry,EngineeringContext,EngineeringSectionCategory,EngineeringTask} from '../engineering';
import {SourceExcerpt} from './SourceExcerpt';

export type EngineeringSection=EngineeringSectionCategory|'tasks';
const sections:[EngineeringSection,string,string][]=[['plan','影响与方案','现状、取舍、范围与实施步骤'],['architecture','架构','模块、边界与协作'],['design','设计','接口、数据与实现设计'],['tasks','任务与变更','目标、实际修改与执行记录'],['verification_plan','验证与证据','验收条件、实际结果与遗留']];
const origins={source:'源码 / 配置',document:'文档声明',user:'用户补充',agent:'Agent 归纳'};
const outcomeNames:Record<string,string>={passed:'通过',failed:'失败',blocked:'受阻',not_run:'未执行',partial:'部分完成',stale:'代码已变，待重验'};
const api=window.arc;
export function ExternalExecutor({projectId,programHint=''}:{projectId:string;programHint?:string}){
  const [program,setProgram]=useState(programHint),[thread,setThread]=useState(''),[sessions,setSessions]=useState<{id:string;name:string;model:string;source:string}[]>([]);
  const [state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const labels:Record<string,string>={queued:'等待派发',sending:'正在发送',awaiting_claim:'等待领取确认',running:'已领取，执行中',completed:'已完成',blocked:'受阻',unknown:'执行状态待核对',cancelled:'已取消'};
  useEffect(()=>{let alive=true;async function read(){try{const value=await api.invoke<any>('executor_status',{project_id:projectId});if(alive){setState(value);if(value.binding){setProgram(old=>old||value.binding.program);setThread(old=>old||value.binding.thread_id);}}}catch(e){if(alive)setError((e as Error).message);}}void read();const timer=setInterval(()=>void read(),5000);return()=>{alive=false;clearInterval(timer);};},[projectId]);
  async function discover(){setBusy(true);setError('');try{const value=await api.invoke('executor_sessions',{project_id:projectId,program});setProgram(value.program);setSessions(value.sessions);if(!value.sessions.length)setError('此工程尚无本机会话。请在 Codex 桌面端打开相同工程目录，创建并发送一条消息，然后刷新会话列表。');}catch(e){setError('读取桌面会话失败：'+(e as Error).message);}finally{setBusy(false);}}
  async function act(operation:string,args:object){setBusy(true);setError('');try{await api.invoke(operation,args);setState(await api.invoke('executor_status',{project_id:projectId}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section className="engineering-section-entry" aria-label="外部 Codex 执行器"><h3>连接 Codex 桌面会话</h3><p>在 Codex 桌面端打开此工程、选择模型，然后在这里选择会话。ARC 自动派发，完整对话与权限处理保留在 Codex 桌面端。</p>
    {state?.binding&&<p>已绑定：{state.binding.name||state.binding.thread_id}<br/>会话配置模型 {state.binding.model||'未取得'} · 推理强度 {state.binding.reasoning_effort||'沿用会话默认'}<br/><button onClick={()=>void act('executor_open',{project_id:projectId})}>在 Codex 桌面端打开对话</button></p>}
    <button disabled={busy} onClick={()=>void discover()}>{busy?'正在检查…':'查找此工程的 Codex 会话'}</button>
    {!!sessions.length&&<label>选择会话<select aria-label="Codex 桌面会话" value={thread} onChange={e=>setThread(e.target.value)}><option value="">请选择</option>{sessions.map(session=><option value={session.id} key={session.id}>{session.name} · {session.model||'模型未取得'} · {session.source}</option>)}</select></label>}
    <button disabled={busy||!thread.trim()} onClick={()=>void act('executor_bind',{project_id:projectId,program,thread_id:thread})}>连接选中的会话</button>
    <details><summary>连接诊断与手动指定</summary><p>后台通过本机官方 Codex 会话服务派发，无需打开命令行窗口。换电脑需安装 Codex、登录并提供可用后台服务和 Node.js；会话 ID 不会随工程迁移。</p><label>Codex 程序路径<input aria-label="外部 Codex CLI 路径" value={program} onChange={e=>setProgram(e.target.value)}/></label><label>会话 ID<input aria-label="外部 Codex 会话 ID" value={thread} onChange={e=>setThread(e.target.value)}/></label>{state?.binding&&<small>{state.binding.version} · 配置核对时间 {new Date(state.binding.checked_at).toLocaleString()}；此模型信息是会话配置，不等于逐轮执行遥测。</small>}</details>
    {error&&<p role="alert" className="warning">{error}</p>}
    {state?.queue?.map((item:any)=><article className="engineering-verification" key={item.dispatch_id}><strong>{labels[item.state]}</strong><small>{item.run_id||item.task_id}</small>{item.error&&<p>{item.error}</p>}{['queued','blocked'].includes(item.state)&&!item.sent_at&&<button disabled={busy} onClick={()=>void act('executor_retry',{dispatch_id:item.dispatch_id})}>检查连接并重试派发</button>}{['queued','sending','awaiting_claim','running'].includes(item.state)&&<button disabled={busy} onClick={()=>void act('executor_cancel',{dispatch_id:item.dispatch_id})}>撤销此任务</button>}{item.state==='unknown'&&<div><p>请在绑定的 Codex 会话核对任务。接续时使用派发 ID {item.dispatch_id}。需要换会话时，先在原会话停止此任务。</p><button disabled={busy} onClick={()=>void act('executor_verify_stopped',{dispatch_id:item.dispatch_id})}>检查原会话是否结束</button><button disabled={busy} onClick={()=>void act('executor_acknowledge_stop',{dispatch_id:item.dispatch_id})}>我已在原会话确认此任务停止</button></div>}</article>)}
  </section>;
}
type Draft={key:string;text:string;entry?:ContextEntry};

/** Render local text as React nodes. Raw HTML is always displayed as text. */
export function ContextText({text}:{text:string}){
  const inline=(value:string):React.ReactNode[]=>value.split(/(`[^`]+`|\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*)/g).map((part,i)=>{
    if(part.startsWith('`')&&part.endsWith('`'))return <code key={i}>{part.slice(1,-1)}</code>;
    if(part.startsWith('**')&&part.endsWith('**'))return <strong key={i}>{part.slice(2,-2)}</strong>;
    const link=part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if(link&&/^(https?:\/\/|mailto:)/i.test(link[2]))return <a key={i} href={link[2]} onClick={e=>{e.preventDefault();void api.invoke('engineering_open_link',{url:link[2]}).catch(error=>window.alert(error.message));}}>{link[1]}</a>;
    return part;
  });
  const blocks:React.ReactNode[]=[];
  const lines=text.replace(/\r\n/g,'\n').split('\n');
  const cells=(line:string)=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(s=>s.trim().replace(/\\\|/g,'|'));
  const isTable=(index:number)=>index+1<lines.length&&lines[index].includes('|')&&cells(lines[index+1]).every(s=>/^:?-{3,}:?$/.test(s));
  for(let i=0;i<lines.length;){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    if(line.startsWith('```')){
      const code:string[]=[];i++;
      while(i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i++]);
      i++;blocks.push(<pre key={i}><code>{code.join('\n')}</code></pre>);continue;
    }
    const heading=line.match(/^(#{1,6})\s+(.+)$/);
    if(heading){blocks.push(React.createElement('h'+heading[1].length,{key:i},inline(heading[2])));i++;continue;}
    if(isTable(i)){
      const headers=cells(line),rows:string[][]=[];i+=2;
      while(i<lines.length&&lines[i].trim()&&lines[i].includes('|'))rows.push(cells(lines[i++]));
      blocks.push(<div className="engineering-table" key={i}><table><thead><tr>{headers.map((cell,j)=><th key={j}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row,j)=><tr key={j}>{headers.map((_,k)=><td key={k}>{inline(row[k]||'')}</td>)}</tr>)}</tbody></table></div>);continue;
    }
    if(/^\s*(?:[-*+] |\d+\. )/.test(line)){
      const items:string[]=[];
      while(i<lines.length&&/^\s*(?:[-*+] |\d+\. )/.test(lines[i]))items.push(lines[i++].replace(/^\s*(?:[-*+] |\d+\. )/,''));
      const children=items.map((item,j)=><li key={j}>{inline(item)}</li>);
      blocks.push(/^\s*\d+\./.test(line)?<ol key={i}>{children}</ol>:<ul key={i}>{children}</ul>);continue;
    }
    const paragraph=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!isTable(i)&&!/^(?:#|```|\s*[-*+] |\s*\d+\. )/.test(lines[i]))paragraph.push(lines[i++]);
    blocks.push(<p key={i}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="engineering-markdown">{blocks}</div>;
}

export function ContextBody({entry,projectId}:{entry:ContextEntry;projectId:string}){
  const [full,setFull]=useState<ContextEntry|null>(null),[error,setError]=useState('');
  useEffect(()=>{setFull(null);setError('');},[entry.entry_id,entry.version]);
  const long=entry.truncated||entry.text.length>300;
  async function expand(){
    if(!entry.truncated||full)return;
    try{const value=await api.invoke<EngineeringContext>('engineering_context',{project_id:projectId,entry_id:entry.entry_id});setFull(value.entries[0]);setError('');}
    catch(e){setError((e as Error).message);}
  }
  if(!long)return <ContextText text={entry.text}/>;
  return <><p>{entry.text.slice(0,240).replace(/^#+\s*/gm,'')}…</p><details onToggle={e=>{if(e.currentTarget.open)void expand();}}><summary>展开完整内容</summary>{error?<p role="alert">{error}<button onClick={()=>void expand()}>重试读取</button></p>:entry.truncated&&!full?<p role="status">正在读取完整内容…</p>:<ContextText text={(full||entry).text}/>}</details></>;
}

export function EngineeringSections({projectId,taskId,section,onSection,tasks,onTask,onArchitecture,onDevelop}:{projectId:string;taskId:string;section:EngineeringSection;onSection:(value:EngineeringSection)=>void;tasks:EngineeringTask[];onTask:(id:string)=>void;onArchitecture:(resultId?:string)=>void;onDevelop:(goal:string)=>void}){
  const [context,setContext]=useState<EngineeringContext|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [drafts,setDrafts]=useState<Partial<Record<EngineeringSection,Draft>>>({}),[editing,setEditing]=useState<EngineeringSection|null>(null),[versions,setVersions]=useState<Record<string,ContextEntry[]>>({});
  const generation=useRef(0),alive=useRef(true),draftKey='engineering-section-drafts/'+projectId+'/'+taskId;
  const editor=useRef<HTMLFormElement|null>(null);
  useEffect(()=>{if(editing===section)editor.current?.scrollIntoView({block:'nearest'});},[editing,section]);
  const title=sections.find(([key])=>key===section)![1],draft=drafts[section]||{key:'',text:''};
  useEffect(()=>{alive.current=true;setDrafts({});setEditing(null);let valid=true;void api.invoke('reading_get',{key:draftKey}).then(value=>{if(valid&&value?.drafts)setDrafts(value.drafts);}).catch(e=>{if(valid)setError(e.message);});return()=>{alive.current=false;valid=false;};},[draftKey]);
  const changeDraft=(value:Draft)=>{const next={...drafts,[section]:value};setDrafts(next);void api.invoke('reading_save',{key:draftKey,value:{project_id:projectId,drafts:next}}).catch(e=>{if(alive.current)setError(e.message);});};
  const load=useCallback(async()=>{const mine=++generation.current;if(section==='tasks'){setContext(null);return;}try{const value=await api.invoke<EngineeringContext>('engineering_context',{project_id:projectId,task_id:taskId,category:section});if(mine===generation.current&&alive.current){setContext(value);setError('');}}catch(e){if(mine===generation.current&&alive.current)setError((e as Error).message);}},[projectId,section,taskId]);
  useEffect(()=>{setContext(null);setError('');setNotice('');void load();const off=api.onEvent(e=>{if(e.type==='engineering_changed'||e.type==='changed')void load();});return()=>{generation.current++;off();};},[load]);
  async function more(){if(!context||context.next_offset==null)return;const mine=generation.current;try{const next=await api.invoke<EngineeringContext>('engineering_context',{project_id:projectId,task_id:taskId,category:section,offset:context.next_offset});if(mine!==generation.current)return;if(next.version!==context.version){await load();return;}setContext({...next,entries:[...context.entries,...next.entries.filter(n=>!context.entries.some(e=>e.entry_id===n.entry_id))]});}catch(e){setError((e as Error).message);}}
  async function edit(entry:ContextEntry){setBusy(true);setError('');const active=section;try{const value=await api.invoke<EngineeringContext>('engineering_context',{project_id:projectId,entry_id:entry.entry_id});const full=value.entries[0];if(!full||full.truncated)throw Error('未取得完整条目，暂不能覆盖编辑');if(alive.current){const next={...drafts,[active]:{entry:full,key:full.key.replace(/^entry:/,''),text:full.text}};setDrafts(next);setEditing(active);}}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}}
  async function save(event:React.FormEvent){event.preventDefault();if(busy||section==='tasks'||!draft.key.trim()||!draft.text.trim())return;const submitted=section;setBusy(true);setError('');try{await api.invoke('engineering_save_entry',{project_id:projectId,task_id:taskId||undefined,entry_id:draft.entry?.entry_id,expected_version:draft.entry?.version||0,submission_key:crypto.randomUUID(),category:section,key:draft.key,text:draft.text});if(alive.current){const next={...drafts,[submitted]:{key:'',text:''}};setDrafts(next);setEditing(null);setVersions({});await api.invoke('reading_save',{key:draftKey,value:{project_id:projectId,drafts:next}});setNotice('已保存到共享工程上下文；Agent 可读取，原版本和来源保留。');await load();}}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}}
  async function history(entry:ContextEntry){try{const values=await api.invoke<{value?:ContextEntry}[]>('engineering_history',{kind:'context',id:entry.entry_id});setVersions(v=>({...v,[entry.entry_id]:values.map(x=>(x.value??x) as ContextEntry)}));}catch(e){setError((e as Error).message);}}
  const verification=tasks.filter(t=>t.task_id===taskId&&t.verification.length>0);
  function develop(){const names=context?.entries.map(entry=>entry.key.replace(/^entry:/,'')).join('、');onDevelop(`请读取共享工程上下文中的「${title}」栏目${names?'（'+names+'）':''}，据此完成以下开发目标：`);}
  return <section className="engineering-sections" aria-label="工程方案到验证">
    <nav className="engineering-section-tabs" aria-label="需求栏目">{sections.filter(([id])=>!['architecture','design'].includes(id)).map(([id,label,description])=><button key={id} disabled={busy} aria-pressed={section===id||id==='plan'&&['architecture','design'].includes(section)} className={section===id||id==='plan'&&['architecture','design'].includes(section)?'selected':''} onClick={()=>onSection(id)}><strong>{label}</strong><small>{description}</small></button>)}</nav>
    {['plan','architecture','design'].includes(section)&&<div className="row engineering-plan-options" aria-label="方案中的可选说明">{[['plan','实施方案'],['architecture','架构变更'],['design','详细设计']].map(([id,label])=><button key={id} aria-pressed={section===id} onClick={()=>onSection(id as EngineeringSection)}>{label}</button>)}<small>按实际需要记录，不要求每个任务都有独立文档。</small></div>}
    {section!=='tasks'&&<div className="engineering-section-body">
      <div className="row between"><div><h2>{title}</h2><p className="muted">与 Agent 共用工程记录；文档声明、用户补充与源码依据分别标识。</p></div><div className="row">{section==='architecture'&&<button disabled={busy} onClick={()=>onArchitecture()}>打开真实工程架构图</button>}<button disabled={busy||(section!=='architecture'&&!taskId)} onClick={()=>{setEditing(section);setNotice('');}}>补充{title}</button></div></div>
      {error&&<p className="warning" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {section==='plan'&&tasks.find(t=>t.task_id===taskId)&&<article className="engineering-section-entry"><h3>当前实施说明</h3><ContextText text={tasks.find(t=>t.task_id===taskId)!.summary||'分析或开发进展尚未回填。'}/>{tasks.find(t=>t.task_id===taskId)!.steps?.map(step=><div key={step.step_id}><h4>{step.title}</h4><p>{step.change}</p><ul>{step.criteria.map(criterion=><li key={criterion.criterion_id}>{criterion.text}</li>)}</ul></div>)}</article>}
      {!context&&!error&&<p role="status">正在读取{title}及来源…</p>}
      {section!=='architecture'&&!taskId&&<p>以下是未归属任务的工程历史资料；不代表当前任务方案或当前代码验证通过。选择任务后查看该任务的独立记录。</p>}
      {context&&!context.entries.length&&<div className="engineering-section-empty"><h3>还没有明确的{title}记录</h3><p>独立文档按需保存；简单需求使用任务步骤即可。这里没有记录不代表任务缺失或验证失败。</p></div>}
      {context?.entries.filter(entry=>(entry.task_id||'')===taskId).map(entry=><article className="engineering-section-entry" key={entry.entry_id}><div className="row between"><h3>{entry.key.replace(/^entry:/,'')}</h3><small>v{entry.version} · {origins[entry.origin]} · {entry.status==='needs_review'?'待复核':entry.status==='superseded'?'已被替代':'已记录'}</small></div><ContextBody entry={entry} projectId={projectId}/>{entry.conflict&&<p className="warning">{entry.conflict}</p>}
        <div className="row"><button disabled={busy} onClick={()=>void edit(entry)}>{entry.origin==='source'||entry.origin==='document'?'补充此记录':'编辑此记录'}</button><button onClick={()=>void history(entry)}>记录版本</button></div>
        <details><summary>来源与边界 · {entry.sources.length} 处引用</summary>{entry.sources.length?entry.sources.map((s,i)=><SourceExcerpt key={i} evidence={{evidence_id:`engineering:${entry.entry_id}:${i}`,source_snapshot_id:s.snapshot_id,path:s.path,line_start:s.line_start,line_end:s.line_end,content_sha256:s.content_sha256,role:'context',note:'工程记录引用的冻结来源'}}/>):<p>尚无源码引用，属于{origins[entry.origin]}，需要结合实现核对。</p>}</details>
        {versions[entry.entry_id]&&<details open><summary>已保存的版本</summary>{versions[entry.entry_id].map(v=><article key={v.version}><strong>v{v.version} · {new Date(v.updated_at).toLocaleString()}</strong><p className="engineering-section-text">{v.text}</p></article>)}</details>}
      </article>)}
      {context?.next_offset!=null&&<button onClick={()=>void more()}>继续读取{title} · 共 {context.total_entries} 条</button>}
      {editing===section&&<form ref={editor} className="engineering-section-editor" onSubmit={save}><h3>{draft.entry?'更新记录':'补充'+title}</h3><label>记录标题<input aria-label="工程记录标题" disabled={busy} maxLength={300} value={draft.key} onChange={e=>changeDraft({...draft,key:e.target.value})} required/></label><label>{title}内容<textarea aria-label="工程栏目内容" disabled={busy} value={draft.text} onChange={e=>changeDraft({...draft,text:e.target.value})} maxLength={60000} rows={8} required/></label><small>保存为用户补充；保留历史，未经源码复核不会冒充事实或验证通过。</small><div className="row"><button className="primary" disabled={busy||!draft.key.trim()||!draft.text.trim()}>{busy?'保存中…':'保存到工程上下文'}</button><button type="button" disabled={busy} onClick={()=>setEditing(null)}>收起编辑（保留草稿）</button></div></form>}
      {section==='verification_plan'&&<section className="engineering-verification-results"><h3>实际验证结果</h3><p className="muted">验证计划不等于执行通过；执行结果绑定当时的代码版本。</p>{!verification.length?<p>还没有执行证据。</p>:verification.map(task=><article key={task.task_id}><button onClick={()=>onTask(task.task_id)}>{task.goal} · {outcomeNames[task.verification_status]}</button>{task.verification.map(v=><p key={v.evidence_id}><code>{v.command}</code> · {outcomeNames[v.outcome]} · {v.origin==='observed'?'已观测执行':'Agent 上报，未独立核验'} · exit {v.exit_code??'未取得'}</p>)}</article>)}</section>}
    </div>}
  </section>;
}
