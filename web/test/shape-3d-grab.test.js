import '../test-support/three-loader.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  regularizeStroke, recognizeShape3D, createShape3DMesh, descriptorFromModelResult,
} = await import('../src/shape-3d.js');
const { SUPPORTED_PATTERN_TYPES } = await import('../src/glyph-3d.js');
const { StrokeEngine } = await import('../src/stroke-engine.js');
const { detectFist } = await import('../src/hand-geometry.js');
const { HandInteraction } = await import('../src/interaction.js');
const { worldHand } = await import('../test-support/world-hand.js');

function sampleCircle({ radius = 1, count = 48, jitter = 0, overshoot = 0, tilt = 0, center = [0, 0, 0] } = {}) {
  const pts = [];
  const total = count + overshoot;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  for (let i = 0; i <= total; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = radius + (jitter ? Math.sin(i * 3.7) * jitter : 0);
    const x = Math.cos(a) * r;
    const y0 = Math.sin(a) * r;
    pts.push({
      x: center[0] + x,
      y: center[1] + y0 * ct,
      z: center[2] + y0 * st,
    });
  }
  return pts;
}

function samplePolygon(vertices, perEdge = 12, jitter = 0) {
  const pts = [];
  for (let e = 0; e < vertices.length; e++) {
    const a = vertices[e], b = vertices[(e + 1) % vertices.length];
    for (let s = 0; s < perEdge; s++) {
      const t = s / perEdge;
      pts.push({
        x: a[0] + (b[0] - a[0]) * t + (jitter ? Math.sin((e * perEdge + s) * 2.9) * jitter : 0),
        y: a[1] + (b[1] - a[1]) * t + (jitter ? Math.cos((e * perEdge + s) * 2.3) * jitter : 0),
        z: a[2] + (b[2] - a[2]) * t,
      });
    }
  }
  pts.push({ ...pts[0] });
  return pts;
}

function fistWorld({ ratio = 0.65, curled = true } = {}) {
  const frame = worldHand({ ratio });
  const w = frame.worldLandmarks[0];
  if (curled) {
    // Curl all 4 fingers inward toward the palm/wrist while preserving valid palm length (0->9).
    const palm = Math.hypot(w[9].x - w[0].x, w[9].y - w[0].y, w[9].z - w[0].z);
    for (const [tip, pip, mcp] of [[8, 6, 5], [12, 10, 9], [16, 14, 13], [20, 18, 17]]) {
      const dirX = w[mcp].x - w[0].x, dirY = w[mcp].y - w[0].y, dirZ = w[mcp].z - w[0].z;
      const d = Math.hypot(dirX, dirY, dirZ) || 1;
      w[pip] = { x: w[0].x + dirX / d * palm * 1.15, y: w[0].y + dirY / d * palm * 1.15, z: w[0].z + dirZ / d * palm * 1.15 };
      w[tip] = { x: w[0].x + dirX / d * palm * 0.72, y: w[0].y + dirY / d * palm * 0.72, z: w[0].z + dirZ / d * palm * 0.72 };
    }
  }
  return frame;
}

test('recognizeShape3D converts circles, squares/rectangles, and triangles while rejecting open/3D paths', () => {
  // Circle (with hand jitter, overshoot, and 3D plane tilt) -> sphere
  const sphere = recognizeShape3D(sampleCircle({ radius: 0.9, jitter: 0.03, overshoot: 5, tilt: 0.4, center: [0.3, -0.2, 0.5] }));
  assert.equal(sphere?.type, 'sphere');
  assert.ok(Math.abs(sphere.radius - 0.9) < 0.08);
  assert.ok(Math.hypot(sphere.center.x - 0.3, sphere.center.y + 0.2, sphere.center.z - 0.5) < 0.08);

  // Square rotated 45 deg with jitter -> cube (regularized equal sides)
  const r = 0.8 * Math.SQRT2;
  const rotatedSquare = samplePolygon([[r, 0, 0], [0, r, 0], [-r, 0, 0], [0, -r, 0]], 12, 0.015);
  const cube = recognizeShape3D(rotatedSquare);
  assert.equal(cube?.type, 'cube');
  assert.ok(Math.abs(cube.size.x - cube.size.y) < 1e-6);
  assert.ok(Math.abs(cube.size.x - cube.size.z) < 1e-6);
  assert.ok(Math.abs(cube.size.x - 1.6) < 0.12);

  // Elongated rectangle -> rectangular box
  const rect = samplePolygon([[-1.1, -0.5, 0], [1.1, -0.5, 0], [1.1, 0.5, 0], [-1.1, 0.5, 0]], 12, 0.01);
  const box = recognizeShape3D(rect);
  assert.equal(box?.type, 'cube');
  assert.ok(box.size.x > box.size.y * 1.6 || box.size.y > box.size.x * 1.6);

  // Triangle -> pyramid
  const tri = samplePolygon([[0, 0.9, 0], [-0.85, -0.65, 0], [0.85, -0.65, 0]], 14, 0.01);
  const pyramid = recognizeShape3D(tri);
  assert.equal(pyramid?.type, 'pyramid');

  // Open line and 3D helix -> null (keep freehand stroke)
  const line = Array.from({ length: 20 }, (_, i) => ({ x: -1 + i * 0.1, y: 0, z: 0 }));
  assert.equal(recognizeShape3D(line), null);
  const helix = Array.from({ length: 60 }, (_, i) => ({
    x: Math.cos(i * 0.35) * 0.7,
    y: Math.sin(i * 0.35) * 0.7,
    z: i * 0.06,
  }));
  assert.equal(recognizeShape3D(helix), null);

  const mesh = createShape3DMesh(cube, { color: '#38bbff' });
  assert.equal(mesh.isGroup, true);
  assert.equal(mesh.userData.shape3d, true);
  assert.equal(mesh.userData.shapeType, 'cube');
  assert.equal(mesh.children.length, 2);
  assert.equal(mesh.children[0].material.transparent, true);
  assert.ok(mesh.children[0].material.opacity > 0 && mesh.children[0].material.opacity < 1);
  assert.equal(mesh.userData.highlightTargets.length, 2);
  mesh.traverse(obj => {
    obj.geometry?.dispose();
    obj.material?.dispose();
  });

  const sphereMesh = createShape3DMesh(sphere, { color: '#38bbff' });
  assert.equal(sphereMesh.children.length, 1);
  assert.equal(sphereMesh.children[0].material.transparent, true);
  sphereMesh.traverse(obj => {
    obj.geometry?.dispose();
    obj.material?.dispose();
  });
});

test('regularizeStroke snaps noisy lines, arcs, circles, triangles, rectangles, and smooth curves', () => {
  // Noisy 3D straight line -> exact collinear line
  const noisyLine = Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    return { x: -1 + t * 2, y: -0.5 + t * 1.2 + Math.sin(i * 2.7) * 0.035, z: t * 0.4 + Math.cos(i * 3.1) * 0.02 };
  });
  const line = regularizeStroke(noisyLine);
  assert.equal(line?.kind, 'line');
  assert.ok(line.points.length >= 12);
  const start = line.points[0], end = line.points.at(-1);
  const mid = line.points[Math.floor(line.points.length / 2)];
  const expectedMid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, z: (start.z + end.z) / 2 };
  assert.ok(Math.hypot(mid.x - expectedMid.x, mid.y - expectedMid.y, mid.z - expectedMid.z) < 0.12);

  // Noisy circular arc -> constant-radius arc
  const noisyArc = Array.from({ length: 30 }, (_, i) => {
    const a = -0.3 + (i / 29) * Math.PI * 0.9;
    const r = 1.1 + Math.sin(i * 3.1) * 0.03;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0 };
  });
  const arc = regularizeStroke(noisyArc);
  assert.equal(arc?.kind, 'arc');
  assert.ok(arc.points.length >= 24);

  // Noisy circle -> standard 64-segment circle
  const regCircle = regularizeStroke(sampleCircle({ radius: 0.9, jitter: 0.04, overshoot: 4 }));
  assert.equal(regCircle?.kind, 'circle');
  assert.equal(regCircle.points.length, 65);

  // Noisy triangle -> crisp 3-edge closed triangle
  const regTri = regularizeStroke(samplePolygon([[0, 0.9, 0], [-0.85, -0.65, 0], [0.85, -0.65, 0]], 14, 0.025));
  assert.equal(regTri?.kind, 'triangle');
  assert.equal(recognizeShape3D(regTri.points)?.type, 'pyramid');

  // Noisy rectangle -> crisp 4-edge rectangle
  const regRect = regularizeStroke(samplePolygon([[-1.0, -0.55, 0], [1.0, -0.55, 0], [1.0, 0.55, 0], [-1.0, 0.55, 0]], 12, 0.02));
  assert.equal(regRect?.kind, 'rectangle');
  assert.equal(recognizeShape3D(regRect.points)?.type, 'cube');

  // Free S-curve -> smooth curve fallback
  const sCurve = Array.from({ length: 36 }, (_, i) => ({
    x: -1.5 + i * 0.09,
    y: Math.sin(i * 0.25) * 0.65 + (i % 2 ? 0.025 : -0.025),
    z: 0,
  }));
  const curve = regularizeStroke(sCurve);
  assert.equal(curve?.kind, 'curve');
  assert.ok(curve.points.length >= 16);
});

test('StrokeEngine smartDraw rebuilds regularized tubes cleanly and combines with shape3d holographic groups', () => {
  const engine = new StrokeEngine(() => {}, () => {});

  // smartDraw on + shape3d off -> straightens noisy triangle into crisp tube stroke
  const noisyTri = samplePolygon([[0, 0.8, 0], [-0.8, -0.6, 0], [0.8, -0.6, 0]], 12, 0.02);
  engine.beginStroke(noisyTri[0], { color: '#38bbff', size: 3, mineral: true, smartDraw: true, shape3d: false });
  for (let i = 1; i < noisyTri.length; i++) engine.appendPoint(noisyTri[i]);
  engine.endStroke();
  assert.equal(engine.shapes.length, 0);
  assert.equal(engine.stats.strokes, 1);
  assert.ok(engine.stats.segments > 0 && Number.isFinite(engine.stats.geometryBytes));

  // smartDraw on + shape3d on -> builds clean translucent pure-color pyramid group
  const noisyTri2 = samplePolygon([[0, 1.0, 0], [-0.9, -0.6, 0], [0.9, -0.6, 0]], 14, 0.025);
  engine.beginStroke(noisyTri2[0], { color: '#20e8ae', size: 3, mineral: true, smartDraw: true, shape3d: true });
  for (let i = 1; i < noisyTri2.length; i++) engine.appendPoint(noisyTri2[i]);
  engine.endStroke();
  assert.equal(engine.shapes.length, 1);
  assert.equal(engine.shapes[0].isGroup, true);
  assert.equal(engine.shapes[0].userData.shapeType, 'pyramid');
  assert.equal(engine.shapes[0].children.length, 2);
  assert.equal(engine.shapes[0].children[0].material.transparent, true);
  assert.ok(Number.isFinite(engine.stats.segments) && Number.isFinite(engine.stats.geometryBytes));

  // undo -> redo -> dispose cleanly
  assert.equal(engine.undo(), true);
  assert.equal(engine.shapes.length, 0);
  assert.equal(engine.redo(), true);
  assert.equal(engine.shapes.length, 1);
  engine.dispose();
});

test('StrokeEngine only converts strokes when shape3d is enabled and keeps stats/undo/redo intact', () => {
  const engine = new StrokeEngine(() => {}, () => {});
  const circle = sampleCircle({ radius: 0.85, count: 40 });

  // Off -> remains regular tube stroke
  engine.beginStroke(circle[0], { color: '#38bbff', size: 3, mineral: true, shape3d: false });
  for (let i = 1; i < circle.length; i++) engine.appendPoint(circle[i]);
  engine.endStroke();
  assert.equal(engine.shapes.length, 0);
  assert.ok(engine.stats.segments > 0);
  const tubeSegments = engine.stats.segments;

  // On + ion effect -> replaces tube with sphere cleanly without crashing comet/stats
  engine.beginStroke(circle[0], { color: '#16baff', size: 3, effect: 'ion', mineral: true, shape3d: true });
  for (let i = 1; i < circle.length; i++) engine.appendPoint(circle[i]);
  engine.endStroke();
  assert.equal(engine.shapes.length, 1);
  assert.equal(engine.shapes[0].userData.shapeType, 'sphere');
  assert.equal(engine.stats.shapes, 1);
  assert.equal(engine.stats.segments, tubeSegments);
  assert.ok(Number.isFinite(engine.stats.geometryBytes));

  assert.equal(engine.undo(), true);
  assert.equal(engine.shapes.length, 0);
  assert.equal(engine.redo(), true);
  assert.equal(engine.shapes.length, 1);
  engine.dispose();
});

test('detectFist and HandInteraction enter Grabbing after 60ms, release after 80ms, and never interrupt Pinching', () => {
  const open = fistWorld({ ratio: 0.65, curled: false });
  const fist = fistWorld({ ratio: 0.65, curled: true });
  assert.equal(detectFist(open.landmarks[0], open.worldLandmarks[0], 640, 480).fist, false);
  assert.equal(detectFist(open.landmarks[0], open.worldLandmarks[0], 640, 480).openForRelease, true);
  assert.equal(detectFist(fist.landmarks[0], fist.worldLandmarks[0], 640, 480).fist, true);

  let shapesPresent = true;
  const machine = new HandInteraction(undefined, { canGrab: () => shapesPresent });
  const send = (t, frame, ratio) => machine.update(
    { ...frame, timestamp: t, landmarks: frame.landmarks, worldLandmarks: frame.worldLandmarks },
    640, 480,
  );
  // Arm to Idle with open hand (80ms handConfirm + 80ms Rearming -> Idle).
  send(0, open, 0.65);
  send(80, open, 0.65);
  const idle = send(160, open, 0.65);
  assert.equal(idle.state, 'Idle');

  // Fist enters Grabbing after 60ms without triggering Pinching.
  assert.equal(send(180, fist, 0.65).state, 'Idle');
  assert.equal(send(245, fist, 0.65).state, 'Grabbing');

  // Holds across a brief 1-frame dropout.
  const held = machine.update({ timestamp: 280, source: '摄像头', landmarks: [], worldLandmarks: [], handedness: [] }, 640, 480);
  assert.equal(held.state, 'Grabbing');
  assert.equal(held.tracking, 'grab-paused');

  // Re-acquires fist and releases back to Idle after 80ms open hand.
  assert.equal(send(310, fist, 0.65).state, 'Grabbing');
  assert.equal(send(340, open, 0.65).state, 'Grabbing');
  assert.equal(send(425, open, 0.65).state, 'Idle');

  // Active Pinching cannot be interrupted into Grabbing.
  const pinch = worldHand({ ratio: 0.15 });
  send(460, pinch, 0.15);
  assert.equal(send(545, pinch, 0.15).state, 'Pinching');
  const pinchFist = fistWorld({ ratio: 0.15, curled: true });
  assert.equal(send(620, pinchFist, 0.15).state, 'Pinching');

  // Cannot grab when shapesPresent is false.
  shapesPresent = false;
  send(660, open, 0.65);
  assert.equal(send(710, open, 0.65).state, 'Idle');
  assert.equal(send(740, fist, 0.65).state, 'Idle');
  assert.equal(send(820, fist, 0.65).state, 'Idle');
});

test('high-jitter and gapped circles, rounded/mid-edge squares, and triangles snap accurately while rejecting figure-8', () => {
  // High edge wobble + ~11% unclosed gap circle -> Kasa fit circle + sphere
  const gappedJitterCircle = Array.from({ length: 34 }, (_, i) => {
    const a = (i / 33) * Math.PI * 1.78;
    const r = 0.95 + Math.sin(i * 3.9) * 0.085;
    return { x: Math.cos(a) * r + 0.4, y: Math.sin(a) * r - 0.1, z: 0.2 };
  });
  assert.equal(regularizeStroke(gappedJitterCircle)?.kind, 'circle');
  assert.equal(recognizeShape3D(gappedJitterCircle)?.type, 'sphere');

  // Heavy jitter + edge-midpoint start + rounded corners square -> equal-side cube
  const sq = [[-0.8, -0.8, 0], [0.8, -0.8, 0], [0.8, 0.8, 0], [-0.8, 0.8, 0]];
  const edgeStartedRaw = samplePolygon(sq, 12, 0.065);
  const rotatedStart = [...edgeStartedRaw.slice(6, -1), ...edgeStartedRaw.slice(0, 5)];
  assert.equal(regularizeStroke(rotatedStart)?.kind, 'rectangle');
  const sq3d = recognizeShape3D(rotatedStart);
  assert.equal(sq3d?.type, 'cube');
  assert.ok(Math.abs(sq3d.size.x - sq3d.size.y) < 1e-6);

  // Jittery triangle with slightly bowed edges + gap -> triangle + pyramid
  const rawTri = samplePolygon([[0, 1.0, 0], [-0.95, -0.65, 0], [0.95, -0.65, 0]], 12, 0.065).slice(0, 33);
  assert.equal(regularizeStroke(rawTri)?.kind, 'triangle');
  assert.equal(recognizeShape3D(rawTri)?.type, 'pyramid');

  // Figure-8 self-intersection -> NOT misclassified as circle/rectangle/triangle
  const figure8 = Array.from({ length: 64 }, (_, i) => {
    const t = (i / 63) * Math.PI * 2;
    return { x: Math.sin(t) * 1.0, y: Math.sin(2 * t) * 0.65, z: 0 };
  });
  assert.notEqual(regularizeStroke(figure8)?.kind, 'circle');
  assert.notEqual(regularizeStroke(figure8)?.kind, 'rectangle');
  assert.notEqual(regularizeStroke(figure8)?.kind, 'triangle');
  assert.equal(recognizeShape3D(figure8), null);
});

test('StrokeEngine snaps multi-stroke straight line endpoints together when smartDraw is enabled', () => {
  const engine = new StrokeEngine(() => {}, () => {});
  const strokeLine = (a, b) => {
    engine.beginStroke(a, { color: '#38bbff', size: 3, mineral: true, smartDraw: true, shape3d: false });
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      engine.appendPoint({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
    engine.endStroke();
  };

  // Draw 3 separate edges of a triangle with slight endpoint gaps (0.12 - 0.16 < 0.28 threshold).
  strokeLine({ x: -1.0, y: -0.5, z: 0 }, { x: 1.0, y: -0.5, z: 0 });
  strokeLine({ x: 1.12, y: -0.42, z: 0 }, { x: 0.0, y: 1.0, z: 0 });
  strokeLine({ x: 0.10, y: 0.90, z: 0 }, { x: -0.92, y: -0.38, z: 0 });

  assert.equal(engine.stats.strokes, 3);
  assert.equal(engine.shapes.length, 0);
  // Check vertices of 3rd chunk start & end snapped onto corners (0, 1, 0) and (-1, -0.5, 0) cleanly.
  const thirdPos = engine.group.children[2].geometry.attributes.position;
  const distToTop = Math.hypot(thirdPos.getX(0) - 0.0, thirdPos.getY(0) - 1.0, thirdPos.getZ(0));
  assert.ok(distToTop < 0.01);
  engine.dispose();
});

test('pyramid apex strictly points UP (+Y) regardless of drawn triangle tilt or orientation', () => {
  const invertedTiltedTri = samplePolygon([[0, -0.9, 0.3], [-0.85, 0.7, -0.2], [0.85, 0.7, -0.2]], 14, 0.01);
  const desc = recognizeShape3D(invertedTiltedTri);
  assert.equal(desc?.type, 'pyramid');

  const mesh = createShape3DMesh(desc, { color: '#38bbff' });
  mesh.updateMatrixWorld(true);
  const posAttr = mesh.children[0].geometry.attributes.position;
  let minY = Infinity, maxY = -Infinity, maxCount = 0;
  for (let i = 0; i < posAttr.count; i++) {
    const wy = posAttr.getY(i);
    // Transform local vertex by mesh matrixWorld
    const m = mesh.matrixWorld.elements;
    const worldY = m[1] * posAttr.getX(i) + m[5] * wy + m[9] * posAttr.getZ(i) + m[13];
    if (worldY < minY) minY = worldY;
    if (worldY > maxY + 1e-4) { maxY = worldY; maxCount = 1; }
    else if (Math.abs(worldY - maxY) <= 1e-4) { maxCount++; }
  }
  // Top height strictly exceeds center + 0.45 * height (apex on +Y), never inverted or sideways.
  assert.ok(maxY > desc.center.y + desc.height * 0.45);
  assert.ok(minY < desc.center.y - desc.height * 0.45);
  mesh.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
});

test('all translucent 3D pattern shapes and A-Z / 0-9 letter meshes build cleanly and swap in StrokeEngine', () => {
  const sampleStrokes = [[
    { x: -0.6, y: -0.5, z: 0 }, { x: 0.0, y: 0.7, z: 0 }, { x: 0.6, y: -0.5, z: 0 }, { x: 0.1, y: -0.2, z: 0 },
  ]];

  for (const type of SUPPORTED_PATTERN_TYPES) {
    const desc = descriptorFromModelResult({ recognized: true, kind: 'pattern', type, displayName: type }, sampleStrokes);
    assert.equal(desc?.type, type);
    const mesh = createShape3DMesh(desc, { color: '#59e094' });
    assert.equal(mesh.userData.shape3d, true);
    assert.equal(mesh.userData.shapeType, type);
    assert.equal(mesh.children[0].material.transparent, true);
    const pos = mesh.children[0].geometry.attributes.position;
    assert.ok(pos.count > 0);
    for (let i = 0; i < pos.count; i++) {
      assert.ok(Number.isFinite(pos.getX(i)) && Number.isFinite(pos.getY(i)) && Number.isFinite(pos.getZ(i)));
    }
    mesh.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
    const desc = descriptorFromModelResult({ recognized: true, kind: 'letter', type: 'letter', char: ch, displayName: `字母 ${ch}` }, sampleStrokes);
    assert.equal(desc?.type, 'letter');
    assert.equal(desc?.char, ch);
    const mesh = createShape3DMesh(desc, { color: '#ff70c8' });
    assert.equal(mesh.userData.shapeChar, ch);
    assert.equal(mesh.children[0].material.transparent, true);
    assert.ok(mesh.children[0].geometry.attributes.position.count > 0);
    mesh.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  // Test multi-stroke replacement, undo/redo, and stale ID rejection
  const engine = new StrokeEngine(() => {}, () => {});
  const unmatchedIds = [];
  engine.onUnmatchedShape = ({ id }) => unmatchedIds.push(id);

  // Draw two straight segments forming 'T' (unmatched locally -> collected for model)
  for (const [a, b] of [[{ x: -0.6, y: 0.6, z: 0 }, { x: 0.6, y: 0.6, z: 0 }], [{ x: 0, y: 0.6, z: 0 }, { x: 0, y: -0.6, z: 0 }]]) {
    engine.beginStroke(a, { color: '#38bbff', size: 3, mineral: true, shape3d: true, smartDraw: false });
    for (let k = 1; k <= 6; k++) {
      const t = k / 6;
      engine.appendPoint({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: 0 });
    }
    engine.endStroke();
  }
  assert.equal(unmatchedIds.length, 2);
  assert.equal(engine.stats.strokes, 2);

  const letterDesc = descriptorFromModelResult({ recognized: true, kind: 'letter', type: 'letter', char: 'T', displayName: '字母 T' }, sampleStrokes);
  const replaced = engine.replaceStrokesWithShape(unmatchedIds, letterDesc, { color: '#38bbff' });
  assert.equal(replaced?.userData.shapeChar, 'T');
  assert.equal(engine.shapes.length, 1);
  assert.equal(engine.stats.strokes, 1);

  assert.equal(engine.undo(), true);
  assert.equal(engine.shapes.length, 0);
  // Stale ID after undo must safely no-op.
  assert.equal(engine.replaceStrokesWithShape(unmatchedIds, letterDesc, { color: '#38bbff' }), null);
  assert.equal(engine.redo(), true);
  assert.equal(engine.shapes.length, 1);
  engine.dispose();
});

test('open C/U letters and continuous 1-stroke A / lowercase a are NOT hijacked into spheres, cubes, or pyramids', () => {
  const interp = (anchors, perSeg = 10) => {
    const out = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i], b = anchors[i + 1];
      for (let s = 0; s < perSeg; s++) {
        out.push({ x: a[0] + (b[0] - a[0]) * s / perSeg, y: a[1] + (b[1] - a[1]) * s / perSeg, z: 0 });
      }
    }
    const last = anchors.at(-1);
    out.push({ x: last[0], y: last[1], z: 0 });
    return out;
  };
  const arcDeg = (d0, d1, rx = 0.85, ry = 1.0) => Array.from({ length: 32 }, (_, i) => {
    const a = (d0 + (d1 - d0) * i / 31) * Math.PI / 180;
    return { x: Math.cos(a) * rx, y: Math.sin(a) * ry, z: 0 };
  });

  // Open C (240°, 270°, 285°, boxy C) and U must NEVER become circle/sphere or rectangle/cube
  for (const stroke of [
    arcDeg(60, 300),
    arcDeg(45, 315),
    arcDeg(37.5, 322.5),
    interp([[0.6, 0.9], [-0.6, 0.9], [-0.6, -0.9], [0.6, -0.9]]),
    interp([[-0.6, 0.9], [-0.6, -0.7], [0, -0.95], [0.6, -0.7], [0.6, 0.9]]),
  ]) {
    assert.equal(recognizeShape3D(stroke), null);
    const reg = regularizeStroke(stroke);
    assert.notEqual(reg?.kind, 'circle');
    assert.notEqual(reg?.kind, 'rectangle');
  }

  // Continuous single-stroke A variants and lowercase 'a' must NOT have legs/stems trimmed off
  const aLoop = interp([[-0.55, -0.85], [0, 0.85], [0.55, -0.85], [0.25, -0.15], [-0.35, -0.15]]);
  const aStar = interp([[-0.55, -0.85], [0, 0.85], [0.55, -0.85], [-0.5, -0.1], [0.5, -0.1]]);
  const lowerA = [...arcDeg(36, 378, 0.45, 0.45), ...interp([[0.45, 0.35], [0.45, -0.6], [0.6, -0.55]], 6)];
  for (const stroke of [aLoop, aStar, lowerA]) {
    assert.equal(recognizeShape3D(stroke), null);
    const reg = regularizeStroke(stroke);
    if (reg) assert.equal(recognizeShape3D(reg.points), null);
  }

  // StrokeEngine fires onStrokeBegin and forwards raw shapeSamples to onUnmatchedShape even when smartDraw is ON
  let beginCalls = 0, unmatchedSamplesLen = 0;
  const engine = new StrokeEngine(() => {}, () => {}, () => {},
    ({ samples }) => { unmatchedSamplesLen = samples.length; },
    () => { beginCalls++; });
  engine.beginStroke(aStar[0], { color: '#38bbff', size: 3, mineral: true, shape3d: true, smartDraw: true });
  for (let i = 1; i < aStar.length; i++) engine.appendPoint(aStar[i]);
  engine.endStroke();
  assert.equal(beginCalls, 1);
  assert.equal(engine.shapes.length, 0);
  assert.ok(unmatchedSamplesLen >= aStar.length - 1);
  engine.dispose();

  // Tightly-closed wobbly circle (~8% gap, 10% radial wobble) still converts cleanly to sphere
  const wobblyClosed = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 35) * Math.PI * 1.84;
    const r = 0.85 + Math.sin(i * 4.3) * 0.085;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0 };
  });
  assert.equal(recognizeShape3D(wobblyClosed)?.type, 'sphere');
});
