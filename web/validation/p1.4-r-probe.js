// Opt-in diagnostic only. No raw points/images retained; reload removes this module.
export async function install(sharedModule, mode) {
  if (window.P14R) throw new Error('Reload before installing another probe');
  const exports = await import(sharedModule);
  const Engine = Object.values(exports).find(v => v?.prototype?.beginStroke);
  if (!Engine) throw new Error('Production StrokeEngine export not found');
  const records = [], raf = [], longTasks = [], render = [], transitions = [], probeErrors = [];
  const restorers = [], accepted = new WeakMap();
  let row, previous, lastPoint, lastState, animation, firstArrival, timer;
  let finished = false, hidden = document.hidden, latestEngine;
  const phases = [[0, 'warmup', '预热：右手张开，等待倒计时'],
    [3000, 'normal', '正常速度：右手捏合画往返线，尽量保持捏合'],
    [11000, 'fast', '快速移动：保持右手捏合，快速左右往返（留在画面内）'],
    [19000, 'out', '保持捏合，把右手移出画面'],
    [22000, 'return-closed', '保持捏合，右手重新入画；先不要张开'],
    [25000, 'open', '张开右手，等待橙色恢复'],
    [28000, 'repinch', '再次捏合，正常速度画线']];
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#111;color:#fff;padding:12px;text-align:center;font-size:21px;pointer-events:none';
  panel.textContent = `${mode} 诊断准备就绪；等待摄像头首个结果`;
  document.body.append(panel);
  function phase(now) {
    const elapsed = now - firstArrival;
    return phases.findLast(p => elapsed >= p[0]) || phases[0];
  }
  const distance = (a, b) => a && b ? Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z) : null;
  const finitePoint = p => !!p && ['x','y','z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 10000);
  function hands({ detail: d }) {
    if (finished || d.source !== '摄像头') return;
    const now = performance.now();
    if (firstArrival === undefined) { firstArrival = now; timer = setTimeout(stop, 30000); }
    const labels = (d.handedness || []).map(a => a?.[0]?.categoryName ?? 'missing');
    const rights = labels.flatMap((s,i) => s === 'Right' ? [i] : []);
    const points = rights.length === 1 ? d.landmarks?.[rights[0]] : null;
    const xyValid = [0,4,8,9].every(i => Number.isFinite(points?.[i]?.x) && Number.isFinite(points?.[i]?.y));
    const canvas = document.querySelector('#camera');
    const dist = (a,b) => Math.hypot((points[a].x-points[b].x)*canvas.width, (points[a].y-points[b].y)*canvas.height);
    const palm = xyValid ? dist(0,9) : null;
    const ratio = xyValid && palm > 1e-6 ? dist(4,8)/palm : null;
    const measured = document.querySelector('#tracking').textContent.match(/本帧 ([\d.]+)/);
    row = { timestamp: d.timestamp, arrival: now, phase: phase(now)[1],
      sampleGap: previous ? d.timestamp-previous.timestamp : null,
      arrivalGap: previous ? now-previous.arrival : null, sampleToHands: now-d.timestamp,
      inferenceDisplayMs: measured ? Number(measured[1]) : null,
      handCount: d.landmarks.length, rightCount: rights.length,
      leftCount: labels.filter(s=>s==='Left').length, missingLabels: labels.filter(s=>s==='missing').length,
      selectedIndex: rights.length === 1 ? rights[0] : null,
      requiredXYValid: xyValid, all21XYZValid: points?.length === 21 && points.every(p=>['x','y','z'].every(k=>Number.isFinite(p[k]))),
      palmPixels: palm, rawRatio: Number.isFinite(ratio) ? ratio : null,
      ratioDelta: Number.isFinite(ratio) && previous?.rawRatio != null ? ratio-previous.rawRatio : null,
      calls: [] };
    records.push(row); previous = row;
  }
  function interaction({detail:d}) {
    if (!row || row.timestamp !== d.timestamp) return;
    row.state = d.state; row.pointValid = finitePoint(d.point);
    row.mappedDistance = distance(lastPoint, d.point);
    row.publishedRatio = d.ratio;
    row.fromState = lastState ?? null;
    if (d.state !== lastState) transitions.push({ timestamp:d.timestamp, arrival:performance.now(), from:lastState??null, to:d.state, phase:row.phase });
    lastState = d.state; lastPoint = d.point ? {...d.point} : null;
  }
  // The production hands listener dispatches interaction synchronously. Intercept
  // dispatch entry so late listener registration cannot shift evidence by a frame.
  const dispatch = window.dispatchEvent;
  const ownDispatch = Object.getOwnPropertyDescriptor(window, 'dispatchEvent');
  window.dispatchEvent = function(event) {
    try {
      if (event.type === 'kineglow:hands') hands(event);
      if (event.type === 'kineglow:interaction') interaction(event);
    } catch(error) { probeErrors.push(String(error)); }
    return dispatch.call(this,event);
  };
  restorers.push(()=>{
    if(ownDispatch) Object.defineProperty(window,'dispatchEvent',ownDispatch);
    else delete window.dispatchEvent;
  });
  for (const name of ['beginStroke','appendPoint','endStroke']) {
    const original = Engine.prototype[name];
    Engine.prototype[name] = function(...args) {
      latestEngine = this;
      const activeBefore = this.active, before = this.stats;
      const started = performance.now();
      let result, error;
      try { result = original.apply(this,args); return result; }
      catch(e) { error = String(e); throw e; }
      finally {
        const elapsed = performance.now()-started;
        const after = this.stats;
        const call = { name, elapsed, activeBefore, activeAfter:this.active,
          result:result ?? null, segmentsDelta:after.segments-before.segments,
          chunksDelta:after.chunks-before.chunks, strokesDelta:after.strokes-before.strokes, error:error??null };
        if (name === 'appendPoint' && result === true) call.acceptedDistance = distance(accepted.get(this),args[0]);
        if (name === 'beginStroke' || (name === 'appendPoint' && result === true)) accepted.set(this,{...args[0]});
        if (name === 'endStroke') accepted.delete(this);
        if (row && !finished) row.calls.push(call);
      }
    };
    restorers.push(()=> { Engine.prototype[name] = original; });
  }
  let lastRAF;
  function frame(t) {
    if (lastRAF !== undefined) raf.push({time:t,gap:t-lastRAF});
    lastRAF=t;
    if (firstArrival !== undefined) {
      const p=phase(performance.now());
      panel.textContent = `${mode} · ${p[2]} · 本轮剩余 ${Math.max(0,Math.ceil((30000-performance.now()+firstArrival)/1000))} 秒`;
    }
    animation = requestAnimationFrame(frame);
  }
  animation=requestAnimationFrame(frame);
  const observer = new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) observer.observe({type:'longtask'});
  const visibility=()=>{hidden ||= document.hidden;};
  document.addEventListener('visibilitychange',visibility);
  function stop() {
    if (finished) return window.P14R.result;
    finished=true; clearTimeout(timer); cancelAnimationFrame(animation);
    observer.takeRecords().forEach(e=>longTasks.push({start:e.startTime,duration:e.duration})); observer.disconnect();
    document.removeEventListener('visibilitychange',visibility);
    restorers.reverse().forEach(f=>f());
    const video=document.querySelector('video');
    const settings=video.srcObject?.getVideoTracks()[0]?.getSettings()??{};
    window.P14R.result={mode,plannedDurationMs:30000,firstArrival,finishedAt:performance.now(),hidden,
      viewport:[innerWidth,innerHeight,devicePixelRatio],video:[video.videoWidth,video.videoHeight],
      trackSettings:Object.fromEntries(['width','height','frameRate','aspectRatio','facingMode','exposureMode','exposureTime','resizeMode'].filter(k=>k in settings).map(k=>[k,settings[k]])), userAgent:navigator.userAgent,
      phases,records,transitions,raf,longTasks,render,probeErrors,engine:latestEngine?.stats??null,
      renderDisplay:document.querySelector('#render-metrics').textContent, restored:true};
    panel.textContent=`${mode} 本轮完成，请把手放下`;
    return window.P14R.result;
  }
  window.P14R={stop,result:null,Engine,
    rendererConstructor:Object.values(exports).find(v=>typeof v==='function' && String(v).includes('this.isWebGLRenderer')),
    attachRenderer(renderer) {
      const original=renderer.render;
      let last;
      renderer.render=function(...args) {
        const start=performance.now();
        try {return original.apply(this,args);}
        finally { const end=performance.now(); render.push({time:start,gap:last===undefined?null:start-last,cpuMs:end-start,
          calls:this.info.render.calls,triangles:this.info.render.triangles,geometries:this.info.memory.geometries});last=start; }
      };
      restorers.push(()=>{renderer.render=original;});
    }};
  return {installed:true,mode,rendererConstructorFound:!!window.P14R.rendererConstructor};
}
