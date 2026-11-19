import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {inside,safeFile} from './snapshot';
import {now,type Store} from './store';

export type ToolProbeStatus='available'|'missing'|'unverifiable'|'declared';
export interface ToolProbe {id:string; label:string; status:ToolProbeStatus; version?:string; detail?:string; required_by?:string}
export interface EffectiveCommands {build?:string; test?:string; typecheck?:string; note?:string}
export interface ProjectEnvironment {
  project_id:string; probed_at:string; tools:ToolProbe[]; candidate_commands:EffectiveCommands; effective_commands:EffectiveCommands;
}
interface ToolSpec {id:string; label:string; required_by?:string; wrapper?:boolean}
const exec=promisify(execFile);
const windows=process.platform==='win32';

async function detectProject(root:string) {
  const files=new Set((await fs.readdir(root,{withFileTypes:true})).filter(item=>item.isFile()).map(item=>item.name));
  const tools:ToolSpec[]=[{id:'git',label:'Git'}], commands:EffectiveCommands={};
  function add(id:string,label:string,required_by:string) {
    if(!tools.some(tool=>tool.id===id))tools.push({id,label,required_by});
  }
  async function manifest(name:string) {
    const file=await safeFile(root,name);
    if((await fs.stat(file)).size>2*1024*1024)throw Error(`${name} 超过 2 MiB，无法读取环境配置`);
    return (await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'');
  }
  if(files.has('package.json')){
    add('node','Node.js','package.json');
    const source=await manifest('package.json');
    let pkg;
    try {pkg=JSON.parse(source);}
    catch(error){if(!(error instanceof SyntaxError))throw error;commands.note='package.json 格式无效，未能提取脚本命令。';}
    const manager=/^(npm|pnpm|yarn|bun)@/.exec(pkg?.packageManager)?.[1]??
      (files.has('pnpm-lock.yaml')?'pnpm':files.has('yarn.lock')?'yarn':files.has('bun.lock')||files.has('bun.lockb')?'bun':'npm');
    add(manager,manager,'package.json');
    for(const field of ['build','test','typecheck'] as const){
      if(typeof pkg?.scripts?.[field]==='string'&&pkg.scripts[field].trim())commands[field]=`${manager} run ${field}`;
    }
  }
  const pythonFiles=['pyproject.toml','requirements.txt'].filter(file=>files.has(file));
  if(pythonFiles.length){
    const python=windows?'python':'python3';
    add(python,'Python',pythonFiles.join('、'));
    const config=(await Promise.all(pythonFiles.map(manifest))).join('\n');
    if(/\bpytest\b/i.test(config))commands.test??=`${python} -m pytest`;
  }
  for(const [file,id,label,wrapper] of [
    ['pom.xml','mvn','Maven','mvnw'],['build.gradle','gradle','Gradle','gradlew'],['build.gradle.kts','gradle','Gradle','gradlew'],
  ] as const){
    if(!files.has(file))continue;
    add('java','Java',file);
    const script=windows&&files.has(wrapper+(id==='mvn'?'.cmd':'.bat'))?wrapper+(id==='mvn'?'.cmd':'.bat'):wrapper;
    let command:string=id;
    if(files.has(script)){
      if(!tools.some(tool=>tool.id===wrapper))tools.push({id:wrapper,label:`${label} Wrapper`,required_by:script,wrapper:true});
      command=windows&&script!==wrapper?`.\\${script}`:`./${script}`;
    }else add(id,label,file);
    commands.build??=`${command} ${id==='mvn'?'package':'build'}`;
    commands.test??=`${command} test`;
  }
  if(files.has('CMakeLists.txt')){
    add('cmake','CMake','CMakeLists.txt');
    commands.build??='cmake -S . -B build && cmake --build build';
  }
  if(files.has('Cargo.toml')){
    add('cargo','Cargo','Cargo.toml');
    commands.build??='cargo build';commands.test??='cargo test';commands.typecheck??='cargo check';
  }
  if(files.has('go.mod')){
    add('go','Go','go.mod');
    commands.build??='go build ./...';commands.test??='go test ./...';
  }
  return {tools,commands};
}

async function hostDirectories(root:string){
  const paths=(process.env.PATH??'').split(path.delimiter).map(dir=>dir.replace(/^"|"$/g,'')).filter(dir=>path.isAbsolute(dir)&&!inside(root,dir));
  const resolved=await Promise.all([...new Set(paths)].map(async dir=>{
    try{return await fs.realpath(dir);}
    catch(error){if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))return '';throw error;}
  }));
  return [...new Set(resolved.filter(dir=>!!dir&&!inside(root,dir)))];
}

async function probeTool(tool:ToolSpec,root:string,hostDirs:string[]):Promise<Pick<ToolProbe,'status'|'version'|'detail'>>{
  if(tool.wrapper)return {status:'declared',detail:'工程提供包装脚本，探测时未运行'};
  const dirs=[...hostDirs];
  if(windows&&tool.id==='git'){
    for(const dir of [process.env.ProgramFiles,process.env['ProgramFiles(x86)']])if(dir)dirs.push(path.join(dir,'Git','cmd'));
    if(process.env.LOCALAPPDATA)dirs.push(path.join(process.env.LOCALAPPDATA,'Programs','Git','cmd'));
  }
  const extensions=windows?['.exe','.cmd','.bat']:[''];
  for(const dir of new Set(dirs))for(const ext of extensions){
    const candidate=path.join(dir,tool.id+ext);
    let file:string;
    try {file=await fs.realpath(candidate);}
    catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))continue;return {status:'unverifiable',detail:'无法读取工具路径'};}
    // Executable lookup uses host paths only. Never execute a workspace binary or wrapper to discover its version.
    if(inside(root,file)||inside(root,candidate))continue;
    const versionArg=tool.id==='go'?'version':tool.id==='java'?'-version':'--version';
    try {
      let executable=file,args=[versionArg];
      if(ext==='.cmd'||ext==='.bat'){
        if(/[%!^&|<>"\r\n]/.test(file))return {status:'unverifiable',detail:'无法直接调用此命令包装器'};
        executable=path.join(process.env.SystemRoot!,'System32','cmd.exe');
        args=['/d','/v:off','/s','/c',`""${file}" ${versionArg}"`];
      }
      const {stdout,stderr}=await exec(executable,args,{cwd:os.tmpdir(),env:{...process.env,PATH:hostDirs.join(path.delimiter)},windowsHide:true,windowsVerbatimArguments:executable!==file,timeout:3000,maxBuffer:64*1024});
      const version=(stdout+'\n'+stderr).match(/\d+(?:\.\d+)+(?:[\w.-]*)/);
      if(version)return {status:'available',version:version[0].slice(0,64)};
      return {status:'unverifiable',detail:'版本命令未返回可识别的版本'};
    }catch {return {status:'unverifiable',detail:'版本命令失败或超过 3 秒'};}
  }
  return {status:'missing',detail:'本机未发现'};
}

function validateCommands(value:unknown):EffectiveCommands {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('有效命令必须为对象');
  const commands:EffectiveCommands={};
  for(const [key,text] of Object.entries(value)){
    if(!['build','test','typecheck','note'].includes(key)||typeof text!=='string'||text.length>2048||/[\x00-\x1f\x7f]/.test(text))throw Error('有效命令仅接受单行文本，每项最多 2048 字符');
    commands[key as keyof EffectiveCommands]=text.trim();
  }
  return commands;
}

type ProbeResult=Omit<ProjectEnvironment,'effective_commands'>;
export class ProjectEnvironmentService {
  private pending=new Map<string,Promise<ProbeResult>>();
  constructor(private store:Store){}
  private async probe(projectId:string,root:string):Promise<ProbeResult>{
    const [{tools,commands},dirs]=await Promise.all([detectProject(root),hostDirectories(root)]);
    const results=await Promise.all(tools.map(async(tool)=>({
      id:tool.id,label:tool.label,required_by:tool.required_by,...await probeTool(tool,root,dirs),
    })));
    const result={project_id:projectId,probed_at:now(),tools:results,candidate_commands:commands};
    this.store.put('project_env_probe',projectId,{root,result});
    return result;
  }
  async get(projectId:string,root:string,refresh=false):Promise<ProjectEnvironment>{
    const cached=this.store.maybe<{root:string;result:ProbeResult}>('project_env_probe',projectId);
    let result:ProbeResult;
    if(!refresh&&cached?.root===root)result=cached.result;
    else {
      const key=JSON.stringify([projectId,root]);
      let pending=this.pending.get(key);
      if(!pending){pending=this.probe(projectId,root).finally(()=>this.pending.delete(key));this.pending.set(key,pending);}
      result=await pending;
    }
    const overrides=this.store.maybe<EffectiveCommands>('project_env_commands',projectId);
    return {...result,effective_commands:{...result.candidate_commands,...overrides}};
  }
  async save(projectId:string,root:string,value:unknown):Promise<ProjectEnvironment>{
    const commands=validateCommands(value),env=await this.get(projectId,root);
    this.store.put('project_env_commands',projectId,commands);
    return {...env,effective_commands:{...env.candidate_commands,...commands}};
  }
}

export function formatEnvironmentBrief(env:ProjectEnvironment):string{
  const available=env.tools.filter(tool=>tool.status==='available').map(tool=>[tool.label,tool.version].filter(Boolean).join(' '));
  const labels:Record<ToolProbeStatus,string>={available:'可用',missing:'本机未发现',declared:'项目声明',unverifiable:'未核实'};
  const other=env.tools.filter(tool=>tool.status!=='available').map(tool=>`${tool.label}（${labels[tool.status]}）`);
  const commands=env.effective_commands;
  return [`可用工具：${available.join('、')||'无'}`,`缺失或未实测：${other.join('、')||'无'}`,
    `构建：${commands.build||'未配置'}`,`测试：${commands.test||'未配置'}`,`类型检查：${commands.typecheck||'未配置'}`,...(commands.note?[`备注：${commands.note}`]:[])].join('\n');
}
