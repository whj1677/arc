import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzedSourcePaths,fileIndex,filePurpose} from '../src/ui/file-map';
import type {AnalysisResult,Explanation,SourceFile,WorkspaceData} from '../src/shared';

test('source folders and code files sort ahead of hidden entries and repository metadata at each level',()=>{
 const files=['.github/workflow.yml','.editorconfig','ref.url','LICENSE','LICENSE.md','cspell.config.yaml','main.ts','src/main.ts','src/internal/read.ts','src/.config','src/LICENSE.md'].map(path=>({path})) as SourceFile[];
 const {root,index}=fileIndex(files);
 assert.deepEqual(root.children.map(n=>n.name),['src','main.ts','.github','.editorconfig','cspell.config.yaml','LICENSE','LICENSE.md','ref.url']);
 assert.deepEqual(index.get('src')?.children.map(n=>n.name),['internal','main.ts','.config','LICENSE.md']);
});

test('analyzed source paths stay bound to the displayed snapshot and folder counts include only indexed files',()=>{
 const result=(projectId:string,snapshotId:string,paths:string[],scopes:string[]=[])=>({
  binding:{project_id:projectId,source_snapshot_id:snapshotId},
  evidence:paths.map(path=>({path,source_snapshot_id:snapshotId})),
  nodes:scopes.map(path=>({source_scope:{path}})),
 }) as unknown as AnalysisResult;
 const saved=result('project','frozen',['src/read.ts','src/read.ts','missing.ts'],['src/summarized.ts','src','docs']);
 const explanations=[
  {result:saved},
  {result:result('other','frozen',['docs/guide.md'])},
  {result:result('project','latest',['src/latest.ts'])},
 ] as Explanation[];
 const active=result('project','frozen',['src/internal/history.ts']);
 const analyzed=analyzedSourcePaths(explanations,'project','frozen',active);
 assert.deepEqual(analyzed,new Set(['src/read.ts','src/summarized.ts','src','docs','missing.ts','src/internal/history.ts']));
 const files=['src/read.ts','src/summarized.ts','src/latest.ts','src/internal/history.ts','docs/guide.md'].map(path=>({path})) as SourceFile[];
 const {root,index}=fileIndex(files,analyzed);
 assert.equal(root.analyzedCount,3);
 assert.equal(index.get('src')?.analyzedCount,3);
 assert.equal(index.get('src')?.count,4);
 assert.equal(index.get('src/internal')?.analyzedCount,1);
 assert.equal(index.get('src/read.ts')?.analyzedCount,1);
 assert.equal(index.get('docs')?.analyzedCount,0);
 assert.deepEqual(analyzedSourcePaths(explanations,'project','latest',active),new Set(['src/latest.ts']));
});
test('file mind map indexes actual folders and counts; purposes cannot leak from another snapshot or a partial citation',()=>{
 const files=['app/backend/server.py','app/backend/store.py','app/frontend/app.js','README.md'].map(path=>({path})) as SourceFile[];
 const {root,index}=fileIndex(files);assert.equal(root.count,4);assert.equal(index.get('app')?.count,3);assert.equal(index.get('app/backend')?.count,2);assert.equal(index.get('app/backend/server.py')?.folder,false);
 const explanation=(id:string,snapshot:string,nodes:unknown[],time:string)=>({result_id:id,created_at:time,result:{binding:{project_id:'project',source_snapshot_id:snapshot},nodes}});
 const note={node_id:'whole',source_scope:{kind:'file',path:'app/backend/server.py'}};
 const data={explanations:[explanation('partial','source', [{node_id:'partial',evidence_ids:['server-code']}],'2026-10-01'),explanation('valid','source',[note],'2026-10-02'),explanation('other-source','new-source',[note],'2026-10-03')]} as unknown as WorkspaceData;
 assert.equal(filePurpose(data,'project','source','app/backend/server.py',false)?.explanation.result_id,'valid');
 assert.equal(filePurpose(data,'project','source','app/backend',true),undefined);assert.equal(filePurpose(data,'other-project','source','app/backend/server.py',false),undefined);
 assert.equal(filePurpose(data,'project','source','app/backend/store.py',false),undefined);
});
