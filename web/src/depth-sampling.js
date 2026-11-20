// Absolute depth is anchored to Astra. Any model-assisted/held estimate is
// explicitly labeled; MediaPipe's relative z is never used as absolute range.
export const DEPTH_SCENE = Object.freeze({ unitsPerMeter: 5, originDepthMeters: 1 });

export function validateDepthFrame(frame) {
  if (!frame || frame.width !== 640 || frame.height !== 480 || frame.depth_unit !== 'mm'
      || frame.coordinate_system !== 'color-camera' || frame.mirrored !== false
      || frame.registration !== 'factory-calibrated-software'
      || !(frame.depth instanceof Uint16Array) || frame.depth.length !== frame.width * frame.height
      || !Array.isArray(frame.intrinsics) || frame.intrinsics.length !== 4
      || !frame.intrinsics.every(Number.isFinite) || frame.intrinsics[0] <= 0 || frame.intrinsics[1] <= 0
      || !Array.isArray(frame.distortion) || frame.distortion.length !== 5 || !frame.distortion.every(Number.isFinite)) {
    throw new Error('Astra 深度帧格式、单位或标定无效');
  }
  return frame;
}

export const DEPTH_SAMPLE = Object.freeze({ radius: 2, minPixels: 3, clusterGapMm: 20,
  maxSpanMm: 60, maxInsetPixels: 10 });

function foregroundCluster(values) {
  // A fingertip patch naturally contains both hand and background. Keep the
  // nearest coherent surface, not the range/median of these different surfaces.
  // Isolated speckles never become a surface merely by being nearer.
  values.sort((a, b) => a - b);
  let cluster = [];
  for (const value of values) {
    if (cluster.length && (value - cluster.at(-1) > DEPTH_SAMPLE.clusterGapMm
        || value - cluster[0] > DEPTH_SAMPLE.maxSpanMm)) {
      if (cluster.length >= DEPTH_SAMPLE.minPixels) return cluster;
      cluster = [];
    }
    cluster.push(value);
  }
  return cluster.length >= DEPTH_SAMPLE.minPixels ? cluster : null;
}

export function sampleTipDepth(tip, frame, hand = null) {
  if (!frame || !Number.isFinite(tip?.x) || !Number.isFinite(tip.y)
      || tip.x < 0 || tip.x > 1 || tip.y < 0 || tip.y > 1) return { reason: '指尖或深度帧无效' };
  const u = Math.min(frame.width - 1, Math.round(tip.x * frame.width));
  const v = Math.min(frame.height - 1, Math.round(tip.y * frame.height));
  const candidates = [{ u, v, inset: 0 }];
  const dip = hand?.[7];
  if (Number.isFinite(dip?.x) && Number.isFinite(dip.y)) {
    const dx = dip.x * frame.width - u, dy = dip.y * frame.height - v;
    const length = Math.hypot(dx, dy);
    if (length > 0) for (const fraction of [.35, .65]) {
      const inset = Math.min(DEPTH_SAMPLE.maxInsetPixels, length * fraction);
      candidates.push({ u: Math.round(u + dx * inset / length), v: Math.round(v + dy * inset / length), inset });
    }
  }
  let bestCount = 0;
  const samples = [];
  for (const sample of candidates) {
    if (sample.u < 0 || sample.u >= frame.width || sample.v < 0 || sample.v >= frame.height) continue;
    const values = [], r = DEPTH_SAMPLE.radius;
    for (let y = Math.max(0, sample.v - r); y <= Math.min(frame.height - 1, sample.v + r); y++) {
      for (let x = Math.max(0, sample.u - r); x <= Math.min(frame.width - 1, sample.u + r); x++) {
        const z = frame.depth[y * frame.width + x];
        if (z >= 200 && z <= 4000) values.push(z);
      }
    }
    bestCount = Math.max(bestCount, values.length);
    const cluster = foregroundCluster(values);
    if (!cluster) continue;
    const middle = Math.floor(cluster.length / 2);
    samples.push({ u, v, z: (cluster.length % 2 ? cluster[middle] : (cluster[middle - 1] + cluster[middle]) / 2) / 1000,
      sampleU: sample.u, sampleV: sample.v, insetPixels: sample.inset, validPixels: cluster.length });
  }
  if (samples.length) return samples.reduce((best, sample) => sample.z < best.z - .02 ? sample : best);
  return { reason: `指尖邻域没有可靠深度（最多 ${bestCount} 个有效像素），等待深度恢复` };
}

export function measuredPoint(tip, frame, hand = null) {
  const sample = sampleTipDepth(tip, frame, hand);
  if (sample.reason) return null;
  return cameraPoint(sample, frame);
}

export function cameraPoint(sample, frame) {
  const { u, v, z } = sample;
  const [fx, fy, cx, cy] = frame.intrinsics;
  const xd = (u - cx) / fx, yd = (v - cy) / fy;
  const [k1, k2, p1, p2, k3] = frame.distortion;
  let x = xd, y = yd;
  // Invert Brown-Conrady distortion, matching the color calibration used by OpenCV.
  for (let i = 0; i < 12; i++) {
    const r2 = x * x + y * y, radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
    if (!Number.isFinite(radial) || radial <= 0) return null;
    const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
    x = (xd - dx) / radial; y = (yd - dy) / radial;
  }
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x: x * z, y: y * z, z };
}

export function mapDepthPoint(tip, frame, hand = null) {
  const point = measuredPoint(tip, frame, hand);
  if (!point) return null;
  const scale = DEPTH_SCENE.unitsPerMeter;
  // Exactly one X mirror, Y up, nearer camera => positive scene Z.
  return { x: -point.x * scale, y: -point.y * scale,
    z: (DEPTH_SCENE.originDepthMeters - point.z) * scale };
}
