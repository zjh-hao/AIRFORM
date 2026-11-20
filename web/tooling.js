import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dependency } from './dependencies.js';
const vite = await import(pathToFileURL(dependency('vite')).href);
const options = { root: dirname(fileURLToPath(import.meta.url)), configLoader: 'runner',
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true } };
if (process.argv[2] === 'build') await vite.build(options);
else {
  const server = await (process.argv[2] === 'preview' ? vite.preview(options) : vite.createServer(options));
  if (process.argv[2] !== 'preview') await server.listen();
  server.printUrls();
}
