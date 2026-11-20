import { ValidationRecording, validateRecording, decodeDepth, RECORDING_LIMITS } from './validation-recording.js';
import { assetUrl } from './local-assets.js';

export function installValidationPanel({getMetadata,isRunning,onReplayStart,onReplayFrame,onReplayEnd}) {
  const $=id=>document.getElementById(id),recorder=new ValidationRecording();
  const status=$('validation-status'),links=$('validation-downloads');
  let lastInteraction=null,videoRecorder=null,stream=null,chunks=[],videoStopped=null;
  let replayAbort=null,finishing=false,disposed=false,recordTimer;
  const urls=[];
  const receive=({detail})=>{lastInteraction=detail;};
  window.addEventListener('kineglow:interaction',receive);
  function controls() {
    $('record-start').disabled=recorder.active||finishing||!!replayAbort;
    $('record-stop').disabled=!recorder.active;
    $('replay-file').disabled=recorder.active||finishing||!!replayAbort;
    $('replay-stop').disabled=!replayAbort;
    $('demo-replay').disabled=$('replay-file').disabled;
  }
  function addDownload(blob,name,label) {
    const url=URL.createObjectURL(blob);urls.push(url);
    const link=document.createElement('a');link.href=url;link.download=name;link.textContent=label;
    links.append(link,document.createTextNode(' · '));
  }
  function clearDownloads() {urls.splice(0).forEach(url=>URL.revokeObjectURL(url));links.replaceChildren();}
  async function finish(reason='user') {
    if(finishing||!recorder.data)return;
    clearTimeout(recordTimer);
    finishing=true;controls();
    try {
      const data=await recorder.stop(reason);
      const prefix=`AIRFORM-${data.metadata.testCase}-${data.createdAt.replace(/[:.]/g,'-')}`;
      if(videoRecorder?.state==='recording')videoRecorder.stop();
      if(videoStopped)await videoStopped;
      stream?.getTracks().forEach(track=>track.stop());stream=null;
      if(disposed)return;
      addDownload(new Blob([JSON.stringify(data)],{type:'application/json'}),`${prefix}.json`,'下载观测与指标 JSON');
      if(chunks.length)addDownload(new Blob(chunks,{type:videoRecorder.mimeType}),`${prefix}.webm`,'下载输入视频');
      window.dispatchEvent(new CustomEvent('kineglow:snapshot',{detail:{receive:blob=>{
        if(blob&&!disposed)addDownload(blob,`${prefix}.png`,'下载画布截图');
      }}}));
      status.textContent=`采集结束：${data.metrics.frames} 帧，${(data.metrics.durationMs/1000).toFixed(1)} 秒。结束原因 ${data.stopReason}。文件仅在本机，点击链接保存。`;
      chunks=[];videoRecorder=null;videoStopped=null;
    } catch(error) {status.textContent=`导出失败：${error.message}`;}
    finally {finishing=false;controls();}
  }
  const start=()=>{
    if(!isRunning()) {status.textContent='请先启动摄像头，确认画面稳定后再开始采集。';return;}
    clearDownloads();chunks=[];videoRecorder=null;videoStopped=null;
    try {
      const metadata={...getMetadata(),testCase:$('validation-case').value,trackingMode:new URLSearchParams(location.search).get('tracking')==='legacy'?'legacy':'world',
        userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};
      if($('record-video').checked) {
        if(!window.MediaRecorder)throw new Error('浏览器不支持视频录制，请取消视频选项');
        stream=document.getElementById('camera').captureStream(30);
        videoRecorder=new MediaRecorder(stream,{videoBitsPerSecond:1_500_000});
        videoRecorder.addEventListener('dataavailable',e=>{if(e.data.size)chunks.push(e.data);});
        videoStopped=new Promise(resolve=>{
          videoRecorder.addEventListener('stop',resolve,{once:true});
          videoRecorder.addEventListener('error',resolve,{once:true});
        });
        metadata.videoStartPerformanceMs=performance.now();
        metadata.videoCaptureFps=30;
        videoRecorder.start(1000);
      }
      recorder.start(metadata);
      recordTimer=setTimeout(()=>void finish('duration-limit'),RECORDING_LIMITS.durationMs);
      status.textContent='正在采集原始检测结果与对齐深度；可选视频为相机采样画面。最多 90 秒 / 128 MiB。';controls();
    } catch(error) {
      if(videoRecorder?.state==='recording')videoRecorder.stop();
      stream?.getTracks().forEach(track=>track.stop());status.textContent=error.message;
    }
  };
  const stop=()=>void finish();
  const cancelReplay=()=>replayAbort?.abort();
  const wait=(ms,signal)=>new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,Math.max(0,ms));signal.addEventListener('abort',done,{once:true});
    if(signal.aborted)done();
  });
  let replayFinished=Promise.resolve();
  const runReplay=async file=>{
    if(!file || recorder.active || finishing || replayAbort)return;
    const controller=new AbortController();replayAbort=controller;controls();let started=false;
    try {
      if(file.size>RECORDING_LIMITS.bytes+1024*1024)throw new Error('回放文件超过大小限制');
      const data=validateRecording(JSON.parse(await file.text()));
      if(controller.signal.aborted)return;
      await onReplayStart(data);started=true;
      const epoch=performance.now();
      for(const frame of data.frames) {
        if(controller.signal.aborted)break;
        const depthFrame=await decodeDepth(frame.depthFrame);
        await wait(epoch+frame.timestamp-performance.now(),controller.signal);
        if(controller.signal.aborted)break;
        onReplayFrame({...frame,depthFrame,timestamp:epoch+frame.timestamp,source:'摄像头',origin:'replay'},data);
        status.textContent=`本地观测回放 ${(frame.timestamp/1000).toFixed(1)} 秒 · 无实时推理；输入视频请单独打开查看。`;
      }
    } catch(error) {status.textContent=`回放失败：${error.message}`;}
    finally {replayAbort=null;if(started)onReplayEnd();controls();}
  };
  const replayFile=file=>{
    if(!file || recorder.active || finishing || replayAbort)return replayFinished;
    replayFinished=runReplay(file);return replayFinished;
  };
  const replay=event=>{const file=event.target.files?.[0];event.target.value='';void replayFile(file);};
  const demo=async()=>{
    try{
      const response=await fetch(assetUrl('/assets/m1-synthetic-observations.json'));
      if(!response.ok)throw Error('找不到本地样例');
      document.getElementById('drawer')?.close();
      await replayFile(await response.blob());
    }catch(error){status.textContent='样例读取失败：'+error.message;}
  };
  $('demo-replay').addEventListener('click',demo);
  $('record-start').addEventListener('click',start);
  $('record-stop').addEventListener('click',stop);
  $('replay-file').addEventListener('change',replay);
  $('replay-stop').addEventListener('click',cancelReplay);
  controls();
  return {
    async record(detail,timings) {
      if(!recorder.active)return;
      try {
        await recorder.record(detail,lastInteraction,timings);
        if(!recorder.active)void finish(recorder.data.stopReason);
        else status.textContent=`采集中：${recorder.data.frames.length} 帧 / ${(recorder.bytes/1024/1024).toFixed(1)} MiB · 压缩开销单独记录`;
      } catch(error) {status.textContent=`采集中断：${error.message}`;void finish('capture-error');}
    },
    stopReplay:()=>{cancelReplay();return replayFinished;},
    stopRecording:()=>recorder.active?finish('input-stopped'):Promise.resolve(),
    dispose() {
      $('demo-replay').removeEventListener('click',demo);
      disposed=true;recorder.active=false;cancelReplay();
      clearTimeout(recordTimer);
      if(videoRecorder?.state==='recording')videoRecorder.stop();
      stream?.getTracks().forEach(track=>track.stop());clearDownloads();
      window.removeEventListener('kineglow:interaction',receive);
      $('record-start').removeEventListener('click',start);$('record-stop').removeEventListener('click',stop);
      $('replay-file').removeEventListener('change',replay);$('replay-stop').removeEventListener('click',cancelReplay);
    },
  };
}
