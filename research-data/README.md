# 研究数据与实验方法

| 目录 | 可回答的问题 |
| --- | --- |
| [model-selection](model-selection/method.md) | 同一段画面上，几种识别路线的输出与耗时如何？ |
| [hand-tracking](hand-tracking/method.md) | 真实采集、快动作回放和短时漏检有哪些差异？ |
| [depth-and-continuity](depth-and-continuity/method.md) | 融合深度以及稳定光标的计算代价和效果如何？ |
| [Astra Python 快扫对照](performance/astra-python-replay.csv) | 同一段快扫回放中，Python DirectML 与 MediaPipe Tasks CPU 的推理耗时、光标延迟及遮挡后重获时间各是多少？实验条件见 [验证记录](../docs/astra-python-ab.md)。 |
| performance | frame-timing.csv 比较历史增强版 10 秒回放的输出和预览间隔。brush-rendering.csv 比较同一桌面合成绘画实验的 120 个渲染帧。 |
| sample | 可直接在工坊中播放的合成手势 JSON。 |
| methods | 研究参考、从数值记录生成汇总的脚本。 |

实测、真人录像回放、合成轨迹和运动估计按来源分别标注。历史对比中的辅助模型不参与本次发布运行。CSV 中的空单元格表示该条件未记录。公开数据只含统计量与合成输入；原始真人摄像头图像、录屏和逐帧个人观测留在本地。
