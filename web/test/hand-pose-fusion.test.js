import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Group } from 'three';
import { HandPoseFusion } from '../src/hand-pose-fusion.js';
import { DepthProjector } from '../src/depth-point.js';
import { OneEuroFilter } from '../src/one-euro-filter.js';
import { connectInteraction } from '../src/interaction.js';
import { connectLiveDrawing } from '../src/live-drawing.js';
import { rgbdHand } from '../test-support/rgbd-hand.js';
const update = (fusion, t, options) => { const f=rgbdHand(options); return fusion.update(f.tip,f.frame,f.hand,t); };

test('metric palm observations estimate occluded tip; an uninitialized RGB hand never invents absolute range', () => {
  const fusion=new HandPoseFusion();
  assert.equal(update(fusion,0,{mode:'none'}),null);
  const point=update(fusion,33,{mode:'palm'});
  assert.ok(Math.abs(point.z-.96)<.002);
  assert.equal(fusion.sample.source,'hand-estimated');assert.ok(fusion.sample.anchors>=5);
});

test('kinematic prediction follows missing depth, then visible hand continues on the last depth plane', () => {
  const fusion=new HandPoseFusion();update(fusion,0,{});
  let point;
  for(let t=33;t<=726;t+=33) {
    const root=1-.1*t/726;
    point=update(fusion,t,{root,shiftX:.06*t/726,mode:'none'});
    assert.ok(point);assert.ok(Math.abs(point.z-(root-.04))<.002);
    assert.equal(fusion.sample.source,'kinematic-predicted');assert.equal(fusion.sample.ageMs,t);
    assert.equal(fusion.last.measuredAt,0);
  }
  assert.ok(point.x>.03);assert.ok(fusion.sample.confidence<.2);
  for(let t=759;t<=891;t+=33)assert.ok(update(fusion,t,{root:.9,mode:'none'}));
  assert.ok(update(fusion,924,{root:.9,mode:'none'}));assert.equal(fusion.sample.source,'depth-plane');
  assert.ok(update(fusion,957,{mode:'none'}));assert.equal(fusion.last.measuredAt,0);
});

test('sensor recovery renews scale, but a rejected background depth jump does not renew the lease', () => {
  const fusion=new HandPoseFusion();update(fusion,0,{});
  assert.ok(update(fusion,33,{mode:'background'}));
  assert.equal(fusion.sample.source,'kinematic-predicted');assert.equal(fusion.last.measuredAt,0);
  assert.ok(Math.abs(fusion.last.z-.96)<.002);
  update(fusion,66,{root:.99,mode:'palm'});
  assert.equal(fusion.sample.source,'hand-estimated');assert.equal(fusion.last.measuredAt,66);
  assert.ok(Math.abs(fusion.last.z-.95)<.002);
});

test('unsupported hand deformation cannot renew depth; it degrades to a labeled drawing plane', () => {
  const fusion=new HandPoseFusion();update(fusion,0,{});
  update(fusion,150,{mode:'none'});
  const f=rgbdHand({mode:'none'});
  for(const i of [5,9,13,17])f.hand[i].x=.1+i*.045;
  assert.ok(fusion.update(f.tip,f.frame,f.hand,200));assert.equal(fusion.sample.source,'depth-plane');
  update(fusion,240,{});
  update(fusion,390,{mode:'none'});
  assert.ok(update(fusion,440,{root:.5,mode:'none'}));assert.equal(fusion.sample.source,'depth-plane');
});

test('reset, out-of-order timestamps, a long frame gap and invalid points cannot revive cached depth', () => {
  const fusion=new HandPoseFusion();update(fusion,100,{});
  assert.equal(update(fusion,99,{mode:'none'}),null);assert.equal(fusion.last.measuredAt,100);
  assert.equal(update(fusion,351,{mode:'none'}),null);
  update(fusion,400,{});fusion.reset();assert.equal(update(fusion,433,{mode:'none'}),null);
  update(fusion,500,{});
  const f=rgbdHand();assert.equal(fusion.update({...f.tip,x:NaN},f.frame,f.hand,533),null);
  assert.equal(fusion.last,null);assert.equal(fusion.reference,null);
});

test('One Euro reduces static metric jitter while adaptive cutoff reduces fast-motion lag', () => {
  const filter=new OneEuroFilter(),fixed=new OneEuroFilter({beta:0});
  let rawEnergy=0,filteredEnergy=0;
  for(let i=0;i<120;i++) {
    const value=.5+(i%2?.004:-.004),smoothed=filter.filter(value,i*1000/30);
    if(i>30){rawEnergy+=(value-.5)**2;filteredEnergy+=(smoothed-.5)**2;}
  }
  assert.ok(filteredEnergy<rawEnergy*.15);
  filter.reset();filter.filter(0,0);fixed.filter(0,0);
  let adaptive,slow;
  for(let i=1;i<=10;i++){adaptive=filter.filter(i*.02,i*1000/30);slow=fixed.filter(i*.02,i*1000/30);}
  assert.ok(.2-adaptive<(.2-slow)*.7);
  assert.equal(filter.filter(NaN,400),null);assert.equal(filter.filter(.2,0),null);
  filter.reset();assert.equal(filter.filter(2,0),2);
});

test('real interaction and geometry keep one nonplanar stroke through long depth holes until actual release', () => {
  const projector=new DepthProjector(),target=new EventTarget(),scene=new Group();let stats;
  const project=(...args)=>projector.project(...args);project.reset=()=>projector.reset();
  const disconnect=connectInteraction(target,()=>({width:640,height:480}),project);
  const dispose=connectLiveDrawing(target,scene,value=>stats=value);
  const send=(timestamp,options)=>{
    const f=rgbdHand(options);
    target.dispatchEvent(new CustomEvent('kineglow:hands',{detail:{timestamp,source:'摄像头',landmarks:[f.hand],
      handedness:[[{categoryName:'Right'}]],depthFrame:f.frame}}));
  };
  try {
    send(0,{ratio:.6});send(80,{ratio:.6});send(160,{ratio:.6});send(200,{});send(280,{});
    for(let t=313;t<=1006;t+=33)send(t,{mode:'none',root:1-.1*(t-280)/726,shiftX:.05*Math.sin((t-280)/150)});
    assert.equal(stats.strokes,0);assert.equal(stats.active,true);
    assert.equal(stats.ends.depth,0);assert.ok(stats.segments>15);
    for(let t=1039;t<=1204;t+=33)send(t,{mode:'none',root:.9});
    assert.equal(stats.ends.depth,0);assert.equal(stats.ends.tracking,0);assert.equal(stats.ends.release,0);
    send(1237,{mode:'none'});assert.equal(stats.strokes,0);
    send(1270,{root:.9});send(1303,{root:.9,shiftX:.01});
    assert.equal(stats.active,true);assert.equal(stats.strokes,0);
    send(1336,{root:.9,ratio:.6});send(1402,{root:.9,ratio:.6});
    assert.equal(stats.strokes,1);
  } finally {disconnect();dispose();}
});
