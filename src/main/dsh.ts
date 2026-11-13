import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {load as loadYaml} from 'js-yaml';
import {AcpConnection,resolveDsh,locate,stopTree,redact,type ActiveProcess} from './providers';
import type {Run,Snapshot,ProviderProfile} from '../shared';
import {schema} from './validation';
import {now} from './store';

// Version-pinned official base composition. Do not apply this patch to the
// user's shared profiles. Every general-purpose model tool is disabled; only
// the per-run Arc MCP tools are attached by session/new.
export const disabledDshTools=[
  'tool-plugin-manager','plugin-manager','hmr','tool-working-directory','tool-bash','tool-pwsh','tool-jobs',
  'tool-fs','tool-fs-search','skill','skill-filesystem','tool-skill','tool-subagent-control',
  'tool-subagent-list-agents','tool-subagent','tool-subagent-fork','tool-workflow',
  'tool-todo','tool-goal','tool-web','session-telemetry-otel'
];
// ACP messageId separates commentary from the final assistant message. Keep
// every original event; never concatenate distinct messages into one JSON.
export function dshFinalMessage(events:any[]){
  const messages=new Map<string,string>();
  for(const event of events){const update=event.update;
    if(update?.sessionUpdate!=='agent_message_chunk'||update.content?.type!=='text')continue;
    const key=typeof update.messageId==='string'?update.messageId:'legacy-message';
    messages.set(key,(messages.get(key)||'')+update.content.text);
  }
  const last=[...messages.values()].at(-1);
  if(!last)throw new Error('ACP 未返回助理正文');
  return last;
}
export function parseProviderText(raw:string,provider:string){
  let text=raw.trim();
  // Only remove a complete outer code fence. No repair, inferred fields, or
  // arbitrary brace extraction; the full Arc schema and source checks follow.
  if(provider==='dsh'&&/^```(?:json)?\s*\n[\s\S]*\n```$/i.test(text))text=text.replace(/^```(?:json)?\s*\n/i,'').replace(/\n```$/,'');
  return JSON.parse(text);
}
export async function dshRuntime(directory:string,configured?:string,ownedHome?:string) {
  const dsh=await resolveDsh(configured);
  const home=ownedHome||path.join(directory,'providers','dsh-home');
  await fs.mkdir(home,{recursive:true});
  const patch=path.join(home,'arc-read-only.patch.yml');
  await fs.writeFile(patch,disabledDshTools.map(id=>`- id: ${id}\n  disabled: true`).join('\n')+'\n');
  const env:NodeJS.ProcessEnv={...process.env,DSH_HOME:home,DSH_PERMISSION_MODE:'read-only'};
  delete env.ELECTRON_RUN_AS_NODE;
  // Reuse an existing local provider credential in child memory only. Never
  // copy the credential file into the Arc database, logs, source or package.
  let authenticated=Boolean(env.DEEPSEEK_API_KEY);
  if(!authenticated)try{
    const existing=loadYaml(await fs.readFile(path.join(os.homedir(),'.dsh','.credentials.yaml'),'utf8')) as any;
    const key=existing?.refs?.DEEPSEEK_API_KEY;
    if(typeof key==='string'&&key){env.DEEPSEEK_API_KEY=key;authenticated=true;}
  }catch{/* No auth is a distinct blocker; never print the file content. */}
  return {dsh,home,patch,env,authenticated};
}
export async function probeDsh(directory:string,configured:string,version:string):Promise<Partial<ProviderProfile>> {
  if(version!=='0.2.1-rc.2')return {status:'blocked_external',reason:`当前 Arc 只读工具组合已按 DSH 0.2.1-rc.2 建立，实际为 ${version}。请选择已隔离安装且经验证的版本。`};
  const r=await dshRuntime(directory,configured);
  const child=spawn(r.dsh.command,[...r.dsh.prefix,'--profile','acp','--patch',r.patch],{cwd:r.home,windowsHide:true,shell:false,env:r.env,stdio:['pipe','pipe','pipe']});
  let diagnostic='';child.stderr.on('data',(d:Buffer)=>{diagnostic=redact((diagnostic+d.toString()).slice(-4000));});
  const client=new AcpConnection(child,()=>{});
  try{
    const handshake=await client.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'Arc',version:'0.1.0'}},30000);
    if(handshake.protocolVersion!==1)throw new Error('DSH 不支持 ACP v1');
    await fs.writeFile(path.join(r.home,'handshake.json'),JSON.stringify({version,checked_at:now(),handshake,diagnostic},null,2));
    return {status:r.authenticated?'available':'auth_required',auth:r.authenticated?'原 DSH 凭据引用已找到；模型请求待实测':'缺少 DeepSeek Harness 已配置凭据',reason:'ACP v1 真实握手通过；本地快照通过受限 MCP 提供。图形客户端会话互通尚未验证。',capabilities:{submit_task:'native: session/new + session/prompt',event_stream:'native: session/update',cancel_run:'native: session/cancel；等待终态',restore:'unsupported: 本版保留 ID，不自动 resume',followup:'emulated: 新 run，带来源摘要',workspace_binding:'native: cwd + 单运行 MCP 源码能力',code_write:'unsupported: 只读工具白名单'}};
  }catch(e){return {status:'blocked_external',reason:`ACP 握手失败：${redact((e as Error).message)} ${diagnostic.slice(-1200)}`};}
  finally{child.stdin.end();await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{void stopTree(child).finally(resolve);},5000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
}
export async function runDsh(options:{run:Run;snapshot:Snapshot;storage:string;resources:string;profile:ProviderProfile;prompt:string;event:(event:any)=>void;started:(active:ActiveProcess)=>void}) {
  const {run,snapshot,storage,resources,profile}=options,r=await dshRuntime(storage,profile.path);
  if(!r.authenticated)throw new Error('DSH 模型授权缺失');
  if(profile.version!=='0.2.1-rc.2')throw new Error('DSH 版本不在已验证的只读组合内');
  const runDir=path.dirname(run.output_path);await fs.mkdir(runDir,{recursive:true});
  const contextPath=path.join(runDir,'source-context.json'),serverPath=path.join(runDir,'context-server.cjs');
  await fs.writeFile(contextPath,JSON.stringify({storage,snapshot}));await fs.copyFile(path.join(resources,'dist','context-server.cjs'),serverPath);
  const cwd=path.join(storage,'snapshots',snapshot.source_snapshot_id);
  const child=spawn(r.dsh.command,[...r.dsh.prefix,'--profile','acp','--patch',r.patch],{cwd,windowsHide:true,shell:false,env:r.env,stdio:['pipe','pipe','pipe']});
  let sessionId='',raw='',stderr='',cancelling=false,promptSent=false,terminalReceived=false;
  const messageEvents:any[]=[];
  child.stderr.on('data',(chunk:Buffer)=>{stderr=redact((stderr+chunk.toString()).slice(-12000));});
  const client=new AcpConnection(child,frame=>{
    if(frame.method==='session/request_permission'){
      // This mode has no authority to widen tools or write scope.
      client.respond(frame.id,{outcome:{outcome:'cancelled'}});
      options.event({type:'permission_denied',reason:'只读分析不自动批准扩大权限',session_id:sessionId});return;
    }
    if(frame.method==='session/update'){
      if(frame.params?.sessionId!==sessionId)return;
      const update=frame.params.update;
      messageEvents.push({update});
      options.event({type:'session.update',session_id:sessionId,update});
      if(update?.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text'){
        raw+=update.content.text;if(Buffer.byteLength(raw)>2*1024*1024){void stopTree(child);throw new Error('DSH 结果超过 2 MiB');}
      }
    }
  });
  options.started({child,cancel:async()=>{cancelling=true;if(sessionId)client.notify('session/cancel',{sessionId});else await stopTree(child);}});
  try{
    const handshake=await client.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'Arc',version:'0.1.0'}},30000);
    if(handshake.protocolVersion!==1)throw new Error('ACP v1 握手不兼容');
    const session=await client.request('session/new',{cwd,mcpServers:[{name:'arc-frozen-source',command:await locate('node'),args:[serverPath,contextPath],env:[]}]},30000);
    if(typeof session.sessionId!=='string'||!session.sessionId)throw new Error('ACP 未返回可验证会话 ID');
    sessionId=session.sessionId;options.event({type:'session.started',thread_id:sessionId});
    const prompt=options.prompt+'\n使用 arc-frozen-source 的只读工具读取源码；无需也不允许命令执行。最终回复必须仅为 JSON，严格遵循这个 Arc 合同：'+JSON.stringify(schema);
    await fs.writeFile(path.join(runDir,'request.json'),JSON.stringify({binding:run.binding,provider:'dsh',runtime_version:profile.version,session_id:sessionId,cwd,source_fingerprint:snapshot.fingerprint,handshake,tools:'arc_list_files / arc_read_source only'},null,2));
    await fs.writeFile(path.join(runDir,'prompt.txt'),prompt);
    if(cancelling){await client.request('session/close',{sessionId});return {code:0,raw:'',stderr,cancelled:true};}
    promptSent=true;
    // A model turn may legitimately take longer than ten minutes. Keep the
    // handshake deadlines, but wait for this turn's terminal reply or cancel.
    const final=await client.request('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]},null);
    terminalReceived=true;
    options.event({type:'provider.finished',session_id:sessionId,stop_reason:final.stopReason});
    const cancelled=final.stopReason==='cancelled';
    await fs.writeFile(path.join(runDir,'transcript.txt'),raw);
    const finalText=cancelled?raw:dshFinalMessage(messageEvents);
    await fs.writeFile(run.output_path,finalText);
    await fs.writeFile(path.join(runDir,'diagnostic.json'),JSON.stringify({stop_reason:final.stopReason,stderr,ended_at:now()},null,2));
    if(!cancelled&&final.stopReason!=='end_turn')throw new Error(`DSH 停止原因 ${final.stopReason}，不能当作分析成功`);
    try{await client.request('session/close',{sessionId},20000);}catch(e){options.event({type:'session.close_failed',session_id:sessionId,error:redact((e as Error).message),terminal_already_received:true});}
    return {code:0,raw:finalText,stderr,cancelled};
  }catch(e){await fs.writeFile(path.join(runDir,'partial.txt'),redact(raw));await fs.writeFile(path.join(runDir,'diagnostic.json'),JSON.stringify({error:redact((e as Error).message),stderr,session_id:sessionId,remote_unknown:promptSent&&!terminalReceived},null,2));if(promptSent&&!terminalReceived)Object.assign(e as Error,{remoteUnknown:true});throw e;}
  finally{child.stdin.end();await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{void stopTree(child).finally(resolve);},7000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
}
