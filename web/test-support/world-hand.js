// Synthetic pinhole projection of a hand template; NOT captured model output.
// Distinct world and projected coordinates expose foreshortening regressions.
const template = [
  [0,.045,0], [-.025,.025,0], [-.040,0,-.005], [-.035,-.035,-.01], [0,0,0],
  [-.035,-.035,0], [-.034,-.065,-.005], [-.030,-.090,-.008], [-.025,-.115,-.015],
  [0,-.045,0], [0,-.085,-.005], [0,-.115,-.010], [0,-.140,-.015],
  [.025,-.040,0], [.025,-.075,-.005], [.025,-.100,-.010], [.025,-.120,-.015],
  [.045,-.025,0], [.05,-.050,-.005], [.05,-.075,-.010], [.05,-.095,-.015],
];

export function worldHand({ timestamp=0, ratio=.65, pitch=0, yaw=0, scale=1, root=.6,
  shiftX=0, shiftY=0, label='Right', missing=false }={}) {
  const points=template.map(p=>[...p]);
  points[4]=[points[8][0]+ratio*.09,points[8][1],points[8][2]];
  const cx=Math.cos(pitch),sx=Math.sin(pitch),cy=Math.cos(yaw),sy=Math.sin(yaw);
  const world=points.map(([x,y,z])=>{
    const yy=y*cx-z*sx,zz=y*sx+z*cx;
    return {x:(x*cy+zz*sy)*scale,y:yy*scale,z:(-x*sy+zz*cy)*scale};
  });
  const hand=world.map(p=>({x:.5+(p.x+shiftX)/(root+p.z)*500/640,
    y:.5+(p.y+shiftY)/(root+p.z)*500/480,z:(p.z-world[0].z)/root*500/640}));
  return { timestamp, source:'摄像头', landmarks:missing?[]:[hand],
    worldLandmarks:missing?[]:[world], handedness:missing?[]:[[{categoryName:label,score:.99}]] };
}

export function armWorld(machine, options={}) {
  const send=(timestamp,ratio)=>machine.update(worldHand({...options,timestamp,ratio}),640,480);
  send(0,.65);send(80,.65);send(160,.65);
  send(200,.15);send(280,.15);return send(320,.15);
}
