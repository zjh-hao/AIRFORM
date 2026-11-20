const arrivalMs=2500, cycleMs=5200;

function buildCloud() {
  let seed=4187;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const spine=angle=>{
    const radius=.52+.22*Math.cos(3*angle);
    return [radius*Math.cos(2*angle),radius*Math.sin(2*angle),.38*Math.sin(3*angle)];
  };
  const particles=[];
  for(let slice=0;slice<240;slice++){
    for(let grain=0;grain<23;grain++){
      const angle=(slice+random()*.72)*Math.PI/120;
      const [cx,cy,cz]=spine(angle),[nextX,nextY,nextZ]=spine(angle+.001);
      const dx=nextX-cx,dy=nextY-cy,dz=nextZ-cz;
      const planar=Math.hypot(dx,dy),length=Math.hypot(planar,dz);
      const phase=(grain+.64*random())*Math.PI*2/23+.3*angle;
      const thickness=.137*(1+.17*Math.sin(3*angle))*(random()<.045?1+random()*.9:1);
      const cosine=Math.cos(phase)*thickness,sine=Math.sin(phase)*thickness;
      const px=cx-dy/planar*cosine-dz*dx/(length*planar)*sine;
      const py=cy+dx/planar*cosine-dz*dy/(length*planar)*sine;
      const pz=cz+planar/length*sine;
      const depth=.54*py+.84*pz, zoom=1/(1-depth*.19);
      const tone=Math.max(0,Math.min(1,.45+.55*depth+.23*Math.sin(phase)+.12*random()));
      const lime=Math.sin(angle*2+.45)> .93 && Math.cos(phase)>.15;
      particles.push({x:(px*.94+py*.18)*zoom,y:(py*.84-pz*.54-px*.21)*zoom,depth,
        size:.65+tone*.95,fill:lime?'rgba(207,243,74,.88)':'rgba(221,232,224,'+(.12+.87*tone).toFixed(2)+')',
        offsetX:0,offsetY:0});
    }
  }
  for(const particle of particles){
    const side=Math.floor(random()*4),along=random(),outside=.008+.12*random();
    particle.fromX=side===0?-outside:side===1?1+outside:along;
    particle.fromY=side===2?-outside:side===3?1+outside:along;
    particle.bend=(random()-.5)*.65;
    particle.delay=random()*.28;
    particle.duration=.49+random()*.23;
  }
  return particles.sort((first,second)=>first.depth-second.depth);
}

export function installFieldCloud(canvas,landing,region){
  const context=canvas.getContext('2d');
  if(!context)return ()=>{};
  const particles=buildCloud(), motion=matchMedia('(prefers-reduced-motion: reduce)');
  let regionWidth=0,regionHeight=0,originX=0,originY=0,canvasLeft=0,canvasTop=0;
  let width=0,height=0,frame=0,last=null,pointer=null,elapsed=motion.matches?arrivalMs:0;
  const visible=()=>!landing.hidden&&!document.hidden;
  const queue=()=>{if(!frame&&visible())frame=requestAnimationFrame(paint);};
  function paint(now){
    frame=0;
    if(!visible()||!width||!height)return;
    const delta=last===null?0:now-last;
    if(!motion.matches && last!==null && delta<1000/30-1){queue();return;}
    last=now;
    elapsed+=delta;
    const step=Math.min(60,delta||16);
    const arrival=Math.min(1,elapsed/arrivalMs);
    const blend=Math.min(1,Math.max(0,(elapsed-arrivalMs+600)/600));
    const breath=motion.matches?0:blend*blend*(3-2*blend)*Math.sin((elapsed-arrivalMs)*2*Math.PI/cycleMs);
    const scale=Math.min(regionWidth*.48,regionHeight*.52),radius=Math.max(52,Math.min(108,scale*.26));
    const ease=motion.matches?1:1-Math.exp(-step/(pointer?75:150));
    context.clearRect(0,0,width,height);
    let settling=false;
    for(const particle of particles){
      const swell=1+breath*(.032+.012*particle.depth);
      let anchorX=originX+regionWidth*.51+scale*(particle.x*swell+particle.depth*.016*breath);
      let anchorY=originY+regionHeight*.5+scale*(particle.y*swell-particle.depth*.021*breath);
      if(arrival<1 && !motion.matches){
        const progress=Math.min(1,Math.max(0,(arrival-particle.delay)/particle.duration));
        const remaining=(1-progress)**3,arc=remaining*progress*particle.bend;
        const travelX=width*particle.fromX-anchorX,travelY=height*particle.fromY-anchorY;
        anchorX+=remaining*travelX-travelY*arc;
        anchorY+=remaining*travelY+travelX*arc;
      }
      let targetX=0,targetY=0;
      if(pointer){
        const dx=anchorX+canvasLeft-pointer.x,dy=anchorY+canvasTop-pointer.y,distance=Math.hypot(dx,dy);
        if(distance<radius){
          const force=(1-distance/radius)**2*radius*.89;
          targetX=(distance?dx/distance:1)*force;targetY=(distance?dy/distance:0)*force;
        }
      }
      particle.offsetX+=(targetX-particle.offsetX)*ease;
      particle.offsetY+=(targetY-particle.offsetY)*ease;
      if(Math.abs(targetX-particle.offsetX)+Math.abs(targetY-particle.offsetY)>.12)settling=true;
      else{particle.offsetX=targetX;particle.offsetY=targetY;}
      context.fillStyle=particle.fill;
      const size=particle.size*Math.max(.9,scale/325)*(1+.07*breath);
      context.fillRect(anchorX+particle.offsetX,anchorY+particle.offsetY,size,size);
    }
    if(!motion.matches||settling)queue();else last=null;
  }
  function resize(){
    if(!visible())return;
    const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio,2);
    const target=region.getBoundingClientRect();
    regionWidth=target.width;regionHeight=target.height;
    canvasLeft=rect.left;canvasTop=rect.top;
    originX=target.left-canvasLeft;originY=target.top-canvasTop;
    width=rect.width;height=rect.height;
    const pixelsWide=Math.round(width*dpr),pixelsHigh=Math.round(height*dpr);
    if(canvas.width!==pixelsWide)canvas.width=pixelsWide;
    if(canvas.height!==pixelsHigh)canvas.height=pixelsHigh;
    context.setTransform(dpr,0,0,dpr,0,0);
    if(frame)cancelAnimationFrame(frame);
    last=null;paint(performance.now());
  }
  const move=event=>{
    pointer={x:event.clientX,y:event.clientY};queue();
  };
  const leave=()=>{pointer=null;queue();};
  const visibility=()=>{
    canvas.hidden=!visible();
    if(visible()){resize();return;}
    cancelAnimationFrame(frame);frame=0;last=null;pointer=null;
    for(const particle of particles){particle.offsetX=0;particle.offsetY=0;}
  };
  const bounds=new ResizeObserver(resize),state=new MutationObserver(visibility);
  const changeMotion=()=>{if(motion.matches)elapsed=Math.max(elapsed,arrivalMs);last=null;queue();};
  motion.addEventListener('change',changeMotion);
  bounds.observe(canvas);bounds.observe(region);state.observe(landing,{attributes:true,attributeFilter:['hidden']});
  region.addEventListener('pointermove',move);region.addEventListener('pointerleave',leave);
  document.addEventListener('visibilitychange',visibility);resize();
  return ()=>{
    bounds.disconnect();state.disconnect();cancelAnimationFrame(frame);
    region.removeEventListener('pointermove',move);region.removeEventListener('pointerleave',leave);
    document.removeEventListener('visibilitychange',visibility);
    motion.removeEventListener('change',changeMotion);
  };
}
