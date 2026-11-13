import type {Run} from '../shared';

export const activeStatuses=new Set(['queued','running','validating','cancel_requested']);
export type ActivityItem={id:string;at:string;kind:'message'|'tool'|'status'|'error';text:string};
export function runChannel(run:Run){
  if(run.origin==='manual_import')return '本地导入 · 未调用 Agent';
  if(run.origin==='mcp')return 'Agent 对话通过 MCP 接入 · 对话由 Agent 客户端管理';
  if(run.provider_id==='codex')return 'Codex CLI 后台 · 在 Arc 查看过程；未验证 Codex 桌面对话同步';
  if(run.native_ui==='dsh-web')return 'DSH 图形会话 · 同一对话分析，完成后自动写回 Arc';
  return `${run.provider_id==='dsh'?'DSH':'WorkBuddy'} 后台 · 在 Arc 查看过程`;
}
export function duration(ms:number) {
  const seconds=Math.max(0,Math.floor(ms/1000));
  return seconds>=60?`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:`${seconds} 秒`;
}
export function activity(run:Run,events:any[],now:number) {
  const items=new Map<string,ActivityItem>(),chunks=new Map<string,string>(),files=new Set<string>(),pending=new Set<string>();
  const toolDetails=new Map<string,{title?:string;path?:string}>();
  let connected=!!run.external_id,output=false,reconnecting=false,lastTime=Date.parse(run.created_at);
  const add=(id:string,e:any,kind:ActivityItem['kind'],text:string)=>items.set(id,{id,at:e.received_at||run.created_at,kind,text});
  for(const [i,e] of events.entries()){
    const stamp=Date.parse(e.received_at);if(Number.isFinite(stamp))lastTime=Math.max(lastTime,stamp);
    const key=String(e.sequence??i),item=e.item,u=e.update;
    if(['thread.started','session.started'].includes(e.type)){connected=true;add(key,e,'status','已建立真实 Agent 会话');}
    if(e.type==='local.stage'){if(e.stage==='mcp_connected')connected=true;add(key,e,'status',e.message);}
    if(item?.type==='mcp_tool_call'){
      reconnecting=false;
      const toolId=`tool:${item.id}`,file=item.arguments?.path;
      const ended=e.type==='item.completed',failed=item.status==='failed'||!!item.error;
      if(ended)pending.delete(toolId);else pending.add(toolId);
      if(ended&&!failed&&item.tool==='arc_read_source'&&typeof file==='string')files.add(file);
      add(toolId,e,failed?'error':'tool',`${ended?(failed?'工具失败':'已完成'):'正在执行'} · ${item.tool}${file?' · '+file:''}${item.arguments?.line_start?' : '+item.arguments.line_start:''}`);
    }
    if(item?.type==='agent_message'&&typeof item.text==='string'){
      reconnecting=false;
      const text=item.text.trim();
      if(/^\s*(?:```(?:json)?\s*)?\{[\s\S]*"schema_version"/.test(text)){
        output=true;add(`message:${item.id}`,e,'status','已收到结构化结果，仍需 Arc 校验和保存');
      }else add(`message:${item.id}`,e,'message',text);
    }
    // Expose only public messages/tool updates; reasoning chunks are not a transcript.
    if(u?.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text'){
      reconnecting=false;
      const id=`message:${u.messageId||'dsh'}`,text=(chunks.get(id)||'')+u.content.text;chunks.set(id,text);
      if(/^\s*(?:```(?:json)?\s*)?\{/.test(text)){output=true;add(id,e,'status','正在接收结构化结果，等待完整输出');}
      else add(id,e,'message',text);
    }
    if(['tool_call','tool_call_update'].includes(u?.sessionUpdate)){
      reconnecting=false;
      const id=`tool:${u.toolCallId}`,prior=toolDetails.get(id),finished=['completed','failed'].includes(u.status);
      const title=u.title||prior?.title||u.toolCallId,file=u.rawInput?.path??prior?.path;
      toolDetails.set(id,{title,path:file});
      if(finished)pending.delete(id);else pending.add(id);
      if(u.status==='completed'&&typeof file==='string'&&/(?:^|__)arc_read_source$/.test(title))files.add(file);
      add(id,e,u.status==='failed'?'error':'tool',`${finished?(u.status==='failed'?'工具失败':'已完成'):'正在执行'} · ${title}${file?' · '+file:''}`);
    }
    if(e.type==='turn.completed'||e.type==='provider.finished'){reconnecting=false;output=true;add(key,e,'status','Agent 已结束本轮输出，等待本地校验');}
    if(e.type==='error'||e.type==='turn.failed'||item?.type==='error'){
      const message=e.message||e.error?.message||item?.message||'Agent 报告错误，最终状态以任务状态为准';
      if(/Reconnecting|waiting for network|request timed out|stream disconnected/i.test(message))reconnecting=true;
      add(key,e,'error',message);
    }
  }
  const phases:Record<string,string>={queued:'准备连接 Agent',validating:'校验结果与源码依据',completed:'分析完成，说明已保存',failed:'分析失败',cancel_requested:'正在请求停止',cancelled:'任务已停止',unknown:'状态未知，需核查原会话',blocked_external:'连接条件缺失'};
  const phase=run.origin==='manual_import'&&run.status==='completed'?'手动导入已校验并保存 · 未调用 Agent':phases[run.status]||(reconnecting?'连接中断，Agent 正在重连':pending.size?'正在读取源码 / 执行工具':output?'已收到输出，等待校验':connected?'Agent 处理中，等待后续输出':'进程已启动，等待 Agent 会话');
  const active=activeStatuses.has(run.status),end=Date.parse(run.ended_at||'');
  return {phase,active,connected,output,reconnecting:active&&reconnecting,items:[...items.values()],files:[...files],pending:pending.size,
    elapsed:duration((active||!Number.isFinite(end)?now:end)-Date.parse(run.created_at)),
    quiet:duration(now-lastTime),stalled:active&&now-lastTime>=45000,lastTime,
    latestMessage:[...items.values()].filter(x=>x.kind==='message').at(-1)};
}
