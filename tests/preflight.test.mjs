import test from 'node:test';
import assert from 'node:assert/strict';
import {checkArticle} from '../plugins/workbench/src/preflight.mjs';
test('发布前检查只给出提示，并识别缺项及可能的私人信息',()=>{
 const checks=Object.fromEntries(checkArticle({title:'',body:'联系 test@example.com',sourceIds:[]}).map(x=>[x.id,x.ok]));
 assert.deepEqual(checks,{title:false,body:true,structure:false,sources:false,private:false});
});
