import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileIndex,filePurpose} from '../src/ui/file-map';
import type {SourceFile,WorkspaceData} from '../src/shared';
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
