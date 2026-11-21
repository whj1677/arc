import React from 'react';
import type { WorkspaceData } from '../shared';
import { sceneStatus } from './presentation';

export function WalkNavigator({ data, projectId, title, selected, choose, zoom }: {
  data: WorkspaceData;
  projectId: string;
  title: string;
  selected: string;
  choose: (id: string) => void;
  zoom: number;
}) {
  const project = data.projects.find(p => p.project_id === projectId);
  const scenes = data.scenarios.filter(s => s.project_id === projectId && !s.archived && s.scenario_id !== project?.overview_scenario_id);
  const features = data.features.filter(f => f.project_id === projectId && !f.archived && scenes.some(s => s.feature_id === f.feature_id))
    .sort((a, b) => a.sort_order - b.sort_order);

  return <section className="walk-navigator" style={{ fontSize: 16 * zoom }} data-zoom-surface aria-label="功能场景导航导图">
    <header data-zoom-anchor><h2>{title} · 功能场景</h2><p>选择功能查看整体流程，或展开走读入口查看具体场景。</p></header>
    <div className="walk-nav-features">
      {features.map(feature => {
        const entries = scenes.filter(s => s.feature_id === feature.feature_id).sort((a, b) => a.sort_order - b.sort_order);
        const overall = entries.find(s => s.kind === 'feature_overview') || entries[0];
        return <article className="walk-nav-feature" key={feature.feature_id}>
          <button className="walk-nav-topic" data-feature-id={feature.feature_id} data-zoom-anchor onClick={() => choose(overall.scenario_id)}>
            <strong>{feature.name}</strong><small>整体流程</small>
          </button>
          <details open={entries.some(s => s.scenario_id === selected) || undefined}>
            <summary>{entries.length} 个走读入口</summary>
            {entries.map(scene => <button key={scene.scenario_id} className="walk-nav-scene" aria-pressed={selected === scene.scenario_id}
              data-scenario-id={scene.scenario_id} data-zoom-anchor onClick={() => choose(scene.scenario_id)}>
              <strong>{scene.kind === 'feature_overview' ? '整体流程' : scene.title}</strong>
              <small>{sceneStatus(data.runs.filter(r => r.binding.scenario_id === scene.scenario_id), data.explanations.some(e => e.scenario_id === scene.scenario_id))}</small>
            </button>)}
          </details>
        </article>;
      })}
      {!features.length && <p className="muted">还没有功能。先添加一个功能，再提出要理解的问题。</p>}
    </div>
  </section>;
}
