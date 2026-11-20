import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const stage=process.argv[2];
if(!['m4','launcher','library','webcam-live','astra-live','astra-ab','camera-replay','hand-frame'].includes(stage))throw new Error('Unknown validation stage');
const replay=stage==='camera-replay';
if(replay && !process.env.KINEGLOW_Y4M)throw Error('Set KINEGLOW_Y4M to a local 30 fps Y4M input');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=await mkdtemp(join(tmpdir(),'kineglow-m3-'));
const browser=spawn(process.env.KINEGLOW_BROWSER??'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-background-networking',
    ...(stage==='library'||stage==='m4'||replay?['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']:[]),
    ...(stage==='webcam-live'?['--use-fake-ui-for-media-stream']:[]),
    ...(replay?['--use-file-for-fake-video-capture='+process.env.KINEGLOW_Y4M]:[]),'about:blank'],
  {windowsHide:true,stdio:'ignore'});
let socket;
try {
  let port;
  for(let retry=0;retry<100&&!port;retry++){
    try{port=parseInt(await readFile(join(profile,'DevToolsActivePort'),'utf8'),10);}catch{await wait(100);}
  }
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(pages.find(page=>page.type==='page' && page.url==='about:blank').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;const pending=new Map(),errors=[];
  socket.onmessage=event=>{
    const message=JSON.parse(event.data), entry=pending.get(message.id);
    if(entry){pending.delete(message.id);clearTimeout(entry.timer);
      if(message.error)entry.reject(Error(message.error.message));else entry.resolve(message.result);}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);
    if(message.method==='Runtime.consoleAPICalled' && message.params.type==='error')
      errors.push(message.params.args.map(arg=>arg.value??arg.description).join(' '));
  };
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>reject(Error(method+' timeout')),45000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));
  });
  const evaluate=async expression=>{
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    return result.result.value;
  };
  await call('Runtime.enable');await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
  const origin = process.env.AIRFORM_URL ?? 'http://127.0.0.1:4197/';
  const defaultUrl = stage === 'launcher' ? new URL('../../AIRFORM.html',import.meta.url).href : origin;
  if (stage === 'launcher') {
    // Exercise the cold-start controls without interrupting a running camera session.
    await call('Network.enable');
    await call('Network.setBlockedURLs', {urls: ['*astra-python-ready.svg*']});
    await call('Page.navigate', {url: defaultUrl});
    for (let i=0; i<30 && !await evaluate("document.querySelector('#launch')?.hidden === false"); i++) await wait(100);
    if (!await evaluate("location.protocol === 'file:' && document.querySelector('#launch')?.href === 'airform-astra-python://start' && !document.querySelector('#launch').hidden"))
      throw Error('The stopped service did not expose its launch control');
    if (!await evaluate("document.title.includes('AIRFORM') && document.querySelector('h1 img')?.naturalWidth > 0"))
      throw Error('The local launcher did not load the AIRFORM identity');
    await call('Network.setBlockedURLs', {urls: []});
  }
  await call('Page.navigate',{url:process.argv[3]??defaultUrl});
  for(let retry=0;retry<100;retry++){if(await evaluate("document.querySelector('#front-view')?.disabled===false"))break;await wait(200);}
  if (stage === 'library') {
    const {checkLibrary} = await import('./effect-library.mjs');
    await checkLibrary({evaluate,call});
  } else if (stage === 'launcher') {
    if (!await evaluate(`location.origin === 'http://127.0.0.1:4197' &&
      document.querySelector('#input-source')?.value === 'astra' &&
      document.querySelector('#backend')?.textContent.includes('Python GPU · DirectML')`))
      throw Error('Launcher did not enter the Python GPU workshop: '+await evaluate("location.href + ' ' + document.querySelector('#status')?.textContent"));
    if (!await evaluate(`document.title === 'AIRFORM · Astra Python GPU' &&
      document.querySelector('#home b').textContent === 'AIRFORM' &&
      document.querySelector('#home img').naturalWidth > 0 &&
      document.querySelector('link[rel=icon]').href === document.querySelector('#home img').src`))
      throw Error('The workshop did not load the AIRFORM header and tab icon');
    console.log('AIRFORM local HTML entered Astra Python GPU on port 4197 in Edge.');
  } else if(stage==='hand-frame'){
    const {probe}=await import('./probe-hand-frame.mjs');
    await probe(evaluate);
  }else if(replay){
    for(let retry=0;retry<150 && await evaluate("document.querySelector('#start').disabled");retry++)await wait(100);
    const result=await evaluate(`(async()=>{
      const samples=[],gaps=[],videoGaps=[],video=document.querySelector('video'),start=document.querySelector('#start');let last,raf,lastVideo,videoCallback;
      const presented=now=>{
        if(lastVideo!==undefined && samples.length)videoGaps.push(now-lastVideo);
        lastVideo=now;videoCallback=video.requestVideoFrameCallback(presented);
      };
      videoCallback=video.requestVideoFrameCallback(presented);
      const tick=now=>{if(last && samples.length)gaps.push(now-last);last=now;raf=requestAnimationFrame(tick);};
      const observe=({detail})=>{if(detail.source==='摄像头')samples.push({at:performance.now(),hand:!!detail.landmarks.length,right:detail.handedness.some(side=>side[0]?.categoryName==='Right'),source:detail.followSource});};
      window.addEventListener('kineglow:hands',observe);raf=requestAnimationFrame(tick);start.click();
      try{for(let retry=0;retry<150&&!samples.length;retry++)await new Promise(ok=>setTimeout(ok,100));
        if(!samples.length)throw Error('No camera frames: '+document.querySelector('#status').textContent);
        await new Promise(ok=>setTimeout(ok,10000));const intervals=samples.slice(1).map((sample,index)=>sample.at-samples[index].at);
        const p95=values=>Math.round(values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]);
        return {backend:document.querySelector('#backend').textContent,n:samples.length,withHand:samples.filter(s=>s.hand).length,right:samples.filter(s=>s.right).length,
          sources:Object.fromEntries([...new Set(samples.map(s=>s.source).filter(Boolean))].map(source=>[source,samples.filter(s=>s.source===source).length])),
          hz:Math.round(10000*(samples.length-1)/(samples.at(-1).at-samples[0].at))/10,gapP95:p95(intervals),
          gapMax:Math.round(Math.max(...intervals)),gapOver250:intervals.filter(ms=>ms>250).length,
          liveVideoVisible:getComputedStyle(video).display!=='none',videoFrames:videoGaps.length,
          videoGapP95:p95(videoGaps),videoGapMax:Math.round(Math.max(...videoGaps)),
          rafP95:p95(gaps),rafOver50:gaps.filter(ms=>ms>50).length};
      }finally{window.removeEventListener('kineglow:hands',observe);video.cancelVideoFrameCallback(videoCallback);cancelAnimationFrame(raf);document.querySelector('#stop').click();}
    })()`);
    console.log(JSON.stringify(result));
    if(errors.length)throw Error(errors.join('\n'));
  }else if(stage==='webcam-live'){
    const info=await evaluate(`(async()=>{
      for(let i=0;i<120 && document.querySelector('#start').disabled;i++) await new Promise(r=>setTimeout(r,100));
      document.querySelector('#start').click();
      const video=document.querySelector('video');
      try {
        for(let i=0;i<120;i++){
          await new Promise(r=>setTimeout(r,100));
          if(video.videoWidth && document.querySelector('#tracking').textContent.includes('推理帧'))
            return {width:video.videoWidth,height:video.videoHeight,worker:document.querySelector('#backend').textContent};
        }
        throw Error(document.querySelector('#alert').textContent || 'No live camera frames');
      }finally{document.querySelector('#stop').click();}
    })()`);
    console.log('Physical camera (no captures):',info);
  }else if(stage==='astra-ab'){
    const { astraAB } = await import('./astra-ab.mjs');
    await astraAB(evaluate);
    if(errors.length)throw Error(errors.join('\n'));
  }else if(stage==='astra-live'){
    await evaluate(`document.querySelector('#input-source').value='astra';
      document.querySelector('#input-source').dispatchEvent(new Event('change'))`);
    for(let retry=0;retry<150 && await evaluate("document.querySelector('#start').disabled");retry++)await wait(100);
    await evaluate(`window.liveSample=[];window.addEventListener('kineglow:hands',({detail})=>{
      if(detail.source==='摄像头')liveSample.push({at:performance.now(),sequence:detail.depthFrame.sequence,hand:!!detail.landmarks.length});
    });document.querySelector('#start').click()`);
    try{
      for(let retry=0;retry<200;retry++){
        if(await evaluate("liveSample.length || document.querySelector('#status').textContent.includes('失败')"))break;
        await wait(200);
      }
      if(!await evaluate('liveSample.length'))throw Error(await evaluate("document.querySelector('#status').textContent")+' '+errors.join(', '));
      await wait(8000);
      console.log(JSON.stringify(await evaluate(`(()=>{const gaps=liveSample.slice(1).map((s,index)=>s.at-liveSample[index].at).sort((a,b)=>a-b);
        return {frames:liveSample.length,avgHz:1000*(liveSample.length-1)/(liveSample.at(-1).at-liveSample[0].at),p95Gap:gaps[Math.ceil(gaps.length*.95)-1],
          seen:liveSample.filter(s=>s.hand).map(s=>s.sequence),samples:liveSample.map(s=>s.sequence),metrics:document.querySelector('#tracking').textContent};})()`)));
      if(!await evaluate('liveSample.length > 1'))throw Error('No live Astra frames');
    }finally{await evaluate("document.querySelector('#stop').click()");await wait(500);}
  }else if(stage==='m4'){
    const {checkWorkstation}=await import('./m4-workstation.mjs');
    await checkWorkstation({stage,call,evaluate,errors});
  }
}finally{socket?.close();browser.kill();}
