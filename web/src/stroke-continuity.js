export const STROKE_CONTINUITY=Object.freeze({ pauseMs:800,missingMs:350,processingGapMs:550,maxBridgeDistance:1.5,
  interpolationStep:.04,maxInterpolationPoints:32 });
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);

// A pen session is distinct from a per-frame observation. Brief missing points
// pause geometry; they do not end the user's still-pinched stroke.
export class StrokeContinuity {
  constructor(){this.reset();}
  reset(){this.last=this.previous=null;this.paused=false;this.bridges=0;}
  end(){this.last=this.previous=null;this.paused=false;}
  pause(timestamp){
    if(!this.last||!Number.isFinite(timestamp)||timestamp-this.last.timestamp>STROKE_CONTINUITY.pauseMs)return false;
    this.paused=true;return true;
  }
  append(engine,point,timestamp){
    if(this.paused&&this.last) {
      if(!Number.isFinite(timestamp)||timestamp-this.last.timestamp>STROKE_CONTINUITY.pauseMs
          ||distance(point,this.last.point)>STROKE_CONTINUITY.maxBridgeDistance)return false;
      const start=this.last.point,chord=distance(start,point),gap=timestamp-this.last.timestamp;
      const tangent={x:0,y:0,z:0};
      if(this.previous) {
        const elapsed=Math.max(1,this.last.timestamp-this.previous.timestamp);
        for(const axis of ['x','y','z'])tangent[axis]=(start[axis]-this.previous.point[axis])*gap/elapsed;
        const size=Math.hypot(tangent.x,tangent.y,tangent.z),limit=chord*.75;
        if(size>limit)for(const axis of ['x','y','z'])tangent[axis]*=limit/size;
      }
      const count=Math.min(STROKE_CONTINUITY.maxInterpolationPoints,Math.max(2,Math.ceil(chord/STROKE_CONTINUITY.interpolationStep)));
      for(let i=1;i<=count;i++) {
        const t=i/count,t2=t*t,t3=t2*t,p={};
        for(const axis of ['x','y','z'])p[axis]=(2*t3-3*t2+1)*start[axis]
          +(t3-2*t2+t)*tangent[axis]+(-2*t3+3*t2)*point[axis]+(t3-t2)*(point[axis]-start[axis]);
        engine.appendPoint(p);
      }
      this.bridges++;
    } else engine.appendPoint(point);
    this.previous=this.last;this.last={point:{...point},timestamp};this.paused=false;return true;
  }
  begin(point,timestamp){this.previous=null;this.last={point:{...point},timestamp};this.paused=false;}
}
