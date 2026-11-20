export class CursorPlayback {
  reset(){this.previous=this.current=null;}
  push(point,time,continuous){
    this.previous=continuous && this.current && time>this.current.time
      && time-this.current.time<=150 ? this.current : null;
    this.current={...point,time};
  }
  sample(time){
    if(!this.previous || !this.current)return null;
    const interval=this.current.time-this.previous.time;
    const duration=Math.min(33,interval);
    const elapsed=Math.max(0,time-this.current.time);
    const delta=['x','y','z'].map(axis=>this.current[axis]-this.previous[axis]);
    const length=Math.hypot(...delta);
    const factor=Math.min(1,elapsed/duration)*Math.min(duration/interval,.08/(length||1));
    return {x:this.current.x+delta[0]*factor,y:this.current.y+delta[1]*factor,
      z:this.current.z+delta[2]*factor};
  }
}
