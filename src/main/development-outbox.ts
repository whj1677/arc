import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {redact} from './providers';
import type {CompletionBinding} from '../engineering';
import {bindWorkspaceCompletion,safeFile} from './snapshot';

export const deferredDevelopmentTools=['arc_update_development','arc_finish_development'];
type DevelopmentWrite={name:string;args:any;client:any;completion_binding?:CompletionBinding|null};
export interface PendingDevelopmentWrite extends DevelopmentWrite {created_at:string;error?:string}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function outboxDirectory(connectionFile:string){return path.join(path.dirname(connectionFile),'development-outbox');}
function completionFile(connectionFile:string,taskId:string){
  return path.join(path.dirname(connectionFile),'development-workspaces',digest(taskId)+'.json');
}
export async function rememberDevelopmentWorkspace(connectionFile:string,taskId:string,root:string){
  const file=completionFile(connectionFile,taskId);
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(root),{flag:'wx'});await fs.rename(temporary,file);}
  finally{await fs.rm(temporary,{force:true});}
}
async function completionBinding(connectionFile:string,taskId:string){
  const file=completionFile(connectionFile,taskId),directory=path.dirname(connectionFile);
  try{
    const workspace=JSON.parse(await fs.readFile(await safeFile(directory,path.relative(directory,file).split(path.sep).join('/')),'utf8'));
    return typeof workspace==='string'&&path.isAbsolute(workspace)?await bindWorkspaceCompletion(workspace):null;
  }catch{return null;}
}
export async function queueDevelopmentWrite(connectionFile:string,request:DevelopmentWrite){
  if(!deferredDevelopmentTools.includes(request.name)||typeof request.args?.task_id!=='string'||typeof request.args?.submission_key!=='string'||!Number.isInteger(request.args.expected_version))throw Error('开发回填缺少任务、版本或幂等提交标识，无法保存待同步记录');
  const directory=outboxDirectory(connectionFile);await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,digest(request.args.task_id+'\n'+request.args.submission_key)+'.json');
  const clean=JSON.parse(redact(JSON.stringify(request))) as DevelopmentWrite;
  const readExisting=async()=>{
    const previous=JSON.parse(await fs.readFile(file,'utf8')) as PendingDevelopmentWrite;
    if(previous.name!==clean.name||JSON.stringify(previous.args)!==JSON.stringify(clean.args))throw Error('相同提交标识对应不同待同步内容');
    return previous;
  };
  try{return {file,value:await readExisting()};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(request.name==='arc_finish_development')clean.completion_binding=await completionBinding(connectionFile,request.args.task_id);
  const value:PendingDevelopmentWrite={...clean,created_at:new Date().toISOString()},temporary=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(value),{flag:'wx'});
  try{await fs.link(temporary,file);return {file,value};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;return {file,value:await readExisting()};}
  finally{await fs.rm(temporary,{force:true});}
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
export async function sendArcTool(connectionFile:string,request:DevelopmentWrite){
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
export async function callArcWithOutbox(connectionFile:string,request:DevelopmentWrite){
  if(!deferredDevelopmentTools.includes(request.name))return sendArcTool(connectionFile,request);
  // Persist before sending: a lost response can be replayed with exactly the
  // same submission key after process or app restart.
  const {file,value:queued}=await queueDevelopmentWrite(connectionFile,request);
  try{const value=await sendArcTool(connectionFile,queued);await fs.rm(file,{force:true});return value;}
  catch(error){if(error instanceof ArcConnectionUnavailable)return {task_id:request.args.task_id,submission_key:request.args.submission_key,saved:'pending_sync',message:'开发记录已保存在本机待同步队列，尚未写入 ARC；重新打开 ARC 后会重试。'};throw error;}
}
