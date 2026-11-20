import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureOutcome,CaptureArming} from '../validation/human-protocol.js';
const files=['observation.json','input.webm','scene.png'];
test('human protocol: a byte/time limit advances without declaring the requested protocol complete',()=>{
  const result=captureOutcome({started:true,aborted:false,reason:'recorder-limit',files});
  assert.equal(result.advance,true);assert.equal(result.complete,false);assert.equal(result.status,'partial-at-limit');
  assert.deepEqual(result.files,files);
});
test('human protocol: aborting preparation never exports the previous group again',()=>{
  const result=captureOutcome({started:false,aborted:true,reason:'operator-aborted',files});
  assert.deepEqual(result.files,[]);assert.equal(result.advance,false);assert.equal(result.complete,false);
});
test('human protocol: a normal recording completes; a missing video stays explicitly incomplete',()=>{
  assert.equal(captureOutcome({started:true,aborted:false,reason:'duration',files}).complete,true);
  const missing=captureOutcome({started:true,aborted:false,reason:'duration',files:['observation.json']});
  assert.equal(missing.advance,false);assert.equal(missing.status,'export-incomplete');
});

test('human protocol: a fixed countdown cannot start static recording before a stable pinch',()=>{
  const gate=new CaptureArming(),sample=(timestamp,state='Pinching',x=0)=>({source:'摄像头',state,timestamp,position:{x,y:0}});
  assert.equal(gate.update(sample(7000,'Idle'),7000),false);
  assert.equal(gate.update(sample(7100),7100),false);
  assert.equal(gate.update(sample(8099),8099),false);
  assert.equal(gate.update(sample(8100),8100),true);
  assert.equal(gate.update(sample(8200,'Pinching',.2),8200),false);
  assert.equal(gate.update(sample(9100,'Pinching',.2),9100),false);
  assert.equal(gate.update(sample(9200,'Pinching',.2),9200),true);
});

test('human protocol: missing or stale observations revoke static arming',()=>{
  const gate=new CaptureArming(),sample=t=>({source:'摄像头',state:'Pinching',timestamp:t,position:{x:0,y:0}});
  gate.update(sample(0),0);assert.equal(gate.update(sample(0),1000),false);
  gate.update(sample(1000),1000);assert.equal(gate.update(null,1100),false);
  assert.equal(gate.update(sample(2100),2100),false);
});
