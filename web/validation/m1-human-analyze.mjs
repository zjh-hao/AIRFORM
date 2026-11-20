import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {HandInteraction,PINCH} from '../src/interaction.js';
if(!process.argv[2])throw Error('Pass a local recording folder with session-manifest.json');
const folder=pathToFileURL(resolve(process.argv[2])+sep);
const manifest=JSON.parse(await readFile(new URL('session-manifest.json',folder),'utf8'));
for(const name of ['supplement-manifest.json','static-retry-manifest.json']) {
  try {const extra=JSON.parse(await readFile(new URL(name,folder),'utf8'));manifest.records.push(...extra.records);} catch(error) {if(error.code!=='ENOENT')throw error;}
}
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const percentile=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.ceil(a.length*p)-1)]:null;
const fraction=(n,total)=>total?n/total:null;
const isPoint=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]));
function jitter(frames,key,pixelsPerUnit) {
  const points=frames.map(f=>f.interaction?.[key]).filter(isPoint);
  if(!points.length)return null;
  const x=points.map(p=>p.x*pixelsPerUnit),y=points.map(p=>p.y*pixelsPerUnit),mx=mean(x),my=mean(y);
  const stdX=Math.sqrt(mean(x.map(v=>(v-mx)**2))),stdY=Math.sqrt(mean(y.map(v=>(v-my)**2)));
  return {frames:points.length,totalFrames:frames.length,stdXPx:stdX,stdYPx:stdY,
    radialRmsPx:Math.hypot(stdX,stdY),radialP95Px:percentile(x.map((v,i)=>Math.hypot(v-mx,y[i]-my)),.95)};
}
function availability(frames) {
  return {frames:frames.length,anyHand:fraction(frames.filter(f=>f.landmarks.length).length,frames.length),
    rightLabel:fraction(frames.filter(f=>f.handedness?.some(h=>h?.[0]?.categoryName==='Right')).length,frames.length),
    qualifiedRight:fraction(frames.filter(f=>f.interaction?.observationValid).length,frames.length),
    inkPoint:fraction(frames.filter(f=>isPoint(f.interaction?.point)).length,frames.length),
    heldCursorFrames:frames.filter(f=>f.interaction?.cursorSource==='held').length};
}
function gestureReplay(frames,mode) {
  const machine=new HandInteraction(undefined,{gestureMode:mode});
  // Recordings start after the operator preparation, so seed both modes with
  // the same recorded initial session state. No pre-recording history exists.
  machine.state=frames[0].interaction?.state??'TrackingLost';
  machine.lastTimestamp=frames[0].timestamp-50;machine.rightSince=frames[0].timestamp-PINCH.handConfirmMs;
  machine.resumeAllowed=!!frames[0].interaction?.canResume;
  let previous=machine.state;const releases=[],states={},trace=[];
  for(const f of frames) {
    const result=machine.update({...f,source:'摄像头'},640,480);
    if(!result)continue;
    states[result.state]=(states[result.state]??0)+1;
    if(previous==='Pinching'&&result.state==='Idle')releases.push({timestamp:f.timestamp,ratio:result.ratio});
    trace.push({timestamp:f.timestamp,state:result.state,ratio:result.ratio,basis:result.gestureBasis??'legacy'});
    previous=result.state;
  }
  return {mode,states,releaseTransitions:releases.length,releases,trace};
}
const files=(await readdir(folder)).filter(n=>/^(?:kineglow|AIRFORM)-.*\.json$/.test(n)&&!n.endsWith('-gesture-trace.json')).sort();
const reports=[];
for(const file of files) {
  const data=JSON.parse(await readFile(new URL(file,folder),'utf8')),frames=data.frames;
  const record=manifest.records.find(r=>r.files.includes(file)&&!r.aborted);
  const rect=record?.sceneRect??{width:562.5,height:480};
  const pixelsPerUnit=Math.min(rect.width/(6*1.1),rect.height/(4.5*1.1));
  const gaps=frames.slice(1).map((f,i)=>f.timestamp-frames[i].timestamp);
  const recordedStates={},bases={};
  for(const f of frames) {
    const s=f.interaction?.state??'unknown',b=f.interaction?.gestureBasis??'missing';
    recordedStates[s]=(recordedStates[s]??0)+1;bases[b]=(bases[b]??0)+1;
  }
  const legacy=gestureReplay(frames,'legacy'),world=gestureReplay(frames,'world');
  const staticFrames=frames.filter(f=>f.timestamp<10000);
  const pairedStatic=staticFrames.filter(f=>isPoint(f.interaction?.point)&&isPoint(f.interaction?.cursorPoint)
    &&f.interaction.cursorSource==='filtered');
  const oldJitter=jitter(pairedStatic,'point',pixelsPerUnit),newJitter=jitter(pairedStatic,'cursorPoint',pixelsPerUnit);
  const stages=data.metadata.testCase==='rotation'?(record?.segment==='forward-recovery'?
    [[0,30000,'toward-camera'],[30000,40000,'flip'],[40000,50000,'brief-exit']]:
    [[0,20000,'left-turn'],[20000,40000,'right-turn'],[40000,70000,'toward-camera'],[70000,80000,'flip'],[80000,90000,'brief-exit']]):[];
  const report={file,testCase:data.metadata.testCase,frames:frames.length,
    durationMs:frames.at(-1).timestamp-frames[0].timestamp,stopReason:data.stopReason,
    protocol:record??null,metrics:data.metrics,availability:availability(frames),recordedStates,bases,
    intervals:{medianMs:percentile(gaps,.5),p95Ms:percentile(gaps,.95),maxMs:Math.max(...gaps),over100ms:gaps.filter(t=>t>100).length},
    gestureComparison:{initialization:'same recorded first state; no pre-roll history',
      legacy:{...legacy,trace:undefined},world:{...world,trace:undefined},
      interpretation:'Release transitions are not automatically false releases; video/intent annotation is required.'},
    staticFirst10s:data.metadata.testCase==='static'?{
      protocolValid:null, videoReview:'Pending review of this input',
      pixelsPerUnit,pairedFrames:pairedStatic.length,totalFrames:staticFrames.length,
      legacyPositionBranch:oldJitter,cursorBranch:newJitter,
      radialStdReduction:oldJitter?.radialRmsPx?1-newJitter.radialRmsPx/oldJitter.radialRmsPx:null}:null,
    stages:stages.map(([from,to,name])=>({name,from,to,actualEndMs:Math.min(to,frames.at(-1).timestamp),
      ...availability(frames.filter(f=>f.timestamp>=from&&f.timestamp<to))}))};
  await writeFile(new URL(file.replace('.json','-gesture-trace.json'),folder),JSON.stringify({legacy:legacy.trace,world:world.trace}));
  reports.push(report);
  console.log(JSON.stringify({file,frames:report.frames,seconds:report.durationMs/1000,availability:report.availability,
    replayReleases:{legacy:legacy.releaseTransitions,world:world.releaseTransitions},jitter:report.staticFirst10s}));
}
const report={evidence:'physical-astra-recordings',createdAt:new Date().toISOString(),reports,
  limitations:['No per-frame human correctness labels yet','View is 562.5 × 480 CSS px, not a 1080p canvas performance test',
    'Recording compresses full aligned depth and affects sampling rate','Two rotation clips ended at byte limit; flip/brief-exit protocol not covered',
    'Jitter compares old ink-position and new cursor branches on identical valid recorded frames; it is not a complete legacy end-to-end run']};
await writeFile(new URL('../human-analysis.json',folder),JSON.stringify(report,null,2)+'\n');
