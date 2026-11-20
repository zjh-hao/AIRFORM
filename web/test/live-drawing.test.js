import '../test-support/three-loader.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectInteraction } from '../src/interaction.js';
const { connectLiveDrawing } = await import('../src/live-drawing.js');
const { Scene } = await import('three');

function harness() {
  const target = new EventTarget(), scene = new Scene();
  const cleanup = connectLiveDrawing(target, scene);
  const group = scene.children[0];
  const send = (state = 'Pinching', x = 0, source = '摄像头', point = { x, y: 0, z: 0 }) =>
    target.dispatchEvent(new CustomEvent('kineglow:interaction', { detail: { state, source, point } }));
  return { target, scene, group, send, cleanup };
}

test('ambiguous foreshortened arc deposits buffered points only after pinch recovery',()=>{
  for(const recover of [false,true]) {
    const drawing=harness();
    const send=(timestamp,x,y,state,conflict=false)=>drawing.target.dispatchEvent(new CustomEvent(
      'kineglow:interaction',{detail:{source:'摄像头',timestamp,point:{x,y,z:0},state,
        releasePending:conflict,retainPendingPath:conflict}}));
    send(0,0,0,'Pinching');send(50,.1,0,'Pinching');
    const mesh=drawing.group.children[0], before=mesh.geometry.drawRange.count;
    send(100,.2,.3,'Pinching',true);send(150,.4,.6,'Pinching',true);
    assert.equal(mesh.geometry.drawRange.count,before);
    send(200,.6,0,recover?'Pinching':'Idle');send(250,.7,0,'Idle');
    mesh.geometry.computeBoundingBox();
    assert.equal(mesh.geometry.boundingBox.max.y>.25,recover);
    drawing.cleanup();
  }
});

test('camera pinch starts, appends incrementally, release retains and next pinch stays separate', () => {
  const h = harness();
  h.send('Idle'); h.send('Rearming'); h.send('Pinching', 0, '官方图片（非真人）');
  assert.equal(h.group.children.length, 0);
  h.send(); assert.equal(h.group.children.length, 0);
  h.send('Pinching', .1); h.send('Pinching', .2);
  assert.equal(h.group.children.length, 1);
  assert.equal(h.group.children[0].geometry.drawRange.count, 216);
  h.send('Idle', 2);
  const first = h.group.children[0].geometry;
  h.send('Pinching', 2); h.send('Pinching', 2.1); h.send('Idle');
  assert.equal(h.group.children.length, 2);
  assert.equal(h.group.children[0].geometry, first);
  const xs = mesh => [...mesh.geometry.attributes.position.array].filter((_, i) => i % 3 === 0);
  assert.ok(Math.max(...xs(h.group.children[0])) < .3);
  assert.ok(Math.min(...xs(h.group.children[1])) > 1.9);
  h.cleanup();
});

for (const [name, state, source, point] of [
  ['loss', 'TrackingLost', '摄像头', null],
  ['null coordinate', 'Pinching', '摄像头', null],
  ['nonfinite coordinate', 'Pinching', '摄像头', { x: NaN, y: 0, z: 0 }],
  ['stopped even with stale pinch', 'Pinching', 'stopped', { x: 0, y: 0, z: 0 }],
  ['rearming', 'Rearming', '摄像头', { x: 0, y: 0, z: 0 }],
]) test(`${name} ends immediately and never joins the next stroke`, () => {
  const h = harness(); h.send(); h.send('Pinching', .1);
  const old = h.group.children[0].geometry;
  h.send(state, 0, source, point);
  assert.notEqual(h.group.children[0].geometry, old); // end compacts the tail now
  const ended = h.group.children[0].geometry;
  h.send('Rearming', 2); h.send('Rearming', 2.1);
  assert.equal(h.group.children.length, 1);
  h.send('Idle', 2); h.send('Pinching', 2); h.send('Pinching', 2.1);
  assert.equal(h.group.children.length, 2);
  assert.equal(h.group.children[0].geometry, ended);
  h.cleanup();
});

test('held pinch resumes the same stroke after brief loss; Stop still ends and requires opening again', () => {
  const h = harness();
  const disconnect = connectInteraction(h.target, () => ({ width: 640, height: 480 }));
  let t = 0;
  const frame = (ratio = .6, source = '摄像头') => {
    const points = Array.from({ length: 21 }, () => ({ x: .5, y: .5, z: 0 }));
    points[0].y = .8; points[9].y = .3;
    points[8].x = .3 + t / 10000;
    points[4].x = points[8].x + ratio * .5 * 480 / 640;
    h.target.dispatchEvent(new CustomEvent('kineglow:hands', { detail: {
      timestamp: t, source, landmarks: ratio === null ? [] : [points],
      handedness: [[{ categoryName: 'Right' }]],
    } }));
    t += 80;
  };
  frame(); frame(); frame(); frame(.1); frame(.1); frame(.1);
  assert.equal(h.group.children.length, 1);
  frame(null);
  const old=h.group.children[0].geometry;
  for(let i=0;i<4;i++)frame(.1);
  assert.equal(h.group.children.length,1);
  assert.equal(h.group.children[0].geometry,old);
  frame(null,'stopped');
  for(let i=0;i<4;i++)frame(.1);
  assert.equal(h.group.children.length,1);
  frame();frame();frame(.1);frame(.1);frame(.1);
  assert.equal(h.group.children.length,2);
  disconnect(); h.cleanup();
});

test('unmount ends active stroke, releases each owned resource once and removes listener/group', () => {
  const h = harness();
  const watched = new Map();
  const watch = () => {
    for (const mesh of h.group.children) for (const resource of [mesh.geometry, mesh.material]) {
      if (watched.has(resource)) continue;
      watched.set(resource, 0);
      resource.addEventListener('dispose', () => watched.set(resource, watched.get(resource) + 1));
    }
  };
  h.send();
  for (let i = 1; i <= 260; i++) h.send('Pinching', i / 100);
  watch(); h.send('Idle'); watch();
  h.send('Pinching', -2); h.send('Pinching', -1.9); watch();
  // Also watch compacted geometry created by endStroke during cleanup.
  const active = h.group.children.at(-1);
  active.geometry.addEventListener('dispose', () => watch());
  h.cleanup(); h.cleanup();
  h.scene.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
  assert.equal(h.scene.children.length, 0);
  assert.equal(h.group.children.length, 0);
  assert.ok([...watched.values()].every(count => count === 1));
  assert.doesNotThrow(() => { h.send(); h.send('Pinching', .1); });
  assert.equal(h.group.children.length, 0);
});
