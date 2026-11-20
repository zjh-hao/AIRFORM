import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CameraSession } from '../src/camera.js';
import { DetectorWorker } from '../src/detector.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function camera(detect) {
  const callbacks = [], tracks = [];
  let stops = 0;
  const video = { readyState: 2, currentTime: 1, play: async () => {}, pause() {} };
  const session = new CameraSession({ video, detect, acquire: async () => {
    const track = { released: false, stop() { this.released = true; }, addEventListener() {} };
    tracks.push(track); return { getTracks: () => [track], getVideoTracks: () => [track] };
  }, stopped: () => stops++, schedule: cb => { callbacks.push(cb); return callbacks.length; }, cancel() {} });
  return { session, video, tracks, callbacks, stops: () => stops };
}
test('async stop/restart never overlaps inference or publishes a stale result', async () => {
  const pending = deferred(); let calls = 0, published = 0;
  const h = camera(async (_, current) => { calls++; await pending.promise; if (current()) published++; });
  const first = h.session.start(); await flush();
  assert.equal(calls, 1);
  h.session.stop(); assert.equal(h.video.srcObject, null); assert.ok(h.tracks[0].released);
  const second = h.session.start(); assert.equal(await second, true);
  h.video.currentTime++; await h.callbacks.shift()();
  assert.equal(calls, 1);
  pending.resolve(); assert.equal(await first, false); assert.equal(published, 0);
  await h.callbacks.shift()(); assert.equal(calls, 2); assert.equal(published, 1);
  h.session.stop(); assert.ok(h.tracks[1].released);
});
test('late rejected inference cannot stop a restarted camera; active rejection releases it', async () => {
  const pending = deferred(); const h = camera(() => pending.promise);
  const first = h.session.start(); await flush(); h.session.stop(); await h.session.start();
  pending.reject(new Error('old worker failure')); assert.equal(await first, false);
  assert.equal(h.session.running, true); assert.equal(h.stops(), 1); h.session.stop();
  const other = camera(async () => { throw new Error('worker failed'); });
  assert.equal(await other.session.start(), false); assert.ok(other.tracks[0].released);
});
test('Stop while play is pending prevents inference and reactivation', async () => {
  const pending = deferred(); let calls = 0; const h = camera(() => calls++);
  h.video.play = () => pending.promise;
  const first = h.session.start(); await flush(); h.session.stop(); pending.resolve();
  assert.equal(await first, false); assert.equal(calls, 0); assert.ok(h.tracks[0].released);
});
function workerClient() {
  const sent = []; let terminated = 0;
  const worker = { postMessage: (...args) => sent.push(args), terminate: () => terminated++ };
  return { worker, sent, client: new DetectorWorker(worker), terminated: () => terminated };
}
test('decoded camera frames coalesce to the newest while busy; repeated or stopped callbacks do not infer', async () => {
  const blocked = deferred(), seen = [];
  const h = camera(async video => { seen.push(video.currentTime); if (seen.length === 1) await blocked.promise; });
  let callback, cancelled;
  h.video.requestVideoFrameCallback = next => { callback = next; return 17; };
  h.video.cancelVideoFrameCallback = token => { cancelled = token; };
  const present = index => { h.video.currentTime = index / 30; callback(0, {presentedFrames:index}); };
  await h.session.start(); present(1); present(2); present(3);
  assert.deepEqual(seen, [1/30]); blocked.resolve(); await flush();
  present(3); assert.deepEqual(seen, [1/30,3/30]);
  h.session.stop(); present(4); assert.equal(cancelled,17); assert.equal(seen.length,2);
});
test('worker transfers one bitmap at a time and rejects queued requests without leaking bitmaps', async () => {
  const h = workerClient(); let closed = 0;
  const bitmap = { close: () => closed++ };
  const first = h.client.request({ bitmap }, [bitmap]);
  await assert.rejects(h.client.request({ bitmap }), /已有推理/); assert.equal(closed, 1);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0][1][0], bitmap);
  const result = { landmarks: [[{ x: .123456789, y: .2, z: -.3 }]] };
  h.worker.onmessage({ data: { result, bitmap } }); assert.equal((await first).result, result);
  const next = h.client.request({ type: 'init' }); h.worker.onmessage({ data: { delegate: 'GPU' } });
  assert.equal((await next).delegate, 'GPU'); h.client.close();
});
test('worker close/crash/decode failure rejects pending work; orphaned replies release bitmaps', async () => {
  for (const failure of ['close', 'error', 'decode']) {
    const h = workerClient(); const pending = h.client.request({ type: 'init' });
    if (failure === 'close') h.client.close();
    if (failure === 'error') h.worker.onerror({ message: 'crashed', preventDefault() {} });
    if (failure === 'decode') h.worker.onmessageerror();
    await assert.rejects(pending); h.client.close(); assert.equal(h.terminated(), 1);
    let closed = 0; h.worker.onmessage({ data: { bitmap: { close: () => closed++ } } }); assert.equal(closed, 1);
    await assert.rejects(h.client.request({}), /已关闭/);
  }
});
test('worker postMessage and detector errors release/reject without wedging the next request', async () => {
  const h = workerClient(); h.worker.postMessage = () => { throw new Error('transfer failed'); };
  let closed = 0;
  await assert.rejects(h.client.request({ bitmap: { close: () => closed++ } }), /transfer failed/);
  assert.equal(closed, 1); assert.equal(h.client.pending, null);
  h.worker.postMessage = () => {};
  const pending = h.client.request({}); h.worker.onmessage({ data: { error: 'detect failed' } });
  await assert.rejects(pending, /detect failed/); assert.equal(h.client.pending, null);
});
for (const requestedMode of [undefined, 'IMAGE']) test(`classic worker ${requestedMode ?? 'default VIDEO'} falls back GPU→CPU and returns unchanged results plus the matching frame`, async () => {
  const expectedMode = requestedMode ?? 'VIDEO';
  const messages = [], delegates = []; let released = 0, fail = false;
  const result = { landmarks: [], worldLandmarks: [], handedness: [] };
  const bitmap = { close: () => released++ };
  const self = { postMessage: (...args) => messages.push(args) };
  vm.runInNewContext(readFileSync(new URL('../src/tracking-worker.js', import.meta.url), 'utf8'), {
    self, importScripts() {}, OffscreenCanvas: class {}, performance: { now: () => 10 },
    Vision: { FilesetResolver: { forVisionTasks: async () => ({}) }, HandLandmarker: { createFromOptions: async (_, options) => {
      delegates.push(options.baseOptions.delegate); assert.equal(options.numHands, 2); assert.equal(options.runningMode, expectedMode);
      if (options.baseOptions.delegate === 'GPU') throw new Error('GPU unavailable');
      return { [expectedMode === 'IMAGE' ? 'detect' : 'detectForVideo']: (...args) => {
        assert.deepEqual(args, expectedMode === 'IMAGE' ? [bitmap] : [bitmap, 123.456789]);
        if (fail) throw new Error('detection failed');
        return result;
      } };
    } } },
  });
  await self.onmessage({ data: { type: 'init', delegate: 'GPU', runningMode: requestedMode } });
  assert.deepEqual(delegates, ['GPU', 'CPU']); assert.equal(messages[0][0].delegate, 'CPU');
  assert.equal(messages[0][0].runningMode, expectedMode);
  await self.onmessage({ data: { type: 'detect', bitmap, timestamp: 123.456789 } });
  assert.equal(messages[1][0].result, result); assert.equal(messages[1][1][0], bitmap); assert.equal(released, 0);
  fail = true; await self.onmessage({ data: { type: 'detect', bitmap, timestamp: 123.456789 } });
  assert.equal(messages[2][0].error, 'detection failed'); assert.equal(released, 1);
});

test('live reacquisition uses the matching frame, backs off on empty input and yields to primary tracking', async () => {
  const calls=[], messages=[];
  const self={postMessage:reply=>messages.push(reply)};
  const detect=(name,frame)=>{
    calls.push(name+frame.time);
    return {landmarks:frame[name]?[Array(21).fill(frame.time)]:[]};
  };
  vm.runInNewContext(readFileSync(new URL('../src/tracking-worker.js', import.meta.url),'utf8'),{
    self,importScripts(){},OffscreenCanvas:class {},performance:{now:()=>0},
    Vision:{FilesetResolver:{forVisionTasks:async()=>({})},HandLandmarker:{createFromOptions:async(_,options)=>
      options.baseOptions.delegate==='GPU'?{detectForVideo:frame=>detect('gpu',frame)}:{detect:frame=>detect('cpu',frame)}}}
  });
  await self.onmessage({data:{type:'init',delegate:'GPU'}});
  assert.equal(messages.pop().recoveryReady,true);
  const frame=async(time,gpu=false,cpu=false,extra={})=>{
    const bitmap={time,gpu,cpu,close(){}};
    await self.onmessage({data:{type:'detect',timestamp:time,bitmap,live:true,...extra}});
    const reply=messages.pop();assert.equal(reply.bitmap,bitmap);return reply;
  };
  await frame(0,true);await frame(33);await frame(66);await frame(99);await frame(367,false,true);
  assert.equal((await frame(400,false,true)).result.landmarks[0][0],400);
  await frame(880,true,true);await frame(915,true,true);
  assert.deepEqual(calls,['gpu0','gpu33','gpu66','cpu66','gpu99','gpu367','cpu367','cpu400','gpu880','gpu915']);
  await frame(950);await frame(985,false,true);
  assert.equal((await frame(1020)).result.landmarks.length,0);
  await frame(1060,false,true,{firstFrame:true});
  await frame(1100,false,true,{live:false});
  assert.deepEqual(calls.slice(-7),['gpu950','gpu985','cpu985','cpu1020','gpu1020','gpu1060','gpu1100']);
});
test('the public worker uses the same local model for primary and recovery with no network tracking', async () => {
  const models=[], replies=[];
  const self={postMessage:reply=>replies.push(reply)};
  vm.runInNewContext(readFileSync(new URL('../src/tracking-worker.js',import.meta.url),'utf8'),{
    self, importScripts(){}, OffscreenCanvas:class {}, performance:{now:()=>0},
    fetch(){throw Error('unexpected network inference');},
    Vision:{FilesetResolver:{forVisionTasks:async()=>({})},HandLandmarker:{createFromOptions:async(_,opts)=>{
      models.push(opts.baseOptions.modelAssetPath);
      return {detectForVideo:()=>({landmarks:[]}),detect:()=>({landmarks:[]})};
    }}}
  });
  await self.onmessage({data:{type:'init',delegate:'GPU'}});
  for(const timestamp of [1,34,70])await self.onmessage({data:{type:'detect',bitmap:{},timestamp,live:true}});
  assert.deepEqual(models,['/assets/hand_landmarker.task','/assets/hand_landmarker.task']);
  assert.ok(replies.slice(1).every(reply=>reply.result?.landmarks.length===0 && !reply.error));
});
