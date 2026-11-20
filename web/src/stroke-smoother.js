const mix = (a,b,t) => ({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);

// Online quadratic corner rounding. Only the most recent, uncommitted part of
// an edge is needed; never fit across separate strokes or search spatially
// (two passes through the centre of a figure eight are unrelated).
export class StrokeSmoother {
  constructor(emit,getStrength=()=>.5) { this.emit=emit; this.getStrength=getStrength; }
  begin(point) { this.tip=this.committed=point; this.first=true; }
  appendPoint(point) {
    const b=this.tip, a=this.committed, len=distance(b,point);
    if(len<1e-6)return;
    // Give immediate feedback on first contact, including very short strokes.
    if(this.first){this.first=false;this.emit(point);this.tip=this.committed=point;return;}
    const strength=this.getStrength();
    if(strength===0){
      if(distance(a,b)>1e-6)this.emit(b);
      this.emit(point);this.tip=this.committed=point;return;
    }
    const trim=Math.min(.5,strength,.20*strength/len);
    const c=mix(b,point,trim);
    // Above the original midpoint setting, also round short edges more
    // strongly; increasing the radius alone only affects long camera steps.
    const control=strength<=.5?b:mix(b,mix(a,c,.5),strength-.5);
    // Sample curves more densely only when the midpoint deviates from its chord.
    const bend=a===b ? 0 : distance(b,mix(a,c,.5));
    const count=Math.min(8,Math.max(1,Math.ceil(Math.sqrt(bend/.008))));
    for(let i=1;i<=count;i++){
      const t=i/count;
      this.emit(mix(mix(a,control,t),mix(control,c,t),t));
    }
    // Uncommitted distance is capped by the chosen radius.
    this.committed=trim===.5?c:mix(point,b,trim);
    if(trim<.5)this.emit(this.committed);
    this.tip=point;
  }
  finish() {
    if(this.tip && distance(this.committed,this.tip)>1e-6)this.emit(this.tip);
    this.tip=this.committed=null;
  }
}
