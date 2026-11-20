import { StrokeEngine } from './stroke-engine.js';
import { StrokeContinuity, STROKE_CONTINUITY } from './stroke-continuity.js';
import { StrokeSmoother } from './stroke-smoother.js';
import { BrushWidth } from './mineral-brush.js';

export function connectLiveDrawing(target, scene, onStats = null, getStrength, getBrush, engine=new StrokeEngine()) {
  const continuity = new StrokeContinuity();
  const width=new BrushWidth();width.reset();
  const ink = new StrokeSmoother(point=>engine.appendPoint(point,getBrush?width.scale:1),getStrength);
  const ends = { depth: 0, tracking: 0, release: 0, stopped: 0, jump: 0 };
  let pendingPath=[];
  let enabled=true;
  let lastPacket=null,missingSince=null,watchdog=null;
  scene.add(engine.group);
  const report = () => onStats?.({ ...engine.stats, ends: { ...ends },
    paused: continuity.paused, bridges: continuity.bridges });
  const end = reason => {
    clearTimeout(watchdog);lastPacket=null;missingSince=null;
    pendingPath=[];
    if(engine.active) { ink.finish(); engine.endStroke(); ends[reason]++; }
    continuity.end();
  };
  const begin = (point,timestamp,timed=true,silenceMs=STROKE_CONTINUITY.missingMs) => {
    width.reset();width.observe(point,timestamp,null);
    engine.beginStroke(point,getBrush?.()??{color:'#35bfff',size:3});ink.begin(point);continuity.begin(point,timestamp);
    if(timed && Number.isFinite(timestamp)) {
      lastPacket=timestamp;missingSince=null;clearTimeout(watchdog);
      watchdog=setTimeout(()=>{end('tracking');report();},silenceMs+1);
    }
  };
  const receive = ({detail:{source,state,point,ratio,tracking,breakStroke,timestamp,canResume,releasePending,retainPendingPath,requalifyingRight,enhanced,processingResume}}) => {
    if(!enabled)return;
    const manual=source==='手动';
    const valid=point&&['x','y','z'].every(axis=>Number.isFinite(point[axis])&&Math.abs(point[axis])<=10000);
    const silenceMs=enhanced && valid && !releasePending?STROKE_CONTINUITY.processingGapMs:STROKE_CONTINUITY.missingMs;
    if(!manual && engine.active && (lastPacket!==null && timestamp-lastPacket>(processingResume?silenceMs:STROKE_CONTINUITY.missingMs) ||
        missingSince!==null && timestamp-missingSince>STROKE_CONTINUITY.missingMs))end('tracking');
    if(processingResume && engine.active)continuity.pause(timestamp);
    if(source==='摄像头' && Number.isFinite(timestamp) && (state==='Pinching' || engine.active)) {
      lastPacket=timestamp;
      if(valid || requalifyingRight)missingSince=null;
      else missingSince??=timestamp;
      clearTimeout(watchdog);
      watchdog=setTimeout(()=>{if(engine.active){end('tracking');report();}},
        silenceMs+1-(missingSince===null?0:timestamp-missingSince));
    }
    const waiting = state==='Pinching'&&!valid || canResume&&['TrackingLost','Idle'].includes(state)
      || tracking==='boundary-paused';
    // Stop depositing ink on the first opening observation. Keep the session
    // so a false alarm can reconnect locally; never replay opening positions.
    if(source==='摄像头' && releasePending && state==='Pinching') {
      if(engine.active && !continuity.pause(timestamp))end('tracking');
      else if(engine.active && retainPendingPath && valid && !breakStroke && pendingPath.length<64)
        pendingPath.push({point:{...point},timestamp});
      else pendingPath=[];
      report();return;
    }
    if(source==='摄像头'&&engine.active&&waiting&&continuity.pause(timestamp)) { pendingPath=[];report();return; }
    if((!manual && source!=='摄像头')||state!=='Pinching'||!valid) {
      const reason=!manual && source!=='摄像头'?'stopped':state==='TrackingLost'||state==='Rearming'?'tracking'
        :state!=='Pinching'?'release':'depth';
      end(reason);
    } else {
      if(breakStroke)end('jump');
      if(engine.active) {
        if(getBrush)width.observe(point,timestamp,ratio);
        if(pendingPath.length && continuity.last) {
          let previous=continuity.last;
          const local=[...pendingPath,{point,timestamp}].every(sample=>{
            const delta=sample.timestamp-previous.timestamp;
            const step=Math.hypot(...['x','y','z'].map(axis=>sample.point[axis]-previous.point[axis]));
            previous=sample;
            return delta>0 && delta<=150 && step<=STROKE_CONTINUITY.maxBridgeDistance;
          });
          if(local && timestamp-continuity.last.timestamp<=STROKE_CONTINUITY.pauseMs)
            for(const sample of pendingPath)continuity.append(ink,sample.point,sample.timestamp);
        }
        pendingPath=[];
        if(!continuity.append(ink,point,timestamp)) {end('tracking');begin(point,timestamp,!manual,silenceMs);}
      } else begin(point,timestamp,!manual,silenceMs);
    }
    report();
  };
  const clear=()=>{clearTimeout(watchdog);lastPacket=null;missingSince=null;pendingPath=[];engine.clear();continuity.reset();for(const reason of Object.keys(ends))ends[reason]=0;report();};
  target.addEventListener('kineglow:interaction',receive);
  const switchMode=({detail})=>{end('stopped');enabled=detail!=='solar';report();};
  target.addEventListener('kineglow:effect',switchMode);
  const pointer=({detail})=>receive({detail:{...detail,source:'手动'}});
  target.addEventListener('kineglow:pointer-ink',pointer);
  target.addEventListener('kineglow:clear',clear);
  let disposed=false;
  return()=>{
    if(disposed)return;disposed=true;
    clearTimeout(watchdog);
    target.removeEventListener('kineglow:pointer-ink',pointer);
    target.removeEventListener('kineglow:effect',switchMode);
    target.removeEventListener('kineglow:interaction',receive);target.removeEventListener('kineglow:clear',clear);
    engine.endStroke();engine.dispose();continuity.reset();
  };
}
