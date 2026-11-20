import {installPalmMap} from './palm-map.js';
import cometSwatches from './effect-studies/comet-still.webp?inline';
import {drawHologram,holograms,loadHologram} from './hologram-library.js';
import {loadCustomHologram} from './custom-hologram.js';

export const brushes = {
  drawing: {name:'矿物光笔', description:'张开右手解锁，捏合移动落笔，松开收笔。拖动画布可绕作品观察。'},
  ion: {name:'离子流', accent:'#55dcff', position:'0%', description:'捏合画出航线，松手发射。青蓝色彗核沿原路飞行，留下收束的离子尾流。'},
  aurora: {name:'极光绸带', accent:'#bd89ff', position:'50%', description:'捏合画出航线，松手发射。薄荷绿与紫色光带绕着笔迹交织。'},
  ember: {name:'熔金星屑', accent:'#ffc361', position:'100%', description:'捏合画出航线，松手发射。金色彗核沿轨迹前进，火星从尾端散落。'},
};
const palmGuide = '启动摄像头，平摊左手或右手。移动手掌改变位置，靠近或远离镜头调整大小。';

export function installEffectLibrary() {
  const byId = id => document.getElementById(id);
  const dialog = byId('fx-library');
  const modeButtons = [...byId('fx-modes').querySelectorAll('button')];
  const brushList = byId('fx-options');
  const canvas = document.createElement('canvas');
  canvas.id = 'palm-fx';
  canvas.hidden = true;
  byId('skeleton').after(canvas);
  let lastHologram = 'dark';
  let activeImage, previewImage, previewFrame;
  let draft, applied, importVersion = 0, loading = false;
  const fileInput = byId('holo-file'), scaleInput = byId('holo-scale'), formatInput = byId('holo-format');
  const message = byId('holo-message');
  const preview = byId('holo-preview');
  const previewContext = preview.getContext('2d');
  installPalmMap(canvas, byId('camera'), byId('drawing-status'), (ctx,pose,seconds) => {
    if (lastHologram === 'custom' && applied) {
      // The camera layer is mirrored. Keep lettering in imported artwork readable.
      ctx.save();
      ctx.translate(pose.x,pose.y);
      ctx.scale(-1,1);
      applied.asset.draw(ctx,0,0,pose.radius*.92*applied.scale,seconds,pose.alpha,applied.format);
      ctx.restore();
      return;
    }
    drawHologram(ctx,activeImage,pose.x,pose.y,pose.radius*holograms[lastHologram].palmScale,seconds,pose.alpha);
  });
  function stopPreview() {
    cancelAnimationFrame(previewFrame);
    previewContext.clearRect(0,0,preview.width,preview.height);
    previewImage = null;
  }
  function animatePreview(image, custom = false) {
    previewImage = image;
    let lastFrame = -1;
    function render(now) {
      if (!dialog.open) return;
      const frame = Math.floor(now * (custom ? .03 : .012));
      if (frame !== lastFrame) {
        previewContext.clearRect(0,0,preview.width,preview.height);
        if (custom) draft.asset.draw(previewContext,144,144,70*draft.scale,now/1000,1,draft.format);
        else drawHologram(previewContext,image,144,144,144,now/1000,1);
        lastFrame = frame;
      }
      previewFrame = requestAnimationFrame(render);
    }
    previewFrame = requestAnimationFrame(render);
  }
  function cancelImport() {
    importVersion++;
    loading = false;
    byId('holo-import').classList.remove('dragging');
    message.textContent = '';
  }
  dialog.addEventListener('close', () => {
    if (!dialog.open) { stopPreview(); cancelImport(); }
  });

  let active = 'drawing';
  let lastBrush = active;
  let selected, previewBrush, previewHologram;
  document.body.dataset.effect = active;

  function inspect(effect) {
    selected = effect;
    const painting = effect !== 'solar';
    const custom = !painting && previewHologram === 'custom';
    if (!custom) cancelImport();
    const item = painting ? brushes[effect] : custom ? {
      name:draft?.name ?? '自定义素材',
      description:draft ? '调整大小后进入掌上全息，摊开任意一只手托起素材。' : '从电脑选择素材，在这里预览，再用手掌托起。文件仅在本次页面中使用。',
    } : holograms[previewHologram];
    if (painting) previewBrush = effect;
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === (painting ? 'painting' : 'solar')));
    }
    byId('fx-brushes').hidden = !painting;
    byId('fx-holograms').hidden = painting;
    for (const button of byId('fx-holograms').querySelectorAll('[data-hologram]')) {
      button.setAttribute('aria-pressed', String(button.dataset.hologram === previewHologram));
    }
    byId('holo-custom').setAttribute('aria-pressed',String(custom));
    byId('holo-import').hidden = !custom;
    byId('holo-controls').hidden = !draft;
    if (custom && draft) {
      scaleInput.value = Math.round(draft.scale*100);
      byId('holo-percent').value = scaleInput.value + '%';
      byId('holo-format-label').hidden = !draft.asset.supportsAtlas;
      formatInput.value = draft.format;
    }
    for (const button of brushList.children) {
      button.setAttribute('aria-pressed', String(button.dataset.effect === effect));
    }
    byId('fx-name').textContent = item.name;
    byId('fx-description').textContent = item.description;
    byId('fx-apply').textContent = painting ? '进入空间绘画 →' : '进入掌上全息 →';
    byId('fx-apply').disabled = custom && (!draft || loading);
    const swatch = byId('fx-swatch');
    stopPreview();
    preview.hidden = painting;
    swatch.firstElementChild.style.visibility = effect === 'drawing' ? 'visible' : 'hidden';
    swatch.style.backgroundImage = painting && effect !== 'drawing' ? 'url("' + cometSwatches + '")' : 'none';
    swatch.style.backgroundPositionX = item.position ?? '0%';
    if (custom) {
      if (draft) animatePreview(null,true);
    } else if (!painting) animatePreview(previewHologram === lastHologram && activeImage ? activeImage : loadHologram(previewHologram));
  }

  function replaceDraft(next) {
    if (draft && draft.asset !== applied?.asset && draft.asset !== next?.asset) draft.asset.dispose();
    draft = next;
  }
  async function importFile(files) {
    if (!files.length) return;
    const version = ++importVersion;
    const file = files[0];
    previewHologram = 'custom';
    loading = true;
    message.textContent = '正在读取 ' + file.name + '…';
    inspect('solar');
    try {
      if (files.length !== 1) throw Error('请一次拖入一个素材。');
      const asset = await loadCustomHologram(file);
      if (version !== importVersion) { asset.dispose(); return; }
      replaceDraft({asset, name:file.name, scale:1, format:'image'});
      message.textContent = '';
    } catch (error) {
      if (version !== importVersion) return;
      console.debug('本地全息素材读取失败',file.name,error);
      message.textContent = /^请选择|^请一次|^请用|^模型|^文件内容/.test(error.message)
        ? error.message : '无法读取这个文件，请检查是否完整，或重新导出后再试。';
    } finally {
      if (version === importVersion) { loading = false; inspect('solar'); }
    }
  }
  byId('holo-custom').onclick = () => { previewHologram = 'custom'; inspect('solar'); };
  byId('holo-drop').onclick = () => fileInput.click();
  fileInput.onchange = () => { importFile([...fileInput.files]); fileInput.value = ''; };
  for (const event of ['dragover','drop']) dialog.addEventListener(event,e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (selected !== 'solar') { e.dataTransfer.dropEffect = 'none'; return; }
    if (event === 'drop') {
      byId('holo-import').classList.remove('dragging');
      importFile(e.dataTransfer.files);
    } else {
      e.dataTransfer.dropEffect = 'copy';
      byId('holo-import').classList.add('dragging');
    }
  });
  dialog.addEventListener('dragleave',e => {
    if (!dialog.contains(e.relatedTarget)) byId('holo-import').classList.remove('dragging');
  });
  scaleInput.oninput = () => {
    if (!draft) return;
    draft.scale = Number(scaleInput.value)/100;
    byId('holo-percent').value = scaleInput.value + '%';
  };
  formatInput.onchange = () => { if (draft) draft.format = formatInput.value; };

  for (const [key, brush] of Object.entries(brushes)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.effect = key;
    button.textContent = brush.name;
    button.style.setProperty('--brush-color', brush.accent ?? '#42b8ff');
    button.onclick = () => inspect(key);
    brushList.append(button);
  }
  for (const button of modeButtons) {
    button.onclick = () => inspect(button.dataset.mode === 'painting' ? previewBrush : 'solar');
  }
  for (const [key,item] of Object.entries(holograms)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.hologram = key;
    button.textContent = item.name;
    button.onclick = () => { previewHologram = key; inspect('solar'); };
    byId('fx-holograms').querySelector('[aria-label="'+item.group+'"]').append(button);
  }
  function open() {
    if (lastHologram === 'custom' && applied) replaceDraft({...applied});
    previewBrush = lastBrush;
    previewHologram = lastHologram;
    inspect(active);
    dialog.showModal();
    byId('fx-modes').querySelector('[aria-pressed=true]').focus();
  }
  byId('effects-open').onclick = byId('browse-fx').onclick = open;
  byId('fx-apply').onclick = () => {
    const changed = active !== selected;
    active = selected;
    document.body.dataset.effect = active;
    const painting = active !== 'solar';
    if (painting) lastBrush = active;
    else {
      lastHologram = previewHologram;
      activeImage = previewImage;
      if (applied && applied.asset !== draft?.asset) applied.asset.dispose();
      applied = lastHologram === 'custom' ? {...draft} : null;
      document.body.dataset.hologram = lastHologram;
    }
    const item = painting ? brushes[active] : applied ? {name:applied.name,group:'本地素材'} : holograms[lastHologram];
    if (changed) window.dispatchEvent(new CustomEvent('kineglow:effect', {detail:active}));
    byId('landing').hidden = true;
    canvas.hidden = painting;
    document.querySelector('.dock-title .code').textContent = painting ? '空间绘画 / 画笔' : '掌上全息 / '+item.group;
    document.querySelector('.dock-title strong').textContent = item.name;
    byId('guide').textContent = painting ? item.description : palmGuide;
    byId('drawing-status').textContent = byId('guide').textContent;
    dialog.close();
    (!painting && !byId('start').disabled ? byId('start') : byId('effects-open')).focus();
  };
}
