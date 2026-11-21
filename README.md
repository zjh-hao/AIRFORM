# AIRFORM · 虚拟特效工坊

用手势在空气中绘制三维光轨，也可以让银河、精密仪器或自己的模型悬浮于掌心。AIRFORM 面向 Windows x64 桌面。Astra Pro Plus 的手部识别默认由 Python 通过 DirectML 在 GPU 上运行，Three.js 负责绘画渲染。

## 首次运行

1. 克隆本仓库，按 [requirement.md](requirement.md) 安装 Python 3.12 x64、Node.js 24（含 npm），并准备 Edge 或 Chrome。Astra 用户另装匹配的 OpenNI2 x64 驱动与插件。
2. 双击 [setup/install.cmd](setup/install.cmd) 完成一次性安装。
3. 双击根目录的 **[AIRFORM.html](AIRFORM.html)**。本机服务关闭时点「启动 Python GPU 工坊」，按浏览器提示允许打开。选好模式后点「启动摄像头」。普通摄像头可在「工坊设置」切换。

## 空间绘画与掌上全息

**空间绘画**提供矿物光笔、离子流、极光绸带和熔金星屑。摊开右手解锁，捏合拇指与食指落笔，松手收笔。支持旋转视角和 PNG、JSON、GLB 导出。

**掌上全息**提供暗尘银河、韦布空间望远镜、毅力号火星车、精密腕表、飞行头盔和古典相机。打开左右任一手掌即可托起素材。「自定义素材」支持本地 GLB、静态或动态 WebP，以及 8×8 图集，可预览并设置显示大小。

普通摄像头通过浏览器识别手部并估计位置。Astra Pro Plus 提供实测深度，开启后可在工坊设置确认 `Python GPU · DirectML`。两条路径共用仓库里的 `hand_landmarker.task`，安装完成后可断网运行。

[使用说明](docs/usage.md) · [实现架构](docs/architecture.md) · [研究数据与实验方法](research-data/README.md) · [验证记录](docs/verification.md) · [素材与署名](licenses/assets.md)
