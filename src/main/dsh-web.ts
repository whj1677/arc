import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {dump} from 'js-yaml';
import {dshRuntime,disabledDshTools} from './dsh';
import {locate,redact,stopTree,type ActiveProcess} from './providers';
import {schema} from './validation';
import type {Run,Snapshot,ProviderProfile} from '../shared';

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const textOf=(message:any)=>(message?.content||[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text||'').join('\n');
export const cleanDshLog=(text:string)=>redact(text).replace(/([?&]token=)[^\s&#]+/gi,'$1[REDACTED]');
export function launchUrl(line:string){
 const match=line.replace(/\x1b\[[0-9;]*m/g,'').match(/^dsh web:\s+(http:\/\/\S+)/);if(!match)return null;
 const url=new URL(match[1]);
 if(url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.username||url.password||url.hash||[...url.searchParams.keys()].some(k=>k!=='token')||url.searchParams.getAll('token').length!==1)throw Error('DSH Web 启动地址不受支持');
 return url.href;
}
export class DshRemote {
 private cookie='';private auth?:Promise<void>;private seq=0;
 constructor(readonly url:string,private fetcher:typeof fetch=fetch){}
 get origin(){return new URL(this.url).origin;}
 private async authenticate(){
  this.auth||=(async()=>{const r=await this.fetcher(this.url,{redirect:'manual',signal:AbortSignal.timeout(15000)});if(r.status!==303||r.headers.get('location')!=='./')throw Error('DSH Web 本机授权失败');
   this.cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).filter(c=>/^dsh[\w-]*=[A-Za-z0-9_.-]+$/.test(c)).join('; ');if(!this.cookie)throw Error('DSH Web 未返回会话凭证');})();return this.auth;
 }
 async rpc(method:string,request?:unknown){
  await this.authenticate();const rpcId=`arc-${++this.seq}-${randomUUID()}`;
  const r=await this.fetcher(`${this.origin}/api/${method}`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',Cookie:this.cookie},body:JSON.stringify({type:'client-request',rpcId,method,payload:{args:request===undefined?{}:{request}}})});
  if(!r.ok)throw Error(`DSH Web ${method} HTTP ${r.status}`);
  const v:any=await r.json();if(v.type!=='server-response'||v.rpcId!==rpcId||typeof v.result?.ok!=='boolean')throw Error('DSH Remote 返回不匹配');
  if(!v.result.ok)throw Error(`DSH Remote 拒绝 ${method}: ${String(v.result.error?.code||'unknown').replace(/[^\w/-]/g,'')} ${cleanDshLog(String(v.result.error?.message||'')).slice(0,1000)}`);
  return v.result.value;
 }
 async snapshot(sessionId:string,after=-1){
  const state=await this.rpc('session/projections',{sessionId});if(!state||!Number.isInteger(state.asOfSeq)||state.asOfSeq<after)throw Error('DSH 会话历史不可核验');
  const records=new Map<number,any>();let beforeSeq:number|undefined;
  while(state.asOfSeq>after){
   const page=await this.rpc('session/page',{address:{kind:'session',sessionId},throughSeq:state.asOfSeq,maxMessages:100,...(beforeSeq===undefined?{}:{beforeSeq})});
   if(!Array.isArray(page?.records)||typeof page.hasMore!=='boolean')throw Error('DSH 会话分页不合法');
   const events=page.records.map((r:any)=>r.type==='event'?r.event:null);
   if(events.some((e:any)=>!e||!Number.isInteger(e.seq)||e.seq<0||e.seq>state.asOfSeq))throw Error('DSH 事件范围不合法');
   for(const e of events)if(e.seq>after)records.set(e.seq,e);
   const min=events.length?Math.min(...events.map((e:any)=>e.seq)):null;
   if(!page.hasMore||(min!==null&&min<=after))break;
   if(min===null||(beforeSeq!==undefined&&min>=beforeSeq))throw Error('DSH 分页未前进');beforeSeq=min;
  }
  const events=[...records.values()].sort((a,b)=>a.seq-b.seq);if(state.asOfSeq>after&&events.at(-1)?.seq!==state.asOfSeq)throw Error('DSH 会话历史缺失');
  return {cursor:state.asOfSeq,events,values:state.values};
 }
}
type Host={child:ChildProcessWithoutNullStreams;client:DshRemote;sessionId?:string;opened?:boolean;closing?:Promise<void>};
const hosts=new Map<string,Host>(),pending=new Map<string,Promise<Host>>();
type Options={run:Run;snapshot:Snapshot;storage:string;resources:string;profile:ProviderProfile;prompt:string;event:(event:any)=>void;started:(active:ActiveProcess)=>void};
async function hostFor(options:Pick<Options,'run'|'storage'|'resources'|'profile'>):Promise<Host>{
 const {run,storage,resources,profile}=options,key=run.output_path;const existing=hosts.get(key);if(existing?.closing){await existing.closing;return hostFor(options);}if(existing&&existing.child.exitCode===null)return existing;if(pending.has(key))return pending.get(key)!;
 const creation=(async()=>{
  if(profile.version!=='0.2.1-rc.2')throw Error('DSH Web 版本不在已验证组合内');
  const dir=path.dirname(run.output_path),home=path.join(dir,'dsh-web-home');
  const r=await dshRuntime(storage,profile.path,home);if(!r.authenticated)throw Error('DSH 模型授权缺失');
  const patch=path.join(home,'arc-web.patch.yml');
  await fs.copyFile(path.join(resources,'dist','dsh-browser-bridge.mjs'),path.join(home,'dsh-browser-bridge.mjs'));
  // Web mounts tools inside a session preset. Keep host registries available;
  // mount only the frozen-source MCP in Arc's own preset, never standard tools.
  const entries=[...disabledDshTools.filter(id=>!['skill','plugin-manager'].includes(id)),'session-title-llm'].map(id=>({id,disabled:true}));
  const source={id:'arc-source',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'arc-frozen-source',transport:'stdio',command:await locate('node'),args:[path.join(dir,'context-server.cjs'),path.join(dir,'source-context.json')],failOnStartupError:true}};
  const additions=[{id:'preset-arc-read-only',name:'@deepseek-ai/dsh-agent-preset',config:{id:'arc-read-only',name:'Arc 只读工程分析',plugins:[{id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:'You analyze the bound source snapshot for Arc using only its read-only MCP tools.'}},source]}},{id:'arc-browser-bridge',name:'./dsh-browser-bridge.mjs'}];
  await fs.writeFile(patch,dump([...entries,{id:'agent-preset-registry',config:{default:'arc-read-only'}},{insert:additions}]));
  const child=spawn(r.dsh.command,[...r.dsh.prefix,'--profile','web','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'],{cwd:path.join(storage,'snapshots',run.binding.source_snapshot_id),env:{...r.env,NO_COLOR:'1'},windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>{stderr=cleanDshLog(stderr+b.toString()).slice(-6000);});
  try{
   const url=await new Promise<string>((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>reject(Error('DSH Web 启动超时')),45000);const finish=(error?:Error,url?:string)=>{clearTimeout(timer);error?reject(error):resolve(url!);};
    child.once('error',e=>finish(e));child.once('exit',code=>finish(Error(`DSH Web 退出 ${code}: ${stderr}`)));
    child.stdout.on('data',b=>{buffer+=b.toString();const lines=buffer.split(/\r?\n/);buffer=lines.pop()||'';for(const line of lines)try{const u=launchUrl(line);if(u)finish(undefined,u);}catch(e){finish(e as Error);}});
   });
   const host={child,client:new DshRemote(url),sessionId:run.external_id};hosts.set(key,host);return host;
  }catch(e){await stopTree(child).catch(()=>{});throw e;}
 })();pending.set(key,creation);try{return await creation;}finally{pending.delete(key);}
}
export async function dshWebSessionUrl(options:Pick<Options,'run'|'storage'|'resources'|'profile'>){
 const {run}=options;if(run.native_ui!=='dsh-web'||!run.external_id)throw Error('该运行没有可核验的 DSH 图形会话');
 const host=await hostFor(options);host.opened=true;const state=await host.client.snapshot(run.external_id);
 if(!state.events.some(e=>e.type==='user/message'))throw Error('DSH 对应会话没有任务消息，拒绝打开空白对话');
 const url=new URL(host.client.url);url.hash=`arc-session=${encodeURIComponent(run.external_id)}`;return url.href;
}
export async function closeDshWebHosts(){await Promise.allSettled([...hosts.values()].map(h=>stopTree(h.child)));hosts.clear();}
// Durable event identity, turn matching and transport state are never inferred
// from an open browser window or from an arbitrary last assistant response.
export async function runDshWeb(options:Options){
 const {run,snapshot,storage,resources,event}=options,dir=path.dirname(run.output_path);await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'source-context.json'),JSON.stringify({storage,snapshot}));await fs.copyFile(path.join(resources,'dist','context-server.cjs'),path.join(dir,'context-server.cjs'));
 const host=await hostFor(options);let sessionId='',submitted=false,cancelling=false,cancelAt=0,cursor=-1,ownTurn:any,seen=false,announced=false;const events:any[]=[];
 options.started({child:host.child,cancel:async()=>{cancelling=true;cancelAt=Date.now();if(sessionId)await host.client.rpc('session/cancel',{sessionId});}});
 try{
  const session=await host.client.rpc('session/create',{cwd:path.join(storage,'snapshots',snapshot.source_snapshot_id),agentPreset:'arc-read-only'});sessionId=session.sessionId;
  if(typeof sessionId!=='string'||!sessionId)throw Error('DSH 未返回会话 ID');host.sessionId=sessionId;
  await host.client.rpc('session/rename',{sessionId,title:`Arc · ${run.title}`});
  event({type:'session.started',thread_id:sessionId,native_ui:'dsh-web'});
  const prompt=options.prompt+'\n请先用一两句公开进度说明分析范围和下一步，再读取源码。最终回复仅为 JSON，遵循合同：'+JSON.stringify(schema);
  const requestId=randomUUID();await fs.writeFile(path.join(dir,'prompt.txt'),prompt);await fs.writeFile(path.join(dir,'request.json'),JSON.stringify({binding:run.binding,provider:'dsh',transport:'web-remote-v2',session_id:sessionId,request_id:requestId,source_fingerprint:snapshot.fingerprint},null,2));
  if(cancelling)return {code:0,raw:'',stderr:'',cancelled:true};
  submitted=true;const receipt=await host.client.rpc('session/prompt',{sessionId,requestId,mode:'queue',content:[{type:'text',text:prompt}],clientTimeZone:'Asia/Shanghai'});
  if(receipt?.accepted!==true)throw Error('DSH 未确认消息接收，禁止自动重发');
  const admitted=Date.now();
  while(true){
   if(host.child.exitCode!==null)throw Error('DSH Web 已退出，未获得本轮终态');
   const state=await host.client.snapshot(sessionId,cursor);cursor=state.cursor;
   for(const e of state.events){events.push(e);
    if(e.type==='user/message'&&e.data?.source?.rpcId===requestId){seen=true;ownTurn=events.slice().reverse().find(p=>p.seq<e.seq&&p.type==='turn/start')?.data?.turn;if(ownTurn===undefined)throw Error('DSH 消息无法绑定轮次');}
    event({type:'dsh.native_event',session_id:sessionId,native_sequence:e.seq,native_type:e.type,data:e.data});
    if(e.type==='tool/call')event({type:'session.update',update:{sessionUpdate:'tool_call',toolCallId:e.data.callId,title:e.data.name,status:'in_progress',rawInput:e.data.arguments}});
    if(e.type==='tool/result')event({type:'session.update',update:{sessionUpdate:'tool_call_update',toolCallId:e.data.message?.toolCallId,status:e.data.message?.isError?'failed':'completed'}});
    if(e.type==='assistant/message'&&e.data?.turn===ownTurn)event({type:'session.update',update:{sessionUpdate:'agent_message_chunk',messageId:String(e.seq),content:{type:'text',text:textOf(e.data.message)}}});
   }
   if(seen&&!announced){announced=true;event({type:'dsh.session_ready',session_id:sessionId,message:'真实 DSH 对话已接收任务，可查看同一会话'});}
   const terminal=events.find(e=>e.type==='turn/end'&&seen&&e.data?.turn===ownTurn);
   if(terminal){
    const cancelled=['aborted','interrupted'].includes(terminal.data?.reason?.kind);if(terminal.data?.reason?.kind!=='completed'&&!cancelled)throw Error(`DSH 本轮未成功：${terminal.data?.reason?.kind}`);
    const raw=events.filter(e=>e.type==='assistant/message'&&e.data?.turn===ownTurn).map(e=>textOf(e.data.message)).filter(Boolean).at(-1)||'';
    if(Buffer.byteLength(raw)>2*1024*1024)throw Error('DSH 输出超过 2 MiB');await fs.writeFile(run.output_path,raw);
    event({type:'provider.finished',session_id:sessionId,stop_reason:terminal.data.reason.kind});
    if(run.overview_parent_run_id&&!host.opened){
      host.closing=stopTree(host.child).then(()=>{hosts.delete(run.output_path);}).catch(error=>{
        host.closing=undefined;
        event({type:'local.stage',stage:'cleanup',message:'后台会话暂未关闭：'+cleanDshLog(String(error))});
      });
      await host.closing;
    }
    return {code:0,raw,stderr:'',cancelled};
   }
   if(!seen&&Date.now()-admitted>45000)throw Error('DSH 消息已提交，但未观察到对应轮次；禁止自动重发');
   if(cancelling&&Date.now()-cancelAt>30000)throw Error('DSH 停止未得到终态确认');
   await pause(1000);
  }
 }catch(e){await fs.writeFile(path.join(dir,'diagnostic.json'),JSON.stringify({error:cleanDshLog((e as Error).message),session_id:sessionId,remote_unknown:submitted},null,2));if(submitted)Object.assign(e as Error,{remoteUnknown:true});throw e;}
}
