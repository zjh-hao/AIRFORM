// Deterministic mechanism checks, never a substitute for human camera validation.
import '../test-support/three-loader.js';
import assert from 'node:assert/strict';
import { HandInteraction, PINCH, connectInteraction } from '../src/interaction.js';
const { connectLiveDrawing } = await import('../src/live-drawing.js');
const { StrokeEngine } = await import('../src/stroke-engine.js');
const { Scene } = await import('three');

export function input(timestamp, ratio = .6, options = {}) {
  // Keep qualification samples inside the image, including negative warmup
  // timestamps. Off-image fingertips now intentionally count as lost input.
  const points = Array.from({ length: 21 }, () => ({ x: .5, y: .5, z: 0 }));
  // Move the thumb to change pinch, not the drawing fingertip. This keeps the
  // gesture timing fixture from fabricating a large drawing-position jump.
  points[0].x=.25;points[9].x=.75;points[4].x=.5*ratio;
  points[8] = { x: 0, y: .5 + timestamp / 10000, z: 0 };
  points[4].y = points[8].y;
  if (options.palm) points[9].x = .25;
  if (options.invalidTip) points[8].x = NaN;
  if (options.invalidThumb) points[4].y = Infinity;
  const labels = options.labels ?? ['Right'];
  return { timestamp, source: options.source ?? '摄像头',
    landmarks: ratio === null ? [] : labels.map(() => points),
    handedness: labels.map(categoryName => [{ categoryName }]) };
}

export const scenarios = [
  ...[1, 12, 24, 39, 40].map(duration => ({ name: `pulse cancels on low sample at ${duration} ms`, run(h) {
    h.send(200, .7); h.send(200 + duration, .2);
    h.expect('Pinching', true, 0); assert.equal(h.engine().stats.chunks, 1);
  } })),
  { name: 'sustained release confirms at exactly 40 ms, once; fresh pinch still needs 80 ms', run(h) {
    h.send(200, PINCH.release); h.send(239.999, PINCH.release); h.expect('Pinching', true, 0);
    h.send(240, PINCH.release); h.expect('Idle', false, 1);
    h.send(240, .9); h.send(241, .8); h.expect('Idle', false, 1);
    h.send(260, PINCH.enter); h.send(339.999, PINCH.enter); h.expect('Idle', false, 1);
    h.send(340, PINCH.enter); h.expect('Pinching', true, 1);
    h.send(350, .8); h.send(389.999, .8); h.expect('Pinching', true, 1);
    h.send(390.001, .8); h.expect('Idle', false, 2);
  } },
  { name: 'threshold jitter and deadband cancel instead of accumulating release time', run(h) {
    for (const t of [200, 240, 280]) {
      h.send(t, .45); h.send(t + 39, .45 - Number.EPSILON); h.expect('Pinching', true, 0);
    }
    h.send(320, .7); h.send(359, .31); h.send(360, .7); h.send(399, .7);
    h.expect('Pinching', true, 0); h.send(400, .7); h.expect('Idle', false, 1);
  } },
  { name: 'duplicate, stale, invalid timestamps and fixture events neither confirm nor cancel', run(h) {
    h.send(200, .8);
    const before = h.events.length;
    for (const t of [200, 199, NaN, Infinity]) h.send(t, .2);
    h.send(230, .2, { source: '官方图片（非真人）' });
    assert.equal(h.events.length, before);
    h.send(239, .8); h.expect('Pinching', true, 0);
    h.send(240, .8); h.expect('Idle', false, 1);
  } },
  ...[
    ['no hand', { ratio: null }], ['Left only', { labels: ['Left'] }],
    ['duplicate Right', { labels: ['Right', 'Right'] }], ['missing label', { labels: [undefined] }],
    ['degenerate palm', { palm: true }], ['invalid tip', { invalidTip: true }],
    ['invalid thumb', { invalidThumb: true }], ['invalid dimensions', { width: 0 }],
    ['camera stopped', { ratio: null, source: 'stopped' }],
    ['sampling gap 251 ms', { time: 451 }],
  ].map(([name, options]) => ({ name: `${name}: brief observation loss pauses; Stop ends; real release confirms`, run(h) {
    h.send(200, .8);
    const time = options.time ?? 210;
    h.send(time, 'ratio' in options ? options.ratio : .2, options);
    h.expect('TrackingLost', options.source!=='stopped', options.source==='stopped'?1:0);
    if (options.source === 'stopped') { h.send(time, null, options); h.send(time + 1, null, options); }
    h.send(time + 20, .2); h.send(time + 100, .2); h.send(time + 180, .2);
    if(options.source==='stopped')h.expect('Rearming',false,1);
    else {
      h.expect('Pinching',true,0);h.send(time+190,.2);
      assert.equal(h.engine().stats.chunks,1);
    }
    h.send(time + 200, .6); h.send(time + 279, .6);
    h.expect(options.source==='stopped'?'Rearming':'Idle',false,1);
    h.send(time + 280, .6); h.expect('Idle', false,1);
    h.send(time + 300, .2); h.send(time + 380, .2); h.send(time + 390, .2);
    h.expect('Pinching', true,1);
    assert.equal(h.engine().stats.chunks,2);
  } })),
  { name: 'existing 250 ms gap boundary remains accepted; release confirms on next observation', run(h) {
    h.send(200, .8); h.send(450, .8); h.expect('Idle', false, 1);
  } },
  { name: 'unmount while release pending ends immediately, disposes once and detaches', run(h) {
    h.send(200, .8);
    h.cleanup(); h.cleanup();
    assert.equal(h.engine().active, false); assert.equal(h.scene.children.length, 0);
    assert.equal(h.engine().stats.segments, 0);
    const before = h.calls.length; h.send(250, .2); assert.equal(h.calls.length, before);
  } },
];

export function runScenario(scenario) {
  const calls = [], events = [], restore = [];
  let engine;
  for (const name of ['beginStroke', 'appendPoint', 'endStroke']) {
    const original = StrokeEngine.prototype[name];
    StrokeEngine.prototype[name] = function(...args) {
      engine = this;
      const before = this.stats, activeBefore = this.active;
      const result = original.apply(this, args);
      calls.push({ name, result, activeBefore, activeAfter: this.active, segmentsDelta: this.stats.segments - before.segments });
      if (name === 'appendPoint' && result) assert.equal(this.stats.segments - before.segments, 1);
      return result;
    };
    restore.push(() => { StrokeEngine.prototype[name] = original; });
  }
  const target = new EventTarget(), scene = new Scene();
  let width = 1;
  const disconnect = connectInteraction(target, () => ({ width, height: 1 }));
  const cleanup = connectLiveDrawing(target, scene);
  target.addEventListener('kineglow:interaction', ({ detail }) => events.push(detail));
  const h = { calls, events, scene, cleanup, engine: () => engine,
    send(t, ratio = .6, options = {}) {
      width = options.width ?? 1;
      target.dispatchEvent(new CustomEvent('kineglow:hands', { detail: input(t, ratio, options) }));
    },
    expect(state, active, ends) {
      assert.equal(events.at(-1).state, state); assert.equal(engine.active, active);
      assert.equal(calls.filter(c => c.name === 'endStroke' && c.result).length, ends);
    } };
  try {
    h.send(-160); h.send(-80); h.send(0); h.send(20, .2); h.send(100, .2); h.send(120, .2);
    h.expect('Pinching', true, 0);
    scenario.run(h);
    return { name: scenario.name, passed: true, synthetic: true,
      states: events.map(({ timestamp, state }) => ({ timestamp, state })),
      activeEnds: calls.filter(c => c.name === 'endStroke' && c.result).length,
      acceptedAppends: calls.filter(c => c.name === 'appendPoint' && c.result).length };
  } finally { disconnect(); cleanup(); restore.reverse().forEach(f => f()); }
}

export function sampleReleaseLatency(Machine = HandInteraction, intervalMs = 12.5) {
  const machine = new Machine();
  const update = (t, ratio) => machine.update(input(t, ratio), 1, 1);
  update(-160, .6); update(-80, .6); update(0, .6); update(20, .2); update(100, .2);
  const firstHigh = 200;
  for (let i = 0; i < 100; i++) {
    const timestamp = firstHigh + intervalMs * i;
    if (update(timestamp, .8).state === 'Idle') return timestamp - firstHigh;
  }
  throw new Error('Release failed to complete');
}
