import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CameraSession } from '../src/camera.js';
import { assets } from '../vite.config.js';
import { packageRoot } from '../dependencies.js';
function harness(acquire) {
  let callback, detections = 0, stops = 0, released = 0;
  const track = { stop: () => released++, addEventListener: () => {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { readyState: 2, currentTime: 1, play: async () => {}, pause() {} };
  const session = new CameraSession({ video, acquire: acquire || (async () => stream),
    detect: () => detections++, stopped: () => stops++, schedule: cb => { callback = cb; return 1; }, cancel() {} });
  return { session, video, stream, tick: () => callback(), counts: () => ({ detections, stops, released }) };
}
test('new frames only; stop cancels even stale callbacks; restart and repeated stop release streams', async () => {
  const h = harness();
  await h.session.start();
  h.tick(); assert.equal(h.counts().detections, 1);
  h.video.currentTime++; h.tick(); assert.equal(h.counts().detections, 2);
  h.session.stop(); h.tick();
  assert.deepEqual(h.counts(), { detections: 2, stops: 1, released: 1 });
  assert.equal(h.video.srcObject, null);
  await h.session.start(); assert.equal(h.counts().detections, 3);
  h.session.stop(); h.session.stop(); assert.equal(h.counts().released, 2);
});
test('late permission result after stop is released without inference', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const pending = h.session.start(); h.session.stop(); resolve(h.stream);
  assert.equal(await pending, false);
  assert.equal(h.counts().released, 1); assert.equal(h.counts().detections, 0);
  assert.equal(h.video.srcObject, null);
});
test('play failure and detector failure release camera', async () => {
  const h = harness(); h.video.play = async () => { throw new Error('play failed'); };
  assert.equal(await h.session.start(), false); assert.equal(h.counts().released, 1);
  const other = harness(); other.session.detect = () => { throw new Error('detect failed'); };
  assert.equal(await other.session.start(), false); assert.equal(other.counts().released, 1);
});
test('default animation APIs are called without the session as receiver', async () => {
  const oldRequest = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  let scheduled = 0, cancelled = 0;
  globalThis.requestAnimationFrame = function () { assert.equal(this, undefined); scheduled++; return 1; };
  globalThis.cancelAnimationFrame = function () { assert.equal(this, undefined); cancelled++; };
  try {
    const h = harness();
    const session = new CameraSession({ video: h.video, acquire: async () => h.stream, detect() {}, stopped() {} });
    assert.equal(await session.start(), true);
    session.stop();
    assert.equal(scheduled, 1); assert.equal(cancelled, 1);
    assert.equal(h.video.srcObject, null);
  } finally { globalThis.requestAnimationFrame = oldRequest; globalThis.cancelAnimationFrame = oldCancel; }
});
test('dependency versions match the merged existing locks, all local assets and model intact', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(JSON.parse(readFileSync(`${packageRoot(name)}/package.json`)).version, version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  for (const path of assets.values()) assert.ok(readFileSync(path).length > 0);
  assert.equal(createHash('sha256').update(readFileSync(assets.get('assets/hand_landmarker.task'))).digest('hex'), 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1');
});
