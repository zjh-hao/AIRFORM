import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader, DRACO_GLTF_CONFIG} from 'three/addons/loaders/DRACOLoader.js';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {drawFrame} from './custom-hologram.js';

function checkContainer(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0) !== 0x676c5446 || view.getUint32(4,true) !== 2 ||
      view.getUint32(8,true) !== buffer.byteLength || view.getUint32(16) !== 0x4a534f4e ||
      view.getUint32(12,true) > buffer.byteLength - 20) throw Error('请选择完整的 GLB 2.0 模型文件。');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,view.getUint32(12,true))));
  if ([...(json.buffers ?? []), ...(json.images ?? [])].some(item => item.uri && !item.uri.startsWith('data:'))) {
    throw Error('模型引用了外部文件。请把贴图和几何数据一起打包进 GLB 后再导入。');
  }
  return json.extensionsUsed ?? [];
}

function disposeObjects(roots) {
  const resources = new Set(), images = new Set();
  for (const root of roots) root.traverse(node => {
    if (node.geometry) resources.add(node.geometry);
    if (node.skeleton) resources.add(node.skeleton);
    for (const material of [].concat(node.material ?? [])) {
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) {
        resources.add(value);
        images.add(value.source.data);
      }
    }
  });
  for (const resource of resources) resource.dispose();
  for (const image of images) image?.close?.();
}

export async function loadModel(buffer) {
  const extensions = checkContainer(buffer);
  const renderer = new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(384,384,false);
  renderer.setClearColor(0,0);
  renderer.toneMapping = T.ACESFilmicToneMapping;
  const draco = new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG).setWorkerLimit(2);
  const textures = extensions.includes('KHR_texture_basisu') ? new KTX2Loader().setWorkerLimit(2).detectSupport(renderer) : null;
  let gltf, environment, mixer;
  function dispose() {
    mixer?.stopAllAction();
    if (gltf) disposeObjects(gltf.scenes);
    environment?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
  try {
    const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(textures).setMeshoptDecoder(MeshoptDecoder);
    gltf = await loader.parseAsync(buffer,'');
    const model = gltf.scene;
    const bounds = new T.Box3().setFromObject(model,true);
    const radius = bounds.getSize(new T.Vector3()).length()/2;
    if (!Number.isFinite(radius) || radius <= 0) throw Error('模型中没有可显示的几何体。');
    const centered = new T.Group();
    centered.scale.setScalar(1/radius);
    centered.position.copy(bounds.getCenter(new T.Vector3())).multiplyScalar(-1/radius);
    centered.add(model);
    const turntable = new T.Group(), scene = new T.Scene();
    turntable.add(centered);
    scene.add(turntable);
    const camera = new T.OrthographicCamera(-1.04,1.04,1.04,-1.04,.1,10);
    camera.position.set(0,.85,4);
    camera.lookAt(0,0,0);
    const room = new RoomEnvironment(), pmrem = new T.PMREMGenerator(renderer);
    try { environment = pmrem.fromScene(room,.045); }
    finally { room.dispose(); pmrem.dispose(); }
    scene.environment = environment.texture;
    const light = new T.DirectionalLight(0xfff5ea,2);
    light.position.set(-3,5,4);
    scene.add(light);
    if (gltf.animations.length) {
      mixer = new T.AnimationMixer(model);
      mixer.clipAction(gltf.animations[0]).play();
    }
    const start = performance.now()/1000, surface = renderer.domElement;
    let lastFrame = -1;
    return {
      draw(ctx,x,y,size,seconds,alpha) {
        const frame = Math.floor(Math.max(0,seconds-start)*24);
        if (frame !== lastFrame) {
          turntable.rotation.y = .35 + frame/24 * .36;
          mixer?.setTime(frame/24);
          renderer.render(scene,camera);
          lastFrame = frame;
        }
        drawFrame(ctx,surface,0,0,surface.width,surface.height,x,y,size,alpha);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    draco.dispose();
    textures?.dispose();
  }
}
