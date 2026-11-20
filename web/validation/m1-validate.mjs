import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HandInteraction } from '../src/interaction.js';
import { ContinuousPosition } from '../src/continuous-position.js';
import { CursorFilter, CURSOR_FILTER } from '../src/cursor-filter.js';
import { HAND_GEOMETRY } from '../src/hand-geometry.js';
import { worldHand } from '../test-support/world-hand.js';

const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
const std=a=>Math.sqrt(mean(a.map(v=>(v-mean(a))**2)));
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
function noise(seed) {
  let value=seed>>>0;
  return ()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/2**32-.5;};
}

export function filterExperiment(options={},seed=20261118) {
  const random=noise(seed),legacy=new ContinuousPosition(),cursor=new CursorFilter(options);
  const raw=[],before=[],after=[],samples=[];
  // 10 s, 30 Hz, deterministic broadband + alternating noise, same inputs.
  for(let i=0;i<300;i++) {
    const x=.04*random()+.005*(i%2?1:-1),timestamp=i*1000/30;
    const old=legacy.update({x:x*.18,y:0,z:0},timestamp).x/.18;
    const next=cursor.update({x,y:0,z:0},timestamp).x;
    samples.push({timestamp,raw:x,legacy:old,cursor:next});
    if(i>=30){raw.push(x);before.push(old);after.push(next);}
  }
  const motion=[];
  for(const speed of [.1,.5,1,2]) {
    const filter=new CursorFilter(options),lags=[];
    for(let i=0;i<180;i++) {
      const timestamp=i*1000/30,x=speed*timestamp/1000;
      const point=filter.update({x,y:0,z:0},timestamp);
      if(i>=30)lags.push((x-point.x)/speed*1000);
    }
    motion.push({speedPalmsPerSecond:speed,meanFilterLagMs:mean(lags),p95FilterLagMs:percentile(lags,.95)});
  }
  return {rawStdPalms:std(raw),legacyStdPalms:std(before),cursorStdPalms:std(after),
    stdReductionVsLegacy:1-std(after)/std(before),motion,samples};
}

export function createSequence() {
  const frames=[];
  for(let timestamp=0;timestamp<=8000;timestamp+=40) {
    const ratio=timestamp<240||timestamp>=3360&&timestamp<4000||timestamp>=7600?.65:.15;
    const pitch=timestamp<800?0:timestamp<3200?80*Math.PI/180:Math.sin(timestamp/1000)*Math.PI/3;
    const detail=worldHand({timestamp,ratio,pitch,shiftX:timestamp<240?0:.025*Math.sin(timestamp/700),
      shiftY:.01*Math.cos(timestamp/900),missing:timestamp>=2600&&timestamp<2720,
      label:timestamp>=4800&&timestamp<4880?'Left':'Right'});
    frames.push({...detail,expectedPinch:ratio<.3,timings:{},depthFrame:null});
  }
  return {schema:'kineglow-observations-v1',evidence:'synthetic-template',
    createdAt:'2026-11-18T00:00:00+08:00',metadata:{width:640,height:480,input:'webcam',
      testCase:'synthetic-rotation-dropout',delegate:'none',description:'数学模板投影，无真人、相机或模型推理'},
    limitations:['仅测试状态机和几何，不能证明真人检测率、端到端延迟或帧率'],frames};
}

export function gestureExperiment(sequence=createSequence()) {
  return ['legacy','world'].map(gestureMode=>{
    const machine=new HandInteraction(undefined,{gestureMode});
    let falseReleases=0,pinchFrames=0,expectedPinchFrames=0,heldFrames=0,previous='TrackingLost';
    const events=sequence.frames.map(frame=>{
      const result=machine.update(frame,640,480);
      if(frame.expectedPinch) {
        expectedPinchFrames++;if(result.state==='Pinching')pinchFrames++;
        if(previous==='Pinching'&&result.state==='Idle')falseReleases++;
      }
      if(result.cursorSource==='held')heldFrames++;
      previous=result.state;
      return {timestamp:frame.timestamp,state:result.state,basis:result.gestureBasis??'legacy',pose:result.pose??null};
    });
    return {gestureMode,falseReleases,pinchFrames,expectedPinchFrames,
      syntheticPinchStateCoverage:pinchFrames/expectedPinchFrames,heldFrames,events};
  });
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const sequence=createSequence(),filter=filterExperiment(),gestures=gestureExperiment(sequence);
  const sweep=[];
  for(const minCutoff of [.5,.75,1,1.5])for(const beta of [1,2,4,8]) {
    const {samples,...result}=filterExperiment({minCutoff,beta});sweep.push({minCutoff,beta,...result});
  }
  const report={stage:'M1 candidate',evidence:'synthetic-only',generatedAt:new Date().toISOString(),
    parameters:{cursor:CURSOR_FILTER,gesture:HAND_GEOMETRY},filter,gestures,sweep,
    holdoutSeeds:[1,42,90210].map(seed=>{const {samples,...result}=filterExperiment({},seed);return {seed,...result};}),
    humanValidation:{frontAvailability:null,angledAvailability:null,jitterPx:null,physicalLatencyMs:null,
      renderFps:null,gpuUtilization:null,status:'未实测'}};
  if(process.argv.includes('--write')) {
    const folder=new URL('../../local-output/',import.meta.url);await mkdir(folder,{recursive:true});
    await writeFile(new URL('2026-11-18-m1-synthetic.json',folder),JSON.stringify(report,null,2)+'\n');
    await writeFile(new URL('synthetic-hand.json',folder),JSON.stringify(sequence)+'\n');
  }
  console.log(JSON.stringify({filter:{...filter,samples:undefined},gestures:gestures.map(({events,...rest})=>rest),
    holdoutSeeds:report.holdoutSeeds.map(s=>({seed:s.seed,reduction:s.stdReductionVsLegacy})),
    sweep:sweep.map(s=>({minCutoff:s.minCutoff,beta:s.beta,reduction:s.stdReductionVsLegacy,lagAtHalfPalm:s.motion[1].meanFilterLagMs}))},null,2));
}
