import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
export function dependency(name) {
  return require.resolve(name);
}
export function packageRoot(name) {
  let path = dirname(dependency(name));
  while (!existsSync(join(path, 'package.json'))) {
    const parent = dirname(path);
    if (parent === path) throw new Error(`No package.json for ${name}`);
    path = parent;
  }
  return path;
}
