// One request in flight; CameraSession skips intermediate camera frames instead of queuing them.
export class DetectorWorker {
  constructor(worker) {
    this.worker = worker;
    this.closed = false;
    worker.onmessage = ({ data }) => {
      const pending = this.pending;
      this.pending = null;
      if (!pending) { data.bitmap?.close(); return; }
      if (data.error) { data.bitmap?.close(); pending.reject(new Error(data.error)); }
      else pending.resolve(data);
    };
    worker.onerror = event => { event.preventDefault?.(); this.close(event.message || '追踪 Worker 失败'); };
    worker.onmessageerror = () => this.close('追踪 Worker 消息无法解码');
  }
  request(message, transfer = []) {
    if (this.closed || this.pending) {
      message.bitmap?.close();
      return Promise.reject(new Error(this.closed ? '追踪 Worker 已关闭' : '已有推理在处理'));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try { this.worker.postMessage(message, transfer); }
      catch (error) { this.pending = null; message.bitmap?.close(); reject(error); }
    });
  }
  close(message = '追踪 Worker 已关闭') {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.pending?.reject(new Error(message));
    this.pending = null;
  }
}
