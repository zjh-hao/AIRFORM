import {Vector3} from 'three';
import {installFieldCloud} from './field-cloud.js';
import {installEffectLibrary} from './effect-library.js';

const byId=id=>document.getElementById(id);
function download(blob,extension){
  if(!blob)throw Error('没有可保存的文件');
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='AIRFORM-'+new Date().toISOString().replace(/[:.]/g,'-')+'.'+extension;
  link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
export function installConsole(){
  installEffectLibrary();
  const disposeCloud=installFieldCloud(byId('field-cloud'),byId('landing'),byId('field-region'));
  const drawer=byId('drawer'),panel=byId('validation-panel');
  const open=()=>{if(!drawer.open)drawer.showModal();};
  byId('settings-open').onclick=open;
  byId('export-open').onclick=()=>{open();byId('export-json').focus();};
  const route=()=>{if(location.hash==='#validation-panel'){open();panel.open=true;panel.scrollIntoView();}};
  route();window.addEventListener('hashchange',route);
  byId('guide-toggle').onclick=event=>{
    const guide=byId('guide');guide.hidden=!guide.hidden;
    event.currentTarget.setAttribute('aria-expanded',String(!guide.hidden));
  };
  byId('show-skeleton').onchange=event=>{byId('skeleton').hidden=!event.target.checked;};
  const status=byId('status'),sceneStatus=byId('scene-status'),alert=byId('alert');
  const observe=()=>{
    const sceneFailed=/失败|丢失/.test(sceneStatus.textContent);
    const message=sceneFailed?sceneStatus.textContent:status.textContent;
    const failed=/失败|拒绝|占用|断开|未找到|notallowed|permission|notreadable|丢失/i.test(message);
    alert.hidden=!failed;
    if(failed)alert.textContent=message+'。'+(sceneFailed?'请刷新页面并检查浏览器硬件加速。':
      /权限|permission|notallowed/i.test(message)?'请在地址栏允许相机权限，然后重试。':
      document.body.dataset.effect==='solar'?'请检查设备连接并关闭占用相机的程序，再重新启动摄像头。':
      '请检查设备连接，关闭占用相机的程序，或切换为鼠标试画。');
  };
  const observer=new MutationObserver(observe);
  for(const element of [status,sceneStatus])observer.observe(element,{childList:true});
  observer.observe(document.body,{attributes:true,attributeFilter:['data-effect']});
  window.addEventListener('pagehide',()=>{disposeCloud();observer.disconnect();window.removeEventListener('hashchange',route);},{once:true});
}

export function installCanvasTools({engine,renderer,camera,controls,render,redraw}){
  const listeners=new AbortController(),listen=(element,type,callback)=>element.addEventListener(type,callback,{signal:listeners.signal});
  const mouse=byId('mouse-mode'),surface=renderer.domElement;
  let pointer=null,keyboardDown=false,mouseMode=false,busyExport=false,toastTimer;
  const keyboardPosition={x:0,y:0};
  const toast=message=>{clearTimeout(toastTimer);byId('clear-status').textContent=message;
    toastTimer=setTimeout(()=>{byId('clear-status').textContent='';},3000);};
  const refresh=stats=>{
    byId('undo').disabled=stats.active||stats.strokes===0;byId('redo').disabled=!engine.canRedo;
    for(const id of ['export-json','export-glb'])byId(id).disabled=busyExport||byId('undo').disabled;
  };
  const endPointer=()=>{
    if(pointer===null && !keyboardDown)return;
    keyboardDown=false;
    const old=pointer;pointer=null;
    if(old!==null && surface.hasPointerCapture(old))surface.releasePointerCapture(old);
    window.dispatchEvent(new CustomEvent('kineglow:pointer-ink',{detail:{state:'Idle',point:null,timestamp:performance.now()}}));
  };
  const toggleMouse=enabled=>{
    endPointer();mouseMode=enabled;controls.enabled=!enabled;
    mouse.setAttribute('aria-pressed',String(enabled));mouse.textContent=enabled?'结束试画':'鼠标试画';
    surface.style.cursor=enabled?'crosshair':'grab';
    if(enabled){byId('landing').hidden=true;surface.focus();byId('drawing-status').textContent='按住鼠标拖动绘画；键盘可按住空格，用方向键移动。';}
    else byId('drawing-status').textContent='拖动画布旋转视角，或启动摄像头绘画。';
  };
  listen(mouse,'click',()=>toggleMouse(!mouseMode));
  listen(window,'kineglow:effect',()=>{endPointer();if(mouseMode && document.body.dataset.effect==='solar')toggleMouse(false);});
  listen(byId('home'),'click',()=>{if(mouseMode)toggleMouse(false);});
  listen(byId('start'),'click',()=>{if(mouseMode)toggleMouse(false);});
  listen(window,'kineglow:hands',({detail})=>{if(mouseMode && detail.source==='摄像头')toggleMouse(false);});
  surface.tabIndex=0;surface.setAttribute('aria-label','三维画布；试画模式支持空格与方向键');
  const depositAt=(x,y)=>{
    const point=new Vector3(x,y,0);
    const viewDepth=new Vector3().project(camera).z;point.z=viewDepth;point.unproject(camera);
    window.dispatchEvent(new CustomEvent('kineglow:pointer-ink',{detail:{state:'Pinching',point,timestamp:performance.now()}}));
  };
  const deposit=event=>{
    const rect=surface.getBoundingClientRect();
    depositAt((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
  };
  listen(surface,'keydown',event=>{
    if(!mouseMode||pointer!==null)return;
    if(event.code==='Space'){
      event.preventDefault();if(!keyboardDown){keyboardDown=true;depositAt(keyboardPosition.x,keyboardPosition.y);}
    }else if(keyboardDown && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
      event.preventDefault();const axis=['ArrowLeft','ArrowRight'].includes(event.key)?'x':'y';
      keyboardPosition[axis]=Math.max(-.96,Math.min(.96,keyboardPosition[axis]+(['ArrowLeft','ArrowDown'].includes(event.key)?-.025:.025)));
      depositAt(keyboardPosition.x,keyboardPosition.y);
    }
  });
  listen(surface,'keyup',event=>{if(event.code==='Space' && keyboardDown)endPointer();});
  listen(surface,'blur',()=>{if(keyboardDown)endPointer();});
  listen(surface,'pointerdown',event=>{
    if(!mouseMode||event.button!==0||pointer!==null||keyboardDown)return;
    pointer=event.pointerId;surface.setPointerCapture(pointer);deposit(event);
  });
  listen(surface,'pointermove',event=>{if(pointer===event.pointerId)deposit(event);});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])
    listen(surface,type,event=>{if(pointer===event.pointerId)endPointer();});
  for(const action of ['undo','redo'])listen(byId(action),'click',()=>{
    if(engine[action]()){refresh(engine.stats);redraw();}
  });
  listen(byId('png'),'click',()=>{render();surface.toBlob(blob=>{if(blob)download(blob,'png');else toast('截图失败，请重试。');});});
  for(const format of ['json','glb'])listen(byId('export-'+format),'click',async()=>{
    if(engine.active||!engine.stats.strokes||busyExport)return;
    busyExport=true;refresh(engine.stats);
    try{
      if(format==='json')download(new Blob([JSON.stringify({schema:'kineglow-mesh-v1',object:engine.group.toJSON()})],{type:'application/json'}),'json');
      else{
        const {GLTFExporter}=await import('three/addons/exporters/GLTFExporter.js');
        if(engine.active||!engine.stats.strokes)throw Error('请先收笔');
        const binary=await new GLTFExporter().parseAsync(engine.group,{binary:true});
        download(new Blob([binary],{type:'model/gltf-binary'}),'glb');
      }
    }catch(error){toast('导出失败：'+error.message);}
    finally{busyExport=false;refresh(engine.stats);}
  });
  listen(window,'kineglow:clear',()=>{endPointer();toast('画布已清除');});
  refresh(engine.stats);
  return {refresh,dispose(){clearTimeout(toastTimer);listeners.abort();}};
}
