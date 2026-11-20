# 四方案对照

four-model-comparison.csv 是同一段历史真人 RGB 绘画输入前 120 帧的离线对照。mp、rtm、yolo、rf 分别代表 MediaPipe、RTMPose、YOLO 与 PG-HandPose。四者在相同输入上各跑一次。

frames 为总帧数。pinched、open、unknown 为状态计数，tracked_pct 为可判定帧百分比。comparable_pairs 是可对比的连续帧对数。median_ms 和 p95_ms 记录推理及共同的左右手判断开销，排除采集、显示和磁盘 I/O。缺少逐帧人工真值，因此不能由可判定率推得识别准确率。
