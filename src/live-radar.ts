import type { AstCallGraphDiff, TaskHudImpact, TaskHudStructureDiff } from './development-hud';

export type RadarMode = 'worktree' | 'commit';

export interface RadarCommit {
  sha: string;
  short_sha: string;
  subject: string;
  authored_at: string;
}

export interface RadarChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  staged?: boolean;
  unstaged?: boolean;
  binary?: boolean;
}

export interface LiveWorkspaceRadar {
  project_id: string;
  workspace_path: string;
  is_git: boolean;
  branch: string | null;
  head_sha: string | null;
  mode: RadarMode;
  base_ref: string;
  target_ref: string;
  fingerprint: string;
  computed_ms: number;
  cache_hit: boolean;
  recent_commits: RadarCommit[];
  changed_files: RadarChangedFile[];
  structure_diff?: TaskHudStructureDiff;
  ast_call_graph?: AstCallGraphDiff;
  impact: TaskHudImpact;
}

export interface LiveFileDiff {
  path: string;
  before: string;
  after: string;
  truncated: boolean;
  binary?: boolean;
}
