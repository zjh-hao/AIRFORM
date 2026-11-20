# AIRFORM · 虚拟特效工坊

用手势在空气中绘制三维光轨，也可以让银河、精密仪器或自己的模型悬浮于掌心。AIRFORM 面向 Windows x64 桌面，使用 MediaPipe Hand Landmarker、Three.js 和 Python 本机相机服务。

## 首次运行

1. 克隆本仓库，安装 Python 3.12 x64（含 Python Launcher）、Node.js 24（含 npm）并准备 Edge 或 Chrome。Astra 用户另装匹配的 OpenNI2 x64 驱动与插件。详见 [requirement.md](requirement.md)。
2. 双击 [setup/install.cmd](setup/install.cmd)，等待出现 “AIRFORM is ready”。
3. 双击根目录的 **[AIRFORM.html](AIRFORM.html)**。冷启动时点击「启动工坊」，允许浏览器打开本机应用。选好模式后点「启动摄像头」并授权。以后直接从这个 HTML 进入。

## 两种模式

**空间绘画**提供矿物光笔、离子流、极光绸带和熔金星屑。摊开右手解锁，捏合拇指与食指落笔，松手收笔。支持旋转视角和 PNG、JSON、GLB 导出。

**掌上全息**提供暗尘银河、韦布空间望远镜、毅力号火星车、精密腕表、飞行头盔和古典相机。打开左右任一手掌即可托起素材。「自定义素材」支持本地 GLB、静态或动态 WebP，以及 8×8 图集，可预览并设置显示大小。

普通摄像头根据画面中的手形和大小估计位置。Astra Pro Plus 还能提供实测深度。两种模式共用仓库里的一个手部模型，安装完成后可断网运行。

[使用说明](docs/usage.md) · [实现架构](docs/architecture.md) · [研究数据与实验方法](research-data/README.md) · [验证记录](docs/verification.md) · [素材与署名](licenses/assets.md)
