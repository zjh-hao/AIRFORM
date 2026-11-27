import { Vector3 } from 'three';

function downsample2d(points, maxCount = 64) {
  if (!Array.isArray(points) || points.length <= maxCount) return points;
  const out = [];
  const step = (points.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

/**
 * Project a 3D stroke into viewer-upright 2D coordinates (+X right, +Y up)
 * with fixed precision for compact POST /api/sketch/recognize payloads.
 */
export function projectStrokeForModel(points, camera = null) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const sampled = downsample2d(points, 64);
  const aspect = camera && Number.isFinite(camera.top - camera.bottom) && Math.abs(camera.top - camera.bottom) > 1e-6
    ? Math.abs((camera.right - camera.left) / (camera.top - camera.bottom))
    : 1.0;

  return sampled.map(p => {
    if (camera) {
      const v = new Vector3(p.x, p.y, p.z).project(camera);
      return [
        Math.round(v.x * aspect * 1000) / 1000,
        Math.round(v.y * 1000) / 1000,
      ];
    }
    return [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000];
  });
}

export async function recognizeSketchRemote({
  strokes,
  closedHint = false,
  fallbackStrokes = null,
  fallbackClosedHint = false,
  timeoutMs = 1800,
} = {}) {
  if (typeof fetch !== 'function' || typeof location !== 'undefined' && location.protocol === 'file:') {
    return null;
  }
  if (!Array.isArray(strokes) || !strokes.length) return null;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const payload = { strokes, closedHint: Boolean(closedHint) };
    if (Array.isArray(fallbackStrokes) && fallbackStrokes.length) {
      payload.fallbackStrokes = fallbackStrokes;
      payload.fallbackClosedHint = Boolean(fallbackClosedHint);
    }
    const response = await fetch('/api/sketch/recognize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-KineGlow-Client': '1',
      },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.recognized ? data : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
