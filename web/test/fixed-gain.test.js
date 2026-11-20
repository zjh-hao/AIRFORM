import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DrawingGain,DRAWING_GAIN,DrawingPlane,imageDrawingFrame} from '../src/drawing-gain.js';
import {DepthProjector} from '../src/depth-point.js';
import {HandInteraction} from '../src/interaction.js';
import {rgbdHand} from '../test-support/rgbd-hand.js';

const at=(p,t,options)=>{const f=rgbdHand(options);return p.project(f.tip,f.frame,f.hand,t);};

test('fixed palm-relative XY gain is independent of current/initial depth, including partial palm recovery',()=>{
  assert.equal(DRAWING_GAIN.multiplier,2.0);
  const distances=[];
  for(const partial of [false,true])for(const root of [.6,1.2]){
    const gain=new DrawingGain(),calibration=rgbdHand({root:.8});
    gain.project(calibration.tip,calibration.frame,calibration.hand);
    const points=[];
    for(const shiftX of [0,.08]){
      const f=rgbdHand({root,shiftX,mode:'none'});
      if(partial)f.hand[0].y=1.04;
      points.push(gain.project(f.tip,f.frame,f.hand));
    }
    distances.push(points[1].x-points[0].x);
  }
  const expected=.08*DRAWING_GAIN.nominalPalmMeters*DRAWING_GAIN.multiplier/.2016;
  distances.forEach(value=>assert.ok(Math.abs(value-expected)<1e-10));
});

test('Astra output has equal XY travel near/far with valid depth and with the old 0.76 m plane retained',()=>{
  const travels=[];
  for(const missing of [false,true])for(const root of [.6,1.2]){
    const p=new DepthProjector();let t=0;
    at(p,t,{root:missing?.8:root});
    for(let i=1;i<=60;i++)at(p,t=i*1000/30,{root,mode:missing?'none':'all'});
    const start=at(p,t+=1000/30,{root,mode:missing?'none':'all'});
    let end;
    for(let i=1;i<=30;i++)end=at(p,t+=1000/30,{root,shiftX:.08*i/30,mode:missing?'none':'all'});
    travels.push(Math.abs(end.x-start.x));
    if(missing){assert.equal(p.sample.source,'depth-plane');assert.equal(p.last.z,.76);}
  }
  travels.forEach(value=>assert.ok(Math.abs(value-travels[0])<1e-8));
});

test('depth changes, source confidence and source switches cannot change planar filter output',()=>{
  const stable=new DepthProjector(),varying=new DepthProjector();
  for(let i=0;i<75;i++){
    const a=rgbdHand({shiftX:.02*Math.sin(i/15)}),b=rgbdHand({shiftX:.02*Math.sin(i/15)});
    if(i>0)b.frame.depth.fill(i%3===0?0:i%3===1?600:1600);
    const x=stable.project(a.tip,a.frame,a.hand,i*40),y=varying.project(b.tip,b.frame,b.hand,i*40);
    assert.ok(x&&y);assert.ok(Math.abs(x.x-y.x)<1e-10);assert.ok(Math.abs(x.y-y.y)<1e-10);
  }
  const p=new DepthProjector();const first=at(p,0,{root:.6});
  let last;
  for(let i=1;i<=60;i++)last=at(p,i*40,{root:.6+i*.01});
  assert.ok(Math.abs(last.x-first.x)<1e-8);assert.ok(Math.abs(last.y-first.y)<1e-8);
  assert.ok(Math.abs(last.z-first.z)>1); // Genuine front/back movement still controls Z.
});

test('release and a new pinch at another distance do not recalibrate gain',()=>{
  const projector=new DepthProjector();const project=(...args)=>projector.project(...args);
  project.reset=()=>projector.reset();project.suspend=t=>projector.suspend(t);
  const machine=new HandInteraction(project);let t=0;
  const send=(root,ratio,shiftX=0)=>{
    const f=rgbdHand({root,ratio,shiftX,mode:t<200?'all':'none'});
    return machine.update({timestamp:t,source:'摄像头',landmarks:[f.hand],handedness:[[{categoryName:'Right'}]],depthFrame:f.frame},640,480);
  };
  send(.8,.6);t=80;send(.8,.6);t=160;send(.8,.6);
  const travel=[];
  for(const root of [.6,1.2]){
    for(let i=0;i<30;i++){t+=40;send(root,.6);}
    t+=40;send(root,.1);t+=80;const start=send(root,.1).point;
    let result;
    for(let i=1;i<=30;i++){t+=40;result=send(root,.1,.08*i/30);}
    assert.equal(result.state,'Pinching');travel.push(Math.abs(result.point.x-start.x));
    t+=40;send(root,.6,.08);t+=80;assert.equal(send(root,.6,.08).state,'Idle');
  }
  assert.ok(Math.abs(travel[0]-travel[1])<.0001);
});

test('webcam shares the fixed multiplier and tracks near/far input without initial depth calibration',()=>{
  const result=[];
  for(const root of [.6,1.2]){
    const plane=new DrawingPlane(),frame=imageDrawingFrame(640,480);let first,last;
    for(let i=0;i<=90;i++){
      const f=rgbdHand({root,shiftX:i<=60?0:.08*(i-60)/30});
      last=plane.project(f.tip,frame,f.hand,i*1000/30);
      if(i===60)first=last;
    }
    result.push(Math.abs(last.x-first.x));
  }
  // Webcam has no calibrated lens; normalized relative-z is an approximation.
  // It must still remove the large (~2x) perspective-speed change, not use Z.
  assert.ok(Math.abs(result[0]/result[1]-1)<.02);
});
