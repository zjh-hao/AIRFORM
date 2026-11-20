import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLANE } from './interaction.js';
import { connectLiveDrawing } from './live-drawing.js';
import { createDrawingCamera, fitDrawingCamera } from './drawing-camera.js';
import { CursorPlayback } from './cursor-playback.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { BRUSH_COLORS } from './mineral-brush.js';
import { StrokeEngine } from './stroke-engine.js';
import {cometFlights} from './comet.js';
import {brushes} from './effect-library.js';
import { installCanvasTools } from './workstation.js';

export function createScene(host, status, metrics, strokeStatus = null, getStrength) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  const maxDpr=Math.min(devicePixelRatio,1.5);
  renderer.setPixelRatio(maxDpr);
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1422');
  scene.fog=new THREE.FogExp2('#0b1422',.055);
  const camera = createDrawingCamera(host.clientWidth, host.clientHeight, PLANE);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableRotate = true;
  controls.enablePan = controls.enableZoom = false;
  controls.update();
  controls.saveState();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x53647e, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(3, 6, 5);
  scene.add(light);
  const grid = new THREE.GridHelper(10, 20, 0x405773, 0x27384b);
  grid.position.y = -2;
  scene.add(grid);
  const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-PLANE.width / 2, -PLANE.height / 2, PLANE.z),
    new THREE.Vector3(PLANE.width / 2, -PLANE.height / 2, PLANE.z),
    new THREE.Vector3(PLANE.width / 2, PLANE.height / 2, PLANE.z),
    new THREE.Vector3(-PLANE.width / 2, PLANE.height / 2, PLANE.z),
  ]), new THREE.LineBasicMaterial({ color: 0x74849d }));
  const cursor = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x35bfff, depthTest: false }));
  cursor.visible = false;
  cursor.renderOrder = 1;
  scene.add(border, cursor);
  const playback=new CursorPlayback();
  let needsRender = true, lastState = null;
  const palette=document.getElementById('brush-colors'), glow=document.getElementById('brush-glow');
  const glowStatus=document.getElementById('brush-glow-status');
  let color=BRUSH_COLORS[0][1],composer=null,slowFrames=0,reduced=false,liveInput=false;
  const supported=renderer.extensions.has('EXT_color_buffer_float');
  for(const [name,value] of BRUSH_COLORS){
    const swatch=document.createElement('button');
    swatch.type='button';swatch.title=name;swatch.setAttribute('aria-label',name);
    swatch.setAttribute('aria-pressed',String(color===value));swatch.style.backgroundColor=value;
    swatch.onclick=()=>{
      color=value;
      for(const button of palette.children)button.setAttribute('aria-pressed',String(button===swatch));
    };
    palette.append(swatch);
  }
  const configureGlow=()=>{
    if(composer){for(const pass of composer.passes)pass.dispose();composer.dispose();composer=null;}
    const active=supported && glow.value!=='off' && !(glow.value==='auto' && (reduced || liveInput));
    renderer.setPixelRatio(active?maxDpr:Math.min(1,maxDpr));
    if(active){
      composer=new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene,camera));
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(1,1),.24,.18,.76));
      composer.addPass(new OutputPass());composer.addPass(new FXAAPass());
    }
    glowStatus.textContent=active?'辉光 + 抗锯齿':!supported?'兼容模式':liveInput && glow.value==='auto'?'实时输入优先 · 单遍渲染':reduced && glow.value==='auto'?'自动轻量模式':'轻量模式';
    needsRender=true;
  };
  const changeGlow=()=>{reduced=false;slowFrames=0;configureGlow();};
  glow.addEventListener('change',changeGlow);configureGlow();
  const liveQuality=({detail})=>{liveInput=detail;if(glow.value==='auto')configureGlow();};
  window.addEventListener('kineglow:camera-layout',liveQuality);
  const render=()=>composer?composer.render():renderer.render(scene,camera);
  const flights=cometFlights(scene),engine=new StrokeEngine(flights.launch,flights.trace);
  const tools=installCanvasTools({engine,renderer,camera,controls,render,redraw:()=>{needsRender=true;}});
  let lastInkStats;
  const disconnectDrawing = connectLiveDrawing(window, scene, strokeStatus ? stats => {
    if(!lastInkStats || stats.active || lastInkStats.active ||
        stats.strokes!==lastInkStats.strokes || stats.segments!==lastInkStats.segments)needsRender=true;
    lastInkStats=stats;
    tools.refresh(stats);
    strokeStatus.textContent = `已结束 ${stats.strokes} 笔 / ${stats.paused ? '短暂停笔，等待续接' : stats.active ? '正在绘画' : '等待起笔'} / ${stats.segments} 管段 · 自动续接 ${stats.bridges} 次\n`
      + `收笔原因：深度中断 ${stats.ends.depth} / 丢手超时或远处重现 ${stats.ends.tracking} / 松手判定 ${stats.ends.release} / 大幅重定位 ${stats.ends.jump}`;
  } : null, getStrength,()=>{const effect=document.body.dataset.effect,accent=brushes[effect]?.accent;return {effect,color:accent||color,size:document.getElementById('brush-size').valueAsNumber*(accent ? .56 : 1),mineral:true};},engine);
  // Rendering on demand avoids redrawing identical frames every RAF while MediaPipe shares the GPU.
  const redraw = () => { needsRender = true; };
  controls.addEventListener('change', redraw);
  const front = document.getElementById('front-view');
  const resetView = () => controls.reset();
  front.disabled = false;
  front.addEventListener('click', resetView);
  let cursorExpiry;
  const receive = ({ detail }) => {
    if(document.body.dataset.effect==='solar')return;
    const { state, cursorSource, cursorAgeMs = 0 } = detail;
    const point = Object.hasOwn(detail, 'cursorPoint') ? detail.cursorPoint : detail.point;
    clearTimeout(cursorExpiry);
    if (cursorSource === 'held') cursorExpiry = setTimeout(() => {
      cursor.visible = false; needsRender = true;
    }, Math.max(0, 150-cursorAgeMs));
    // Repeated hidden-cursor results (no valid right hand) cannot change the cursor or any stroke:
    // an active stroke only ends on a result whose state differs from the previous Pinching one.
    if (point === null && !cursor.visible && state === lastState) return;
    if(point && cursorSource==='filtered' && !detail.breakStroke && !detail.releasePending)
      playback.push(point,performance.now(),state===lastState);
    else playback.reset();
    lastState = state;
    cursor.visible = point !== null;
    if (point) cursor.position.set(point.x, point.y, point.z);
    cursor.material.color.set(cursorSource === 'held' ? 0xffb347 : state === 'Pinching' ? 0x59e094 : state === 'Rearming' ? 0xffb347 : 0x35bfff);
    needsRender = true;
  };
  window.addEventListener('kineglow:interaction', receive);
  const clear = () => { clearTimeout(cursorExpiry); playback.reset();cursor.visible = false; lastState = null; needsRender = true; };
  window.addEventListener('kineglow:clear', clear);
  const resetEffect=()=>{flights.clear();clear();};
  window.addEventListener('kineglow:effect',resetEffect);
  document.getElementById('home').addEventListener('click',resetEffect);
  const snapshot=({detail})=>{
    render();
    renderer.domElement.toBlob(blob=>detail?.receive?.(blob),'image/png');
  };
  window.addEventListener('kineglow:snapshot',snapshot);
  let disposed = false, frames = 0, rafFrames = 0, last = performance.now(), start = last, maxGap = 0, total = 0, renderMs = 0;
  const resize = new ResizeObserver(() => {
    renderer.setSize(host.clientWidth, host.clientHeight);
    composer?.setSize(host.clientWidth,host.clientHeight);
    fitDrawingCamera(camera, host.clientWidth, host.clientHeight, PLANE);
    // setSize clears the drawing buffer, so the next RAF must redraw.
    needsRender = true;
  });
  resize.observe(host);
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    renderer.setAnimationLoop(null);
    status.textContent = 'WebGL 上下文丢失，请刷新';
  });
  let renderedLast=false;
  renderer.setAnimationLoop(now => {
    if(composer && glow.value==='auto' && renderedLast && document.visibilityState==='visible'){
      slowFrames=now-last>24?slowFrames+1:Math.max(0,slowFrames-1);
      if(slowFrames>=24){reduced=true;configureGlow();}
    }
    renderedLast=false;
    maxGap = Math.max(maxGap, now - last);
    last = now;
    rafFrames++;
    if(flights.update(now,renderer.domElement.height*camera.zoom/(camera.top-camera.bottom)))needsRender=true;
    const display=cursor.visible && playback.sample(now);
    if(display && !cursor.position.equals(display)) {
      cursor.position.set(display.x,display.y,display.z);needsRender=true;
    }
    if (needsRender) {
      needsRender = false;
      const begin = performance.now();
      render();renderedLast=true;
      renderMs += performance.now() - begin;
      frames++; total++;
    }
    if (now - start >= 1000) {
      const seconds = (now - start) / 1000;
      metrics.textContent = `渲染帧 ${total} / 按需渲染 ${(frames / seconds).toFixed(1)} / RAF ${(rafFrames / seconds).toFixed(1)} 次/秒 / render CPU ${frames ? (renderMs / frames).toFixed(2) : '--'} ms\n窗口最大 RAF 间隔 ${maxGap.toFixed(1)} ms / 几何 ${renderer.info.memory.geometries} / 纹理 ${renderer.info.memory.textures} / draw calls ${renderer.info.render.calls}`;
      start = now; frames = 0; rafFrames = 0; maxGap = 0; renderMs = 0;
    }
  });
  status.textContent = '正交视图 · 拖动只改变观察角度，保留笔迹的三维坐标';
  return () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(cursorExpiry);
    renderer.setAnimationLoop(null);
    resize.disconnect();
    window.removeEventListener('kineglow:camera-layout',liveQuality);
    window.removeEventListener('kineglow:interaction', receive);
    window.removeEventListener('kineglow:clear', clear);
    window.removeEventListener('kineglow:effect',resetEffect);
    document.getElementById('home').removeEventListener('click',resetEffect);flights.clear();
    window.removeEventListener('kineglow:snapshot',snapshot);
    front.removeEventListener('click', resetView);
    front.disabled = true;
    controls.removeEventListener('change', redraw);
    controls.dispose();
    tools.dispose();
    palette.replaceChildren();glow.removeEventListener('change',changeGlow);
    if(composer){for(const pass of composer.passes)pass.dispose();composer.dispose();}
    disconnectDrawing();
    scene.traverse(object => {
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material?.dispose());
    });
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
}
