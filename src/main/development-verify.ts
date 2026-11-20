import {execFile,spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {inspectVerificationOutput} from '../delivery-audit';
import {locateVerificationShell,type DevelopmentCommand} from './development-runner';
import type {ProjectEnvironment} from './env-probe';
import {redact,stopTree} from './providers';

type Kind = 'typecheck' | 'test' | 'build';
type FailedCommand = Pick<DevelopmentCommand,'command'|'exit_code'|'output'> & {reason:string};
const labels:Record<Kind,string> = {typecheck:'类型检查',test:'测试',build:'构建'};
const windows = process.platform === 'win32';
const exec = promisify(execFile);

async function closedWithin(closed:Promise<number|null>,ms:number) {
  let timer:NodeJS.Timeout;
  const elapsed = new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),ms);});
  try { return await Promise.race([closed.then(()=>true),elapsed]); }
  finally { clearTimeout(timer!); }
}

async function stopWindowsVerification(shell:string,child:ChildProcessWithoutNullStreams,closed:Promise<number|null>,start:number,exitTime:()=>number|undefined) {
  let treeError:unknown;
  try { await stopTree(child); }
  catch(error) { treeError=error; }
  if (await closedWithin(closed,500)) return;
  const end=exitTime();
  if (!child.pid || !end) throw treeError ?? Error('无法确认验证 Shell 已退出。');
  // taskkill /T takes a snapshot. A child spawned just after that snapshot can
  // outlive the shell and retain its stdout/stderr. Limit the fallback to
  // children created during this particular shell's lifetime, pinning each
  // native process handle before invoking taskkill on its PID.
  const script=[
    "$ErrorActionPreference='Stop'",
    `$from=[DateTimeOffset]::FromUnixTimeMilliseconds(${start}).UtcDateTime`,
    `$to=[DateTimeOffset]::FromUnixTimeMilliseconds(${end+1}).UtcDateTime`,
    `$reused=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}'`,
    'if ($reused -and $reused.CreationDate.ToUniversalTime() -lt $to) { $to=$reused.CreationDate.ToUniversalTime() }',
    `foreach ($row in (Get-CimInstance Win32_Process -Filter 'ParentProcessId=${child.pid}')) {`,
    '  $born=$row.CreationDate.ToUniversalTime()',
    '  if ($born -lt $from -or $born -ge $to) { continue }',
    '  $process=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue',
    '  if (!$process) { continue }',
    '  try {',
    '    $null=$process.Handle',
    '    if ($process.HasExited -or [Math]::Abs(($process.StartTime.ToUniversalTime()-$born).TotalMilliseconds) -gt 1) { continue }',
    '    & "$env:SystemRoot\\System32\\taskkill.exe" /PID $process.Id /T /F',
    '    if ($LASTEXITCODE -ne 0 -and !$process.HasExited) { throw "无法停止验证子进程 $($process.Id)" }',
    '  } finally { $process.Dispose() }',
    '}',
  ].join('\n');
  await exec(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000});
  if (!await closedWithin(closed,1500)) throw Error('仍有未确认归属的进程占用验证输出管道。');
}

function targetedTest(base:string, scope:readonly string[]) {
  const npm = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?test$/.test(base);
  if (!npm && !/^(?:python3?\s+-m\s+)?pytest$/.test(base)) return base;
  const files = scope.map(file => file.replaceAll('\\','/')).filter(file =>
    /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$/.test(file));
  // Package managers may pass their arguments through another shell. Fall back
  // to the full configured suite for names that can't be passed literally there.
  if (!files.length || files.some(file => !/^[\p{L}\p{M}\p{N} ._/-]+$/u.test(file))) return base;
  const args = files.map(file => {
    const literal = file.startsWith('-') ? './'+file : file;
    return literal.includes(' ') ? "'"+literal+"'" : literal;
  });
  return base + (npm ? ' -- ' : ' ') + args.join(' ');
}

export function selectHostVerificationCommands(env:ProjectEnvironment,writeScope:readonly string[]) {
  const commands:{kind:Kind;command:string}[] = [], skipped:string[] = [];
  for (const kind of ['typecheck','test','build'] as const) {
    const base = env.effective_commands[kind]?.trim();
    if (!base) continue;
    const token = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(base);
    const executable = path.win32.basename(token?.slice(1).find(Boolean) ?? '').replace(/\.(exe|cmd|bat)$/i,'').toLowerCase();
    const tool = env.tools.find(tool => tool.id === executable)
      ?? (executable === 'ctest' ? env.tools.find(tool => tool.id === 'cmake') : undefined);
    if (tool?.status === 'missing') {
      skipped.push(`本机缺少 ${tool.label} 环境，已跳过本地${labels[kind]}（${base}），改由独立 Diff 审查把关。`);
    } else {
      commands.push({kind,command:kind === 'test' ? targetedTest(base,writeScope) : base});
    }
  }
  return {commands,skipped};
}

function hostEnvironment() {
  const env = {...process.env};
  if (windows) {
    const gitDir = path.join(env.ProgramFiles ?? 'C:\\Program Files','Git','cmd');
    const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
    if (existsSync(path.join(gitDir,'git.exe'))) env[key] = [gitDir,env[key]].filter(Boolean).join(path.delimiter);
  }
  return env;
}

async function execute(shell:string,command:string,workspace:string,env:NodeJS.ProcessEnv,isStopped:()=>boolean) {
  const start = Date.now(), started_at = new Date(start).toISOString();
  const checkExit = 'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }';
  // The CMake configure/build pair from env-probe also runs on Windows PowerShell 5.
  const script = path.basename(shell).toLowerCase() === 'powershell.exe' && /^cmake [\w ./=-]+ && cmake [\w ./=-]+$/.test(command)
    ? command.replace(' && ','\n'+checkExit+'\n') : command;
  const args = windows
    ? ['-NoLogo','-NoProfile','-NonInteractive','-Command',["$ErrorActionPreference='Stop'",'[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',script,checkExit,'exit $LASTEXITCODE'].join('\n')]
    : ['-c',command];
  const child = spawn(shell,args,{cwd:workspace,env,windowsHide:true,detached:!windows,stdio:'pipe'});
  child.stdin.end();
  let output = '', stopReason = '', stopError = '', exited:number|undefined;
  const collect = (chunk:string) => { output = (output+chunk).slice(-24000); };
  child.stdout.setEncoding('utf8').on('data',collect);
  child.stderr.setEncoding('utf8').on('data',collect);
  child.once('exit',()=>{ exited=Date.now(); });
  child.once('error',error=>{ stopReason=error.message; });
  const closed = new Promise<number|null>(resolve=>child.once('close',resolve));
  let stopping:Promise<void>|undefined,finishUnconfirmed!:()=>void;
  const unconfirmed=new Promise<null>(resolve=>{finishUnconfirmed=()=>resolve(null);});
  function stop(reason:string) {
    if (stopping) return;
    stopReason=reason;
    stopping=(async()=>{
      if(windows) await stopWindowsVerification(shell,child,closed,start,()=>exited);
      else if(child.pid){
        try { process.kill(-child.pid,'SIGKILL'); }
        catch(error) { if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error; }
      }
    })().catch(error=>{
      stopError='无法确认宿主验证进程树已停止：'+redact(String(error));
      child.stdout.destroy();child.stderr.destroy();child.unref();
      finishUnconfirmed();
    });
  }
  const timeout=setTimeout(()=>stop('宿主验证超过 180 秒。'),180000);
  const cancel=setInterval(()=>{if(isStopped())stop('宿主验证已取消。');},200);
  const exit=await Promise.race([closed,unconfirmed]).finally(()=>{
    clearTimeout(timeout);
    clearInterval(cancel);
  });
  await stopping;
  if (stopReason) collect('\n'+stopReason);
  if (stopError) collect('\n'+stopError);
  const record:DevelopmentCommand = {
    id:randomUUID(),command:redact(command),cwd:workspace,cwd_source:'task_workspace',exit_code:stopReason ? null : exit,
    output:redact(output).slice(-24000),started_at,completed_at:new Date().toISOString(),
  };
  return {record,stopReason,stopError};
}

export async function runHostVerification(options:{
  workspace:string;env:ProjectEnvironment;writeScope:readonly string[];isStopped:()=>boolean;
  onCommand?:(cmd:DevelopmentCommand)=>Promise<void>;
}) {
  const selected = selectHostVerificationCommands(options.env,options.writeScope);
  const commands:DevelopmentCommand[] = [], failed:FailedCommand[] = [];
  if (selected.commands.length && !options.isStopped()) {
    const shell = await locateVerificationShell(), env = hostEnvironment();
    for (const {command} of selected.commands) {
      if (options.isStopped()) break;
      const {record,stopReason,stopError} = await execute(shell,command,options.workspace,env,options.isStopped);
      commands.push(record);
      await options.onCommand?.(record);
      if(stopError) throw Object.assign(Error(stopError),{remoteUnknown:true});
      const metrics = inspectVerificationOutput(record.command,record.exit_code,record.output);
      if (record.exit_code !== 0 || (metrics.failed ?? 0) > 0 || metrics.suspicious_empty) {
        failed.push({command:record.command,exit_code:record.exit_code,output:record.output,reason:stopReason || metrics.label});
        break;
      }
    }
  }
  return {commands,skipped:selected.skipped,failed};
}
