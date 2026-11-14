import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {redact} from './providers';

export const deferredDevelopmentTools=['arc_update_development','arc_finish_development'];
export interface PendingDevelopmentWrite {name:string;args:any;client:any;created_at:string;error?:string}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function outboxDirectory(connectionFile:string){return path.join(path.dirname(connectionFile),'development-outbox');}
export async function queueDevelopmentWrite(connectionFile:string,request:Omit<PendingDevelopmentWrite,'created_at'>){
  if(!deferredDevelopmentTools.includes(request.name)||typeof request.args?.task_id!=='string'||typeof request.args?.submission_key!=='string'||!Number.isInteger(request.args.expected_version))throw Error('开发回填缺少任务、版本或幂等提交标识，无法保存待同步记录');
  const directory=outboxDirectory(connectionFile);await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,digest(request.args.task_id+'\n'+request.args.submission_key)+'.json');
  const clean=JSON.parse(redact(JSON.stringify(request)));
  try{const previous=JSON.parse(await fs.readFile(file,'utf8'));if(JSON.stringify({name:previous.name,args:previous.args})!==JSON.stringify({name:clean.name,args:clean.args}))throw Error('相同提交标识对应不同待同步内容');return file;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify({...clean,created_at:new Date().toISOString()}),{flag:'wx'});
  try{await fs.link(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const previous=JSON.parse(await fs.readFile(file,'utf8'));if(JSON.stringify({name:previous.name,args:previous.args})!==JSON.stringify({name:clean.name,args:clean.args}))throw Error('相同提交标识对应不同待同步内容');}
  finally{await fs.rm(temporary,{force:true});}return file;
}
export async function pendingDevelopmentWrites(connectionFile:string){
  const directory=outboxDirectory(connectionFile);let names:string[];
  try{names=await fs.readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const records=[];
  for(const name of names.filter(name=>/^[a-f0-9]{64}\.json$/.test(name))){const file=path.join(directory,name);try{const value=JSON.parse(await fs.readFile(file,'utf8')) as PendingDevelopmentWrite;records.push({file,value});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  return records.sort((a,b)=>a.value.created_at.localeCompare(b.value.created_at));
}
export async function flushDevelopmentWrites(connectionFile:string,send:(request:PendingDevelopmentWrite)=>Promise<unknown>){
  const result:{task_id:string;submission_key:string;saved:'saved'|'pending_sync';error?:string}[]=[];
  for(const {file,value}of await pendingDevelopmentWrites(connectionFile)){
    try{if(!deferredDevelopmentTools.includes(value.name))throw Error('待同步工具类型无效');await send(value);await fs.rm(file,{force:true});result.push({task_id:value.args.task_id,submission_key:value.args.submission_key,saved:'saved'});}
    catch(error){const message=redact((error as Error).message),temporary=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify({...value,error:message}),{flag:'wx'});await fs.rename(temporary,file);}catch(saveError){throw Error('待同步记录错误状态保存失败：'+redact(String(saveError)));}finally{await fs.rm(temporary,{force:true});}result.push({task_id:value.args?.task_id,submission_key:value.args?.submission_key,saved:'pending_sync',error:message});}
  }
  return result;
}

export class ArcConnectionUnavailable extends Error {}
export async function sendArcTool(connectionFile:string,request:{name:string;args:any;client:any}){
  let connection:any;
  try{connection=JSON.parse(await fs.readFile(connectionFile,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ArcConnectionUnavailable('ARC 未运行；连接文件暂不可用');throw error;}
  const url=new URL(connection.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/tool'||url.username||url.password||typeof connection.token!=='string')throw Error('Arc 连接地址无效');
  let response:Response;
  try{response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`},body:JSON.stringify(request),signal:AbortSignal.timeout(60000),redirect:'error'});}catch(error){throw new ArcConnectionUnavailable('ARC 暂不可连接：'+redact((error as Error).message));}
  const result=await response.json() as any;
  if(!response.ok||result.error)throw Error(result.error||'Arc 请求失败');
  return result.value;
}
export async function callArcWithOutbox(connectionFile:string,request:{name:string;args:any;client:any}){
  if(!deferredDevelopmentTools.includes(request.name))return sendArcTool(connectionFile,request);
  // Persist before sending: a lost response can be replayed with exactly the
  // same submission key after process or app restart.
  const file=await queueDevelopmentWrite(connectionFile,request);
  try{const value=await sendArcTool(connectionFile,request);await fs.rm(file,{force:true});return value;}
  catch(error){if(error instanceof ArcConnectionUnavailable)return {task_id:request.args.task_id,submission_key:request.args.submission_key,saved:'pending_sync',message:'开发记录已保存在本机待同步队列，尚未写入 ARC；重新打开 ARC 后会重试。'};throw error;}
}
