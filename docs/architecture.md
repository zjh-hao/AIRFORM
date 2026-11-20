# 实现架构

根目录 HTML 通过就绪图探测回环服务。Windows 当前用户协议调用 `backend/workshop_launcher.py`，启动仓库自己的 Python 环境。服务只监听本机，提供预构建的网页以及 Astra 设备会话。

普通摄像头由浏览器采集。Worker 读入一份 MediaPipe Hand Landmarker 任务文件，运行视频识别；GPU 连续漏检时使用同一模型的 CPU 实例复核。Astra 通过隔离进程配对深度与彩色帧，再用配准、深度采样和手形融合计算空间位置。失踪预测与实测深度在诊断中有独立标记。

绘画状态机处理解锁、捏合、释放与短暂缺测。笔迹引擎生成 Three.js 几何体。掌上全息根据掌心、掌宽和深度计算位置与比例，内置素材从透明图集取帧，本地 GLB 则按需解码和渲染。

`tools/art/` 保存重制素材的脚本。运行模型转台示例：在仓库根目录执行 `node tools/art/render-holograms.mjs local-output/frames --study helmet`。省略 `--study` 和型号可生成五种模型的 64 帧，之后用 `pack-holograms.py` 打包。
