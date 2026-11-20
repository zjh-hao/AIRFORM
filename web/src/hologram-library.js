const sheets = import.meta.glob('./holograms/*.webp', {eager:true, query:'?url', import:'default'});
export const holograms = {
  dark: {palmScale:1.28, name:'暗尘银河', group:'星系', description:'从斜上方看银蓝色旋臂，黑色尘雾掠过暖白星核。'},
  webb: {palmScale:0.9225, name:'韦布空间望远镜', group:'写实科技', description:'沿镜面侧缘看过去，六边形主镜、支撑架和层叠遮阳罩逐渐分开。'},
  rover: {palmScale:0.9225, name:'毅力号火星车', group:'写实科技', description:'六个车轮、悬架和前部机械臂随视角展开，上方桅杆勾出车身轮廓。'},
  watch: {palmScale:0.885, name:'精密计时腕表', group:'写实科技', description:'斜光扫过金属表圈，表盘刻度、侧面按钮和表带纹理逐层显现。'},
  helmet: {palmScale:0.885, name:'磨损飞行头盔', group:'写实科技', description:'近看面罩反射、外壳划痕和边缘掉漆，侧光把细小的表面起伏勾出来。'},
  camera: {palmScale:0.9225, name:'古典皮腔相机', group:'写实科技', description:'绕镜头观察金属镜筒、折叠皮腔和对焦机构，看光学仪器的机械结构。'},
};

export function loadHologram(key) {
  const image = new Image();
  image.src = sheets['./holograms/'+key+'.webp'];
  return image;
}

// The 8 × 8 transparent sheet is rendered from the 3D source, so camera tracking
// only pays for one texture copy per frame. Pose interpolation runs independently.
export function drawHologram(ctx, image, x, y, radius, seconds, alpha) {
  if (!image?.complete || !image.naturalWidth) return;
  const side = image.naturalWidth / 8;
  const frame = Math.floor(seconds * 12) % 64;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(image, (frame%8)*side, Math.floor(frame/8)*side, side,side,
    x-radius,y-radius,2*radius,2*radius);
  ctx.restore();
}
