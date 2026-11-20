import { OneEuroFilter } from './one-euro-filter.js';

// Inputs are palm-normalized interaction units. Independent of the ink Kalman
// filter: no filtered ink coordinate or extrapolation is fed into this branch.
// Selected from the recorded synthetic sweep; human calibration is pending.
export const CURSOR_FILTER = Object.freeze({ minCutoff: .5, beta: 4, derivativeCutoff: 1,
  motionCutoff: 2.5, motionSamples: 6, motionCoherence: .9, motionSpeed: .05,
  resumeMs: 350, relocationDistance: 2, outlierDistance: 1 });
const axes = ['x', 'y', 'z'];
const valid = p => p && axes.every(k => Number.isFinite(p[k]));
const distance = (a, b) => Math.hypot(...axes.map(k => a[k]-b[k]));

export class CursorFilter {
  constructor(options = {}) {
    this.options = { ...CURSOR_FILTER, ...options };
    this.filters = axes.map(() => new OneEuroFilter(this.options));
    this.reset();
  }
  reset() {
    this.filters.forEach(f => f.reset());
    this.last = null; this.lastSeen = null; this.paused = false; this.candidate = null; this.history = []; this.status = 'waiting';
  }
  suspend() { this.paused = true; this.candidate = null; this.history = []; }
  resume(point, timestamp) { this.suspend(); return this.update(point, timestamp); }
  update(point, timestamp) {
    if (!Number.isFinite(timestamp) || (this.lastSeen !== null && timestamp <= this.lastSeen)) return null;
    this.lastSeen = timestamp;
    if (!valid(point)) { this.suspend(); this.status = 'missing'; return null; }
    if (this.last) {
      const elapsed = timestamp-this.last.timestamp, jump = distance(point, this.last.point);
      if (elapsed > this.options.resumeMs || (this.paused && jump > this.options.relocationDistance)) this.reset();
      else if (!this.paused && jump > this.options.outlierDistance) {
        const coherent = this.candidate && timestamp-this.candidate.timestamp <= 150
          && distance(point, this.candidate.point) < this.options.outlierDistance / 2;
        this.candidate = { point: { ...point }, timestamp };
        if (!coherent) { this.status = 'outlier-held'; return { ...this.last.output }; }
      } else this.candidate = null;
    }
    // Resume from the new observation, with no stale velocity/derivative. The
    // pen session independently decides whether its geometry may reconnect.
    if (this.paused) this.filters.forEach(f => f.reset());
    // A coherent slow movement otherwise remains behind the hand despite the
    // low stationary cutoff. Raise the SAME filter's cutoff when recent travel
    // is directional; this window never averages positions or predicts points.
    this.history.push({point:{...point},timestamp});
    this.history=this.history.slice(-this.options.motionSamples);
    const first=this.history[0],net=distance(point,first.point),seconds=(timestamp-first.timestamp)/1000;
    const travel=this.history.slice(1).reduce((sum,s,i)=>sum+distance(s.point,this.history[i].point),0);
    const moving=this.history.length===this.options.motionSamples&&travel>0&&seconds>0
      &&net/travel>=this.options.motionCoherence&&net/seconds>=this.options.motionSpeed;
    this.filters.forEach(f=>{f.minCutoff=moving?Math.max(this.options.minCutoff,this.options.motionCutoff):this.options.minCutoff;});
    const output = Object.fromEntries(axes.map((k, i) => [k, this.filters[i].filter(point[k], timestamp)]));
    this.last = { timestamp, point: { ...point }, output };
    this.lastSeen = timestamp;
    this.paused = false; this.status = 'filtered';
    return { ...output };
  }
}
