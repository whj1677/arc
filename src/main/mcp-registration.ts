import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const samePath=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export function ownedArcRegistration(existing:any,resources:string){
  const transport=existing?.transport,args=transport?.args;
  if(transport?.type!=='stdio'||!/^node(?:\.exe)?$/i.test(path.basename(transport.command||''))||!Array.isArray(args)||args.length!==2||args.some(x=>typeof x!=='string'||!path.isAbsolute(x))||Object.keys(transport.env||{}).length||transport.env_vars?.length)return false;
  const packaged=path.basename(resources)==='app'&&path.basename(path.dirname(resources))==='resources';
  const root=packaged?path.resolve(resources,'../../../..'):path.resolve(resources);
  const relative=path.relative(root,args[0]).split(path.sep);
  const script=samePath(args[0],path.join(root,'dist/arc-mcp.cjs'))||(relative.length===6&&relative[0]==='release'&&relative[2]==='resources'&&relative[3]==='app'&&relative[4]==='dist'&&relative[5]==='arc-mcp.cjs');
  return script&&path.basename(args[1])==='connection.json'&&path.basename(path.dirname(args[1]))==='mcp';
}

export async function writeConnection(file:string,connection:unknown){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(connection),{mode:0o600,flag:'wx'});await fs.rename(temporary,file);}
  finally{await fs.rm(temporary,{force:true});}
}

// Only an explicit registration may adopt a retired connection file. Existing
// stdio clients read it again for every call, so they can survive that repair.
export async function adoptConnection(file:string,owner:string,connection:any,restore=false){
  if(samePath(file,owner))return false;
  let previous:any;
  try{if(!(await fs.lstat(file)).isFile())throw Error('Arc 旧连接文件类型无效');previous=JSON.parse(await fs.readFile(file,'utf8'));}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'&&!restore)previous=null;else if(restore)return false;else throw e;}
  if(restore&&(!previous?.arc_connection_file||!samePath(previous.arc_connection_file,owner)))return false;
  if(previous?.url!==connection.url||previous?.token!==connection.token){
    let url:URL|undefined;
    try{url=new URL(previous?.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/tool'||url.username||url.password)url=undefined;}catch{}
    if(previous&&!url){if(restore)return false;throw Error('Arc 旧连接地址无效，未覆盖');}
    if(url){
      let alive=false;
      try{await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${previous.token}`},body:JSON.stringify({name:'arc_current_project',args:{}}),signal:AbortSignal.timeout(1500),redirect:'error'});alive=true;}
      catch(e){if((e as any).cause?.code!=='ECONNREFUSED'){if(restore)return false;throw Error('无法确认旧 Arc 连接已关闭，未覆盖；请稍后重试');}}
      if(alive){if(restore)return false;throw Error('另一 Arc 实例仍在使用现有 MCP 连接；请先关闭该实例再连接当前工程');}
    }
  }
  await fs.mkdir(path.dirname(file),{recursive:true});
  await writeConnection(file,{...connection,arc_connection_file:owner});
  return true;
}
