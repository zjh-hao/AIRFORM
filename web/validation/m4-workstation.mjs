import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function checkWorkstation({stage,call,evaluate,errors}){
  const folder=new URL('../../local-output/screens/',import.meta.url);
  await mkdir(folder,{recursive:true});
  const viewport=(width,height)=>call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  const screenshot=async name=>{
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const result=await call('Page.captureScreenshot',{format:'png'});
    await writeFile(new URL('2026-11-19-workshop-'+name+'.png',folder),Buffer.from(result.data,'base64'));
  };
  await viewport(1440,900);
  if(stage==='m4-baseline'){await screenshot('before');return;}
  await call('Page.reload',{});
  const ingress=await evaluate(`(async()=>{
    for(let retry=0;retry<100;retry++){
      const canvas=document.querySelector('body>#field-cloud');
      if(canvas){
        const rect=canvas.getBoundingClientRect();
        if(rect.left!==0||rect.top!==0||rect.width!==innerWidth||rect.height!==innerHeight)return false;
        const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        if([0,1,2,3].every(side=>{
          for(let y=1;y<canvas.height;y+=3)for(let x=1;x<canvas.width;x+=3){
            if((side===0?x<canvas.width*.1:side===1?x>canvas.width*.9:side===2?y<50:y>canvas.height-50)
                && pixels[(y*canvas.width+x)*4+3]>40)return true;
          }
          return false;
        }))return true;
      }
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    return false;
  })()`);
  assert.ok(ingress,'Incoming particles must be visible at all four viewport edges');
  await evaluate(`(async()=>{
    const canvas=document.getElementById('field-cloud'),region=document.getElementById('field-region');
    const probe=document.createElement('canvas');probe.width=80;probe.height=60;
    const context=probe.getContext('2d',{willReadFrequently:true}),started=performance.now();
    let resets=0;
    const observer=new MutationObserver(records=>{resets+=records.length;});
    observer.observe(canvas,{attributes:true,attributeFilter:['width','height']});
    try{
      while(performance.now()-started<2900){
        await new Promise(requestAnimationFrame);
        if(performance.now()-started<900)continue;
        if(canvas.parentElement!==document.body||resets)throw Error('Cloud surface replaced or reset during arrival');
        const rect=region.getBoundingClientRect(),scale=canvas.width/innerWidth;
        context.clearRect(0,0,80,60);
        context.drawImage(canvas,rect.left*scale,rect.top*scale,rect.width*scale,rect.height*scale,0,0,80,60);
        if(!context.getImageData(0,0,80,60).data.some((value,index)=>index%4===3&&value>5))
          throw Error('Empty cloud frame during transition');
      }
    }finally{observer.disconnect();}
  })()`);
  await evaluate("(async()=>{for(let count=0;count<80&&document.querySelector('#start').disabled;count++)await new Promise(resolve=>setTimeout(resolve,100));})()");
  const click=id=>evaluate('document.getElementById('+JSON.stringify(id)+').click()');
  assert.equal(await evaluate("document.querySelector('#drawer').open"),false);
  const layout=()=>evaluate(`(()=>{
    const rect=selector=>document.querySelector(selector).getBoundingClientRect();
    const title=document.querySelector('.intro h1'),range=document.createRange();
    range.selectNodeContents(title);
    return title.textContent==='虚拟特效工坊' && range.getClientRects().length===1 &&
      ['.subtitle','.lede','.session'].every(selector=>Math.abs(rect(selector).left-rect('.intro h1').left)<1) && !document.querySelector('.steps') &&
      range.getBoundingClientRect().right<=rect('.intro').right && rect('.lede').bottom<=rect('.session').top &&
      rect('.session').right<rect('#field-region').left && getComputedStyle(document.querySelector('#preview')).display==='none' && rect('.session').bottom<rect('.stage').bottom;
  })()`);
  assert.ok(await layout());
  assert.ok(await evaluate(`(() => {
    const style = (id, pseudo) => getComputedStyle(document.getElementById(id), pseudo);
    return style('start', '::before').content === '""' &&
      style('start').color !== style('stop').color &&
      ['start', 'mouse-mode', 'guide-toggle', 'png', 'settings-open', 'export-json'].every(id =>
        style(id).borderTopStyle === 'none' && style(id).borderBottomStyle === 'solid');
  })()`), 'Desktop actions should show the optical baseline and distinguish the camera from disabled input');
  assert.ok(await evaluate(`(() => {
    const preview = document.querySelector('#preview');
    const summary = preview.querySelector('summary');
    const glow = document.querySelector('#brush-glow');
    return getComputedStyle(preview).borderStyle === 'none' && [summary, glow].every(control => {
      const style = getComputedStyle(control);
      return style.borderStyle === 'none none solid' && style.backgroundImage !== 'none';
    });
  })()`), 'Input preview and glow should share the desktop action baseline and end tick');
  await click('browse-fx');await click('fx-apply');
  await evaluate("document.querySelector('#preview summary').click()");
  assert.ok(await evaluate("document.querySelector('#preview').open && document.querySelector('#camera').checkVisibility()"));
  await evaluate("document.querySelector('#preview summary').click()");
  assert.equal(await evaluate("document.querySelector('#preview').open"), false);
  await click('home');
  const cloudSample=()=>evaluate("document.getElementById('field-cloud').toDataURL()");
  const assembled=await cloudSample();
  await evaluate('new Promise(resolve=>setTimeout(resolve,600))');
  assert.ok(assembled!==await cloudSample(),'Assembled cloud must breathe without a pointer');
  await screenshot('desktop');
  await click('browse-fx');await click('fx-apply');
  await evaluate("document.querySelector('#brush-glow').focus()");
  for (const [key, keyCode, mode] of [['ArrowDown', 40, 'on'], ['ArrowDown', 40, 'off'], ['Home', 36, 'auto']]) {
    for (const type of ['keyDown', 'keyUp']) {
      await call('Input.dispatchKeyEvent', {type, key, code:key, windowsVirtualKeyCode:keyCode});
    }
    assert.equal(await evaluate("document.querySelector('#brush-glow').value"), mode);
  }
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await call('Page.reload',{});
  await evaluate(`(async()=>{
    for(let retry=0;retry<100;retry++){
      const canvas=document.querySelector('body>#field-cloud');
      if(canvas && canvas.width>300 && document.querySelector('#front-view')?.disabled===false)return;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    throw Error('Reduced-motion landing did not initialize');
  })()`);
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:15,y:20});
  await evaluate(`(async()=>{
    const sample=()=>document.getElementById('field-cloud').toDataURL();
    let previous=sample();
    for(let retry=0;retry<20;retry++){
      await new Promise(resolve=>setTimeout(resolve,80));
      const current=sample();
      if(matchMedia('(prefers-reduced-motion: reduce)').matches && previous===current)return;
      previous=current;
    }
    throw Error('Reduced-motion cloud did not settle');
  })()`);
  const resting=await cloudSample(),probe=await evaluate(`(()=>{
    const canvas=document.getElementById('field-cloud'),rect=canvas.getBoundingClientRect(),
      pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let row=canvas.height>>1;row<canvas.height;row++)
      for(let col=canvas.width>>2;col<canvas.width;col++)
        if(pixels[(row*canvas.width+col)*4+3]>90)
          return {x:rect.left+col*rect.width/canvas.width,y:rect.top+row*rect.height/canvas.height};
  })()`);
  assert.ok(probe);
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...probe});
  await evaluate('new Promise(resolve=>setTimeout(resolve,160))');
  assert.ok(resting!==await cloudSample(),'Particles must respond locally to pointer movement');
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:15,y:20});
  await evaluate('new Promise(resolve=>setTimeout(resolve,1800))');
  assert.ok(resting===await cloudSample(),'Particles must return to the original shape');
  await call('Emulation.setEmulatedMedia',{features:[]});
  await viewport(1024,768);await screenshot('desktop-window');
  assert.ok(await layout());
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await viewport(1440,900);await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await click('mouse-mode');
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:510,y:350,button:'left',buttons:1,clickCount:1});
  for(let step=0;step<24;step++)await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:515+step*12,y:350+Math.sin(step*.25)*80,button:'left',buttons:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:800,y:320,button:'left'});
  assert.equal(await evaluate("document.querySelector('#undo').disabled"),false,JSON.stringify([errors,await evaluate("['stroke-status','mouse-mode','drawing-status'].map(id=>document.getElementById(id).textContent).concat(document.elementFromPoint(510,350)?.tagName)")]));
  await click('undo');assert.equal(await evaluate("document.querySelector('#redo').disabled"),false);await click('redo');
  await click('export-open');assert.equal(await evaluate("document.querySelector('#drawer').open"),true);
  await evaluate("window.saved=[];HTMLAnchorElement.prototype.click=async function(){const blob=await(await fetch(this.href)).blob();window.saved.push([this.download.split('.').at(-1),blob.size,await blob.slice(0,4).text()]);}");
  await click('export-json');await click('export-glb');
  await evaluate("document.querySelector('#drawer').close()");await click('png');
  const saved=await evaluate("(async()=>{for(let retry=0;retry<100&&saved.length<3;retry++)await new Promise(resolve=>setTimeout(resolve,50));return saved;})()");
  assert.equal(saved.length,3);assert.ok(saved.every(file=>file[1]>100));
  assert.ok(saved.some(([ext,,magic])=>ext==='glb'&&magic==='glTF'));
  await evaluate("document.querySelector('#scene canvas').focus()");
  for(const [type,key,code] of [['keyDown',' ','Space'],['keyDown','ArrowRight','ArrowRight'],['keyUp',' ','Space']])
    await call('Input.dispatchKeyEvent',{type,key,code});
  assert.ok(await evaluate("document.querySelector('#stroke-status').textContent.includes('2 笔')"));
  await click('home');
  assert.ok(await evaluate("!document.querySelector('#landing').hidden && document.querySelector('#mouse-mode').getAttribute('aria-pressed')==='false' && !document.querySelector('#undo').disabled"));
  await click('settings-open');await click('demo-replay');
  assert.ok(await evaluate("(async()=>{for(let count=0;count<150;count++){if(document.querySelector('#status').textContent.includes('回放已结束'))return true;await new Promise(resolve=>setTimeout(resolve,100));}return false;})()"));
  await click('settings-open');await click('demo-replay');
  assert.ok(await evaluate("(async()=>{for(let count=0;count<50;count++){if(!document.querySelector('#replay-stop').disabled && document.querySelector('#landing').hidden)return true;await new Promise(resolve=>setTimeout(resolve,50));}return false;})()"));
  await click('home');
  assert.ok(await evaluate("(async()=>{await new Promise(resolve=>setTimeout(resolve,250));return !document.querySelector('#landing').hidden && document.querySelector('#replay-stop').disabled && !document.querySelector('#start').disabled;})()"));
  assert.deepEqual(errors,[]);console.log('M4 desktop window sizes, mouse/keyboard, undo/redo, JSON/GLB/PNG and offline replay passed',saved);
}
