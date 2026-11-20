import {AdditiveBlending,BufferAttribute,BufferGeometry,Color,DoubleSide,DynamicDrawUsage,Group,Mesh,MeshBasicMaterial,Points,ShaderMaterial,Vector3} from 'three';

const palettes={ion:['#edffff','#16baff'],aurora:['#73ffdf','#bb75ff'],ember:['#fff2ad','#ff6d22']};
const clamp=value=>Math.min(1,Math.max(0,value));
const noise=value=>{const seed=Math.sin(value*91.713)*45738.2;return seed-Math.floor(seed);};

export class FlightPath{
  constructor(points){this.points=points;this.distances=[0];for(let index=1;index<points.length;index++)this.distances.push(this.distances.at(-1)+points[index].distanceTo(points[index-1]));}
  extend(point){
    const last=this.points.at(-1);this.distances.push(this.distances.at(-1)+last.distanceTo(point));this.points.push(point);
    if(this.points.length>160){this.points.shift();const offset=this.distances[1];this.distances=this.distances.slice(1).map(value=>value-offset);}
  }
  at(fraction,out){
    const distance=clamp(fraction)*this.distances.at(-1);let low=0,high=this.points.length-1;
    while(high-low>1){const mid=(low+high)>>1;if(this.distances[mid]<distance)low=mid;else high=mid;}
    return out.lerpVectors(this.points[low],this.points[high],(distance-this.distances[low])/(this.distances[high]-this.distances[low]||1));
  }
}

function makeFlight(points,type,size,owner,start,attached=false){
  const path=new FlightPath(points),group=new Group(), count=type==='ember'?148:84;
  const positions=new Float32Array(count*3),colors=new Float32Array(count*3),sizes=new Float32Array(count);
  const geometry=new BufferGeometry(),position=new BufferAttribute(positions,3).setUsage(DynamicDrawUsage);
  geometry.setAttribute('position',position);geometry.setAttribute('tint',new BufferAttribute(colors,3));geometry.setAttribute('diameter',new BufferAttribute(sizes,1));
  const [inner,outer]=palettes[type].map(value=>new Color(value)),color=new Color();
  for(let index=0;index<count;index++){
    const tail=index/(count-1);
    color.copy(inner).lerp(outer,tail).multiplyScalar(1-.55*tail).toArray(colors,index*3);
    sizes[index]=(index===0?1.7:type==='ember'?.12+.48*noise(index+3):.24+.58*(1-tail))*size*.055;
  }
  const material=new ShaderMaterial({transparent:true,depthWrite:false,blending:AdditiveBlending,uniforms:{pixels:{value:100},fade:{value:1}},
    vertexShader:'attribute vec3 tint; attribute float diameter; uniform float pixels; varying vec3 light; void main(){light=tint; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); gl_PointSize=clamp(diameter*pixels,1.2,80.);}',
    fragmentShader:'varying vec3 light; uniform float fade; void main(){float r=length(gl_PointCoord-.5)*2.; if(r>=1.)discard; gl_FragColor=vec4(light,fade*(exp(-r*r*5.)+.3*(1.-r)));}'});
  const dust=new Points(geometry,material);dust.frustumCulled=false;group.add(dust);
  const steps=36,ribbons=[];
  if(type==='aurora')for(const tint of palettes.aurora){
    const strip=new BufferGeometry(),vertices=new BufferAttribute(new Float32Array(steps*6),3).setUsage(DynamicDrawUsage),indices=[];
    for(let index=2;index<steps*2;index++)indices.push(index-2,index-1,index);
    strip.setAttribute('position',vertices);strip.setIndex(indices);
    const mesh=new Mesh(strip,new MeshBasicMaterial({color:tint,side:DoubleSide,blending:AdditiveBlending,transparent:true,opacity:.62,depthWrite:false}));mesh.frustumCulled=false;group.add(mesh);ribbons.push(mesh);
  }
  const point=new Vector3(),side=new Vector3(),tangent=new Vector3(),up=new Vector3(),axis=new Vector3();
  const duration=Math.min(4200,Math.max(1300,path.distances.at(-1)*460));
  function frame(now,pixels){
    const phase=attached?1:(now-start)/duration;if(!owner.parent || phase>=1.42)return false;
    const extent=attached?Math.min(1,1.35/(path.distances.at(-1)||1)):.36;
    const width=size*.045,fade=clamp((1.42-phase)/.32);material.uniforms.fade.value=fade;material.uniforms.pixels.value=pixels;
    for(let index=0;index<count;index++){
      const tail=index/(count-1),fraction=phase-tail*extent;
      path.at(fraction,point);
      const spread=width*tail*(type==='ember'?3.6:.32);
      point.x+=(noise(index+1)*2-1)*spread;point.y+=(noise(index+711)*2-1)*spread-(type==='ember'?tail*tail*width*2:0);point.z+=(noise(index+333)*2-1)*spread;
      if(fraction<0 || fraction>1)point.z=1e5;
      position.setXYZ(index,point.x,point.y,point.z);
    }
    position.needsUpdate=true;
    ribbons.forEach((mesh,band)=>{
      const attr=mesh.geometry.attributes.position;mesh.material.opacity=.64*fade;
      for(let index=0;index<steps;index++){
        const tail=index/(steps-1),fraction=clamp(phase-extent*tail);path.at(fraction,point);
        path.at(Math.min(.999,fraction)+.001,tangent).sub(path.at(Math.min(.999,fraction),axis)).normalize();
        axis.set(0,0,1);if(Math.abs(tangent.z)>.9)axis.set(0,1,0);
        side.crossVectors(tangent,axis).normalize();up.crossVectors(tangent,side);
        const angle=tail*8+(attached?now*.002:phase*5)+Math.PI*band,envelope=Math.sin(Math.PI*tail);
        point.addScaledVector(side,Math.cos(angle)*width*envelope).addScaledVector(up,Math.sin(angle)*width*envelope);
        const half=width*.34*envelope;point.addScaledVector(side,-half);attr.setXYZ(index*2,point.x,point.y,point.z);point.addScaledVector(side,half*2);attr.setXYZ(index*2+1,point.x,point.y,point.z);
      }attr.needsUpdate=true;
    });return true;
  }
  return {group,frame,owner,path,dispose(){group.removeFromParent();for(const child of group.children){child.geometry.dispose();child.material.dispose();}}};
}

export function cometFlights(scene){
  let flights=[],live=null;
  const detach=()=>{live?.dispose();live=null;};
  return {trace(previous,next,type,size,owner){if(live?.owner===owner){live.path.extend(next);return;}detach();live=makeFlight([previous,next],type,size,owner,performance.now(),true);scene.add(live.group);},
    launch(...args){detach();if(flights.length===8)flights.shift().dispose();const flight=makeFlight(...args,performance.now());flights.push(flight);scene.add(flight.group);},
    update(now,pixels){const dirty=Boolean(live)||flights.length>0;if(live && !live.frame(now,pixels))detach();flights=flights.filter(flight=>{if(flight.frame(now,pixels))return true;flight.dispose();return false;});return dirty;},
    clear(){detach();for(const flight of flights)flight.dispose();flights=[];}};
}
