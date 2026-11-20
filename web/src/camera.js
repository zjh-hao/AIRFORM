// A generation token also releases streams returned after Stop/pagehide during a permission prompt.
export class CameraSession {
  constructor({ video, acquire, detect, stopped, schedule = callback => requestAnimationFrame(callback), cancel = id => cancelAnimationFrame(id) }) {
    Object.assign(this, { video, acquire, detect, stopped, schedule, cancel });
    this.generation = 0;
    this.running = false;
    this.stream = null;
    this.processing = false;
  }
  async start() {
    const generation = ++this.generation;
    let stream;
    try {
      stream = await this.acquire();
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return false;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (generation === this.generation) this.stop('摄像头断开，可重新启动');
      });
      await this.video.play();
      if (generation !== this.generation) return false;
      this.running = true;
      let lastVideoTime = -1;
      const current = () => generation === this.generation && this.running;
      if (typeof this.video.requestVideoFrameCallback === 'function') {
        let pending = false, lastFrame;
        const drain = async () => {
          if (this.processing) return;
          this.processing = true;
          try {
            while (current() && pending) {
              pending = false;
              this.inflight = Promise.resolve(this.detect(this.video, current));
              await this.inflight;
            }
          } catch (error) { if (current()) this.stop(`推理失败：${error.message}`); }
          finally { this.processing = false; this.inflight = null; }
        };
        const presented = (_, metadata) => {
          if (!current()) return;
          this.frameCallback = this.video.requestVideoFrameCallback(presented);
          if (lastFrame === metadata.presentedFrames || this.video.readyState < 2) return;
          lastFrame = metadata.presentedFrames;
          pending = true;
          void drain();
        };
        this.frameCallback = this.video.requestVideoFrameCallback(presented);
        return true;
      }
      const loop = async () => {
        if (!current()) return;
        try {
          const frameTime = this.video.getVideoPlaybackQuality?.().totalVideoFrames || Math.floor(this.video.currentTime * 30);
          if (!this.processing && this.video.readyState >= 2 && frameTime !== lastVideoTime) {
            lastVideoTime = frameTime;
            this.processing = true;
            try {
              this.inflight = Promise.resolve(this.detect(this.video, current));
              await this.inflight;
            } finally { this.processing = false; this.inflight = null; }
          }
          if (current()) this.animation = this.schedule(loop);
        } catch (error) { if (current()) this.stop(`推理失败：${error.message}`); }
      };
      await loop();
      return current();
    } catch (error) {
      if (generation === this.generation) this.stop(`启动失败：${error.name}: ${error.message}`);
      return false;
    }
  }
  stop(message = '已停止，摄像头已释放；可重新启动') {
    ++this.generation;
    this.running = false;
    if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback(this.frameCallback);
    this.frameCallback = undefined;
    this.cancel(this.animation);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.stopped(message);
  }
}
