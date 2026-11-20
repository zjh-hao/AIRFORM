import {readFile,writeFile} from 'node:fs/promises';
import {DrawingGain} from '../src/drawing-gain.js';
import {CursorFilter} from '../src/cursor-filter.js';
import {unitHandShape} from '../src/hand-shape.js';
import {filterExperiment} from './m1-validate.mjs';
if(!process.argv[2] || !process.argv[3])throw Error('Pass an input observation JSON and output report path');
const data=JSON.parse(await readFile(process.argv[2],'utf8'));
const gain=new DrawingGain(),samples=[];
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
const std=a=>Math.sqrt(mean(a.map(v=>(v-mean(a))**2)));
function spread(points) {
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y),mx=mean(xs),my=mean(ys);
  const radius=points.map(p=>Math.hypot(p.x-mx,p.y-my)).sort((a,b)=>a-b);
  return {stdX:std(xs),stdY:std(ys),radialRms:Math.hypot(std(xs),std(ys)),p95:radius[Math.ceil(radius.length*.95)-1]};
}
for(const f of data.frames) {
  if(f.timestamp>=10000)continue;
  const hand=f.landmarks[f.interaction.handIndex],input=gain.project(hand[8],f.depthFrame,hand);
  samples.push({timestamp:f.timestamp,point:{x:input.x/.18,y:input.y/.18,z:0},
    root:gain.lastRoot,relativeZ:unitHandShape(hand,f.depthFrame).points[8].z,
    tipX:hand[8].x*f.depthFrame.width,tipY:hand[8].y*f.depthFrame.height});
}
const pixelsPerPalm=.18*5*Math.min(562.5/6.6,480/4.95);
const averageRoot=mean(samples.map(sample=>sample.root));
const averageZ=mean(samples.map(sample=>sample.relativeZ));
const inputSpread=scale=>spread(samples.map(sample=>({
  x:sample.point.x*scale(sample)*pixelsPerPalm,y:sample.point.y*scale(sample)*pixelsPerPalm
})));
function noisyRamp(options,axis,speed) {
  const stationary=new CursorFilter(options),moving=new CursorFilter(options),lags=[];
  for(const sample of samples) {
    const offset=speed*(sample.timestamp-samples[0].timestamp)/1000;
    const reference=stationary.update(sample.point,sample.timestamp);
    const displaced=moving.update({...sample.point,[axis]:sample.point[axis]+offset},sample.timestamp);
    lags.push((offset-(displaced[axis]-reference[axis]))/speed*1000);
  }
  return {axis,speedPalmsPerSecond:speed,meanSignedLagMs:mean(lags),
    p95AbsoluteLagMs:lags.map(Math.abs).sort((left,right)=>left-right)[Math.ceil(.95*lags.length)-1]};
}
const run=options=>{
  const filter=new CursorFilter(options),out=samples.map(s=>filter.update(s.point,s.timestamp));
  const px=spread(out.map(p=>({x:p.x*pixelsPerPalm,y:p.y*pixelsPerPalm})));
  return {options,...px,slowRampLagMs:filterExperiment(options).motion[0].meanFilterLagMs};
};
const baseline=run({}),sweep=[];
for(const minCutoff of [.03,.05,.1,.2,.35,.5])for(const beta of [0,.5,1,2,4])sweep.push(run({minCutoff,beta}));
const report={evidence:'offline-calibration-on-recorded-physical-static-input',
  source:'local static-hand recording',frames:samples.length,
  rawInteractionAblations:{
    fixedPalmScale:inputSpread(sample=>averageRoot/sample.root),
    fixedPalmScaleAndTipRelativeZ:inputSpread(sample=>averageRoot*averageZ/(sample.root*sample.relativeZ))
  },
  pairedNoiseRamp:[{}, {minCutoff:.03,beta:0}].map(options=>({options,
    motion:['x','y'].flatMap(axis=>[.1,.5,1].map(speed=>noisyRamp(options,axis,speed)))})),
  rawImageTipPixels:spread(samples.map(s=>({x:s.tipX,y:s.tipY}))),
  rawInteractionPixels:spread(samples.map(s=>({x:s.point.x*pixelsPerPalm,y:s.point.y*pixelsPerPalm}))),
  visualScale:{mean:mean(samples.map(s=>s.root)),std:std(samples.map(s=>s.root))},baseline,sweep,
  note:'Cold-start replay of the independent cursor branch, not fresh real-time validation. Synthetic ramp lag excludes camera/inference/render latency.'};
await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,sweep:sweep.filter(s=>s.slowRampLagMs<100).sort((a,b)=>a.radialRms-b.radialRms).slice(0,8)},null,2));
