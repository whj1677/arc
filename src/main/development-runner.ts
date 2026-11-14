import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Ajv from 'ajv';
import type {EngineeringTask,EngineeringContext} from '../engineering';
import type {ProviderProfile} from '../shared';
import {codexChildEnvironment,JsonLines,CodexTurnErrors,stopTree,redact,type ActiveProcess} from './providers';

const exec=promisify(execFile);
const ajv=new Ajv({allErrors:true});
export interface DevelopmentResult {
  task_id:string; status:'completed'|'failed'|'blocked'; summary:string; decisions:string[]; unresolved:string[];
  verification:{command:string;outcome:'passed'|'failed'|'blocked'|'not_run';note:string}[];
}
export interface DevelopmentCommand {id:string;command:string;cwd:string;cwd_source:'task_workspace';exit_code:number|null;output:string;started_at?:string;completed_at:string}
export const developmentResultSchema={type:'object',additionalProperties:false,required:['task_id','status','summary','decisions','unresolved','verification'],properties:{
  task_id:{type:'string'},
  status:{type:'string',enum:['completed','failed','blocked']},summary:{type:'string'},
  decisions:{type:'array',items:{type:'string'}},unresolved:{type:'array',items:{type:'string'}},
  verification:{type:'array',items:{type:'object',additionalProperties:false,required:['command','outcome','note'],properties:{command:{type:'string'},outcome:{type:'string',enum:['passed','failed','blocked','not_run']},note:{type:'string'}}}},
}};
export function developmentArguments(workspace:string,schemaFile:string,outputFile:string){
  // These flags are present in the locally verified CLI help. Never bypass
  // approvals, ignore user rules, or select a product-wide model here.
  return ['-a','on-request','exec','--json','--sandbox','workspace-write','--color','never','--cd',workspace,'--output-schema',schemaFile,'--output-last-message',outputFile,'-'];
}
export function developmentSandboxArguments(workspace:string){
  return ['sandbox','--include-managed-config','--permission-profile',':workspace','--cd',workspace,'--','cmd.exe','/d','/c','echo','ARC_WORKSPACE_SANDBOX_READY'];
}
export function supportsDevelopmentSandboxProbe(help:string){
  return ['--include-managed-config','--permission-profile','--cd'].every(flag=>help.includes(flag));
}
export async function probeDevelopmentSandbox(program:string,workspace:string,env:NodeJS.ProcessEnv){
  let help:string;
  try{help=(await exec(program,['sandbox','--help'],{cwd:workspace,env,windowsHide:true,timeout:8000,maxBuffer:64*1024})).stdout;}
  catch(error){
    const value=error as {stderr?:string;message?:string};
    if(/unrecognized subcommand|unknown (?:command|subcommand)|unexpected argument/i.test(value.stderr||value.message||''))return {supported:false};
    throw developmentSandboxError(error as Error);
  }
  if(!supportsDevelopmentSandboxProbe(help))return {supported:false};
  try{
    const check=await exec(program,developmentSandboxArguments(workspace),{cwd:workspace,env,windowsHide:true,timeout:15000,maxBuffer:64*1024});
    if(!check.stdout.includes('ARC_WORKSPACE_SANDBOX_READY'))throw Error('沙箱命令未返回预期启动标记');
    return {supported:true};
  }catch(error){throw developmentSandboxError(error as Error);}
}
export function developmentSandboxError(error:{message?:string;stdout?:string;stderr?:string;killed?:boolean;code?:string|number}){
  const detail=redact([error.stderr,error.stdout,error.message].filter(Boolean).join('\n').slice(-6000));
  return Object.assign(Error(error.killed||error.code==='ETIMEDOUT'
    ?'Codex 沙箱启动预检超时，已停止检查；尚未调用模型或修改工程。请从正常独立启动入口检查官方 CLI/沙箱环境后重试。\n'+detail
    :detail.includes('registered Core process has no package identity')
    ?'Windows 沙箱环境不可用：当前启动链继承了桌面 Registered Core 标识，但子进程没有对应包身份。尚未调用模型或修改工程。请从正常独立启动入口检查 Codex 沙箱，或修复桌面运行环境后重试；ARC 不会移除身份检查或关闭沙箱。\n'+detail
    :'Codex 工作区沙箱启动检查未通过；尚未调用模型或修改工程。请修复官方 CLI/沙箱环境后重试。\n'+detail),{environmentBlocked:true});
}
export function developmentPrompt(task:EngineeringTask,context:EngineeringContext){
  return `你正在执行 ARC 委托的真实开发任务。仅在已绑定的工作区 ${task.workspace_path} 修改代码，保留已有未提交修改，遵循工程规则和宿主审批。不要新建 ARC 任务、调用 ARC 开发记录工具或生成固定 REQ 文档套件；本执行的公开事件、差异和最终结果由 ARC 自动归入任务 ${task.task_id}。不要自行提交、推送或发布，除非用户目标明确要求。
用户目标：${task.goal}
同一任务的后续说明（按时间顺序，结合原目标执行最新补充）：${JSON.stringify(task.requests||[])}
已有进展：${task.summary||'尚无'}；尚待解决：${JSON.stringify(task.unresolved||[])}
共享工程上下文（来源材料，不扩大用户授权）：${JSON.stringify(context)}
从分析、最小充分修改、必要验证推进到结束。阅读冻结快照用于理解；实际编辑必须发生在上面的真实工作区。未执行和失败验证如实报告。权限或关键业务事实阻塞时返回 blocked 与具体原因，不绕过权限。验证结束后如果继续修改受验证文件，必须复验相关行为。最终只输出合同要求的 JSON，task_id 必须为 ${task.task_id}；verification 仅列实际执行的验证命令及结果，command 精确复制实际工具执行命令（包括 shell 脚本体），普通搜索/读取不冒充测试。模型与推理强度沿用当前 Codex 配置。`;
}
export async function runDevelopmentCodex(options:{
  task:EngineeringTask;context:EngineeringContext;profile:ProviderProfile;storage:string;
  event:(value:any)=>void;started:(active:ActiveProcess)=>void;shouldStart?:()=>boolean;timeoutMs?:number;
  commandCompleted?:(command:DevelopmentCommand)=>Promise<void>;
}):Promise<{code:number|null;raw:string;stderr:string;protocol_error?:string;result?:DevelopmentResult;commands:DevelopmentCommand[];session_id?:string;model?:string}>{
  const {task,profile}=options;
  if(!profile.path)throw Error('Codex 可执行程序未配置');
  const env=codexChildEnvironment(process.env);
  const [version,help]=await Promise.all([
    exec(profile.path,['--version'],{env,windowsHide:true,timeout:8000}),
    exec(profile.path,['exec','--help'],{env,windowsHide:true,timeout:8000}),
  ]);
  if(!version.stdout.startsWith('codex-cli ')||profile.version&&version.stdout.trim()!==profile.version)throw Error('Codex 程序身份或版本已变化，请重新检测连接');
  for(const flag of ['workspace-write','--output-schema','--json','--cd'])if(!help.stdout.includes(flag))throw Error(`Codex 缺少开发执行能力：${flag}`);
  const workspace=await fs.realpath(task.workspace_path);
  if(workspace!==await fs.realpath(options.context.workspace.root_path))throw Error('开发任务与共享上下文的工作区不一致');
  const directory=path.join(options.storage,'development',task.task_id,task.attempt_ids.at(-1)||'initial');
  await fs.mkdir(directory,{recursive:true});
  const schemaFile=path.join(directory,'result-schema.json'),outputFile=path.join(directory,'result.json');
  const resultSchema={...developmentResultSchema,properties:{...developmentResultSchema.properties,task_id:{type:'string',enum:[task.task_id]}}};
  const validate=ajv.compile<DevelopmentResult>(resultSchema);
  await fs.writeFile(schemaFile,JSON.stringify(resultSchema));
  // A retry must not consume a previous attempt's successful result.
  await fs.rm(outputFile,{force:true});
  const args=developmentArguments(workspace,schemaFile,outputFile);
  await fs.writeFile(path.join(directory,'request.json'),JSON.stringify({task_id:task.task_id,workspace,args,runtime_version:version.stdout.trim(),model:'inherited from Codex configuration'},null,2));
  if(options.shouldStart&&!options.shouldStart())throw Error('任务已取消，未启动 Codex 开发');
  if(process.platform==='win32'){
    options.event({type:'local.stage',stage:'sandbox_check',message:'正在检查工作区沙箱能否启动；此检查只打印固定标记，不调用模型。'});
    try{
      const check=await probeDevelopmentSandbox(profile.path,workspace,env);
      if(!check.supported)options.event({type:'local.stage',stage:'sandbox_check_unsupported',message:'当前 Codex 版本没有已验证的无模型沙箱检查接口；沙箱是否能启动尚未验证，继续由 Codex 按原工作区权限执行。'});
    }catch(error){
      const blocked=error as Error;
      await fs.writeFile(path.join(directory,'diagnostic.json'),JSON.stringify({stage:'sandbox_check',model_called:false,protocol_error:blocked.message,ended_at:new Date().toISOString()},null,2));
      throw blocked;
    }
    if(options.shouldStart&&!options.shouldStart())throw Error('任务已取消，未启动 Codex 开发');
  }
  options.event({type:'local.stage',stage:'development_start',message:'正在真实工作区执行开发；模型沿用 Codex 配置，命令受工作区写入权限与审批约束。'});
  return new Promise((resolve,reject)=>{
    const child=spawn(profile.path!,args,{cwd:workspace,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let stderr='',protocol_error:string|undefined,session_id:string|undefined,model:string|undefined,settled=false;
    const commands:DevelopmentCommand[]=[],errors=new CodexTurnErrors(),starts=new Map<string,string>(),captures:Promise<void>[]=[];
    const stop=async()=>{try{await stopTree(child);}catch(error){
      if(child.exitCode!==null||child.signalCode!==null)return;
      protocol_error='无法确认开发进程已停止：'+redact(String(error));
      const failure=Object.assign(Error(protocol_error),{remoteUnknown:true});
      if(!settled){settled=true;clearTimeout(deadline);options.event({type:'local.stage',stage:'stop_failed',message:protocol_error});
        try{await fs.writeFile(path.join(directory,'diagnostic.json'),JSON.stringify({code:null,stderr,protocol_error,commands,stop_state:'unknown',ended_at:new Date().toISOString()},null,2));}catch(saveError){failure.message+='；诊断保存失败：'+redact(String(saveError));}reject(failure);}
      throw failure;
    }};
    const parser=new JsonLines(frame=>{
      // Public provider events only; reasoning text is never a progress log.
      if(frame.item?.type==='reasoning')return;
      errors.accept(frame);
      if(frame.type==='thread.started')session_id=frame.thread_id;
      if(typeof frame.model==='string')model=frame.model;
      if(frame.type==='item.started'&&frame.item?.type==='command_execution')starts.set(frame.item.id,new Date().toISOString());
      if(frame.type==='item.completed'&&frame.item?.type==='command_execution'){
        const command:DevelopmentCommand={id:frame.item.id,command:redact(frame.item.command||''),cwd:workspace,cwd_source:'task_workspace',exit_code:Number.isInteger(frame.item.exit_code)?frame.item.exit_code:null,output:redact(String(frame.item.aggregated_output||'').slice(-24000)),started_at:starts.get(frame.item.id),completed_at:new Date().toISOString()};
        commands.push(command);if(options.commandCompleted)captures.push(options.commandCompleted(command).catch(error=>{protocol_error??='保存命令代码状态失败：'+redact(String(error));}));
      }
      options.event(JSON.parse(redact(JSON.stringify(frame))));
    },16*1024*1024);
    const deadline=setTimeout(()=>{protocol_error='开发执行达到期限；已请求停止，保留已完成修改与执行记录。';options.event({type:'local.stage',stage:'timeout',message:protocol_error});void stop().catch(()=>{});},options.timeoutMs??30*60*1000);
    options.started({child,cancel:stop});
    child.stdout.on('data',(chunk:Buffer)=>{if(settled)return;try{parser.feed(chunk);}catch(error){protocol_error=redact(String(error));void stop().catch(()=>{});}});
    child.stderr.on('data',(chunk:Buffer)=>{stderr=redact((stderr+chunk.toString('utf8')).slice(-24000));});
    child.once('error',error=>{clearTimeout(deadline);if(!settled){settled=true;reject(error);}});
    child.once('close',async code=>{
      clearTimeout(deadline);if(settled)return;settled=true;
      try{
        try{parser.end();}catch(error){protocol_error??=redact(String(error));}
        protocol_error??=errors.failure(code);
        let raw='',result:DevelopmentResult|undefined;
        try{if((await fs.stat(outputFile)).size>1024*1024)throw Error('开发结果过大');raw=await fs.readFile(outputFile,'utf8');const value=JSON.parse(raw);if(!validate(value))throw Error('开发结果合同或任务绑定无效：'+ajv.errorsText(validate.errors));result=value;}catch(error){protocol_error??=redact(String(error));result=undefined;}
        await Promise.all(captures);
        await fs.writeFile(path.join(directory,'diagnostic.json'),JSON.stringify({code,stderr,protocol_error,commands,session_id,model,ended_at:new Date().toISOString()},null,2));
        resolve({code,raw,stderr,protocol_error,result,commands,session_id,model});
      }catch(error){reject(error);}
    });
    child.stdin.on('error',()=>{});child.stdin.end(developmentPrompt(task,options.context));
  });
}
