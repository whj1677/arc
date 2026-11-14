import fs from 'node:fs/promises';
import path from 'node:path';
import type {Store} from './store';
import {id,now} from './store';
import {inside,relativePath,safeFile,sha} from './snapshot';
import type {Project,Snapshot} from '../shared';

interface Row {kind:string;id:string;value:any}
interface Bundle {format:'arc-engineering';version:1;exported_at:string;project_id:string;objects:Row[];versions:(Row&{version:number})[];events:{run_id:string;event_id:string;sequence:number;value:any}[];files:{path:string;sha256:string;data:string}[]}
const kinds=new Set(['project','feature','scenario','revision','annotation','snapshot','run','explanation','reading','reading_question','engineering_workspace','engineering_context','engineering_task','development_attempt','engineering_receipt','engineering_state','engineering_context_state','engineering_mcp_begin','development_submission']);
const validId=(value:unknown)=>{if(typeof value!=='string'||!value||value.length>300||/[\\/\0:]/.test(value))throw Error('导入对象标识无效');return value;};
function referencedFile(store:Store,value:string){const full=path.isAbsolute(value)?value:path.join(store.directory,value);if(!inside(store.directory,full))throw Error('证据路径位于 ARC 数据目录之外，无法完整导出');return relativePath(path.relative(store.directory,full).split(path.sep).join('/'));}
export async function exportEngineeringProject(store:Store,projectId:string,filePath:string) {
  store.get('project',projectId);
  const rows=(store.db.prepare('SELECT kind,id,json FROM objects').all() as any[]).map(r=>({kind:r.kind,id:r.id,value:JSON.parse(r.json)}));
  const owned=new Set<string>([projectId]);let objects:Row[]=[];
  const sceneIds=new Set(rows.filter(r=>r.kind==='scenario'&&r.value?.project_id===projectId).map(r=>r.id));
  const ownsReading=(row:Row)=>row.id.startsWith(`${projectId}/`)||['project-session','feature-expand-mode','analysis-provider','engineering-section-drafts','engineering-selection'].some(prefix=>row.id===`${prefix}/${projectId}`)||sceneIds.has(row.id);
  // Reading-state rows use scenario ids as their key. Other entities have an
  // explicit project/scenario/binding relationship; never export global settings.
  for(let pass=0;pass<4;pass++)for(const row of rows)if(kinds.has(row.kind)&&!objects.includes(row)) {
    const v=row.value;if(v&&typeof v==='object'&&(row.kind==='reading'?ownsReading(row):v.project_id===projectId||v.binding?.project_id===projectId||v.result?.binding?.project_id===projectId||owned.has(v.scenario_id)||owned.has(v.task_id)||owned.has(row.id))){objects.push(row);owned.add(row.id);}
  }
  const objectKeys=new Set(objects.map(r=>`${r.kind}\0${r.id}`));
  const versions=(store.db.prepare('SELECT kind,id,version,json FROM engineering_versions').all() as any[]).filter(r=>objectKeys.has(`${r.kind}\0${r.id}`)).map(r=>({kind:r.kind,id:r.id,version:r.version,value:JSON.parse(r.json)}));
  const events=(store.db.prepare('SELECT run_id,event_id,sequence,json FROM events').all() as any[]).filter(r=>owned.has(r.run_id)).map(r=>({run_id:r.run_id,event_id:r.event_id,sequence:r.sequence,value:JSON.parse(r.json)}));
  const paths=new Set<string>(),expectedHashes=new Map<string,string>();
  for(const row of objects) {
    const v=row.value;
    if(row.kind==='snapshot')for(const f of (v as Snapshot).files){const file=`snapshots/${validId(v.source_snapshot_id)}/${relativePath(f.path)}`;paths.add(file);expectedHashes.set(file,f.content_sha256);}
    if(row.kind==='run'&&v.output_path){const file=referencedFile(store,v.output_path);if(!file.startsWith(`runs/${row.id}/`))throw Error('分析结果文件不属于该次执行');try{await fs.access(path.join(store.directory,file));paths.add(file);}catch{/* Runs interrupted before output have no result file. */}}
    if(row.kind==='development_attempt'&&v.log_path)paths.add(referencedFile(store,v.log_path));
    if(row.kind==='engineering_task')for(const e of v.verification??[])if(e.log_path)paths.add(referencedFile(store,e.log_path));
  }
  for(const row of versions)if(row.kind==='engineering_task')for(const e of row.value.verification??[])if(e.log_path)paths.add(referencedFile(store,e.log_path));
  const files:Bundle['files']=[];let size=0;
  for(const file of paths){const bytes=await fs.readFile(await safeFile(store.directory,file));size+=bytes.length;if(size>256*1024*1024)throw Error('导出证据超过 256 MiB，请缩小工程范围');const hash=sha(bytes);if(expectedHashes.has(file)&&expectedHashes.get(file)!==hash)throw Error('冻结来源哈希不匹配，保留原导出文件');files.push({path:file,sha256:hash,data:bytes.toString('base64')});}
  // Rewrite only storage paths. Workspaces remain historical labels and are
  // explicitly unbound on restore, rather than inferred from an old machine.
  objects=structuredClone(objects);for(const row of objects)if(row.kind==='run'&&row.value.output_path)row.value.output_path=referencedFile(store,row.value.output_path);
  const bundle:Bundle={format:'arc-engineering',version:1,exported_at:now(),project_id:projectId,objects,versions,events,files};
  const target=path.resolve(filePath),temp=`${target}.${id('pending')}`;
  await fs.mkdir(path.dirname(target),{recursive:true});try{await fs.writeFile(temp,JSON.stringify(bundle));await fs.rename(temp,target);}catch(error){await fs.rm(temp,{force:true});throw error;}
  return {file_path:target,project_id:projectId,objects:objects.length,files:files.length,bytes:size};
}
export async function restoreEngineeringProject(store:Store,filePath:string) {
  const stat=await fs.stat(filePath);if(stat.size>400*1024*1024)throw Error('导入文件超过 400 MiB');
  const bundle=JSON.parse(await fs.readFile(filePath,'utf8')) as Bundle;
  if(bundle.format!=='arc-engineering'||bundle.version!==1||!Array.isArray(bundle.objects)||!Array.isArray(bundle.versions)||!Array.isArray(bundle.files)||!Array.isArray(bundle.events))throw Error('不支持的 ARC 工程导出格式');
  validId(bundle.project_id);if(bundle.objects.length>100000||bundle.files.length>100000||bundle.versions.length>100000)throw Error('导入对象数量超限');
  const objectKeys=new Set<string>();
  for(const row of bundle.objects){if(!kinds.has(row.kind)||!row.value||typeof row.value!=='object')throw Error('导入对象类型无效');if(!['reading','engineering_mcp_begin','development_submission'].includes(row.kind))validId(row.id);else if(typeof row.id!=='string'||!row.id||row.id.length>1000||row.id.includes('\0'))throw Error('记录键无效');const key=`${row.kind}\0${row.id}`;if(objectKeys.has(key))throw Error('导出中有重复对象');objectKeys.add(key);if(store.maybe(row.kind,row.id))throw Error(`ID_CONFLICT：${row.kind}/${row.id} 已存在；不会覆盖本地历史`);}
  const project=bundle.objects.find(r=>r.kind==='project'&&r.id===bundle.project_id)?.value as Project|undefined;if(!project)throw Error('导出缺少工程身份');
  const ownedIds=new Set(bundle.objects.map(r=>r.id));
  const owns=(kind:string,key:unknown)=>typeof key==='string'&&objectKeys.has(`${kind}\0${key}`);
  const workspaces=bundle.objects.filter(r=>r.kind==='engineering_workspace');if(workspaces.length!==1||workspaces[0].value.project_id!==bundle.project_id||!owns('engineering_state',workspaces[0].id)||!owns('engineering_context_state',bundle.project_id))throw Error('恢复包缺少可显式重绑定的工程状态');
  const identityFields:Record<string,string>={project:'project_id',feature:'feature_id',scenario:'scenario_id',revision:'question_revision_id',annotation:'annotation_id',snapshot:'source_snapshot_id',explanation:'result_id',reading_question:'question_id',engineering_workspace:'workspace_id',engineering_task:'task_id',engineering_context:'entry_id',development_attempt:'attempt_id'};
  for(const row of [...bundle.objects,...bundle.versions]){
    const v=row.value;if(!v||typeof v!=='object')throw Error('记录内容无效');
    if(v.project_id&&v.project_id!==bundle.project_id||v.binding?.project_id&&v.binding.project_id!==bundle.project_id||v.result?.binding?.project_id&&v.result.binding.project_id!==bundle.project_id)throw Error('记录包含其他工程的数据');
    if(row.kind==='project'&&row.id!==bundle.project_id)throw Error('导出包含多个工程身份');
    if(identityFields[row.kind]&&v[identityFields[row.kind]]!==row.id)throw Error('记录标识与内容不一致');
    if(v.scenario_id&&!owns('scenario',v.scenario_id)||v.feature_id&&!owns('feature',v.feature_id)||v.task_id&&row.kind==='development_attempt'&&!owns('engineering_task',v.task_id))throw Error('记录关联对象缺失');
    if(row.kind==='run'&&(!v.binding||v.binding.run_id!==row.id||!owns('snapshot',v.binding.source_snapshot_id)||!owns('scenario',v.binding.scenario_id)||v.development_task_id&&!owns('engineering_task',v.development_task_id)))throw Error('分析执行归属或快照缺失');
    if(row.kind==='reading_question'&&(!owns('snapshot',v.source_snapshot_id)||v.run_id&&!owns('run',v.run_id)||!Array.isArray(v.run_ids)||v.run_ids.some((key:string)=>!owns('run',key))))throw Error('阅读问答执行或快照缺失');
    if(row.kind==='engineering_task'&&(v.task_id!==row.id||!Array.isArray(v.verification)||!Array.isArray(v.attempt_ids)||!ownedIds.has(v.workspace_id)||v.reading&&(!owns('feature',v.reading.feature_id)||!owns('scenario',v.reading.scenario_id)||!owns('explanation',v.reading.result_id)||!owns('snapshot',v.reading.source_snapshot_id))||v.walkthrough?.run_id&&!owns('run',v.walkthrough.run_id)||v.walkthrough?.result_id&&!owns('explanation',v.walkthrough.result_id)))throw Error('任务归属、功能关联或数据格式无效');
    if(row.kind==='engineering_context'&&(v.entry_id!==row.id||!Array.isArray(v.sources)))throw Error('上下文格式无效');
  }
  const snapshotRows=bundle.objects.filter(r=>r.kind==='snapshot');
  if(!owns('snapshot',project.snapshot_id))throw Error('工程当前快照缺失');
  const allowedFiles=new Map<string,string|undefined>();
  for(const row of snapshotRows){const snapshot=row.value as Snapshot;if(snapshot.project_id!==bundle.project_id||snapshot.source_snapshot_id!==row.id||!Array.isArray(snapshot.files))throw Error('快照归属无效');for(const f of snapshot.files){const file=`snapshots/${row.id}/${relativePath(f.path)}`;if(allowedFiles.has(file))throw Error('快照包含重复文件');allowedFiles.set(file,f.content_sha256);}}
  for(const row of [...bundle.objects,...bundle.versions]) {
    const v=row.value;
    if(row.kind==='run'&&v.output_path){relativePath(v.output_path);if(!v.output_path.startsWith(`runs/${row.id}/`))throw Error('分析结果文件不属于该次执行');allowedFiles.set(v.output_path,undefined);}
    const log=(value:string,taskId:string)=>{relativePath(value);if(!value.startsWith(`development/${taskId}/`)&&!value.startsWith(`logs/${taskId}/`))throw Error('日志不属于任务证据目录');allowedFiles.set(value,undefined);};
    if(row.kind==='development_attempt'&&v.log_path)log(v.log_path,v.task_id);
    if(row.kind==='engineering_task')for(const e of v.verification??[])if(e.log_path)log(e.log_path,v.task_id);
  }
  const fileNames=new Set<string>(),decoded:{path:string;bytes:Buffer}[]=[];let total=0;
  for(const file of bundle.files){relativePath(file.path);if(fileNames.has(file.path)||!allowedFiles.has(file.path))throw Error('导入包含重复或未引用文件');fileNames.add(file.path);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))throw Error('证据编码无效');const bytes=Buffer.from(file.data,'base64');total+=bytes.length;if(total>256*1024*1024)throw Error('导入证据超过 256 MiB');if(sha(bytes)!==file.sha256||(allowedFiles.get(file.path)&&allowedFiles.get(file.path)!==file.sha256))throw Error('导入证据哈希不匹配');if(!/^(?:snapshots|runs|development|engineering|logs)\//.test(file.path))throw Error('证据路径不在允许目录');decoded.push({path:file.path,bytes});}
  for(const row of snapshotRows)for(const f of row.value.files)if(!fileNames.has(`snapshots/${row.id}/${f.path}`))throw Error('导出缺少快照原文');
  const snapshotIds=new Set(snapshotRows.map(r=>r.id));
  for(const row of [...bundle.objects,...bundle.versions]){
    const v=row.value;if(row.kind==='engineering_context')for(const source of v.sources)if(!snapshotIds.has(source.snapshot_id))throw Error('上下文来源快照缺失');
    if(row.kind==='engineering_task')for(const state of [v.baseline,v.end_state,v.diff_baseline,v.reading?{snapshot_id:v.reading.source_snapshot_id}:null,v.walkthrough?.source_snapshot_id?{snapshot_id:v.walkthrough.source_snapshot_id}:null,v.rebind_source_snapshot_id?{snapshot_id:v.rebind_source_snapshot_id}:null,...v.verification.map((e:any)=>e.code_state)].filter(Boolean))if(!snapshotIds.has(state.snapshot_id))throw Error('任务代码状态或走读来源快照缺失');
    if(row.kind==='development_attempt'&&v.log_path&&!fileNames.has(v.log_path)||row.kind==='engineering_task'&&v.verification.some((e:any)=>e.log_path&&!fileNames.has(e.log_path)))throw Error('导出缺少被引用日志');
  }
  for(const row of bundle.versions)if(!objectKeys.has(`${row.kind}\0${row.id}`)||!Number.isSafeInteger(row.version)||row.version<1||row.value.version!==row.version)throw Error('历史版本关联无效');
  const eventOwners=new Set(bundle.objects.filter(r=>['run','development_attempt'].includes(r.kind)).map(r=>r.id));
  const eventIds=new Set<string>();for(const event of bundle.events){const key=`${event.run_id}\0${event.event_id}`;if(!eventOwners.has(event.run_id)||!Number.isSafeInteger(event.sequence)||event.sequence<1||typeof event.event_id!=='string'||!event.event_id||eventIds.has(key))throw Error('事件归属无效或事件重复');eventIds.add(key);}
  const created:string[]=[];
  try {
    for(const file of decoded){const output=path.join(store.directory,file.path);let cursor=store.directory;for(const segment of path.dirname(file.path).split('/')){cursor=path.join(cursor,segment);await fs.mkdir(cursor,{recursive:true});if((await fs.lstat(cursor)).isSymbolicLink())throw Error('恢复路径包含符号链接');}await fs.writeFile(output,file.bytes,{flag:'wx'});created.push(output);}
    store.transaction(()=>{
      const interrupted:Row[]=[];
      for(const row of bundle.objects){const v=row.value;if(row.kind==='engineering_workspace')v.status='unbound';if(row.kind==='development_attempt'&&['starting','running'].includes(v.status)){v.status='interrupted';v.ended_at=now();v.error='从导出恢复的执行不会自动重启。';}if(row.kind==='engineering_task'&&v.status==='running'){v.status='interrupted';v.version++;v.updated_at=now();interrupted.push(row);}if(row.kind==='run'){if(v.output_path)v.output_path=path.join(store.directory,v.output_path);if(!['completed','failed','cancelled','blocked_external'].includes(v.status)){v.status='unknown';v.error='恢复后尚未核查原执行，不会自动重发。';}}store.put(row.kind,row.id,v);}
      for(const row of bundle.versions)store.db.prepare('INSERT INTO engineering_versions VALUES(?,?,?,?)').run(row.kind,row.id,row.version,JSON.stringify(row.value));
      for(const row of interrupted)store.putVersion(row.kind,row.id,row.value.version,row.value);
      for(const event of bundle.events)store.event(event.run_id,event.event_id,event.sequence,event.value);
    });
  }catch(error){for(const file of created)if(inside(store.directory,file))await fs.rm(file,{force:true});throw error;}
  return {project_id:bundle.project_id,status:'unbound' as const,objects:bundle.objects.length,files:decoded.length};
}
