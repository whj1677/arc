import React from 'react';
import type { Feature, Project, ReadingState, WorkspaceData } from '../shared';
import { compactTitle, sceneStatus } from './presentation';
import { ScrollPanel } from './workbench-primitives';

const api = window.arc;

export interface CatalogSidebarProps {
  data: WorkspaceData;
  project?: Project;
  projectId: string;
  scenarioId: string;
  reading: ReadingState;
  loadedKey: string;
  catalogReading: boolean;
  preview: unknown;
  featureTabs?: readonly (readonly [string, string])[] | string[][];
  primaryViews: readonly (readonly [string, string])[] | string[][];
  extraViews: readonly (readonly [string, string])[] | string[][];
  archiveVisible: boolean;
  setArchiveVisible: (visible: boolean) => void;
  featureOpen: (featureId: string) => boolean;
  toggleFeature: (featureId: string) => void;
  navigateView: (view: string) => void;
  setEntrance: (entrance: 'overview' | 'walk') => void;
  chooseScenario: (scenarioId: string) => void;
  onHide: () => void;
  onOpenFeatureModal: () => void;
  onRenameFeature: (feature: Feature) => void;
  savePosition: (name: string, top: number, left: number) => void;
  action: <T>(fn: () => Promise<T>, message?: string) => Promise<T | undefined>;
}

export function CatalogSidebar({
  data,
  project,
  projectId,
  scenarioId,
  reading,
  loadedKey,
  catalogReading,
  preview,
  featureTabs,
  primaryViews,
  extraViews,
  archiveVisible,
  setArchiveVisible,
  featureOpen,
  toggleFeature,
  navigateView,
  setEntrance,
  chooseScenario,
  onHide,
  onOpenFeatureModal,
  onRenameFeature,
  savePosition,
  action,
}: CatalogSidebarProps) {
  const viewButton = ([v, label]: readonly string[]) => (
    <button
      key={v}
      className={`nav-view ${reading.view === v ? 'selected' : ''}`}
      aria-current={reading.view === v ? 'page' : undefined}
      onClick={() => navigateView(v)}
    >
      {label}
    </button>
  );

  const visibleFeatures = data.features
    .filter(
      f =>
        f.project_id === projectId &&
        (archiveVisible || !f.archived) &&
        data.scenarios.some(s => s.feature_id === f.feature_id && s.scenario_id !== project?.overview_scenario_id),
    )
    .sort((a, b) => a.sort_order - b.sort_order);

  return (
    <aside id="workspace-navigation" className="catalog" aria-label="工作区导航">
      <div className="pane-heading">
        <span>{reading.entrance === 'overview' ? '深入阅读' : '功能与场景'}</span>
        <button className="icon" aria-label="收起目录" title="隐藏导航" onClick={onHide}>
          <svg className="arc-ui-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 3.5 5.5 8 10 12.5" />
          </svg>
        </button>
      </div>
      <ScrollPanel positions={reading.scroll} restoreKey={loadedKey} onPosition={savePosition} name="catalog">
        {reading.entrance === 'overview' && (
          <nav className="catalog-views" aria-label="工程页面">
            {[...primaryViews, ...extraViews].map(viewButton)}
          </nav>
        )}
        {reading.entrance === 'walk' && (
          <>
            <button className={`catalog-home ${catalogReading ? 'selected' : ''}`} onClick={() => setEntrance('walk')}>
              功能总览
            </button>
            {!catalogReading && !preview && !featureTabs && (
              <nav className="catalog-views" aria-label="当前功能视图">
                <span className="catalog-label">当前功能视图</span>
                {[...primaryViews, ...extraViews].map(viewButton)}
              </nav>
            )}
            <span className="catalog-label">已展开的功能与场景</span>
            {visibleFeatures.map(feature => (
              <div key={feature.feature_id} className="feature-group">
                <div className="feature-label">
                  <button className="feature-toggle" aria-expanded={featureOpen(feature.feature_id)} onClick={() => toggleFeature(feature.feature_id)}>
                    <span aria-hidden="true">{featureOpen(feature.feature_id) ? '⌄' : '›'}</span>
                    <strong title={feature.name}>{compactTitle(feature.name, 24)}</strong>
                  </button>
                  <details className="feature-menu">
                    <summary aria-label={`管理功能 ${feature.name}`}>⋯</summary>
                    <div className="feature-actions">
                      <button className="icon" aria-label={`重命名功能 ${feature.name}`} onClick={() => onRenameFeature(feature)}>
                        ✎
                      </button>
                      <button
                        className="icon"
                        aria-label={`将功能置前 ${feature.name}`}
                        onClick={() =>
                          void action(() =>
                            api.invoke('organize', {
                              kind: 'feature',
                              id: feature.feature_id,
                              patch: { sort_order: Math.min(0, ...data.features.filter(f => f.project_id === projectId).map(f => f.sort_order)) - 1 },
                            }),
                          )
                        }
                      >
                        ↑
                      </button>
                      <button
                        className="icon"
                        aria-label={`${feature.archived ? '恢复' : '归档'}功能 ${feature.name}`}
                        onClick={() =>
                          void action(() => api.invoke('organize', { kind: 'feature', id: feature.feature_id, patch: { archived: !feature.archived } }))
                        }
                      >
                        {feature.archived ? '↶' : '−'}
                      </button>
                    </div>
                  </details>
                </div>
                <div className="feature-scenes" hidden={!featureOpen(feature.feature_id)}>
                  {data.scenarios
                    .filter(s => s.feature_id === feature.feature_id && s.scenario_id !== project?.overview_scenario_id && (archiveVisible || !s.archived))
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map(s => (
                      <button
                        key={s.scenario_id}
                        className={`scene-row ${scenarioId === s.scenario_id ? 'selected' : ''}`}
                        aria-label={s.title}
                        aria-current={scenarioId === s.scenario_id ? 'page' : undefined}
                        onClick={() => chooseScenario(s.scenario_id)}
                      >
                        <span title={s.title}>{s.kind === 'feature_overview' ? '整体走读' : compactTitle(s.title)}</span>
                        <small className="scene-status">
                          {s.kind === 'feature_overview' ? '整体走读' : '场景'} ·{' '}
                          {s.archived || feature.archived
                            ? '已归档'
                            : sceneStatus(
                                data.runs.filter(r => !r.reading_question_id && r.binding.scenario_id === s.scenario_id),
                                data.explanations.some(e => e.scenario_id === s.scenario_id),
                              )}
                        </small>
                      </button>
                    ))}
                </div>
              </div>
            ))}
            <div className="catalog-management">
              <button className="quiet full" onClick={onOpenFeatureModal}>
                ＋ 添加功能
              </button>
              <button className="quiet full" onClick={() => setArchiveVisible(!archiveVisible)}>
                {archiveVisible ? '隐藏归档' : '查看归档'}
              </button>
            </div>
          </>
        )}
      </ScrollPanel>
    </aside>
  );
}
