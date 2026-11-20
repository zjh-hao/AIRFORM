# 手部跟踪数据说明

human-summary.json 汇总 8 次历史 Astra 采集，按静止、绘画、旋转和低照度区分。frames、durationMs 分别为实际记录帧数和毫秒时长。detectedHandFraction 为检出手的帧比例；qualifiedInteractionFraction 还要求交互资格。各段实际时长与可用数不同。

recovery-comparison.csv 是同一段真人快动作视频的约 10 秒浏览器实时回放。各轮会跳帧，表内分别保留分母、当前帧骨架、纯运动估计、输出频率及间隔 P95。fast-motion-summary.csv 是历史试验台最终一轮的整段与两个时间窗汇总；motion_only_frames 属于估计。前 25 秒中 747 个记录帧有 736 个可见输出，其中 155 帧为运动估计。人工粗标的 9 个指尖样本中位误差约 7.0 px；快动作掌心抽查有输出 11/12，最大误差约 69.4 px（640×480）。

这些数字描述各次历史实验的输入和实现。当前发布版单模型的启动与功能验证另见 docs/verification.md。
