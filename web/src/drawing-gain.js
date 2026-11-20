import { cameraPoint, DEPTH_SCENE } from './depth-sampling.js';
import { unitHandShape } from './hand-shape.js';
import { ContinuousPosition } from './continuous-position.js';
import { STROKE_CONTINUITY } from './stroke-continuity.js';
import { CursorFilter } from './cursor-filter.js';

// Interaction coordinates, not metric XY reconstruction. One nominal palm is
// always the same drawing distance. NEVER calibrate this scale from sensor Z,
// the initial position, or beginStroke; sensor depth only controls scene Z.
export const DRAWING_GAIN = Object.freeze({ multiplier: 2.0, nominalPalmMeters: .09 });
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const visible = p => p && Number.isFinite(p.x) && Number.isFinite(p.y)
  && p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1;

export class DrawingGain {
  constructor() { this.reset(); }
  reset() { this.boneLengths=null; this.lastRoot=null; this.mode='waiting'; }

  project(tip,frame,hand,pose=unitHandShape(hand,frame)) {
    if(!visible(tip))return null;
    let root=null;
    // Bone 1 is wrist -> middle MCP. It supplies a fixed nominal scale; the
    // other palm spans allow the same scale to survive a partially clipped hand.
    if(pose?.bones[1]>.015) {
      root=DRAWING_GAIN.nominalPalmMeters/pose.bones[1];
      const lengths=pose.bones.map(length=>length*root);
      this.boneLengths=lengths.map((length,i)=>length>.001
        ? (this.boneLengths?.[i] ? .95*this.boneLengths[i]+.05*length : length)
        : this.boneLengths?.[i]??0);
      this.mode='palm-normalized';
    } else if(pose&&this.boneLengths) {
      const candidates=pose.bones.flatMap((length,i)=>length>.015&&this.boneLengths[i]>.001
        ? [this.boneLengths[i]/length]:[]);
      const middle=candidates.length?median(candidates):NaN;
      const consistent=candidates.filter(value=>Math.abs(value/middle-1)<=.2);
      if(consistent.length>=2) {root=median(consistent);this.mode='visible-bones';}
    }
    if(root===null&&visible(hand?.[0])&&visible(hand?.[9])) {
      const [fx,fy]=frame.intrinsics;
      const span=Math.hypot((hand[0].x-hand[9].x)*frame.width/fx,(hand[0].y-hand[9].y)*frame.height/fy);
      if(span>1e-6) {root=DRAWING_GAIN.nominalPalmMeters/span;this.mode='palm-2d';}
    }
    if(root!==null&&Number.isFinite(root)&&root>.02&&root<8)this.lastRoot=root;
    else {root=this.lastRoot??1;this.mode=this.lastRoot===null?'image-fallback':'held-visual-scale';}
    const relativeZ=pose?.points[8]?.z??1;
    const point=cameraPoint({u:tip.x*frame.width,v:tip.y*frame.height,z:root*relativeZ},frame);
    if(!point)return null;
    return {x:point.x*DRAWING_GAIN.multiplier,y:point.y*DRAWING_GAIN.multiplier,z:0};
  }
}

// Shared planar estimator for both webcam and Astra. Its confidence and speed
// limits are independent of depth noise, so Z changes cannot slow X/Y down.
export class DrawingPlane {
  constructor() {
    this.gain=new DrawingGain();
    this.filter=new ContinuousPosition({largeInnovationMeters:DRAWING_GAIN.nominalPalmMeters*DRAWING_GAIN.multiplier*1.25});
    this.cursorFilter=new CursorFilter();
    this.reset();
  }
  reset() {this.gain.reset();this.filter.reset();this.cursorFilter.reset();this.cursorPoint=null;this.rawPoint=null;this.lastTimestamp=null;this.suspendedAt=null;}
  suspend(timestamp) {
    this.suspendedAt??=this.lastTimestamp??timestamp;
    this.filter.suspend();
    this.cursorFilter.suspend();
    if(timestamp-this.suspendedAt>STROKE_CONTINUITY.pauseMs) {
      this.gain.reset();this.filter.reset();this.cursorFilter.reset();this.cursorPoint=null;
    }
  }
  project(tip,frame,hand,timestamp,pose) {
    this.suspendedAt=null;
    const input=this.gain.project(tip,frame,hand,pose);
    const palm=DRAWING_GAIN.nominalPalmMeters*DRAWING_GAIN.multiplier;
    const cursor=this.cursorFilter.update(input ? {x:input.x/palm,y:input.y/palm,z:0} : null,timestamp);
    this.rawPoint=input ? {...input} : null;
    this.cursorPoint=cursor ? {x:-cursor.x*palm*DEPTH_SCENE.unitsPerMeter,y:-cursor.y*palm*DEPTH_SCENE.unitsPerMeter,z:0} : null;
    const point=this.filter.update(input,timestamp,1);
    if(!point)return null;
    this.lastTimestamp=timestamp;
    const scale=DEPTH_SCENE.unitsPerMeter;
    return {x:-point.x*scale,y:-point.y*scale,z:0};
  }
}

// Webcam XY uses a normalized image coordinate system, not invented camera
// calibration. The palm ratio cancels the common scale; no metric Z is inferred.
export function imageDrawingFrame(width,height) {
  return {width,height,intrinsics:[width,width,width/2,height/2],distortion:[0,0,0,0,0]};
}
