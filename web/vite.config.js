import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packageRoot } from './dependencies.js';
const local = path => fileURLToPath(new URL(path, import.meta.url));
const vision = packageRoot('@mediapipe/tasks-vision');
const three = packageRoot('three');
export const assets = new Map([
  ['tracking-worker.js', local('./src/tracking-worker.js')],
  ['assets/vision_bundle.js', `${vision}/vision_bundle.js`],
  ['assets/hand_landmarker.task', local('../assets/models/hand_landmarker.task')],
  ['assets/woman_hands.jpg', local('../.cache/woman_hands.jpg')],
  ['assets/m1-synthetic-observations.json', local('../research-data/sample/synthetic-hand.json')],
  ['LICENSE.mediapipe', local('../licenses/LICENSE.mediapipe')],
  ['LICENSE.three', `${three}/LICENSE`],
  ['LICENSE.vite', `${packageRoot('vite')}/LICENSE.md`],
  ['THIRD_PARTY_NOTICES.md', local('../THIRD_PARTY_NOTICES.md')],
  ...readdirSync(`${vision}/wasm`).filter(name => /\.(wasm|js)$/.test(name))
    .map(name => [`wasm/${name}`, `${vision}/wasm/${name}`]),
]);
export default {
  build: { rolldownOptions: { input: local('./index.html') } },
  resolve: { alias: [
    { find: /^three\/addons\//, replacement: `${three.replaceAll('\\', '/')}/examples/jsm/` },
    { find: /^three$/, replacement: `${three.replaceAll('\\', '/')}/build/three.module.js` },
    { find: '@mediapipe/tasks-vision', replacement: `${vision.replaceAll('\\', '/')}/vision_bundle.mjs` },
  ] },
  server: { fs: { allow: [local('..')] } },
  plugins: [{
    name: 'local-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0].slice(1);
        if (!assets.has(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm'
          : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream');
        res.end(readFileSync(assets.get(name)));
      });
    },
    generateBundle() {
      for (const [fileName, path] of assets) this.emitFile({ type: 'asset', fileName, source: readFileSync(path) });
    },
  }],
};
