import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { load } from 'js-yaml';
import { satisfies } from 'semver';
import type { ProviderProfile } from '../shared';
import { redact } from './providers';
import { locate, windowsPackageDirs } from './executables';
import { now } from './store';

const exec = promisify(execFile);
export function isSupportedDshVersion(version:string) {
  return satisfies(version,'>=0.2.1-rc.2',{includePrerelease:true});
}

export async function resolveDsh(configured?: string) {
  let file: string;
  if (configured) {
    if (!path.isAbsolute(configured)) throw Error('DSH 程序路径必须是绝对路径');
    await fs.access(configured);
    file = configured;
  } else if (process.platform === 'win32') {
    const directories = (process.env.PATH ?? '').split(path.delimiter).map(directory => directory.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
    directories.push(...windowsPackageDirs(),path.join(process.env.USERPROFILE||os.homedir(),'scoop','shims'));
    const candidates = [...new Set(directories)].flatMap(directory => ['dsh.exe', 'dsh.cmd'].map(name => path.join(directory, name)));
    const available = await Promise.all(candidates.map(async item => (await fs.stat(item).catch(() => null))?.isFile()));
    const index = available.indexOf(true);
    if (index < 0) throw Error('未在本机找到 dsh.cmd 或 dsh.exe，请先安装 DeepSeek Harness。');
    file = candidates[index];
  } else {
    file = await locate('dsh');
  }

  if (/\.cmd$/i.test(file)) {
    const content = await fs.readFile(file, 'utf8');
    const explicit = content.match(/^\s*"([^"\r\n]+node\.exe)"\s+"([^"\r\n]+\.[cm]?js)"\s+%\*\s*$/im);
    if (explicit && path.isAbsolute(explicit[1]) && path.isAbsolute(explicit[2])) {
      await Promise.all([fs.access(explicit[1]), fs.access(explicit[2])]);
      return { command: explicit[1], prefix: [explicit[2]], path: file };
    }
    // npm's generated cmd shim points at a package entry relative to itself.
    const relative = content.match(/"%dp0%[\\/]?(node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)"\s+%\*/i)?.[1];
    if (!relative) throw Error('无法识别 DSH 启动器，请检查官方安装。');
    const entry = path.resolve(path.dirname(file), relative);
    await fs.access(entry);
    return { command: await locate('node'), prefix: [entry], path: file };
  }
  if (/\.[cm]?js$/i.test(file)) return { command: await locate('node'), prefix: [file], path: file };
  if (process.platform === 'win32' && !/\.exe$/i.test(file)) throw Error('Windows 需要 DSH 的 .cmd、.exe 或官方 JavaScript 入口');
  return { command: file, prefix: [], path: file };
}

export async function dshCredential() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const raw = await fs.readFile(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw Error('无法读取本机 DSH 登录凭据，请检查 DSH 的账户配置。');
  });
  try {
    const key = (load(raw) as { refs?: { DEEPSEEK_API_KEY?: unknown } } | undefined)?.refs?.DEEPSEEK_API_KEY;
    return typeof key === 'string' ? key : undefined;
  } catch {
    throw Error('本机 DSH 登录凭据格式无效，请在 DSH 中重新登录。');
  }
}

export async function probeDsh(configured?: string): Promise<ProviderProfile> {
  const profile: ProviderProfile = {
    provider_id: 'dsh', requested_name: 'dsh', product: 'DeepSeek Harness', transport: 'dsh web',
    status: 'blocked_external', auth: '未检查登录', reason: '', checked_at: now(),
    capabilities: { submit_task: 'DSH Web', event_stream: 'DSH Web', code_write: '通过 ARC 写入已批准的文件' },
  };
  try {
    const runtime = await resolveDsh(configured);
    profile.path = runtime.path;
    const { stdout } = await exec(runtime.command, [...runtime.prefix, '--version'], { windowsHide: true, timeout: 8000 });
    profile.version = stdout.trim();
    if (!isSupportedDshVersion(profile.version)) throw Error(`DSH 需要可识别的版本号且版本 ≥ 0.2.1-rc.2，当前为 ${profile.version}。`);
  } catch (error) {
    return { ...profile, reason: redact((error as Error).message) };
  }
  try {
    if (await dshCredential()) return { ...profile, status: 'available', auth: '检测到本机 DSH 凭据', reason: '本机 DSH Web 已就绪' };
    return { ...profile, status: 'auth_required', auth: '需登录', reason: '请先在 DeepSeek Harness 中完成登录或配置模型凭据。' };
  } catch (error) {
    return { ...profile, status: 'auth_required', auth: '需登录', reason: (error as Error).message };
  }
}

export function parseDshReply(raw: string): unknown {
  const value = raw.trim();
  const fenced = /^\x60\x60\x60(?:json)?\s*\r?\n([\s\S]*)\r?\n\x60\x60\x60$/i.exec(value);
  return JSON.parse(fenced?.[1] ?? value);
}
