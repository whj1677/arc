import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {WorkspaceData,ReadingTarget,ReadingQuestion,SourceEvidence,Run} from '../shared';
import {RunActivity} from './RunActivity';
import {SourceExcerpt} from './SourceExcerpt';
import './reading-questions.css';

type Props={data:WorkspaceData;projectId:string;scenarioId:string;resultId:string|null;target:ReadingTarget;targetLabel:string;featureId:string;featureLabel:string;snapshotId:string;disabled:boolean;reload:()=>Promise<unknown>;settings:()=>void};
const activeStatuses=['queued','running','validating','cancel_requested'];
const retryStatuses=['failed','blocked_external','cancelled','unknown'];
const sameTarget=(a:ReadingTarget,b:ReadingTarget)=>a.kind===b.kind&&a.id===b.id;

export function ReadingQuestions({data,projectId,scenarioId,resultId,target,targetLabel,featureId,featureLabel,snapshotId,disabled,reload,settings}:Props){
  const baseKey=[projectId,scenarioId,resultId,target.kind,target.id].join('/');
  const [wholeScope,setWholeScope]=useState<Record<string,boolean>>({}),[drafts,setDrafts]=useState<Record<string,string>>({});
  const [mode,setMode]=useState<'codex'|'mcp'>('codex'),[sourceMode,setSourceMode]=useState<'bound'|'latest'>('bound'),[correction,setCorrection]=useState(false);
  const [errors,setErrors]=useState<Record<string,string>>({}),[sending,setSending]=useState<Record<string,boolean>>({}),[inspecting,setInspecting]=useState<{questionId:string;evidence:SourceEvidence}|null>(null);
  const [replyTo,setReplyTo]=useState<Record<string,string>>({});
  const [resultScopes,setResultScopes]=useState<Record<string,string>>({});
  const [revealQuestion,setRevealQuestion]=useState<{key:string;id:string}|null>(null);
  const submitting=useRef(new Set<string>()),composer=useRef<HTMLTextAreaElement>(null),activeContext=useRef('');
  const root=useRef<HTMLElement>(null),jumps=useRef<HTMLElement>(null),source=useRef<HTMLDivElement>(null),questionElements=useRef(new Map<string,HTMLElement>());
  const selectedTarget:ReadingTarget=wholeScope[baseKey]?{kind:'feature',id:featureId}:target;
  const label=wholeScope[baseKey]?featureLabel:targetLabel;
  const scopeKey=[projectId,scenarioId,resultId,selectedTarget.kind,selectedTarget.id].join('/');
  const scope=resultScopes[scopeKey]||'current';
  const scopedResultId=scope==='current'?resultId:scope==='unanalysed'?null:scope;
  const historical=scopedResultId!==resultId;
  const contextKey=[projectId,scenarioId,scopedResultId,selectedTarget.kind,selectedTarget.id].join('/');
  activeContext.current=contextKey;
  const relatedQuestions=(data.questions||[]).filter(q=>q.project_id===projectId&&(!scenarioId||q.scenario_id===scenarioId)&&(sameTarget(q.target,selectedTarget)||(selectedTarget.kind==='feature'&&q.target.kind==='feature'&&(q.feature_id===featureId||(featureId===projectId&&q.scenario_id===data.projects.find(p=>p.project_id===projectId)?.overview_scenario_id)))));
  const historicalResults=[...new Set(relatedQuestions.map(q=>q.result_id).filter(id=>id!==resultId))];
  const questions=relatedQuestions.filter(q=>q.result_id===scopedResultId);
  const previous=questions.find(q=>q.question_id===replyTo[contextKey])||questions.at(-1);
  const sourceId=sourceMode==='latest'?'':previous?.source_snapshot_id||snapshotId;
  const snapshot=data.snapshots.find(s=>s.source_snapshot_id===sourceId),draft=drafts[contextKey]||'';
  const activeQuestion=questions.find(q=>{const run=data.runs.find(r=>r.binding.run_id===q.run_id);return run&&[...activeStatuses,'waiting_agent'].includes(run.status);}),busy=!!activeQuestion;
  const answered=questions.filter(q=>q.answer),latestAnswer=answered.at(-1);
  function reveal(element:HTMLElement|null|undefined){
    const panel=root.current?.closest<HTMLElement>('.panel-scroll');
    if(!element||!panel||!root.current?.getClientRects().length)return;
    panel.scrollTo({top:Math.max(0,panel.scrollTop+element.getBoundingClientRect().top-panel.getBoundingClientRect().top-(jumps.current?.offsetHeight||0)-8),behavior:'auto'});
  }
  function revealAnswer(question:ReadingQuestion){const element=questionElements.current.get(question.question_id);reveal(element?.querySelector<HTMLElement>('.question-answer')||element);}
  useEffect(()=>{setInspecting(null);setCorrection(false);setSourceMode('bound');},[contextKey]);
  useLayoutEffect(()=>{
    if(!revealQuestion)return;
    if(revealQuestion.key!==contextKey){setRevealQuestion(null);return;}
    const element=questionElements.current.get(revealQuestion.id);
    if(element){reveal(element);setRevealQuestion(null);}
  },[contextKey,revealQuestion,questions]);
  useLayoutEffect(()=>{if(inspecting)reveal(source.current);},[inspecting]);
  async function send(event:React.FormEvent){
    event.preventDefault();if(!draft.trim()||disabled||busy||submitting.current.has(contextKey))return;
    const key=contextKey;submitting.current.add(key);setSending(s=>({...s,[key]:true}));setErrors(e=>({...e,[key]:''}));
    const request={project_id:projectId,scenario_id:previous?.scenario_id||scenarioId||undefined,result_id:scopedResultId,target:previous?.target||selectedTarget,question:draft,source_mode:sourceMode,mode,correction,submission_key:crypto.randomUUID(),previous_question_id:previous?.question_id};
    try{const submitted=await window.arc.invoke<ReadingQuestion>('reading_ask',request);setDrafts(d=>({...d,[key]:''}));setReplyTo(v=>({...v,[key]:''}));if(activeContext.current===key){setSourceMode('bound');setCorrection(false);setRevealQuestion({key,id:submitted.question_id});}await reload();}catch(reason){setErrors(e=>({...e,[key]:(reason as Error).message}));}finally{submitting.current.delete(key);setSending(s=>({...s,[key]:false}));}
  }
  async function retry(question:ReadingQuestion){
    const key=contextKey;if(submitting.current.has(key))return;submitting.current.add(key);setSending(s=>({...s,[key]:true}));setErrors(e=>({...e,[key]:''}));
    try{await window.arc.invoke('reading_retry',{question_id:question.question_id,mode,submission_key:crypto.randomUUID()});if(activeContext.current===key)setRevealQuestion({key,id:question.question_id});await reload();}catch(reason){setErrors(e=>({...e,[key]:(reason as Error).message}));}finally{submitting.current.delete(key);setSending(s=>({...s,[key]:false}));}
  }
  async function cancel(run:Run){try{await window.arc.invoke('run_cancel',{run_id:run.binding.run_id});await reload();}catch(reason){setErrors(e=>({...e,[contextKey]:(reason as Error).message}));}}
  return <section ref={root} className="reading-questions" aria-label="当前位置问答" data-target-kind={selectedTarget.kind} data-target-id={selectedTarget.id}>
    <header><span className="eyebrow">在这里问清楚</span><h2>{label}</h2>{target.kind!=='feature'&&<label className="question-scope">提问范围<select aria-label="提问范围" value={wholeScope[baseKey]?'feature':'object'} onChange={e=>setWholeScope(v=>({...v,[baseKey]:e.target.value==='feature'}))}><option value="object">当前选中对象</option><option value="feature">{featureLabel}</option></select></label>}<p className="muted">回答保存在这个阅读位置，可随时切换后回来继续。</p></header>
    {historicalResults.length>0&&<label className="question-scope">问答所属说明<select aria-label="问答所属说明" value={scope} onChange={e=>setResultScopes(v=>({...v,[scopeKey]:e.target.value}))}><option value="current">当前阅读的说明{resultId?'':' · 尚无完整结果'}</option>{historicalResults.map(id=><option key={id||'unanalysed'} value={id||'unanalysed'}>{id?`历史说明 · ${id}`:'生成完整说明前的问答'}</option>)}</select></label>}
    {historical&&<p className="question-history-notice" role="status">正在阅读历史问答，左侧图保持原位置。继续提问将沿用这里的原问题、对象与冻结快照。{scopedResultId?`原说明：${scopedResultId}`:'这些问题提出时尚无完整分析结果。'}</p>}
    {questions.length>0&&<nav ref={jumps} className="question-jumps" aria-label="问答定位"><strong title={label}>{label}</strong><small aria-live="polite">{answered.length} 条回答已保存</small><div>{latestAnswer&&<button onClick={()=>revealAnswer(latestAnswer)}>查看最新回答</button>}{activeQuestion?<button onClick={()=>reveal(questionElements.current.get(activeQuestion.question_id))}>查看当前任务</button>:<button onClick={()=>composer.current?.focus()}>继续提问</button>}</div></nav>}
    <div className="question-thread" aria-label="已保存问答">{questions.map(q=>{const run=data.runs.find(r=>r.binding.run_id===q.run_id),answer=q.answer;return <article className="reading-question" key={q.question_id} data-question-id={q.question_id} ref={element=>{if(element)questionElements.current.set(q.question_id,element);else questionElements.current.delete(q.question_id);}}>
      <h3>你问</h3><p className="question-text">{q.question}</p><small className="question-time">{new Date(q.created_at).toLocaleString('zh-CN')}</small>
      <details className="question-binding"><summary>{q.source_mode==='latest'?'按刷新后的源码回答':'基于冻结源码'} · {data.snapshots.find(s=>s.source_snapshot_id===q.source_snapshot_id)?.captured_at.slice(0,10)||'已保存'}</summary><p>快照：{q.source_snapshot_id}</p><p>原说明：{q.result_id||'尚无工程分析结果'}</p><p>问题版本：{q.question_revision_id}</p><p>本次回答只解释当前问题，不代表整张工程图已更新或验证通过。</p></details>
      {answer?<><h3>解释</h3><p className="question-answer">{answerText(answer.answer,answer.evidence,e=>setInspecting({questionId:q.question_id,evidence:e}))}</p>{answer.evidence.length>0&&<section className="question-evidence"><h4>源码依据</h4>{answer.evidence.map(e=><button key={e.evidence_id} data-evidence-id={e.evidence_id} onClick={()=>setInspecting(inspecting?.questionId===q.question_id&&inspecting.evidence.evidence_id===e.evidence_id?null:{questionId:q.question_id,evidence:e})}><strong>[{e.evidence_id}] {e.path}:{e.line_start}–{e.line_end}</strong><small>{e.note}</small></button>)}</section>}{inspecting?.questionId===q.question_id&&<div ref={source}><SourceExcerpt evidence={inspecting.evidence}/></div>} {!!answer.uncertainties.length&&<section className="question-boundaries"><h4>未确认与边界</h4>{answer.uncertainties.map((item,index)=><p key={index}>{item}</p>)}</section>}<button className="quiet" onClick={()=>{setReplyTo(v=>({...v,[contextKey]:q.question_id}));setSourceMode('bound');composer.current?.focus();}}>继续追问 ↓</button></>:run?.status==='waiting_agent'?<section className="question-waiting" role="status"><strong>等待外部 Agent 领取</strong><p>问题与上下文已保存，尚未开始分析。在已接入 Arc MCP 的对话中，让 Agent 领取当前阅读问题。</p><small>Arc 不会主动唤醒外部对话。</small><div className="row"><button onClick={settings}>MCP 接入</button><button onClick={()=>void cancel(run)}>取消等待</button></div></section>:run?<QuestionProgress run={run} cancel={()=>void cancel(run)}/>:<p>问题已保存，等待任务状态。</p>}
      {run&&retryStatuses.includes(run.status)&&<button className="secondary full" disabled={sending[contextKey]||busy} onClick={()=>void retry(q)}>重试这个问题</button>}
    </article>;})}</div>
    <form className="question-composer" onSubmit={send}>
      {previous&&<p className="muted">接着问：{previous.question.slice(0,80)}{previous.question.length>80?'…':''}</p>}
      <label htmlFor="reading-question-input">{previous?'继续提问':'向 Codex 提问'}<textarea id="reading-question-input" ref={composer} aria-label="当前位置的问题" placeholder={selectedTarget.kind==='file'||selectedTarget.kind==='directory'?'这个文件或目录负责什么？':'这一步具体做了什么？失败以后会发生什么？'} rows={4} maxLength={4000} value={draft} onChange={e=>setDrafts(d=>({...d,[contextKey]:e.target.value}))}/></label>
      <div className="question-options"><label>执行方式<select aria-label="提问执行方式" value={mode} onChange={e=>setMode(e.target.value as 'codex'|'mcp')}><option value="codex">Codex · 在 ARC 内回答</option><option value="mcp">外部 Agent · MCP 待领取</option></select></label><label>回答来源<select aria-label="提问源码来源" value={sourceMode} onChange={e=>setSourceMode(e.target.value as 'bound'|'latest')}><option value="bound">沿用此处冻结快照</option><option value="latest">刷新并按最新代码回答</option></select></label></div>
      <p className="question-source-note">{sourceMode==='latest'?'发送时刷新工程快照；旧图保持原来源，新回答会单独标记来源变化。':`${previous?'继承上次回答的来源':'使用当前阅读来源'}${snapshot?' · '+new Date(snapshot.captured_at).toLocaleString('zh-CN'):''}。`}<span title={sourceId}>{sourceId||'尚未刷新'}</span></p>
      <label className="question-correction"><input type="checkbox" checked={correction} onChange={e=>setCorrection(e.target.checked)}/>这是纠错，同时保存为对象批注</label>
      {correction&&<p className="muted">纠错是用户线索，Agent 仍需结合源码查证。</p>}{mode==='mcp'&&<p className="muted">仅登记任务；需在外部对话领取，ARC 不会自动唤醒 Agent。</p>}
      {errors[contextKey]&&<p className="question-error" role="alert">{errors[contextKey]}</p>}
      <button className="primary full" type="submit" disabled={disabled||busy||sending[contextKey]||!draft.trim()}>{sending[contextKey]?'正在保存问题…':busy?'等待本问题完成或取消':mode==='mcp'?'保存问题，等待 Agent 领取':'发送问题'}</button>{disabled&&<p className="warning">当前是演示工程，不能派发真实任务。</p>}
    </form>
  </section>;
}

function answerText(text:string,evidence:SourceEvidence[],open:(evidence:SourceEvidence)=>void){
  const byId=new Map(evidence.map(e=>[e.evidence_id,e]));
  return text.split(/(\[[^\[\]\r\n]+\])/g).map((part,index)=>{
    const source=part.startsWith('[')&&part.endsWith(']')?byId.get(part.slice(1,-1)):undefined;
    return source?<button key={index} className="answer-citation" data-evidence-id={source.evidence_id} aria-label={`查看依据 ${source.evidence_id}：${source.path} 第 ${source.line_start} 至 ${source.line_end} 行`} onClick={()=>open(source)}>{part}</button>:part;
  });
}

function QuestionProgress({run,cancel}:{run:Run;cancel:()=>void}){
  const [events,setEvents]=useState<any[]>([]),[error,setError]=useState('');
  useEffect(()=>{let current=true,busy=false;const refresh=async()=>{if(busy)return;busy=true;try{const items=await window.arc.invoke<any[]>('run_events',{run_id:run.binding.run_id});if(current){setEvents(items);setError('');}}catch(reason){if(current)setError((reason as Error).message);}finally{busy=false;}};void refresh();const off=window.arc.onEvent(e=>{if(e.type==='run_event'&&e.run_id===run.binding.run_id)void refresh();});return()=>{current=false;off();};},[run.binding.run_id,run.status]);
  return <RunActivity run={run} events={events} error={error} stop={cancel}/>;
}
