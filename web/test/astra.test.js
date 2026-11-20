import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapDepthPoint, measuredPoint, sampleTipDepth, sampleHandDepth, DepthProjector, validateDepthFrame } from '../src/depth-point.js';
import { AstraSession, unpackAstraFrame } from '../src/astra-session.js';
import { HandInteraction, connectInteraction } from '../src/interaction.js';
import { connectLiveDrawing } from '../src/live-drawing.js';
import { Group } from 'three';
import { DRAWING_GAIN } from '../src/drawing-gain.js';

function frame(mm = 1000) {
  return { width: 640, height: 480, intrinsics: [500, 500, 320, 240], distortion: [0, 0, 0, 0, 0],
    depth_unit: 'mm', coordinate_system: 'color-camera', mirrored: false,
    registration: 'factory-calibrated-software', depth: new Uint16Array(640 * 480).fill(mm) };
}
function packet(sequence = 1) {
  const { depth, ...metadata } = frame();
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  const header = new TextEncoder().encode(JSON.stringify({ ...metadata, version: 1, sequence,
    jpeg_bytes: jpeg.length, depth_bytes: depth.byteLength }));
  const buffer = new ArrayBuffer(4 + header.length + jpeg.length + depth.byteLength);
  new DataView(buffer).setUint32(0, header.length, true);
  const bytes = new Uint8Array(buffer);
  bytes.set(header, 4); bytes.set(jpeg, 4 + header.length);
  bytes.set(new Uint8Array(depth.buffer), 4 + header.length + jpeg.length);
  return buffer;
}
const response = sequence => ({ ok: true, status: 200, arrayBuffer: async () => packet(sequence) });

test('Astra measured millimeters become metric XYZ and mirrored spatial scene coordinates', () => {
  const f = validateDepthFrame(frame());
  assert.deepEqual(measuredPoint({ x: .5, y: .5 }, f), { x: 0, y: 0, z: 1 });
  assert.deepEqual(mapDepthPoint({ x: .5, y: .5 }, f), { x: -0, y: -0, z: 0 });
  assert.deepEqual(measuredPoint({ x: .75, y: .5 }, f), { x: .32, y: 0, z: 1 });
  assert.equal(mapDepthPoint({ x: .75, y: .5 }, f).x, -1.6);
  assert.equal(mapDepthPoint({ x: .5, y: .5 }, frame(600)).z, 2);
  assert.equal(mapDepthPoint({ x: .5, y: .5 }, frame(1400)).z, -1.9999999999999996);
});

test('inverse distortion recovers a forward-projected point rather than treating distorted pixels as rays', () => {
  const f = frame(), [x, y] = [.2, -.15];
  const [k1, k2, p1, p2, k3] = f.distortion = [.1, -.15, -.0005, -.003, -.1];
  const r2 = x*x+y*y, radial = 1+r2*(k1+r2*(k2+r2*k3));
  const u = 500*(x*radial+2*p1*x*y+p2*(r2+2*x*x))+320;
  const v = 500*(y*radial+p1*(r2+2*y*y)+2*p2*x*y)+240;
  const p = measuredPoint({ x: u/640, y: v/480 }, f);
  assert.ok(Math.abs(p.x-x)<.002); assert.ok(Math.abs(p.y-y)<.002);
});

test('depth holes fail closed while coherent finger depth survives background and isolated outliers', () => {
  for (const f of [frame(0), frame(65535)]) assert.equal(mapDepthPoint({ x: .5, y: .5 }, f), null);
  const f = frame(); f.depth[240*640+320]=1500;
  assert.equal(measuredPoint({ x: .5, y: .5 }, f).z, 1);
  for (let y=238;y<=242;y++)for(let x=318;x<=322;x++)f.depth[y*640+x]=x<320?750:1600;
  assert.equal(sampleTipDepth({x:.5,y:.5},f).z,.75);
  assert.equal(mapDepthPoint({ x: -.01, y: .5 }, frame()), null);
  assert.equal(mapDepthPoint({ x: .5, y: .5 }, null), null);
  for (const bad of [{...frame(),mirrored:true},{...frame(),depth_unit:'m'},{...frame(),intrinsics:[0,500,320,240]}]) {
    assert.throws(()=>validateDepthFrame(bad));
  }
});

test('bounded sampling toward the distal finger finds current measured depth without palm or stale fallback', () => {
  const f=frame(0),hand=Array.from({length:21},()=>({x:.5,y:.5}));
  hand[7]={x:.5,y:.55};
  for(let y=246;y<=252;y++)for(let x=318;x<=322;x++)f.depth[y*640+x]=720;
  assert.equal(sampleTipDepth(hand[8],f).reason.includes('没有可靠深度'),true);
  const sample=sampleTipDepth(hand[8],f,hand);
  assert.equal(sample.z,.72);assert.ok(sample.insetPixels<=10);
  assert.equal(measuredPoint(hand[8],frame(0),hand),null);
  const distant=frame(0);
  for(let y=275;y<=285;y++)for(let x=318;x<=322;x++)distant.depth[y*640+x]=720;
  assert.equal(measuredPoint(hand[8],distant,hand),null);
});

function palmFixture(anchors = [0,5,9,13,17]) {
  const f=frame(0),hand=Array.from({length:21},()=>({x:.5,y:.65,z:0}));
  hand[0]={x:.5,y:.8,z:0};hand[5]={x:.45,y:.6,z:0};hand[9]={x:.5,y:.6,z:0};
  hand[13]={x:.55,y:.6,z:0};hand[17]={x:.6,y:.65,z:0};
  hand[8]={x:.5,y:.3,z:-.05};hand[7]={x:.5,y:.33,z:-.04};
  for(const i of anchors){const u=Math.round(hand[i].x*640),v=Math.round(hand[i].y*480);
    for(let y=v-2;y<=v+2;y++)for(let x=u-2;x<=u+2;x++)f.depth[y*640+x]=1000;}
  return {f,hand};
}

test('occluded fingertip uses agreeing CURRENT palm depths plus a labeled relative model offset', () => {
  const {f,hand}=palmFixture();
  const sample=sampleHandDepth(hand[8],f,hand);
  assert.equal(sample.source,'hand-estimated');assert.equal(sample.anchors,5);
  assert.ok(Math.abs(sample.z-.936)<1e-12);
  assert.equal(sampleHandDepth(hand[8],frame(0),hand).source,'invalid');
  const one=palmFixture([0]);
  assert.equal(sampleHandDepth(one.hand[8],one.f,one.hand).source,'invalid');
  assert.equal(sampleHandDepth({...hand[8],x:-.1},f,hand).source,'invalid');
  for(let y=142;y<=146;y++)for(let x=318;x<=322;x++)f.depth[y*640+x]=3000;
  const background=sampleHandDepth(hand[8],f,hand);
  assert.equal(background.source,'hand-estimated');assert.ok(Math.abs(background.z-.936)<1e-12);
});

test('visible RGB tip keeps drawing on the previous depth plane without inventing fresh measurements', () => {
  const projector=new DepthProjector(),tip={x:.5,y:.5,z:0};
  assert.ok(projector.project(tip,frame(),null,0));
  // Small motion remains below the planar outlier threshold. Without palm
  // landmarks this test exercises the explicit image-scale fallback only.
  const held=projector.project({...tip,x:.54},frame(0),null,100);
  assert.ok(held.x < 0 && held.x > -.256*DRAWING_GAIN.multiplier);
  assert.equal(projector.sample.source,'depth-plane');assert.equal(projector.sample.ageMs,100);
  assert.ok(projector.project(tip,frame(0),null,180));
  assert.ok(projector.project(tip,frame(0),null,181));
  assert.ok(projector.project(tip,frame(0),null,220));assert.equal(projector.last.measuredAt,0);
  assert.ok(projector.project(tip,frame(800),null,240));
  assert.equal(projector.sample.source,'tip-measured');
});

test('depth filter reduces source-switch jumps; explicit reset removes any held range', () => {
  const projector=new DepthProjector(),tip={x:.5,y:.5,z:0};
  projector.project(tip,frame(),null,0);
  const moved=projector.project(tip,frame(1040),null,30);
  assert.ok(moved.z<0&&moved.z>-.2);
  projector.reset();
  assert.equal(projector.project(tip,frame(0),null,40),null);
});

test('actual RGB tracking loss resets depth continuity immediately and cannot reuse the old hand', () => {
  const projector=new DepthProjector();
  const project=(tip,f,hand,t)=>projector.project(tip,f,hand,t);project.reset=()=>projector.reset();
  const machine=new HandInteraction(project);
  const hand=Array.from({length:21},()=>({x:.5,y:.5,z:0}));
  hand[0]={x:.5,y:.8,z:0};hand[9]={x:.5,y:.3,z:0};hand[4]={x:.75,y:.5,z:0};
  const input=t=>({timestamp:t,source:'摄像头',landmarks:[hand],handedness:[[{categoryName:'Right'}]],depthFrame:frame()});
  machine.update(input(0),640,480);machine.update(input(80),640,480);machine.update(input(160),640,480);
  assert.notEqual(projector.last,null);
  assert.equal(machine.update({...input(180),landmarks:[],handedness:[]},640,480).state,'TrackingLost');
  assert.equal(projector.last,null);
  assert.equal(projector.project(hand[8],frame(0),hand,190),null);
});

test('occluded-tip RGB-D sequence and short whole-hand depth holes produce one continuous real stroke', () => {
  const projector=new DepthProjector(),target=new EventTarget(),scene=new Group();
  const project=(tip,f,hand,t)=>projector.project(tip,f,hand,t);project.reset=()=>projector.reset();
  const disconnect=connectInteraction(target,()=>({width:640,height:480}),project);
  let latest;
  const dispose=connectLiveDrawing(target,scene,stats=>latest=stats);
  function send(timestamp,ratio,empty=false) {
    const {f,hand}=palmFixture();
    hand[8].x=.5+Math.max(0,timestamp-280)/4000;hand[7].x=hand[8].x;
    hand[4]={x:hand[8].x+ratio*.2*480/640,y:hand[8].y,z:hand[8].z};
    target.dispatchEvent(new CustomEvent('kineglow:hands',{detail:{timestamp,source:'摄像头',
      landmarks:[hand],handedness:[[{categoryName:'Right'}]],depthFrame:empty?frame(0):f}}));
  }
  try {
    send(0,.6);send(80,.6);send(160,.6);send(200,.1);send(280,.1);
    for(let t=320;t<=640;t+=40)send(t,.1,t===400||t===440);
    send(680,.6);send(720,.6);
    assert.equal(latest.strokes,1);assert.ok(latest.segments>=8);
    assert.equal(latest.ends.depth,0);assert.equal(latest.ends.tracking,0);assert.equal(latest.ends.release,1);
  } finally {disconnect();dispose();}
});

test('depth-only holes preserve the recognized pinch; valid depth can resume without forced reopening', () => {
  const m = new HandInteraction(mapDepthPoint);
  function update(t, ratio, depthFrame=frame()) {
    const p=Array.from({length:21},()=>({x:.5,y:.5}));
    p[0]={x:.5,y:.8};p[9]={x:.5,y:.3};p[4]={x:.5+ratio*.5*480/640,y:.5};
    return m.update({timestamp:t,source:'摄像头',landmarks:[p],handedness:[[{categoryName:'Right'}]],depthFrame},640,480);
  }
  update(0,.6);update(80,.6);assert.equal(update(160,.6).state,'Idle');
  update(200,.1);assert.equal(update(280,.1).state,'Pinching');
  const hole=update(300,.1,frame(0));
  assert.equal(hole.state,'Pinching');assert.equal(hole.point,null);assert.equal(hole.handIndex,0);
  const recovered=update(340,.1);
  assert.equal(recovered.state,'Pinching');assert.notEqual(recovered.point,null);
  update(380,.6);assert.equal(update(420,.6).state,'Idle');
});

test('startup can unlock using RGB landmarks while depth has holes, but a closed hand cannot bypass startup', () => {
  const m=new HandInteraction(mapDepthPoint);
  const p=Array.from({length:21},()=>({x:.5,y:.5}));p[0]={x:.5,y:.8};p[9]={x:.5,y:.3};
  function update(t,ratio,depth=frame(0)){
    p[4]={x:.5+ratio*.5*480/640,y:.5};
    return m.update({timestamp:t,source:'摄像头',landmarks:[p],handedness:[[{categoryName:'Right'}]],depthFrame:depth},640,480);
  }
  update(0,.1);update(80,.1);assert.equal(update(160,.1).state,'Rearming');
  update(200,.6);assert.equal(update(280,.6).state,'Idle');
  update(320,.1);assert.equal(update(400,.1).state,'Pinching');
  assert.notEqual(update(440,.1,frame()).point,null);
});

test('packet decoding validates version, bounds and complete depth; never accepts truncation', () => {
  const decoded=unpackAstraFrame(packet());
  assert.equal(decoded.frame.depth[0],1000);assert.equal(decoded.image.size,4);
  assert.throws(()=>unpackAstraFrame(new ArrayBuffer(0)));
  assert.throws(()=>unpackAstraFrame(packet().slice(0,-1)));
  const corrupt=packet();new DataView(corrupt).setUint32(0,999999,true);
  assert.throws(()=>unpackAstraFrame(corrupt));
});

test('short depth holes pause then bridge the same nonplanar stroke; Stop finalizes it', () => {
  const target=new EventTarget(),scene=new Group();
  const disconnect=connectInteraction(target,()=>({width:640,height:480}),mapDepthPoint);
  const dispose=connectLiveDrawing(target,scene);
  function send(timestamp,ratio,mm=1000) {
    const p=Array.from({length:21},()=>({x:.5,y:.5}));
    p[0]={x:.5,y:.8};p[9]={x:.5,y:.3};p[4]={x:.5+ratio*.5*480/640,y:.5};
    target.dispatchEvent(new CustomEvent('kineglow:hands',{detail:{timestamp,source:'摄像头',
      landmarks:[p],handedness:[[{categoryName:'Right'}]],depthFrame:frame(mm)}}));
  }
  try {
    send(0,.6);send(80,.6);send(160,.6);send(200,.1);send(280,.1);
    send(320,.1,1100);send(360,.1,900);send(400,.1,0);
    const meshes=scene.children[0].children;
    assert.equal(meshes.length,1);
    const positions=meshes[0].geometry.attributes.position;
    const zs=Array.from({length:positions.count},(_,i)=>positions.getZ(i));
    // First depth extremum is immediate; the live rounded edge can be up
    // to 0.10 scene units behind the newest accepted sample.
    assert.ok(Math.min(...zs)<-.49);assert.ok(Math.max(...zs)>.39);
    const count=meshes[0].geometry.drawRange.count;
    send(440,.1,1200);send(520,.1,1200);send(600,.1,1200);
    assert.ok(meshes[0].geometry.drawRange.count>count);
    assert.equal(meshes.length,1);
    send(640,.1,1100);
    assert.equal(meshes.length,1);
    target.dispatchEvent(new CustomEvent('kineglow:interaction',{detail:{state:'TrackingLost',source:'stopped',point:null,timestamp:660}}));
    const ended=meshes[0].geometry.attributes.position;
    assert.ok(Math.min(...Array.from({length:ended.count},(_,i)=>ended.getZ(i)))<-.9);
  } finally {disconnect();dispose();}
  assert.equal(scene.children.length,0);
});

test('late start after Stop releases its own token without publishing a frame', async () => {
  let resolveStart, calls=[], detects=0;
  const s=new AstraSession({detect:()=>detects++,stopped:()=>{},
    post:async(action,body)=>{calls.push([action,body]);if(action==='start')return new Promise(r=>resolveStart=r);return {};}});
  const pending=s.start();await new Promise(setImmediate);s.stop();resolveStart({session:'old'});
  assert.equal(await pending,false);assert.equal(detects,0);
  assert.deepEqual(calls.at(-1),['stop',{session:'old'}]);assert.equal(s.running,false);
});

test('a restart during Astra startup waits for the abandoned lease to be released', async () => {
  let completeStart, completeStop;
  const calls = [];
  const flush = () => new Promise(setImmediate);
  const s = new AstraSession({detect:()=>{}, stopped:()=>{}, post:async(action,body)=>{
    calls.push([action,body]);
    if (action === 'stop') return new Promise(resolve => { completeStop = resolve; });
    if (calls.length === 1) return new Promise(resolve => { completeStart = resolve; });
    throw Error('test complete');
  }});
  const first = s.start();
  await flush();
  const stopping = s.stop();
  const restarted = s.start();
  completeStart({session:'old'});
  await flush();
  assert.deepEqual(calls.map(([action])=>action),['start','stop']);
  completeStop({});
  await stopping;
  assert.equal(await first,false);
  assert.equal(await restarted,false);
  assert.deepEqual(calls.map(([action])=>action),['start','stop','start']);
});

test('one frame/inference in flight; Stop suppresses late inference results and closes image', async () => {
  let finish,closed=0,detects=0;
  const s=new AstraSession({post:async()=>({session:'s'}),get:async()=>response(1),
    decode:async()=>({width:640,height:480,close:()=>closed++}),stopped:()=>{},
    detect:async(_bitmap,current)=>{detects++;await new Promise(r=>finish=r);assert.equal(current(),false);}});
  const pending=s.start();await new Promise(setImmediate);
  assert.equal(detects,1);await s.stop();finish();
  assert.equal(await pending,false);assert.equal(closed,1);assert.equal(detects,1);
});

test('frame failure releases the camera; a later start can recover after rejected inflight work', async () => {
  let starts=0,stops=0,messages=[];
  const s=new AstraSession({post:async action=>{if(action==='start')return {session:String(++starts)};stops++;return{};},
    get:async()=>{throw new Error('disconnect');},detect:()=>{},stopped:message=>messages.push(message)});
  assert.equal(await s.start(),false);await s.releasing;
  assert.equal(await s.start(),false);await s.releasing;
  assert.equal(starts,2);assert.equal(stops,2);assert.equal(s.running,false);
  assert.ok(messages.every(message=>message.includes('disconnect')));
});

test('slow Astra inference consumes only the newest intact RGB-D pair and aborts the outstanding pull on stop', async () => {
  const pending = [], seen = [], closed = [], displayed = []; let finish, decoded=0, inflight=0;
  const session = new AstraSession({post:async()=>({session:'s'}),stopped:()=>{},
    get:(_url,signal)=>new Promise((resolve,reject)=>{pending.push(resolve);signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true});}),
    decode:async()=>{const id=++decoded;return {width:640,height:480,id,close:()=>closed.push(id)};},
    preview:bitmap=>displayed.push(bitmap.id),
    detect:async(bitmap,_current,_label,frame)=>{assert.equal(++inflight,1);seen.push([bitmap.id,frame.sequence]);
      if(frame.sequence===2)await new Promise(resolve=>{finish=resolve;});inflight--;}});
  const starting=session.start(); const flush=()=>new Promise(setImmediate);
  await flush();pending.shift()(response(1));await starting;
  for(const sequence of [2,3,4]){pending.shift()(response(sequence));await flush();}
  assert.deepEqual(displayed,[1,2,3,4]);assert.deepEqual(seen,[[1,1],[2,2]]);
  finish();await flush();assert.deepEqual(seen,[[1,1],[2,2],[4,4]]);
  const signal=session.controller.signal;await session.stop();assert.ok(signal.aborted);assert.deepEqual(closed.sort(),[1,2,3,4]);
});
