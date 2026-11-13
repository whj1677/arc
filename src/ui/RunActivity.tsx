import React,{useEffect,useState} from 'react';
import type {Run} from '../shared';
import {activity,runChannel} from './activity';
import {AnalysisError} from './AnalysisError';

export function RunActivity({run,events,detailed=false,open,stop,error}:{run:Run;events:any[];detailed?:boolean;open?:()=>void;stop:()=>void;error?:string}){
  const [now,setNow]=useState(Date.now());
  const [openError,setOpenError]=useState('');
  useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[run.binding.run_id]);
  const a=activity(run,events,now);
  const manual=run.origin==='manual_import';
  return <section className={`run-activity ${detailed?'expanded':''} ${a.active?'active':'terminal'}`} aria-label={manual?'本地导入记录':'真实分析进度'}>
    <div className="activity-heading"><div><strong>{a.active&&<span className="activity-dot" aria-hidden="true"/>}{a.phase}</strong><small>{manual?'本地导入与校验，不计 Agent 联调':`${run.provider_id} · ${a.active?'已用时':'耗时'} ${a.elapsed} · ${a.files.length} 个文件有读取完成记录`}</small></div>
      <div className="row">{run.native_ui==='dsh-web'&&run.external_id&&<button onClick={()=>{setOpenError('');void window.arc.invoke('run_open_provider',{run_id:run.binding.run_id}).catch(e=>setOpenError(e.message));}}>在 DSH 中打开此对话</button>}{open&&<button onClick={open}>查看真实过程</button>}{a.active&&<button disabled={run.status==='cancel_requested'} onClick={stop}>{run.origin==='mcp'?'撤销本次接入':'停止本次分析'}</button>}</div>
    </div>
    {!manual&&<p className="muted" aria-label="本次分析通道">{runChannel(run)}</p>}
    {openError&&<p className="warning">{openError}</p>}
    {a.active&&!manual&&run.origin!=='mcp'&&<p className="muted">{run.overview_format?'首次分析与关系复核合计限时 5 分钟，可随时停止；未通过复核的草稿不会发布。':run.reading_question_id?'本次追问执行限时 5 分钟，可随时停止；超时后保留问题与诊断，支持重试。':'Arc 不设完整工程分析总时限，可手动停止；连接故障仍会如实显示。'}</p>}
    {a.active&&<p className={a.reconnecting||a.stalled?'warning':'muted'}>{a.reconnecting?'已收到连接失败 / 重连事件，不能视为正在正常分析。可等待连接恢复或停止本次任务。':a.stalled?`已 ${a.quiet} 未收到新事件，无法确认 Agent 当前是否仍在分析。可继续等待或停止。`:`最近活动距今 ${a.quiet} · 以下依据真实事件，不估算完成百分比。`}</p>}
    {error&&<p className="warning">过程记录暂时读取失败：{error}。正在重试，不能据此判断 Agent 是否已停止。</p>}
    {run.error&&<AnalysisError error={run.error}/>}
    {!detailed&&a.active&&a.latestMessage&&<p className="activity-preview"><b>Agent 最近消息：</b>{a.latestMessage.text.slice(0,190)}{a.latestMessage.text.length>190?'…':''}</p>}
    {detailed&&<>
      <div className="activity-milestones"><span>{manual?'✓ 导入已接收':'✓ 任务已保存'}</span>{!manual&&<><span>{a.connected?'✓ 已建立会话':'会话待确认'}</span><span>{a.output||run.status==='completed'?'✓ 已收到输出':a.active?'等待最终输出':'本轮未完成输出'}</span></>}<span>{run.status==='completed'?'✓ 校验并保存':a.active?'正式说明待保存':'本轮没有保存新说明'}</span></div>
      <details><summary>本次任务与绑定来源</summary><p>{run.question}</p><small className="path">{run.binding.run_id}<br/>{run.binding.source_snapshot_id}<br/>{manual?'手动导入，未创建原生会话':run.external_id?`Provider 会话 ID（不证明桌面可见）：${run.external_id}`:run.origin==='mcp'?'MCP 接入；对话和模型由 Agent 界面管理':'尚未收到 Provider 会话 ID'}</small></details>
      <h3>{manual?'本地导入记录':'真实过程'}</h3>
      {!a.items.length&&<p>{manual?'没有 Agent 对话；此记录来自手动导入。':'任务已保存，正在等待第一条 Agent 事件；尚无可展示的消息。'}</p>}
      <ol className="activity-timeline">{a.items.slice(-8).map(item=><li key={item.id} className={item.kind}><small>{new Date(item.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})} · {item.kind==='message'?'Agent 消息':item.kind==='tool'?'工具活动':item.kind==='error'?'错误记录':'运行事件'}</small><p>{item.text.slice(0,1800)}{item.text.length>1800?'…':''}</p></li>)}</ol>
      <details><summary>全部可读消息与活动（{a.items.length}）</summary><ol className="activity-timeline">{a.items.map(item=><li key={item.id}><small>{new Date(item.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})}</small><p>{item.text}</p></li>)}</ol></details>
    </>}
  </section>;
}
