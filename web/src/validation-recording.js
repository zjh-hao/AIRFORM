// Local evidence format. Recorded landmarks are detector outputs, not ground
// truth; optional full aligned depth allows deterministic projector replay.
export const RECORDING_LIMITS = Object.freeze({ frames: 9000, durationMs: 90000, bytes: 128*1024*1024 });
const finitePoint = p => p && ['x','y','z'].every(k=>Number.isFinite(p[k]));
const base64 = bytes => {
  let text='';
  for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
};

export async function encodeDepth(frame) {
  if(!frame)return null;
  const {depth,...metadata}=frame;
  if(!(depth instanceof Uint16Array)||depth.length!==frame.width*frame.height)throw new Error('深度帧长度无效');
  const bytes=new Uint8Array(depth.length*2),view=new DataView(bytes.buffer);
  for(let i=0;i<depth.length;i++)view.setUint16(i*2,depth[i],true);
  const compressed=await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return {...metadata,depthEncoding:'gzip-u16le-base64',depthData:base64(new Uint8Array(compressed))};
}

export async function decodeDepth(frame) {
  if(!frame)return null;
  const count=frame.width*frame.height;
  if(!Number.isInteger(count)||count<=0||count>1920*1080||frame.depthEncoding!=='gzip-u16le-base64'
      ||typeof frame.depthData!=='string'||frame.depthData.length>count*4+1024)throw new Error('回放深度格式无效');
  const bytes=Uint8Array.from(atob(frame.depthData),c=>c.charCodeAt(0));
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoded=new Uint8Array(count*2);let offset=0;
  try {
    while(true){
      const {done,value}=await reader.read();if(done)break;
      if(offset+value.length>decoded.length)throw new Error('回放深度解压长度超限');
      decoded.set(value,offset);offset+=value.length;
    }
  } finally {await reader.cancel();}
  if(offset!==decoded.length)throw new Error('回放深度不完整');
  const depth=new Uint16Array(count),view=new DataView(decoded.buffer);
  for(let i=0;i<count;i++)depth[i]=view.getUint16(i*2,true);
  const {depthEncoding,depthData,...metadata}=frame;
  return {...metadata,depth};
}

export class ValidationRecording {
  constructor(limits={}) {this.limits={...RECORDING_LIMITS,...limits};this.active=false;this.pending=null;}
  start(metadata) {
    if(this.active||this.pending)throw new Error('上一段采集尚未结束');
    this.data={schema:'kineglow-observations-v1',createdAt:new Date().toISOString(),
      evidence:'recorded-detector-output',metadata:structuredClone(metadata),
      limitations:['检测结果不是人工标注真值','采集压缩有开销，不能用此模式代替性能测试','时间从浏览器采样开始，不是动作到屏幕延迟'],
      frames:[],stopReason:null};
    this.bytes=0;this.first=null;this.active=true;
  }
  async record(detail,interaction,timings={}) {
    if(!this.active||detail.source!=='摄像头'||detail.origin==='replay')return;
    if(this.pending)throw new Error('采集必须保持单帧在途');
    const token=this.data;
    this.pending=(async()=>{
      this.first??=detail.timestamp;
      token.metadata.firstSamplePerformanceMs??=this.first;
      if(token.frames.length>=this.limits.frames||detail.timestamp-this.first>this.limits.durationMs) {
        this.active=false;token.stopReason='time-or-frame-limit';return;
      }
      const start=performance.now();
      const frame={timestamp:detail.timestamp-this.first,landmarks:structuredClone(detail.landmarks),
        ...(detail.followSource?{followSource:detail.followSource}:{}),
        ...(detail.enhanced?{enhanced:true}:{}),
        worldLandmarks:structuredClone(detail.worldLandmarks??[]),handedness:structuredClone(detail.handedness??[]),
        interaction:structuredClone(interaction??null),timings:{...timings},
        depthFrame:await encodeDepth(detail.depthFrame)};
      // Store observation-relative time in both copies, so replay does not mix clocks.
      if(frame.interaction)frame.interaction.timestamp=frame.timestamp;
      frame.timings.captureMs=performance.now()-start;
      const bytes=new TextEncoder().encode(JSON.stringify(frame)).length;
      if(this.bytes+bytes>this.limits.bytes) {this.active=false;token.stopReason='byte-limit';return;}
      this.bytes+=bytes;token.frames.push(frame);
    })();
    try {await this.pending;} finally {this.pending=null;}
  }
  async stop(reason='user') {
    this.active=false;await this.pending;
    if(!this.data)return null;
    this.data.stopReason??=reason;
    this.data.metrics=summarizeRecording(this.data);
    return this.data;
  }
}

export function summarizeRecording(data) {
  const frames=data.frames,n=frames.length;
  const durationMs=n>1?frames.at(-1).timestamp-frames[0].timestamp:0;
  const detections=frames.filter(f=>f.landmarks.length>0).length;
  const valid=frames.filter(f=>f.interaction?.observationValid===true
    || (f.interaction&&!Object.hasOwn(f.interaction,'observationValid')&&Number.isInteger(f.interaction.handIndex))).length;
  const held=frames.filter(f=>f.interaction?.cursorSource==='held').length;
  const mean=key=>{
    const values=frames.map(f=>f.timings[key]).filter(Number.isFinite);
    return values.length?values.reduce((s,v)=>s+v,0)/values.length:null;
  };
  return {frames:n,durationMs,detectorOutputHz:durationMs>0?(n-1)*1000/durationMs:null,
    detectedHandFrames:detections,detectedHandFraction:n?detections/n:null,
    qualifiedInteractionFrames:valid,qualifiedInteractionFraction:n?valid/n:null,heldCursorFrames:held,
    meanInferenceMs:mean('inferenceMs'),meanSampleToOverlayMs:mean('sampleToOverlayMs'),meanCaptureMs:mean('captureMs'),
    humanAnnotatedAvailability:null,screenJitterPx:null,physicalEndToEndMs:null,gpuUtilization:null,
    note:'帧检测率包含任意手；交互率要求合格右手。保持帧不算成功检测，二者都不是人工标注的正确率。'};
}

export function validateRecording(data) {
  if(data?.schema!=='kineglow-observations-v1'||!Array.isArray(data.frames)
      ||!data.frames.length||data.frames.length>RECORDING_LIMITS.frames)throw new Error('不是有效的 AIRFORM 观测序列');
  if(!Number.isInteger(data.metadata?.width)||!Number.isInteger(data.metadata?.height)
      ||data.metadata.width<1||data.metadata.height<1||data.metadata.width>1920||data.metadata.height>1080)throw new Error('回放画面尺寸无效');
  if(!['webcam','astra'].includes(data.metadata.input))throw new Error('回放输入源无效');
  let previous=-1;
  for(const frame of data.frames) {
    if(!Number.isFinite(frame.timestamp)||frame.timestamp<=previous||frame.timestamp>RECORDING_LIMITS.durationMs
        ||!Array.isArray(frame.landmarks)||frame.landmarks.length>2
        ||!frame.landmarks.every(hand=>Array.isArray(hand)&&hand.length===21&&hand.every(finitePoint))
        ||!Array.isArray(frame.worldLandmarks)||frame.worldLandmarks.length>2
        ||!frame.worldLandmarks.every(hand=>Array.isArray(hand)&&hand.length===21&&hand.every(finitePoint))
        ||!Array.isArray(frame.handedness))throw new Error('回放关键点或时间戳无效');
    if(data.metadata.input==='astra'&&!frame.depthFrame)throw new Error('Astra 回放缺少对齐深度');
    previous=frame.timestamp;
  }
  return data;
}
