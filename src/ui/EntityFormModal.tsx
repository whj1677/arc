import React, { useRef } from 'react';
import type { Feature } from '../shared';

const api = window.arc;

export interface EntityFormModalProps {
  modal: string;
  error: string;
  pending: boolean;
  indexTasks: any[];
  userFeatures: Feature[];
  formFeature: string;
  setFormFeature: (value: string) => void;
  formName: string;
  setFormName: (value: string) => void;
  formQuestion: string;
  setFormQuestion: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent, analyze?: boolean) => Promise<void>;
  action: <T>(fn: () => Promise<T>, message?: string) => Promise<T | undefined>;
}

export function EntityFormModal({
  modal,
  error,
  pending,
  indexTasks,
  userFeatures,
  formFeature,
  setFormFeature,
  formName,
  setFormName,
  formQuestion,
  setFormQuestion,
  onCancel,
  onSubmit,
  action,
}: EntityFormModalProps) {
  const composing = useRef(false);
  const questionLabel =
    modal === 'build'
      ? '构建目标、宏与包含路径（作为源码来源条件保存）'
      : modal === 'feature'
        ? '场景问题（可选）'
        : '要理解的问题';

  return (
    <form
      onSubmit={onSubmit}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' && (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) {
          e.preventDefault();
        }
      }}
    >
      {modal === 'scenario' && (
        <label>
          所属功能
          <select required value={formFeature} onChange={e => setFormFeature(e.target.value)}>
            {userFeatures.map(f => (
              <option key={f.feature_id} value={f.feature_id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {modal === 'open' && (
        <>
          {error && (
            <p className="warning" role="alert">
              {error}
            </p>
          )}
          {pending && (
            <div className="scope-box" role="status">
              <strong>{indexTasks.length ? '正在准备只读源码' : '正在打开工程并准备任务…'}</strong>
              {indexTasks.map(task => (
                <div key={task.project_id}>
                  <p>
                    {task.project_name} · 已读取 {task.count} 个文本文件
                  </p>
                  <button type="button" onClick={() => void action(() => api.invoke('index_cancel', { project_id: task.project_id }))}>
                    取消本次索引
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="open-project-intro">
            <p>选一个源码文件夹，先看系统架构和功能目录，再点选功能或文件继续提问。</p>
            <ol>
              <li>冻结只读源码</li>
              <li>在 ARC 内分析全貌</li>
              <li>原位阅读与追问</li>
            </ol>
            <p className="muted">首次分析需要连接 Codex 的同目录会话。已有分析记录的工程会恢复阅读。</p>
          </div>
        </>
      )}

      {['feature', 'featureRename', 'open', 'rename'].includes(modal) && (
        <label>
          {modal === 'open' ? '本地工程绝对路径' : modal === 'feature' ? '功能名称' : '显示标题'}
          <input
            autoFocus
            required
            maxLength={modal === 'open' ? 2000 : 300}
            value={formName}
            onChange={e => setFormName(e.target.value)}
          />
        </label>
      )}

      {modal === 'open' && (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void action(async () => {
              const selectedPath = await api.invoke<string | null>('pick_project_path');
              if (selectedPath) setFormName(selectedPath);
            })
          }
        >
          选择文件夹…
        </button>
      )}

      {['feature', 'scenario', 'revise', 'build'].includes(modal) && (
        <label>
          {questionLabel}
          <textarea
            aria-label={questionLabel}
            required={modal === 'scenario' || modal === 'revise'}
            maxLength={20000}
            value={formQuestion}
            onChange={e => setFormQuestion(e.target.value)}
            rows={5}
          />
        </label>
      )}

      {modal !== 'open' && (
        <p className="muted">
          {modal === 'revise' ? '修改问题会建立新修订，旧运行保持原问题和来源。' : '添加功能与场景只保存理解入口，不修改工程源码。'}
        </p>
      )}

      <div className="row end">
        <button type="button" disabled={pending} onClick={onCancel}>
          取消
        </button>
        {modal === 'open' && (
          <button type="button" disabled={pending} onClick={e => void onSubmit(e, false)}>
            仅打开
          </button>
        )}
        <button className="primary" type="submit" value="analyze" disabled={pending}>
          {pending ? '处理中…' : modal === 'open' ? '打开并分析' : '保存'}
        </button>
      </div>
    </form>
  );
}
