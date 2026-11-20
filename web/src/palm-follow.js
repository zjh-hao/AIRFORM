const hover=.79, holdMs=160, coastMs=500, trendMs=150, fadeMs=200, forgetMs=1100;
const middle=(samples,key)=>samples.map(pose=>pose[key]).sort((first,second)=>first-second)[1];

export class PalmFollow {
  reset(){this.pose=null;this.anchor=null;this.history=[];this.trend=[];this.coast=null;this.loss=null;this.closed=false;}
  beginLoss(now){
    this.loss??={start:now,alpha:this.pose.alpha};
  }
  beginCoast(now){
    if(this.coast || this.closed || !this.pose)return;
    const first=this.trend[0],last=this.trend.at(-1);
    const span=last.time-first.time,dx=last.x-first.x,dy=last.y-first.y;
    const speed=Math.hypot(dx,dy);
    const scale=span>=35 && speed>0?Math.min(.5/(span/1000),this.unit*.20/speed):0;
    this.coast={start:now,x:this.pose.x,y:this.pose.y,vx:dx*scale,vy:dy*scale};
  }
  observe(candidates,now,shortSide,skeletonMissing=true){
    if(!candidates.length){
      if(!this.pose)return null;
      this.beginLoss(now);
      if(this.pose && !skeletonMissing){this.coast=null;this.closed=true;}
      else this.beginCoast(this.loss.start);
      return null;
    }
    if(this.pose && now-(this.loss?.start??this.seen)>forgetMs)this.reset();
    const rank=sample=>this.anchor?Math.hypot(sample.x-this.anchor.x,sample.y-this.anchor.y)+(sample.label!==this.label?shortSide*.1:0):-sample.radius;
    const sample=candidates.reduce((best,next)=>rank(next)<rank(best)?next:best);
    this.unit=shortSide;
    if(!this.pose){
      this.anchor={x:sample.x,y:sample.y};this.target={x:sample.x,y:sample.y-hover*sample.radius,radius:sample.radius};
      this.pose={...this.target,alpha:0};this.history=[sample,sample,sample];this.clock=now;this.trend=[];
    }else{
      if(this.coast || this.closed || now-this.seen>holdMs){
        this.history=[sample,sample,sample];this.trend=[];
        this.anchor={x:sample.x,y:sample.y};this.target.x=sample.x;this.target.y=sample.y-hover*this.pose.radius;
      }
      this.history.shift();this.history.push(sample);
      const radius=middle(this.history,'radius'),x=middle(this.history,'x'),y=middle(this.history,'y');
      if(Math.abs(radius-this.target.radius)>Math.max(shortSide*.003,this.pose.radius*.035))this.target.radius=radius;
      if(Math.hypot(x-this.anchor.x,y-this.anchor.y)>Math.max(shortSide*.018,this.pose.radius*.10)){
        this.anchor={x,y};this.target.x=x;this.target.y=y-hover*this.pose.radius;
      }
    }
    if(this.label!==sample.label)this.trend=[];
    this.trend=this.trend.filter(point=>now-point.time<=trendMs);
    this.trend.push({...this.anchor,time:now});
    this.coast=null;this.loss=null;this.closed=false;this.seen=now;this.label=sample.label;return sample;
  }
  frame(now){
    if(!this.pose)return null;
    const age=now-this.seen,seconds=Math.max(0,Math.min(40,now-this.clock))/1000;
    this.clock=Math.max(this.clock,now);
    if(now-(this.loss?.start??this.seen)>forgetMs){this.reset();return null;}
    const pose=this.pose;
    if(age>holdMs && !this.loss){
      this.beginLoss(this.seen+holdMs);this.beginCoast(this.loss.start);
    }
    if(this.coast){
      const drift=this.coast,elapsed=Math.max(0,now-drift.start),phase=Math.min(1,elapsed/coastMs);
      const travel=(coastMs/1000)*phase*(1-phase/2);
      pose.x=drift.x+drift.vx*travel;pose.y=drift.y+drift.vy*travel;
    }else if(!this.loss){
      const delta=this.target.radius-pose.radius;
      pose.radius+=Math.sign(delta)*Math.min(Math.abs(delta),this.unit*.07*seconds);
      const dx=this.target.x-pose.x,dy=this.target.y-pose.y,distance=Math.hypot(dx,dy);
      if(distance){const share=Math.min(this.unit*.4*seconds/distance,distance<.05?1:-Math.expm1(-seconds/.14));pose.x+=dx*share;pose.y+=dy*share;}
      pose.alpha=Math.min(1,pose.alpha+seconds*8);
    }
    if(this.loss){
      const fade=Math.max(0,now-this.loss.start-coastMs)/fadeMs;
      pose.alpha=this.loss.alpha*Math.max(0,1-fade);
    }
    return pose;
  }
}
