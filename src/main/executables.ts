import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const resolved = new Map<string,string>();

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
  return uniquePaths([under(env.APPDATA,'npm'),env.PNPM_HOME,under(env.LOCALAPPDATA,'pnpm'),under(env.VOLTA_HOME,'bin')]);
}

function windowsPowerShell() {
  return path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
}

function windowsFallbacks(name:string) {
  const env=process.env, home=env.USERPROFILE||os.homedir();
  const binary=name.endsWith('.exe')?name:name+'.exe';
  const scoop=path.join(home,'scoop','shims',binary);
  const candidates:(string|undefined)[]=[];
  if(name==='node'||name==='git') {
    const parts=name==='node'?['nodejs',binary]:['Git','cmd',binary];
    for(const root of [env.ProgramFiles,env['ProgramFiles(x86)'],under(env.LOCALAPPDATA,'Programs')])
      candidates.push(under(root,...parts));
    if(name==='node')candidates.push(under(env.NVM_SYMLINK,binary),under(env.VOLTA_HOME,'bin',binary));
    candidates.push(scoop);
  } else if(name==='codex') {
    const dirs=windowsPackageDirs();
    candidates.push(...dirs.flatMap(npmNativeCodexCandidates),...dirs.map(dir=>path.join(dir,binary)),scoop);
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
  if(configured) {
    if(!path.isAbsolute(configured))throw new Error('程序路径必须是绝对路径');
    if(windowsCodex&&!/\.exe$/i.test(configured)&&/^codex(?:\.cmd|\.ps1)?$/i.test(path.basename(configured))) {
      for(const nativeExe of npmNativeCodexCandidates(path.dirname(configured))) {
        if(await isFile(nativeExe))return nativeExe;
      }
    }
    if(await isFile(configured)) {
      if(!windows||/\.exe$/i.test(configured))return configured;
      throw new Error(`Windows 下需指定 .exe 可执行文件（不能直接执行脚本包装器）：${configured}`);
    }
    const staleStore=windowsCodex&&/\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources\\codex\.exe$/i.test(path.normalize(configured));
    if(!staleStore)throw new Error(`指定的程序路径不存在或无法访问：${configured}`);
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
  } else {
    const directories=[...(process.env.PATH||'').split(path.delimiter).filter(Boolean),'/usr/local/bin','/opt/homebrew/bin','/usr/bin','/bin',path.join(os.homedir(),'.local','bin')];
    for(const directory of new Set(directories)) {
      const candidate=path.resolve(directory,name);
      if(await isExecutable(candidate))return found(candidate);
    }
  }
  throw Object.assign(new Error(`本机 PATH 或标准安装目录中未找到「${name}」程序。请确认已安装并加入 PATH。`),{code:'ENOENT'});
}
