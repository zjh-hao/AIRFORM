import { HandLandmarker } from '@mediapipe/tasks-vision';
import { drawHands } from './overlay.js';
import { CameraSession } from './camera.js';
import { createScene } from './scene.js';
import { DetectorWorker } from './detector.js';
import { assetUrl } from './local-assets.js';
import { connectInteraction } from './interaction.js';
import { AstraSession } from './astra-session.js';
import { DepthProjector } from './depth-point.js';
import { HAND_FUSION } from './hand-pose-fusion.js';
import { DrawingPlane, DRAWING_GAIN, imageDrawingFrame } from './drawing-gain.js';
import { installValidationPanel } from './validation-panel.js';
import { installConsole } from './workstation.js';
installConsole();
const $ = selector => document.querySelector(selector);
const video = $('video'), canvas = $('#camera'), context = canvas.getContext('2d');
const skeleton = $('#skeleton'), bones = skeleton.getContext('2d');
function sizeCamera(width,height){
  if(canvas.width===width && canvas.height===height)return;
  canvas.width=skeleton.width=width;canvas.height=skeleton.height=height;
  canvas.closest('.camera-slot').style.setProperty('--camera-aspect',String(width/height));
}
function clearSkeleton() {
  bones.clearRect(0, 0, skeleton.width, skeleton.height);
}
const status = $('#status'), start = $('#start'), stop = $('#stop'), fixture = $('#fixture');
const input = $('#input-source'), depthCanvas = $('#depth'), depthContext = depthCanvas.getContext('2d');
const clearCanvas = $('#clear-canvas');
const smoothing = $('#smoothing');
let inkStrength;
function updateStrength() {
  inkStrength = smoothing.valueAsNumber / 100;
  $('#smoothing-value').value = smoothing.value + '%';
}
smoothing.addEventListener('input', updateStrength);
updateStrength();
input.value = new URLSearchParams(location.search).get('input') === 'astra' ? 'astra' : 'webcam';
function activeSession() { return input.value === 'astra' ? astraSession : session; }
let detector, detectorLoading, browserBackend = '', busy = false, disposed = false, frames = 0, handsFrames = 0, lastTimestamp = -1;
let inferenceTotal = 0, inferenceMax = 0, received = 0, cleanupScene;
let cameraRequest = 0, starting = false;
let validation;
let firstSampleAt, lastDepthPreviewAt = -Infinity;
let lastDiagnosticAt = -Infinity, diagnosticDue = true, lastArrival;
const frameGaps = [];
function cameraLayout(active) {
  const changed = $('.stage').classList.contains('camera-live') !== active;
  $('.stage').classList.toggle('camera-live', active);
  $('.stage').classList.toggle('live-webcam',active && input.value==='webcam');
  if(changed)window.dispatchEvent(new CustomEvent('kineglow:camera-layout',{detail:active}));
  $('#preview').open = active;
  if (active) $('#landing').hidden = true;
}
let pipelineTotal = 0, pipelineMax = 0, delegate = '';
function controls() {
  const astra = input.value === 'astra';
  start.disabled = disposed || busy || activeSession().running || (astra ? location.protocol === 'file:' : !delegate);
  fixture.disabled = disposed || busy || activeSession().running;
  stop.disabled = disposed || (!starting && !activeSession().running);
  input.disabled = busy || starting || session.running || astraSession.running;
  $('#mouse-mode').disabled=input.disabled || !cleanupScene;
  start.textContent=starting?'正在连接…':activeSession().running?'设备已连接':!astra&&!delegate?'加载模型…':'启动摄像头';
}
function publish(result, timestamp, source) {
  window.dispatchEvent(new CustomEvent('kineglow:hands', { detail: { ...result, timestamp, source } }));
}
function receive({ detail }) {
  received++;
  if (detail.source === '摄像头' && !diagnosticDue) return;
  $('#received').textContent = `收到事件 ${received} / source ${detail.source}\n最新 timestamp ${detail.timestamp.toFixed(1)} ms / 手数 ${detail.landmarks.length}\n`
    + detail.landmarks.map((points, index) => {
      const tip = points[8];
      return `${detail.handedness[index]?.[0]?.categoryName}: ${points.length} 点 / 食指 x=${tip.x.toFixed(4)} y=${tip.y.toFixed(4)} z=${tip.z.toFixed(4)}`;
    }).join('\n');
}
window.addEventListener('kineglow:hands', receive);
const depthProjector = new DepthProjector();
const planeProjector = new DrawingPlane();
let webcamDrawingFrame;
let projectionFrames = 0, projectionTotal = 0, projectionMax = 0;
const projectPoint = (tip, frame, hand, timestamp) => {
  if (input.value !== 'astra') {
    if(webcamDrawingFrame?.width!==canvas.width||webcamDrawingFrame?.height!==canvas.height) {
      webcamDrawingFrame=imageDrawingFrame(canvas.width,canvas.height);
    }
    return planeProjector.project(tip,webcamDrawingFrame,hand,timestamp);
  }
  const started = performance.now();
  const point = depthProjector.project(tip, frame, hand, timestamp);
  const elapsed = performance.now() - started;
  projectionFrames++; projectionTotal += elapsed; projectionMax = Math.max(projectionMax, elapsed);
  if (diagnosticDue) $('#fusion-metrics').textContent = `轻量融合与滤波：本帧 ${elapsed.toFixed(2)} / 平均 ${(projectionTotal / projectionFrames).toFixed(2)} / 最大 ${projectionMax.toFixed(2)} ms · 复用现有手部模型`;
  return point;
};
projectPoint.reset = () => { depthProjector.reset(); planeProjector.reset(); };
projectPoint.suspend = timestamp => input.value==='astra' ? depthProjector.suspend(timestamp) : planeProjector.suspend(timestamp);
projectPoint.motionStatus = () => input.value === 'astra' ? depthProjector.sample.motion : planeProjector.filter.status;
projectPoint.cursorPoint = () => input.value === 'astra' ? depthProjector.cursorPoint : planeProjector.cursorPoint;
const gestureMode = new URLSearchParams(location.search).get('tracking') === 'legacy' ? 'legacy' : 'world';
const runningMode = new URLSearchParams(location.search).get('inference') === 'image' ? 'IMAGE' : 'VIDEO';
const astraDelegate = new URLSearchParams(location.search).get('delegate') === 'CPU' ? 'CPU' : 'GPU';
let astraBackend = astraDelegate === 'GPU' ? 'Python GPU · DirectML' : 'Python CPU';
const astraMode = runningMode === 'IMAGE' ? 'IMAGE 逐帧图片识别' : 'VIDEO 视频跟踪';
const disconnectInteraction = connectInteraction(window, () => ({ width: canvas.width, height: canvas.height }), projectPoint, { gestureMode });
function depthSampleText(sample) {
  const mm = (sample.z * 1000).toFixed(0);
  switch (sample.source) {
    case 'tip-measured': return `指尖邻域实测：${mm} mm`;
    case 'hand-estimated': return `手部深度辅助估计：${mm} mm（${sample.anchors} 个当前深度锚点）`;
    case 'kinematic-predicted': return `骨架约束预测：${mm} mm · ${sample.bones} 条掌骨支持 · ${sample.ageMs.toFixed(0)} / ${HAND_FUSION.predictionMs} ms（非深度实测）`;
    case 'depth-plane': return `深度暂缺，沿上一深度平面继续绘画 · ${sample.ageMs.toFixed(0)} ms（非新测量）`;
    default: return sample.reason;
  }
}
function drawingPrompt({ source, state, point, tracking, canResume }) {
  if (source === 'stopped') return '已停止。点击“启动摄像头”后，先张开右手解锁。';
  if (state === 'TrackingLost') return canResume
    ? '绘画暂时中断：将右手放回画面并保持捏合，识别稳定后自动续画。'
    : '尚未确认右手：请将右手完整放入画面，张开保持片刻。';
  if (state === 'Rearming') return '等待解锁：请先张开右手，再捏合拇指与食指。';
  if (tracking === 'boundary-paused') return '手部边缘短时失追：暂停落笔，回到刚才位置可续画；持续失追将收笔。';
  if (tracking === 'pinch-paused') return '短暂漏检：暂停落笔，保持捏合即可继续。';
  if (tracking === 'foreshortened') return '手指朝向镜头：使用三维手势判断；捏合绘画，松开收笔。';
  if (state === 'Pinching') {
    if (input.value === 'astra' && depthProjector.sample.source === 'depth-plane') return '正在连续绘画：深度暂缺，沿上一深度平面继续；保持捏合即可。';
    if (!point) return '捏合已识别，但整只手没有可靠深度；已暂停绘画，深度恢复后继续。';
    if (input.value === 'astra' && depthProjector.sample.source === 'kinematic-predicted') {
      return '正在绘画：深度暂缺，使用短时骨架辅助预测。松开两指结束这一笔。';
    }
    return tracking === 'partial-hand' ? '正在绘画：使用可见手指；其他部位出画不强制收笔。'
      : '捏合已识别，正在绘画。松开两指结束这一笔。';
  }
  if (canResume) return '右手已恢复：保持捏合片刻即可续画，无需重新张开。';
  return point ? '已就绪：捏合拇指与食指并移动，即可绘画。' : '右手已就绪，等待可靠的手部深度。';
}
function showInteraction({ detail }) {
  if(document.body.dataset.effect==='solar')return;
  const { state, point, ratio, handIndex, timestamp, source } = detail;
  const prompt = $('#drawing-status');
  if (input.value === 'astra' && (diagnosticDue || source !== '摄像头')) {
    $('#depth-point-status').textContent = handIndex === null ? '等待有效右手' : depthSampleText(depthProjector.sample);
  }
  prompt.dataset.state = source==='stopped'?'stopped':state==='TrackingLost'||detail.cursorSource==='held'?'lost':
    point && state==='Pinching' && !detail.releasePending?'drawing':state==='Idle'?'ready':'waiting';
  const instruction=drawingPrompt(detail);
  if(prompt.textContent!==instruction)prompt.textContent=instruction;
  if (source === '摄像头' && !diagnosticDue) return;
  $('#interaction').textContent = `${state} / source ${source} / timestamp ${timestamp.toFixed(1)} ms\n`
    + `右手索引 ${handIndex ?? '--'} / pinch ratio ${ratio?.toFixed(3) ?? '--'}\n`
    + `手势 ${detail.gestureBasis ?? gestureMode} / 姿态 ${detail.pose ?? '--'} / 光标 ${detail.cursorSource ?? '--'}${detail.labelHeld ? ' / 短时保持手身份' : ''}\n`
    + (point ? `场景坐标 x=${point.x.toFixed(3)} y=${point.y.toFixed(3)} z=${point.z.toFixed(3)}\n` : '无有效右手或深度，光标隐藏\n')
    + '青色 Idle / 绿色 Pinching / 橙色 Rearming（启动/清除后先张开；绘画中断后保持捏合可恢复）';
}
window.addEventListener('kineglow:interaction', showInteraction);
function clearDrawing() {
  window.dispatchEvent(new CustomEvent('kineglow:clear'));
  $('#clear-status').textContent = '画布已清除';
  $('#drawing-status').textContent = '画布已清除。摄像头保持运行，请先张开右手再重新绘画。';
  $('#drawing-status').dataset.state = 'waiting';
  $('#interaction').textContent = 'TrackingLost · 画布已清除，等待张开右手重新解锁';
  $('#depth-point-status').textContent = '画布已清除，等待重新解锁';
}
const confirmClear=()=>{
  if(!$('#undo').disabled || !$('#redo').disabled){
    if(!window.confirm('清除全部笔迹和撤销历史？此操作不能撤销。'))return;
  }
  clearDrawing();
};
clearCanvas.addEventListener('click', confirmClear);
async function detect(source, current = () => !disposed, label = '摄像头', depthFrame = null) {
  const timestamp = Math.max(performance.now(), lastTimestamp + 1);
  lastTimestamp = timestamp;
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  if (!current()) { bitmap.close(); return; }
  sizeCamera(bitmap.width,bitmap.height);
  if (!frames) context.drawImage(bitmap, 0, 0);
  const tracking = depthFrame?.tracking;
  if (depthFrame && !tracking) throw new Error('当前 Astra 服务没有 Python 识别结果');
  const response = tracking ? { result: tracking, elapsed: tracking.inferenceMs, bitmap }
    : await detector.request({ type: 'detect', bitmap, timestamp, live: label === '摄像头', firstFrame: frames === 0 }, [bitmap]);
  try {
    if (!current()) return;
    const { elapsed } = response;
    const { landmarks, worldLandmarks, handedness } = response.result;
    const result = { landmarks, worldLandmarks, handedness };
    if (tracking && (frames === 0 || astraBackend !== depthFrame.tracking_backend)) {
      astraBackend = depthFrame.tracking_backend;
      $('#backend').textContent = `${astraBackend} · ${astraMode}`;
    }
    if(response.recoveryError && input.value === 'webcam') $('#backend').textContent = delegate + ' Worker · CPU 复核不可用，继续主识别';
    context.drawImage(response.bitmap, 0, 0);
    frames++; handsFrames += Number(result.landmarks.length > 0);
    inferenceTotal += elapsed; inferenceMax = Math.max(inferenceMax, elapsed);
    clearSkeleton();
    if (!skeleton.hidden && result.landmarks.length) {
      drawHands(bones, result.landmarks, HandLandmarker.HAND_CONNECTIONS, canvas.width, canvas.height);
    }
    if (depthFrame) drawDepth(depthFrame);
    const message = `${label}：${result.landmarks.length ? '检测到手' : '无手'}（${result.landmarks.length}）`;
    if(status.textContent!==message)status.textContent=message;
    const arrival = performance.now(), pipeline = arrival - timestamp;
    if (lastArrival !== undefined) {
      frameGaps.push(arrival-lastArrival);
      if (frameGaps.length>90) frameGaps.shift();
    }
    lastArrival=arrival;
    diagnosticDue = arrival-lastDiagnosticAt>=250 || label!=='摄像头';
    pipelineTotal += pipeline; pipelineMax = Math.max(pipelineMax, pipeline);
    firstSampleAt ??= timestamp;
    if (diagnosticDue) {
      lastDiagnosticAt = arrival;
      const hz = frames > 1 ? ((frames-1)*1000/(timestamp-firstSampleAt)).toFixed(1) : '--';
      const gap95=[...frameGaps].sort((left,right)=>left-right)[Math.ceil(frameGaps.length*.95)-1];
      const stage = tracking ? `${astraBackend} / 本帧预处理 ${tracking.preprocessMs.toFixed(1)} ms / 浏览器接收后至骨架 ${pipeline.toFixed(1)} ms`
        : `${delegate} Worker / 采样至叠加 本帧 ${pipeline.toFixed(1)} / 平均 ${(pipelineTotal / frames).toFixed(1)} / 最大 ${pipelineMax.toFixed(1)} ms`;
      $('#tracking').textContent = `推理帧 ${frames} / 有手帧 ${handsFrames} / 有效采样 ${hz} Hz\n推理 本帧 ${elapsed.toFixed(1)} / 平均 ${(inferenceTotal / frames).toFixed(1)} / 最大 ${inferenceMax.toFixed(1)} ms\n${stage}（非端到端延迟）\n最近输出间隔 P95 ${gap95?.toFixed(1) ?? '--'} ms（含取帧、推理与调度）`;
      if(response.recovered) $('#tracking').append(' · 本帧骨架来自 CPU 复核');
    }
    const detail={...result,depthFrame,timestamp,source:label};
    publish(detail, timestamp, label);
    await validation?.record(detail,{inferenceMs:elapsed,...(tracking ? {} : {sampleToOverlayMs:pipeline})});
    return result;
  } finally { response.bitmap.close(); }
}
const session = new CameraSession({ video,
  acquire: () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('需要 localhost / HTTPS 摄像头 API');
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' } });
  },
  detect,
  stopped,
});
const astraSession = new AstraSession({ detect, stopped, inference: runningMode, delegate: astraDelegate });
function stopped(message) {
  cameraLayout(false);
  void validation?.stopRecording();
  clearSkeleton();
  context.clearRect(0, 0, canvas.width, canvas.height);
  depthContext.clearRect(0, 0, depthCanvas.width, depthCanvas.height);
  $('#depth-point-status').textContent = '等待有效右手与指尖深度';
  publish({ landmarks: [], worldLandmarks: [], handedness: [] }, performance.now(), 'stopped');
  status.textContent = message;
  controls();
}
function drawDepth(frame) {
  const now = performance.now();
  if (!$('#drawer').open || !depthCanvas.closest('details').open || now-lastDepthPreviewAt < 200) return;
  lastDepthPreviewAt = now;
  const image = depthContext.createImageData(frame.width, frame.height);
  let valid = 0;
  for (let i = 0; i < frame.depth.length; i++) {
    const z = frame.depth[i], offset = i * 4;
    image.data[offset + 3] = 255;
    if (!z) continue;
    valid++;
    const t = Math.max(0, Math.min(1, (z - 200) / 1800));
    image.data[offset] = 255 * (1 - t);
    image.data[offset + 1] = 150 * (1 - Math.abs(2 * t - 1));
    image.data[offset + 2] = 255 * t;
  }
  depthContext.putImageData(image, 0, 0);
  $('#depth-status').textContent = `Astra 深度帧 ${frame.depth_index} · 有效像素 ${valid} · 毫米深度 · 主机配对间隔 ${frame.host_pair_gap_ms.toFixed(1)} ms（非硬件同步）`;
}
function describeInput() {
  const astra = input.value === 'astra';
  document.title = astra ? `AIRFORM · Astra Python ${astraDelegate}` : 'AIRFORM · 虚拟特效工坊';
  $('#preview .pane-title').textContent = `01　/　实景追踪 · ${astra?'Astra RGB-D · Python':'普通摄像头'}`;
  $('#backend').textContent = astra ? `${astraBackend} · ${astraMode}（启动后确认）`
    : browserBackend || '正在加载浏览器模型…';
  const switchLink = $('#inference-switch');
  const target = new URL(location.href);
  target.searchParams.set('inference', runningMode === 'IMAGE' ? 'video' : 'image');
  target.searchParams.set('input', input.value);
  switchLink.href = target.href;
  switchLink.textContent = runningMode === 'IMAGE' ? '切回连续视频跟踪' : '对照：切换到逐帧图片识别';
  for(const link of document.querySelectorAll('#validation-panel a[data-tracking]')) {
    const params=new URLSearchParams(location.search);params.set('input',input.value);params.set('tracking',link.dataset.tracking);
    link.href=`?${params}`;
  }
  $('#depth-preview').hidden = !astra;
  const solar = document.body.dataset.effect === 'solar';
  $('#input-description').textContent = solar
    ? (astra ? '掌上全息优先使用 Astra 掌部深度调整素材大小。' : '掌上全息按画面中的手掌大小估算距离。')
    : astra
    ? `Astra RGB-D · 固定绘画倍率 ${DRAWING_GAIN.multiplier.toFixed(2)}× · XY 按手掌尺度归一化，深度只控制 Z`
    : `普通摄像头 · 固定绘画倍率 ${DRAWING_GAIN.multiplier.toFixed(2)}× · 按手掌尺度归一化的平面绘画`;
}
input.addEventListener('change', () => {
  describeInput(); stopped('输入已切换，请启动摄像头并先张开右手');
  if (input.value === 'webcam') void prepareBrowserInput();
});
describeInput();
window.addEventListener('kineglow:effect', describeInput);
function resetMetrics() {
  firstSampleAt = undefined;
  lastArrival = undefined; frameGaps.length = 0; lastDiagnosticAt = -Infinity; diagnosticDue = true;
  lastDepthPreviewAt = -Infinity;
  frames = handsFrames = inferenceTotal = inferenceMax = pipelineTotal = pipelineMax = 0;
  projectionFrames = projectionTotal = projectionMax = 0;
  $('#fusion-metrics').textContent = '等待融合计算 · 复用现有手部模型';
}
start.addEventListener('click', async () => {
  const request = ++cameraRequest;
  cameraLayout(true);
  $('#drawing-status').textContent = document.body.dataset.effect==='solar'?'正在连接摄像头；画面就绪后请平摊任意一只手。':'正在连接摄像头；画面就绪后请张开右手。';
  $('#drawing-status').dataset.state = 'waiting';
  busy = starting = true; resetMetrics(); controls();
  clearSkeleton();
  context.clearRect(0, 0, canvas.width, canvas.height);
  status.textContent = input.value === 'astra' ? '正在连接 Astra 彩色与深度流…' : '等待摄像头权限与实时帧…';
  await Promise.allSettled([session.inflight, astraSession.inflight]);
  if (request !== cameraRequest || disposed) return;
  await activeSession().start();
  if (request === cameraRequest) { busy = starting = false; controls(); }
});
stop.addEventListener('click', async () => {
  validation?.stopReplay();
  ++cameraRequest;
  starting = false; busy = true;
  try { await activeSession().stop(); }
  finally { busy = false; controls(); }
});
$('#home').addEventListener('click',async()=>{
  const home=$('#home'),request=++cameraRequest;
  const stopInput=starting || activeSession().running;
  home.disabled=true;starting=false;busy=true;controls();
  try{
    await Promise.all([validation?.stopReplay(),stopInput?activeSession().stop():null]);
    if(disposed || request!==cameraRequest)return;
    $('#front-view').click();
    $('#drawer').close();$('#guide').hidden=true;$('#guide-toggle').setAttribute('aria-expanded','false');
    $('#preview').open=false;$('#validation-panel').open=false;
    if(location.hash==='#validation-panel')history.replaceState(null,'',location.pathname+location.search);
    $('#landing').hidden=false;
    $('#drawing-status').textContent='选择创作模式后，启动摄像头。';
    $('#drawing-status').dataset.state='waiting';
  }finally{
    home.disabled=false;
    if(request===cameraRequest && !disposed){busy=false;controls();home.focus();}
  }
});
fixture.addEventListener('click', async () => {
  busy = true; controls();
  try {
    const image = new Image();
    image.src = assetUrl('/assets/woman_hands.jpg');
    await image.decode();
    await loadBrowserDetector();
    await Promise.allSettled([session.inflight, astraSession.inflight]);
    if (disposed) return;
    resetMetrics();
    const result = await detect(image, () => !disposed, '官方图片（非真人）');
    if (disposed) return;
    if (result.landmarks.length !== 2 || result.landmarks.some(hand => hand.length !== 21 || hand.some(p => ![p.x, p.y, p.z].every(Number.isFinite)))) throw new Error('预期双手各 21 个有限坐标');
    status.textContent = '官方图片通过：双手各 21 点（不代表真人集成通过）';
  } catch (error) { status.textContent = `图片自检失败：${error.message}`; }
  finally { busy = false; controls(); }
});
window.addEventListener('pagehide', () => {
  disposed = true;
  validation?.dispose();
  session.stop('页面已退出');
  astraSession.stop('页面已退出');
  detector?.close(); detector = null;
  cleanupScene?.();
  window.removeEventListener('kineglow:hands', receive);
  disconnectInteraction();
  clearCanvas.removeEventListener('click', confirmClear);
  window.removeEventListener('kineglow:interaction', showInteraction);
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
validation=installValidationPanel({
  getMetadata:()=>({width:canvas.width,height:canvas.height,input:input.value,
    delegate:input.value === 'astra' ? astraBackend : delegate,runningMode}),
  isRunning:()=>activeSession().running,
  async onReplayStart(data) {
    ++cameraRequest;starting=false;busy=true;controls();
    await Promise.allSettled([session.stop('正在切换到本地回放'),astraSession.stop('正在切换到本地回放')]);
    await Promise.allSettled([session.inflight,astraSession.inflight]);
    busy=true;input.value=data.metadata.input;describeInput();clearDrawing();
    $('#landing').hidden=true;
    sizeCamera(data.metadata.width,data.metadata.height);
    context.clearRect(0,0,canvas.width,canvas.height);clearSkeleton();controls();
    status.textContent='本地观测回放 · 非实时摄像头';
  },
  onReplayFrame(detail) {
    if(disposed)return;
    clearSkeleton();drawHands(bones,detail.landmarks,HandLandmarker.HAND_CONNECTIONS,canvas.width,canvas.height);
    if(detail.depthFrame)drawDepth(detail.depthFrame);
    publish(detail,detail.timestamp,detail.source);
  },
  onReplayEnd() {busy=false;if(!disposed)stopped('本地回放已结束；可重新启动摄像头');},
});
try {
  cleanupScene = createScene($('#scene'), $('#scene-status'), $('#render-metrics'), $('#stroke-status'), () => inkStrength);
  clearCanvas.disabled = false;
  $('#mouse-mode').disabled=false;
}
catch (error) { $('#scene-status').textContent = `场景初始化失败：${error.message}`; console.error(error); }
function loadBrowserDetector() {
  if (!detectorLoading) {
    detector = new DetectorWorker(new Worker(assetUrl('/tracking-worker.js')));
    detectorLoading = detector.request({ type: 'init', runningMode, sensitive: runningMode === 'VIDEO',
      delegate: new URLSearchParams(location.search).get('delegate') === 'CPU' ? 'CPU' : 'GPU' }).then(loaded => {
      delegate = loaded.delegate;
      browserBackend = `${delegate} Worker · ${loaded.runningMode === 'IMAGE' ? 'IMAGE 逐帧图片识别' : 'VIDEO 视频跟踪'} · 单帧在途${loaded.fallback ? '（GPU 初始化失败，已回退 CPU）' : ''}`;
      if (loaded.recoveryReady) browserBackend += ' · 连续漏检时 CPU 复核';
      else if (loaded.recoveryError) browserBackend += ' · CPU 复核不可用';
    }).catch(error => {
      detector?.close(); detector = null; detectorLoading = null;
      throw error;
    });
  }
  return detectorLoading;
}
async function prepareBrowserInput() {
  status.textContent = '正在加载本地模型…';
  try {
    await loadBrowserDetector();
    if (!disposed && input.value === 'webcam') {
      $('#backend').textContent = browserBackend;
      status.textContent = '本地模型已就绪'; controls();
    }
  } catch (error) {
    if (!disposed && input.value === 'webcam') status.textContent = `模型加载失败：${error.message}`;
  }
}
controls();
if (input.value === 'webcam') void prepareBrowserInput();
else status.textContent = '点击启动摄像头，连接 Astra 并加载 Python 模型';
