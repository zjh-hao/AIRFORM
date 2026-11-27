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
import { DISPLAY_NAMES } from './glyph-3d.js';
import { descriptorFromModelResult } from './shape-3d.js';
import { projectStrokeForModel, recognizeSketchRemote } from './sketch-client.js';

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
  const palette=document.getElementById('brush-colors'), glow=document.getElementById('brush-glow'), shapeToggle=document.getElementById('shape-3d'), smartDrawToggle=document.getElementById('smart-draw');
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
  const flights=cometFlights(scene);
  let tools = null, shapeToastTimer = null, settleTimer = null, settleEpoch = 0, clearEpoch = 0;
  let lastInkStats = null, lastLiveStats = null;
  let recentUnmatched = [];
  const SKETCH_SETTLE_MS = 950;
  const MULTI_STROKE_WINDOW_MS = 4500;
  const cancelPendingSketch = (hard = false) => {
    clearTimeout(settleTimer);
    settleTimer = null;
    settleEpoch++;
    if (hard) clearEpoch++;
  };
  const updateStrokeReadout = (live = null) => {
    if (live) lastLiveStats = live;
    const base = lastLiveStats ?? { paused: false, bridges: 0, ends: { depth: 0, tracking: 0, release: 0, stopped: 0, jump: 0 } };
    const current = { ...engine.stats, ends: base.ends, paused: base.paused, bridges: base.bridges };
    if (!lastInkStats || current.active || lastInkStats.active ||
        current.strokes !== lastInkStats.strokes || current.segments !== lastInkStats.segments) {
      needsRender = true;
    }
    lastInkStats = current;
    if (tools) tools.refresh(current);
    if (strokeStatus) {
      strokeStatus.textContent = `已结束 ${current.strokes} 笔 / ${current.paused ? '短暂停笔，等待续接' : current.active ? '正在绘画' : '等待起笔'} / ${current.segments} 管段 · 自动续接 ${current.bridges} 次\n`
        + `收笔原因：深度中断 ${current.ends.depth} / 丢手超时或远处重现 ${current.ends.tracking} / 松手判定 ${current.ends.release} / 大幅重定位 ${current.ends.jump}`;
    }
  };
  const announceShape = descriptor => {
    updateStrokeReadout();
    needsRender = true;
    const label = descriptor?.displayName || DISPLAY_NAMES[descriptor?.type] || descriptor?.type;
    const badge = document.getElementById('clear-status');
    if (label && badge) {
      clearTimeout(shapeToastTimer);
      badge.textContent = `已识别：${label} → 3D ${label}`;
      shapeToastTimer = setTimeout(() => {
        if (badge.textContent.startsWith('已识别：')) badge.textContent = '';
      }, 2400);
    }
  };
  const computeBounds2d = pts => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { minX, maxX, minY, maxY };
  };
  const unionBounds2d = (a, b) => ({
    minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
  });
  const boxesNear = (a, b) => {
    const pad = Math.min(0.28, Math.max(0.14, Math.max(a.maxX - a.minX, a.maxY - a.minY, b.maxX - b.minX, b.maxY - b.minY) * 0.35));
    return a.minX <= b.maxX + pad && a.maxX >= b.minX - pad && a.minY <= b.maxY + pad && a.maxY >= b.minY - pad;
  };
  const runSketchRecognition = async (expectedSettle, expectedClear, style) => {
    if (disposed || engine.active || expectedSettle !== settleEpoch || expectedClear !== clearEpoch) return;
    const now = performance.now();
    recentUnmatched = recentUnmatched.filter(item => now - item.time <= MULTI_STROKE_WINDOW_MS && engine.hasStroke(item.id));
    if (!recentUnmatched.length) return;

    const latest = recentUnmatched[recentUnmatched.length - 1];
    const cluster = [latest];
    let clusterBounds = latest.bounds;
    for (let i = recentUnmatched.length - 2; i >= 0 && cluster.length < 12; i--) {
      const prev = recentUnmatched[i];
      if (latest.time - prev.time <= MULTI_STROKE_WINDOW_MS && boxesNear(clusterBounds, prev.bounds)) {
        cluster.unshift(prev);
        clusterBounds = unionBounds2d(clusterBounds, prev.bounds);
      }
    }

    const isClosed = items => {
      const first2d = items[0].points2d[0], last2d = items.at(-1).points2d.at(-1);
      const b = computeBounds2d(items.flatMap(item => item.points2d));
      const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
      return diag > 1e-4 && Math.hypot(first2d[0] - last2d[0], first2d[1] - last2d[1]) <= diag * 0.28;
    };

    const useCluster = cluster.length >= 2;
    const primaryItems = useCluster ? cluster : [latest];
    const remote = await recognizeSketchRemote({
      strokes: primaryItems.map(item => item.points2d),
      closedHint: isClosed(primaryItems),
      fallbackStrokes: useCluster ? [latest.points2d] : null,
      fallbackClosedHint: useCluster ? isClosed([latest]) : false,
    });
    if (disposed || expectedClear !== clearEpoch) return;
    const badge = document.getElementById('clear-status');
    if (!remote) {
      if (badge && badge.textContent.startsWith('等待补画')) badge.textContent = '';
      return;
    }
    const targetItems = useCluster && remote.usedFallback ? [latest] : primaryItems;
    const targetIds = targetItems.map(item => item.id);
    if (!targetIds.every(gid => engine.hasStroke(gid))) return;
    const descriptor = descriptorFromModelResult(remote, targetItems.map(item => item.points3d));
    if (!descriptor) return;
    if (engine.replaceStrokesWithShape(targetIds, descriptor, style)) {
      const used = new Set(targetIds);
      recentUnmatched = recentUnmatched.filter(item => !used.has(item.id));
    }
  };
  const handleUnmatchedShape = ({ id, samples, style }) => {
    if (disposed || !style?.shape3d) return;
    const points2d = projectStrokeForModel(samples, camera);
    if (points2d.length < 2) return;
    const now = performance.now();
    recentUnmatched = recentUnmatched.filter(item => now - item.time <= MULTI_STROKE_WINDOW_MS && engine.hasStroke(item.id));
    recentUnmatched.push({ id, points3d: samples, points2d, bounds: computeBounds2d(points2d), time: now });
    if (recentUnmatched.length > 12) recentUnmatched.shift();

    cancelPendingSketch(false);
    const expectedSettle = settleEpoch, expectedClear = clearEpoch;
    const badge = document.getElementById('clear-status');
    if (badge) {
      clearTimeout(shapeToastTimer);
      badge.textContent = '等待补画或识别中…（停顿约 1 秒自动识别）';
    }
    settleTimer = setTimeout(() => { void runSketchRecognition(expectedSettle, expectedClear, style); }, SKETCH_SETTLE_MS);
  };
  const engine=new StrokeEngine(flights.launch,flights.trace,announceShape,handleUnmatchedShape,() => cancelPendingSketch(false));
  tools=installCanvasTools({engine,renderer,camera,controls,render,redraw:()=>{needsRender=true;}});
  let grabbed = null, hovered = null;
  const grabOffset = new THREE.Vector3();
  const setShapeEmissive = (shapeObj, delta = 0) => {
    const targets = shapeObj?.userData?.highlightTargets;
    if (!Array.isArray(targets)) return;
    for (const target of targets) {
      if (!target?.material) continue;
      if (target.type === 'body') {
        target.material.emissiveIntensity = target.baseEmissive + delta;
        target.material.opacity = Math.min(0.82, target.baseOpacity + delta * 0.28);
      } else if (target.type === 'line') {
        target.material.opacity = Math.min(1, target.base + delta * 0.45);
      } else {
        target.material.emissiveIntensity = target.base + delta;
      }
    }
  };
  const releaseGrab = () => {
    if (grabbed) { setShapeEmissive(grabbed, 0); grabbed = null; needsRender = true; }
  };
  const clearHover = () => {
    if (hovered && hovered !== grabbed) setShapeEmissive(hovered, 0);
    hovered = null;
  };
  const findGrabbable = pt => {
    if (!pt || !engine.shapes.length) return null;
    let best = null, bestDist = Infinity;
    for (const mesh of engine.shapes) {
      const dx = mesh.position.x - pt.x, dy = mesh.position.y - pt.y, dz = mesh.position.z - pt.z;
      const reach = (mesh.userData?.hitRadius ?? .5) + .65;
      const d = Math.hypot(dx, dy, dz * .65);
      if (d <= reach && d < bestDist) { bestDist = d; best = mesh; }
    }
    return best;
  };
  const disconnectDrawing = connectLiveDrawing(window, scene, updateStrokeReadout, ()=>smartDrawToggle?.checked?Math.max(getStrength(),.78):getStrength(),()=>{const effect=document.body.dataset.effect,accent=brushes[effect]?.accent;return {effect,color:accent||color,size:document.getElementById('brush-size').valueAsNumber*(accent ? .56 : 1),mineral:true,shape3d:Boolean(shapeToggle?.checked),smartDraw:Boolean(smartDrawToggle?.checked)};},engine);
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
    if (grabbed && !grabbed.parent) grabbed = null;
    if (hovered && !hovered.parent) hovered = null;
    if (state === 'Grabbing') {
      clearHover();
      if (point) {
        if (!grabbed) {
          const target = findGrabbable(point);
          if (target) {
            grabbed = target;
            grabOffset.set(grabbed.position.x - point.x, grabbed.position.y - point.y, grabbed.position.z - point.z);
            setShapeEmissive(grabbed, .55);
          }
        }
        if (grabbed) {
          grabbed.position.set(point.x + grabOffset.x, point.y + grabOffset.y, point.z + grabOffset.z);
          needsRender = true;
        }
      }
    } else {
      releaseGrab();
      if (point && state === 'Idle') {
        const nextHover = findGrabbable(point);
        if (nextHover !== hovered) {
          clearHover();
          hovered = nextHover;
          if (hovered) setShapeEmissive(hovered, .25);
          needsRender = true;
        }
      } else if (hovered) {
        clearHover();
        needsRender = true;
      }
    }
    // Repeated hidden-cursor results (no valid right hand) cannot change the cursor or any stroke:
    // an active stroke only ends on a result whose state differs from the previous Pinching one.
    if (point === null && !cursor.visible && state === lastState) return;
    if(point && cursorSource==='filtered' && !detail.breakStroke && !detail.releasePending)
      playback.push(point,performance.now(),state===lastState);
    else playback.reset();
    lastState = state;
    cursor.visible = point !== null;
    if (point) cursor.position.set(point.x, point.y, point.z);
    cursor.material.color.set(cursorSource === 'held' ? 0xffb347 : state === 'Grabbing' ? 0xd8fa43 : state === 'Pinching' ? 0x59e094 : state === 'Rearming' ? 0xffb347 : 0x35bfff);
    needsRender = true;
  };
  window.addEventListener('kineglow:interaction', receive);
  const clear = () => { cancelPendingSketch(true); recentUnmatched = []; releaseGrab(); clearHover(); clearTimeout(cursorExpiry); playback.reset();cursor.visible = false; lastState = null; needsRender = true; };
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
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    cancelPendingSketch(true);
    recentUnmatched = [];
    clearTimeout(shapeToastTimer);
    releaseGrab();
    clearHover();
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
  cleanup.hasShapes = () => engine.shapes.length > 0;
  cleanup.grabbedType = () => grabbed?.userData?.shapeType ?? null;
  cleanup.grabbedLabel = () => grabbed?.userData?.displayName ?? null;
  return cleanup;
}
