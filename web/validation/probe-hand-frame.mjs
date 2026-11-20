import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function probe(evaluate){
  const bytes=await readFile(process.env.KINEGLOW_SHOT);
  const crop=(process.env.KINEGLOW_CROP??'0,0,640,480').split(',').map(Number);
  const results=await evaluate('('+run.toString()+')('+JSON.stringify(bytes.toString('base64'))+','+JSON.stringify(crop)+')');
  console.log(JSON.stringify(results));
  const live=results.find(row=>row.delegate==='GPU' && row.runningMode==='VIDEO');
  assert.ok(live?.samples.some(sample=>sample.hand==='Right' && sample.points===21),'Expected right-hand skeleton from the live path');
  assert.equal(live.blank,0,'Blank frames must not retain a skeleton');
  return results;
}

async function run(encoded,crop){
  const shot=await createImageBitmap(await(await fetch('data:image/png;base64,'+encoded)).blob());
  const full=new OffscreenCanvas(640,480),ctx=full.getContext('2d');
  ctx.translate(640,0);ctx.scale(-1,1);ctx.drawImage(shot,...crop,0,0,640,480);shot.close();
  const rows=[];
  for(const delegate of ['GPU','CPU'])for(const runningMode of ['VIDEO','IMAGE']){
    const worker=new Worker('/tracking-worker.js');
    const ask=(data,transfer=[])=>new Promise((resolve,reject)=>{
      worker.onmessage=({data})=>data.error?reject(Error(data.error)):resolve(data);
      worker.onerror=event=>reject(Error(event.message));worker.postMessage(data,transfer);
    });
    try{
      const init=await ask({type:'init',delegate,runningMode});
      const row={delegate:init.delegate,runningMode,samples:[]};
      const blank=new OffscreenCanvas(640,480);
      blank.getContext('2d').fillRect(0,0,640,480);
      for(const timestamp of [100,134,168,202,236,600]){
        const bitmap=await createImageBitmap(timestamp>=236?blank:full);
        const out=await ask({type:'detect',bitmap,timestamp,live:true,firstFrame:timestamp===100},[bitmap]);
        row.samples.push({hand:out.result.handedness[0]?.[0]?.categoryName,points:out.result.landmarks[0]?.length??0,recovered:out.recovered});
        if(timestamp===600)row.blank=out.result.landmarks.length;
        out.bitmap.close();
      }
      rows.push(row);
    }finally{worker.terminate();}
  }
  return rows;
}
