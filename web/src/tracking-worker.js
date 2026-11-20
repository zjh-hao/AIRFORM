// This installed MediaPipe build loads a classic WASM script exposing ModuleFactory.
// Keep the worker classic too; importing that script as ESM hides its factory.

let detector, runningMode, recovery, recoveryActive = false, misses = 0, nextRetry = 0, nextPrimary = 0;
self.onmessage = async ({ data }) => {
  let bitmap = data.bitmap;
  try {
    if (data.type === 'init') {
      importScripts('/assets/vision_bundle.js');
      const { FilesetResolver, HandLandmarker } = Vision;
      const files = await FilesetResolver.forVisionTasks('/wasm');
      runningMode = data.runningMode === 'IMAGE' ? 'IMAGE' : 'VIDEO';
      const modelAssetPath = '/assets/hand_landmarker.task';
      const create = (delegate, mode = runningMode) => HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath, delegate },
        canvas: new OffscreenCanvas(1, 1), runningMode: mode, numHands: 2,
        ...(data.sensitive && mode==='VIDEO'?{minHandDetectionConfidence:.28,minHandPresenceConfidence:.28,minTrackingConfidence:.35}:{}),
      });
      let delegate = data.delegate, fallback;
      try { detector = await create(delegate); }
      catch (error) {
        if (delegate === 'CPU') throw error;
        fallback = String(error.message || error);
        delegate = 'CPU'; detector = await create(delegate);
      }
      let recoveryError;
      if (delegate === 'GPU' && runningMode === 'VIDEO') {
        try { recovery = await create('CPU', 'IMAGE'); }
        catch (error) { recoveryError = String(error.message || error); }
      }
      self.postMessage({ delegate, fallback, runningMode, recoveryReady: Boolean(recovery), recoveryError });
    } else {
      const begin = performance.now();
      if (!data.live || data.firstFrame) { recoveryActive = false; misses = 0; nextRetry = 0; }
      let result, recovered = false, recoveryError;
      const retry = () => {
        try {
          const candidate = recovery.detect(bitmap);
          if (candidate.landmarks.length) {
            if (!recoveryActive) nextPrimary = data.timestamp + 500;
            result = candidate; recovered = recoveryActive = true;
          }
        } catch (error) {
          recoveryError = String(error.message || error);
          recovery.close?.(); recovery = null;
        }
        if (!recovered) { recoveryActive = false; nextRetry = data.timestamp + 300; }
      };
      if (data.live && recoveryActive && data.timestamp < nextPrimary) retry();
      if (!recovered) {
        result = runningMode === 'IMAGE' ? detector.detect(bitmap) : detector.detectForVideo(bitmap, data.timestamp);
        if (result.landmarks.length) { recoveryActive = false; misses = 0; nextRetry = 0; }
        else if (recoveryActive) { nextPrimary = data.timestamp + 500; retry(); }
        else if (data.live && recovery && ++misses >= 2 && data.timestamp >= nextRetry) retry();
      }
      const elapsed = performance.now() - begin;
      // Return the very frame used for inference, so the overlay and pixels agree.
      self.postMessage({ result, elapsed, bitmap, recovered, recoveryError }, [bitmap]);
      bitmap = null;
    }
  } catch (error) { self.postMessage({ error: String(error.message || error) }); }
  finally { bitmap?.close(); }
};
