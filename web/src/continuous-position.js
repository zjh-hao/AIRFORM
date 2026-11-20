// Constant-velocity Kalman blocks [position, velocity], one per metric axis.
// Robust measurement weighting/correction limits are engineering additions.
// No image processing, future frames, learned weights, or growing history.
export const CONTINUOUS_POSITION = Object.freeze({ accelerationVariance: 16,
  maxSpeedMps: 2.5, maxCorrectionMps: 2, largeInnovationMeters: .18,
  predictionMs: 120, resumeDistanceMeters: .35 });
const axes=['x','y','z'];
const norm=p=>Math.hypot(p.x,p.y,p.z);
const delta=(a,b)=>Object.fromEntries(axes.map(axis=>[axis,a[axis]-b[axis]]));

export class ContinuousPosition {
  constructor(options = {}) {
    this.options = Object.freeze({ ...CONTINUOUS_POSITION, ...options });
    this.reset();
  }
  reset() { this.blocks=null; this.timestamp=null; this.measuredAt=null; this.candidate=null; this.paused=false; this.status=null; }
  suspend() { this.paused=true; }
  update(point,timestamp,confidence=1) {
    if(!Number.isFinite(timestamp)||(this.timestamp!==null&&timestamp<=this.timestamp))return null;
    const valid=point&&axes.every(axis=>Number.isFinite(point[axis]));
    if(!this.blocks) {
      if(!valid)return null;
      this.blocks=axes.map(axis=>({p:point[axis],v:0,p00:.0001,p01:0,p11:.1}));
      this.timestamp=this.measuredAt=timestamp;this.paused=false;this.status={mode:'measured',relocated:false};
      return {...point};
    }
    const dt=Math.min(.12,(timestamp-this.timestamp)/1000);
    const before=Object.fromEntries(axes.map((axis,i)=>[axis,this.blocks[i].p]));
    if(this.paused) {
      this.blocks.forEach(b=>{b.v=0;});this.paused=false;
      if(valid&&norm(delta(point,before))>this.options.resumeDistanceMeters) {
        this.reset();const output=this.update(point,timestamp,confidence);
        this.status={mode:'relocated',relocated:true};return output;
      }
    }
    this.timestamp=timestamp;
    for(const b of this.blocks) {
      const q=this.options.accelerationVariance;
      b.p+=b.v*dt;
      b.p00+=2*dt*b.p01+dt*dt*b.p11+q*dt**4/4;
      b.p01+=dt*b.p11+q*dt**3/2;b.p11+=q*dt*dt;
    }
    const predicted=Object.fromEntries(axes.map((axis,i)=>[axis,this.blocks[i].p]));
    if(!valid&&timestamp-this.measuredAt>this.options.predictionMs) {
      this.blocks.forEach(b=>{b.v=0;});this.status={mode:'waiting',relocated:false};return null;
    }
    let correct=!!valid,coherent=false,innovation=0;
    if(valid) {
      innovation=norm(delta(point,predicted));
      if(innovation>this.options.largeInnovationMeters) {
        const c=this.candidate;
        coherent=!!c&&timestamp-c.timestamp<=250
          &&norm(delta(point,c.point))<=.03+this.options.maxSpeedMps*dt;
        this.candidate={point:{...point},timestamp};correct=coherent;
      } else this.candidate=null;
    }
    if(correct) {
      const std=.006/Math.sqrt(Math.max(.1,confidence));
      for(let i=0;i<3;i++) {
        const b=this.blocks[i],e=point[axes[i]]-b.p;
        const base=std*std*(i===2?2:1);
        const robust=coherent?1:Math.max(1,Math.abs(e)/(3*Math.sqrt(b.p00+base)));
        const r=base*robust*robust,k0=b.p00/(b.p00+r),k1=b.p01/(b.p00+r);
        const p00=b.p00,p01=b.p01;
        const correction=Math.max(-this.options.maxCorrectionMps*dt,
          Math.min(this.options.maxCorrectionMps*dt,k0*e));
        const scale=Math.abs(k0*e)>1e-12?correction/(k0*e):1, kp=k0*scale,kv=k1*scale;
        b.p+=correction;
        b.v=Math.max(-this.options.maxSpeedMps,Math.min(this.options.maxSpeedMps,b.v+kv*e));
        // Joseph covariance update also remains valid when correction is clipped.
        b.p00=Math.max(1e-10,(1-kp)**2*p00+kp*kp*r);
        b.p01=(1-kp)*(p01-kv*p00)+kp*kv*r;
        b.p11=Math.max(1e-10,b.p11-2*kv*p01+kv*kv*(p00+r));
      }
      this.measuredAt=timestamp;
    } else this.blocks.forEach(b=>{b.v*=.8;});
    const speed=Math.hypot(...this.blocks.map(b=>b.v));
    if(speed>this.options.maxSpeedMps)this.blocks.forEach(b=>{b.v*=this.options.maxSpeedMps/speed;});
    const output=Object.fromEntries(axes.map((axis,i)=>[axis,this.blocks[i].p]));
    const move=delta(output,before),length=norm(move),limit=.003+this.options.maxSpeedMps*dt;
    if(length>limit)for(let i=0;i<3;i++)this.blocks[i].p=output[axes[i]]=before[axes[i]]+move[axes[i]]*limit/length;
    this.status={mode:correct?(coherent?'correcting':'filtered'):'predicting',relocated:false,innovationMeters:innovation};
    return output;
  }
}
