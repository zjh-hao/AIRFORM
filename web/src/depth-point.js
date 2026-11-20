import { DEPTH_SCENE } from './depth-sampling.js';
import { HandPoseFusion } from './hand-pose-fusion.js';
import { ContinuousPosition } from './continuous-position.js';
import { DrawingPlane } from './drawing-gain.js';
import { STROKE_CONTINUITY } from './stroke-continuity.js';
import { CursorFilter } from './cursor-filter.js';
export { DEPTH_SCENE, DEPTH_SAMPLE, validateDepthFrame, sampleTipDepth,
  measuredPoint, mapDepthPoint } from './depth-sampling.js';
export { sampleHandDepth } from './hand-pose-fusion.js';

// Sensor confidence and pen-session lifetime are separate. No coordinate gate
// may turn a single unreliable observation into an endStroke command.
export class DepthProjector {
  constructor() {
    this.fusion = new HandPoseFusion(); this.plane = new DrawingPlane();
    this.depthFilter = new ContinuousPosition(); this.cursorDepth = new CursorFilter(); this.reset();
  }
  get filter() { return this.plane.filter; }
  get last() { return this.fusion.last; }
  get sample() { return this.fusion.sample; }
  reset() {
    this.fusion.reset(); this.plane.reset(); this.depthFilter.reset();
    this.cursorDepth.reset(); this.cursorPoint = null;
    this.lastOutput = null; this.suspendedAt = null;
  }
  suspend(timestamp) {
    this.suspendedAt ??= this.last?.timestamp ?? timestamp;
    this.plane.suspend(timestamp); this.depthFilter.suspend();
    this.cursorDepth.suspend();
    if (timestamp-this.suspendedAt > STROKE_CONTINUITY.pauseMs) {
      this.fusion.reset(); this.plane.reset(); this.depthFilter.reset(); this.cursorDepth.reset(); this.cursorPoint = null; this.lastOutput = null;
    }
  }
  project(tip, frame, hand, timestamp) {
    if(!frame) {this.reset();return null;}
    const allowGap = this.suspendedAt !== null && timestamp-this.suspendedAt <= STROKE_CONTINUITY.pauseMs;
    this.suspendedAt = null;
    const point = this.fusion.update(tip, frame, hand, timestamp, { allowGap });
    const xy = this.plane.project(tip, frame, hand, timestamp, this.fusion.pose);
    // Independent display depth branch, before the ink Kalman. One nominal
    // 9 cm palm sets its filter units, not a measured palm or a depth scale.
    const cursorZ = this.cursorDepth.update(point ? {x:0,y:0,z:point.z/.09} : null,timestamp);
    this.cursorPoint = this.plane.cursorPoint && cursorZ ? { ...this.plane.cursorPoint,
      z:(DEPTH_SCENE.originDepthMeters-cursorZ.z*.09)*DEPTH_SCENE.unitsPerMeter } : null;
    const depth = this.depthFilter.update(point ? {x:0,y:0,z:point.z} : null,timestamp,this.sample.confidence??1);
    this.sample.motion = { ...this.filter.status,
      relocated: !!(this.filter.status?.relocated || this.depthFilter.status?.relocated) };
    if (!xy || !depth) return null;
    const scale = DEPTH_SCENE.unitsPerMeter;
    this.lastOutput = { x: xy.x, y: xy.y,
      z: (DEPTH_SCENE.originDepthMeters-depth.z)*scale };
    return { ...this.lastOutput };
  }
}
