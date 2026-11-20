import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DevelopmentAttempt,EngineeringTask} from '../src/engineering';

const require=createRequire(import.meta.url);
require.extensions['.css']=()=>{};
const {DevelopmentActivity,PlanDecision,taskDetailStage}=require('../src/ui/DevelopmentActivity.tsx') as typeof import('../src/ui/DevelopmentActivity');

const ready={
  task_id:'plan',version:2,status:'pending',workflow:'ready',scope:[],attempt_ids:['analysis-attempt'],
  goal:'审阅修改方案',summary:'只读分析完成',decisions:[],unresolved:[],changes:[],verification:[],verification_status:'not_run',
  proposed_scope:['tasks.c','list.c','include/FreeRTOS.h'],requirement_package:{behaviors:[]},
} as unknown as EngineeringTask;

test('analysis and ready plans stay out of the delivery stage even with earlier attempts',()=>{
  assert.equal(taskDetailStage({...ready,workflow:'analysis'}),'analysis');
  assert.equal(taskDetailStage({...ready,workflow:'analysis',status:'running'}),'analysis');
  assert.equal(taskDetailStage(ready),'approval');
  assert.equal(taskDetailStage({...ready,workflow:'execution'}),'delivery');
  assert.equal(taskDetailStage({...ready,workflow:undefined,status:'blocked'}),'delivery');
});

test('ready plan presents the full file list, revision and approval controls inline',()=>{
  const html=renderToStaticMarkup(React.createElement(PlanDecision,{task:ready,busy:false,error:'',onDecision(){}}));
  assert.doesNotMatch(html,/<dialog\b/);
  assert.match(html,/审阅待确认方案/);
  assert.match(html,/title="include\/FreeRTOS\.h">FreeRTOS\.h</);
  assert.match(html,/修订意见/);
  assert.match(html,/退回补充/);
  assert.match(html,/<button class="primary">按此方案执行/);
});

test('failed attempt stays in history after a verified but blocked task is backfilled',()=>{
  const task:EngineeringTask={...ready,workflow:'execution',status:'blocked',verification_status:'passed',unresolved:['补充移植说明']};
  const attempt={status:'failed',error:'earlier failure'} as DevelopmentAttempt;
  const html=renderToStaticMarkup(React.createElement(DevelopmentActivity,{task,attempt,events:[],onSettings(){}}));
  assert.match(html,/执行动态/);
  assert.doesNotMatch(html,/执行失败|earlier failure/);
});
