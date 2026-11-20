import { cameraPoint, sampleTipDepth } from './depth-sampling.js';
import { unitHandShape as shape } from './hand-shape.js';

// Engineering adaptation of whole-hand/kinematic temporal tracking (Mueller
// et al., ICCV 2017), not a reproduction of its CNN or optimizer. Metric scale
// comes from Astra; relative model Z/bones constrain only short occlusions.
export const HAND_FUSION = Object.freeze({ predictionMs: 900,
  maxGapMs: 250, consensusMeters: .08, maxScaleChange: .35, maxSpeedMps: 1.5, maxBoneScaleError: .35 });
const ANCHORS = [0, 5, 6, 9, 10, 13, 14, 17, 18];
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};


function observe(tip, frame, hand, model) {
  const direct = sampleTipDepth(tip, frame, hand);
  if (!model) return { ...direct, source: direct.reason ? 'invalid' : 'tip-measured' };
  const roots = [], seen = new Set();
  for (const i of ANCHORS) {
    if (!model.points[i]) continue;
    const key = `${Math.round(hand[i].x * frame.width)},${Math.round(hand[i].y * frame.height)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sample = sampleTipDepth(hand[i], frame);
    if (!sample.reason) roots.push(sample.z / model.points[i].z);
  }
  roots.sort((a, b) => a - b);
  let consensus = [];
  for (let i = 0; i < roots.length; i++) {
    const group = roots.slice(i).filter(z => z - roots[i] <= HAND_FUSION.consensusMeters);
    if (group.length > consensus.length) consensus = group;
  }
  const anchors = consensus.length;
  if (anchors < 2) return { ...direct, source: direct.reason ? 'invalid' : 'tip-measured' };
  const root = median(consensus), estimate = root * model.points[8].z;
  if (!direct.reason && Math.abs(direct.z - estimate) <= .12) return { ...direct, source: 'tip-measured', anchors };
  return { u: tip.x * frame.width, v: tip.y * frame.height, z: estimate,
    source: 'hand-estimated', anchors };
}

export function sampleHandDepth(tip, frame, hand = null) {
  if (!frame || !Number.isFinite(tip?.x) || !Number.isFinite(tip.y)
      || tip.x < 0 || tip.x > 1 || tip.y < 0 || tip.y > 1) return { source: 'invalid', reason: '指尖或深度帧无效' };
  return observe(tip, frame, hand, shape(hand, frame));
}

function consistentMetricScale(sample, model, reference) {
  if (!model || !reference) return true;
  const root = sample.z/model.points[8].z;
  const ratios = model.bones.flatMap((length,i) => length > .015 && reference.lengths[i] > .015
    ? [length*root/reference.lengths[i]] : []);
  const required = model.bones.filter(length=>length>.015).length >= 5 ? 5 : 3;
  // A depth-source switch that suddenly makes the physical palm much larger
  // is not evidence of a real relocation. Actual forward/backward motion also
  // changes the RGB hand scale, keeping these metric lengths approximately fixed.
  return ratios.filter(ratio=>Math.abs(ratio-1)<=HAND_FUSION.maxBoneScaleError).length >= required;
}

export class HandPoseFusion {
  constructor() { this.reset(); }
  reset() {
    this.last = null; this.reference = null; this.pose = null;
    this.sample = { source: 'invalid', reason: '等待有效手部深度' };
  }

  update(tip, frame, hand, timestamp, { allowGap = false } = {}) {
    if (!Number.isFinite(timestamp) || !frame || !Number.isFinite(tip?.x) || !Number.isFinite(tip.y)
        || tip.x < 0 || tip.x > 1 || tip.y < 0 || tip.y > 1) { this.reset(); return null; }
    if (this.last && timestamp <= this.last.timestamp) return null;
    if (this.last && timestamp - this.last.timestamp > HAND_FUSION.maxGapMs && !allowGap) this.reset();
    const model = this.pose = shape(hand, frame), previous = this.last;
    let sample = observe(tip, frame, hand, model);
    if (previous && !sample.reason && !consistentMetricScale(sample,model,this.reference)) {
      sample = { reason: '当前深度与手形尺度不一致' };
    }
    const measured = !sample.reason;
    if (!measured) {
      const ageMs = previous ? timestamp - previous.measuredAt : Infinity;
      if (previous && model && this.reference && ageMs <= HAND_FUSION.predictionMs) {
        // Closed-form one-parameter kinematic fit: metric palm bones divided
        // by current unit-depth bones estimate root depth. No new neural model.
        const roots = model.bones.flatMap((length, i) => length > .015 && this.reference.lengths[i] > .015
          ? [this.reference.lengths[i] / length] : []);
        const available = model.bones.filter(length => length > .015).length;
        const required = available >= 5 ? 5 : 3;
        const root = roots.length >= required ? median(roots) : NaN;
        const agreeing = roots.filter(value => Math.abs(value / root - 1) <= .15).length;
        const z = root * model.points[8].z;
        const dt = (timestamp - previous.timestamp) / 1000;
        if (agreeing >= required && Math.abs(root / this.reference.root - 1) <= HAND_FUSION.maxScaleChange
            && z >= .2 && z <= 4 && Math.abs(z - previous.z) <= .03 + HAND_FUSION.maxSpeedMps * dt) {
          sample = { u: tip.x * frame.width, v: tip.y * frame.height, z, source: 'kinematic-predicted',
            ageMs, confidence: .65 * (1 - ageMs / (HAND_FUSION.predictionMs + 1)), bones: agreeing };
        }
      }
      if (sample.reason && previous) {
        sample = { u: tip.x * frame.width, v: tip.y * frame.height, z: previous.z,
          source: 'depth-plane', ageMs, confidence: .2 };
      }
      if (sample.reason) {
        this.sample = sample; this.last = this.reference = null; return null;
      }
    }
    const point = cameraPoint(sample, frame);
    if (!point) { this.reset(); return null; }
    // Confidence affects the continuous estimator downstream. Bad depth falls
    // back to the prior plane; it must not veto valid RGB XY or end a stroke.
    if (measured) {
      if (model) {
        const root = sample.z / model.points[8].z;
        const lengths = model.bones.map(length => length * root);
        const old = this.reference?.lengths;
        this.reference = { root, lengths: lengths.map((length, i) => {
          if (length <= .015) return old?.[i] ?? 0;
          return old?.[i] > 0 ? old[i] * .95 + length * .05 : length;
        }) };
      } else this.reference = null;
      sample = { ...sample, ageMs: 0, confidence: sample.source === 'tip-measured' ? 1 : .8 };
    }
    this.sample = sample;
    this.last = { z: sample.z, timestamp, measuredAt: measured ? timestamp : previous.measuredAt };
    return point;
  }
}
