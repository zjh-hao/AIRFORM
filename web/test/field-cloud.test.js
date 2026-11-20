import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installFieldCloud} from '../src/field-cloud.js';

test('landing scatters, converges, breathes periodically, and stops when hidden or reduced',context=>{
  const listeners=new EventTarget(),motion=Object.assign(new EventTarget(),{matches:false});
  const previously=new Map();
  function inject(name,value){
    previously.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  }
  context.after(()=>{
    for(const [name,descriptor] of previously){
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);
      else delete globalThis[name];
    }
  });
  let scheduled=null,visibilityChanged=null,positions=[],clock=0;
  inject('performance',{now:()=>clock});
  const body={};
  const region=Object.assign(new EventTarget(),{
    getBoundingClientRect:()=>({width:720,height:480,left:530,top:100})});
  inject('document',Object.assign(listeners,{hidden:false,body}));
  inject('matchMedia',()=>motion);inject('devicePixelRatio',1);
  inject('ResizeObserver',class{observe(){} disconnect(){}});
  inject('MutationObserver',class{constructor(notify){visibilityChanged=notify;}observe(){} disconnect(){}});
  inject('requestAnimationFrame',callback=>{scheduled=callback;return 1;});
  inject('cancelAnimationFrame',()=>{scheduled=null;});
  const canvas=Object.assign(new EventTarget(),{
    parentElement:body,
    getBoundingClientRect:()=>({width:1280,height:720,left:0,top:0}),
    getContext:()=>({setTransform(){},clearRect(){positions=[];},fillRect(x,y){positions.push([x,y]);}})
  });
  const landing={hidden:false},dispose=installFieldCloud(canvas,landing,region);
  const draw=time=>{clock=time;const paint=scheduled;scheduled=null;paint(time);return positions;};
  try{
    const scattered=draw(0),incoming=draw(450);
    assert.equal(canvas.parentElement,body);
    assert.ok(scattered.every(([x,y])=>x<0||x>1280||y<0||y>720));
    assert.ok(incoming.some(([x,y])=>x>0&&x<530&&y>0&&y<720));
    const arriving=draw(2465),formed=draw(2500),inhaled=draw(3800),cycle=draw(7700);
    assert.equal(canvas.parentElement,body);
    assert.ok(arriving.every(([x,y],index)=>Math.hypot(x-formed[index][0],y-formed[index][1])<1));
    assert.equal(formed.length,5520);
    assert.ok(scattered.some(([x])=>x<0)&&scattered.some(([x])=>x>1280));
    assert.ok(scattered.some(([,y])=>y<0)&&scattered.some(([,y])=>y>720));
    assert.ok(formed.every(([x,y])=>x>=530&&x<=1250&&y>=100&&y<=580));
    assert.ok(formed.some(([x,y],index)=>Math.hypot(x-inhaled[index][0],y-inhaled[index][1])>3));
    assert.ok(formed.every(([x,y],index)=>Math.hypot(x-cycle[index][0],y-cycle[index][1])<1e-8));
    landing.hidden=true;visibilityChanged();assert.equal(scheduled,null);
    clock=60000;landing.hidden=false;visibilityChanged();assert.deepEqual(positions,cycle);
    motion.matches=true;motion.dispatchEvent(new Event('change'));
    assert.deepEqual(draw(60100),formed);assert.equal(scheduled,null);
  }finally{dispose();}
});
