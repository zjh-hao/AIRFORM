# AIRFORM Astra Python 本地验证

## 当前 Python GPU 版

根目录的 `AIRFORM.html` 会进入端口 4197 的 GPU 版。服务关闭时点「启动 Python GPU 工坊」。安装时注册当前用户的 Windows 协议 `airform-astra-python`。在同一网页地址加 `&delegate=CPU` 可以显式选择 CPU 路径。

在 Edge 从本地 HTML 进入实验版后，用同一台 Astra 实机收到 163 帧，约 20.1 Hz。两份 ONNX Runtime 性能分析日志确认掌部检测与关键点网络的计算都经过 `DmlExecutionProvider`。原自检图识别到左右手各 21 点，空白图返回无手。暗尘银河的静态回放有 494 次绘制，中心和半径在该场景中的抖动均为 0 px。

在同一段 640×480、30 FPS 的快扫回放中，两条 Python 路径各测一轮。下列延迟为中位数 / P95。

| 指标 | Python GPU · DirectML | Python CPU · MediaPipe Tasks |
| --- | ---: | ---: |
| 推理耗时，各 192 帧 | 4.57 / 6.92 ms | 15.69 / 17.45 ms |
| 配对时间戳至下一次浏览器渲染回调，各 192 帧 | 13.60 / 34.87 ms | 25.04 / 28.21 ms |
| 笔尖光标相位落后，各 8 次 | 34.70 / 38.16 ms | 44.27 / 45.87 ms |
| 遮挡后首次识别，各 5 次 | 15.17 / 26.87 ms，失败 0 次 | 21.24 / 25.44 ms，失败 0 次 |

本轮未采集真人端到端延迟。公开的数值汇总见 [同帧测量 CSV](../research-data/performance/astra-python-replay.csv)。GPU 路径复用了模型权重，Python 用 NumPy 和 OpenCV 实现裁剪、解码和跟踪区更新。GPU 结果和 MediaPipe Tasks CPU 的逐点值可有差异。

## GPU 接入前的 CPU 基线对照

以下是接入 Python GPU 前的记录。复现实验版 CPU 路径时，在 URL 加 `&delegate=CPU`。

浏览器 GPU 基线提交为 `8bc7c6269b12722395297729b2ff7e466a566861`。基线和当前版本各自从其根目录的 `AIRFORM.html` 进入。两版轮流占用同一设备，切换前点「停止输入」并等设备释放。

## 实现差异

| 项目 | 正式版 | Python 实验版 |
| --- | --- | --- |
| 推理 | Edge Worker 默认 GPU，连续漏检按现有规则用 CPU IMAGE 复核 | Python MediaPipe 1.1.1 CPU VIDEO。Windows 此实验环境使用 Python CPU 一路推理。IMAGE 诊断可从原设置链接切换 |
| 彩色输入 | 从同一对 RGB-D 取 JPEG 解码结果 | 从采集的 BGR 直接转 RGB。网页继续用 JPEG 预览，预览与骨架同帧更新 |
| 等待与时钟 | 采集和浏览器各保留最新帧，VIDEO 使用浏览器推理提交时间 | 采集和推理并行，仅保留一对待推理最新帧。VIDEO 使用相对采集时间，网页滤波继续使用浏览器单调时钟 |
| 依赖 | OpenCV 4.13.0.92，浏览器 MediaPipe 1.1.1 | OpenCV contrib 4.13.0.92 满足 Python MediaPipe 的依赖，同一环境保留一个 `cv2` 包 |

两版共用同一模型文件，SHA-256 为 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`。VIDEO 识别上限为两手，检测、存在和跟踪阈值分别为 `0.28 / 0.28 / 0.35`。配准、深度采样、左右手标签、镜像方向、捏合规则、滤波参数、Three.js 和内置素材沿用正式版。Python 暴露归一化与世界坐标两组关键点。 [MediaPipe Hand Landmarker Python API](https://ai.google.dev/edge/api/mediapipe/python/mp/tasks/vision/HandLandmarker)

## 方法

2026-11-20，Windows x64、Intel Core Ultra 7 251HX、NVIDIA RTX 5060 Laptop、Edge 157.0.4341.60 headless、视口 1920×1080、Python 3.12.16、Node 24.22.3。各项目按正式版、实验版、实验版、正式版顺序轮流运行。同帧回放经过两版各自的 HTTP 服务、生产网页和原有交互路径。软件延迟用同机时钟采样校准，取最低往返耗时一次的中点，最低 RTT 约 0.8–1.0 ms。

- **取流**用同一台 Astra Pro Plus，640×480。每轮等第一帧后剔除 5 秒，再取 8 秒稳态结果。设备由两版轮流使用。场景帧没有手势真值标签。
- **回放**用仓库自检图下方手掌的水平反转裁剪，构造 640×480、30 FPS 的可重放 RGB-D 流。静止段 90 帧，像素位置和真值深度固定，加有种子固定的彩色噪声、亮度偏移和 ±6 mm 深度噪声。快速段每轮 8 个 ±105 px、周期 0.8 秒的水平扫动，峰值约 825 px/s。每轮末尾 5 次用空帧遮挡 400 ms，再露出手 600 ms。两版的输入源帧序列相同。
- **推理耗时**用 Worker 返回的耗时或 Python `detect_for_video` 调用的耗时，CPU 复核计在对应 Worker 帧内。软件延迟从主机给彩深配对记时到下一次 `requestAnimationFrame` 回调，覆盖浏览器解码和交互更新。快扫延迟通过拟合已知扫动相位估计，笔尖数值取 Three.js 场景收到的过滤后光标 X，采样点取下一帧回调。显示器扫描与曝光前的动作等待需要外部测量。
- **全息抖动**用暗尘银河每次绘制的图集中心，计算它与该轮静态中心中位数的二维距离。单位为 640×480 预览画布像素，动画图集自转照常运行。P95 取升序第 `ceil(0.95 × n)` 项。

## 实测结果

延迟与抖动按「中位数 / P95」列出。

| 指标 | 正式版 Edge GPU | 实验版 Python CPU |
| --- | ---: | ---: |
| Astra 实机推理耗时，稳态各 321 帧 | 10.9 / 14.2 ms | 29.1 / 44.4 ms |
| Astra 实机配对时间戳到下一次浏览器渲染回调，各 321 帧 | 69.7 / 89.6 ms | 90.5 / 120.1 ms |
| Astra 实机结果输出间隔，各 319 个间隔 | 49.3 / 69.4 ms | 49.3 / 74.6 ms |
| Astra 实机启动按钮到首个识别结果，各 2 轮 | 7.94 / 7.97 s | 4.95 / 5.34 s |
| 同帧回放快扫推理耗时，各 384 帧 | 8.1 / 9.8 ms | 15.4 / 17.2 ms |
| 同帧回放快扫食指关键点相位落后，各 16 次 | 17.5 / 19.7 ms | 25.0 / 26.8 ms |
| 同帧回放快扫笔尖光标相位落后，各 16 次 | 37.0 / 40.0 ms | 43.8 / 46.3 ms |
| 同帧回放快扫缺帧、丢右手或丢光标 | 0 / 384 | 0 / 384 |
| 同帧回放静止全息中心抖动 | 0.00 / 0.00 px，990 次绘制 | 0.00 / 0.00 px，994 次绘制 |
| 同帧回放静止全息半径抖动与低透明度绘制 | 0.00 / 0.00 px，0 次 | 0.00 / 0.00 px，0 次 |
| 同帧回放遮挡后首次识别，各 10 次 | 14.5 / 29.4 ms，失败 0 次 | 24.1 / 26.6 ms，失败 0 次 |
| 同帧回放始终张掌的误落笔，各 2 轮 | 0 笔 | 0 笔 |
| 真人连续捏合的误落笔和断笔 | 待现场测 | 待现场测 |
| 真人动作到显示器出光的端到端延迟 | 待现场测 | 待现场测 |

在这次历史对照里，浏览器 GPU 的快扫光标中位数领先旧 Python CPU 约 7 ms，静止全息持平。旧 Python CPU 更快给出首个结果。两版遮挡重获均为 10/10，浏览器 GPU 的中位数较低，Python CPU 在这个小样本中的 P95 略低。对照条件中，计算设备、彩色输入编码和调度方式均有差异。

复现脚本把逐帧日志写入本地的 `local-output/astra-ab/`。日志记录时间戳、侧别和少量坐标。采集过程中未写入实机图像或录像。

历史检查通过 158 项前端测试、11 项 Python 测试和生产构建。Astra VIDEO/IMAGE 实机、普通摄像头的浏览器 GPU 路径、素材库及笔迹导出均已在 Edge 验证。Python 用项目自检图输出左右手各 21 个归一化点和 21 个世界坐标点。

## 现场复测

两版固定相机、灯光、窗口尺寸和手距（约 60–75 cm），建议按 A→B→B→A 各做一轮。切换版前释放设备。

1. **全息**选暗尘银河，掌心朝镜头，手肘放稳，托住 10 秒。记抖动、闪烁或消失次数。
2. **跟手与捏合**选矿物光笔，张开右手解锁。做 10 次捏合、快速左右移动、松开，笔与笔之间留约 0.5 秒。记未捏合时的误落笔、捏合期间的断笔、没画出来的笔，以及快扫时最明显的落后。
3. **遮挡**同一只手遮住约 0.5 秒再露出，做 5 次。要测真实延迟，用可录高帧率的第二台设备同框拍手和显示器，按帧数换算动作到屏幕的延迟。录像只保存在本地。

## 复现命令

需要比较浏览器 GPU 时，用 `git worktree add --detach ../AIRFORM-baseline 8bc7c62` 准备基线源码，再按该版本的安装说明构建基线。然后在当前目录分别启动回放服务。也可以加 `--live`，让服务轮流使用同一台 Astra 实机。

```powershell
..\AIRFORM-baseline\.venv\Scripts\python.exe tools/astra_ab.py --root ../AIRFORM-baseline --port 4205
.\.venv\Scripts\python.exe tools/astra_ab.py --root . --tracked --port 4206
```

另一个 PowerShell 窗口运行下例。`AIRFORM_AB_CASE` 可选 `drawing`、`hologram`、`live`。基线两轮使用输出后缀 `-a1`、`-a2`。Python 两轮用端口 4206，输出后缀为 `-b1`、`-b2`。比较 Python CPU 时用 `http://127.0.0.1:4206/?input=astra&delegate=CPU`，比较 Python GPU 时使用同地址的默认设置。

```powershell
New-Item -ItemType Directory -Force local-output/astra-ab | Out-Null
$env:AIRFORM_URL = 'http://127.0.0.1:4205/?input=astra'
$env:AIRFORM_AB_CASE = 'drawing'
$env:AIRFORM_AB_OUT = 'local-output/astra-ab/drawing-a1.json'
node web/validation/m3-visual.mjs astra-ab
.\.venv\Scripts\python.exe tools/astra_ab_summary.py local-output/astra-ab
```
