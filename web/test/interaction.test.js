import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandInteraction, PINCH, mapPoint, pinchRatio, connectInteraction } from '../src/interaction.js';

function hand(ratio = 0.6, x = 0.5, y = 0.5) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[0] = { x: 0.5, y: 0.8 };
  points[9] = { x: 0.5, y: 0.3 };
  points[8] = { x, y };
  points[4] = { x: x + ratio * 0.5 * 480 / 640, y };
  return points;
}
function frame(timestamp, ratio = 0.6, label = 'Right', source = '摄像头') {
  return { timestamp, source, landmarks: ratio === null ? [] : [hand(ratio)],
    handedness: ratio === null ? [] : [[{ categoryName: label, score: 0.99 }]] };
}
const update = (machine, timestamp, ratio, label, source) => machine.update(frame(timestamp, ratio, label, source), 640, 480);
function armed(options) {
  const machine = new HandInteraction(undefined, options);
  assert.equal(update(machine, -160).state, 'TrackingLost');
  assert.equal(update(machine, -80).state, 'Rearming');
  assert.equal(update(machine, 0).state, 'Idle');
  return machine;
}

test('enhanced tracking resumes only a nearby measured right-hand pinch after a short processing gap',()=>{
  for(const [delay,ratio,label,shift,expected] of [
    [440,.1,'Right',0,true],[560,.1,'Right',0,false],[440,.6,'Right',0,false],
    [440,.1,'Left',0,false],[440,.1,'Right',.25,false],
  ]){
    const machine=armed();
    update(machine,20,.1);update(machine,120,.1);update(machine,160,.1);
    const packet=frame(160+delay,ratio,label);
    for(const point of packet.landmarks[0])point.x+=shift;
    const result=machine.update({...packet,enhanced:true},640,480);
    assert.equal(result.processingResume,expected);
    assert.equal(result.state==='Pinching',expected);
  }
  const lost=armed();
  update(lost,20,.1);update(lost,120,.1);update(lost,160,.1);update(lost,200,null);
  assert.equal(lost.update({...frame(600,.1),enhanced:true},640,480).processingResume,false);
});

test('legacy baseline: model-space contact delays a 2D release for at most 100 ms',()=>{
  const m=armed({gestureMode:'legacy'}); update(m,100,.1); update(m,180,.1);
  function disagree(t){
    const f=frame(t,.52); f.worldLandmarks=[hand(.12).map(p=>({...p,z:0}))];
    return m.update(f,640,480).state;
  }
  assert.equal(disagree(200),'Pinching');assert.equal(disagree(260),'Pinching');
  assert.equal(update(m,280,.1).state,'Pinching');
  assert.equal(disagree(300),'Pinching');assert.equal(disagree(400),'Idle');
});

test('P0-A geometry uses actual pixel aspect and rejects invalid input', () => {
  assert.ok(Math.abs(pinchRatio(hand(0.2), 640, 480) - 0.2) < 1e-12);
  assert.ok(Math.abs(pinchRatio(hand(0.2), 1280, 960) - 0.2) < 1e-12);
  assert.ok(Math.abs(pinchRatio(hand(0.2), 640, 960) - 0.1) < 1e-12);
  const degenerate = hand(); degenerate[9] = degenerate[0];
  assert.equal(pinchRatio(degenerate, 640, 480), null);
  const invalid = hand(); invalid[4].x = NaN;
  for (const [points, w, h] of [[invalid, 640, 480], [[], 640, 480], [null, 640, 480], [hand(), 0, 480], [hand(), Infinity, 480]]) {
    assert.equal(pinchRatio(points, w, h), null);
  }
});

test('selects Right by label, independent of X and detection order; excludes left/ambiguous hands', () => {
  const machine = new HandInteraction();
  const left = hand(0.1, 0.9), right = hand(0.6, 0.1);
  const original = { timestamp: 0, source: '摄像头', landmarks: [left, right],
    handedness: [[{ categoryName: 'Left' }], [{ categoryName: 'Right' }]] };
  const before = structuredClone(original);
  assert.equal(machine.update(original, 640, 480).point, null);
  const first = machine.update({ ...original, timestamp: 80 }, 640, 480);
  assert.equal(first.handIndex, 1); assert.deepEqual(first.point, mapPoint(right[8]));
  assert.deepEqual(original, before);
  assert.equal(machine.update({ ...original, timestamp: 160, landmarks: [right, left], handedness: original.handedness.toReversed() }, 640, 480).state, 'Idle');
  const onlyLeft = update(machine, 180, 0.1, 'Left');
  assert.equal(onlyLeft.state, 'TrackingLost'); assert.equal(onlyLeft.point, null);
  assert.equal(machine.update({ ...original, timestamp: 200, handedness: [[], []] }, 640, 480).point, null);
  assert.equal(machine.update({ ...original, timestamp: 220, handedness: [[{ categoryName: 'Right' }], [{ categoryName: 'Right' }]] }, 640, 480).point, null);
});

test('entry needs uninterrupted 80 ms; hysteresis holds; release needs uninterrupted 40 ms', () => {
  const machine = armed();
  for (const [t, ratio] of [[100, 0.29], [140, 0.31], [180, 0.29], [220, 0.299]]) assert.equal(update(machine, t, ratio).state, 'Idle');
  assert.equal(update(machine, 260, 0.29).state, 'Pinching');
  for (const [t, ratio] of [[280, 0.31], [310, 0.44], [340, 0.29], [370, 0.449]]) assert.equal(update(machine, t, ratio).state, 'Pinching');
  assert.equal(update(machine, 400, 0.46).state, 'Pinching');
  assert.equal(update(machine, 420, 0.29).state, 'Pinching');
  assert.equal(update(machine, 460, 0.46).state, 'Pinching');
  assert.equal(update(machine, 499, 0.46).state, 'Pinching');
  assert.equal(update(machine, 500, 0.46).state, 'Idle');
  assert.equal(update(machine, 520, 0.29).state, 'Idle');
});

test('exact enter/release boundaries are inclusive without rounding the measured ratio', () => {
  const machine = new HandInteraction();
  const sample = (t, ratio) => {
    const detail = frame(t);
    detail.landmarks[0][0] = detail.landmarks[0][4] = { x: 0, y: 0 };
    detail.landmarks[0][9] = { x: 1, y: 0 };
    detail.landmarks[0][8] = { x: ratio, y: 0 };
    return machine.update(detail, 1, 1);
  };
  sample(-80, PINCH.release); sample(0, PINCH.release); assert.equal(sample(80, PINCH.release).state, 'Idle');
  sample(100, PINCH.enter); assert.equal(sample(180, PINCH.enter).state, 'Pinching');
  assert.equal(sample(200, PINCH.release).state, 'Pinching');
  assert.equal(sample(240, PINCH.release).state, 'Idle');
});

test('loss ends the old stroke; a held pinch resumes after right-hand and pinch confirmation without reopening', () => {
  const machine = armed();
  update(machine, 100, 0.1); assert.equal(update(machine, 180, 0.1).state, 'Pinching');
  const lost = update(machine, 200, null);
  assert.equal(lost.state, 'TrackingLost'); assert.equal(lost.point, null);
  assert.equal(update(machine, 240, 0.1).state, 'TrackingLost');
  const recovering = update(machine, 320, 0.1);
  assert.equal(recovering.state,'Idle'); assert.equal(recovering.canResume,true);
  assert.equal(update(machine, 400, 0.1).state, 'Pinching');
  assert.equal(update(machine, 440, 0.6).state, 'Pinching');
  assert.equal(update(machine, 480, 0.6).state, 'Idle');
  assert.equal(update(machine, 520, 0.1).state, 'Idle');
  assert.equal(update(machine, 600, 0.1).state, 'Pinching');
  assert.equal(update(machine, 620, 0.1, 'Left').state, 'TrackingLost');
});

test('resume intent survives repeated losses and long sampling gaps, but Stop and Clear revoke it', () => {
  const machine=armed();update(machine,100,.1);update(machine,180,.1);
  assert.equal(update(machine,200,null).canResume,true);
  update(machine,240,.1);assert.equal(update(machine,260,null).canResume,true);
  update(machine,300,.1);assert.equal(update(machine,380,.1).state,'Idle');
  assert.equal(update(machine,460,.1).state,'Pinching');
  assert.equal(update(machine,711,.1).canResume,true);
  assert.equal(update(machine,791,.1).state,'Idle');assert.equal(update(machine,871,.1).state,'Pinching');
  update(machine,900,null);update(machine,920,null,'Right','stopped');
  update(machine,940,.1);assert.equal(update(machine,1020,.1).state,'Rearming');
  update(machine,1100,.6);update(machine,1180,.6);update(machine,1220,.1);update(machine,1300,.1);
  update(machine,1340,null);machine.reset();
  update(machine,1380,.1);assert.equal(update(machine,1460,.1).state,'Rearming');
});

test('automatic recovery still rejects left/ambiguous and brief right-label detections', () => {
  const machine=armed();update(machine,100,.1);update(machine,180,.1);update(machine,200,null);
  for(const [t,label] of [[220,'Left'],[240,'Right'],[260,'Left'],[280,'Right']]) {
    const result=update(machine,t,.1,label);assert.equal(result.state,'TrackingLost');assert.equal(result.point,null);
  }
  const ambiguous=frame(300,.1);ambiguous.landmarks.push(hand(.1));ambiguous.handedness.push([{categoryName:'Right'}]);
  assert.equal(machine.update(ambiguous,640,480).point,null);
  update(machine,320,.1);assert.equal(update(machine,400,.1).state,'Idle');
  assert.equal(update(machine,480,.1).state,'Pinching');
});

test('stop/restart, invalid palm and long sampling gaps rearm; stale samples and fixture do not alter state', () => {
  const machine = armed();
  update(machine, 100, 0.1); update(machine, 180, 0.1);
  assert.equal(update(machine, 190, 0.6, 'Right', '官方图片（非真人）'), null);
  assert.equal(update(machine, 180, 0.6), null);
  assert.equal(machine.state, 'Pinching');
  const stopped = update(machine, 200, null, 'Right', 'stopped');
  assert.deepEqual(stopped, { state: 'TrackingLost', point: null, timestamp: 200, source: 'stopped', ratio: null, handIndex: null });
  assert.equal(update(machine, 220, 0.1).state, 'TrackingLost');
  update(machine, 300, 0.6); update(machine, 380, 0.6);
  update(machine, 400, 0.1);
  assert.equal(update(machine, 400 + PINCH.maxGapMs + 1, 0.1).state, 'TrackingLost');
  const invalid = frame(700); invalid.landmarks[0][0] = invalid.landmarks[0][9];
  assert.equal(machine.update(invalid, 640, 480).state, 'TrackingLost');
});

test('plane mapping is mirrored once, bounded, continuous, fixed depth and independent of model Z', () => {
  assert.deepEqual(mapPoint({ x: 0, y: 0, z: -3 }), { x: 3, y: 2.25, z: 0 });
  assert.deepEqual(mapPoint({ x: 1, y: 1, z: 99 }), { x: -3, y: -2.25, z: 0 });
  assert.deepEqual(mapPoint({ x: 0, y: 1 }), { x: 3, y: -2.25, z: 0 });
  assert.deepEqual(mapPoint({ x: 1, y: 0 }), { x: -3, y: 2.25, z: 0 });
  assert.deepEqual(mapPoint({ x: 0.5, y: 0.5 }), { x: 0, y: 0, z: 0 });
  assert.deepEqual(mapPoint({ x: -0.2, y: 1.2 }), { x: 3, y: -2.25, z: 0 });
  assert.equal(mapPoint({ x: NaN, y: 0 }), null);
  for (let i = 0; i < 100; i++) {
    const a = mapPoint({ x: i / 100, y: i / 100 });
    const b = mapPoint({ x: (i + 1) / 100, y: (i + 1) / 100 });
    assert.ok(b.x < a.x && b.y < a.y);
    assert.ok(Math.abs(b.x - a.x) < 0.061);
  }
});

test('public event adapter emits every camera/stop result with original timestamp/source and detaches', () => {
  const target = new EventTarget(), events = [];
  target.addEventListener('kineglow:interaction', e => events.push(e.detail));
  const disconnect = connectInteraction(target, () => ({ width: 640, height: 480 }));
  const send = detail => target.dispatchEvent(new CustomEvent('kineglow:hands', { detail }));
  send(frame(0)); send(frame(80)); send(frame(100, 0.6, 'Right', '官方图片（非真人）')); send(frame(160));
  send(frame(200, null, 'Right', 'stopped'));
  assert.deepEqual(events.map(e => [e.state, e.timestamp, e.source]), [
    ['TrackingLost', 0, '摄像头'], ['Rearming', 80, '摄像头'], ['Idle', 160, '摄像头'], ['TrackingLost', 200, 'stopped'],
  ]);
  disconnect(); send(frame(220)); assert.equal(events.length, 4);
});

test('brief Right misclassification during left-hand re-entry never shows a cursor or arms interaction', () => {
  const machine = new HandInteraction();
  for (const [t, label] of [[0, 'Left'], [20, 'Right'], [40, 'Right'], [60, 'Left'],
    [100, 'Right'], [160, 'Right'], [170, 'Left'], [200, 'Right']]) {
    const result = update(machine, t, 0.1, label);
    assert.equal(result.state, 'TrackingLost'); assert.equal(result.point, null);
  }
  assert.equal(update(machine, 280, 0.1).state, 'Rearming');
  assert.equal(update(machine, 360, 0.1).state, 'Rearming');
  assert.equal(update(machine, 380, 0.6).state, 'Rearming');
  assert.equal(update(machine, 460, 0.6).state, 'Idle');
});
