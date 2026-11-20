// Deterministic synthetic calibrated hand. Not a recorded Astra sequence.
const TEMPLATE = [
  [.50,.78,0], [.44,.72,-.01], [.40,.65,-.02], [.43,.54,-.03], [.49,.42,-.04],
  [.44,.59,0], [.44,.48,-.01], [.46,.40,-.025], [.49,.36,-.04],
  [.50,.57,0], [.50,.43,-.01], [.50,.34,-.02], [.50,.28,-.03],
  [.56,.59,0], [.57,.47,-.01], [.58,.39,-.02], [.58,.34,-.03],
  [.62,.64,0], [.65,.55,-.01], [.66,.49,-.02], [.67,.44,-.03],
];
export function rgbdHand({ root = 1, shiftX = 0, shiftY = 0, mode = 'all', ratio = .1 } = {}) {
  const frame = { width: 640, height: 480, intrinsics: [500,500,320,240], distortion: [0,0,0,0,0],
    depth_unit: 'mm', coordinate_system: 'color-camera', mirrored: false,
    registration: 'factory-calibrated-software', depth: new Uint16Array(640 * 480) };
  const hand = TEMPLATE.map(([x,y,offset]) => {
    const z = root + offset, X = (x*640-320)/500*(1+offset)+shiftX, Y = (y*480-240)/500*(1+offset)+shiftY;
    return { x: (X/z*500+320)/640, y: (Y/z*500+240)/480, z: offset/root*500/640 };
  });
  const palmPixels = Math.hypot((hand[0].x-hand[9].x)*640,(hand[0].y-hand[9].y)*480);
  hand[4] = { x: hand[8].x + ratio*palmPixels/640, y: hand[8].y, z: hand[8].z };
  const indices = mode === 'none' ? [] : mode === 'palm' ? [0,5,6,9,10,13,14,17,18] : Array.from({length:21},(_,i)=>i);
  for (const i of indices) {
    const u=Math.round(hand[i].x*640),v=Math.round(hand[i].y*480);
    const mm=mode==='background'?3000:Math.round((root+TEMPLATE[i][2])*1000);
    for(let y=Math.max(0,v-2);y<=Math.min(479,v+2);y++)for(let x=Math.max(0,u-2);x<=Math.min(639,u+2);x++)frame.depth[y*640+x]=mm;
  }
  return { frame, hand, tip: hand[8], trueTipDepth: root+TEMPLATE[8][2] };
}
