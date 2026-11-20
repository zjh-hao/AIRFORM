import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Group, Vector3 } from 'three';
import { createDrawingCamera, fitDrawingCamera } from '../src/drawing-camera.js';
import { connectInteraction, HandInteraction, PLANE } from '../src/interaction.js';
import { connectLiveDrawing } from '../src/live-drawing.js';
import { DepthProjector } from '../src/depth-point.js';
import { HandPoseFusion } from '../src/hand-pose-fusion.js';
import { rgbdHand } from '../test-support/rgbd-hand.js';

function frame(timestamp,{ratio=.1,partial=false,missing=false,label='Right',source='摄像头',shiftX=0,mode='all'}={}) {
  const f=rgbdHand({ratio,shiftX,mode});
  if(partial)f.hand[0].y=1.04;
  return {timestamp,source,landmarks:missing?[]:[f.hand],handedness:missing?[]:[[{categoryName:label}]],depthFrame:f.frame};
}
function harness() {
  const target=new EventTarget(),scene=new Group(),projector=new DepthProjector();let stats,interaction;
  const project=(...args)=>projector.project(...args);project.reset=()=>projector.reset();
  const disconnect=connectInteraction(target,()=>({width:640,height:480}),project);
  const dispose=connectLiveDrawing(target,scene,value=>stats=value);
  target.addEventListener('kineglow:interaction',({detail})=>interaction=detail);
  const send=(t,options)=>target.dispatchEvent(new CustomEvent('kineglow:hands',{detail:frame(t,options)}));
  const arm=()=>{send(0,{ratio:.6});send(80,{ratio:.6});send(160,{ratio:.6});send(200,{});send(280,{shiftX:.005});};
  return {target,scene,send,arm,stats:()=>stats,result:()=>interaction,close:()=>{disconnect();dispose();}};
}

test('orthographic brush projection has the same width at near/far Z and after viewport resize', () => {
  const camera=createDrawingCamera(640,480,PLANE);
  const width=z=>{
    const a=new Vector3(-.03,0,z).project(camera),b=new Vector3(.03,0,z).project(camera);
    return b.x-a.x;
  };
  camera.updateMatrixWorld();
  assert.equal(camera.isOrthographicCamera,true);
  assert.ok(Math.abs(width(4)-width(-15))<1e-12);
  fitDrawingCamera(camera,300,600,PLANE);
  assert.ok(Math.abs(width(4)-width(-15))<1e-12);
  assert.ok(camera.right>=PLANE.width/2&&camera.top>=PLANE.height/2);
});

test('visible thumb/index keep drawing for seconds with the wrist outside, using remaining palm spans', () => {
  const h=harness();
  try {
    h.arm();
    for(let t=320;t<=2320;t+=40) {
      h.send(t,{partial:true,shiftX:.005+(t-280)/100000});
      assert.equal(h.result().state,'Pinching');assert.equal(h.result().tracking,'partial-hand');
      assert.ok(h.result().point);
    }
    h.send(2360,{partial:true,ratio:.6});h.send(2420,{partial:true,ratio:.6});
    assert.equal(h.stats().strokes,1);assert.equal(h.stats().ends.tracking,0);assert.equal(h.stats().ends.depth,0);
    assert.equal(h.stats().ends.release,1);
  } finally {h.close();}
});

test('partial palm retains current depth anchors, and three calibrated visible bones support bounded prediction', () => {
  const fusion=new HandPoseFusion(),full=frame(0),partial=frame(40,{partial:true,mode:'palm'});
  fusion.update(full.landmarks[0][8],full.depthFrame,full.landmarks[0],0);
  assert.ok(fusion.update(partial.landmarks[0][8],partial.depthFrame,partial.landmarks[0],40));
  assert.equal(fusion.sample.source,'hand-estimated');assert.ok(fusion.sample.anchors>=2);
  const empty=frame(80,{partial:true,mode:'none'});
  assert.ok(fusion.update(empty.landmarks[0][8],empty.depthFrame,empty.landmarks[0],80));
  assert.equal(fusion.sample.source,'kinematic-predicted');assert.equal(fusion.sample.bones,3);
});

test('empty detections after edge clipping pause geometry and resume the same nearby stroke', () => {
  const h=harness();
  try {
    h.arm();h.send(320,{partial:true,shiftX:.006});const before=h.stats().segments;
    h.send(360,{missing:true});h.send(440,{missing:true});
    assert.equal(h.result().tracking,'boundary-paused');assert.equal(h.result().point,null);
    assert.equal(h.stats().active,true);assert.equal(h.stats().segments,before);assert.equal(h.stats().strokes,0);
    h.send(480,{partial:true,shiftX:.01});
    assert.equal(h.result().state,'Pinching');assert.ok(h.stats().segments>before);
    h.send(520,{ratio:.6});h.send(580,{ratio:.6});
    assert.equal(h.stats().strokes,1);assert.equal(h.stats().ends.tracking,0);
  } finally {h.close();}
});

test('edge pause has a fixed deadline; an expired/remote/left hand or a missing fingertip cannot join', () => {
  for(const cause of ['deadline','remote','left','tip']) {
    const h=harness();
    try {
      h.arm();h.send(320,{partial:true});h.send(360,{missing:true});
      if(cause==='deadline'){h.send(500,{missing:true});h.send(640,{missing:true});}
      if(cause==='remote')h.send(400,{partial:true,shiftX:.2});
      if(cause==='left')h.send(400,{partial:true,label:'Left'});
      if(cause==='tip') {
        const detail=frame(400,{partial:true});detail.landmarks[0][8].x=1.02;
        h.target.dispatchEvent(new CustomEvent('kineglow:hands',{detail}));
      }
      assert.equal(h.result().state,'TrackingLost');assert.equal(h.stats().active,true);
      assert.equal(h.stats().paused,true);
      h.send(1240,{missing:true});
      assert.equal(h.stats().active,false);assert.equal(h.stats().ends.tracking,1);
    } finally {h.close();}
  }
});

test('partial hand alone cannot unlock a fresh session; release on edge recovery does not draw a bridge', () => {
  const fresh=new HandInteraction();
  for(const t of [0,80,160,240])assert.equal(fresh.update(frame(t,{partial:true,ratio:.6}),640,480).state,'TrackingLost');
  const h=harness();
  try {
    h.arm();h.send(320,{partial:true});h.send(360,{missing:true});const before=h.stats().segments;
    h.send(400,{ratio:.6});
    assert.equal(h.result().state,'Idle');assert.equal(h.stats().segments,before);assert.equal(h.stats().strokes,1);
  } finally {h.close();}
});

test('large 3D reacquisition cannot bridge across an edge pause even with nearby screen coordinates', () => {
  const target=new EventTarget(),scene=new Group();let stats;
  const dispose=connectLiveDrawing(target,scene,value=>stats=value);
  let timestamp=0;
  const send=(point,tracking)=>target.dispatchEvent(new CustomEvent('kineglow:interaction',
    {detail:{source:'摄像头',state:'Pinching',point,tracking,timestamp:timestamp+=40}}));
  try {
    send({x:0,y:0,z:0});send({x:.01,y:0,z:0});send(null,'boundary-paused');
    send({x:.02,y:0,z:2});
    assert.equal(stats.strokes,1);assert.equal(stats.ends.tracking,1);
    send({x:.03,y:0,z:2});assert.equal(scene.children[0].children.length,2);
  } finally {dispose();}
});

test('clear releases finished/active geometry, resets counters and requires open before another stroke', () => {
  const h=harness();let released=0;
  try {
    h.arm();h.send(320,{shiftX:.01});h.send(360,{ratio:.6});h.send(420,{ratio:.6});
    h.send(460,{});h.send(540,{});h.send(580,{shiftX:.02});
    const group=h.scene.children[0],resources=new Set(group.children.flatMap(mesh=>[mesh.geometry,mesh.material]));
    resources.forEach(resource=>resource.addEventListener('dispose',()=>released++));
    h.target.dispatchEvent(new CustomEvent('kineglow:clear'));
    assert.equal(group.children.length,0);assert.equal(released,resources.size);
    assert.equal(h.stats().strokes,0);assert.equal(h.stats().segments,0);assert.equal(h.stats().active,false);
    assert.ok(Object.values(h.stats().ends).every(value=>value===0));
    h.send(620,{});h.send(700,{});h.send(780,{});assert.equal(h.stats().active,false);
    h.send(820,{ratio:.6});h.send(900,{ratio:.6});h.send(940,{});h.send(1020,{});h.send(1060,{shiftX:.01});
    assert.equal(h.stats().active,true);assert.equal(group.children.length,1);
  } finally {h.close();}
  assert.doesNotThrow(()=>h.target.dispatchEvent(new CustomEvent('kineglow:clear')));
});
