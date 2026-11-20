// Fit the longest side to the chosen palm diameter, preserving the file's proportions.
export function drawFrame(ctx, image, sx, sy, width, height, x, y, radius, alpha) {
  const scale = 2 * radius / Math.max(width, height);
  const w = width * scale, h = height * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(image, sx, sy, width, height, x-w/2, y-h/2, w, h);
  ctx.restore();
}

async function loadWebP(file) {
  const header = new DataView(await file.slice(0, 21).arrayBuffer());
  if (header.byteLength < 16 || header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57454250) {
    throw Error('文件内容不是有效的 WebP 图片。');
  }
  const animated = header.byteLength >= 21 && header.getUint32(12) === 0x56503858 && (header.getUint8(20) & 2);
  let image, decoder, frameIndex = 0, frameCount = 1, nextAt = 0, pending = false, disposed = false;
  if (animated) {
    if (!globalThis.ImageDecoder) throw Error('请用支持动态 WebP 解码的新版 Edge 或 Chrome 打开工坊。');
    decoder = new ImageDecoder({data:await file.arrayBuffer(), type:'image/webp', preferAnimation:true});
    try {
      await decoder.tracks.ready;
      frameCount = decoder.tracks.selectedTrack.frameCount;
      image = (await decoder.decode({frameIndex:0})).image;
    } catch (error) {
      decoder.close();
      throw error;
    }
  } else {
    image = await createImageBitmap(file);
  }
  const width = image.displayWidth ?? image.width, height = image.displayHeight ?? image.height;
  function advance(seconds) {
    if (!decoder || pending || frameCount < 2) return;
    const duration = Math.max(.01, (image.duration || 100000) / 1e6);
    if (!nextAt) nextAt = seconds + duration;
    if (seconds < nextAt) return;
    pending = true;
    frameIndex = (frameIndex + 1) % frameCount;
    decoder.decode({frameIndex}).then(({image:next}) => {
      if (disposed) { next.close(); return; }
      image.close();
      image = next;
      nextAt = performance.now()/1000 + Math.max(.01, (next.duration || 100000) / 1e6);
    }).catch(() => { frameCount = 1; }).finally(() => { pending = false; });
  }
  return {
    supportsAtlas: !animated && width % 8 === 0 && height % 8 === 0,
    draw(ctx,x,y,radius,seconds,alpha,format) {
      advance(seconds);
      const grid = format === 'atlas' ? 8 : 1;
      const w = width/grid, h = height/grid, frame = Math.floor(seconds*12) % (grid*grid);
      drawFrame(ctx,image,(frame%grid)*w,Math.floor(frame/grid)*h,w,h,x,y,radius,alpha);
    },
    dispose() { disposed = true; decoder?.close(); image.close(); },
  };
}

export async function loadCustomHologram(file) {
  if (/\.glb$/i.test(file.name)) {
    const {loadModel} = await import('./custom-glb.js');
    return loadModel(await file.arrayBuffer());
  }
  if (/\.webp$/i.test(file.name)) return loadWebP(file);
  throw Error('请选择 .glb 或 .webp 文件。');
}
