import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test-support/three-loader.js';
import { CursorPlayback } from '../src/cursor-playback.js';
const { Scene }=await import('three');
const { connectLiveDrawing }=await import('../src/live-drawing.js');

test('M2: display motion saturates in one frame and never changes observations',()=>{
  const playback=new CursorPlayback(), point={x:.05,y:0,z:0};
  playback.push({x:0,y:0,z:0},0,false);playback.push(point,50,true);
  assert.ok(playback.sample(66).x>.05);
  assert.deepEqual(playback.sample(83),playback.sample(500));
  assert.equal(point.x,.05);
  playback.reset();assert.equal(playback.sample(501),null);
});

test('enhanced processing pauses bridge measured endpoints once and expire on sustained silence',context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const target=new EventTarget();let stats;
  const close=connectLiveDrawing(target,new Scene(),value=>stats=value);
  const send=(timestamp,x,processingResume=false)=>target.dispatchEvent(new CustomEvent('kineglow:interaction',
    {detail:{state:'Pinching',source:'摄像头',point:{x,y:0,z:0},timestamp,enhanced:true,processingResume}}));
  try {
    send(0,0);send(40,.12);context.mock.timers.tick(430);assert.equal(stats.active,true);
    send(470,.2,true);assert.equal(stats.bridges,1);assert.equal(stats.ends.tracking,0);
    context.mock.timers.tick(551);assert.equal(stats.ends.tracking,1);assert.equal(stats.active,false);
  } finally {close();}
});

test('M2: silence closes and tapers at the last observed endpoint without a later event',context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const scene=new Scene(), target=new EventTarget();let stats;
  const close=connectLiveDrawing(target,scene,value=>stats=value);
  try {
    for(const [timestamp,x] of [[0,0],[40,.12]])target.dispatchEvent(new CustomEvent('kineglow:interaction',
      {detail:{state:'Pinching',source:'摄像头',point:{x,y:0,z:0},timestamp}}));
    context.mock.timers.tick(350);assert.equal(stats.active,true);
    context.mock.timers.tick(1);assert.equal(stats.active,false);assert.equal(stats.ends.tracking,1);
    const positions=scene.children[0].children[0].geometry.attributes.position;
    const radius=Math.hypot(positions.getY(14),positions.getZ(14));
    assert.ok(radius>.003 && radius<.006);assert.ok(Math.abs(positions.getX(13)-.12)<1e-6);
  } finally {close();}
});
