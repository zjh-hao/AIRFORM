import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

// Centre each turntable on a view that shows the construction and surface finish.
const views = {
  webb:   {yaw:-1.23, pitch:.36, swing:.34},
  rover:  {yaw:.65, pitch:.34},
  watch:  {yaw:-.20, pitch:.14, swing:.52},
  helmet: {yaw:-.47, pitch:.12},
  camera: {yaw:.55, pitch:.12},
};

function foilRelief(){
  const side=256, data=new Uint8Array(side*side);
  for(let y=0;y<side;y++)for(let x=0;x<side;x++){
    const u=x/side*2*Math.PI,v=y/side*2*Math.PI;
    const warp=.65*Math.sin(2*v+u)+.24*Math.cos(4*u-v);
    const folds=Math.abs(Math.sin(4*u+2*v+warp))**.42;
    const ripples=Math.sin(13*u-5*v+3*warp)*Math.sin(v+warp);
    data[y*side+x]=Math.round(128+70*(folds-.5)+24*ripples);
  }
  const texture=new T.DataTexture(data,side,side,T.RedFormat);
  texture.wrapS=texture.wrapT=T.RepeatWrapping;
  texture.minFilter=texture.magFilter=T.LinearFilter;texture.needsUpdate=true;
  return texture;
}

export function createModelStudio(size=384) {
  const renderer=new T.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
  renderer.setSize(size,size,false);
  renderer.setClearColor(0,0);
  renderer.toneMapping=T.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.04;
  const scene=new T.Scene(),camera=new T.OrthographicCamera(-1,1,1,-1,.01,100);
  const draco=new DRACOLoader().setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
  const loader=new GLTFLoader().setDRACOLoader(draco);
  camera.position.z=5;
  const pmrem=new T.PMREMGenerator(renderer),room=new RoomEnvironment();
  scene.environment=pmrem.fromScene(room,.045).texture;
  scene.environmentIntensity=.78;
  room.dispose();pmrem.dispose();
  const key=new T.DirectionalLight(0xffefe1,2.15);
  key.position.set(-3,5,4);scene.add(key);
  const rim=new T.DirectionalLight(0xc0dcff,1.6);
  rim.position.set(4,2,-3);scene.add(rim);
  const turntable=new T.Group();
  scene.add(turntable);
  let view;
  function aim(phase, study=false) {
    const a=phase*2*Math.PI;
    turntable.rotation.set(view.pitch+.065*Math.sin(a),study?a:view.yaw+(view.swing??.61)*Math.sin(a+.32),0,'XYZ');
    turntable.updateMatrixWorld(true);
  }
  return {
    async select(id,url) {
      turntable.clear();
      view=views[id];
      const {scene:model}=await loader.loadAsync(url);
      // Present the optical assembly at palm scale. The source GLB includes its tripod.
      if(id==='camera')model.getObjectByName('tripod')?.removeFromParent();
      model.traverse(o=>{if(o.isLight)o.visible=false;});
      model.updateMatrixWorld(true);
      const foil=id==='webb'?foilRelief():null;
      if(id==='webb')model.traverse(o=>{
        const m=o.material;
        if(m?.name.endsWith(':mirror_blinn')){
          // Distinguish the eighteen adjacent segments when the aperture is only a few pixels wide.
          const facet=Number(o.name.match(/mirror(\d+)/i)?.[1]??0);
          o.material=m.clone();
          o.material.color.setHex(0xe6b756).multiplyScalar(.78+.25*Math.sin(facet*2.4));
          o.material.metalness=.86;o.material.roughness=.23;
          const seam=new T.LineSegments(new T.EdgesGeometry(o.geometry,38),
            new T.LineBasicMaterial({color:0x66543a,transparent:true,opacity:.5}));
          o.add(seam);
        }
        if(m && /shld_(silv|pink)/.test(m.name)){
          const pos=o.geometry.attributes.position,uv=new Float32Array(pos.count*2),point=new T.Vector3();
          for(let i=0;i<pos.count;i++){
            point.fromBufferAttribute(pos,i).applyMatrix4(o.matrixWorld);
            uv[2*i]=point.x*.31;uv[2*i+1]=point.z*.31;
          }
          o.geometry.setAttribute('uv',new T.BufferAttribute(uv,2));
          m.metalness=.86;m.roughness=.32;m.bumpMap=foil;m.bumpScale=.0026;
        }
      });
      const bounds=new T.Box3().setFromObject(model,true);
      const dims=bounds.getSize(new T.Vector3());
      const unit=1/Math.max(dims.x,dims.y,dims.z);
      const mount=new T.Group();
      mount.add(model);
      mount.scale.setScalar(unit);
      mount.position.copy(bounds.getCenter(new T.Vector3())).multiplyScalar(-unit);
      turntable.add(mount);
      // Fit the entire loop once. Changing the crop per frame makes the model pulse.
      const swept=new T.Box3();
      for(let i=0;i<16;i++){aim(i/16);swept.union(new T.Box3().setFromObject(turntable,true));}
      const center=swept.getCenter(new T.Vector3()), extent=swept.getSize(new T.Vector3());
      camera.position.set(center.x,center.y,5);
      const half=.54*Math.max(extent.x,extent.y);
      camera.left=camera.bottom=-half;camera.right=camera.top=half;
      camera.updateProjectionMatrix();
    },
    frame(phase, study=false) {
      aim(phase,study);renderer.render(scene,camera);
      return renderer.domElement.toDataURL('image/png').split(',')[1];
    }
  };
}
