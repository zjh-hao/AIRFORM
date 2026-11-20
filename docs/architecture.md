# 实现架构

## Astra Python GPU

根目录 `AIRFORM.html` 进入回环地址 `127.0.0.1:4197`。服务关闭时，网页上的启动按钮通过安装时注册的 `airform-astra-python` Windows 协议运行本机服务。

开启 Astra 会话时，Python 默认用 ONNX Runtime DirectML 在 GPU 上执行原 `hand_landmarker.task` 内的掌部检测和关键点网络。安装时从原模型转换 ONNX 并写入 `.cache/astra-gpu`。图像裁剪、检测框解码、跟踪区和坐标映射在 Python 中完成，沿用 MediaPipe 手部任务的阈值和几何。访问 `?input=astra&delegate=CPU` 可运行原来的 MediaPipe Tasks CPU 对照。 [MediaPipe 手部任务实现](https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/tasks/cc/vision) · [ONNX Runtime DirectML](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)

原 OpenNI 与 DirectShow 采集进程继续配对并配准 RGB-D。后台线程持续采集，最多保留一对待推理的最新帧。Python 用原始彩色帧转成 RGB 推理，再把关键点、左右手、推理时间、原始采集时间和帧号与同一对 JPEG、深度一起发给浏览器。

Python VIDEO 路径保留相对第一帧采集时钟的递增整数毫秒。OpenNI 设备时间、帧号和主机配对间隔保留，网页状态机继续使用浏览器的单调时钟。输入的像素坐标保持原生方向，预览和叠加层由 CSS 镜像，场景映射仍沿用绘画坐标约定。Astra 的预览在绘画和全息中都与同一包的识别结果一起更新。普通摄像头仍使用浏览器 Worker。

## 普通摄像头与渲染

普通摄像头由浏览器采集。Worker 读取 MediaPipe Hand Landmarker 任务文件并运行视频识别。GPU 连续漏检时使用同一模型的 CPU 实例复核。Astra 则用配准深度和手形融合计算空间位置。短时运动预测和实测深度分别在诊断界面标记。

绘画状态机处理解锁、捏合、释放与短暂缺测。笔迹引擎生成 Three.js 几何体。掌上全息根据掌心、掌宽和深度计算位置与比例，内置素材从透明图集取帧，本地 GLB 则按需解码和渲染。

`tools/art/` 保存重制素材的脚本。运行模型转台示例：在仓库根目录执行 `node tools/art/render-holograms.mjs local-output/frames --study helmet`。省略 `--study` 和型号可生成五种模型的 64 帧，之后用 `pack-holograms.py` 打包。
