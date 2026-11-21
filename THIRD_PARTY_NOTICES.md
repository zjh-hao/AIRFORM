# Third-party licenses and credits for AIRFORM

- `@mediapipe/tasks-vision@1.1.1`: official npm package, https://www.npmjs.com/package/@mediapipe/tasks-vision . Registry tarball URL, integrity and Apache-2.0 metadata are pinned in `web/package-lock.json`. JS and WASM are used unmodified. MediaPipe source: https://github.com/google-ai-edge/mediapipe ; full Apache-2.0 license reused from `licenses/LICENSE.mediapipe` and included in production output.
- Model: existing `assets/models/hand_landmarker.task`, official float16/version 1, https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task . Size 7,819,105 bytes; SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`. No new model download. The existing research record identifies Apache-2.0 in the official linked [Hand Tracking model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf); preserve that provenance, rather than treating the code license as proof of asset licensing.
- Fixture: existing `.cache/woman_hands.jpg`, https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg . Used only as the official validation image; code licensing is not asserted to grant general image reuse rights. SHA-256 `70cbeb38e198c9862202e0979c21a99b40ca980d3e7b250176c85b1636a40f12`.
- Vite `8.3.5`: build-time dependency, MIT; https://github.com/vitejs/vite . Complete core and bundled notices are in `web/node_modules/vite/LICENSE.md`; transitive versions and license metadata are in the lockfile.
- Astra GPU inference installs the [ONNX Runtime DirectML package](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html). Setup uses [TensorFlow](https://github.com/tensorflow/tensorflow) and [tf2onnx](https://github.com/onnx/tensorflow-onnx) to convert the two networks inside the bundled `hand_landmarker.task` locally. The geometry follows the [MediaPipe hand task implementations](https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/tasks/cc/vision). The installed packages provide their own notices.

The build copies the verified hand model, diagnostic image and installed WASM files into `web/dist/` for local operation.

Official API reference used for this implementation: https://developers.google.com/edge/api/mediapipe/js/tasks-vision.handlandmarker and https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js .

## M1 geometry and cursor filtering (2026-11-18)

- MediaPipe's world landmarks are model-estimated 3D coordinates, not depth
  sensor measurements. M1 uses the existing model without retraining. Source:
  https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker?tab=Web
- The cursor branch uses the existing locally implemented One Euro equations
  from Casiez, Roussel & Vogel, CHI 2012, pp. 2527–2530:
  https://gery.casiez.net/1euro/ . No third-party implementation was copied.
  Palm-unit normalization, quality checks, bounded outlier handling,
  reset/suspend/resume behavior and the independent ink/cursor branches are
  repository-specific engineering. Parameters are provisional and accompanied
  by a synthetic sweep; this is not proof of human performance.
- The rigid hand template, projected test sequences, local recording/replay
  format and tests are authored for this project. They are explicitly synthetic
  and are not presented as model inference or captured human data.

## Three.js 0.186.1 — MIT

AIRFORM uses Three.js primitives to generate stroke geometry and the packaged OrbitControls addon to navigate the canvas.

- Project: https://threejs.org/
- Source: https://github.com/mrdoob/three.js
- Module: `examples/jsm/controls/OrbitControls.js`
- License below is copied verbatim from the installed `three@0.186.1/LICENSE`.

Retain this copyright and permission notice when distributing copies or substantial
portions of Three.js, including bundled application builds.

The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


## Vite 8.3.5 — build-time dependency

Vite is installed from npm, not vendored here. Its core is MIT-licensed:
Copyright (c) 2019-present, VoidZero Inc. and Vite contributors.
The installed package's `node_modules/vite/LICENSE.md` contains its full core
license and bundled dependency notices. Other installed dependencies retain their
own license files; their exact versions and package license metadata are recorded
in `web/package-lock.json`. This notice does not relicense those dependencies.
# M3 后处理与自有笔刷

使用本项目已有的 Three.js（MIT）提供的 EffectComposer、RenderPass、UnrealBloomPass、OutputPass 和 FXAAPass；不另行联网加载。笔宽响应、分块几何的笔尖变化、色板与基于视角的发光着色为本项目实现。Three.js 许可证随前端发布于 LICENSE.three。


## 掌上全息写实科技素材

本地 GLB 导入使用已锁定的 Three.js 包中的 GLTFLoader、RoomEnvironment 和解码组件。Draco 与 Basis Universal 解码器随包本地分发（Apache-2.0），meshoptimizer 解码器沿用其 MIT 许可。工坊自行实现了取景、预览、素材大小调节与掌心合成。

此项目保存下列作者发布的 GLB，并为课程工坊重新布光、取景、制作透明循环动画与动图。GLB 保留原始模型和标识。韦布动画调整了镜面材质反射，相机动画取机身特写。

| 项目内名称 | 模型与作者 | 来源与使用条款 |
| --- | --- | --- |
| 韦布空间望远镜 | James Webb Space Telescope (A)，NASA / Goddard Space Flight Center | [NASA 原始模型](https://science.nasa.gov/3d-resources/james-webb-space-telescope-a/) · [NASA 媒体使用说明](https://www.nasa.gov/nasa-brand-center/images-and-media/) |
| 毅力号火星车 | Mars 2020 Perseverance Rover，NASA / Jet Propulsion Laboratory | [NASA 原始模型](https://science.nasa.gov/3d-resources/mars-2020-perseverance-rover/) · [NASA 媒体使用说明](https://www.nasa.gov/nasa-brand-center/images-and-media/) |
| 精密计时腕表 | 原模型由 graphiccompressor 创作，Eric Chadwick / Darmstadt Graphics Group 制作 glTF 展示版 | [Chronograph Watch](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ChronographWatch) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。Khronos、3D Commerce、DGG 标志按原页面另列条款。 |
| 磨损飞行头盔 | Damaged Helmet，2016 theblueturtle_ 原作，2018 ctxwing 重建与转换 | [原始模型和署名](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet)。原作 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)，转换部分 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。 |
| 古典皮腔相机 | Antique Camera，2018 UX3D / Maximillan Kamps | [模型及标识说明](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/AntiqueCamera) · [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
