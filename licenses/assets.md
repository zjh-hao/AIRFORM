# 作品素材来源与使用许可

网页使用本地 WebP 图集，原始 GLB 位于 `assets/holograms/`。每件素材及其衍生图集保留各自的作者和使用条件。

## 掌上全息写实科技素材

本地 GLB 导入使用已锁定的 Three.js 包中的 GLTFLoader、RoomEnvironment 和解码组件。Draco 与 Basis Universal 解码器随包本地分发（Apache-2.0），meshoptimizer 解码器沿用其 MIT 许可。工坊自行实现了取景、预览、素材大小调节与掌心合成。

此项目保存下列作者发布的 GLB，并为课程工坊重新布光、取景、制作透明循环动画与动图。GLB 保留原始模型和标识。韦布动画调整了镜面材质反射，相机动画取机身特写。

| 项目内名称 | 模型与作者 | 来源与使用条款 |
| --- | --- | --- |
| 韦布空间望远镜 | James Webb Space Telescope (A)，NASA / Goddard Space Flight Center | [NASA 原始模型](https://science.nasa.gov/3d-resources/james-webb-space-telescope-a/) · [NASA 媒体使用说明](https://www.nasa.gov/nasa-brand-center/images-and-media/) |
| 毅力号火星车 | Mars 2020 Perseverance Rover，NASA / Jet Propulsion Laboratory | [NASA 原始模型](https://science.nasa.gov/3d-resources/mars-2020-perseverance-rover/) · [NASA 媒体使用说明](https://www.nasa.gov/nasa-brand-center/images-and-media/) |
| 精密计时腕表 | 原模型由 graphiccompressor 创作，Eric Chadwick / Darmstadt Graphics Group 制作 glTF 展示版 | [Chronograph Watch](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ChronographWatch) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。Khronos、3D Commerce、DGG 标志按原页面另列条款。 |
| 磨损飞行头盔 | Damaged Helmet，2016 theblueturtle_ 原作，2018 ctxwing 重建与转换 | [原始模型和署名](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet)。原作 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)，转换部分 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。 |
| 古典皮腔相机 | Antique Camera，2018 UX3D / Maximillan Kamps | [模型及标识说明](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/AntiqueCamera) · [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

## 手部识别与诊断图

MediaPipe Hand Landmarker 官方 float16 v1 随库提供。安装脚本从 Google 的固定地址获取官方诊断图，在本机校验 SHA-256。来源、模型卡和哈希记录在[第三方声明](../THIRD_PARTY_NOTICES.md)和[资源清单](../setup/assets.json)。
