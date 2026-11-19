import React from 'react';
import type { Project, Scenario, WorkspaceData } from '../shared';
import { ExternalExecutor } from './EngineeringSections';
import { EngineeringManagement } from './EngineeringWorkspace';

const api = window.arc;

export interface SettingsModalProps {
  data: WorkspaceData;
  project?: Project;
  projectId: string;
  scenario?: Scenario;
  scenarioId: string;
  mcp: any;
  setMcp: (value: any) => void;
  settings: any;
  error: string;
  connectionError: string;
  notice: string;
  setNotice: (value: string) => void;
  pending: boolean;
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
  refreshMcp,
  action,
  reload,
  chooseProject,
  restoreEngineering,
  onOpenBuildConfig,
  onOpenRenameScenario,
}: SettingsModalProps) {
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

      {project && !project.fictional ? (
        <ExternalExecutor
          key={projectId}
          projectId={projectId}
          projectPath={project.root_path}
          programHint={data.providers.find(p => p.provider_id === 'codex')?.path || ''}
          onBound={refreshMcp}
        />
      ) : (
        <p className="scope-box">打开一个实际工程，即可查找并连接该工程的 Codex 会话。</p>
      )}

      <details className="provider-card agent-settings-advanced">
        <summary>外部 Agent 自行领取 · MCP</summary>
        <p>让已接入 MCP 的 Codex 对话来 ARC 领取你准备的分析任务。</p>
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
        <p className="path">{settings?.data_directory}</p>
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
        <p className="muted">Arc {settings?.version} · Windows 桌面</p>
      </details>
    </div>
  );
}
