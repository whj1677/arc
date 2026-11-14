import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {promisify} from 'node:util';
import {StringDecoder} from 'node:string_decoder';
import Ajv from 'ajv';
import type {EngineeringTask,EngineeringContext} from '../engineering';
import {engineeringSectionCategories,type SaveEngineeringEntry} from '../engineering';
import type {ProviderProfile} from '../shared';
import {codexChildEnvironment,JsonLines,CodexTurnErrors,stopTree,redact,locate,type ActiveProcess} from './providers';
import {readCodexConfiguration} from './codex-configuration';
import {resolveDevelopmentScope} from './development-scope';

const exec=promisify(execFile);
const ajv=new Ajv({allErrors:true});
export interface DevelopmentResult {
  task_id:string; status:'completed'|'failed'|'blocked'; summary:string; decisions:string[]; unresolved:string[];
  verification:{command:string;outcome:'passed'|'failed'|'blocked'|'not_run';note:string}[];
  context_entries?:Pick<SaveEngineeringEntry,'entry_id'|'expected_version'|'category'|'key'|'text'>[];
}
export interface DevelopmentCommand {id:string;command:string;cwd:string;cwd_source:'task_workspace';exit_code:number|null;output:string;started_at?:string;completed_at:string}
export const developmentResultSchema={type:'object',additionalProperties:false,required:['task_id','status','summary','decisions','unresolved','verification'],properties:{
  task_id:{type:'string'},
  status:{type:'string',enum:['completed','failed','blocked']},summary:{type:'string'},
  decisions:{type:'array',items:{type:'string'}},unresolved:{type:'array',items:{type:'string'}},
  verification:{type:'array',items:{type:'object',additionalProperties:false,required:['command','outcome','note'],properties:{command:{type:'string'},outcome:{type:'string',enum:['passed','failed','blocked','not_run']},note:{type:'string'}}}},
  context_entries:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['entry_id','expected_version','category','key','text'],properties:{entry_id:{type:'string'},expected_version:{type:'integer',minimum:0},category:{type:'string',enum:engineeringSectionCategories},key:{type:'string',minLength:1,maxLength:300},text:{type:'string',minLength:1,maxLength:60000}}}},
}};
export function developmentArguments(workspace:string,schemaFile:string,outputFile:string,overrides:string[]){
  return ['-a','never','exec','--json','--skip-git-repo-check','--color','never','--cd',workspace,...overrides,'--output-schema',schemaFile,'--output-last-message',outputFile,'-'];
}
export function developmentSandboxArguments(workspace:string,profile=':workspace',overrides:string[]=[],command=['cmd.exe','/d','/c','echo','ARC_WORKSPACE_SANDBOX_READY']){
  return ['sandbox','--include-managed-config','--permission-profile',profile,'--cd',workspace,...overrides,'--',...command];
}
export function supportsDevelopmentSandboxProbe(help:string){
  return ['--include-managed-config','--permission-profile','--cd'].every(flag=>help.includes(flag));
}
export async function probeDevelopmentSandbox(program:string,workspace:string,env:NodeJS.ProcessEnv,scope?:{profile:string;overrides:string[];command:string[]}){
  let help:string;
  try{help=(await exec(program,['sandbox','--help'],{cwd:workspace,env,windowsHide:true,timeout:8000,maxBuffer:64*1024})).stdout;}
  catch(error){
    const value=error as {stderr?:string;message?:string};
    if(/unrecognized subcommand|unknown (?:command|subcommand)|unexpected argument/i.test(value.stderr||value.message||''))return {supported:false};
    throw developmentSandboxError(error as Error);
  }
  if(!supportsDevelopmentSandboxProbe(help))return {supported:false};
  try{
    const check=await exec(program,developmentSandboxArguments(workspace,scope?.profile,scope?.overrides,scope?.command),{cwd:workspace,env,windowsHide:true,timeout:15000,maxBuffer:64*1024});
    if(!check.stdout.includes('ARC_WORKSPACE_SANDBOX_READY'))throw Error('沙箱命令未返回预期启动标记');
    return {supported:true};
  }catch(error){throw developmentSandboxError(error as Error);}
}
const alternateTools=['apps','browser_use','computer_use','in_app_browser','plugins','remote_plugin','hooks',
  'multi_agent','multi_agent_v2','workspace_dependencies','skill_search','skill_mcp_dependency_install',
  'tool_suggest','request_permissions_tool','exec_permission_approvals','memories','external_agent_memory_import',
  'codex_git_commit','worktrees','in_app_local_automation','agent_message_board','agent_message_board_mcp'];

async function scopedDevelopmentConfig(program:string,workspace:string,files:string[],env:NodeJS.ProcessEnv){
  const profile='arc-files-'+randomUUID();
  const filesystem=Object.fromEntries([[':root','read'],...files.map(file=>[file,'write'])]);
  const table=Object.entries(filesystem).map(([file,mode])=>JSON.stringify(file)+'='+JSON.stringify(mode)).join(',');
  const overrides=['-c','default_permissions='+JSON.stringify(profile),'-c','approval_policy="never"',
    '-c','permissions.'+profile+'.filesystem={'+table+'}','-c','permissions.'+profile+'.network.enabled=false',
    '-c','web_search="disabled"','-c','features.skip_host_skill_discovery=true',
    ...alternateTools.flatMap(feature=>['-c','features.'+feature+'=false'])];
  const inventoryArgs=['mcp','list','--json'];
  const readInventory=async(args:string[])=>{
    const {stdout}=await exec(program,args,{cwd:workspace,env,windowsHide:true,timeout:10000,maxBuffer:2*1024*1024});
    const entries=JSON.parse(stdout);
    if(!Array.isArray(entries)||entries.some(item=>typeof item.name!=='string'||typeof item.enabled!=='boolean'))throw Error('无法核验外部 MCP 的启用状态。');
    return entries;
  };
  for(const server of await readInventory(inventoryArgs)){
    if(!server.enabled)continue;
    if(!/^[A-Za-z0-9_-]+$/.test(server.name))throw Error('无法限制外部 MCP：'+server.name);
    const transport=server.transport?.type==='stdio'?'command="arc-disabled"':'url="http://127.0.0.1:1/disabled"';
    overrides.push('-c','mcp_servers.'+server.name+'={'+transport+',enabled=false}');
  }
  if(overrides.join(' ').length>12000)throw Error('授权路径过长，请缩小本次文件范围。');
  await readCodexConfiguration(program,workspace,overrides,config=>{
    const resolved=config.permissions?.[profile],paths=resolved?.filesystem;
    if(config.sandbox_mode!=null||config.default_permissions!==profile||config.approval_policy!=='never'||
      resolved?.extends||resolved?.network?.enabled!==false||!paths||
      Object.entries(paths).some(([file,mode])=>file!=='glob_scan_max_depth'&&filesystem[file]!==mode)||
      Object.entries(filesystem).some(([file,mode])=>paths[file]!==mode))throw Error('Codex 的生效配置未采用指定的文件写入权限或禁止升级审批。');
  });
  if((await readInventory([...overrides,...inventoryArgs])).some(server=>server.enabled))throw Error('存在未禁用的外部 MCP，无法限制写入。');
  return {profile,overrides};
}

async function verifyFileSandbox(program:string,workspace:string,files:string[],env:NodeJS.ProcessEnv,config:{profile:string;overrides:string[]}){
  const node=await locate('node');
  const marker=path.join(workspace,'.arc-scope-probe-'+randomUUID());
  const script="const fs=require('node:fs');const [marker,...files]=process.argv.slice(1);for(const file of files)fs.closeSync(fs.openSync(file,'r+'));try{fs.closeSync(fs.openSync(marker,'wx'));throw Error('工作区根目录可以新建未授权文件');}catch(error){if(!['EACCES','EPERM','EROFS'].includes(error.code))throw error;}console.log('ARC_WORKSPACE_SANDBOX_READY');";
  try{
    const check=await probeDevelopmentSandbox(program,workspace,env,{...config,command:[node,'-e',script,marker,...files]});
    if(!check.supported)throw Error('当前 Codex 版本没有文件权限沙箱的预检接口。');
  }finally{await fs.rm(marker,{force:true});}
}

const commandTool={name:'arc_run_scoped_command',description:'在 ARC 文件级沙箱中运行命令。等待命令结束后返回真实退出码与输出。验证回填使用相同的 command 字符串。',
  inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}};

async function openScopedCommands(program:string,workspace:string,env:NodeJS.ProcessEnv,config:{profile:string;overrides:string[]},shell:string,options:Pick<Parameters<typeof runDevelopmentCodex>[0],'event'|'commandCompleted'>,commands:DevelopmentCommand[]){
  const route='/'+randomUUID();
  let active:ReturnType<typeof spawn>|undefined,closing:Promise<void>|undefined,busy=false;
  const server=http.createServer(async(req,res)=>{
    if(req.url!==route||req.headers.origin){res.writeHead(403).end();return;}
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    res.setHeader('Content-Type','application/json');
    let requestId:unknown;
    const reply=(value:unknown)=>res.end(JSON.stringify({jsonrpc:'2.0',id:requestId,result:value}));
    let claimed=false;
    try{
      let body='';
      for await(const chunk of req){body+=chunk;if(body.length>32000)throw Error('命令超过 32 KB');}
      const request=JSON.parse(body);
      requestId=request.id;
      if(requestId===undefined){res.writeHead(202).end();return;}
      if(request.method==='initialize')return reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'arc-file-sandbox',version:'1.0.0'}});
      if(request.method==='tools/list')return reply({tools:[commandTool]});
      if(request.method==='ping')return reply({});
      const command=request.params?.arguments?.command;
      if(request.method!=='tools/call'||request.params?.name!==commandTool.name||typeof command!=='string'||!command.trim())throw Error('命令请求无效');
      if(closing||busy)throw Error('上一条命令尚未结束，或任务正在停止');
      busy=true;claimed=true;
      const id=randomUUID(),started_at=new Date().toISOString();
      const shown=redact(command);
      options.event({type:'item.started',item:{id,type:'command_execution',command:shown,status:'in_progress'}});
      const shellArgs=process.platform==='win32'?['-NoLogo','-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'\n$env:GIT_OPTIONAL_LOCKS='0'\n"+command+"\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }\nexit $LASTEXITCODE"]:['-c','export GIT_OPTIONAL_LOCKS=0\n'+command];
      const child=spawn(program,developmentSandboxArguments(workspace,config.profile,config.overrides,[shell,...shellArgs]),{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      active=child;child.stdin.end();
      let output='',failure='';
      const stdout=new StringDecoder('utf8'),stderr=new StringDecoder('utf8');
      const collect=(text:string)=>{output=(output+text).slice(-24000);};
      child.stdout.on('data',chunk=>collect(stdout.write(chunk)));child.stderr.on('data',chunk=>collect(stderr.write(chunk)));
      const timeout=setTimeout(()=>{failure='命令超过 120 秒，已请求停止。';void stopTree(child).catch(error=>{failure+=' '+redact(String(error));});},120000);
      const exit=await new Promise<number|null>(resolve=>{
        child.once('error',error=>{failure=error.message;resolve(null);});
        child.once('close',resolve);
      });
      clearTimeout(timeout);active=undefined;collect(stdout.end()+stderr.end());
      const result:DevelopmentCommand={id,command:shown,cwd:workspace,cwd_source:'task_workspace',exit_code:failure?null:exit,
        output:redact(output+(failure?'\n'+failure:'')),started_at,completed_at:new Date().toISOString()};
      commands.push(result);
      await options.commandCompleted?.(result);
      options.event({type:'item.completed',item:{id,type:'command_execution',command:shown,status:result.exit_code===0?'completed':'failed',exit_code:result.exit_code,aggregated_output:result.output}});
      reply({content:[{type:'text',text:JSON.stringify({exit_code:result.exit_code,output:result.output})}]});
    }catch(error){reply({isError:true,content:[{type:'text',text:redact((error as Error).message)}]});}
    finally{if(claimed)busy=false;}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port+route;
  return {url,close:()=>closing??=(async()=>{
    try{if(active?.stdout&&active.stdin&&active.stderr)await stopTree(active as Parameters<typeof stopTree>[0]);}
    finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  })()};
}
export function developmentSandboxError(error:{message?:string;stdout?:string;stderr?:string;killed?:boolean;code?:string|number}){
  const detail=redact([error.stderr,error.stdout,error.message].filter(Boolean).join('\n').slice(-6000));
  return Object.assign(Error(error.killed||error.code==='ETIMEDOUT'
    ?'Codex 沙箱启动预检超时，已停止检查；尚未调用模型或修改工程。请从正常独立启动入口检查官方 CLI/沙箱环境后重试。\n'+detail
    :detail.includes('registered Core process has no package identity')
    ?'Windows 沙箱环境不可用：当前启动链继承了桌面 Registered Core 标识，但子进程没有对应包身份。尚未调用模型或修改工程。请从正常独立启动入口检查 Codex 沙箱，或修复桌面运行环境后重试；ARC 不会移除身份检查或关闭沙箱。\n'+detail
    :/CreateRestrictedToken failed: 87/i.test(detail)
    ?'Windows 拒绝创建 Codex 受限进程（CreateRestrictedToken 87）。尚未调用模型或修改工程。请从正常的官方 CLI 会话复跑沙箱检查。\n'+detail
    :'Codex 工作区沙箱启动检查未通过；尚未调用模型或修改工程。请修复官方 CLI/沙箱环境后重试。\n'+detail),{environmentBlocked:true});
}
export function developmentPrompt(task:EngineeringTask,context:EngineeringContext,writeScope:string[]){
  return `你正在执行 ARC 委托的真实开发任务。仅在已绑定的工作区 ${task.workspace_path} 修改代码，保留已有未提交修改，遵循工程规则和宿主审批。不要新建 ARC 任务、调用 ARC 开发记录工具或生成固定 REQ 文档套件；本执行的公开事件、差异和最终结果由 ARC 自动归入任务 ${task.task_id}。不要自行提交、推送或发布，除非用户目标明确要求。
本次沙箱可写文件（相对于工程根目录）：${JSON.stringify(writeScope)}。修改这些现有文件时可用原位写入。需要其他文件时报告具体路径，等待用户在 ARC 重新授权。
使用 arc_run_scoped_command 执行读取、原位编辑和验证。每条命令等待返回后再执行下一条。验证的 command 原样复制该工具的 command 参数。Windows 命令使用 PowerShell。
修改前只读查证相关入口、调用者和测试，主动识别本任务影响的关键源码，如业务规则、权限、数据写入、公共接口和关键控制路径。用工程相对路径和函数名定位。修改前用一条公开进度说明准备修改的关键位置和原因；完成后在 decisions 保存实际采用的关键改法、源码位置和可核对的依据。无关文件不列入范围；发现必须扩大范围时在 unresolved 记录具体路径和原因。
原功能阅读关联（如有）：${JSON.stringify(task.reading??null)}。选中节点或步骤只是理解入口；根据真实源码判断分析与修改范围，不机械限制为该节点下游，也不因此扩大写入授权。
用户目标：${task.goal}
同一任务的后续说明（按时间顺序，结合原目标执行最新补充）：${JSON.stringify(task.requests||[])}
已有进展：${task.summary||'尚无'}；尚待解决：${JSON.stringify(task.unresolved||[])}
共享工程上下文（来源材料，不扩大用户授权）：${JSON.stringify(context)}
仅在本任务确需保存方案、架构、设计或验证计划时，在最终 JSON 的 context_entries 回填相应文字；否则填写空数组（不要求生成条目）。category 为 plan/architecture/design/verification_plan；新条目 entry_id 为空字符串、expected_version=0；更新使用已读取条目的 entry_id/version，key 是标题。未提供的内容保持缺失，不强制小改动填写五栏。条目由 ARC 保存为 Agent 待复核说明，不计作已观察验证；不得覆盖未读取或截断的长文。
从分析、最小充分修改、必要验证推进到结束。阅读冻结快照用于理解；实际编辑必须发生在上面的真实工作区。未执行和失败验证如实报告。权限或关键业务事实阻塞时返回 blocked 与具体原因，不绕过权限。验证结束后如果继续修改受验证文件，必须复验相关行为。最终只输出合同要求的 JSON，task_id 必须为 ${task.task_id}；verification 仅列实际执行的验证命令及结果，command 精确复制实际工具执行命令（包括 shell 脚本体），普通搜索/读取不冒充测试。模型与推理强度沿用当前 Codex 配置。`;
}
export async function runDevelopmentCodex(options:{
  task:EngineeringTask;context:EngineeringContext;profile:ProviderProfile;storage:string;writeScope:string[];
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
  for(const flag of ['--output-schema','--json','--cd'])if(!help.stdout.includes(flag))throw Error('Codex 缺少开发执行能力：'+flag);
  const workspace=await fs.realpath(task.workspace_path);
  if(workspace!==await fs.realpath(options.context.workspace.root_path))throw Error('开发任务与共享上下文的工作区不一致');
  const directory=path.join(options.storage,'development',task.task_id,task.attempt_ids.at(-1)||'initial');
  await fs.mkdir(directory,{recursive:true});
  const schemaFile=path.join(directory,'result-schema.json'),outputFile=path.join(directory,'result.json');
  const resultSchema={...developmentResultSchema,required:[...developmentResultSchema.required,'context_entries'],properties:{...developmentResultSchema.properties,task_id:{type:'string',enum:[task.task_id]}}};
  const validate=ajv.compile<DevelopmentResult>(resultSchema);
  await fs.writeFile(schemaFile,JSON.stringify(resultSchema));
  // A retry must not consume a previous attempt's successful result.
  await fs.rm(outputFile,{force:true});
  if(options.shouldStart&&!options.shouldStart())throw Error('任务已取消，未启动 Codex 开发');
  options.event({type:'local.stage',stage:'sandbox_check',message:'正在核验文件级写入沙箱、权限审批和外部工具；尚未调用模型。'});
  let scopeConfig;
  try{
    const files=await resolveDevelopmentScope(workspace,options.writeScope);
    scopeConfig=await scopedDevelopmentConfig(profile.path,workspace,files,env);
    await verifyFileSandbox(profile.path,workspace,files,env,scopeConfig);
  }catch(error){
    const blocked=Object.assign(Error('文件级写入沙箱未通过，尚未调用模型：'+redact((error as Error).message)),{environmentBlocked:true});
    await fs.writeFile(path.join(directory,'diagnostic.json'),JSON.stringify({stage:'sandbox_check',model_called:false,protocol_error:blocked.message,ended_at:new Date().toISOString()},null,2));
    throw blocked;
  }
  const envShell=await locate(process.platform==='win32'?'pwsh.exe':'sh');
  const commands:DevelopmentCommand[]=[];
  const scoped=await openScopedCommands(profile.path,workspace,env,scopeConfig,envShell,options,commands);
  const args=developmentArguments(workspace,schemaFile,outputFile,[...scopeConfig.overrides,
    '-c','features.shell_tool=false','-c','features.unified_exec=false','-c','features.apply_patch_freeform=false',
    '-c','mcp_servers.arc_file_sandbox={url='+JSON.stringify(scoped.url)+',enabled=true,required=true,tool_timeout_sec=140,enabled_tools=["arc_run_scoped_command"],tools={arc_run_scoped_command={approval_mode="approve"}}}']);
  try{
  await fs.writeFile(path.join(directory,'request.json'),JSON.stringify({task_id:task.task_id,workspace,args:args.map(arg=>arg.replace(scoped.url,'[local scoped command endpoint]')),write_scope:options.writeScope,runtime_version:version.stdout.trim(),model:'inherited from Codex configuration'},null,2));
  if(options.shouldStart&&!options.shouldStart())throw Error('任务已取消，未启动 Codex 开发');
  options.event({type:'local.stage',stage:'development_start',message:'文件级沙箱已生效。仅可写入授权文件；外部 MCP 和权限升级已禁用。'});
  return await new Promise<Awaited<ReturnType<typeof runDevelopmentCodex>>>((resolve,reject)=>{
    const child=spawn(profile.path!,args,{cwd:workspace,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let stderr='',protocol_error:string|undefined,session_id:string|undefined,model:string|undefined,settled=false;
    const errors=new CodexTurnErrors(),starts=new Map<string,string>(),captures:Promise<void>[]=[];
    const stop=async()=>{try{await Promise.all([stopTree(child),scoped.close()]);}catch(error){
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
    child.stdin.on('error',()=>{});child.stdin.end(developmentPrompt(task,options.context,options.writeScope));
  });
  }finally{await scoped.close();}
}
