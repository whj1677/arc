import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {Store,id,now} from './store';
import {JsonLines,codexChildEnvironment,redact,locate} from './providers';
import type {Run} from '../shared';

const exec=promisify(execFile);
export interface ExecutorBinding {
  project_id:string;workspace_path:string;program:string;thread_id:string;
  model:string|null;reasoning_effort:string|null;version:string;checked_at:string;
  name?:string;
}
export interface Dispatch {
  dispatch_id:string;project_id:string;run_id?:string;task_id?:string;thread_id?:string;submission_key?:string;attempt_id?:string;request?:string;scope?:string[];phase?:'analysis'|'execution';
  task_version?:number;reviewed_version?:number;
  state:'queued'|'sending'|'awaiting_claim'|'running'|'completed'|'blocked'|'unknown'|'cancelled';
  created_at:string;sent_at?:string;claimed_at?:string;last_activity?:string;error?:string;revoked?:boolean;
}

/** A fresh read-only protocol connection inspects the external session. No model turn is started. */
export async function codexMetadata(program:string,cwd:string,method:string,params:unknown):Promise<any>{
  return new Promise((resolve,reject)=>{
    const child=spawn(program,['app-server','--stdio'],{cwd,env:codexChildEnvironment(process.env),windowsHide:true,stdio:['pipe','pipe','pipe']});
    let settled=false,diagnostic='';
    const finish=(error?:Error,value?:unknown)=>{
      if(settled)return;settled=true;clearTimeout(timer);child.stdin.end();child.kill();
      if(error)reject(error);else resolve(value);
    };
    const send=(value:unknown)=>child.stdin.write(JSON.stringify(value)+'\n');
    const timer=setTimeout(()=>finish(Error('Codex 会话检查超过 15 秒，执行器状态未确认'+(diagnostic?'：'+redact(diagnostic.slice(-1500)):''))),15000);
    const parser=new JsonLines(frame=>{
      if(frame.error){finish(Error(redact(frame.error.message||JSON.stringify(frame.error))));return;}
      if(frame.id===1){send({jsonrpc:'2.0',method:'initialized'});send({jsonrpc:'2.0',id:2,method,params});}
      if(frame.id===2)finish(undefined,frame.result);
    });
    child.stdout.on('data',chunk=>{try{parser.feed(chunk);}catch(error){finish(error as Error);}});
    child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-3000);});child.stdin.on('error',error=>finish(error));
    child.once('error',error=>finish(error));child.once('close',()=>{if(!settled)finish(Error('Codex 会话检查连接提前关闭'));});
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'arc_external_binding',version:'0.1.0'},capabilities:{experimentalApi:true}}});
  });
}

export class ExternalDispatch {
  private pumping=false;
  private timer?:ReturnType<typeof setInterval>;
  constructor(readonly store:Store,readonly changed:()=>void,
    private readonly metadata=codexMetadata,
    private readonly command=exec,
    private readonly canSend: (projectId:string,workspace:string)=>boolean=()=>true){
    for(const item of this.items())if(['sending','awaiting_claim','running'].includes(item.state)){
      item.state='unknown';item.error='ARC 重启前未确认执行终态。保留原任务，先核对外部会话，禁止自动重发。';this.save(item);
    }
  }
  start(){this.timer=setInterval(()=>void this.pump(),5000);this.timer.unref();void this.pump();}
  close(){if(this.timer)clearInterval(this.timer);}
  items(projectId?:string){return this.store.all<Dispatch>('external_dispatch').filter(item=>!projectId||item.project_id===projectId);}
  binding(projectId:string){return this.store.maybe<ExecutorBinding>('external_executor',projectId);}
  async sessions(workspace:string,program?:string){
    const executable=await locate('codex',program||undefined);
    const value=await this.metadata(executable,workspace,'thread/list',{cwd:workspace,limit:100,sortKey:'updated_at',sourceKinds:['vscode','exec','cli','appServer'],useStateDbOnly:true});
    return {program:executable,sessions:value.data.filter((thread:any)=>path.resolve(thread.cwd).toLowerCase()===path.resolve(workspace).toLowerCase()).map((thread:any)=>({id:thread.id,name:thread.name||thread.preview?.slice(0,80)||thread.id,model:thread.model,reasoning_effort:thread.reasoningEffort,source:thread.originator||thread.source,updated_at:thread.updatedAt})),has_more:!!value.nextCursor};
  }
  async bind(projectId:string,workspace:string,program:string,threadId:string,configure?:(resolvedProgram:string)=>Promise<unknown>){
    program=await locate('codex',program||undefined);
    if(!path.isAbsolute(program)||!threadId.trim())throw Error('请填写官方 CLI 绝对路径和外部会话 ID');
    const [{stdout:version},{stdout:help},value]=await Promise.all([
      this.command(program,['--version'],{windowsHide:true,timeout:8000}),
      this.command(program,['queue','--help'],{windowsHide:true,timeout:8000}),
      this.metadata(program,workspace,'thread/read',{threadId,includeTurns:false}),
    ]);
    if(!String(version).startsWith('codex-cli ')||!String(help).includes('--resume'))throw Error('此 CLI 缺少已要求的 queue --resume 能力');
    const thread=value.thread;
    if(!thread||thread.id!==threadId||path.resolve(thread.cwd).toLowerCase()!==path.resolve(workspace).toLowerCase())throw Error('Codex 会话的实际工作目录与当前工程不一致');
    const requireIdle=()=>{
      if(this.items(projectId).some(item=>['sending','awaiting_claim','running','unknown'].includes(item.state)))throw Error('原执行存在未确认任务，请先核对原会话终态后再更换绑定');
    };
    requireIdle();
    if(configure){await configure(program);requireIdle();}
    const binding:ExecutorBinding={project_id:projectId,workspace_path:workspace,program,thread_id:threadId,name:thread.name||thread.preview?.slice(0,80),model:thread.model??null,reasoning_effort:thread.reasoningEffort??null,version:String(version).trim(),checked_at:now()};
    this.store.put('external_executor',projectId,binding);this.changed();void this.pump();return binding;
  }
  enqueue(projectId:string,target:Pick<Dispatch,'run_id'|'task_id'|'submission_key'|'request'|'scope'|'phase'|'task_version'|'reviewed_version'>){
    const existing=this.items().find(item=>item.project_id===projectId&&item.run_id===target.run_id&&item.task_id===target.task_id&&item.submission_key===target.submission_key);
    if(existing)return existing;
    const item:Dispatch={dispatch_id:id('dispatch'),project_id:projectId,...target,state:'queued',created_at:now()};
    this.save(item);void this.pump();return item;
  }
  private save(item:Dispatch){this.store.put('external_dispatch',item.dispatch_id,item);this.changed();}
  started(dispatchId:string,attemptId:string){const item=this.store.get<Dispatch>('external_dispatch',dispatchId);item.attempt_id=attemptId;this.save(item);}
  claim(dispatchId:string){
    const item=this.store.get<Dispatch>('external_dispatch',dispatchId);
    if(item.revoked)throw Error('此派发已撤销，拒绝迟到领取');
    if(!['sending','awaiting_claim','running','unknown'].includes(item.state))throw Error('派发当前不可领取：'+item.state);
    item.state='running';item.claimed_at??=now();item.last_activity=now();item.error=undefined;this.save(item);return item;
  }
  cancel(dispatchId:string){
    const item=this.store.get<Dispatch>('external_dispatch',dispatchId);
    if(['completed','cancelled'].includes(item.state))return item;
    const unsent=item.state==='queued'||item.state==='blocked'&&!item.sent_at;
    item.revoked=true;
    item.state=unsent?'cancelled':'unknown';item.error=unsent?'已取消未发送任务':'已撤销 ARC 任务接收权限；外部会话是否停止尚未确认，请在原 Codex 会话停止。';
    if(item.run_id){const run=this.store.get<Run>('run',item.run_id);if(!['completed','failed','cancelled'].includes(run.status)){run.status='cancelled';run.error=item.error;run.ended_at=now();this.store.put('run',item.run_id,run);}}
    this.save(item);return item;
  }
  acknowledgeStop(dispatchId:string){
    const item=this.store.get<Dispatch>('external_dispatch',dispatchId);
    if(item.state!=='unknown')throw Error('仅需核对未知执行状态');
    item.state='cancelled';item.revoked=true;item.error='用户已在外部 Codex 核实并确认此派发停止；保留已有修改和任务上下文。';
    this.save(item);return item;
  }
  async verifyStopped(dispatchId:string){
    const item=this.store.get<Dispatch>('external_dispatch',dispatchId),binding=this.binding(item.project_id);
    if(item.state!=='unknown'||!binding||!item.thread_id)throw Error('没有待核对的外部执行');
    const {thread}=await this.metadata(binding.program,binding.workspace_path,'thread/read',{threadId:item.thread_id,includeTurns:true});
    const turns=thread?.turns??[];
    const matching=turns.filter((turn:any)=>turn.items?.some((entry:any)=>entry.type==='userMessage'&&entry.content?.some((content:any)=>content.type==='text'&&content.text?.includes('ARC 派发 '+item.dispatch_id+'。'))));
    if(!matching.length||turns.some((turn:any)=>!['completed','failed','interrupted'].includes(turn.status)))throw Error('未找到对应派发的已结束回合，或会话仍在执行；保持未知状态，不重新发送。');
    item.state='cancelled';item.revoked=true;item.error='已通过 Codex 会话记录核对：对应派发回合已结束。原执行未完整回填，保留已有成果，需继续原任务。';this.save(item);return item;
  }
  async retry(dispatchId:string){
    const item=this.store.get<Dispatch>('external_dispatch',dispatchId);
    if(item.sent_at||!['blocked','queued'].includes(item.state))throw Error('任务可能已经送达，不能重发。请在原会话使用同一个派发 ID 接续。');
    item.state='queued';item.error=undefined;this.save(item);await this.pump();return this.store.get<Dispatch>('external_dispatch',dispatchId);
  }
  async pump(){
    if(this.pumping)return;this.pumping=true;
    try{
      for(const item of this.items()){
        const run=item.run_id?this.store.maybe<Run>('run',item.run_id):null;
        const attempt=item.attempt_id?this.store.maybe<any>('development_attempt',item.attempt_id):null;
        if(!item.revoked&&item.claimed_at&&['completed','failed','cancelled','blocked_external'].includes(run?.status??attempt?.status)&&!['completed','cancelled','blocked'].includes(item.state)){
          item.state=(run?.status??attempt?.status)==='completed'?'completed':'blocked';item.error=run?.error??attempt?.error;this.save(item);continue;
        }
        if(item.state==='running'&&item.claimed_at&&Date.now()-Date.parse(item.claimed_at)>300000&&run){
          run.status='blocked_external';run.error='外部分析超过 5 分钟预算；已停止接收新结果。外部会话是否停止尚未确认，公开进度与旧结果已保留。';run.ended_at=now();this.store.put('run',run.binding.run_id,run);item.state='unknown';item.revoked=true;item.error=run.error;this.save(item);continue;
        }
        if(item.state==='awaiting_claim'&&item.sent_at&&Date.now()-Date.parse(item.sent_at)>60000){item.state='unknown';item.error='已发送超过 60 秒，尚无领取回执。可能等待权限或外部会话离线，请核对原会话；不会自动重发。';this.save(item);continue;}
        if(item.state!=='queued')continue;
        const binding=this.binding(item.project_id);
        if(!binding||!this.canSend(item.project_id,binding.workspace_path)){
          const reason=binding?'等待在「连接 Agent」重新授权或核对工程目录':'等待绑定已登录的本机 Codex 会话';
          if(item.error!==reason){item.error=reason;this.save(item);}
          continue;
        }
        if(this.items().some(other=>other.dispatch_id!==item.dispatch_id&&other.thread_id===binding.thread_id&&['sending','awaiting_claim','running','unknown'].includes(other.state)))continue;
        try{
          const current=await this.metadata(binding.program,binding.workspace_path,'thread/read',{threadId:binding.thread_id,includeTurns:false});
          if(path.resolve(current.thread.cwd).toLowerCase()!==path.resolve(binding.workspace_path).toLowerCase())throw Error('外部会话工作区已改变');
          await this.command(binding.program,['app-server','daemon','version'],{windowsHide:true,timeout:10000});
          const latestQueued=this.store.get<Dispatch>('external_dispatch',item.dispatch_id),activeBinding=this.binding(item.project_id);
          if(latestQueued.state!=='queued'||latestQueued.revoked||!this.canSend(item.project_id,binding.workspace_path)||
            activeBinding?.thread_id!==binding.thread_id||activeBinding.program!==binding.program)continue;
          binding.model=current.thread.model??null;binding.reasoning_effort=current.thread.reasoningEffort??null;binding.checked_at=now();
          this.store.put('external_executor',binding.project_id,binding);
          item.thread_id=binding.thread_id;item.state='sending';item.sent_at=now();item.error=undefined;this.save(item);
          const message=`ARC 派发 ${item.dispatch_id}。先调用 arc_claim_dispatch，dispatch_id=${item.dispatch_id}，按返回的固定任务、上下文与权限执行。仅操作 ${binding.workspace_path}。如已领取，继续同一任务，禁止新建重复修改。${item.task_id?`${item.phase==='analysis'?'本次是只读需求分析，禁止修改工程或运行构建测试；按领取合同在 ARC 保存 AEC 需求包、实施步骤和建议范围；完成分析后停止，等待用户确认。':'执行已批准的需求包版本和文件范围，按批准的步骤关联验证证据并回填结果。'}使用会话原生只读文件或命令工具核对当前工作区源码；arc_read_source 仅适用于工程分析运行，不接受开发 task_id。`:'工程分析只读本次运行的冻结源码，按领取返回的 run_id 使用 arc_list_files 和 arc_read_source。'}`;
          const response=await this.command(binding.program,['queue','--thread',binding.thread_id,'--message',message,'--resume'],{cwd:binding.workspace_path,windowsHide:true,timeout:20000});
          const latest=this.store.get<Dispatch>('external_dispatch',item.dispatch_id);
          if(latest.state==='sending'){latest.state='awaiting_claim';latest.error=String(response.stderr).trim()?redact(String(response.stderr).trim()):'已排入 Codex，等待实际领取确认';this.save(latest);}
        }catch(error){
          const latest=this.store.get<Dispatch>('external_dispatch',item.dispatch_id);
          if(!latest.revoked&&latest.state!=='running'){latest.state=latest.sent_at?'unknown':'blocked';latest.error=redact((error as Error).message);this.save(latest);}
        }
      }
    }finally{this.pumping=false;}
  }
}
