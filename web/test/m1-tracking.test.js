import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandInteraction } from '../src/interaction.js';
import { HandGesture, worldGeometry } from '../src/hand-geometry.js';
import { CursorFilter } from '../src/cursor-filter.js';
import { DrawingPlane, imageDrawingFrame } from '../src/drawing-gain.js';
import { worldHand, armWorld } from '../test-support/world-hand.js';

test('M1: short conflicting depth opening pauses ink and returns to the same pinch',()=>{
  const machine=new HandInteraction();armWorld(machine);
  const send=(timestamp,worldRatio,imageRatio)=>{
    const frame=worldHand({timestamp,ratio:worldRatio});
    frame.landmarks=worldHand({timestamp,ratio:imageRatio}).landmarks;
    return machine.update(frame,640,480);
  };
  for(const timestamp of [360,410,460,510]) {
    const result=send(timestamp,.54,.12);
    assert.equal(result.state,'Pinching');
    assert.equal(result.releasePending,true);
  }
  assert.equal(send(560,.2,.12).releasePending,undefined);
  assert.equal(send(600,.54,.12).state,'Pinching');
  assert.equal(send(850,.54,.12).state,'Idle');
});

test('M1: a partial right hand after a hysteresis frame does not require a new pinch',()=>{
  const machine=new HandInteraction();armWorld(machine);
  machine.update(worldHand({timestamp:360,ratio:.38}),640,480);
  const partial=worldHand({timestamp:400,ratio:.2});
  partial.landmarks[0][4].x=-.01;
  const paused=machine.update(partial,640,480);
  assert.equal(paused.state,'Pinching');assert.equal(paused.point,null);
  assert.equal(machine.update(worldHand({timestamp:440,ratio:.2}),640,480).state,'Pinching');
});

test('M1: local 3D pinch ratio is invariant to rigid rotation and hand scale',()=>{
  for(const ratio of [.15,.30,.45,.7])for(const pitch of [0,Math.PI/3,Math.PI/2,-Math.PI/3])
    for(const yaw of [0,.8,-1.2])for(const scale of [.7,1,1.3]) {
      const frame=worldHand({ratio,pitch,yaw,scale}),before=structuredClone(frame);
      const geometry=worldGeometry(frame.worldLandmarks[0]);
      assert.ok(geometry);assert.ok(Math.abs(geometry.ratio-ratio)<1e-12);
      assert.deepEqual(frame,before);
    }
});

test('M1: long foreshortened pinch holds through false 2D release; actual 3D opening releases',()=>{
  const machine=new HandInteraction(),legacy=new HandInteraction(undefined,{gestureMode:'legacy'});
  armWorld(machine);armWorld(legacy);
  let result,oldResult;
  for(let timestamp=360;timestamp<=1200;timestamp+=40) {
    const frame=worldHand({timestamp,ratio:.2,pitch:80*Math.PI/180});
    result=machine.update(frame,640,480);oldResult=legacy.update(frame,640,480);
    assert.equal(result.state,'Pinching');assert.equal(result.releasePending,undefined);
    assert.equal(result.gestureBasis,'world');assert.equal(result.pose,'foreshortened');
  }
  assert.equal(oldResult.state,'Idle');
  const open=t=>machine.update(worldHand({timestamp:t,ratio:.65,pitch:80*Math.PI/180}),640,480);
  assert.equal(open(1240).state,'Pinching');assert.equal(open(1280).state,'Idle');
});

test('M1: a 150 ms missing observation holds only display/session, never invents an ink point',()=>{
  const machine=new HandInteraction();armWorld(machine);
  for(const timestamp of [360,400,470]) {
    const r=machine.update(worldHand({timestamp,missing:true}),640,480);
    assert.equal(r.state,'Pinching');assert.equal(r.point,null);
    assert.equal(r.observationValid,false);assert.equal(r.cursorSource,'held');assert.ok(r.cursorPoint);
  }
  const resumed=machine.update(worldHand({timestamp:471,ratio:.15}),640,480);
  // At 151 ms the short hold expires; the existing pen session owns reconnection.
  assert.ok(resumed.canResume);assert.equal(resumed.point,null);
});

test('M1: one short handedness flip retains a confirmed drawing hand, but cannot latch Left forever',()=>{
  const machine=new HandInteraction();armWorld(machine);
  const flip=t=>machine.update(worldHand({timestamp:t,ratio:.15,label:'Left'}),640,480);
  assert.equal(flip(360).state,'Pinching');assert.equal(flip(400).labelHeld,true);
  assert.equal(flip(441).state,'TrackingLost');
  const initial=new HandInteraction();
  for(const timestamp of [0,80,160,240])assert.equal(initial.update(worldHand({timestamp,label:'Left'}),640,480).point,null);
});

test('M1: ambiguous hands and distant replacement never reuse short label continuity',()=>{
  for(const kind of ['ambiguous','distant']) {
    const machine=new HandInteraction();armWorld(machine);
    const frame=worldHand({timestamp:360,ratio:.15,label:kind==='distant'?'Left':'Right',shiftX:kind==='distant'?.2:0});
    if(kind==='ambiguous') {
      frame.landmarks.push(structuredClone(frame.landmarks[0]));
      frame.worldLandmarks.push(structuredClone(frame.worldLandmarks[0]));
      frame.handedness.push([{categoryName:'Right'}]);
    }
    assert.equal(machine.update(frame,640,480).point,null);
  }
});

test('M1: world quality rejects nonfinite/collapsed/outlier geometry; foreshortening fallback is bounded',()=>{
  const base=worldHand({pitch:80*Math.PI/180,ratio:.2});
  assert.equal(worldGeometry(base.worldLandmarks[0].slice(0,20)),null);
  const invalid=structuredClone(base.worldLandmarks[0]);invalid[8].z=NaN;
  assert.equal(worldGeometry(invalid),null);
  invalid[8]={x:100,y:100,z:100};assert.equal(worldGeometry(invalid),null);
  assert.equal(worldGeometry(Array.from({length:21},()=>({x:0,y:0,z:0}))),null);
  const gesture=new HandGesture();
  gesture.observe(base.landmarks[0],640,480,0,base.worldLandmarks[0]);
  assert.equal(gesture.observe(base.landmarks[0],640,480,100,[]).basis,'unreliable');
  assert.equal(gesture.observe(base.landmarks[0],640,480,151,[]).basis,'image');
  gesture.reset();assert.equal(gesture.observe(base.landmarks[0],640,480,200,[]).basis,'image');
  const collapsed=worldHand({pitch:Math.PI/2,ratio:.2});
  assert.equal(gesture.observe(collapsed.landmarks[0],640,480,250,[]),null);
});

test('M1: stop/clear revoke world gesture and held cursor, and startup still requires opening',()=>{
  const machine=new HandInteraction();armWorld(machine);
  const stopped=machine.update({timestamp:360,source:'stopped',landmarks:[],handedness:[]},640,480);
  assert.equal(stopped.point,null);assert.equal(stopped.cursorPoint,undefined);
  for(const timestamp of [400,480,560])machine.update(worldHand({timestamp,ratio:.15}),640,480);
  assert.equal(machine.state,'Rearming');machine.reset();
  machine.update(worldHand({timestamp:600,ratio:.15}),640,480);
  assert.equal(machine.update(worldHand({timestamp:680,ratio:.15}),640,480).state,'Rearming');
});

test('M1: cursor branch smooths stationary noise without changing the independent ink estimator',()=>{
  const plane=new DrawingPlane(),frame=imageDrawingFrame(640,480);
  const raw=[],cursor=[];
  for(let i=0;i<300;i++) {
    const f=worldHand({timestamp:i*1000/30,shiftX:(i%2?1:-1)*.002});
    const hand=f.landmarks[0];plane.project(hand[8],frame,hand,f.timestamp);
    if(i>30) {raw.push(plane.rawPoint.x);cursor.push(-plane.cursorPoint.x/5);}
  }
  const deviation=values=>{
    const mean=values.reduce((s,x)=>s+x,0)/values.length;
    return Math.sqrt(values.reduce((s,x)=>s+(x-mean)**2,0)/values.length);
  };
  assert.ok(deviation(cursor)<deviation(raw)*.4);
  // Neither filter aliases or consumes the other's state.
  const inkBefore=structuredClone(plane.filter.blocks);
  plane.cursorFilter.reset();assert.deepEqual(plane.filter.blocks,inkBefore);
});

test('M1: cursor missing/outlier/stale/reset semantics never extrapolate or carry old derivative into recovery',()=>{
  const filter=new CursorFilter();
  filter.update({x:0,y:0,z:0},0);filter.update({x:.1,y:0,z:0},33);
  const before={...filter.last.output};
  assert.deepEqual(filter.update({x:8,y:0,z:0},66),before);
  assert.equal(filter.status,'outlier-held');
  assert.equal(filter.update({x:0,y:0,z:0},50),null);
  assert.equal(filter.update(null,100),null);
  assert.deepEqual(filter.update({x:.12,y:0,z:0},133),{x:.12,y:0,z:0});
  assert.equal(filter.update({x:9,y:0,z:0},133),null);
  assert.deepEqual(filter.resume({x:4,y:2,z:1},200),{x:4,y:2,z:1});
  filter.reset();assert.equal(filter.last,null);
});

test('M1: coherent slow motion raises the same filter cutoff and stays below 70 ms steady filter lag',()=>{
  for(const speed of [.1,.5,1,2]) {
    const filter=new CursorFilter();
    for(let i=0;i<120;i++) {
      const timestamp=i*1000/30,x=speed*timestamp/1000;
      const output=filter.update({x,y:0,z:0},timestamp);
      if(i>30)assert.ok((x-output.x)/speed*1000<70);
    }
  }
});
