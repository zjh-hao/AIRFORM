import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../test-support/three-loader.js';
const {StrokeEngine}=await import('../src/stroke-engine.js');

test('M4: undo/redo preserve finished geometry; replacement and clear dispose redo history',()=>{
  const engine=new StrokeEngine();
  const draw=()=>{engine.beginStroke({x:0,y:0,z:0});engine.appendPoint({x:1,y:1,z:1});engine.endStroke();};
  draw();const original=engine.group.children[0];let releases=0;
  original.geometry.addEventListener('dispose',()=>releases++);
  engine.undo();assert.equal(engine.stats.strokes,0);assert.ok(engine.canRedo);
  engine.redo();assert.equal(engine.group.children[0],original);
  engine.undo();draw();assert.equal(releases,1);assert.equal(engine.redo(),false);
  engine.undo();engine.clear();assert.equal(engine.canRedo,false);engine.dispose();
});
