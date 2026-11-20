// Normalize pinch using the visible wrist/MCP when possible. When those points
// leave the image, visible palm spans transfer the last calibrated scale. This
// is only gesture normalization; it never supplies metric camera depth.
export const BOUNDARY = Object.freeze({ pauseMs: 300, scaleHoldMs: 600, recoveryDistance: .08 });
const SPANS = [[0,5],[0,9],[0,17],[5,9],[9,13],[13,17]];
export const inImage = p => p && Number.isFinite(p.x) && Number.isFinite(p.y)
  && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const distance = (a,b,w,h) => Math.hypot((a.x-b.x)*w,(a.y-b.y)*h);
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];

export function atBoundary(hand) {
  return [0,5,9,13,17,20].some(i => !inImage(hand?.[i])
    || Math.min(hand[i].x,1-hand[i].x,hand[i].y,1-hand[i].y) < .04);
}

export class GestureScale {
  reset() { this.reference = null; }
  observe(hand, width, height, timestamp) {
    if (!(width > 0 && height > 0) || ![width,height].every(Number.isFinite)
        || !inImage(hand?.[4]) || !inImage(hand?.[8])) return null;
    const spans = SPANS.map(([a,b]) => inImage(hand[a]) && inImage(hand[b])
      ? distance(hand[a],hand[b],width,height) : 0);
    let palm;
    const partial = !inImage(hand[0]) || !inImage(hand[9]);
    if (!partial) {
      palm = distance(hand[0],hand[9],width,height);
      if (palm <= 1e-6) return null;
      this.reference = { palm, spans, timestamp, width, height };
    } else {
      const ref = this.reference;
      if (!ref || ref.width !== width || ref.height !== height) return null;
      const candidates = spans.flatMap((length,i) => length > 5 && ref.spans[i] > 5
        ? [length/ref.spans[i]*ref.palm] : []);
      const center = candidates.length ? median(candidates) : NaN;
      const consensus = candidates.filter(value => Math.abs(value/center-1) <= .2);
      if (consensus.length >= 2 && center/ref.palm >= .5 && center/ref.palm <= 2) palm = median(consensus);
      else if (timestamp-ref.timestamp <= BOUNDARY.scaleHoldMs) palm = ref.palm;
      else return null;
    }
    return { ratio: distance(hand[4],hand[8],width,height)/palm, partial, boundary: atBoundary(hand) };
  }
}
