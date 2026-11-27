import { GestureScale, atBoundary, inImage } from './gesture-scale.js';

// Provisional engineering limits, exposed for replay/calibration. World values
// are model estimates in metres, never Astra depth measurements.
export const HAND_GEOMETRY = Object.freeze({ enter: .30, release: .45,
  foreshortenedRatio: .55, fingerForwardRatio: .35, worldHoldMs: 150,
  labelHoldMs: 120, identityDistance: .10, historySize: 15, conflictConfirmMs: 250,
  foreshortenedConflictMs: 550 });
const axes = ['x', 'y', 'z'];
const sub = (a, b) => axes.map(k => a[k] - b[k]);
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const norm = a => Math.hypot(...a);
const unit = a => a.map(v => v / norm(a));
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

export function worldGeometry(world) {
  if (!Array.isArray(world) || world.length !== 21
      || !world.every(p => p && axes.every(k => Number.isFinite(p[k])))) return null;
  const palm = sub(world[9], world[0]), length = norm(palm);
  if (length < .015 || length > .25) return null;
  const y = unit(palm), across = sub(world[17], world[5]);
  const orthogonal = across.map((v, i) => v - dot(across, y) * y[i]);
  // Reject collapsed palm bases and grossly implausible geometry. Do not use
  // image visibility/presence scores: this task does not reliably supply them.
  if (norm(orthogonal) / length < .12 || norm(across) / length > 2.5) return null;
  if ([4, 8, 12, 16, 20].some(i => norm(sub(world[i], world[0])) / length > 4)) return null;
  const x = unit(orthogonal), z = cross(x, y);
  const local = p => [x, y, z].map(axis => dot(sub(p, world[0]), axis) / length);
  const thumb = local(world[4]), tip = local(world[8]);
  const finger = sub(world[8], world[7]), fingerLength = norm(finger);
  return { ratio: norm(tip.map((v, i) => v - thumb[i])), palmLength: length,
    basis: { x, y, z }, tip, thumb,
    foreshortened: Math.hypot(palm[0], palm[1]) / length < HAND_GEOMETRY.foreshortenedRatio
      || (fingerLength > .002 && Math.hypot(finger[0], finger[1]) / fingerLength < HAND_GEOMETRY.fingerForwardRatio) };
}

export class HandGesture {
  constructor() { this.image = new GestureScale(); this.reset(); }
  reset() { this.image.reset(); this.palms = []; this.projected = []; this.lastWorld = null; }
  observe(hand, width, height, timestamp, world) {
    if (!(width > 0 && height > 0) || ![width, height, timestamp].every(Number.isFinite)
        || !inImage(hand?.[4]) || !inImage(hand?.[8])) return null;
    const image = this.image.observe(hand, width, height, timestamp);
    let geometry = worldGeometry(world);
    const reference = this.palms.length >= 3 ? median(this.palms) : null;
    if (geometry && reference && Math.abs(geometry.palmLength / reference - 1) > .4) geometry = null;
    if (geometry) {
      const projected = inImage(hand[0]) && inImage(hand[9])
        ? Math.hypot((hand[0].x-hand[9].x)*width, (hand[0].y-hand[9].y)*height) : null;
      const shortened = projected !== null && this.projected.length >= 3
        && projected < median(this.projected) * HAND_GEOMETRY.foreshortenedRatio;
      const foreshortened = geometry.foreshortened || shortened;
      this.palms.push(geometry.palmLength);
      if (projected > 0 && !foreshortened) this.projected.push(projected);
      this.palms = this.palms.slice(-HAND_GEOMETRY.historySize);
      this.projected = this.projected.slice(-HAND_GEOMETRY.historySize);
      this.lastWorld = { timestamp, foreshortened };
      return { ratio: geometry.ratio, projectedContact: image?.ratio <= HAND_GEOMETRY.enter,
        basis: 'world', quality: 'model-estimated',
        partial: !inImage(hand[0]) || !inImage(hand[9]), boundary: atBoundary(hand),
        pose: foreshortened ? 'foreshortened' : 'normal', geometry,
        thresholds: { enter: HAND_GEOMETRY.enter, release: HAND_GEOMETRY.release } };
    }
    // A missing/invalid world packet during a foreshortened pose must not turn
    // its contradictory 2D projection into positive evidence of a release.
    if (this.lastWorld?.foreshortened && timestamp-this.lastWorld.timestamp <= HAND_GEOMETRY.worldHoldMs) {
      return { ratio: null, basis: 'unreliable', pose: 'foreshortened', boundary: atBoundary(hand) };
    }
    return image ? { ...image, basis: 'image', quality: 'image-fallback', pose: 'normal' } : null;
  }
}

// Only tolerate a short label flip for one continuously observed hand that was
// already drawing. No initial Left hand or ambiguous pair can arm drawing.
export class HandIdentity {
  reset() { this.last = null; }
  select({ landmarks, worldLandmarks, handedness, timestamp }, allowHold) {
    const candidates = (handedness ?? []).flatMap((labels, i) => labels?.[0]?.categoryName === 'Right' ? [i] : []);
    if (candidates.length === 1) {
      const index = candidates[0], hand = landmarks?.[index];
      this.last = hand?.[9] && worldGeometry(worldLandmarks?.[index])
        ? { timestamp, anchor: { ...hand[9] } } : null;
      return { index, held: false };
    }
    if (candidates.length || !allowHold || landmarks?.length !== 1 || !this.last
        || timestamp-this.last.timestamp > HAND_GEOMETRY.labelHoldMs
        || !worldGeometry(worldLandmarks?.[0])) return { index: null, held: false };
    const anchor = landmarks[0][9];
    if (!inImage(anchor) || Math.hypot(anchor.x-this.last.anchor.x, anchor.y-this.last.anchor.y)
        > HAND_GEOMETRY.identityDistance) return { index: null, held: false };
    // Do not refresh the last Right timestamp: repeated Left labels expire.
    return { index: 0, held: true };
  }
}

const FINGER_JOINTS = [[8, 6, 5], [12, 10, 9], [16, 14, 13], [20, 18, 17]];

/**
 * Detect a closed fist gesture for 3D shape grabbing while resisting accidental
 * pinch overlap and providing hysteresis for release.
 */
export function detectFist(hand, world, width, height) {
  const useWorld = Array.isArray(world) && world.length === 21
    && world.every(p => p && axes.every(k => Number.isFinite(p[k])));
  const pts = useWorld ? world : hand;
  if (!pts?.[0] || (!useWorld && !(width > 0 && height > 0))) return { fist: false, openForRelease: false };
  const dist = (a, b) => {
    if (!pts[a] || !pts[b]) return null;
    if (!useWorld && (!inImage(pts[a]) || !inImage(pts[b]))) return null;
    return useWorld
      ? Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y, pts[a].z - pts[b].z)
      : Math.hypot((pts[a].x - pts[b].x) * width, (pts[a].y - pts[b].y) * height);
  };
  let validFingers = 0, curled = 0, extended = 0, threeBackCurled = 0;
  let indexRatio = Infinity;
  for (let f = 0; f < FINGER_JOINTS.length; f++) {
    const [tip, pip, mcp] = FINGER_JOINTS[f];
    const dTip = dist(tip, 0), dPip = dist(pip, 0), dMcp = dist(mcp, 0);
    if (!Number.isFinite(dTip) || !Number.isFinite(dPip) || !(dMcp > 1e-6)) continue;
    validFingers++;
    const ratio = dTip / dMcp;
    if (f === 0) indexRatio = ratio;
    const isCurled = ratio <= 1.28 || dTip <= dPip * 1.08;
    const isExtended = ratio >= 1.44 && dTip > dPip * 1.12;
    if (isCurled) {
      curled++;
      if (f > 0) threeBackCurled++;
    }
    if (isExtended) extended++;
  }
  const fist = validFingers >= 4 && (curled === 4 || (threeBackCurled === 3 && indexRatio <= 1.38));
  return { fist, openForRelease: validFingers >= 3 && extended >= 2 };
}
