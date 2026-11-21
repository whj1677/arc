import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const resolved = new Map<string,string>();
const defaultOverrides = new Map<'node'|'git',string>();
const editorExecutables = {code:[['code','Code']],trae:[['trae-cn','Trae CN'],['trae','Trae']]} as const;

export function setDefaultExecutableOverrides(overrides:Partial<Record<'node'|'git',string>>) {
  for(const name of ['node','git'] as const) {
    const file=overrides[name]||undefined;
    if(file===defaultOverrides.get(name))continue;
    if(file)defaultOverrides.set(name,file);
    else defaultOverrides.delete(name);
    resolved.delete(name);
  }
}

export function getDefaultExecutableOverride(name:'node'|'git') {
  return defaultOverrides.get(name);
}

function under(base:string|undefined,...parts:string[]) {
  return base && path.join(base,...parts);
}

function uniquePaths(paths:(string|undefined)[]) {
  const unique=new Map<string,string>();
  for(const file of paths)if(file)unique.set(path.normalize(file).toLowerCase(),file);
  return [...unique.values()];
}

export function windowsPackageDirs() {
  const env=process.env;
  return uniquePaths([under(env.APPDATA,'npm'),env.PNPM_HOME,under(env.LOCALAPPDATA,'pnpm'),under(env.VOLTA_HOME,'bin'),env.npm_config_prefix]);
}

export function windowsGitDirs() {
  const env=process.env;
  return uniquePaths([under(env.ProgramFiles,'Git','cmd'),under(env['ProgramFiles(x86)'],'Git','cmd'),
    under(env.LOCALAPPDATA,'Programs','Git','cmd'),path.join(env.USERPROFILE||os.homedir(),'scoop','shims')]);
}

export function windowsNodeDirs() {
  const env=process.env;
  return uniquePaths([under(env.ProgramFiles,'nodejs'),under(env['ProgramFiles(x86)'],'nodejs'),
    under(env.LOCALAPPDATA,'Programs','nodejs'),env.NVM_SYMLINK]);
}

function windowsPowerShell() {
  return path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
}

const associationLookup = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type @'
using System.Runtime.InteropServices;
using System.Text;
public static class ArcFileAssociation {
  [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)]
  public static extern int AssocQueryString(uint flags, uint kind, string extension,
    string verb, StringBuilder result, ref uint length);
}
'@
$length = [uint32]32768
$result = [Text.StringBuilder]::new([int]$length)
$executable = 2 # ASSOCSTR_EXECUTABLE
$status = [ArcFileAssociation]::AssocQueryString(0, $executable, $env:ARC_SOURCE_EXTENSION, 'open', $result, [ref]$length)
if ($status -eq 0) { $result.ToString() }
elseif ($status -ne 0x80070483 -and $status -ne 0x80070002) { throw "AssocQueryString failed: $status" }
`;

export async function windowsDefaultExecutable(extension:string) {
  if(!extension)return;
  const command=Buffer.from(associationLookup,'utf16le').toString('base64');
  const {stdout}=await exec(windowsPowerShell(),['-NoProfile','-NonInteractive','-EncodedCommand',command],{
    env:{...process.env,ARC_SOURCE_EXTENSION:extension},windowsHide:true,timeout:5000,
  });
  const file=stdout.trim();
  if(path.isAbsolute(file)&&/\.exe$/i.test(file)&&path.basename(file).toLowerCase()!=='openwith.exe')return file;
}

export async function windowsEditorCli(program:string) {
  if(!path.isAbsolute(program)||!/\.exe$/i.test(program))return;
  const cli=path.join(path.dirname(program),'resources','app','out','cli.js');
  if(await isFile(cli))return cli;
}

function windowsFallbacks(name:string) {
  const env=process.env, home=env.USERPROFILE||os.homedir();
  const binary=name.endsWith('.exe')?name:name+'.exe';
  const scoop=path.join(home,'scoop','shims',binary);
  const candidates:(string|undefined)[]=[];
  if(name==='node') {
    candidates.push(...windowsNodeDirs().map(dir=>path.join(dir,binary)),under(env.VOLTA_HOME,'bin',binary),scoop);
  } else if(name==='git') {
    candidates.push(...windowsGitDirs().map(dir=>path.join(dir,binary)));
  } else if(name==='codex') {
    const dirs=windowsPackageDirs();
    candidates.push(...dirs.flatMap(npmNativeCodexCandidates),...dirs.map(dir=>path.join(dir,binary)),scoop);
  } else if(name==='code'||name==='trae') {
    return uniquePaths([under(env.LOCALAPPDATA,'Programs'),env.ProgramFiles,env['ProgramFiles(x86)']].flatMap(base=>
      editorExecutables[name].map(([,editor])=>under(base,name==='code'?'Microsoft VS Code':editor,`${editor}.exe`))));
  } else if(name==='powershell.exe') {
    candidates.push(windowsPowerShell());
  }
  return uniquePaths([...candidates,under(env.APPDATA,'npm',binary),under(env.LOCALAPPDATA,'Programs',name,binary),path.join(home,'.local','bin',binary)]);
}

function npmNativeCodexCandidates(npmDir:string):string[] {
  const modules=path.join(npmDir,'node_modules');
  const architecture=process.arch==='arm64'?'arm64':'x64';
  const target=architecture==='arm64'?'aarch64':'x86_64';
  return [path.join(modules,'@openai','codex','node_modules'),modules].flatMap(base=>
    ['bin','codex'].map(layout=>path.join(base,'@openai',`codex-win32-${architecture}`,'vendor',`${target}-pc-windows-msvc`,layout,'codex.exe')));
}

async function windowsEditorCodexCandidates() {
  const home=process.env.USERPROFILE||os.homedir();
  const extensions=(await Promise.all(['.vscode','.cursor'].map(async editor=>{
    const dir=path.join(home,editor,'extensions');
    try {
      const entries=await fs.readdir(dir,{withFileTypes:true});
      return entries.filter(entry=>entry.isDirectory()&&/^openai\.chatgpt-/i.test(entry.name))
        .map(entry=>({name:entry.name,dir:path.join(dir,entry.name)}));
    } catch(error) {
      if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))return [];
      throw error;
    }
  }))).flat().sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true,sensitivity:'base'}));
  const architectures=process.arch==='arm64'?['arm64','x86_64']:['x86_64'];
  return extensions.flatMap(({dir})=>architectures.map(arch=>path.join(dir,'bin',`windows-${arch}`,'codex.exe')));
}

async function isFile(file:string) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function isExecutable(file:string) {
  if(process.platform!=='win32'){
    try { await fs.access(file,constants.X_OK); } catch { return false; }
  }
  return isFile(file);
}

export async function locate(name:string, configured?:string) {
  const windows=process.platform==='win32';
  const windowsCodex=windows&&name==='codex';
  const effective=configured||((name==='node'||name==='git')?defaultOverrides.get(name):undefined);
  if(effective) {
    if(!path.isAbsolute(effective))throw new Error('程序路径必须是绝对路径');
    if(windowsCodex&&!/\.exe$/i.test(effective)&&/^codex(?:\.cmd|\.ps1)?$/i.test(path.basename(effective))) {
      for(const nativeExe of npmNativeCodexCandidates(path.dirname(effective))) {
        if(await isFile(nativeExe))return nativeExe;
      }
    }
    if(await isFile(effective)) {
      if(!windows||/\.exe$/i.test(effective))return effective;
      throw new Error(`Windows 下需指定 .exe 可执行文件（不能直接执行脚本包装器）：${effective}`);
    }
    const staleStore=windowsCodex&&/\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources\\codex\.exe$/i.test(path.normalize(effective));
    if(!staleStore)throw new Error(`指定的程序路径不存在或无法访问：${effective}`);
  }
  const cached=resolved.get(name);
  if(cached&&await isExecutable(cached))return cached;
  function found(file:string) {
    if(windowsCodex||['git','node','powershell.exe'].includes(name))resolved.set(name,file);
    return file;
  }
  if(windowsCodex) {
    // Prefer the installed Codex Desktop MSIX binary so daemon/session protocol matches the desktop app.
    try {
      const {stdout}=await exec(windowsPowerShell(),['-NoProfile','-NonInteractive','-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation',
      ],{windowsHide:true,timeout:5000});
      const installPath=stdout.trim();
      if(path.isAbsolute(installPath)) {
        const executable=path.join(installPath,'app','resources','codex.exe');
        if(await isFile(executable))return found(executable);
      }
    } catch {}
  }
  if(windows) {
    if(name==='code'||name==='trae') {
      for(const directory of (process.env.PATH??'').split(path.delimiter).map(dir=>dir.replace(/^"|"$/g,'')).filter(dir=>path.isAbsolute(dir))) {
        for(const [command,editor] of editorExecutables[name]) {
          const executable=path.join(directory,`${editor}.exe`);
          if(await isFile(executable))return executable;
          if(await isFile(path.join(directory,`${command}.cmd`))||await isFile(path.join(directory,command))) {
            const installed=path.resolve(directory,'..',`${editor}.exe`);
            if(await isFile(installed))return installed;
          }
        }
      }
      for(const candidate of windowsFallbacks(name))if(await isFile(candidate))return candidate;
      throw Object.assign(new Error(`未找到 ${name==='code'?'VS Code':'Trae'} 可执行文件。`),{code:'ENOENT'});
    }
    try {
      const {stdout}=await exec('where.exe',[name],{windowsHide:true,timeout:5000});
      const candidates=stdout.trim().split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      // On Windows, spawn/execFile without shell only executes native .exe binaries (never extensionless sh or .cmd).
      for(const candidate of candidates) {
        if(!/\.exe$/i.test(candidate)||!await isFile(candidate))continue;
        return found(candidate);
      }
      if(windowsCodex) {
        for(const npmDir of new Set(candidates.filter(file=>path.isAbsolute(file)).map(file=>path.dirname(file)))) {
          for(const nativeExe of npmNativeCodexCandidates(npmDir)) {
            if(await isFile(nativeExe))return found(nativeExe);
          }
        }
      }
    } catch {
      // Avoid surfacing raw GBK-encoded Windows where.exe stderr as UTF-8 mojibake.
    }
    for(const candidate of windowsFallbacks(name))if(await isFile(candidate))return found(candidate);
    if(windowsCodex)for(const candidate of await windowsEditorCodexCandidates()) {
      if(await isFile(candidate))return found(candidate);
    }
  } else {
    const directories=[...(process.env.PATH||'').split(path.delimiter).filter(Boolean),'/usr/local/bin','/opt/homebrew/bin','/usr/bin','/bin',path.join(os.homedir(),'.local','bin')];
    for(const directory of new Set(directories)) {
      const candidate=path.resolve(directory,name);
      if(await isExecutable(candidate))return found(candidate);
    }
  }
  throw Object.assign(new Error(`本机 PATH 或标准安装目录中未找到「${name}」程序。请确认已安装并加入 PATH。`),{code:'ENOENT'});
}
