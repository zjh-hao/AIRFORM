# 发布验证记录

2026-11-20 在 Windows x64、Python 3.12、Node 24 和桌面 Edge 上检查单模型版。

| 检查项 | 观测 |
| --- | --- |
| 前端回归、生产构建 | 157 项通过，Vite 构建完成。旧版两项本机辅助模型请求测试随该链路移除，新增单权重、零网络推理测试。 |
| Python 后端 | 10 项采集管理、几何、会话与 HTTP 边界测试通过。 |
| 全新克隆 | 在带中文和空格的独立目录克隆，首次创建虚拟环境，以本机缓存的锁定 Python 安装包完成安装。官方自检图获取、npm ci、构建、协议注册及 167 项自动化测试通过。 |
| 本地启动 | 根 HTML 的冷启动按钮、协议目标、已运行服务跳转、Logo 与标签图标通过。4187 已被开发版占用时，公开版在 4188 服务。 |
| 普通摄像头 | 实体摄像头输出 640×480，浏览器 GPU 视频推理已运行。 |
| Astra Pro Plus | 实机采集 30 对 640×480 彩深帧，每帧有有效深度，深度帧号递增。浏览器进一步取得 39 个 RGB-D 推理结果；这段检查中未观察到手。 |
| 绘画与全息 | Edge 验证四种画笔、六套图集、导入 GLB、静态与动态 WebP、图集和大小调节；使用合成手掌验证显示比例。鼠标和键盘绘画、撤销、重做、PNG/JSON/GLB 导出及合成回放通过。 |
| 素材重制 | 用原始头盔 GLB 渲染了 8 帧转台样例。 |

运行命令（仓库根目录）：

```powershell
npm --prefix web test
npm --prefix web run build
.\.venv\Scripts\python.exe -m unittest discover -s tests/python
node web/validation/m3-visual.mjs launcher
node web/validation/m3-visual.mjs library
node web/validation/m3-visual.mjs m4
```

若使用备用端口，先设置 `$env:AIRFORM_URL='http://127.0.0.1:4188/'`。工作区截图等测试输出写入 Git 忽略的本地目录。上述硬件检查验证取流与推理，快动作、遮挡后重获的真人效果仍需现场试画。
