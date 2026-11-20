import { validateDepthFrame } from './depth-point.js';

const api = '/api/astra';
export async function requestAstra(action, body = {}, keepalive = false) {
  const response = await fetch(`${api}/${action}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-KineGlow-Client': '1' },
    body: JSON.stringify(body), keepalive });
  const result = await response.json().catch(() => ({ error: '请通过 Astra 启动脚本打开本地工坊' }));
  if (!response.ok) throw new Error(result.error || 'Astra 服务请求失败');
  return result;
}

export function unpackAstraFrame(buffer) {
  if (buffer.byteLength < 4) throw new Error('Astra 数据包不完整');
  const size = new DataView(buffer).getUint32(0, true);
  if (size < 2 || size > 16384 || 4 + size > buffer.byteLength) throw new Error('Astra 数据头无效');
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)));
  const { jpeg_bytes: jpeg, depth_bytes: depth } = metadata;
  if (metadata.version !== 1 || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1
      || !Number.isSafeInteger(jpeg) || jpeg <= 0 || depth !== 640 * 480 * 2
      || 4 + size + jpeg + depth !== buffer.byteLength) throw new Error('Astra 数据包版本或长度无效');
  const imageOffset = 4 + size, depthOffset = imageOffset + jpeg;
  const samples = depthOffset % 2 ? new Uint16Array(buffer.slice(depthOffset)) : new Uint16Array(buffer, depthOffset);
  const frame = validateDepthFrame({ ...metadata, depth: samples });
  return { frame, image: new Blob([new Uint8Array(buffer, imageOffset, jpeg)], { type: 'image/jpeg' }) };
}

export class AstraSession {
  constructor({ detect, stopped, preview, post = requestAstra, get = (url, signal) => fetch(url, { cache: 'no-store', signal }),
    decode = blob => createImageBitmap(blob) }) {
    Object.assign(this, { detect, stopped, preview, post, get, decode });
    this.generation = 0;
    this.running = false;
    this.session = null;
    this.releasing = Promise.resolve();
  }

  async start() {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    let token;
    try {
      await this.releasing;
      // A prior inference may still own the single shared Worker request.
      await Promise.allSettled([this.inflight]);
      if (!current()) return false;
      const loaded = await this.post('start');
      token = loaded.session;
      if (!current()) { await this.post('stop', { session: token }, true); return false; }
      this.session = token;
      this.running = true;
      const controller = this.controller = new AbortController();
      let sequence = 0;
      const receive = async () => {
        const response = await this.get(`${api}/frame?session=${encodeURIComponent(token)}&after=${sequence}`, controller.signal);
        if (!current()) return;
        if (response.status === 204) return;
        if (!response.ok) throw new Error((await response.json()).error || 'Astra 深度流中断');
        const { frame, image } = unpackAstraFrame(await response.arrayBuffer());
        if (!current()) return;
        if (frame.sequence <= sequence) throw new Error('Astra 收到陈旧帧');
        sequence = frame.sequence;
        const bitmap = await this.decode(image);
        try {
          if (!current()) { bitmap.close(); return; }
          if (bitmap.width !== frame.width || bitmap.height !== frame.height) throw new Error('Astra 彩色与深度帧尺寸不一致');
          this.preview?.(bitmap);
          return { frame, bitmap };
        } catch (error) { bitmap.close(); throw error; }
      };
      const infer = async ({frame, bitmap}) => {
        try {
          if (current()) await this.detect(bitmap, current, '摄像头', frame);
        } finally { bitmap.close(); }
      };
      // Await the first frame so startup errors reach the interface immediately.
      this.inflight = receive().then(packet => packet && infer(packet));
      await this.inflight;
      if (!current()) return false;
      let latest, processing = false;
      const failed = error => { if (current()) this.stop(`Astra 已停止：${error.message}`); };
      const drain = async () => {
        processing = true;
        try {
          while (latest && current()) {
            const packet = latest; latest = null;
            await infer(packet);
          }
        } catch (error) { failed(error); }
        finally { processing = false; latest?.bitmap.close(); latest = null; }
      };
      const loop = async () => {
        try {
          while (current()) {
            const packet = await receive();
            if (!packet) continue;
            if (!current()) { packet.bitmap.close(); break; }
            latest?.bitmap.close();
            latest = packet;
            if (!processing) this.inflight = drain();
          }
        } catch (error) { failed(error); }
      };
      void loop();
      return true;
    } catch (error) {
      if (current()) this.stop(`Astra 启动失败：${error.message}`);
      return false;
    }
  }

  stop(message = 'Astra 已停止，笔迹已保留') {
    const generation = ++this.generation;
    this.running = false;
    this.controller?.abort(); this.controller = null;
    const token = this.session;
    this.session = null;
    if (token) this.releasing = this.post('stop', { session: token }, true).then(() => {
      if (generation === this.generation) this.stopped(`${message}；设备已释放`);
    }).catch(error => {
      if (generation === this.generation) this.stopped(`Astra 释放未确认：${error.message}；服务会在租约超时后释放`);
    });
    this.stopped(token ? `${message}；正在释放设备` : message);
    return this.releasing;
  }
}
