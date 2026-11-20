# 安装要求

| 组件 | 要求与用途 |
| --- | --- |
| 系统 | Windows x64，启动器通过当前用户的 Windows URL 协议打开本机 Python 服务。 |
| Python | 3.12 x64。安装 Python Launcher 后，`py -3.12 --version` 应可用；也可用环境变量 `AIRFORM_PYTHON` 指定 3.12 的 python.exe。 |
| Node.js / npm | 项目以 Node 24 和自带的 npm 验证。Node 用于构建及开发测试。 |
| 浏览器 | 支持摄像头、WebGL 2、WASM 和 Worker 的桌面 Edge 或 Chrome；摄像头权限由浏览器管理。 |
| 普通摄像头 | Windows 能识别且未被其他程序独占的摄像头。 |
| Astra Pro Plus | 需要 Orbbec 设备驱动、64 位 OpenNI2 运行时及其驱动插件。关闭占用设备的 Viewer。其他硬件型号应单独验证。 |

## 首次安装

双击 `setup/install.cmd`。它在项目内创建 `.venv`，安装 [Python 依赖](requirements.txt)，校验仓库内的模型，下载并校验官方诊断用图，再按 [npm 锁文件](web/package-lock.json) 安装前端包、构建网页、注册当前用户的启动协议。首次安装需要网络或等效的包缓存。安装失败可修复后重跑。移动克隆目录后，请重新安装并注册协议。

Astra 用户若将运行时安装在非标准位置，请在 PowerShell 中将 `$env:OPENNI2_REDIST64` 指向包含 `OpenNI2.dll` 与驱动插件的目录，然后运行 `.\setup\install.cmd`。安装器在本机缓存这个路径。可用 `setup\check-astra.cmd` 进行 30 帧彩深自检。普通摄像头无需安装 OpenNI。

## 启动与诊断

双击根目录 `AIRFORM.html`。默认地址为 `http://127.0.0.1:4187/`；若被其他程序占用，后台尝试 4188，入口会识别本版就绪标记。两个端口均被占用时，释放其中一个后重试。后台启动日志位于 `%LOCALAPPDATA%\AIRFORM\workshop.log`。

可在仓库根目录手动运行 `.\.venv\Scripts\python.exe -m backend.astra.server` 查看控制台诊断。首次安装后网页、手部模型、解码器、图集均从本机读取。素材重制用到的 Pillow 单列于 [美术工具依赖](tools/art/requirements.txt)。
