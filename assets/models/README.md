# MediaPipe 手部识别模型

空间绘画和掌上全息共用此目录的 `hand_landmarker.task`。它是官方 float16 v1 手部任务包。安装脚本从该任务包转换掌部检测和手部关键点两个网络，供 Astra 的 Python DirectML 路径使用。普通摄像头由浏览器读取同一任务包。浏览器 GPU 连续漏检时可用同一权重在 CPU 上复核。

模型的固定来源和 SHA-256 见 [资源清单](../../setup/assets.json)。署名和模型卡见[第三方声明](../../THIRD_PARTY_NOTICES.md)。
