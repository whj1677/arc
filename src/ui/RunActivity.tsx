import React,{useEffect,useState} from 'react';
import type {Run} from '../shared';
import {activity,runChannel,runEngineName,activeStatuses} from './activity';
import {AnalysisError} from './AnalysisError';

export function RunActivity({run,events,detailed=false,collapsible=false,open,stop,error}:{run:Run;events:any[];detailed?:boolean;collapsible?:boolean;open?:()=>void;stop:()=>void;error?:string}){
  const [expanded,setExpanded]=useState(()=>activeStatuses.has(run.status));
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[run.binding.run_id]);
  const a=activity(run,events,now);
  const manual=run.origin==='manual_import';
  const stopLabel=run.execution_mode==='codex_desktop'?'撤销本次派发':run.origin==='mcp'?'撤销本次接入':'停止本次分析';
  const body=<section className={`run-activity ${detailed?'expanded':''} ${a.active?'active':'terminal'}`} aria-label={manual?'本地导入记录':'真实分析进度'}>
    <div className="activity-heading"><div><strong>{a.active&&<span className="activity-dot" aria-hidden="true"/>}{a.phase}</strong><small>{manual?'本地导入与校验，不计 Agent 联调':`${runEngineName(run)} · ${a.active?'已用时':'耗时'} ${a.elapsed} · ${a.files.length} 个文件有读取完成记录`}</small></div>
      <div className="row">{open&&<button onClick={open}>查看真实过程</button>}{a.active&&<button disabled={run.status==='cancel_requested'} onClick={stop}>{stopLabel}</button>}</div>
    </div>
    {!manual&&<p className="muted" aria-label="本次分析通道">{runChannel(run)}</p>}
    {a.active&&!manual&&run.origin!=='mcp'&&<p className="muted">{run.provider_id==='dsh'?'本次任务通过本机 DSH Web 执行，可随时停止。':run.overview_format?(run.overview_from_result_id?'沿用原说明的冻结源码，自动补查尚未确认的关系并复核，合计限时 5 分钟。新结果保存为新版本，当前阅读位置保留。':'首次分析、必要的关系补查与复核合计限时 5 分钟，可随时停止。ARC 会自动补查未确认的关系，未通过复核的关系不会画入工程图。'):run.reading_question_id?'本次追问执行限时 5 分钟，可随时停止；超时后保留问题与诊断，支持重试。':'Arc 不设完整工程分析总时限，可手动停止；连接故障仍会如实显示。'}</p>}
    {a.active&&<p className={a.reconnecting||a.stalled?'warning':'muted'}>{a.reconnecting?'已收到连接失败 / 重连事件，不能视为正在正常分析。可等待连接恢复或停止本次任务。':run.status==='waiting_agent'?'尚未收到领取回执。':a.stalled?`已 ${a.quiet} 未收到新事件，无法确认 Agent 当前是否仍在分析。可继续等待或停止。`:`最近活动距今 ${a.quiet} · 以下依据真实事件，不估算完成百分比。`}</p>}
    {error&&<p className="warning">过程记录暂时读取失败：{error}。正在重试，不能据此判断 Agent 是否已停止。</p>}
    {run.error&&<AnalysisError error={run.error}/>}
    {!detailed&&a.active&&a.latestMessage&&<p className="activity-preview"><b>Agent 最近消息：</b>{a.latestMessage.text.slice(0,190)}{a.latestMessage.text.length>190?'…':''}</p>}
    {detailed&&<>
      <div className="activity-milestones"><span>{manual?'✓ 导入已接收':'✓ 任务已保存'}</span>{!manual&&<><span>{a.connected?'✓ 已建立会话':'会话待确认'}</span><span>{a.output||run.status==='completed'?'✓ 已收到输出':a.active?'等待最终输出':'本轮未完成输出'}</span></>}<span>{run.status==='completed'?'✓ 校验并保存':a.active?'正式说明待保存':'本轮没有保存新说明'}</span></div>
      <details><summary>本次任务与绑定来源</summary><p>{run.question}</p>{run.overview_from_result_id&&<p className="path">补查原说明：{run.overview_from_result_id} · 沿用其冻结源码</p>}<small className="path">{run.binding.run_id}<br/>{run.binding.source_snapshot_id}<br/>{manual?'手动导入，未创建原生会话':run.external_id?`Provider 会话 ID（不证明桌面可见）：${run.external_id}`:run.origin==='mcp'?'MCP 接入；对话和模型由 Agent 界面管理':'尚未收到 Provider 会话 ID'}</small></details>
      <h3>{manual?'本地导入记录':'真实过程'}</h3>
      {!a.items.length&&<p>{manual?'没有 Agent 对话；此记录来自手动导入。':'任务已保存，正在等待第一条 Agent 事件；尚无可展示的消息。'}</p>}
      <ol className="activity-timeline">{a.items.slice(-8).map(item=><li key={item.id} className={item.kind}><small>{new Date(item.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})} · {item.kind==='message'?'Agent 消息':item.kind==='tool'?'工具活动':item.kind==='error'?'错误记录':'运行事件'}</small><p>{item.text.slice(0,1800)}{item.text.length>1800?'…':''}</p></li>)}</ol>
      <details><summary>全部可读消息与活动（{a.items.length}）</summary><ol className="activity-timeline">{a.items.map(item=><li key={item.id}><small>{new Date(item.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})}</small><p>{item.text}</p></li>)}</ol></details>
    </>}
  </section>;
  if(!collapsible)return body;
  return <section className="analysis-activity-panel" aria-label="分析执行动态"><button className="activity-disclosure" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>执行动态 {expanded?'▴':'▾'} · {a.phase}</button>{expanded&&<div>{body}</div>}</section>;
}
