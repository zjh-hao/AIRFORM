import '../test-support/three-loader.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install } from './p1.4-r-probe.js';
import { connectInteraction } from '../src/interaction.js';
const { connectLiveDrawing } = await import('../src/live-drawing.js');
const { StrokeEngine } = await import('../src/stroke-engine.js');
const { Scene } = await import('three');

test('diagnostic records derived input, exact engine outcomes and restores original methods', async () => {
  const names=['window','document','requestAnimationFrame','cancelAnimationFrame','PerformanceObserver','innerWidth','innerHeight','devicePixelRatio'];
  const originals=new Map(names.map(n=>[n,Object.getOwnPropertyDescriptor(globalThis,n)]));
  const originalAppend=StrokeEngine.prototype.appendPoint;
  const target=new EventTarget();
  const originalDispatch=target.dispatchEvent;
  const panel={style:{},remove(){}};
  const document=new EventTarget();
  Object.assign(document,{hidden:false,createElement:()=>panel,body:{append(){}},querySelector:s=>({
    '#camera':{width:640,height:480},'#tracking':{textContent:'推理 本帧 12.3'},
    '#render-metrics':{textContent:'test'},video:{videoWidth:640,videoHeight:480},
  })[s]});
  Object.assign(globalThis,{window:target,document,requestAnimationFrame:()=>1,cancelAnimationFrame(){},
    PerformanceObserver:class {static supportedEntryTypes=[];takeRecords(){return [];}disconnect(){}},
    innerWidth:1280,innerHeight:900,devicePixelRatio:1});
  let cleanup,disconnect;
  try {
    disconnect=connectInteraction(target,()=>({width:640,height:480}));
    const scene=new Scene(); cleanup=connectLiveDrawing(target,scene);
    // Match the real page: production listeners exist before instrumentation.
    await install(new URL('../src/stroke-engine.js',import.meta.url).href,'self-check-synthetic');
    const frame=(timestamp,ratio=.6,x=.3,labels=['Right'])=>{
      const points=Array.from({length:21},()=>({x:.5,y:.5,z:0}));
      points[0].y=.8;points[9].y=.3;points[8].x=x;points[4].x=x+ratio*.375;
      target.dispatchEvent(new CustomEvent('kineglow:hands',{detail:{timestamp,source:'摄像头',landmarks:[points],handedness:labels.map(categoryName=>[{categoryName}])}}));
    };
    frame(0);frame(80);frame(160);frame(240,.1);frame(320,.1);frame(340,.1,.4);
    frame(360,.6);frame(380,.1,.4,[]);
    const render=function(){};
    const renderer={render,info:{render:{calls:1,triangles:2},memory:{geometries:1}}};
    target.P14R.attachRenderer(renderer);renderer.render();
    const result=target.P14R.stop();
    assert.equal(result.records.length,8);
    assert.equal(result.records[5].calls[0].name,'appendPoint');
    assert.equal(result.records[5].calls[0].segmentsDelta,1);
    assert.ok(Math.abs(result.records[5].calls[0].acceptedDistance-.6)<1e-12);
    assert.equal(result.records[6].state,'Pinching');
    assert.equal(result.records[6].calls.length,0); // first open sample freezes ink
    assert.equal(result.records[7].rightCount,0);
    assert.equal(result.records[7].state,'TrackingLost');
    assert.equal(result.transitions.length,5);
    assert.deepEqual(result.probeErrors,[]);
    assert.equal(target.dispatchEvent,originalDispatch);
    assert.equal(StrokeEngine.prototype.appendPoint,originalAppend);
    assert.equal(renderer.render,render);
    assert.equal(result.render.length,1);
    assert.equal(target.P14R.stop(),result);
    assert.equal(/"landmarks"|"handedness"|"point"|"bitmap"/.test(JSON.stringify(result)),false);
  } finally {
    target.P14R?.stop();disconnect?.();cleanup?.();
    for(const [name,descriptor] of originals) {
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  }
});
