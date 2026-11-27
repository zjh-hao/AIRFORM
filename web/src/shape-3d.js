import {
  BoxGeometry, Color, ConeGeometry, DoubleSide, EdgesGeometry, Group,
  LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshStandardMaterial,
  Quaternion, SphereGeometry, Vector3,
} from 'three';
import {
  DISPLAY_NAMES, SUPPORTED_PATTERN_TYPES, buildLetterGeometry, buildPatternGeometry,
} from './glyph-3d.js';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function pointToSegDist2d(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 1e-12 ? clamp((wx * vx + wy * vy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

function jacobiSymmetric3(a00, a01, a02, a11, a12, a22) {
  const A = [
    [a00, a01, a02],
    [a01, a11, a12],
    [a02, a12, a22],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 24; iter++) {
    let p = 0, q = 1;
    let maxVal = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > maxVal) { p = 0; q = 2; maxVal = Math.abs(A[0][2]); }
    if (Math.abs(A[1][2]) > maxVal) { p = 1; q = 2; maxVal = Math.abs(A[1][2]); }
    if (maxVal < 1e-10) break;
    const diff = A[q][q] - A[p][p];
    const phi = 0.5 * Math.atan2(2 * A[p][q], diff);
    const c = Math.cos(phi), s = Math.sin(phi);
    const app = c * c * A[p][p] - 2 * s * c * A[p][q] + s * s * A[q][q];
    const aqq = s * s * A[p][p] + 2 * s * c * A[p][q] + c * c * A[q][q];
    A[p][p] = app;
    A[q][q] = aqq;
    A[p][q] = A[q][p] = 0;
    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue;
      const arp = c * A[r][p] - s * A[r][q];
      const arq = s * A[r][p] + c * A[r][q];
      A[r][p] = A[p][r] = arp;
      A[r][q] = A[q][r] = arq;
    }
    for (let r = 0; r < 3; r++) {
      const vrp = c * V[r][p] - s * V[r][q];
      const vrq = s * V[r][p] + c * V[r][q];
      V[r][p] = vrp;
      V[r][q] = vrq;
    }
  }
  return [0, 1, 2].map(i => ({
    val: A[i][i],
    vec: new Vector3(V[0][i], V[1][i], V[2][i]).normalize(),
  })).sort((a, b) => b.val - a.val);
}

function fitPlane(points) {
  const origin = new Vector3();
  for (const p of points) origin.add(p);
  origin.divideScalar(points.length);

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const dx = p.x - origin.x, dy = p.y - origin.y, dz = p.z - origin.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const nPts = points.length;
  const eigen = jacobiSymmetric3(xx / nPts, xy / nPts, xz / nPts, yy / nPts, yz / nPts, zz / nPts);
  const uAxis = eigen[0].vec.clone().normalize();
  let vAxis = eigen[1].vec.clone();
  vAxis.addScaledVector(uAxis, -vAxis.dot(uAxis)).normalize();
  let normal = new Vector3().crossVectors(uAxis, vAxis).normalize();
  if (normal.z < 0) {
    vAxis.negate();
    normal.negate();
  }

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, minN = Infinity, maxN = -Infinity;
  const pts2d = points.map(p => {
    const d = new Vector3(p.x - origin.x, p.y - origin.y, p.z - origin.z);
    const u = d.dot(uAxis), v = d.dot(vAxis), w = d.dot(normal);
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
    if (w < minN) minN = w; if (w > maxN) maxN = w;
    return { x: u, y: v };
  });
  return {
    origin, uAxis, vAxis, normal,
    spanU: maxU - minU, spanV: maxV - minV, spanN: maxN - minN,
    pts2d,
  };
}

function resamplePath2D(pts, count, closed) {
  const source = closed ? [...pts, pts[0]] : pts;
  const cum = [0];
  for (let i = 1; i < source.length; i++) {
    cum.push(cum[i - 1] + dist2d(source[i], source[i - 1]));
  }
  const total = cum.at(-1);
  if (total <= 1e-6) return null;
  const divisor = closed ? count : Math.max(1, count - 1);
  const step = total / divisor;
  const out = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 1e-9 ? (target - cum[seg]) / segLen : 0;
    out.push({
      x: source[seg].x + (source[seg + 1].x - source[seg].x) * t,
      y: source[seg].y + (source[seg + 1].y - source[seg].y) * t,
    });
  }
  return out;
}

function resamplePath3D(vecs, maxPoints = 64) {
  const cum = [0];
  for (let i = 1; i < vecs.length; i++) cum.push(cum[i - 1] + vecs[i].distanceTo(vecs[i - 1]));
  const total = cum.at(-1);
  if (total <= 1e-6) return vecs.map(v => ({ x: v.x, y: v.y, z: v.z }));
  const count = clamp(Math.ceil(total / 0.05) + 1, 16, maxPoints);
  const step = total / (count - 1);
  const out = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 1e-9 ? (target - cum[seg]) / segLen : 0;
    out.push({
      x: vecs[seg].x + (vecs[seg + 1].x - vecs[seg].x) * t,
      y: vecs[seg].y + (vecs[seg + 1].y - vecs[seg].y) * t,
      z: vecs[seg].z + (vecs[seg + 1].z - vecs[seg].z) * t,
    });
  }
  return out;
}

function rdpOpen(pts, eps) {
  if (pts.length <= 2) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const abx = b.x - a.x, aby = b.y - a.y;
  const abLen = Math.hypot(abx, aby);
  let maxDist = -1, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = abLen > 1e-9
      ? Math.abs(abx * (pts[i].y - a.y) - aby * (pts[i].x - a.x)) / abLen
      : dist2d(pts[i], a);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > eps) {
    const left = rdpOpen(pts.slice(0, idx + 1), eps);
    const right = rdpOpen(pts.slice(idx), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [a, b];
}

function pathLength2D(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist2d(pts[i], pts[i - 1]);
  return len;
}

function extractClosedLoop(raw2d, diag, { maxGapRatio, maxArcGapRatio, minWindingTurns, maxWindingTurns }) {
  let pts2d = raw2d;
  const n = pts2d.length;
  if (n < 8) return null;

  const rawLen = pathLength2D(pts2d);
  if (rawLen <= 1e-6) return null;

  const rawGap = dist2d(pts2d[0], pts2d[n - 1]);
  const maxStart = Math.floor(n * 0.12);
  const minEnd = Math.floor(n * 0.85);
  let bestStart = 0, bestEnd = n - 1, bestGap = rawGap;
  for (let i = 0; i <= maxStart; i++) {
    for (let j = minEnd; j < n; j++) {
      if (j - i + 1 < Math.max(8, Math.floor(n * 0.84))) continue;
      const d = dist2d(pts2d[i], pts2d[j]);
      if (d < bestGap) { bestGap = d; bestStart = i; bestEnd = j; }
    }
  }
  if (bestGap <= 0.24 * diag && bestGap < rawGap * 0.9) {
    const trimmed = pts2d.slice(bestStart, bestEnd + 1);
    const trimmedLen = pathLength2D(trimmed);
    // Reject trims that discard a substantial part of a letter (e.g. A crossbar or lowercase 'a' tail).
    if (trimmedLen >= rawLen * 0.84) {
      let maxTailProtrusion = 0;
      const tailIndices = [];
      for (let i = 0; i < bestStart; i++) tailIndices.push(i);
      for (let j = bestEnd + 1; j < n; j++) tailIndices.push(j);
      for (const idx of tailIndices) {
        let nearest = Infinity;
        for (const q of trimmed) {
          const d = dist2d(pts2d[idx], q);
          if (d < nearest) nearest = d;
        }
        if (nearest > maxTailProtrusion) maxTailProtrusion = nearest;
      }
      if (maxTailProtrusion <= 0.20 * diag) {
        pts2d = trimmed;
      }
    }
  }

  const loopLen = pathLength2D(pts2d);
  const endGap = dist2d(pts2d[pts2d.length - 1], pts2d[0]);
  if (endGap > maxGapRatio * diag) return null;
  if (endGap / Math.max(loopLen, 1e-6) > maxArcGapRatio) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts2d) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const boxCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  let winding = 0;
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i], b = pts2d[(i + 1) % pts2d.length];
    winding += Math.atan2(
      (a.x - boxCenter.x) * (b.y - boxCenter.y) - (a.y - boxCenter.y) * (b.x - boxCenter.x),
      (a.x - boxCenter.x) * (b.x - boxCenter.x) + (a.y - boxCenter.y) * (b.y - boxCenter.y),
    );
  }
  const turns = Math.abs(winding) / (2 * Math.PI);
  if (turns < minWindingTurns || turns > maxWindingTurns) return null;
  const tightlyClosed = endGap <= 0.26 * diag && turns >= 0.85;
  return { loop: pts2d, tightlyClosed };
}

function smoothClosedRing(ring, passes = 2) {
  const N = ring.length;
  const weights = [0.1, 0.2, 0.4, 0.2, 0.1];
  let curr = ring;
  for (let p = 0; p < passes; p++) {
    const next = new Array(N);
    for (let i = 0; i < N; i++) {
      let sx = 0, sy = 0;
      for (let k = -2; k <= 2; k++) {
        const pt = curr[(i + k + N) % N];
        const w = weights[k + 2];
        sx += pt.x * w;
        sy += pt.y * w;
      }
      next[i] = { x: sx, y: sy };
    }
    curr = next;
  }
  return curr;
}

function polygonAreaAndCentroid(ring) {
  const N = ring.length;
  let signedArea = 0, sumX = 0, sumY = 0;
  for (let i = 0; i < N; i++) {
    const p = ring[i], q = ring[(i + 1) % N];
    signedArea += p.x * q.y - q.x * p.y;
    sumX += p.x; sumY += p.y;
  }
  return { area: Math.abs(signedArea) * 0.5, centroid: { x: sumX / N, y: sumY / N } };
}

function fitCircleKasa(ring, charRadius) {
  const N = ring.length;
  let mx = 0, my = 0;
  for (const p of ring) { mx += p.x; my += p.y; }
  mx /= N; my /= N;

  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of ring) {
    const u = p.x - mx, v = p.y - my;
    const u2 = u * u, v2 = v * v;
    suu += u2; suv += u * v; svv += v2;
    suuu += u2 * u; svvv += v2 * v;
    suvv += u * v2; svuu += v * u2;
  }
  const det = suu * svv - suv * suv;
  let cx = mx, cy = my, r;
  if (Math.abs(det) > 1e-9) {
    const rhs1 = 0.5 * (suuu + suvv);
    const rhs2 = 0.5 * (svvv + svuu);
    const uc = (rhs1 * svv - rhs2 * suv) / det;
    const vc = (suu * rhs2 - suv * rhs1) / det;
    const rEst = Math.sqrt(uc * uc + vc * vc + (suu + svv) / N);
    if (Number.isFinite(uc) && Number.isFinite(vc) && Number.isFinite(rEst) && rEst > 1e-5) {
      cx = mx + uc;
      cy = my + vc;
      r = rEst;
    }
  }
  if (!(r > 1e-5)) {
    r = ring.reduce((s, p) => s + Math.hypot(p.x - mx, p.y - my), 0) / N;
  }
  const sq = ring.reduce((s, p) => {
    const e = Math.hypot(p.x - cx, p.y - cy) - r;
    return s + e * e;
  }, 0);
  const rms = Math.sqrt(sq / N) / Math.max(charRadius, 1e-6);
  return { cx, cy, r, rms };
}

function fitMaxAreaTriangle(ring, polyArea, charRadius) {
  const N = ring.length;
  const area2 = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

  let i0 = 0, i1 = Math.floor(N / 2), farD = -1;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const d = dist2d(ring[i], ring[j]);
      if (d > farD) { farD = d; i0 = i; i1 = j; }
    }
  }
  let i2 = 0, bestA = -1;
  for (let k = 0; k < N; k++) {
    const a = area2(ring[i0], ring[i1], ring[k]);
    if (a > bestA) { bestA = a; i2 = k; }
  }
  const idx = [i0, i1, i2].sort((a, b) => a - b);
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let slot = 0; slot < 3; slot++) {
      const o1 = idx[(slot + 1) % 3], o2 = idx[(slot + 2) % 3];
      let bestK = idx[slot], bestVal = area2(ring[bestK], ring[o1], ring[o2]);
      for (let k = 0; k < N; k++) {
        if (k === o1 || k === o2) continue;
        const a = area2(ring[k], ring[o1], ring[o2]);
        if (a > bestVal) { bestVal = a; bestK = k; }
      }
      idx[slot] = bestK;
    }
  }
  idx.sort((a, b) => a - b);
  const verts = [ring[idx[0]], ring[idx[1]], ring[idx[2]]];
  const triArea = area2(verts[0], verts[1], verts[2]) * 0.5;

  let minAngle = Math.PI;
  for (let v = 0; v < 3; v++) {
    const a = verts[(v + 2) % 3], b = verts[v], c = verts[(v + 1) % 3];
    const ux = a.x - b.x, uy = a.y - b.y;
    const vx = c.x - b.x, vy = c.y - b.y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) { minAngle = 0; break; }
    const ang = Math.acos(clamp((ux * vx + uy * vy) / (lu * lv), -1, 1));
    if (ang < minAngle) minAngle = ang;
  }

  let sq = 0;
  for (const p of ring) {
    const d0 = pointToSegDist2d(p, verts[0], verts[1]);
    const d1 = pointToSegDist2d(p, verts[1], verts[2]);
    const d2 = pointToSegDist2d(p, verts[2], verts[0]);
    const d = Math.min(d0, d1, d2);
    sq += d * d;
  }
  const rms = Math.sqrt(sq / N) / Math.max(charRadius, 1e-6);
  const areaRatio = triArea > 1e-9 ? polyArea / triArea : Infinity;
  return { verts, triArea, minAngle, areaRatio, rms };
}

function fitObbRectangle(ring, polyArea, charRadius) {
  let best = { area: Infinity, w: 0, h: 0, angle: 0, center: { x: 0, y: 0 } };
  const steps = 45;
  for (let s = 0; s < steps; s++) {
    const theta = (s / steps) * (Math.PI / 2);
    const c = Math.cos(theta), sn = Math.sin(theta);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of ring) {
      const rx = p.x * c + p.y * sn;
      const ry = -p.x * sn + p.y * c;
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    }
    const w = maxX - minX, h = maxY - minY, area = w * h;
    if (area < best.area) {
      const cxRot = (minX + maxX) / 2, cyRot = (minY + maxY) / 2;
      best = {
        area, w, h, angle: theta,
        center: { x: cxRot * c - cyRot * sn, y: cxRot * sn + cyRot * c },
      };
    }
  }
  const hw = best.w * 0.5, hh = best.h * 0.5;
  const c = Math.cos(best.angle), sn = Math.sin(best.angle);
  const verts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
    x: best.center.x + lx * c - ly * sn,
    y: best.center.y + lx * sn + ly * c,
  }));

  let sq = 0;
  for (const p of ring) {
    let minD = Infinity;
    for (let e = 0; e < 4; e++) {
      const d = pointToSegDist2d(p, verts[e], verts[(e + 1) % 4]);
      if (d < minD) minD = d;
    }
    sq += minD * minD;
  }
  const rms = Math.sqrt(sq / ring.length) / Math.max(charRadius, 1e-6);
  const aspect = Math.max(best.w, best.h) > 1e-6 ? Math.min(best.w, best.h) / Math.max(best.w, best.h) : 0;
  const obbFill = best.area > 1e-6 ? polyArea / best.area : 0;
  return { ...best, verts, aspect, obbFill, rms };
}

function fitClosedCanonicalShape(pts2d, diag, { relaxed = false, allowEllipse = false } = {}) {
  const extracted = extractClosedLoop(pts2d, diag, {
    maxGapRatio: relaxed ? 0.38 : 0.36,
    maxArcGapRatio: relaxed ? 0.20 : 0.19,
    minWindingTurns: relaxed ? 0.78 : 0.80,
    maxWindingTurns: relaxed ? 1.65 : 1.55,
  });
  if (!extracted) return null;
  const { loop, tightlyClosed } = extracted;

  const rawRing = resamplePath2D(loop, 64, true);
  if (!rawRing) return null;
  const ring = smoothClosedRing(rawRing, 2);
  const { area, centroid } = polygonAreaAndCentroid(ring);
  if (area <= 1e-5) return null;

  const charRadius = Math.sqrt(area / Math.PI);
  const circle = fitCircleKasa(ring, charRadius);
  const rect = fitObbRectangle(ring, area, charRadius);
  const tri = fitMaxAreaTriangle(ring, area, charRadius);

  const maxErr = relaxed ? 0.175 : (tightlyClosed ? 0.165 : 0.145);
  const candidates = [];

  if (tri.minAngle >= (22 * Math.PI) / 180 && tri.areaRatio >= 0.70 && tri.areaRatio <= 1.42 && tri.rms <= maxErr) {
    candidates.push({ kind: 'triangle', rms: tri.rms, verts: tri.verts, triArea: tri.triArea, centroid });
  }
  if (rect.aspect >= 0.38 && rect.obbFill >= 0.76 && rect.rms <= maxErr) {
    candidates.push({ kind: 'rectangle', rms: rect.rms, rect });
  }
  if (rect.aspect >= 0.70 && rect.obbFill <= 0.86 && circle.rms <= maxErr) {
    candidates.push({ kind: 'circle', rms: circle.rms, circle });
  }
  if (allowEllipse && rect.aspect >= 0.40 && rect.aspect < 0.70 && rect.obbFill <= 0.85) {
    const rx = rect.w * 0.5, ry = rect.h * 0.5;
    if (rx > 1e-5 && ry > 1e-5) {
      const cs = Math.cos(rect.angle), sn = Math.sin(rect.angle);
      let sq = 0;
      for (const p of ring) {
        const dx = p.x - rect.center.x, dy = p.y - rect.center.y;
        const lx = (dx * cs + dy * sn) / rx;
        const ly = (-dx * sn + dy * cs) / ry;
        const e = Math.hypot(lx, ly) - 1;
        sq += e * e;
      }
      const ellipseRms = Math.sqrt(sq / ring.length);
      if (ellipseRms <= 0.13) {
        candidates.push({ kind: 'ellipse', rms: ellipseRms, rect });
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.rms - b.rms);
  return { winner: candidates[0], centroid, charRadius, rect, circle, tri };
}

function sampleLine3D(a, b, maxStep = 0.075, minSteps = 12) {
  const len = a.distanceTo(b);
  const steps = Math.max(minSteps, Math.ceil(len / maxStep));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    });
  }
  return out;
}

function samplePolyline2D(verts2d, toWorld, closed, perEdge = 12) {
  const out = [];
  const edgeCount = closed ? verts2d.length : verts2d.length - 1;
  for (let e = 0; e < edgeCount; e++) {
    const a = verts2d[e], b = verts2d[(e + 1) % verts2d.length];
    const segLen = dist2d(a, b);
    const steps = Math.max(perEdge, Math.ceil(segLen / 0.06));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push(toWorld({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
    }
  }
  out.push(toWorld(closed ? verts2d[0] : verts2d[verts2d.length - 1]));
  return out;
}

function fitArc2D(pts2d) {
  if (pts2d.length < 6) return null;
  const open = resamplePath2D(pts2d, 48, false);
  if (!open) return null;
  const a = open[0], b = open[Math.floor(open.length / 2)], c = open[open.length - 1];
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const R = Math.hypot(a.x - cx, a.y - cy);
  if (!Number.isFinite(R) || R < 0.15 || R > 20) return null;

  let sqSum = 0, maxErr = 0;
  let prevAng = Math.atan2(open[0].y - cy, open[0].x - cx);
  const startAng = prevAng;
  let totalSweep = 0, sign = 0;
  for (let i = 0; i < open.length; i++) {
    const err = Math.abs(Math.hypot(open[i].x - cx, open[i].y - cy) - R);
    sqSum += err * err;
    if (err > maxErr) maxErr = err;
    if (i > 0) {
      let da = Math.atan2(open[i].y - cy, open[i].x - cx) - prevAng;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) > 1e-4) {
        if (sign === 0) sign = Math.sign(da);
        else if (Math.sign(da) !== sign && Math.abs(da) > 0.18) return null;
      }
      totalSweep += da;
      prevAng += da;
    }
  }
  const rmsErr = Math.sqrt(sqSum / open.length);
  const absSweep = Math.abs(totalSweep);
  if (absSweep < (25 * Math.PI) / 180 || absSweep > (330 * Math.PI) / 180) return null;
  if (rmsErr / R > 0.085 || maxErr > 0.16 || maxErr / R > 0.16) return null;

  const steps = Math.max(24, Math.min(48, Math.ceil(absSweep / (Math.PI / 24))));
  const arcPts = [];
  for (let i = 0; i <= steps; i++) {
    const ang = startAng + (totalSweep * i) / steps;
    arcPts.push({ x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) });
  }
  return arcPts;
}

function chaikinSmooth3D(vecs, rounds = 3) {
  let pts = resamplePath3D(vecs, 56);
  for (let r = 0; r < rounds; r++) {
    if (pts.length < 3) break;
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (i > 0) next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      if (i < pts.length - 2) next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return resamplePath3D(pts.map(p => new Vector3(p.x, p.y, p.z)), 48);
}

/**
 * Snap hand-drawn strokes into clean lines, arcs, circles/ellipses,
 * squares/rectangles, triangles, sharp polylines, or smooth curves.
 */
export function regularizeStroke(points) {
  if (!Array.isArray(points) || points.length < 4) return null;
  const vecs = points.map(p => new Vector3(p.x, p.y, p.z));
  let totalLen = 0;
  for (let i = 1; i < vecs.length; i++) totalLen += vecs[i].distanceTo(vecs[i - 1]);
  if (totalLen < 0.12) return null;

  // Step A: Straight 3D line segment
  const p0 = vecs[0], p1 = vecs[vecs.length - 1];
  const chord = p0.distanceTo(p1);
  if (chord >= 0.12 && chord / totalLen >= 0.78) {
    const dir = p1.clone().sub(p0).divideScalar(chord);
    let maxDev = 0;
    for (const p of vecs) {
      const ap = p.clone().sub(p0);
      const proj = clamp(ap.dot(dir), 0, chord);
      const dev = p.distanceTo(p0.clone().addScaledVector(dir, proj));
      if (dev > maxDev) maxDev = dev;
    }
    if (maxDev <= Math.max(0.08 * chord, 0.055)) {
      return { kind: 'line', points: sampleLine3D(p0, p1) };
    }
  }

  const fitted = fitPlane(vecs);
  const { origin, uAxis, vAxis, spanU, spanV, spanN } = fitted;
  const raw2d = fitted.pts2d;
  const maxPlanar = Math.max(spanU, spanV);
  const diag = Math.hypot(spanU, spanV);
  const toWorld = p2 => ({
    x: origin.x + uAxis.x * p2.x + vAxis.x * p2.y,
    y: origin.y + uAxis.y * p2.x + vAxis.y * p2.y,
    z: origin.z + uAxis.z * p2.x + vAxis.z * p2.y,
  });

  if (maxPlanar >= 0.14 && spanN / maxPlanar <= 0.82) {
    // Step B: Direct geometric fitting on pre-smoothed closed loop
    const match = fitClosedCanonicalShape(raw2d, diag, { relaxed: true, allowEllipse: true });
    if (match) {
      const { winner } = match;
      if (winner.kind === 'triangle') {
        return { kind: 'triangle', points: samplePolyline2D(winner.verts, toWorld, true, 14) };
      }
      if (winner.kind === 'rectangle') {
        const { rect } = winner;
        const isSquare = rect.aspect >= 0.75;
        const hw = (isSquare ? (rect.w + rect.h) * 0.5 : rect.w) * 0.5;
        const hh = isSquare ? hw : rect.h * 0.5;
        const c = Math.cos(rect.angle), sn = Math.sin(rect.angle);
        const rectVerts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
          x: rect.center.x + lx * c - ly * sn,
          y: rect.center.y + lx * sn + ly * c,
        }));
        return { kind: 'rectangle', points: samplePolyline2D(rectVerts, toWorld, true, 12) };
      }
      if (winner.kind === 'circle') {
        const { cx, cy, r } = winner.circle;
        const steps = 64;
        const loop2d = [];
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          loop2d.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        return { kind: 'circle', points: loop2d.map(toWorld) };
      }
      if (winner.kind === 'ellipse') {
        const { rect } = winner;
        const rx = rect.w * 0.5, ry = rect.h * 0.5;
        const c = Math.cos(rect.angle), sn = Math.sin(rect.angle);
        const steps = 64;
        const loop2d = [];
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const lx = rx * Math.cos(a), ly = ry * Math.sin(a);
          loop2d.push({ x: rect.center.x + lx * c - ly * sn, y: rect.center.y + lx * sn + ly * c });
        }
        return { kind: 'ellipse', points: loop2d.map(toWorld) };
      }
    }

    // Step C: Open polyline (2-4 straight segments with crisp corners)
    const openVerts = rdpOpen(raw2d, 0.075 * diag);
    if (openVerts.length >= 3 && openVerts.length <= 5) {
      let validPoly = true;
      for (let i = 1; i < openVerts.length - 1; i++) {
        const ax = openVerts[i].x - openVerts[i - 1].x, ay = openVerts[i].y - openVerts[i - 1].y;
        const bx = openVerts[i + 1].x - openVerts[i].x, by = openVerts[i + 1].y - openVerts[i].y;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la < 0.10 || lb < 0.10) { validPoly = false; break; }
        const turnAngle = Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1));
        if (turnAngle < (25 * Math.PI) / 180) { validPoly = false; break; }
      }
      if (validPoly) {
        let searchFrom = 0;
        const indices = openVerts.map(v => {
          let bestIdx = searchFrom, bestD = Infinity;
          for (let j = searchFrom; j < raw2d.length; j++) {
            const d = dist2d(raw2d[j], v);
            if (d < bestD) { bestD = d; bestIdx = j; }
          }
          searchFrom = bestIdx;
          return bestIdx;
        });
        for (let s = 0; s < openVerts.length - 1 && validPoly; s++) {
          const a = openVerts[s], b = openVerts[s + 1];
          const segLen = dist2d(a, b);
          const dx = b.x - a.x, dy = b.y - a.y;
          for (let j = indices[s]; j <= indices[s + 1]; j++) {
            const d = segLen > 1e-6 ? Math.abs(dx * (raw2d[j].y - a.y) - dy * (raw2d[j].x - a.x)) / segLen : 0;
            if (d > Math.max(0.085 * segLen, 0.045)) { validPoly = false; break; }
          }
        }
        if (validPoly) {
          return { kind: 'polyline', points: samplePolyline2D(openVerts, toWorld, false, 10) };
        }
      }
    }

    // Step D: Open circular arc
    const arc2d = fitArc2D(raw2d);
    if (arc2d) {
      return { kind: 'arc', points: arc2d.map(toWorld) };
    }
  }

  // Step E: Smooth curve fallback
  return { kind: 'curve', points: chaikinSmooth3D(vecs, 3) };
}

/**
 * Recognize near-closed 2D hand-drawn shapes (circle, square/rectangle, triangle)
 * projected on their best-fit stroke plane and return 3D primitive descriptors.
 */
export function recognizeShape3D(points) {
  if (!Array.isArray(points) || points.length < 8) return null;
  const vecs = points.map(p => new Vector3(p.x, p.y, p.z));
  let totalLen = 0;
  for (let i = 1; i < vecs.length; i++) totalLen += vecs[i].distanceTo(vecs[i - 1]);
  if (totalLen < 0.45) return null;

  const fitted = fitPlane(vecs);
  const { origin, uAxis, vAxis, normal, spanU, spanV, spanN, pts2d } = fitted;
  const maxPlanar = Math.max(spanU, spanV);
  const diag = Math.hypot(spanU, spanV);
  if (maxPlanar < 0.22 || diag < 0.25) return null;
  if (spanN / maxPlanar > 0.75) return null;

  const match = fitClosedCanonicalShape(pts2d, diag, { relaxed: false, allowEllipse: false });
  if (!match) return null;
  const { winner } = match;

  const plane = {
    uAxis: { x: uAxis.x, y: uAxis.y, z: uAxis.z },
    vAxis: { x: vAxis.x, y: vAxis.y, z: vAxis.z },
    normal: { x: normal.x, y: normal.y, z: normal.z },
  };
  const toWorld = p2 => ({
    x: origin.x + uAxis.x * p2.x + vAxis.x * p2.y,
    y: origin.y + uAxis.y * p2.x + vAxis.y * p2.y,
    z: origin.z + uAxis.z * p2.x + vAxis.z * p2.y,
  });

  if (winner.kind === 'triangle') {
    const triVerts = winner.verts;
    const cx = (triVerts[0].x + triVerts[1].x + triVerts[2].x) / 3;
    const cy = (triVerts[0].y + triVerts[1].y + triVerts[2].y) / 3;
    const rMean = (dist2d(triVerts[0], { x: cx, y: cy }) + dist2d(triVerts[1], { x: cx, y: cy }) + dist2d(triVerts[2], { x: cx, y: cy })) / 3;
    const radius = clamp(rMean * 0.96, 0.22, 2.4);
    const height = clamp(radius * 1.45, 0.32, 3.2);
    return {
      type: 'pyramid',
      center: toWorld({ x: cx, y: cy }),
      radius,
      height,
      plane,
      hitRadius: Math.max(radius, height * 0.5),
    };
  }

  if (winner.kind === 'rectangle') {
    const { rect } = winner;
    const isSquare = rect.aspect >= 0.76;
    const width = clamp(isSquare ? (rect.w + rect.h) * 0.5 : rect.w, 0.25, 3.0);
    const height = clamp(isSquare ? width : rect.h, 0.25, 3.0);
    const depth = clamp(isSquare ? width : Math.min(rect.w, rect.h), 0.25, 3.0);
    return {
      type: 'cube',
      center: toWorld(rect.center),
      size: { x: width, y: height, z: depth },
      obbAngle: rect.angle,
      plane,
      hitRadius: Math.hypot(width, height, depth) * 0.5,
    };
  }

  if (winner.kind === 'circle') {
    const { cx, cy, r } = winner.circle;
    const radius = clamp(r, 0.15, 2.2);
    return {
      type: 'sphere',
      center: toWorld({ x: cx, y: cy }),
      radius,
      plane,
      hitRadius: radius,
    };
  }

  return null;
}

function makeTranslucentMaterial(baseColor) {
  return new MeshStandardMaterial({
    color: baseColor.clone(),
    emissive: baseColor.clone(),
    emissiveIntensity: 0.22,
    roughness: 0.28,
    metalness: 0.05,
    transparent: true,
    opacity: 0.46,
    depthWrite: false,
    side: DoubleSide,
  });
}

function addTranslucentFacetedBody(group, bodyGeo, bodyMat, baseColor, highlightTargets) {
  const body = new Mesh(bodyGeo, bodyMat);
  body.renderOrder = 2;
  const edgeMat = new LineBasicMaterial({ color: baseColor.clone(), transparent: true, opacity: 0.42 });
  highlightTargets.push({ material: edgeMat, type: 'line', base: edgeMat.opacity });
  const edges = new LineSegments(new EdgesGeometry(bodyGeo, 24), edgeMat);
  group.add(body, edges);
}

/**
 * Convert a backend ONNX model recognition result + raw 3D stroke points into a
 * normalized 3D shape/pattern/letter descriptor centered at the stroke bounding box.
 */
export function descriptorFromModelResult(result, strokePointsList) {
  if (!result?.recognized || !Array.isArray(strokePointsList) || !strokePointsList.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let count = 0;
  for (const pts of strokePointsList) {
    if (!Array.isArray(pts)) continue;
    for (const p of pts) {
      if (!p) continue;
      count++;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
  }
  if (count < 4) return null;
  const center = { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, z: (minZ + maxZ) * 0.5 };
  const spanX = maxX - minX, spanY = maxY - minY;
  const radius = clamp(Math.max(spanX, spanY) * 0.52, 0.34, 1.85);
  const type = result.type;

  if (type === 'sphere') {
    return { type: 'sphere', center, radius, hitRadius: radius, displayName: DISPLAY_NAMES.sphere };
  }
  if (type === 'cube') {
    const side = clamp(radius * 1.6, 0.35, 2.4);
    return { type: 'cube', center, size: { x: side, y: side, z: side }, hitRadius: side * 0.86, displayName: DISPLAY_NAMES.cube };
  }
  if (type === 'pyramid') {
    const height = clamp(radius * 1.45, 0.36, 2.8);
    return { type: 'pyramid', center, radius, height, hitRadius: Math.max(radius, height * 0.5), displayName: DISPLAY_NAMES.pyramid };
  }
  if (type === 'letter' && result.char) {
    const ch = String(result.char).trim().toUpperCase().slice(0, 1);
    return {
      type: 'letter',
      char: ch,
      displayName: result.displayName || `字母 ${ch}`,
      center,
      radius,
      hitRadius: radius,
    };
  }
  if (SUPPORTED_PATTERN_TYPES.includes(type)) {
    return {
      type,
      displayName: result.displayName || DISPLAY_NAMES[type] || type,
      center,
      radius,
      hitRadius: radius,
    };
  }
  return null;
}

/**
 * Create a clean translucent pure-color 3D Group from a recognized shape
 * descriptor with subtle edge outlines for polygonal facets and highlight targets.
 */
export function createShape3DMesh(shape, style = {}) {
  const baseColor = new Color(style.color || '#35bfff');
  const bodyMat = makeTranslucentMaterial(baseColor);
  const highlightTargets = [
    { material: bodyMat, type: 'body', baseEmissive: bodyMat.emissiveIntensity, baseOpacity: bodyMat.opacity },
  ];

  const group = new Group();
  group.name = shape.type === 'letter' && shape.char ? `airform-letter-${shape.char}` : `airform-${shape.type}`;
  group.position.set(shape.center.x, shape.center.y, shape.center.z);

  if (shape.type === 'sphere') {
    const body = new Mesh(new SphereGeometry(shape.radius, 28, 20), bodyMat);
    body.renderOrder = 2;
    group.add(body);
  } else if (shape.type === 'cube') {
    const { x: sx, y: sy, z: sz } = shape.size;
    addTranslucentFacetedBody(group, new BoxGeometry(sx, sy, sz), bodyMat, baseColor, highlightTargets);
    if (shape.plane) {
      const u = new Vector3(shape.plane.uAxis.x, shape.plane.uAxis.y, shape.plane.uAxis.z);
      const v = new Vector3(shape.plane.vAxis.x, shape.plane.vAxis.y, shape.plane.vAxis.z);
      const n = new Vector3(shape.plane.normal.x, shape.plane.normal.y, shape.plane.normal.z);
      const basis = new Matrix4().makeBasis(u, v, n);
      group.quaternion.setFromRotationMatrix(basis);
      if (Number.isFinite(shape.obbAngle)) {
        group.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), shape.obbAngle));
      }
      group.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.38));
      group.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.26));
    }
  } else if (shape.type === 'pyramid') {
    addTranslucentFacetedBody(group, new ConeGeometry(shape.radius, shape.height, 4), bodyMat, baseColor, highlightTargets);
    // Keep pyramid base horizontal and apex strictly upright (+Y).
    group.rotation.set(0, Math.PI / 4 + 0.22, 0);
  } else if (shape.type === 'letter') {
    addTranslucentFacetedBody(group, buildLetterGeometry(shape.char, shape.radius), bodyMat, baseColor, highlightTargets);
    group.rotation.set(0.06, -0.18, 0);
  } else if (SUPPORTED_PATTERN_TYPES.includes(shape.type)) {
    addTranslucentFacetedBody(group, buildPatternGeometry(shape.type, shape.radius), bodyMat, baseColor, highlightTargets);
    group.rotation.set(0.06, -0.18, 0);
  } else {
    throw new Error(`Unsupported 3D shape type: ${shape.type}`);
  }

  group.userData = {
    shape3d: true,
    shapeType: shape.type,
    shapeChar: shape.char ?? null,
    displayName: shape.displayName ?? DISPLAY_NAMES[shape.type] ?? shape.type,
    hitRadius: shape.hitRadius,
    highlightTargets,
  };
  return group;
}
