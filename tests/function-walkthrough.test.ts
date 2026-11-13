import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AnalysisResult} from '../src/shared';
import {validateFunctionWalkthroughs} from '../src/main/function-walkthrough-validation';

const fixture=()=>({nodes:[{node_id:'entry',kind:'function'},{node_id:'store',kind:'function'},{node_id:'business',kind:'stage'}],edges:[{edge_id:'call',kind:'sync_call',source_node_id:'entry',target_node_id:'store',status:'source_supported'}],evidence:[{evidence_id:'ev'}],function_walkthroughs:[{id:'save',label:'保存',trigger:'提交保存',entry_node_id:'entry',boundary:'只覆盖保存',evidence_ids:['ev'],steps:[
 {id:'start',kind:'entry',from_node_id:null,to_node_id:'entry',text:'进入',input:'请求',output:'校验',condition:'',evidence_ids:['ev']},
 {id:'save',kind:'call',from_node_id:'entry',to_node_id:'store',text:'保存',input:'内容',output:'项目',condition:'',evidence_ids:['ev']},
 {id:'done',kind:'return',from_node_id:'store',to_node_id:'entry',text:'返回',input:'项目',output:'交回请求方',condition:'',evidence_ids:['ev']},
]}]} as unknown as AnalysisResult);
test('explicit entry, call and paired return retain declared order',()=>{const r=fixture(),saved=JSON.stringify(r);assert.deepEqual(validateFunctionWalkthroughs(r),[]);assert.equal(JSON.stringify(r),saved);});
test('historical explanations without order stay valid without manufacturing a trace',()=>{const r=fixture();delete (r as any).function_walkthroughs;assert.deepEqual(validateFunctionWalkthroughs(r),[]);assert.equal(r.function_walkthroughs,undefined);});
test('rejects unrelated and non-function entries and steps',()=>{for(const id of ['other-result','business']){const r=fixture() as any;r.function_walkthroughs[0].entry_node_id=id;r.function_walkthroughs[0].steps[1].to_node_id=id;assert.ok(validateFunctionWalkthroughs(r).some(e=>e.includes('不是本结果的函数')));assert.ok(validateFunctionWalkthroughs(r).some(e=>e.includes('非函数节点')));}});
test('cannot replace a direct call with an unproved asynchronous dispatch',()=>{const r=fixture() as any;r.function_walkthroughs[0].steps[1].kind='dispatch';assert.ok(validateFunctionWalkthroughs(r).some(e=>e.includes('缺少对应来源关系')));});
test('return before call, missing evidence and work disguised as a cross-function hop are rejected',()=>{const r=fixture() as any;const p=r.function_walkthroughs[0];[p.steps[1],p.steps[2]]=[p.steps[2],p.steps[1]];p.steps[2].kind='work';p.steps[2].evidence_ids=['from-another-version'];const errors=validateFunctionWalkthroughs(r);assert.ok(errors.some(e=>e.includes('返回步骤缺少先前调用')));assert.ok(errors.some(e=>e.includes('缺少本结果依据')));assert.ok(errors.some(e=>e.includes('函数内部处理不能冒充跨函数调用')));});
