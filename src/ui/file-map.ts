import type { AnalysisResult, Explanation, SourceFile, WorkspaceData } from '../shared';

export interface FileTopic {
  path: string;
  name: string;
  folder: boolean;
  children: FileTopic[];
  count: number;
  analyzedCount: number;
}

function isRepoMeta({ name, folder }: FileTopic) {
  return name.startsWith('.') || (!folder && /^(?:license(?:\.md)?|cspell\.config\.yaml|.*\.url)$/i.test(name));
}

export function fileIndex(files: readonly SourceFile[], analyzedPaths: ReadonlySet<string> = new Set()) {
  const root: FileTopic = { path: '', name: '工程根目录', folder: true, children: [], count: 0, analyzedCount: 0 };
  const index = new Map<string, FileTopic>([['', root]]);

  for (const file of files) {
    const parts = file.path.split('/');
    const analyzed = Number(analyzedPaths.has(file.path));
    let parent = root;
    root.count++;
    root.analyzedCount += analyzed;
    for (const [i, name] of parts.entries()) {
      const path = parts.slice(0, i + 1).join('/');
      let topic = index.get(path);
      if (!topic) {
        topic = { path, name, folder: i < parts.length - 1, children: [], count: 0, analyzedCount: 0 };
        index.set(path, topic);
        parent.children.push(topic);
      }
      if (topic.folder) topic.count++;
      topic.analyzedCount += analyzed;
      parent = topic;
    }
  }

  for (const topic of index.values()) {
    topic.children.sort((a, b) => Number(isRepoMeta(a)) - Number(isRepoMeta(b)) || Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
  }
  return { root, index };
}

export function analyzedSourcePaths(
  explanations: readonly Explanation[],
  projectId: string,
  snapshotId: string | undefined,
  activeResult?: AnalysisResult,
): ReadonlySet<string> {
  const paths = new Set<string>();
  if (!snapshotId) return paths;
  const results = explanations.map(explanation => explanation.result);
  if (activeResult && !results.includes(activeResult)) results.push(activeResult);

  for (const result of results) {
    if (result.binding.project_id !== projectId || result.binding.source_snapshot_id !== snapshotId) continue;
    for (const evidence of result.evidence) {
      if (evidence.source_snapshot_id === snapshotId) paths.add(evidence.path);
    }
    for (const node of result.nodes) {
      if (node.source_scope) paths.add(node.source_scope.path);
    }
  }
  return paths;
}
export function filePurpose(data:WorkspaceData,projectId:string,snapshotId:string,path:string,folder:boolean){
 return data.explanations.filter(e=>e.result.binding.project_id===projectId&&e.result.binding.source_snapshot_id===snapshotId).toSorted((a,b)=>b.created_at.localeCompare(a.created_at)).flatMap(explanation=>explanation.result.nodes.filter(n=>n.source_scope?.kind===(folder?'folder':'file')&&n.source_scope.path===path).map(node=>({node,explanation}))).at(0);
}
