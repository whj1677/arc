import type { FunctionWalkthrough } from '../contracts/agent-adapter';
import type { AnalysisResult, ReadingGuide } from './shared';

const unique = (ids: readonly string[]) => [...new Set(ids)];
type Graph = Pick<AnalysisResult, 'nodes' | 'edges' | 'evidence'>;

export function savedReadingGuide(result?: AnalysisResult): ReadingGuide | undefined {
  const guide = result?.reading_guide;
  if (guide && /^feature-graph-[0-9a-f]{32}$/.test(result.result_id) && result.function_walkthroughs?.length
    && !guide.roles.length && !guide.handoffs.length && guide.files.every(f => f.title === f.path && !f.detail)
    && result.nodes.every(n => n.function_details)) {
    // Older compact graphs stored only step links and full paths. Project from that saved graph without rewriting it.
    return featureGraphReadingGuide(result, result.function_walkthroughs, guide.paths.map(p => p.intro));
  }
  return guide;
}

// Both new and saved compact graphs use the same frozen definitions and ordered steps.
export function featureGraphReadingGuide(graph: Graph, walks: readonly FunctionWalkthrough[], outcomes: readonly string[]): ReadingGuide {
  const evidencePath = new Map(graph.evidence.map(e => [e.evidence_id, e.path]));
  const nodes = new Map(graph.nodes.map(node => [node.node_id, node]));
  const functionFile = new Map(graph.nodes.map(node => [node.node_id, evidencePath.get(node.function_details!.definition_evidence_id)!]));
  const filePaths = unique(graph.evidence.map(e => e.path));
  const roleId = new Map(filePaths.map((path, index) => [path, `file.${index + 1}`]));
  const steps: ReadingGuide['steps'][number][] = [];
  const stepsByFile = new Map(filePaths.map(path => [path, new Set<string>()]));
  const handoffs: ReadingGuide['handoffs'][number][] = [];
  const paths = walks.map((walk, pathIndex) => {
    const files = new Set<string>(), roles = new Set<string>(), handoffIds: string[] = [];
    const stepIds = walk.steps.map((step, stepIndex) => {
      const actor = nodes.get(step.to_node_id);
      if (!actor) throw Error(`路径 ${walk.id} 步骤 ${step.id} 引用未知函数：${step.to_node_id}`);
      const nodeIds = unique(step.from_node_id ? [step.from_node_id, step.to_node_id] : [step.to_node_id]);
      const id = `reading.${pathIndex + 1}.${stepIndex + 1}`;
      steps.push({ id, title: step.text, actor: actor.label, text: step.input, outcome: step.output, detail: step.condition,
        node_ids: nodeIds, evidence_ids: step.evidence_ids });
      // Callsite evidence often cites only the caller. Include both confirmed definition files.
      const definitionFiles = nodeIds.map(n => functionFile.get(n));
      for (const path of definitionFiles) if (path) roles.add(roleId.get(path)!);
      for (const path of [...definitionFiles, ...step.evidence_ids.map(e => evidencePath.get(e))]) {
        if (path) { files.add(path); stepsByFile.get(path)!.add(id); }
      }
      if (step.from_node_id && ['call', 'callback', 'dispatch'].includes(step.kind)) {
        const from = functionFile.get(step.from_node_id), to = functionFile.get(step.to_node_id)!;
        const kind = step.kind === 'call' ? 'sync_call' : 'execution_boundary';
        const candidates = graph.edges.filter(e => e.source_node_id === step.from_node_id && e.target_node_id === step.to_node_id
          && e.kind === kind && e.status === 'source_supported');
        // Distinguish different callsites of the same function pair on separate branches.
        const sites = candidates.length === 1 ? candidates : candidates.filter(e => e.evidence_ids.some(ref => step.evidence_ids.includes(ref)));
        if (from && from !== to && sites.length) {
          const sourceRole = roleId.get(from)!, targetRole = roleId.get(to)!;
          handoffIds.push(id);
          handoffs.push({ id, from: sourceRole, to: targetRole, label: step.text, kind: step.kind === 'call' ? '同步调用' : step.kind === 'callback' ? '回调' : '分派',
            send: step.input, receive: step.output, detail: step.condition,
            evidence_ids: unique([...step.evidence_ids, ...sites.flatMap(e => e.evidence_ids)]) });
        }
      }
      return id;
    });
    return { id: walk.id, label: walk.label, entry: walk.trigger, intro: outcomes[pathIndex], boundary: walk.boundary,
      step_ids: stepIds, lanes: [], failure_ids: [], role_ids: [...roles], handoff_ids: handoffIds, files: [...files] };
  });
  const participating = new Set(paths.flatMap(p => p.role_ids));
  const roles: ReadingGuide['roles'][number][] = [];
  const files = filePaths.map(path => {
    const name = path.split('/').at(-1)!;
    const title = filePaths.some(other => other !== path && other.split('/').at(-1) === name) ? path : name;
    const defined = graph.nodes.filter(n => functionFile.get(n.node_id) === path);
    const linked = stepsByFile.get(path)!;
    const duties = unique(defined.map(n => n.description));
    const description = duties.length ? duties.join(' ')
      : unique(steps.filter(s => linked.has(s.id)).map(s => s.title)).join('；') || '本功能引用的源码依据';
    const evidenceIds = graph.evidence.filter(e => e.path === path).map(e => e.evidence_id);
    const id = roleId.get(path)!;
    if (participating.has(id)) roles.push({ id, title, duty: description, files: [path], evidence_ids: unique(defined.flatMap(n => n.evidence_ids)) });
    return { path, title, description, detail: defined.length ? '涉及函数：' + defined.map(n => n.function_details!.symbol).join('、') : '',
      step_ids: [...linked], evidence_ids: evidenceIds };
  });
  return { steps, paths, files, roles, handoffs };
}
