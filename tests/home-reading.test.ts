import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AnalysisResult,Explanation,Project,Scenario} from '../src/shared';
import {componentReading,contextSummary,savedBusinessPath} from '../src/ui/home-reading';

test('material summaries preserve source identifiers and inline code when removing Markdown',()=>{
  assert.equal(contextSummary({text:'# 构建\n**cmake_minimum_required** 使用 `FREERTOS_PORT` 和 `char *p`。'}),'构建 cmake_minimum_required 使用 FREERTOS_PORT 和 char *p。');
});

test('recommend a component with documented inputs and outputs ahead of the first listed component',()=>{
  const io={availability:'specified',evidence_ids:['cart']};
  const nodes=[{node_id:'entry',inputs:[],outputs:[],evidence_ids:['index']},{node_id:'total',inputs:[io],outputs:[io],evidence_ids:['cart']}];
  const result={nodes,edges:[],architecture:{node_ids:['entry','total'],edge_ids:[]},binding:{source_snapshot_id:'s'},evidence:['index','cart'].map(evidence_id=>({evidence_id,source_snapshot_id:'s'}))} as unknown as AnalysisResult;
  assert.equal(componentReading(result)?.node.node_id,'total');
  assert.equal(componentReading({...result,evidence:[]}),undefined);
  assert.equal(componentReading({...result,binding:{...result.binding,source_snapshot_id:'different'}}),undefined);
});

test('use only a saved business path with both endpoints grounded in the current question and snapshot',()=>{
  const project={project_id:'p',snapshot_id:'s'} as Project;
  const scene={scenario_id:'scene',project_id:'p',question_revision_id:'q'} as Scenario;
  const step={id:'begin',evidence_ids:['src']};
  const result={binding:{project_id:'p',source_snapshot_id:'s',question_revision_id:'q'},evidence:[{evidence_id:'src',source_snapshot_id:'s'}],reading_guide:{steps:[step],paths:[{entry:'submit',step_ids:['begin']}]}} as unknown as AnalysisResult;
  const saved={scenario_id:'scene',result} as Explanation;
  assert.equal(savedBusinessPath(project,[scene],[saved])?.first.id,'begin');
  assert.equal(savedBusinessPath({...project,snapshot_id:'next'},[scene],[saved]),undefined);
  assert.equal(savedBusinessPath(project,[{...scene,question_revision_id:'next'}],[saved]),undefined);
  assert.equal(savedBusinessPath(project,[scene],[{...saved,result:{...result,evidence:[]}}]),undefined);
});
