// Resolve all frontend resources against the local workshop origin.
export function assetUrl(path) {
  return new URL(path, location.origin).href;
}
