export const BRUSH_COLORS = Object.freeze([
  ['冰川蓝','#38bbff'],['碧玺绿','#20e8ae'],['紫水晶','#ad7cff'],
  ['蔷薇石','#ff629a'],['日光石','#ff9852'],['月长石','#ffdd99']
]);

export class BrushWidth {
  reset(){this.scale=1;this.last=null;}
  observe(point,timestamp,ratio){
    const elapsed=timestamp-this.last?.timestamp;
    if(this.last && elapsed>0 && elapsed<=150){
      const speed=Math.hypot(point.x-this.last.x,point.y-this.last.y,point.z-this.last.z)*1000/elapsed;
      const pressure=Number.isFinite(ratio)?1-Math.min(1,Math.max(0,ratio/.45)):.5;
      const target=.54+.69/(1+speed/2)+.22*pressure;
      this.scale+=(target-this.scale)*(1-Math.exp(-elapsed/85));
    }
    this.last={...point,timestamp};
    return this.scale;
  }
}
