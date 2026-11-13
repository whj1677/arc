import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectLabel} from '../src/ui/project-label';
test('generic source directories retain their engineering scope without renaming real projects',()=>{
 assert.equal(projectLabel({name:'src',root_path:'D:\\projects\\ui-test-agent\\src'}),'ui-test-agent · src');
 assert.equal(projectLabel({name:'src',root_path:'C:/projects/arc-app/src/'}),'arc-app · src');
 assert.equal(projectLabel({name:'app',root_path:'D:/pm-req/app'}),'pm-req · app');
 assert.equal(projectLabel({name:'贸易增量',root_path:'C:/work/贸易增量'}),'贸易增量');
 assert.equal(projectLabel({name:'自定义名称',root_path:'C:/work/app'}),'自定义名称');
});
