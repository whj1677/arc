import { discoveredFeature } from '../discovered-feature';
import { hasFunctionGraphs, type AnalysisResult, type Feature, type Project, type Scenario } from '../shared';
import type { Store } from './store';

function tokens(text: string): Set<string> {
  const words = new Set<string>();
  for (const [word] of text.matchAll(/[a-z][a-z0-9_]*|\p{Script=Han}+/giu)) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      for (let i = 1; i < chars.length; i++) words.add(chars[i - 1] + chars[i]);
    } else {
      words.add(word.toLowerCase());
      for (const part of word.replace(/([a-z\d])([A-Z])/g, '$1 $2').split(/[_ ]+/)) {
        if (part.length > 1) words.add(part.toLowerCase());
      }
    }
  }
  return words;
}

function compact(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : line.slice(0, limit - 1) + '…';
}

function callChain(result: AnalysisResult): string | undefined {
  const nodes = new Map(result.nodes.map(n => [n.node_id, n]));
  const evidence = new Map(result.evidence.map(e => [e.evidence_id, e]));
  for (const walk of result.function_walkthroughs ?? []) {
    const chain = [walk.entry_node_id];
    for (const step of walk.steps) {
      if (step.kind === 'return') break;
      if (!['call', 'callback', 'dispatch'].includes(step.kind)) continue;
      // Sibling calls in a walkthrough are not a caller-callee chain.
      if (step.from_node_id !== chain.at(-1)) break;
      const kind = step.kind === 'call' ? 'sync_call' : 'execution_boundary';
      if (!result.edges.some(e => e.kind === kind && e.status === 'source_supported' &&
        e.source_node_id === step.from_node_id && e.target_node_id === step.to_node_id)) break;
      chain.push(step.to_node_id);
      if (chain.length === 4) break;
    }
    if (chain.length < 2) continue;
    const functions = chain.map(id => nodes.get(id)!);
    const files = functions.flatMap(fn => fn.evidence_ids.map(id => evidence.get(id)!.path));
    return functions.map(fn => fn.function_details?.symbol ?? fn.label).join(' -> ') +
      ' (' + [...new Set(files)].slice(0, 3).join(', ') + ')';
  }
}

export function buildDevelopmentKnowledgeBrief(store: Store, projectId: string, queryText: string, scopeFiles: readonly string[] = []): string {
  const project = store.get<Project>('project', projectId);
  const explanations = store.developmentExplanations(project).filter(e => !e.result.fictional);
  const overview = explanations.find(e => e.scenario_id === project.overview_scenario_id && e.result.feature_catalog)?.result;
  if (!overview?.feature_catalog) return '';
  const { groups } = overview.feature_catalog;
  const nodes = new Map(overview.nodes.map(n => [n.node_id, n]));
  const evidence = new Map(overview.evidence.map(e => [e.evidence_id, e]));
  const files = new Set(scopeFiles.map(file => file.replaceAll('\\', '/')));
  const query = tokens(queryText);
  for (const token of tokens([...files].map(file => file.replace(/\.[^./]+$/, '')).join(' '))) {
    if (!['src', 'lib', 'main', 'test', 'tests'].includes(token)) query.add(token);
  }
  const scoreText = (text: string) => [...tokens(text)].filter(word => query.has(word)).length;
  const features = groups.flatMap(group => group.node_ids.map(id => {
    const node = nodes.get(id)!;
    const refs = node.evidence_ids.map(id => evidence.get(id)!);
    const paths = refs.map(e => e.path);
    if (node.source_scope) paths.push(node.source_scope.path);
    const score = (paths.some(file => files.has(file)) ? 20 : 0) + 4 * scoreText(node.label) +
      2 * scoreText(paths.join(' ')) + scoreText(group.label + ' ' + node.description);
    return {node, group: group.label, refs, paths, score};
  })).filter(f => f.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);

  const lines = ['子系统：' + compact(groups.map(g => g.label + '(' + g.node_ids.length + ')').join('、'), 300)];
  const matchedNodes = new Set<string>();
  for (const {node, group, refs, paths} of features) {
    matchedNodes.add(node.node_id);
    if (node.parent_node_id) matchedNodes.add(node.parent_node_id);
    for (const path of paths) files.add(path);
    const anchors = [...new Set(refs.map(ref => ref.path + ':' + ref.line_start))].slice(0, 3);
    lines.push('功能：' + compact(group + ' / ' + node.label, 70) + ' — ' + compact(node.description, 115) +
      (anchors.length ? ' [' + compact(anchors.join(', '), 150) + ']' : ''));
  }

  const architecture = new Set(overview.architecture?.edge_ids);
  const relations = overview.edges.filter(edge => architecture.has(edge.edge_id)).map(edge => {
    const endpoints = [nodes.get(edge.source_node_id)!, nodes.get(edge.target_node_id)!];
    const refs = [...edge.evidence_ids, ...endpoints.flatMap(n => n.evidence_ids)];
    const score = (endpoints.some(n => matchedNodes.has(n.node_id)) ? 20 : 0) +
      (refs.some(id => files.has(evidence.get(id)!.path)) ? 10 : 0) +
      scoreText([edge.label, ...endpoints.map(n => n.label), ...refs.map(id => evidence.get(id)!.path)].join(' '));
    return {score, text: endpoints[0].label + ' -> ' + endpoints[1].label + ': ' + edge.label};
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  for (const relation of relations) lines.push('架构：' + compact(relation.text, 140));

  if (features.length) {
    const savedFeatures = store.all<Feature>('feature');
    const scenes = store.all<Scenario>('scenario');
    let count = 0;
    for (const {node} of features) {
      const feature = discoveredFeature(savedFeatures, explanations, overview, node.node_id, project.snapshot_id);
      if (!feature || feature.archived) continue;
      const scene = scenes.find(s => s.feature_id === feature.feature_id && s.kind === 'feature_overview' && !s.archived);
      if (!scene) continue;
      const graph = explanations.find(e => e.scenario_id === scene.scenario_id && e.source_status === 'current' &&
        e.result.binding.feature_id === feature.feature_id && e.result.binding.question_revision_id === scene.question_revision_id &&
        e.result.binding.source_snapshot_id === project.snapshot_id && hasFunctionGraphs(e.result));
      const chain = graph && callChain(graph.result);
      if (chain) {
        lines.push('调用：' + compact(node.label + ' — ' + chain, 310));
        if (++count === 2) break;
      }
    }
  }
  return lines.join('\n').slice(0, 4000);
}
