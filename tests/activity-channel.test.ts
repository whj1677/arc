import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Run} from '../src/shared';
import {activity,runChannel} from '../src/ui/activity';
import {analysisErrorMessage} from '../src/ui/AnalysisError';

const run={provider_id:'codex',status:'running',created_at:'2026-10-22T00:00:00Z',external_id:'cli-thread'} as Run;
const time=Date.parse(run.created_at)+60000;
const retry={type:'error',message:'Reconnecting... 2/5 (request timed out)'};
test('a CLI thread ID does not establish a visible desktop conversation',()=>{
  assert.match(runChannel(run),/Codex 在 ARC 内分析/);
  assert.match(runChannel(run),/独立只读任务/);
  assert.doesNotMatch(runChannel(run),/同一对话|续接|同步/);
  assert.match(runChannel({...run,origin:'mcp'}),/通过 MCP 接入/);
  assert.doesNotMatch(runChannel({...run,origin:'manual_import'}),/对话/);
});
test('reconnect overrides processing even when the provider allocated a thread',()=>{
  const value=activity(run,[{type:'thread.started'},retry],time);
  assert.equal(value.reconnecting,true);
  assert.equal(value.phase,'连接中断，Agent 正在重连');
  assert.equal(value.files.length,0);
  assert.equal(value.output,false);
});
test('local events and reasoning do not prove the connection recovered',()=>{
  const value=activity(run,[retry,{type:'local.stage',message:'local update'},
    {type:'item.completed',item:{type:'reasoning',text:'private'}}],time);
  assert.equal(value.reconnecting,true);
  assert.ok(!JSON.stringify(value).includes('private'));
});
test('a real public message recovers the phase; terminal failure still wins',()=>{
  const events=[retry,{type:'item.completed',item:{id:'public',type:'agent_message',text:'现在开始读取入口。'}}];
  assert.equal(activity(run,events,time).reconnecting,false);
  assert.equal(activity({...run,status:'failed'},[retry],time).phase,'分析失败');
  assert.equal(activity({...run,status:'failed'},[retry],time).reconnecting,false);
});
test('timeouts have a readable outcome without implying a saved result',()=>{
  assert.match(analysisErrorMessage('codex 未成功完成（exit=1）：超过 600 秒执行预算，正在终止本地任务'),/未得到可保存的完整结果/);
  assert.match(analysisErrorMessage('request timed out'),/本次分析未完成/);
});
