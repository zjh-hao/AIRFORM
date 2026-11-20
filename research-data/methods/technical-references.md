# 技术参考

- MediaPipe Hand Landmarker 提供手部关节、左右手判定及模型估计的世界关节；Astra 的深度采样来自设备。[任务文档](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
- 光标稳定器参考 One Euro Filter 的速度自适应平滑思路。项目在跟踪中分别处理光标、墨迹和短时缺测。[原作者方法说明](https://gery.casiez.net/1euro/)
- 深度连续性使用测量更新与常速度状态预测；合成基准保存了采样范围与耗时口径。[OpenCV Kalman 文档](https://docs.opencv.org/4.x/dd/d6a/classcv_1_1KalmanFilter.html)
- 渲染采用 Three.js 的几何、加载器及后处理，笔迹状态、手掌跟随和全息合成为项目实现。[第三方声明](../../THIRD_PARTY_NOTICES.md)
