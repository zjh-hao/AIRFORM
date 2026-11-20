import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../dependencies.js';

// Match Vite's existing dependency reuse without installing another copy.
const root = packageRoot('three');
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.conditions.includes('require')) return nextResolve(specifier, context);
  if (specifier === 'three') return nextResolve(pathToFileURL(`${root}/build/three.module.js`).href, context);
  if (specifier.startsWith('three/addons/')) return nextResolve(pathToFileURL(`${root}/examples/jsm/${specifier.slice(13)}`).href, context);
  return nextResolve(specifier, context);
} });
