import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FileSummary} from '../src/ui/FileSummary';
import {FileMap} from '../src/ui/FileMap';
import {analyzedSourcePaths,fileIndex,filePurpose} from '../src/ui/file-map';
import type {AnalysisResult,Explanation,Snapshot,SourceFile,WorkspaceData} from '../src/shared';

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
 assert.deepEqual(Object.fromEntries(analyzed),{'src/read.ts':'referenced','src/summarized.ts':'explained','src':'explained','docs':'explained','missing.ts':'referenced','src/internal/history.ts':'referenced'});
 const files=['src/read.ts','src/summarized.ts','src/latest.ts','src/internal/history.ts','docs/guide.md'].map(path=>({path})) as SourceFile[];
 const {root,index}=fileIndex(files,analyzed);
 assert.equal(root.analyzedCount,3);
 assert.equal(index.get('src')?.analyzedCount,3);
 assert.equal(index.get('src')?.count,4);
 assert.equal(index.get('src/internal')?.analyzedCount,1);
 assert.equal(index.get('src/read.ts')?.analyzedCount,1);
 assert.equal(index.get('docs')?.analyzedCount,0);
 assert.deepEqual(Object.fromEntries(analyzedSourcePaths(explanations,'project','latest',active)),{'src/latest.ts':'referenced'});
});

test('directory tree and detail distinguish a scoped summary, a citation and an unreferenced file',()=>{
 const snapshot={source_snapshot_id:'s',files:['src/tasks.c','src/task.c','src/include.h','src2/tasks.c'].map(path=>({path}))} as Snapshot;
 const cite=(id:string,path:string,snapshot='s')=>({evidence_id:id,path,source_snapshot_id:snapshot,line_start:21,line_end:25,note:'调度器读取就绪队列'});
 const data={projects:[],scenarios:[{scenario_id:'walk',title:'任务就绪流程'}],features:[],explanations:[
  {result_id:'a',scenario_id:'walk',created_at:'1',result:{
   binding:{project_id:'p',source_snapshot_id:'s'},evidence:[cite('first','src/tasks.c'),cite('outside','src2/tasks.c'),cite('wrong-snapshot','src/tasks.c','old')],
   nodes:[{description:'完整的任务说明',source_scope:{kind:'file',path:'src/task.c'},inputs:[],outputs:[],claim_ids:[],evidence_ids:[]}],claims:[]}},
  {result_id:'b',scenario_id:'walk',created_at:'2',result:{binding:{project_id:'p',source_snapshot_id:'s'},evidence:[cite('second','src/task.c')],nodes:[]}},
  {result_id:'old',scenario_id:'walk',created_at:'0',result:{binding:{project_id:'p',source_snapshot_id:'old'},evidence:[cite('old','src/tasks.c')],nodes:[]}},
 ]} as unknown as WorkspaceData;
 const analyzedPaths=analyzedSourcePaths(data.explanations,'p','s');
 const noop=()=>{};
 const tree=renderToStaticMarkup(createElement(FileMap,{files:snapshot.files,analyzedPaths,title:'目录',expanded:['src'],selected:'',select:noop,toggle:noop,zoom:1,search:''}));
 assert.match(tree,/tasks\.c<\/strong><span class="filemap-badge">已引用/);
 assert.match(tree,/task\.c<\/strong><span class="filemap-badge">已解释/);
 assert.match(tree,/已涉及（3）/);
 const details=(path:string)=>renderToStaticMarkup(createElement(FileSummary,{data,projectId:'p',snapshot,path,ask:noop}));
 const cited=details('src/tasks.c');
 for(const text of ['已在以下分析中引用（1 处）','任务就绪流程','src/tasks.c:21–25','调度器读取就绪队列','生成整文件摘要']) assert.ok(cited.includes(text),text);
 assert.doesNotMatch(cited,/用途尚未分析/);
 assert.match(details('src'),/已在以下分析中引用（2 处）/);
 assert.match(details('src/task.c'),/完整的任务说明/);
 assert.match(details('src/include.h'),/用途尚未分析/);
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
