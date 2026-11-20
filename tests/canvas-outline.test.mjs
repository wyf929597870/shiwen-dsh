import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasOutline} from '../plugins/workbench/src/canvas-outline.mjs';

test('outline follows numeric branch order and promotes through unselected parents',()=>{
  const t=zh=>zh;
  const a={recordId:'a',kind:'idea',path:[2],title:'整理旧笔记',text:'先回看。再归类。先回看。'};
  const b={recordId:'b',kind:'reading_note',path:[2,1,0],title:'一段摘录',match:{text:'找出重复出现的问题。'}};
  const c={recordId:'c',kind:'article',path:[10],title:'[下一步]',match:{text:'留下值得重访的材料。'}};
  const result=canvasOutline([c,b,a],t);
  assert.equal(result.title,'整理旧笔记 · 文章大纲');
  assert.equal(result.body,'## 整理旧笔记\n\n- 先回看。\n- 再归类。\n\n### 一段摘录\n\n- 找出重复出现的问题。\n\n## \\[下一步\\]\n\n- 留下值得重访的材料。');
  assert.deepEqual(result.sourceIds,['a','b']);
});
