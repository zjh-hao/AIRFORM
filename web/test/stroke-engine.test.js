import '../test-support/three-loader.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trajectory } from '../test-support/stroke-trajectories.js';
const { StrokeEngine } = await import('../src/stroke-engine.js');
const { Color, Vector3, Group } = await import('three');
const origin = { x: 0, y: 0, z: 0 };

function geometryValid(engine) {
  for (const { geometry: g } of engine.group.children) {
    const p = g.attributes.position, n = g.attributes.normal;
    assert.ok(g.drawRange.count <= g.index.count);
    const used = new Set(g.index.array.slice(0, g.drawRange.count));
    for (const i of used) {
      assert.ok(i < p.count);
      assert.ok([p.getX(i), p.getY(i), p.getZ(i)].every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-5);
    }
    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    for (let i = 0; i < g.drawRange.count; i += 3) {
      a.fromBufferAttribute(p, g.index.getX(i)); b.fromBufferAttribute(p, g.index.getX(i + 1)); c.fromBufferAttribute(p, g.index.getX(i + 2));
      assert.ok(b.sub(a).cross(c.sub(a)).lengthSq() > 0, `degenerate triangle at ${i}`);
    }
    for (const attribute of [p, n]) assert.ok(attribute.updateRanges.length <= 3);
  }
}

test('continuous 3D appends preserve old rings, depth, bounded upload ranges and valid triangles', () => {
  const e = new StrokeEngine();
  e.beginStroke(trajectory(0, 0, 1000));
  e.appendPoint(trajectory(0, 1, 1000));
  const prefix = e.group.children[0].geometry.attributes.position.array.slice(26 * 3, 50 * 3);
  for (let i = 2; i < 1000; i++) e.appendPoint(trajectory(0, i, 1000));
  assert.deepEqual(e.group.children[0].geometry.attributes.position.array.slice(26 * 3, 50 * 3), prefix);
  assert.equal(e.stats.segments, 999); assert.equal(e.stats.chunks, 8);
  geometryValid(e); e.endStroke(); geometryValid(e);
  e.dispose();
});

test('chunk boundary shares exactly the preceding ring; long strokes never overflow', () => {
  const e = new StrokeEngine(); e.beginStroke(trajectory(0, 0, 12000));
  for (let i = 1; i < 12000; i++) e.appendPoint(trajectory(0, i, 12000));
  assert.equal(e.stats.segments, 11999); assert.equal(e.stats.chunks, 94);
  for (let i = 1; i < e.group.children.length; i++) {
    const prev = e.group.children[i - 1].geometry.attributes.position.array;
    const next = e.group.children[i].geometry.attributes.position.array;
    assert.deepEqual(prev.slice((26 + 128 * 12) * 3), next.slice(26 * 3, 38 * 3));
  }
  geometryValid(e); e.dispose();
});

test('separate strokes never connect and style is copied at begin', () => {
  const e = new StrokeEngine(); const style = { color: '#ff8040', size: 7 };
  e.beginStroke(origin, style); style.color = '#ffffff'; style.size = 1;
  e.appendPoint({ x: 0, y: 0, z: 1 }); e.endStroke();
  e.beginStroke({ x: 10, y: 5, z: -2 }, { color: '#35bfff', size: 2 });
  e.appendPoint({ x: 11, y: 5, z: -2 }); e.endStroke();
  const [a, b] = e.group.children;
  assert.notEqual(a.geometry, b.geometry); assert.notEqual(a.material, b.material);
  assert.ok(a.material.color.equals(new Color('#ff8040')));
  assert.ok(b.material.color.equals(new Color('#35bfff')));
  assert.ok(Math.abs(a.geometry.attributes.position.getY(26) - .07) < 1e-6);
  a.geometry.computeBoundingBox(); b.geometry.computeBoundingBox();
  assert.ok(a.geometry.boundingBox.max.x < .08); assert.ok(b.geometry.boundingBox.min.x > 9.9);
  assert.equal(e.stats.strokes, 2); geometryValid(e); e.dispose();
});

test('input points are copied and z is retained at ring centers', () => {
  const e = new StrokeEngine(); const p = { x: 1, y: 2, z: 3 };
  e.beginStroke(p); p.z = 99;
  e.appendPoint({ x: 1, y: 2, z: 4 });
  const a = e.group.children[0].geometry.attributes.position;
  for (const [offset, expectedZ] of [[26, 3], [38, 4]]) {
    const center = new Vector3();
    for (let i = 0; i < 12; i++) center.add(new Vector3().fromBufferAttribute(a, offset + i));
    center.divideScalar(12);
    assert.ok(center.distanceTo(new Vector3(1, 2, expectedZ)) < 1e-6);
  }
  e.dispose();
});

test('duplicates and sub-microunit samples return false; zero-length strokes allocate nothing', () => {
  const e = new StrokeEngine(); e.beginStroke(origin);
  assert.equal(e.appendPoint(origin), false);
  assert.equal(e.appendPoint({ x: 1e-8, y: 0, z: 0 }), false);
  assert.equal(e.stats.geometryBytes, 0); assert.equal(e.endStroke(), true);
  assert.equal(e.stats.strokes, 0);
  e.beginStroke(origin); assert.equal(e.appendPoint({ x: 2e-6, y: 0, z: 0 }), true);
  geometryValid(e); e.endStroke(); geometryValid(e); e.dispose();
});

test('vertical, reversal, near reversal and sharp turns keep finite nondegenerate geometry', () => {
  const e = new StrokeEngine(); e.beginStroke(origin);
  for (const p of [[0, 1, 0], [0, 0, 0], [.00001, 1, 0], [1, 1, 1], [1, 1, -1]]) e.appendPoint({ x: p[0], y: p[1], z: p[2] });
  geometryValid(e); e.dispose();
});

test('invalid points and styles fail before changing active state or geometry', () => {
  const e = new StrokeEngine();
  for (const p of [null, {}, { x: 0, y: 0, z: NaN }, { x: Infinity, y: 0, z: 0 }, { x: '0', y: 0, z: 0 }, { x: 1e100, y: 0, z: 0 }]) {
    assert.throws(() => e.beginStroke(p)); assert.equal(e.active, false);
  }
  for (const style of [null, { color: 'bad' }, { color: 123 }, { size: 0 }, { size: Infinity }, { size: 101 }]) {
    assert.throws(() => e.beginStroke(origin, style)); assert.equal(e.active, false);
  }
  e.beginStroke(origin); e.appendPoint({ x: 1, y: 0, z: 0 });
  const before = e.stats;
  assert.throws(() => e.appendPoint({ x: NaN, y: 0, z: 0 })); assert.deepEqual(e.stats, before);
  assert.throws(() => e.beginStroke(origin)); assert.deepEqual(e.stats, before);
  e.appendPoint({ x: 2, y: 0, z: 0 }); geometryValid(e); e.dispose();
});

test('cancel removes only active stroke; end/clear/dispose are explicit and idempotent', () => {
  const e = new StrokeEngine(); const parent = new Group(); parent.add(e.group);
  assert.throws(() => e.appendPoint(origin)); assert.equal(e.endStroke(), false); assert.equal(e.cancelStroke(), false);
  const disposed = { geometry: 0, material: 0 };
  for (let round = 0; round < 50; round++) {
    e.beginStroke(origin); e.appendPoint({ x: 1, y: 2, z: 3 });
    const mesh = e.group.children.at(-1);
    mesh.geometry.addEventListener('dispose', () => disposed.geometry++);
    mesh.material.addEventListener('dispose', () => disposed.material++);
    if (round % 2) {
      e.cancelStroke(); assert.equal(e.stats.strokes, 1); e.clear();
    } else {
      e.endStroke(); // Trim disposes the former allocation; the final geometry also needs disposing.
      mesh.geometry.addEventListener('dispose', () => disposed.geometry++);
    }
  }
  assert.deepEqual(disposed, { geometry: 75, material: 50 });
  e.clear(); e.clear(); assert.equal(e.stats.geometryBytes, 0); assert.equal(e.group.children.length, 0);
  e.dispose(); e.dispose(); assert.equal(parent.children.length, 0);
  for (const call of [() => e.beginStroke(origin), () => e.appendPoint(origin), () => e.endStroke(), () => e.cancelStroke(), () => e.clear()]) assert.throws(call, /disposed/);
});

test('multiple chunks share one material and clear releases it exactly once', () => {
  const e = new StrokeEngine(); e.beginStroke(origin);
  for (let i = 1; i < 300; i++) e.appendPoint({ x: i * .01, y: 0, z: 0 });
  let materials = 0, geometries = 0;
  const meshes = [...e.group.children];
  assert.equal(new Set(meshes.map(m => m.material)).size, 1);
  meshes[0].material.addEventListener('dispose', () => materials++);
  meshes.forEach(m => m.geometry.addEventListener('dispose', () => geometries++));
  e.clear(); assert.equal(materials, 1); assert.equal(geometries, 3); e.dispose();
});

test('Float32 precision boundary rejects an unrepresentable radius before mutation', () => {
  const e = new StrokeEngine();
  assert.throws(() => e.beginStroke({ x: 10000, y: 10000, z: 10000 }, { size: .1 }), /Float32/);
  assert.equal(e.active, false);
  e.beginStroke(origin, { size: .1 });
  assert.throws(() => e.appendPoint({ x: 10000, y: 0, z: 0 }), /Float32/);
  assert.equal(e.stats.geometryBytes, 0); e.cancelStroke();
  e.beginStroke({ x: 10000, y: 10000, z: 10000 });
  assert.equal(e.appendPoint({ x: 10000, y: 10000, z: 10000 - 1e-6 }), false);
  e.appendPoint({ x: 9999, y: 9999, z: 9999 }); geometryValid(e); e.dispose();
});
