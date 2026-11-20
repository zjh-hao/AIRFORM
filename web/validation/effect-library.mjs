import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {worldHand} from '../test-support/world-hand.js';

export async function checkLibrary({evaluate,call}) {
  const element = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = async selector => {
    assert.ok(await evaluate(element(selector) + '?.checkVisibility()'), selector);
    await evaluate(element(selector) + '.click()');
  };
  const text = selector => evaluate(element(selector) + '.textContent.trim()');
  const visible = selector => evaluate(element(selector) + '.checkVisibility()');
  const shot = async name => {
    if (!process.env.KINEGLOW_LIBRARY_SHOTS) return;
    await wait(200);
    const {data} = await call('Page.captureScreenshot',{format:'png'});
    await writeFile(join(process.env.KINEGLOW_LIBRARY_SHOTS,name+'.png'),Buffer.from(data,'base64'));
  };
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await click('#browse-fx');
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#fx-modes button'), b=>b.textContent)"),['空间绘画','掌上全息']);
  const names=['矿物光笔','离子流','极光绸带','熔金星屑'];
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#fx-options button'), b=>b.textContent)"), names);
  await shot('空间绘画目录');
  const modeTop = await evaluate("document.querySelector('#fx-modes').getBoundingClientRect().top");
  for (const [i,key] of ['drawing','ion','aurora','ember'].entries()) {
    await click('[data-effect="'+key+'"][type=button]');
    assert.equal(await text('#fx-name'),names[i]);
    assert.equal(await text('#fx-apply'),'进入空间绘画 →');
    await click('#fx-apply');
    assert.equal(await text('.dock-title strong'),names[i]);
    assert.equal(await text('.dock-title .code'),'空间绘画 / 画笔');
    await click('#effects-open');
  }
  await click('[data-mode=solar]');
  assert.equal(await evaluate("document.querySelector('#fx-modes').getBoundingClientRect().top"),modeTop);
  assert.equal(await visible('#fx-options'),false);
  assert.equal(await text('#fx-apply'),'进入掌上全息 →');
  await shot('掌上全息目录');
  // Browsing and closing must preserve the applied brush.
  await click('[aria-label="关闭特效目录"]');
  assert.equal(await evaluate("document.body.dataset.effect"),'ember');
  await click('#effects-open');
  assert.equal(await text('#fx-options [aria-pressed=true]'),'熔金星屑');
  await click('[data-mode=solar]');
  await click('#fx-apply');
  assert.equal(await text('.dock-title strong'),'暗尘银河');
  assert.equal(await visible('#mouse-mode'),false);
  assert.match(await text('#guide'),/平摊左手或右手/);
  assert.equal(await evaluate("!!document.querySelector('video').srcObject"),false);
  await click('#settings-open');
  assert.equal(await visible('#archive'),false);
  assert.equal(await visible('#smoothing'),false);
  assert.match(await text('#input-description'),/掌上全息/);
  await click('[aria-label="关闭设置"]');
  for(let i=0;i<150 && await evaluate("document.querySelector('#start').disabled");i++) await wait(100);
  await click('#start');
  for(let i=0;i<120 && !await evaluate("document.querySelector('video').srcObject?.active");i++) await wait(100);
  assert.ok(await evaluate("document.querySelector('video').srcObject?.active"));
  const materials=['dark','webb','rover','watch','helmet','camera'];
  const palmWidths={};
  await click('#effects-open');
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#fx-holograms [data-hologram]'), b=>b.dataset.hologram)"), materials);
  await click('[aria-label="关闭特效目录"]');
  async function measurePalm(label) {
    const packet = worldHand({label});
    return evaluate(`(async()=>{
      const packet=${JSON.stringify(packet)}, fx=document.querySelector('#palm-fx');
      const ctx=fx.getContext('2d'), draw=ctx.drawImage;
      let width,height;
      ctx.drawImage=function(...args){[width,height]=args.slice(-2);return draw.apply(this,args);};
      const isolate=e=>{if(e.detail!==packet)e.stopImmediatePropagation();};
      window.addEventListener('kineglow:hands',isolate,true);
      try{
        for(let i=0;i<12;i++){
          packet.timestamp=performance.now();
          window.dispatchEvent(new CustomEvent('kineglow:hands',{detail:packet}));
          await new Promise(requestAnimationFrame);
        }
        return {width,height,visible:ctx.getImageData(0,0,fx.width,fx.height).data.some((v,i)=>i%4===3&&v>40)};
      }finally{ctx.drawImage=draw;window.removeEventListener('kineglow:hands',isolate,true);}
    })()`);
  }
  for (const key of materials) {
    await click('#effects-open');
    await click('[data-hologram="'+key+'"]');
    const itemName=await text('#fx-name');
    const hasPixels = "document.querySelector('#holo-preview').getContext('2d').getImageData(0,0,288,288).data.some((v,i)=>i%4===3 && v>60)";
    for(let i=0;i<60 && !await evaluate(hasPixels);i++) await wait(50);
    assert.ok(await evaluate(hasPixels),key+' preview');
    const animated=await evaluate(`(async()=>{
      const preview=document.querySelector('#holo-preview');
      const first=preview.toDataURL(), start=performance.now();
      while(performance.now()-start<1500){
        await new Promise(requestAnimationFrame);
        if(preview.toDataURL()!==first)return true;
      }
      return false;
    })()`);
    assert.ok(animated,key+' preview must present another animation frame');
    await click('#fx-apply');
    assert.equal(await text('.dock-title strong'),itemName);
    const rendered=await measurePalm(key==='camera'?'Left':'Right');
    assert.ok(rendered.visible && rendered.width>0,key+' on palm');
    palmWidths[key]=rendered.width;
  }
  console.log('Overlay widths for a fixed palm (px)',palmWidths);
  for(const key of ['webb','rover','camera','watch','helmet']){
    const ratio=palmWidths[key]/palmWidths.dark;
    const compact=key==='watch'||key==='helmet';
    const previousRatio=(compact ? 1.18 : 1.23)/1.28;
    assert.ok(Math.abs(ratio/previousRatio - 0.75)<0.001,key+' should render at 75% of its previous width');
  }
  await click('#effects-open');
  await click('#holo-custom');
  assert.ok(await evaluate("document.querySelector('#fx-apply').disabled"));
  await evaluate(`(async()=>{
    const c=document.createElement('canvas'); c.width=96; c.height=48;
    const ctx=c.getContext('2d');ctx.fillStyle='cyan';ctx.fillRect(0,0,96,48);
    const blob=await new Promise(ok=>c.toBlob(ok,'image/webp'));
    const dt=new DataTransfer();dt.items.add(new File([blob],'我的素材.webp'));
    document.querySelector('#holo-drop').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
  })()`);
  const ready = async name => {
    for(let i=0;i<160 && await text('#fx-name')!==name;i++) {
      const msg=await text('#holo-message');
      if(msg && !msg.startsWith('正在读取'))throw Error(name+' — '+msg);
      await wait(100);
    }
    assert.equal(await text('#fx-name'),name);
  };
  const choose = async path => {
    const {root}=await call('DOM.getDocument');
    const {nodeId}=await call('DOM.querySelector',{nodeId:root.nodeId,selector:'#holo-file'});
    await call('DOM.setFileInputFiles',{nodeId,files:[fileURLToPath(new URL(path,import.meta.url))]});
    await ready(path.split('/').at(-1));
  };
  const setSize = value => evaluate(`{const s=document.querySelector('#holo-scale');s.value=${value};s.dispatchEvent(new Event('input'));}`);
  await ready('我的素材.webp');
  await click('#fx-apply');
  const full=await measurePalm('Left');
  assert.ok(full.visible && Math.abs(full.width/full.height-2)<.001);
  await click('#effects-open');
  await setSize(75);
  assert.equal(await text('#holo-percent'),'75%');
  await click('#fx-apply');
  const smaller=await measurePalm('Left');
  assert.ok(smaller.visible && Math.abs(smaller.width/full.width-.75)<.001);
  await click('#effects-open');
  await setSize(150);
  await click('[aria-label="关闭特效目录"]');
  await click('#effects-open');
  assert.equal(await text('#holo-percent'),'75%');
  await evaluate(`{
    const dt=new DataTransfer();dt.items.add(new File(['broken'],'broken.glb'));
    document.querySelector('#holo-drop').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true}));
  }`);
  for(let i=0;i<50 && !(await text('#holo-message')).includes('GLB 2.0');i++) await wait(50);
  assert.match(await text('#holo-message'),/GLB 2.0/);
  assert.equal(await text('#fx-name'),'我的素材.webp');
  for(const path of ['../src/holograms/dark.webp','../test-support/fixtures/comet.webp','../../assets/holograms/webb.glb']){
    await choose(path);
    if(path.endsWith('dark.webp')) {
      await evaluate("const f=document.querySelector('#holo-format');f.value='atlas';f.dispatchEvent(new Event('change'))");
    }
    const animates = await evaluate(`(async()=>{
      const p=document.querySelector('#holo-preview'),ctx=p.getContext('2d');
      let first; const start=performance.now();
      while(performance.now()-start<5000){
        await new Promise(requestAnimationFrame);
        if(!ctx.getImageData(0,0,288,288).data.some((v,i)=>i%4===3&&v>40))continue;
        const frame=p.toDataURL(); if(first && frame!==first)return true; first=frame;
      }
      return false;
    })()`);
    assert.ok(animates,path+' animates');
    if(path.endsWith('.glb')) await shot('自定义掌上全息');
    await click('#fx-apply');
    assert.equal(await text('.dock-title strong'),path.split('/').at(-1));
    assert.ok((await measurePalm('Right')).visible,path+' on palm');
    await click('#effects-open');
  }
  await click('[aria-label="关闭特效目录"]');
  console.log('Custom drag-and-drop, 75% palm scale, cancel, invalid file, atlas, animated WebP and Draco GLB passed.');
  await click('#stop');
  await click('#effects-open');
  assert.equal(await text('#fx-modes [aria-pressed=true]'),'掌上全息');
  await click('[data-mode=painting]');
  assert.equal(await text('#fx-options [aria-pressed=true]'),'熔金星屑');
  await click('#fx-apply');
  await click('#settings-open');
  assert.equal(await visible('#smoothing'),true);
  assert.equal(await visible('#archive'),true);
  console.log('Both categories, four brushes, mode-specific controls, cancel and brush recall passed.');
}
