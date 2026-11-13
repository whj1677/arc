import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AnalysisResult,ReadingState,Snapshot} from '../src/shared';
import {readingQuestionTarget} from '../src/ui/reading-target';

test('unexplained files and directories retain exact scope; root asks about the whole project',()=>{
  const snapshot={files:[{path:'src/main.ts'}]} as Snapshot;
  const reading={view:'files',selected:'',file:'src/main.ts'} as ReadingState;
  assert.deepEqual(readingQuestionTarget(undefined,reading,'project',snapshot).target,{kind:'file',id:'src/main.ts'});
  assert.deepEqual(readingQuestionTarget(undefined,{...reading,file:'src'},'project',snapshot).target,{kind:'directory',id:'src'});
  assert.deepEqual(readingQuestionTarget(undefined,{...reading,file:''},'project',snapshot).target,{kind:'feature',id:'project'});
});

test('business steps and repeated function calls preserve their own context rather than the common callee',()=>{
  const result={nodes:[{node_id:'save',label:'保存'}],edges:[],reading_guide:{steps:[{id:'save-step',title:'提交保存',node_ids:['save']}],roles:[],handoffs:[]},function_walkthroughs:[{id:'path',steps:[{id:'first',to_node_id:'save',text:'首次保存'},{id:'retry',to_node_id:'save',text:'失败后重试'}]}]} as unknown as AnalysisResult;
  const reading={view:'timeline',selected:'step:save-step'} as ReadingState;
  assert.deepEqual(readingQuestionTarget(result,reading,'feature',undefined).target,{kind:'step',id:'save-step'});
  for(const id of ['first','retry'])assert.deepEqual(readingQuestionTarget(result,{...reading,view:'functions',selected:`call-step:path:${id}`},'feature',undefined).target,{kind:'call_step',id:`call-step:path:${id}`});
});
