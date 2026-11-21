import React, {useEffect,useRef,useState} from 'react';
import type { CodexPreferences, CodexReasoningEffortPreference, ProgramPathKey, Project, ProviderPathConfig, RuntimeToolStatus, Scenario, WorkspaceData } from '../shared';
import { CodexModelSelect } from './CodexModelSelect';
import { ExternalExecutor } from './EngineeringSections';
import { EngineeringManagement } from './EngineeringWorkspace';
import {analysisModes,type AnalysisMode} from './discovery-state';

const api = window.arc;

interface EnvironmentSettings {
  data_directory: string;
  version: string;
  provider_config: ProviderPathConfig;
  runtime_tools: RuntimeToolStatus[];
}

const programPaths = [
  { id: 'codex', key: 'codex_path', label: 'OpenAI Codex', title: '选择 Codex 程序（codex.exe 或 codex.cmd）' },
  { id: 'dsh', key: 'dsh_path', label: 'DeepSeek Harness (DSH)', title: '选择 DSH 程序（dsh.cmd 或 dsh.exe）' },
  { id: 'node', key: 'node_path', label: 'Node.js（必需）', title: '选择 Node.js 程序（node.exe）' },
  { id: 'git', key: 'git_path', label: 'Git（推荐）', title: '选择 Git 程序（git.exe）' },
] as const;

export interface SettingsModalProps {
  data: WorkspaceData;
  project?: Project;
  projectId: string;
  scenario?: Scenario;
  scenarioId: string;
  mcp: any;
  setMcp: (value: any) => void;
  settings: EnvironmentSettings | null;
  error: string;
  connectionError: string;
  notice: string;
  setNotice: (value: string) => void;
  pending: boolean;
  mode: AnalysisMode;
  openDesktop: boolean;
  setMode: (mode: AnalysisMode) => void;
  saveCodexPreferences: (changes: Partial<CodexPreferences>) => Promise<boolean>;
  refreshMcp: () => void;
  action: <T>(fn: () => Promise<T>, message?: string) => Promise<T | undefined>;
  reload: () => Promise<WorkspaceData>;
  chooseProject: (project: Project, workspace?: WorkspaceData) => Promise<void>;
  restoreEngineering: () => Promise<void>;
  onOpenBuildConfig: (config: string) => void;
  onOpenRenameScenario: (title: string) => void;
}

export function SettingsModal({
  data,
  project,
  projectId,
  scenario,
  scenarioId,
  mcp,
  setMcp,
  settings,
  error,
  connectionError,
  notice,
  setNotice,
  pending,
  mode,
  openDesktop,
  setMode,
  saveCodexPreferences,
  refreshMcp,
  action,
  reload,
  chooseProject,
  restoreEngineering,
  onOpenBuildConfig,
  onOpenRenameScenario,
}: SettingsModalProps) {
  const [detecting,setDetecting]=useState(false);
  const [desktopExpanded,setDesktopExpanded]=useState(openDesktop);
  const [detectionError,setDetectionError]=useState('');
  const [envSettings, setEnvSettings] = useState(settings);
  const refreshedEnvSettings = useRef(false);
  const [pathDraft, setPathDraft] = useState<ProviderPathConfig>({});
  const selectedEngine = (mode === 'codex' || mode === 'dsh') ? data.providers.find(p => p.provider_id === mode) : undefined;
  const engineNeedsPath = !!selectedEngine && selectedEngine.status !== 'available' && selectedEngine.status !== 'auth_required';
  const nodeMissing = envSettings?.runtime_tools.find(tool => tool.id === 'node')?.status === 'missing';
  const [pathsExpanded, setPathsExpanded] = useState(engineNeedsPath || nodeMissing);

  useEffect(() => {
    // The parent's opening request may finish after a newer local refresh.
    if (!refreshedEnvSettings.current) setEnvSettings(settings);
  }, [settings]);
  useEffect(() => {
    if (engineNeedsPath || nodeMissing) setPathsExpanded(true);
  }, [engineNeedsPath, nodeMissing, mode]);

  async function detectEngines(override?: { key: ProgramPathKey; path: string }) {
    setDetecting(true);
    setDetectionError('');
    try {
      await api.invoke('providers_probe', override && { config: { [override.key]: override.path } });
      const [updated] = await Promise.all([api.invoke<EnvironmentSettings>('settings'), reload()]);
      refreshedEnvSettings.current = true;
      setEnvSettings(updated);
      if (override) setPathDraft(draft => {
        const next = { ...draft };
        delete next[override.key];
        return next;
      });
    } catch(e) {
      setDetectionError((e as Error).message);
    } finally {
      setDetecting(false);
    }
  }
  async function pickProgram(key: ProgramPathKey, title: string) {
    setDetectionError('');
    try {
      const picked = await api.invoke<string | null>('pick_program', { title });
      if (picked) await detectEngines({ key, path: picked });
    } catch (e) {
      setDetectionError((e as Error).message);
    }
  }
  useEffect(()=>{void detectEngines();},[]);

  return (
    <div className="settings-body agent-settings">
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      {connectionError && (
        <p role="alert" className="warning">
          {connectionError}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      <section className="provider-card agent-local-engines" aria-labelledby="local-engines-title">
        <h3 id="local-engines-title">本机引擎（开箱即用）</h3>
        <p>默认引擎适用于所有工程的分析、提问和新需求。</p>
        <div className="agent-engine-choices" role="group" aria-label="默认本机引擎">
          {(['codex','dsh'] as const).map(engine=>{
            const profile=data.providers.find(p=>p.provider_id===engine);
            const status=detecting?'检测中…':profile?.status==='available'?'已就绪':profile?.status==='auth_required'?'需登录':profile?.path?'不可用':profile?'未检测到':'待检测';
            return <button key={engine} aria-pressed={mode===engine} aria-describedby={`agent-state-${engine}`} disabled={pending} onClick={()=>setMode(engine)}>
              <strong>{analysisModes[engine].option}</strong>
              <span id={`agent-state-${engine}`} aria-hidden="true" className={`agent-state${profile?.status==='available'&&!detecting?' ready':''}`} title={profile?.reason}>
                {status}
              </span>
            </button>;
          })}
        </div>
        <div className="agent-engine-actions">
          <small role="status">当前默认：{analysisModes[mode].option}</small>
          <button disabled={detecting||pending} onClick={()=>void detectEngines()}>检测本机引擎</button>
        </div>
        <fieldset className="agent-codex-preferences">
          <legend>Codex 模型与推理强度</legend>
          <div className="agent-codex-fields">
            <div>
              <span>模型</span>
              <CodexModelSelect catalog={data.codex_models} model={data.codex_preferences.model}
                label="Codex 模型" disabled={pending} allowCustom onModelChange={model => saveCodexPreferences({model})}/>
            </div>
            <label>推理强度
              <select aria-label="Codex 推理强度" disabled={pending} value={data.codex_preferences.reasoning_effort}
                onChange={event => void saveCodexPreferences({reasoning_effort:event.target.value as CodexReasoningEffortPreference})}>
                <option value="auto">按任务自动分级（推荐）</option>
                <option value="low">低（更快）</option>
                <option value="medium">中（均衡）</option>
                <option value="high">高（深度）</option>
              </select>
            </label>
          </div>
        </fieldset>
        {detectionError&&<p role="alert" className="warning">{detectionError}</p>}
        {!detecting&&data.providers.filter(p=>p.provider_id===mode&&p.status!=='available').map(p=><p key={p.provider_id} className="muted">{p.status==='auth_required'?`请先在 ${analysisModes[mode].name} 中登录，再检测。`:p.reason}</p>)}
        <details className="agent-runtime-paths" open={pathsExpanded} onToggle={event => setPathsExpanded(event.currentTarget.open)}>
          <summary>程序路径与运行环境（自定义安装位置）</summary>
          <p>默认自动探测常见安装位置；若程序装在自定义盘符或未加入 PATH，可在此手动指定。</p>
          <div className="agent-runtime-list" aria-busy={detecting}>
            {programPaths.map(({ id, key, label, title }) => {
              const tool = id === 'codex' || id === 'dsh'
                ? data.providers.find(provider => provider.provider_id === id)
                : envSettings?.runtime_tools.find(runtime => runtime.id === id);
              const saved = envSettings?.provider_config[key] ?? '';
              const draft = pathDraft[key] ?? saved;
              const ready = tool?.status === 'available';
              const needsLogin = tool?.status === 'auth_required';
              const status = detecting ? '检测中…' : ready ? '已就绪' : needsLogin ? '需登录' : tool?.path || saved ? '不可用' : '未检测到';
              const detail = ready || needsLogin ? tool?.path : tool?.reason;
              const disabled = detecting || pending;
              return <div className="agent-runtime-entry" key={key} role="group" aria-labelledby={`program-label-${id}`}>
                <div className="agent-runtime-heading">
                  <label id={`program-label-${id}`} htmlFor={`program-path-${id}`}>{label}</label>
                  <span className={`agent-state${ready && !detecting ? ' ready' : ''}`}>
                    {status}{!detecting && tool?.version && ` · ${tool.version}`}
                  </span>
                </div>
                <p id={`program-detail-${id}`} className={tool?.reason && !ready && !needsLogin ? 'warning' : 'muted'}>
                  {saved ? '手动指定' : '自动检测'}{detail && ` · ${detail}`}
                </p>
                <div className="row agent-runtime-controls">
                  <input id={`program-path-${id}`} aria-describedby={`program-detail-${id}`} value={draft}
                    placeholder="留空自动检测" disabled={disabled} spellCheck={false} autoComplete="off"
                    onChange={event => {
                      const path = event.target.value;
                      setPathDraft(current => ({ ...current, [key]: path }));
                    }}/>
                  <button disabled={disabled} onClick={() => void pickProgram(key, title)}>选择程序…</button>
                  {draft !== saved && <button disabled={disabled} onClick={() => void detectEngines({ key, path: draft })}>应用</button>}
                  {saved && <button disabled={disabled} onClick={() => void detectEngines({ key, path: '' })}>恢复自动</button>}
                </div>
              </div>;
            })}
          </div>
        </details>
      </section>

      <details className="provider-card agent-settings-advanced" open={desktopExpanded} onToggle={event=>setDesktopExpanded(event.currentTarget.open)}>
        <summary>高级：绑定 Codex 桌面会话（可选）</summary>
        <p>{analysisModes.codex_desktop.description}。</p>
        <button aria-pressed={mode==='codex_desktop'} disabled={pending} onClick={()=>setMode('codex_desktop')}>设为默认引擎</button>
        {desktopExpanded&&(project&&!project.fictional?(
          <ExternalExecutor key={projectId} projectId={projectId} projectPath={project.root_path}
            programHint={data.providers.find(p=>p.provider_id==='codex')?.path||''} onBound={refreshMcp}/>
        ):<p className="scope-box">打开一个实际工程，即可查找并连接该工程的 Codex 会话。</p>)}
      </details>

      <details className="provider-card agent-settings-advanced">
        <summary>外部 Agent · MCP</summary>
        <p>由已接入 ARC MCP 的 Agent 自行领取已保存的任务。</p>
        <button aria-pressed={mode==='mcp'} disabled={pending} onClick={()=>setMode('mcp')}>设为默认引擎</button>
        {scenario && (
          <div className="scope-box">
            <strong>{scenario.title}</strong>
            <p>准备任务后，在已接入 ARC 的 Codex 对话中说「领取 ARC 当前分析任务」。</p>
          </div>
        )}
        <p>
          当前可领取的工程：
          {mcp?.enabled
            ? data.projects.find(p => p.project_id === mcp.project_id)?.name || mcp.project_id
            : mcp
              ? '未授权'
              : '正在读取'}
        </p>
        {mcp?.registered && <p className="muted">Codex 已登记 MCP。请在新会话中加载 ARC 工具。</p>}
        <div className="row">
          <button
            disabled={!project || project.fictional || pending}
            onClick={() =>
              void action(
                async () => setMcp(await api.invoke('mcp_enable', { project_id: projectId, register_codex: true })),
                '已为 Codex 配置 MCP。请在新会话中加载 ARC 工具。',
              )
            }
          >
            授权当前工程并登记 MCP
          </button>
          <button disabled={!mcp?.enabled || pending} onClick={() => void action(async () => setMcp(await api.invoke('mcp_disable')))}>
            撤销上述工程授权
          </button>
        </div>
      </details>

      <details className="provider-card agent-settings-advanced">
        <summary>工程管理与本地数据</summary>
        {project && (
          <EngineeringManagement
            project={project}
            onRestored={id =>
              void reload().then(workspace => {
                const restored = workspace.projects.find(p => p.project_id === id);
                if (restored) void chooseProject(restored, workspace);
              })
            }
          />
        )}
        <p className="path">{envSettings?.data_directory}</p>
        <div className="row">
          <button
            onClick={() =>
              void action(async () => {
                const value = await api.invoke('backup');
                if (value) setNotice('数据库备份已保存');
              })
            }
          >
            备份 SQLite
          </button>
          <button
            disabled={!project}
            onClick={() =>
              void action(async () => {
                const value = await api.invoke('engineering_export', { project_id: projectId });
                if (value) setNotice('工程上下文、开发记录与阅读资料已导出');
              })
            }
          >
            导出当前工程资料
          </button>
          <button onClick={() => void restoreEngineering()}>恢复工程记录</button>
          <button
            disabled={!scenario}
            onClick={() =>
              void action(async () => {
                const value = await api.invoke('import_result', { scenario_id: scenarioId });
                if (value) setNotice('手动导入已校验');
              })
            }
          >
            导入当前场景结果
          </button>
        </div>
        {project && (
          <div className="row">
            <button onClick={() => onOpenBuildConfig(project.build_config)}>配置构建目标 / 宏</button>
            {scenario && (
              <>
                <button onClick={() => onOpenRenameScenario(scenario.title)}>重命名场景</button>
                <button
                  onClick={() =>
                    void action(
                      () => api.invoke('organize', { kind: 'scenario', id: scenarioId, patch: { archived: !scenario.archived } }),
                      '场景归档状态已保存',
                    )
                  }
                >
                  {scenario.archived ? '恢复场景' : '归档场景'}
                </button>
              </>
            )}
          </div>
        )}
        <p className="muted">Arc {envSettings?.version} · Windows 桌面</p>
      </details>
    </div>
  );
}
