import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ValidationRecording,encodeDepth,decodeDepth,validateRecording,summarizeRecording} from '../src/validation-recording.js';
import {worldHand} from '../test-support/world-hand.js';

test('M1 recording: aligned millimetre depth survives lossless gzip/JSON round trip',async()=>{
  const depth=new Uint16Array([0,1,255,256,700,65535,1024,4096]);
  const frame={width:4,height:2,depth,intrinsics:[500,500,2,1],depth_unit:'mm',depth_index:7};
  const encoded=await encodeDepth(frame);
  depth[0]=900; // Encoding owns its immutable byte copy.
  const decoded=await decodeDepth(JSON.parse(JSON.stringify(encoded)));
  assert.deepEqual([...decoded.depth],[0,1,255,256,700,65535,1024,4096]);
  assert.deepEqual(decoded.intrinsics,frame.intrinsics);assert.equal(decoded.depth_index,7);
  await assert.rejects(()=>decodeDepth({...encoded,width:2}),/长度|超限/);
  await assert.rejects(()=>decodeDepth({...encoded,depthEncoding:'unknown'}),/格式/);
});

test('M1 recording: captures missed detections and explicitly excludes held frames from detection counts',async()=>{
  const recording=new ValidationRecording();recording.start({width:640,height:480,input:'webcam'});
  const first=worldHand({timestamp:1000});
  await recording.record(first,{timestamp:1000,observationValid:true,cursorSource:'filtered'},{inferenceMs:10});
  first.landmarks[0][8].x=999;
  await recording.record(worldHand({timestamp:1033,missing:true}),{timestamp:1033,observationValid:false,cursorSource:'held'},{inferenceMs:12});
  const data=await recording.stop();
  assert.equal(validateRecording(data),data);assert.equal(data.frames[0].timestamp,0);
  assert.notEqual(data.frames[0].landmarks[0][8].x,999);
  assert.equal(data.metrics.frames,2);assert.equal(data.metrics.detectedHandFraction,.5);
  assert.equal(data.metrics.qualifiedInteractionFraction,.5);assert.equal(data.metrics.heldCursorFrames,1);
  assert.equal(data.metrics.physicalEndToEndMs,null);assert.equal(data.metrics.meanInferenceMs,11);
  await recording.record(worldHand({timestamp:1066}),null);assert.equal(data.frames.length,2);
});

test('M1 recording: resource limits stop explicitly and replay never records itself',async()=>{
  const recording=new ValidationRecording({frames:1});recording.start({width:640,height:480,input:'webcam'});
  await recording.record({...worldHand(),origin:'replay'},null);assert.equal(recording.data.frames.length,0);
  await recording.record(worldHand(),null);await recording.record(worldHand({timestamp:33}),null);
  const data=await recording.stop();assert.equal(data.frames.length,1);assert.equal(data.stopReason,'time-or-frame-limit');
  const small=new ValidationRecording({bytes:1});small.start({width:640,height:480,input:'webcam'});
  await small.record(worldHand(),null);assert.equal((await small.stop()).stopReason,'byte-limit');
});

test('M1 recording: replay rejects nonmonotonic time, invalid points, dimensions and incomplete RGB-D',async()=>{
  const recording=new ValidationRecording();recording.start({width:640,height:480,input:'webcam'});
  await recording.record(worldHand(),null);await recording.record(worldHand({timestamp:33}),null);
  const data=await recording.stop();
  for(const mutate of [d=>d.frames[1].timestamp=0,d=>d.frames[0].landmarks[0][8].x=NaN,
    d=>d.metadata.width=Infinity,d=>d.metadata.input='astra']) {
    const invalid=structuredClone(data);mutate(invalid);assert.throws(()=>validateRecording(invalid));
  }
});

test('M1 recording: legacy baseline reports qualified right-hand frames using its original event contract',()=>{
  const data={frames:[{timestamp:0,landmarks:[[]],interaction:{handIndex:0},timings:{}},
    {timestamp:33,landmarks:[],interaction:{handIndex:null},timings:{}}]};
  assert.equal(summarizeRecording(data).qualifiedInteractionFraction,.5);
});
