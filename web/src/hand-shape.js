import { cameraPoint } from './depth-sampling.js';

const BONES = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 9], [9, 13], [13, 17]];

export function unitHandShape(hand, frame) {
  if (!Array.isArray(hand) || !hand[0] || !Number.isFinite(hand[0].z)) return null;
  const points = hand.map(p => {
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return null;
    const z = 1 + (p.z - hand[0].z) * frame.width / frame.intrinsics[0];
    if (z < .6 || z > 1.4) return null;
    return cameraPoint({ u: p.x * frame.width, v: p.y * frame.height, z }, frame);
  });
  if (!points[8]) return null;
  const bones = BONES.map(([a, b]) => points[a] && points[b]
    ? Math.hypot(...['x', 'y', 'z'].map(axis => points[a][axis] - points[b][axis])) : 0);
  // Observations can use any visible anchors. Requiring a whole palm here
  // discarded valid finger/MCP depth as soon as the wrist left the image.
  return { points, bones };
}
