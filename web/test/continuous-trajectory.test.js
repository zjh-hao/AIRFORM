import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Group} from 'three';
import {ContinuousPosition} from '../src/continuous-position.js';
import {DepthProjector} from '../src/depth-point.js';
import {connectInteraction} from '../src/interaction.js';
import {connectLiveDrawing} from '../src/live-drawing.js';
import {rgbdHand} from '../test-support/rgbd-hand.js';
import {DRAWING_GAIN} from '../src/drawing-gain.js';

function harness(){
  const target=new EventTarget(),scene=new Group(),projector=new DepthProjector();let result,stats;
  const point=(...args)=>projector.project(...args);point.reset=()=>projector.reset();
  point.suspend=t=>projector.suspend(t);point.motionStatus=()=>projector.sample.motion;
  const disconnect=connectInteraction(target,()=>({width:640,height:480}),point);
  const dispose=connectLiveDrawing(target,scene,value=>stats=value);
  target.addEventListener('kineglow:interaction',({detail})=>result=detail);
  const send=(timestamp,options={})=>{
    const f=rgbdHand(options);
    if(options.partial)f.hand[0].y=1.04;
    if(options.falseDepth)f.frame.depth=f.frame.depth.map(z=>z*2);
    target.dispatchEvent(new CustomEvent('kineglow:hands',{detail:{timestamp,source:options.source??'摄像头',
      landmarks:options.missing?[]:[f.hand],handedness:options.missing?[]:[[{categoryName:options.label??'Right'}]],depthFrame:f.frame}}));
  };
  const arm=()=>{send(0,{ratio:.6});send(80,{ratio:.6});send(160,{ratio:.6});send(200,{});send(280,{shiftX:.005});};
  return{target,scene,projector,send,arm,result:()=>result,stats:()=>stats,close:()=>{disconnect();dispose();}};
}

test('a stable pinch survives repeated brief central dropouts without rearming or drawing while absent',()=>{
  const h=harness();
  try {
    h.arm(); h.send(310,{shiftX:.01});
    for(const t of [340,450]) {
      const before=h.stats().segments;
      h.send(t,{missing:true});
      assert.equal(h.stats().segments,before);
      assert.equal(h.result().tracking,'pinch-paused');
      h.send(t+45,{shiftX:.02});
      assert.equal(h.result().state,'Pinching');
      assert.equal(h.stats().strokes,0);
    }
    h.send(525,{ratio:.8});h.send(580,{ratio:.8});
    assert.equal(h.stats().ends.release,1);
  } finally {h.close();}
});

test('Kalman reduces static jitter, follows ordinary motion and keeps finite positive uncertainty',()=>{
  const filter=new ContinuousPosition();let raw=0,smoothed=0;
  for(let i=0;i<150;i++){
    const x=.5+(i%2?.004:-.004),p=filter.update({x,y:0,z:1},i*1000/30);
    if(i>30){raw+=(x-.5)**2;smoothed+=(p.x-.5)**2;}
    assert.ok(filter.blocks.every(b=>b.p00>0&&b.p11>0&&b.p00*b.p11>=b.p01*b.p01-1e-12));
  }
  assert.ok(smoothed<raw*.5);
  filter.reset();let squared=0,count=0;
  for(let i=0;i<90;i++){
    const x=i/30,p=filter.update({x,y:0,z:1},i*1000/30);
    if(i>15){squared+=(p.x-x)**2;count++;}
  }
  assert.ok(Math.sqrt(squared/count)<.02);
});

test('isolated outlier does not cause a large jump; coherent movement corrects continuously instead of returning null',()=>{
  const filter=new ContinuousPosition();filter.update({x:0,y:0,z:1},0);
  const spike=filter.update({x:.4,y:0,z:1},33);
  assert.ok(Math.abs(spike.x)<.01);assert.equal(filter.status.mode,'predicting');
  assert.ok(filter.update({x:.01,y:0,z:1},66));
  let prior=.01,p;
  for(let i=1;i<=20;i++){
    p=filter.update({x:.3,y:0,z:1},66+i*33);
    assert.ok(p);assert.ok(Math.abs(p.x-prior)<.09);prior=p.x;
  }
  assert.ok(Math.abs(p.x-.3)<.03);
  assert.equal(filter.update({x:NaN,y:0,z:1},1000),null);
});

test('seconds of missing depth keep visible fingertip XY moving on a labeled old depth plane',()=>{
  const h=harness();
  try{
    h.arm();let planeSeen=false;
    for(let t=330;t<=3330;t+=50){
      h.send(t,{mode:'none',shiftX:.04*Math.sin(t/700)});
      assert.equal(h.result().state,'Pinching');assert.ok(h.result().point);
      planeSeen ||= h.projector.sample.source==='depth-plane';
    }
    assert.ok(planeSeen);assert.equal(h.projector.last.measuredAt,280);
    assert.equal(h.stats().strokes,0);assert.equal(h.stats().ends.depth,0);
    h.send(3380,{ratio:.6});h.send(3440,{ratio:.6});assert.equal(h.stats().strokes,1);
  }finally{h.close();}
});

test('nearby recovery after missing RGB fills the same stroke, with no geometry while observations are missing',()=>{
  const h=harness();
  try{
    h.arm();h.send(330,{shiftX:.01});const before=h.stats().segments;
    h.send(380,{missing:true});h.send(480,{missing:true});
    assert.equal(h.stats().active,true);assert.equal(h.stats().paused,true);assert.equal(h.stats().segments,before);
    h.send(530,{shiftX:.025});h.send(630,{shiftX:.03});h.send(730,{shiftX:.035});
    assert.equal(h.result().state,'Pinching');assert.equal(h.stats().strokes,0);
    assert.ok(h.stats().bridges>=1);assert.ok(h.stats().segments>before);
    h.send(780,{ratio:.6,shiftX:.035});h.send(840,{ratio:.6,shiftX:.035});assert.equal(h.stats().strokes,1);
  }finally{h.close();}
});

test('partial hand scale and calibrated depth survive short empty detections without requiring the wrist to reappear',()=>{
  const h=harness();
  try{
    h.arm();h.send(320,{partial:true,shiftX:.01});h.send(360,{missing:true});h.send(460,{missing:true});
    h.send(500,{partial:true,shiftX:.015});h.send(600,{partial:true,shiftX:.02});h.send(700,{partial:true,shiftX:.025});
    assert.equal(h.result().state,'Pinching');assert.ok(h.result().point);assert.equal(h.stats().strokes,0);
    assert.ok(h.stats().bridges>=1);
  }finally{h.close();}
});

test('long loss, explicit stop and actual open finish strokes; Clear also resets suspended estimator state',()=>{
  for(const reason of ['timeout','stop','open','clear']){
    const h=harness();
    try{
      h.arm();h.send(330,{shiftX:.01});h.send(380,{missing:true});
      if(reason==='timeout'){h.send(600,{missing:true});h.send(1200,{missing:true});}
      if(reason==='stop')h.send(420,{missing:true,source:'stopped'});
      if(reason==='open'){h.send(480,{ratio:.6});h.send(580,{ratio:.6});}
      if(reason==='clear'){
        h.target.dispatchEvent(new CustomEvent('kineglow:clear'));
        assert.equal(h.projector.filter.blocks,null);assert.equal(h.scene.children[0].children.length,0);
        h.send(480,{});h.send(580,{});h.send(680,{});assert.equal(h.result().state,'Rearming');
      }
      assert.equal(h.stats().active,false);
    }finally{h.close();}
  }
});

test('mixed circles at 8/15/30 Hz reconnect short holes but split a sampled loss over 350 ms',context=>{
  for(const hz of [8,15,30]){
    const h=harness();let maxStep=0,previous=null,squared=0,count=0;
    try{
      h.arm();
      const samples=Math.round(hz*5),dt=1000/hz;
      for(let i=0;i<samples;i++){
        const elapsed=i*dt,t=330+elapsed,angle=i/samples*2*Math.PI;
        const x=.07*Math.cos(angle),y=.07*Math.sin(angle),root=1+.025*Math.sin(angle);
        const missing=(elapsed>=1000&&elapsed<=1200)||(elapsed>=2500&&elapsed<=2750);
        const mode=elapsed>=300&&elapsed<=1800?'none':'all';
        const spike=i===Math.floor(samples*.43),falseDepth=i===Math.floor(samples*.70)||i===Math.floor(samples*.70)+1;
        h.send(t,{shiftX:spike?.3:x,shiftY:y,root,mode,missing,falseDepth});
        const r=h.result();
        if(r.state==='Pinching'&&r.point){
          if(previous)maxStep=Math.max(maxStep,Math.hypot(...['x','y','z'].map(a=>r.point[a]-previous[a])));
          previous=r.point;
          // XY now uses fixed palm-relative interaction units, not camera meters.
          const gain=DRAWING_GAIN.nominalPalmMeters*DRAWING_GAIN.multiplier/.2016;
          squared+=(r.point.x/5-(-(-.012288+x))*gain)**2+(r.point.y/5-(-(-.129024+y))*gain)**2;count++;
        }
      }
      const rmse=Math.sqrt(squared/count);
      const longLosses=hz===8?1:0;
      assert.equal(h.stats().strokes,longLosses);assert.equal(h.stats().ends.depth,0);assert.equal(h.stats().ends.tracking,longLosses);
      assert.ok(h.stats().bridges>=2-longLosses);assert.ok(maxStep<.5);assert.ok(rmse<.025);
      h.send(5380,{ratio:.6});h.send(5440,{ratio:.6});
      assert.equal(h.stats().strokes,1+longLosses);assert.equal(h.stats().ends.release,1);
      context.diagnostic(JSON.stringify({hz,strokes:h.stats().strokes,bridges:h.stats().bridges,
        xyRmseInteractionUnits:rmse,maxStepSceneUnits:maxStep}));
    }finally{h.close();}
  }
});
