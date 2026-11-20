import type { Explanation } from './shared';

export type ExplanationFreshness =
  | { kind: 'current' }
  | { kind: 'affected'; files: string[] }
  | { kind: 'other_changed'; count: number };

const normalize = (path: string) => path.replaceAll('\\', '/');

export function explanationFreshness(
  explanation: Explanation,
  projectSnapshotId: string,
  changedFiles: readonly string[],
): ExplanationFreshness {
  const current = explanation.source_status === 'current';
  if (explanation.result.binding.source_snapshot_id === projectSnapshotId && current && !changedFiles.length) {
    return { kind: 'current' };
  }
  const changed = new Set(changedFiles.map(normalize));
  const files: string[] = [];
  for (const { path } of explanation.result.evidence) {
    if (changed.delete(normalize(path))) files.push(path);
  }
  if (files.length) return { kind: 'affected', files };
  if (changedFiles.length || !current) return { kind: 'other_changed', count: changedFiles.length };
  return { kind: 'current' };
}
