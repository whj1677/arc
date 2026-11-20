import type { AnalysisResult } from '../shared';

type Component = AnalysisResult['nodes'][number];

export function objectEvidence(object: Pick<Component, 'evidence_ids'>, result: AnalysisResult) {
  const ids = new Set(object.evidence_ids);
  return result.evidence.filter(e => ids.has(e.evidence_id) && e.source_snapshot_id === result.binding.source_snapshot_id);
}

function directory(file: string) {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '' : file.slice(0, slash);
}

export function componentContext(component: Component, result: AnalysisResult) {
  const evidence = objectEvidence(component, result);
  const files = [...new Set(evidence.map(e => e.path))];
  const directories = new Set(files.map(directory).filter(Boolean));
  // Root-level files only match the same file. A shared repository root says nothing about a feature.
  const relatedIds = new Set(result.evidence.filter(e => e.source_snapshot_id === result.binding.source_snapshot_id
    && (files.includes(e.path) || directories.has(directory(e.path)))).map(e => e.evidence_id));
  const catalog = result.feature_catalog;
  const catalogIds = new Set(catalog?.groups.flatMap(group => group.node_ids));
  const relatedReadings = catalog?.readings?.filter(reading =>
    reading.steps.some(step => step.evidence_ids.some(id => relatedIds.has(id))));
  const readingIds = new Set(relatedReadings?.map(reading => reading.node_id));
  const features = result.nodes.filter(n => catalogIds.has(n.node_id) && n.node_id !== component.node_id &&
    (readingIds.has(n.node_id) || n.evidence_ids.some(id => relatedIds.has(id))));
  return { evidence, files, features, children: result.nodes.filter(n => n.parent_node_id === component.node_id) };
}
