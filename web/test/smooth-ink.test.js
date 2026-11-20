import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StrokeSmoother} from '../src/stroke-smoother.js';
import {connectInteraction} from '../src/interaction.js';
import {connectLiveDrawing} from '../src/live-drawing.js';
import {Scene} from 'three';

test('online smoothing suppresses alternating depth jitter on a figure eight and preserves endpoints and lobes',()=>{
  const raw=Array.from({length:97},(_,i)=>{
    const t=i*2*Math.PI/96;
    return {x:Math.sin(2*t),y:1.4*Math.sin(t),z:i===0||i===96?0:(i%2?.04:-.04)};
  });
  const path=[raw[0]], ink=new StrokeSmoother(p=>path.push(p));
  ink.begin(raw[0]);raw.slice(1).forEach(p=>ink.appendPoint(p));
  assert.ok(path.length>raw.length); // smooth points already emitted before release
  ink.finish();
  const variation=ps=>ps.slice(1).reduce((s,p,i)=>s+Math.abs(p.z-ps[i].z),0);
  assert.ok(variation(path)<.75*variation(raw));
  assert.deepEqual(path[0],raw[0]);assert.deepEqual(path.at(-1),raw.at(-1));
  assert.ok(path.some(p=>p.y>1.37)&&path.some(p=>p.y< -1.37));
  const top=path.findIndex(p=>p.y>1),bottom=path.findIndex(p=>p.y< -1);
  assert.ok(path.slice(top,bottom).some(p=>Math.hypot(p.x,p.y)<.15));
});

test('moving the fingertip during the release window never extends the finished mesh',()=>{
  const target=new EventTarget(),scene=new Scene();
  const off=connectInteraction(target,()=>({width:640,height:480}),(tip)=>({x:tip.x,y:0,z:0}));
  const dispose=connectLiveDrawing(target,scene);
  function frame(timestamp,x,ratio){
    const hand=Array.from({length:21},()=>({x:.5,y:.5,z:0}));
    hand[0].y=.8;hand[9].y=.3;hand[8].x=x;hand[4].x=x+.375*ratio;
    target.dispatchEvent(new CustomEvent('kineglow:hands',{detail:{timestamp,source:'摄像头',
      landmarks:[hand],handedness:[[{categoryName:'Right'}]]}}));
  }
  try {
    for(const t of [0,80,160])frame(t,.1,.6);
    for(const [t,x] of [[200,.1],[280,.1],[310,.2],[340,.3]])frame(t,x,.1);
    const mesh=scene.children[0].children[0],count=mesh.geometry.drawRange.count;
    frame(370,.45,.55);frame(390,.58,.55);
    assert.equal(mesh.geometry.drawRange.count,count);
    frame(415,.70,.55);
    const pos=mesh.geometry.attributes.position;
    assert.ok(Math.abs(Math.max(...Array.from({length:pos.count},(_,i)=>pos.getX(i)))-.3)<1e-6);
  }finally{off();dispose();}
});

test('slider changes the current stroke without rewriting it and zero returns to raw samples',()=>{
  const p=(x,y)=>({x,y,z:0}), raw=[p(0,0),p(.15,0),p(.15,.15),p(.3,.15),p(.3,.3)];
  let setting=0;
  const out=[],ink=new StrokeSmoother(pt=>out.push(pt),()=>setting);
  ink.begin(raw[0]);ink.appendPoint(raw[1]);ink.appendPoint(raw[2]);
  assert.deepEqual(out,raw.slice(1,3));
  const original=structuredClone(out);setting=1;ink.appendPoint(raw[3]);
  assert.deepEqual(out.slice(0,2),original);
  assert.notDeepEqual(out.at(-1),raw[3]);
  setting=0;ink.appendPoint(raw[4]);ink.finish();
  assert.deepEqual(out.slice(-2),raw.slice(-2));
});
