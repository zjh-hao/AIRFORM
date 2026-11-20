import { writeFile } from 'node:fs/promises';

export async function astraAB(evaluate) {
  const mode = process.env.AIRFORM_AB_CASE ?? 'live';
  if (!['live', 'hologram', 'drawing'].includes(mode) || !process.env.AIRFORM_AB_OUT)
    throw Error('Set AIRFORM_AB_CASE and AIRFORM_AB_OUT');
  const result = await evaluate(`(${measure.toString()})(${JSON.stringify(mode)})`);
  await writeFile(process.env.AIRFORM_AB_OUT, JSON.stringify(result));
  console.log(JSON.stringify({ mode, backend: result.backend, samples: result.rows.length,
    hands: result.rows.filter(row => row.sides.length).length, hologramDraws: result.palms.length,
    firstFrameMs: result.firstFrameMs, clockRTTMs: result.clockRTTMs }));
}

async function measure(mode) {
  const $ = selector => document.querySelector(selector);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 150 && $('#start').disabled; i++) await wait(100);
  if ($('#start').disabled || $('#input-source').value !== 'astra') throw Error('Astra page not ready');
  if (mode === 'hologram') {
    $('#effects-open').click();
    $('#fx-modes [data-mode=solar]').click();
    $('#fx-apply').click();
    if (document.body.dataset.effect !== 'solar') throw Error('Hologram mode failed');
  }
  const clockSamples = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const { monotonicMs } = await (await fetch('/__ab_clock', { cache: 'no-store' })).json();
    const end = performance.now();
    clockSamples.push({ rtt: end - start, offset: monotonicMs - (start + end) / 2 });
  }
  const clock = clockSamples.sort((a, b) => a.rtt - b.rtt)[0];
  const rows = [], palms = [], workers = new WeakSet();
  let workerResult, interaction, lastRow;
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, ...args) {
    if (message?.type === 'detect' && !workers.has(this)) {
      workers.add(this);
      const receive = this.onmessage;
      this.onmessage = event => {
        workerResult = event.data;
        return receive.call(this, event);
      };
    }
    return post.call(this, message, ...args);
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(...args) {
    if (mode === 'hologram' && this.canvas.id === 'palm-fx' && args.length === 9 && lastRow?.phase === 'static') {
      const [, , , , , x, y, w, h] = args;
      palms.push({ x: x + w / 2, y: y + h / 2, radius: w / 2, alpha: this.globalAlpha });
    }
    return draw.apply(this, args);
  };
  window.addEventListener('kineglow:interaction', ({ detail }) => { interaction = detail; });
  window.addEventListener('kineglow:hands', ({ detail }) => {
    if (detail.source !== '摄像头' || !detail.depthFrame) return;
    const frame = detail.depthFrame;
    const capture = frame.captured_monotonic * 1000 - clock.offset;
    const { landmarks, handedness, timestamp } = detail;
    const sides = handedness.map(hand => hand[0]?.categoryName);
    const right = sides.indexOf('Right');
    const tip = landmarks[right < 0 ? 0 : right]?.[8];
    const active = interaction?.timestamp === timestamp ? interaction : null;
    const row = lastRow = { sequence: frame.sequence, depthIndex: frame.depth_index,
      phase: frame.test_phase, trial: frame.test_trial, offset: frame.test_offset,
      pairGapMs: frame.host_pair_gap_ms, timestamp, at: performance.now(), capture,
      modelMs: frame.tracking?.inferenceMs ?? workerResult?.elapsed,
      preprocessMs: frame.tracking?.preprocessMs, modelTimestampMs: frame.tracking?.timestampMs,
      recovered: workerResult?.recovered, sides, tipX: tip?.x, tipY: tip?.y,
      cursorX: active?.cursorSource === 'filtered' ? active.cursorPoint?.x : undefined,
      state: active?.state, point: Boolean(active?.point),
    };
    rows.push(row);
    requestAnimationFrame(() => { row.nextRaf = performance.now(); });
  });

  const start = performance.now();
  $('#start').click();
  try {
    for (let i = 0; i < 200 && !rows.length; i++) {
      if ($('#status').textContent.includes('失败')) throw Error($('#status').textContent);
      await wait(100);
    }
    if (!rows.length) throw Error($('#status').textContent);
    if (mode === 'live') await wait(13000);
    else {
      for (let i = 0; i < 240 && lastRow?.phase !== 'tail'; i++) await wait(100);
      if (lastRow?.phase !== 'tail') throw Error('Replay did not finish: ' + $('#status').textContent);
    }
    if (!rows.every(row => Number.isFinite(row.modelMs))) throw Error('Missing per-frame inference timings');
    return { mode, backend: $('#backend').textContent, clockRTTMs: clock.rtt,
      firstFrameMs: rows[0].at - start, rows, palms, strokeStatus: $('#stroke-status').textContent };
  } finally {
    $('#stop').click();
    for (let i = 0; i < 75 && $('#input-source').disabled; i++) await wait(100);
  }
}
