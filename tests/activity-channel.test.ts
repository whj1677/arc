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
test('independent overview review remains visibly unfinished and keeps both phase messages',()=>{
  const events=[{type:'item.completed',item:{id:'0',type:'agent_message',text:'入口已查证'}},{type:'local.stage',stage:'overview_review',message:'开始核对关系'},
    {type:'item.completed',phase:'overview_review',item:{id:'0',type:'agent_message',text:'正在核对 IPC'}}];
  const value=activity(run,events,time);assert.match(value.phase,/核对首轮关系.*尚未发布/);assert.equal(value.items.filter(item=>item.kind==='message').length,2);
  assert.equal(activity({...run,status:'failed'},events,time).phase,'分析失败');
});
test('automatic relation research and recheck display actual phases without claiming a saved result',()=>{
  const events=[{type:'local.stage',stage:'overview_review',message:'初审发现两条关系缺少依据'},
    {type:'local.stage',stage:'overview_research',message:'只补查被拒关系'},
    {type:'item.completed',phase:'overview_research',item:{id:'0',type:'agent_message',text:'继续读取接收端'}}];
  assert.match(activity(run,events,time).phase,/自动补查.*原阅读位置保留/);
  assert.equal(activity(run,[...events,retry],time).phase,'连接中断，Agent 正在重连','a research phase must not hide a network failure');
  events.push({type:'local.stage',stage:'overview_recheck',message:'复核修订后的关系'});
  assert.match(activity(run,events,time).phase,/复核补查.*尚未保存/);
  events.push({type:'local.stage',stage:'overview_reviewed',message:'最终复核已完成'});
  assert.match(activity(run,events,time).phase,/等待本地校验和保存/);
  assert.equal(activity({...run,status:'cancel_requested'},events,time).phase,'正在请求停止');
  assert.equal(activity({...run,status:'completed'},events,time).phase,'分析完成，说明已保存');
});
