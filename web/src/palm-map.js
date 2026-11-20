import {sampleTipDepth} from './depth-sampling.js';
import {PalmFollow} from './palm-follow.js';

const anchors=[0,5,9,13,17];
const dist=(first,second)=>Math.hypot(first.x-second.x,first.y-second.y,first.z-second.z);
const median=list=>list.sort((first,second)=>first-second)[list.length>>1];
export function palmPose(packet,index,width,height){
  const hand=packet.landmarks[index],world=packet.worldLandmarks?.[index];
  if(hand?.length!==21 || hand.some(point=>!Number.isFinite(point?.x+point?.y)))return null;
  const bones=world?.length===21 && world.every(point=>Number.isFinite(point?.x+point?.y+point?.z))?world:
    hand.map(point=>({x:point.x*width,y:point.y*height,z:(point.z||0)*width}));
  let extended=0;
  for(const base of [5,9,13,17]){
    const [knuckle,pip,dip,tip]=bones.slice(base,base+4);
    const length=dist(knuckle,pip)+dist(pip,dip)+dist(dip,tip);
    if(dist(knuckle,tip)>.87*length && dist(bones[0],tip)>1.16*dist(bones[0],knuckle))extended++;
  }
  if(extended<4 || dist(bones[4],bones[8])<.22*dist(bones[0],bones[9]))return null;
  const center={x:0,y:0};for(const joint of anchors){center.x+=hand[joint].x/5;center.y+=hand[joint].y/5;}
  const span=(first,second)=>Math.hypot((hand[first].x-hand[second].x)*width,(hand[first].y-hand[second].y)*height);
  let radius=1.35*Math.max(span(5,17),span(0,9)*.9);
  if(radius<5 || center.x<0 || center.x>1 || center.y<0 || center.y>1)return null;
  const frame=packet.depthFrame;
  let measured=false;
  if(frame?.depth && frame.intrinsics?.[0]>0){
    const depths=[center,hand[9],hand[5],hand[13]].map(point=>sampleTipDepth(point,frame).z).filter(Number.isFinite);
    if(depths.length>=2){const depth=median(depths);if(depths.filter(value=>Math.abs(value-depth)<.07).length>=2){
      const widthMeters=bones===world?Math.max(.058,Math.min(.115,dist(bones[5],bones[17]))):.08;
      const metricRadius=frame.intrinsics[0]*widthMeters*1.35/depth;
      if(metricRadius>radius*.30 && metricRadius<radius*2.4){radius=.28*radius+.72*metricRadius;measured=true;}
    }}
  }
  radius=Math.min(width*.42,Math.max(9,radius));
  return {x:center.x*width,y:center.y*height,radius,measured,label:packet.handedness?.[index]?.[0]?.categoryName||''};
}

export function installPalmMap(canvas,camera,status,drawObject){
  const ctx=canvas.getContext('2d'),follow=new PalmFollow();let raf=0;
  const active=()=>document.body.dataset.effect==='solar';
  function reset(){cancelAnimationFrame(raf);raf=0;follow.reset();ctx.clearRect(0,0,canvas.width,canvas.height);}
  function render(now){raf=0;ctx.clearRect(0,0,canvas.width,canvas.height);if(!active())return;
    const pose=follow.frame(now);
    if(!pose){status.textContent='平摊左手或右手，托起全息素材。';return;}
    if(follow.coast && pose.alpha>0 && status.dataset.palmState!=='coast'){
      status.dataset.palmState='coast';status.textContent='手掌暂时丢失 · 全息素材正沿原方向缓停（非实测）';
    }
    if(pose.alpha>0)drawObject(ctx,pose,now/1000);raf=requestAnimationFrame(render);
  }
  function receive({detail}){
    if(!active())return;
    if(detail.source==='stopped'){reset();status.textContent='输入已停止。启动摄像头后，平摊任意一只手。';return;}
    if(detail.source!=='摄像头' || !camera.closest('.camera-live'))return;
    if(canvas.width!==camera.width || canvas.height!==camera.height){canvas.width=camera.width;canvas.height=camera.height;reset();}
    const candidates=detail.landmarks.map((_,index)=>palmPose(detail,index,canvas.width,canvas.height)).filter(Boolean);
    const visible=detail.landmarks.some((hand,index)=>hand?.length===21 &&
      (!follow.label || !detail.handedness?.[index]?.[0]?.categoryName || detail.handedness[index][0].categoryName===follow.label));
    const next=follow.observe(candidates,performance.now(),Math.min(canvas.width,canvas.height),!visible);
    if(!next){if(!follow.pose?.alpha)status.textContent='平摊左手或右手，托起全息素材。';return;}
    status.dataset.palmState='tracked';status.textContent='掌上全息已锁定掌心 · '+(next.measured?'Astra 掌部实测深度':'按掌骨大小估算距离');
    if(!raf)raf=requestAnimationFrame(render);
  }
  window.addEventListener('kineglow:hands',receive);window.addEventListener('kineglow:effect',reset);
  window.addEventListener('pagehide',()=>{reset();window.removeEventListener('kineglow:hands',receive);window.removeEventListener('kineglow:effect',reset);},{once:true});
}
