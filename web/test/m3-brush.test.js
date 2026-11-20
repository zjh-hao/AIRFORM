import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../test-support/three-loader.js';
import {BRUSH_COLORS,BrushWidth} from '../src/mineral-brush.js';
const {Scene}=await import('three');
const {connectLiveDrawing}=await import('../src/live-drawing.js');

function widthAt(speed,ratio){
  const width=new BrushWidth();width.reset();
  for(let time=0;time<=800;time+=25)width.observe({x:speed*time/1000,y:0,z:0},time,ratio);
  return width;
}
test('M3: speed and tighter pinch affect width independently, gaps do not create spikes',()=>{
  const slow=widthAt(.2,.1),fast=widthAt(6,.1);
  assert.ok(slow.scale>fast.scale && slow.scale<1.5 && fast.scale>.5);
  assert.ok(fast.scale>widthAt(6,.3).scale);
  const prior=slow.scale;assert.equal(slow.observe({x:20,y:0,z:0},1400,.2),prior);
  slow.reset();assert.equal(slow.scale,1);
});
test('M3: color is latched per stroke; actual ring radii respond without moving endpoints',()=>{
  const target=new EventTarget(),scene=new Scene();let color=BRUSH_COLORS[0][1];
  const close=connectLiveDrawing(target,scene,null,()=>0,()=>({color,size:3,mineral:true}));
  const send=(timestamp,x,state='Pinching')=>target.dispatchEvent(new CustomEvent('kineglow:interaction',{
    detail:{source:'摄像头',timestamp,point:{x,y:0,z:0},state,ratio:.15}}));
  try{
    for(let index=0;index<=20;index++)send(index*25,index*.004);
    color=BRUSH_COLORS[2][1];
    for(let index=1;index<=20;index++)send(500+index*25,.08+index*.15);
    send(1025,3.08,'Idle');send(1100,0);send(1125,.1);send(1150,.1,'Idle');
    const [first,second]=scene.children[0].children;
    assert.equal('#'+first.material.emissive.getHexString(),BRUSH_COLORS[0][1]);
    assert.equal('#'+second.material.emissive.getHexString(),color);
    const positions=first.geometry.attributes.position;
    const radius=ring=>Math.hypot(positions.getY(26+12*ring),positions.getZ(26+12*ring));
    assert.ok(radius(18)>radius(35));assert.ok(radius(0)<radius(18));assert.ok(radius(40)<radius(35));
    assert.ok(Math.abs(positions.getX(13)-3.08)<1e-5);
  }finally{close();}
});
