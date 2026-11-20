import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { dump } from 'js-yaml';
import { dshCredential, resolveDsh } from './dsh';
import { locate, redact, stopTree, type ActiveProcess } from './providers';
import type { Run, Snapshot, ProviderProfile } from '../shared';

const cleanLog = (text: string) => redact(text).replace(/([?&]token=)[^\s&#]+/gi, '$1[REDACTED]');
const preset = 'arc-read-only';

export class DshMalformedReply extends Error {}

function launchUrl(line: string) {
  const match = /^dsh web:\s+(http:\/\/\S+)/.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
  if (!match) return;
  const url = new URL(match[1]);
  if (url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1) {
    throw Error('DSH Web 启动地址不受支持');
  }
  return url.href;
}

class DshRemote {
  private cookie = '';
  private readonly origin: string;
  constructor(private readonly url: string) {
    this.origin = new URL(url).origin;
  }

  async authenticate() {
    const response = await fetch(this.url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status !== 303 || response.headers.get('location') !== './') throw Error('DSH Web 本机授权失败');
    this.cookie = response.headers.getSetCookie().map(item => item.split(';')[0])
      .filter(item => /^dsh[\w-]*=[A-Za-z0-9_.-]+$/.test(item)).join('; ');
    if (!this.cookie) throw Error('DSH Web 未返回会话凭证');
  }

  async rpc(method: string, request: object) {
    const rpcId = 'arc-' + randomUUID();
    const response = await fetch(this.origin + '/api/' + method, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
    });
    if (!response.ok) throw Error(`DSH Web ${method} HTTP ${response.status}`);
    const reply = await response.json();
    if (reply.type !== 'server-response' || reply.rpcId !== rpcId || typeof reply.result?.ok !== 'boolean') {
      throw Error('DSH Web 返回的请求标识不匹配');
    }
    if (!reply.result.ok) {
      throw Error(`DSH Web 拒绝 ${method}：${cleanLog(String(reply.result.error?.code))} ${cleanLog(String(reply.result.error?.message ?? '')).slice(0, 1000)}`);
    }
    return reply.result.value;
  }

  async events(sessionId: string, after: number) {
    const { asOfSeq } = await this.rpc('session/projections', { sessionId });
    if (!Number.isInteger(asOfSeq) || asOfSeq < after) throw Error('DSH 会话历史不可核验');
    const records = new Map<number, NativeEvent>();
    let beforeSeq: number | undefined;
    while (asOfSeq > after) {
      const page = await this.rpc('session/page', {
        address: { kind: 'session', sessionId }, throughSeq: asOfSeq, maxMessages: 100, beforeSeq,
      });
      if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean') throw Error('DSH 会话分页不合法');
      const events: NativeEvent[] = page.records.filter((record: any) => record.type === 'event').map((record: any) => record.event);
      if (events.some(event => !Number.isInteger(event.seq) || event.seq < 0 || event.seq > asOfSeq)) {
        throw Error('DSH 事件范围不合法');
      }
      for (const event of events) if (event.seq > after) records.set(event.seq, event);
      const floor = Math.min(...events.map(event => event.seq));
      if (!page.hasMore || floor <= after) break;
      if (!Number.isFinite(floor) || (beforeSeq !== undefined && floor >= beforeSeq)) throw Error('DSH 分页未前进');
      beforeSeq = floor;
    }
    const events = [...records.values()].sort((a, b) => a.seq - b.seq);
    if (asOfSeq > after && events.at(-1)?.seq !== asOfSeq) throw Error('DSH 会话历史缺失');
    return { cursor: asOfSeq, events };
  }
}
type NativeEvent = { seq: number; type: string; data: any };

function waitForHost(child: ChildProcessWithoutNullStreams) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('DSH Web 启动超时')), 45000);
    let buffer = '';
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timer);
      child.stdout.off('data', read);
      child.stdout.resume();
      if (error) reject(error);
      else resolve(url!);
    };
    const read = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      try {
        for (const line of lines) {
          const url = launchUrl(line);
          if (url) { finish(undefined, url); break; }
        }
      } catch (error) {
        finish(error as Error);
      }
    };
    child.stdout.on('data', read);
    child.once('error', error => finish(error));
    child.once('close', code => finish(Error(`DSH Web 已退出（${code}）`)));
  });
}

type Options = {
  profile: ProviderProfile;
  prompt: string;
  outputSchema: object;
  submitResult?: boolean;
  event: (event: any) => void;
  started: (active: ActiveProcess) => void;
  shouldStart?: () => boolean;
  timeoutMs?: number;
} & ({
  toolFree: true;
  run: Pick<Run, 'title' | 'output_path'>;
  submitResult?: false;
} | {
  toolFree?: false;
  run: Pick<Run, 'title' | 'output_path'> & { binding: { source_snapshot_id: string } };
  snapshot: Snapshot;
  storage: string;
  resources: string;
});

export async function runDshWeb(options: Options): Promise<{ code: number; raw: string; stderr: string; protocol_error?: string; session_id?: string }> {
  const { run, profile, event } = options;
  const deadline = options.toolFree ? Date.now() + (options.timeoutMs ?? 60000) : undefined;
  const directory = path.dirname(run.output_path);
  const cwd = options.toolFree ? directory : path.join(options.storage, 'snapshots', options.snapshot.source_snapshot_id);
  const home = path.join(directory, 'dsh-web-home');
  const patch = path.join(home, 'arc-web.patch.yml');
  const contextPath = path.join(directory, 'source-context.json');
  const [runtime, key] = await Promise.all([resolveDsh(profile.path), dshCredential()]);
  if (!key) throw Error('缺少本机 DSH 登录凭据');
  await fs.mkdir(home, { recursive: true });
  const plugins = options.toolFree ? [] : [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Use Arc tools to read the bound source snapshot and deliver the requested result.' } },
    { id: 'arc-source', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'arc-frozen-source', transport: 'stdio', command: await locate('node'),
      args: [path.join(options.resources, 'dist', 'context-server.cjs'), contextPath], failOnStartupError: true,
    } },
  ];
  const prompt = options.prompt + (options.submitResult
    ? '\n调用 arc_submit_result，把符合该工具合同的完整结果作为参数提交。工具确认后结束。'
    : '\n最终只回复一个符合以下合同的 JSON 对象。\n' + JSON.stringify(options.outputSchema));
  await Promise.all([
    !options.toolFree && fs.writeFile(contextPath, JSON.stringify({ storage: options.storage, snapshot: options.snapshot, resultSchema: options.submitResult ? options.outputSchema : undefined })),
    fs.writeFile(path.join(directory, 'prompt.txt'), prompt),
    fs.writeFile(patch, dump([
      { id: 'agent-preset-registry', config: { default: preset } },
      { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'preset-' + preset, name: '@deepseek-ai/dsh-agent-preset', config: { id: preset, name: 'Arc 只读工程分析', plugins } }] },
    ])),
  ]);

  if (options.shouldStart && !options.shouldStart()) throw Error('任务已取消，未启动 DSH Web');
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: key, DSH_PERMISSION_MODE: 'read-only', NO_COLOR: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime.command, [...runtime.prefix, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
  const clean = (value: string) => cleanLog(value.replaceAll(key, '[REDACTED]'));
  let submitted = false, terminal = false, cancelled = false;
  let stopping: Promise<void> | undefined, sessionId: string | undefined, remote: DshRemote | undefined;
  const stop = () => stopping ??= stopTree(child);
  let timedOut = false;
  const timer = deadline === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    void stop().catch(() => {}); // finally awaits the same stop operation
  }, Math.max(0, deadline - Date.now()));
  const url = waitForHost(child);
  options.started({ child, cancel: async () => {
    cancelled = true;
    await stop();
  } });

  try {
    remote = new DshRemote(await url);
    await remote.authenticate();
    if (cancelled) return { code: 1, raw: '', stderr: '' };
    const session = await remote.rpc('session/create', { cwd, agentPreset: preset });
    sessionId = session.sessionId;
    if (!sessionId) throw Error('DSH 未返回会话 ID');
    event({ type: 'session.started', thread_id: sessionId });
    const requestId = randomUUID();
    await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({
      ...(!options.toolFree && {binding: options.run.binding, source_fingerprint: options.snapshot.fingerprint}),
      provider: 'dsh', transport: 'dsh web', session_id: sessionId, request_id: requestId,
    }, null, 2));
    if (cancelled) return { code: 1, raw: '', stderr: '' };
    submitted = true;
    const receipt = await remote.rpc('session/prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: 'Asia/Shanghai' });
    if (receipt?.accepted !== true) throw Error('DSH 未确认接收消息');

    const admitted = Date.now();
    let lastProgress = admitted, cursor = -1, lastTurn: number | undefined, ownTurn: number | undefined, raw = '';
    while (!cancelled) {
      if (child.exitCode !== null) throw Error('DSH Web 已退出，未获得本轮终态');
      const state = await remote.events(sessionId, cursor);
      cursor = state.cursor;
      if (state.events.length) lastProgress = Date.now();
      for (const frame of state.events) {
        const { seq, type, data } = frame;
        if (type === 'turn/start') lastTurn = data.turn;
        if (type === 'user/message' && data.source?.rpcId === requestId) {
          if (lastTurn === undefined) throw Error('DSH 消息无法绑定轮次');
          ownTurn = lastTurn;
        }
        if (ownTurn === undefined) continue;
        if (type === 'tool/call') {
          const argumentsJson = options.submitResult && data.name.endsWith('arc_submit_result') ? undefined : data.arguments;
          const rawInput = typeof argumentsJson === 'string' ? JSON.parse(argumentsJson) : argumentsJson;
          event({ type: 'session.update', update: {
            sessionUpdate: 'tool_call', toolCallId: data.callId, title: data.name, status: 'in_progress', rawInput,
          } });
        }
        if (type === 'tool/result') event({ type: 'session.update', update: {
          sessionUpdate: 'tool_call_update', toolCallId: data.message?.toolCallId, status: data.message?.isError ? 'failed' : 'completed',
        } });
        if (type === 'assistant/message' && data.turn === ownTurn) {
          const content = (data.message?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
          if (content) {
            raw = content;
            event({ type: 'session.update', update: { sessionUpdate: 'agent_message_chunk', messageId: String(seq), content: { type: 'text', text: content } } });
          }
        }
        if (type === 'turn/end' && data.turn === ownTurn) {
          terminal = true;
          const reason = data.reason?.kind;
          event({ type: 'provider.finished', session_id: sessionId, stop_reason: reason });
          if (reason !== 'completed') {
            const message = clean('DSH 本轮未完成：' + (data.reason?.error?.message || reason));
            if (data.reason?.error?.code === 'MALFORMED_RESPONSE') throw new DshMalformedReply(message);
            throw Error(message);
          }
          if (options.submitResult) {
            raw = await fs.readFile(path.join(directory, 'submitted-result.json'), 'utf8').catch(error => {
              if (error.code === 'ENOENT') return raw;
              throw error;
            });
          }
          if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw Error('DSH 输出超过 2 MiB');
          await fs.writeFile(run.output_path, raw);
          return { code: 0, raw, stderr: clean(stderr), session_id: sessionId };
        }
      }
      const elapsed = Date.now();
      if (ownTurn === undefined && elapsed - admitted > 45000) throw Error('DSH 消息已提交，但未观察到对应轮次');
      if (elapsed - admitted > (options.timeoutMs ?? 12 * 60_000) || elapsed - lastProgress > 5 * 60_000) {
        await remote.rpc('session/cancel', { sessionId });
        throw Error('DSH Web 超过本轮等待时限');
      }
      await pause(700);
    }
    return { code: 1, raw, stderr: clean(stderr), session_id: sessionId };
  } catch (error) {
    if (timedOut) throw Error('DSH 优化提示词超过 60 秒，请重试。');
    if (cancelled) return { code: 1, raw: '', stderr: clean(stderr), session_id: sessionId };
    const message = clean((error as Error).message);
    await fs.writeFile(path.join(directory, 'diagnostic.json'), JSON.stringify({ error: message, stderr: clean(stderr), session_id: sessionId }));
    if (error instanceof DshMalformedReply) throw error;
    throw Object.assign(Error(message), { remoteUnknown: submitted && !terminal });
  } finally {
    clearTimeout(timer);
    await stop();
  }
}
